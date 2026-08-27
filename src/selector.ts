/**
 * SelectionFlowManager: multi-slot registry of one-shot selection cards.
 * A caller presents a spec; the manager sends the card and settles the flow
 * exactly once — on a pick, a cancel, or TTL expiry — patching the terminal
 * card and resolving the awaiting promise. Card submits arrive via the bot's
 * parser chain; authorization reuses the operator allowlist with the ask
 * branch's silent-ignore semantics (non-operators and stale/replayed cards
 * are no-ops, never errors).
 */

import { randomUUID } from 'node:crypto'
import {
  buildSelectorCancelledCard,
  buildSelectorCard,
  buildSelectorExpiredCard,
  buildSelectorSettledCard,
  type ParsedSelectorAction,
  type SelectorOption,
  type SelectorSpec,
} from './selector-card.ts'

/** How a presented selection ended. */
export type SelectorOutcome =
  | { status: 'picked'; value: string; label: string }
  | { status: 'cancelled' }
  | { status: 'expired' }

/** Printf-style logger surface (cordis logger compatible; all optional). */
export interface SelectorLogger {
  info?(message: string, ...args: unknown[]): void
  warn?(message: string, ...args: unknown[]): void
  error?(message: string, ...args: unknown[]): void
}

/** Outbound + authorization surface the manager needs. */
export interface SelectorDeps {
  /** Send one card to a chat; resolves the messageId, undefined on failure. */
  sendCard(chatId: string, card: unknown): Promise<string | undefined>
  /** Patch a card in place; false on failure. */
  patchCard(messageId: string, card: unknown): Promise<boolean>
  /** Operator gate — same allowlist semantics as the ask branch. */
  allowlisted(openId: string | undefined): boolean
  logger: SelectorLogger
  /** Flow lifetime; default 10 minutes. */
  ttlMs?: number
  /** Timer seam for tests; defaults to an unref'd real setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

/** Default flow lifetime: 10 minutes. */
const DEFAULT_TTL_MS = 10 * 60 * 1000

type FlowState = 'pending' | 'picked' | 'cancelled' | 'expired' | 'failed'

/** One presented selection awaiting its outcome. */
interface SelectionFlow {
  readonly id: string
  readonly chatId: string
  readonly spec: SelectorSpec
  messageId: string | undefined
  state: FlowState
  readonly expiresAt: number
  /** Terminal card chosen at settle time (a late messageId still patches it). */
  terminalCard: unknown | undefined
  readonly resolve: (outcome: SelectorOutcome) => void
  readonly reject: (error: Error) => void
  /** Real-timer handle (absent when a sleep seam is injected). */
  timer: ReturnType<typeof setTimeout> | undefined
}

export class SelectorManager {
  private readonly deps: SelectorDeps
  private readonly flows = new Map<string, SelectionFlow>()

  constructor(deps: SelectorDeps) {
    this.deps = deps
  }

  /** Live pending-flow count (tests / debugging). */
  get pendingCount(): number {
    let count = 0
    for (const flow of this.flows.values()) {
      if (flow.state === 'pending') count += 1
    }
    return count
  }

  /**
   * Send a selector card and resolve with the operator's outcome. Rejects
   * only when the card cannot be delivered (the flow is removed then); a
   * pick, a cancel or the TTL expiry all resolve normally.
   */
  present(chatId: string, spec: SelectorSpec): Promise<SelectorOutcome> {
    return new Promise<SelectorOutcome>((resolve, reject) => {
      const id = randomUUID()
      const ttlMs = this.deps.ttlMs ?? DEFAULT_TTL_MS
      const flow: SelectionFlow = {
        id,
        chatId,
        spec,
        messageId: undefined,
        state: 'pending',
        expiresAt: Date.now() + ttlMs,
        terminalCard: undefined,
        resolve,
        reject,
        timer: undefined,
      }
      this.flows.set(id, flow)
      this.armTimer(flow, ttlMs)
      void this.sendFor(flow)
    })
  }

