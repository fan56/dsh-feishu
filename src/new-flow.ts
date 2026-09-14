/**
 * NewSessionFlowManager: the SINGLE live /new config flow. `/new` presents
 * the config card; the flow settles exactly once — on submit, on cancel, or
 * at TTL expiry — patching the terminal card and resolving the awaiting
 * promise. A second `/new` while one is pending expires the old flow first
 * (the operator obviously restarted the intent). Card submits arrive via the
 * bot's parser chain; authorization is the caller's job (the same operator
 * allowlist gate as every other interactive surface).
 */

import { randomUUID } from 'node:crypto'
import {
  buildNewSessionCancelledCard,
  buildNewSessionCard,
  buildNewSessionExpiredCard,
  type NewSessionCardSpec,
  type NewSessionPicks,
} from './new-card.ts'

/** How a presented /new config flow ended. */
export type NewSessionOutcome =
  | { status: 'submitted'; picks: NewSessionPicks; readonly messageId: string }
  | { status: 'cancelled'; readonly messageId: string }
  | { status: 'expired'; readonly messageId: string }

/** Printf-style logger surface (cordis logger compatible; all optional). */
export interface NewFlowLogger {
  warn?(message: string, ...args: unknown[]): void
}

/** Outbound surface the manager needs. */
export interface NewFlowDeps {
  /** Send one card to a chat; resolves the messageId, undefined on failure. */
  sendCard(chatId: string, card: unknown): Promise<string | undefined>
  /** Patch a card in place; false on failure. */
  patchCard(messageId: string, card: unknown): Promise<boolean>
  logger?: NewFlowLogger
  /** Flow lifetime; default 10 minutes (same as the selector flows). */
  ttlMs?: number
  /** Timer seam for tests; defaults to a real unref'd setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_TTL_MS = 10 * 60 * 1000

/** One pending config flow. */
interface PendingNewFlow {
  readonly flowId: string
  readonly messageId: string
  state: 'pending' | 'submitted' | 'cancelled' | 'expired'
  settle: (outcome: NewSessionOutcome) => void
}

export class NewSessionFlowManager {
  private readonly deps: NewFlowDeps
  private readonly ttlMs: number
  private pending: PendingNewFlow | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(deps: NewFlowDeps) {
    this.deps = deps
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  }

  /**
   * Send the config card and await the operator's outcome. Resolves undefined
   * only when the card could not be sent at all (no chat, send failure).
   */
  async present(chatId: string, spec: NewSessionCardSpec): Promise<NewSessionOutcome | undefined> {
    await this.expirePending()
    const flowId = randomUUID()
    const messageId = await this.deps.sendCard(chatId, buildNewSessionCard(spec, flowId))
    if (messageId === undefined) return undefined
    return await new Promise<NewSessionOutcome>(resolve => {
      const settle = (outcome: NewSessionOutcome) => this.settle(flowId, outcome, resolve)
      this.pending = { flowId, messageId, state: 'pending', settle }
      this.armExpiry()
    })
  }

  /** Feed one parsed card action; a foreign/stale flow id is a no-op. */
  handleAction(parsed: { flowId: string; cancelled?: boolean; picks: NewSessionPicks }): void {
    const flow = this.pending
    if (flow === undefined || flow.flowId !== parsed.flowId || flow.state !== 'pending') return
    if (parsed.cancelled === true) {
      flow.settle({ status: 'cancelled', messageId: flow.messageId })
      return
    }
    flow.settle({ status: 'submitted', picks: parsed.picks, messageId: flow.messageId })
  }

  /** Expire the pending flow, if any — used by the TTL and by re-/new. */
  private async expirePending(): Promise<void> {
    const flow = this.pending
    if (flow === undefined || flow.state !== 'pending') return
    flow.settle({ status: 'expired', messageId: flow.messageId })
  }

  private settle(flowId: string, outcome: NewSessionOutcome, resolve: (outcome: NewSessionOutcome) => void): void {
    const flow = this.pending
    if (flow === undefined || flow.flowId !== flowId || flow.state !== 'pending') return
    flow.state = outcome.status === 'submitted' ? 'submitted' : outcome.status === 'cancelled' ? 'cancelled' : 'expired'
    this.clearTimer()
    this.pending = undefined
    void this.patchTerminal(flow.messageId, outcome.status)
    resolve(outcome)
  }

  private patchTerminal(messageId: string, status: 'submitted' | 'cancelled' | 'expired'): void {
    // submitted → the CALLER patches the real created card once the session
    // actually exists; here only the unsavory endings get their grey card.
    if (status === 'submitted') return
    const card = status === 'cancelled' ? buildNewSessionCancelledCard() : buildNewSessionExpiredCard()
    void this.deps.patchCard(messageId, card).catch(() => undefined)
  }

  private armExpiry(): void {
    this.clearTimer()
    const fire = (): void => {
      const flow = this.pending
      if (flow === undefined || flow.state !== 'pending') return
      this.deps.logger?.warn?.('dsh-feishu: /new config flow expired')
      flow.settle({ status: 'expired', messageId: flow.messageId })
    }
    if (this.deps.sleep !== undefined) {
      // Test seam: no real timer exists, nothing to clear later.
      void this.deps.sleep(this.ttlMs).then(fire)
      return
    }
    const timer = setTimeout(fire, this.ttlMs)
    // Unref IMMEDIATELY — a ref'd 10-minute timer would pin the host process
    // (and every test runner) until it fires.
    typeof timer.unref === 'function' && timer.unref()
    this.timer = timer
  }

  private clearTimer(): void {
    this.timer !== undefined && clearTimeout(this.timer)
    this.timer = undefined
  }
}
