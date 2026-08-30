/**
 * btw bot wiring — the bridge between the pure controller (btw.ts) and the
 * Feishu card surface: command entry, card publish + 5s beat, settle/cancel
 * card lifecycle. All card ops ride the bot's serial chain (passed in
 * pre-wrapped, like SelectorManager's), so a btw patch never interleaves
 * with a round-card settle or a selector flow.
 *
 * Per-surface by design (docs/adr/0001-btw-duplicated-not-shared.md): this
 * manager's queue/slot/cancellation are independent of the TUI's overlay —
 * phone-side disruptions (/new, /resume, /stop) cancel phone-side calls via
 * Bot.cancelAll hooks, and nothing else touches them.
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import {
  BtwController,
  BTW_IDLE_NOTICE,
  BTW_USAGE,
  parseBtwInput,
  type BtwRunState,
  type BtwSelection,
  type BtwStreamFn,
} from './btw.ts'
import { buildBtwCard, type BtwSchema2Card } from './btw-card.ts'

export interface BtwManagerDeps {
  /** The side-call stream — ctx.get('llm').stream adapted to BtwCallOptions. */
  stream: BtwStreamFn
  sendCard: (chatId: string, card: BtwSchema2Card) => Promise<string | undefined>
  patchCard: (messageId: string, card: BtwSchema2Card) => Promise<boolean>
  /** Reply channel for background outcomes (errors / drained-background runs). */
  notify: (text: string) => void
  resolveSelection: () => BtwSelection | undefined
  buildSnapshot: () => readonly Message[]
  isMainRunning: () => boolean
  isReadOnlyView: () => boolean
  hasCapturingSurface?: () => boolean
  /** Card beat cadence — the same statusIntervalMs the round cards use. */
  beatMs: number
  logger: { warn: (format: string, ...values: readonly unknown[]) => void }
}

/**
 * Owns the phone-side btw lifecycle. One live card at a time; the 5s beat
 * patches it while streaming; the settle/cancel path patches once and stops
 * the beat. Bare `/btw` re-ships the live or last exchange as a fresh card.
 */
export class BtwManager {
  private readonly deps: BtwManagerDeps
  private readonly controller: BtwController
  private cardMessageId: string | undefined
  private beat: ReturnType<typeof setInterval> | undefined
  /** Most recent run handed to a card — the cancel path renders from it. */
  private cardRun: BtwRunState | undefined
  private chatId: string | undefined
  private disposed = false

  constructor(deps: BtwManagerDeps) {
    this.deps = deps
    this.controller = new BtwController({
      stream: options => this.deps.stream(options),
      resolveSelection: () => this.deps.resolveSelection(),
      buildSnapshot: () => this.deps.buildSnapshot(),
      requestRender: () => this.onControllerRender(),
      notify: (message, kind) => {
        if (kind === 'error' || kind === 'info') this.deps.notify(message)
        else this.deps.logger.warn('dsh-feishu: btw notice: %s', message)
      },
      onRunStarted: run => { void this.openCard(run) },
      onCardRequestedClose: () => { this.settleLiveCardAsCanceled() },
      hasCapturingSurface: () => this.deps.hasCapturingSurface?.() ?? false,
    })
  }

  /** `/btw` entry: returns the reply text; cards go out on their own. */
  async handleBtw(rawInput: string, chatId: string): Promise<string> {
    if (this.disposed) return BTW_USAGE
    this.chatId = chatId
    const parsed = parseBtwInput(rawInput)
    if (parsed.kind === 'empty') {
      const opened = this.controller.openReview()
      if (opened === 'live') return '⌘ btw 正在运行——卡片已重发。'
      if (opened === 'review') return '上一条 btw 问答已重发。'
      return BTW_USAGE
    }
    if (parsed.kind === 'error') return parsed.error
    if (!(this.deps.isMainRunning() && !this.deps.isReadOnlyView())) {
      return BTW_IDLE_NOTICE
    }
    const result = this.controller.submit({
      question: parsed.question,
      ...(parsed.modelOverride === undefined ? {} : { modelOverride: parsed.modelOverride }),
    })
    switch (result.kind) {
      case 'started':
        return '⌘ btw 已提交——旁路回答中，不占用主线。'
      case 'queued':
        return `⌘ btw 已排队（第 ${result.position} 位）。`
      case 'rejected':
        return `btw 被拒绝：${result.reason}。`
    }
  }

  /** Phone-side disruption (/new, /resume, /stop): kill runs, settle the card. */
  cancelAll(): void {
    this.controller.cancelAll()
  }

  dispose(): void {
    this.disposed = true
    this.stopBeat()
    this.cardMessageId = undefined
    this.controller.dispose()
  }

  // ------------------------------------------------------------- card lifecycle --

  private async openCard(run: BtwRunState): Promise<void> {
    this.cardRun = run
    const chatId = this.chatId
    if (chatId === undefined) {
      this.controller.setCardOpen(false)
      return
    }
    let messageId: string | undefined
    try {
      messageId = await this.deps.sendCard(chatId, buildBtwCard(run, this.controller.queuedCount))
    } catch (error) {
      this.deps.logger.warn('dsh-feishu: btw card send failed: %o', error)
    }
    if (messageId === undefined) {
      // No card surface — the run still delivers into the slot; bare /btw
      // retries the card, errors surface through notify.
      this.controller.setCardOpen(false)
      return
    }
    this.cardMessageId = messageId
    this.controller.setCardOpen(true)
    this.startBeat()
  }

  /** Controller render callback: deltas no-op (the beat covers them); a
   * settle finalizes the card in place. */
  private onControllerRender(): void {
    const run = this.controller.currentRun
    if (run === undefined || run.status === 'streaming') return
    void this.finalizeCard(run)
  }

  private async finalizeCard(run: BtwRunState): Promise<void> {
    this.stopBeat()
    await this.patchCardIfLive(run)
    // A settled run whose card closed has no further viewer — prune it so
    // the slot (bare /btw) is the only thing a later render can resurrect.
    this.controller.setCardOpen(false)
  }

  private settleLiveCardAsCanceled(): void {
    this.stopBeat()
    const run = this.cardRun
    if (run !== undefined && this.cardMessageId !== undefined) {
      void this.deps
        .patchCard(this.cardMessageId, buildBtwCard({ ...run, status: 'canceled' }, 0))
        .catch(() => undefined)
    }
    this.cardMessageId = undefined
    this.cardRun = undefined
    this.controller.setCardOpen(false)
  }

  private startBeat(): void {
    if (this.beat !== undefined) return
    this.beat = setInterval(() => {
      const run = this.controller.currentRun
      if (run === undefined || run.status !== 'streaming' || this.cardMessageId === undefined) return
      void this.deps
        .patchCard(this.cardMessageId, buildBtwCard(run, this.controller.queuedCount))
        .catch(() => undefined)
    }, Math.max(5000, this.deps.beatMs))
  }

  private stopBeat(): void {
    if (this.beat !== undefined) clearInterval(this.beat)
    this.beat = undefined
  }

  private async patchCardIfLive(run: BtwRunState): Promise<void> {
    const messageId = this.cardMessageId
    if (messageId === undefined) return
    this.cardMessageId = undefined
    this.cardRun = undefined
    try {
      await this.deps.patchCard(messageId, buildBtwCard(run, this.controller.queuedCount))
    } catch (error) {
      this.deps.logger.warn('dsh-feishu: btw card patch failed: %o', error)
    }
  }
}