  /**
   * Settle the flow a selector submit belongs to. Unknown / already-settled
   * flows (stale or replayed cards) and non-operators are ignored silently;
   * a pick that matches no option is treated as a cancel (warned).
   */
  handleAction(parsed: ParsedSelectorAction, operatorOpenId: string | undefined): void {
    const flow = this.flows.get(parsed.flowId)
    if (flow === undefined || flow.state !== 'pending') return
    if (!this.deps.allowlisted(operatorOpenId)) return
    if (parsed.cancel === true) {
      this.settle(flow, { status: 'cancelled' }, buildSelectorCancelledCard(flow))
      return
    }
    const option: SelectorOption | undefined = parsed.pick === undefined
      ? undefined
      : flow.spec.options.find(candidate => candidate.value === parsed.pick)
    if (option === undefined) {
      if (parsed.pick === undefined) {
        this.deps.logger.warn?.('dsh-feishu: selector flow %s submit carried no pick — settling as cancelled', flow.id)
      } else {
        this.deps.logger.warn?.('dsh-feishu: selector flow %s pick %s matched no option — settling as cancelled', flow.id, parsed.pick)
      }
      this.settle(flow, { status: 'cancelled' }, buildSelectorCancelledCard(flow))
      return
    }
    this.settle(flow, { status: 'picked', value: option.value, label: option.label }, buildSelectorSettledCard(flow, option))
  }

  /** Cancel every pending flow (e.g. the session view was rebound). */
  cancelAll(reason?: string): void {
    for (const flow of [...this.flows.values()]) {
      if (flow.state !== 'pending') continue
      if (reason !== undefined) this.deps.logger.info?.('dsh-feishu: selector flow %s cancelled: %s', flow.id, reason)
      this.settle(flow, { status: 'cancelled' }, buildSelectorCancelledCard(flow))
    }
  }

  // ------------------------------------------------------------- internals --

  private async sendFor(flow: SelectionFlow): Promise<void> {
    let messageId: string | undefined
    try {
      messageId = await this.deps.sendCard(flow.chatId, buildSelectorCard(flow))
    } catch (error) {
      this.fail(flow, error)
      return
    }
    if (flow.state !== 'pending') {
      // Settled while the send was in flight — dismiss the stray card so no
      // interactive control lingers (same cleanup the ask flow does).
      if (messageId !== undefined && flow.terminalCard !== undefined) {
        void this.patchTerminal(messageId, flow.terminalCard)
      }
      return
    }
    if (messageId === undefined) {
      // sendCard swallows API errors into undefined — that is the only
      // send-time failure signal, and it must reject the awaiting caller.
      this.fail(flow, new Error('the selection card could not be delivered'))
      return
    }
    flow.messageId = messageId
  }

  private armTimer(flow: SelectionFlow, ttlMs: number): void {
    const fire = () => {
      // State + map membership double as the cancel check for injected-sleep
      // timers that have no clearable handle.
      if (flow.state !== 'pending' || this.flows.get(flow.id) !== flow) return
      this.settle(flow, { status: 'expired' }, buildSelectorExpiredCard(flow))
    }
    if (this.deps.sleep !== undefined) {
      void this.deps.sleep(ttlMs).then(fire, () => undefined)
      return
    }
    const timer = setTimeout(fire, ttlMs)
    timer.unref?.() // never hold the process open for a flow's TTL
    flow.timer = timer
  }

  private clearTimer(flow: SelectionFlow): void {
    if (flow.timer !== undefined) {
      clearTimeout(flow.timer)
      flow.timer = undefined
    }
  }

  /** Exactly-once settle: state guard → terminal patch → resolve. */
  private settle(flow: SelectionFlow, outcome: SelectorOutcome, card: unknown): void {
    if (flow.state !== 'pending') return
    flow.state = outcome.status
    flow.terminalCard = card
    this.clearTimer(flow)
    this.flows.delete(flow.id)
    if (flow.messageId !== undefined) void this.patchTerminal(flow.messageId, card)
    flow.resolve(outcome)
  }

  /** Remove an undeliverable flow and reject its awaiting caller. */
  private fail(flow: SelectionFlow, error: unknown): void {
    if (flow.state !== 'pending') return
    flow.state = 'failed'
    this.clearTimer(flow)
    this.flows.delete(flow.id)
    flow.reject(error instanceof Error ? error : new Error(String(error)))
  }

  /** Best-effort terminal patch — failure is warned, never thrown. */
  private async patchTerminal(messageId: string, card: unknown): Promise<void> {
    try {
      const ok = await this.deps.patchCard(messageId, card)
      if (!ok) this.deps.logger.warn?.('dsh-feishu: selector terminal patch failed (message %s)', messageId)
    } catch (error) {
      this.deps.logger.warn?.('dsh-feishu: selector terminal patch threw: %o', error)
    }
  }
}
