/**
 * The bot orchestrator: inbound queue → command routing → session binding →
 * status-card lifecycle.
 *
 * Lifecycle rules (design doc §2/§5 定稿):
 * - silent startup — the bot never sends anything unprompted;
 * - binding only through /resume; unbound input gets one hint line;
 * - prompts inject via `agent.followup` (queued when a turn is running);
 * - one status card per turn, opened on turn/start (or on a mid-turn bind),
 *   patched in place on the status beat ONLY when content changed, finalized
 *   on turn/end, followed by the assistant body as plain messages;
 * - no replay of session history on bind (live events from bind time on).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { isOperator } from './allowlist.ts'
import { buildStatusCard, type InteractiveCard } from './card.ts'
import { classifyInbound, helpText } from './commands.ts'
import type { ResolvedConfig } from './config.ts'
import { parseReceiveEvent, type InboundMessage } from './inbound.ts'
import { EMOJI_DONE, EMOJI_SEEN, type LarkGateway } from './lark-client.ts'
import { buildResumeRows, formatResumeTable, pickResumeRow, type ResumeRow, type SessionPersistenceLike } from './resume-table.ts'
import { foldBoundEvent, foldChildEvent, initialRunState, lastTurnBody, type RunState, subagentRows } from './run-state.ts'
import type { SessionBinder } from './binder.ts'
import type { StateStore } from './state-store.ts'
import { clipLine, segmentText } from './text.ts'

/** A pending /resume table awaiting its index reply (5-minute lifetime). */
interface PendingPicker {
  rows: readonly ResumeRow[]
  expiresAt: number
}

const PICKER_TTL_MS = 5 * 60 * 1000

export interface BotDeps {
  readonly ctx: Context
  readonly config: ResolvedConfig
  readonly lark: LarkGateway
  readonly binder: SessionBinder
  readonly store: StateStore
  readonly allowlist: ReadonlySet<string>
  /** Clock seam for deterministic tests. */
  readonly now?: () => number
}

export class FeishuBot {
  private readonly ctx: Context
  private readonly config: ResolvedConfig
  private readonly lark: LarkGateway
  private readonly binder: SessionBinder
  private readonly store: StateStore
  private readonly allowlist: ReadonlySet<string>
  private readonly now: () => number

  private readonly runState: RunState = initialRunState()
  private pendingPicker: PendingPicker | undefined
  private cardMessageId: string | undefined
  private cardHash: string | undefined
  /** Inbound message that triggered the current turn (for the done reaction). */
  private turnOriginMessageId: string | undefined
  private ticker: ReturnType<typeof setInterval> | undefined
  private disposed = false

  /** Inbound queue — the WS handler only pushes; a serial drain processes. */
  private readonly queue: InboundMessage[] = []
  private draining = false

  constructor(deps: BotDeps) {
    this.ctx = deps.ctx
    this.config = deps.config
    this.lark = deps.lark
    this.binder = deps.binder
    this.store = deps.store
    this.allowlist = deps.allowlist
    this.now = deps.now ?? Date.now
  }

  /** Wire subscriptions, start the beat, open the Lark connection. */
  async start(): Promise<void> {
    await this.store.ready()
    const offFirehose = this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      try {
        this.onSessionEvent(session, event)
      } catch (error) {
        this.ctx.logger.warn('dsh-feishu: firehose fold failed: %o', error)
      }
    })
    const interval = setInterval(() => {
      try {
        this.beat()
      } catch {
        // A throwing beat must never take the process down.
      }
    }, this.config.statusIntervalMs)
    interval.unref?.()
    this.ticker = interval
    this.cleanupFns.push(offFirehose, () => clearInterval(interval))
    await this.lark.start(data => this.enqueue(data))
    // Restore the binding WITHOUT resuming: if the persisted session happens
    // to be live in this process, attach to it (no side effects). A stored
    // but cold id stays in the store only — the lazy resume happens on the
    // operator's first interaction, because an eager resume at startup would
    // occupy the registry and could block the TUI from resuming that session.
    const bound = this.store.get().boundSessionId
    if (bound !== undefined) {
      const live = this.binder.getAgentFor(bound)
      if (live !== undefined) {
        try {
          await this.binder.bind(bound)
          this.maybeOpenCardForRunningAgent()
        } catch (error) {
          this.ctx.logger.warn('dsh-feishu: stored binding %s attach failed: %o', bound, error)
        }
      } else if (this.store.get().boundSessionId !== undefined) {
        this.ctx.logger.info('dsh-feishu: stored binding %s is not live — will resume on first use', bound)
      }
    }
  }

  private readonly cleanupFns: Array<() => void> = []

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const fn of this.cleanupFns.splice(0)) {
      try { fn() } catch { /* contained */ }
    }
    if (this.ticker !== undefined) clearInterval(this.ticker)
    this.lark.close()
    await this.binder.dispose().catch(() => undefined)
  }

  // ------------------------------------------------------------- inbound --

  /** WS receive callback — enqueue-only (3s ack window; no business logic). */
  private enqueue(data: unknown): void {
    const message = parseReceiveEvent(data)
    if (message === undefined) return
    this.queue.push(message)
    if (this.queue.length > 50) this.queue.splice(0, this.queue.length - 50)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) return
    this.draining = true
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const message = this.queue.shift()!
        try {
          await this.process(message)
        } catch (error) {
          this.ctx.logger.warn('dsh-feishu: inbound processing failed: %o', error)
        }
      }
    } finally {
      this.draining = false
    }
  }

  private async reply(text: string): Promise<void> {
    const chatId = this.store.get().lastChatId
    if (chatId === undefined) return
    await this.lark.sendText(chatId, text)
  }

  /** Reply with a long body, segmented at the configured size. */
  private async replyLong(text: string): Promise<void> {
    const chatId = this.store.get().lastChatId
    if (chatId === undefined) return
    for (const segment of segmentText(text, this.config.bodySegmentChars)) {
      await this.lark.sendText(chatId, segment)
    }
  }

  private async process(message: InboundMessage): Promise<void> {
    if (!isOperator(message.openId, this.allowlist)) return // silent — non-operator
    if (message.chatType !== 'p2p') return // v1: private chat only
    if (this.store.get().lastChatId !== message.chatId) {
      await this.store.update({ lastChatId: message.chatId })
    }
    if (message.messageType !== 'text' || message.text === undefined) {
      await this.reply('目前仅支持文本消息。')
      return
    }
    const intent = classifyInbound(message.text)
    switch (intent.kind) {
      case 'help': await this.reply(helpText(this.boundId() !== undefined)); break
      case 'resume': await this.handleResumeList(); break
      case 'resume-pick': await this.handleResumePick(intent.n); break
      case 'new': await this.handleNew(); break
      case 'status': await this.reply(this.statusText()); break
      case 'stop': await this.handleStop(); break
      case 'sub': await this.handleSub(intent.n); break
      case 'display':
        await this.store.update({ displayThink: intent.value === 'on' })
        await this.reply(intent.value === 'on' ? '已开启 think/tool 尾行显示。' : '已关闭 think/tool 尾行显示。')
        break
      case 'rejected':
        await this.reply(`「/${intent.name}」属于配置类命令，请在电脑端操作。`)
        break
      case 'passthrough': await this.handlePassthrough(intent.name, intent.line); break
      case 'prompt': await this.handlePrompt(message, intent.text); break
    }
  }

  // ------------------------------------------------------------ commands --

  private async handleResumeList(): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (persistence === undefined) {
      await this.reply('当前 profile 没有 session 持久化服务，无法列出会话。')
      return
    }
    let rows: ResumeRow[]
    try {
      rows = await buildResumeRows(persistence)
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: /resume list failed: %o', error)
      await this.reply('读取会话列表失败，请稍后再试。')
      return
    }
    this.pendingPicker = { rows, expiresAt: this.now() + PICKER_TTL_MS }
    await this.reply(formatResumeTable(rows, this.now()))
  }

  private async handleResumePick(n: number): Promise<void> {
    const picker = this.pendingPicker
    if (picker === undefined || picker.expiresAt < this.now()) {
      this.pendingPicker = undefined
      await this.reply('选择已过期。先发 /resume 查看会话列表。')
      return
    }
    const row = pickResumeRow(picker.rows, n)
    if (row === undefined) {
      await this.reply(`序号超出范围（1–${picker.rows.length}）。重新发 /resume 刷新列表。`)
      return
    }
    try {
      const bound = await this.binder.bind(row.sessionId)
      await this.store.update({ boundSessionId: row.sessionId })
      this.pendingPicker = undefined
      this.resetRunView()
      await this.reply(
        `已进入会话：${row.preview}\n`
        + `（${bound.mode === 'attached' ? '附着正在运行的会话' : '已从持久化恢复'} · ${row.sessionId.slice(0, 8)}）\n`
        + '直接发消息即可派活；/help 查看全部命令。',
      )
      this.maybeOpenCardForRunningAgent()
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: bind %s failed: %o', row.sessionId, error)
      await this.reply('进入会话失败，请重试或换一个。')
    }
  }

  private async handleNew(): Promise<void> {
    if (this.binder.getSessionId() === undefined) {
      await this.reply('当前未绑定会话。发 /resume 查看可进入的会话。')
      return
    }
    await this.binder.detach()
    await this.store.update({ boundSessionId: undefined })
    this.resetRunView()
    await this.closeCardAsDetached()
    await this.reply('已解绑。发 /resume 进入其他会话。')
  }

  private async handleStop(): Promise<void> {
    const agent = this.binder.getAgent()
    if (agent === undefined) {
      await this.reply('当前未绑定会话。')
      return
    }
    if (agent.status !== 'running') {
      await this.reply('当前没有正在运行的 turn。')
      return
    }
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      await this.reply('已发送停止指令（排队中的消息保留）。')
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: stop failed: %o', error)
      await this.reply('停止指令发送失败。')
    }
  }

  private async handleSub(n: number): Promise<void> {
    const rows = subagentRows(this.runState)
    if (rows.length === 0) {
      await this.reply('当前 turn 没有子代理活动。')
      return
    }
    if (n < 1 || n > rows.length) {
      await this.reply(`序号超出范围（1–${rows.length}）。`)
      return
    }
    const row = rows[n - 1]!
    const status = row.outcome === undefined ? '运行中' : `已结束（${row.outcome}）`
    const lines = [
      `🧵 ${row.label} · ${status}`,
      `round ${row.rounds}${row.lastTool !== undefined ? ` · 最近工具 ${row.lastTool}` : ''}`,
    ]
    if (row.tail !== undefined) lines.push(`最新输出：${clipLine(row.tail, 500)}`)
    else lines.push('（暂无输出）')
    await this.reply(lines.join('\n'))
  }

  private async handlePassthrough(name: string, line: string): Promise<void> {
    const agent = await this.ensureBoundAgent()
    if (agent === undefined) {
      await this.reply('尚未绑定会话。先发 /resume 进入一个会话。')
      return
    }
    const commands = this.ctx.get('commands') as
      | { execute: (...args: never[]) => unknown; find?: (agent: Agent, name: string) => unknown }
      | undefined
    if (commands === undefined) {
      await this.reply('当前 profile 没有命令服务，无法透传。')
      return
    }
    if (commands.find?.(agent, name) === undefined) {
      await this.reply(`命令 /${name} 在当前环境不可用。`)
      return
    }
    try {
      // rc.7: execute(agent, line, signal) — rc.8 inserts an images array
      // before the signal; probe the arity like dsh-tui-pi does.
      const signal = AbortSignal.timeout(30_000)
      const execution = (commands.execute as (...args: unknown[]) => unknown)(
        ...commands.execute.length >= 4 ? [agent, line, [], signal] : [agent, line, signal],
      ) as Promise<{ result?: { kind?: string; text?: string } } | undefined>
      const outcome = await execution
      const text = outcome?.result?.text
      if (outcome?.result?.kind === 'error') {
        await this.reply(`/${name} 执行失败：${clipLine(text ?? '未知错误', 500)}`)
      } else if (text !== undefined && text !== '') {
        await this.replyLong(text)
      } else {
        await this.reply(`/${name} 已执行。`)
      }
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: passthrough /%s failed: %o', name, error)
      await this.reply(`/${name} 执行出错。`)
    }
  }

  private async handlePrompt(message: InboundMessage, text: string): Promise<void> {
    if (text === '') return
    const agent = await this.ensureBoundAgent()
    if (agent === undefined) {
      await this.reply('尚未绑定会话。发 /resume 查看并进入一个会话；/help 查看命令。')
      return
    }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    // Tie the done-reaction to this message only when OUR prompt opens the
    // next turn; a prompt queued behind a running (TUI-driven) turn would
    // otherwise react on the wrong turn's completion.
    if (agent.status !== 'running') {
      this.turnOriginMessageId = message.messageId
    }
    await this.lark.react(message.messageId, EMOJI_SEEN)
  }

  /** Resolve the bound session to a live agent, resuming it if needed. */
  private async ensureBoundAgent(): Promise<Agent | undefined> {
    const id = this.binder.getSessionId() ?? this.store.get().boundSessionId
    if (id === undefined) return undefined
    const live = this.binder.getAgent()
    if (live !== undefined) return live
    try {
      const bound = await this.binder.bind(id)
      await this.store.update({ boundSessionId: id })
      this.maybeOpenCardForRunningAgent()
      return bound.agent
    } catch {
      return undefined
    }
  }

  // ------------------------------------------------------------ firehose --

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const boundId = this.binder.getSessionId()
    if (boundId === undefined || this.disposed) return
    const sessionId = String(session.id)
    if (sessionId === boundId) {
      foldBoundEvent(this.runState, event)
      if (event.type === 'turn/start') {
        void this.openCard()
      } else if (event.type === 'turn/end') {
        void this.finalizeTurn()
      }
      return
    }
    const header = session.header as
      | { parentSession?: string; origin?: string; delegationDepth?: number }
      | undefined
    if (
      header?.parentSession !== undefined && String(header.parentSession) === boundId
      && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)
    ) {
      foldChildEvent(this.runState, sessionId, event)
    }
  }

  // ---------------------------------------------------------- status card --

  private sessionLabel(): string {
    const id = this.binder.getSessionId()
    return id === undefined ? '—' : id.slice(0, 8)
  }

  /** Open the per-turn card (bound session's agent is mid-turn). */
  private async openCard(): Promise<void> {
    const chatId = this.store.get().lastChatId
    if (chatId === undefined) return // silent-start rule: nowhere to send yet
    const { card, hash } = buildStatusCard(this.runState, {
      sessionLabel: this.sessionLabel(),
      displayThink: this.store.get().displayThink,
      now: this.now(),
    })
    const messageId = await this.lark.sendCard(chatId, card)
    if (messageId !== undefined) {
      this.cardMessageId = messageId
      this.cardHash = hash
    }
  }

  /** A bind landed while the agent is already running — open the card late. */
  private maybeOpenCardForRunningAgent(): void {
    if (this.cardMessageId !== undefined) return
    const agent = this.binder.getAgent()
    if (agent === undefined || agent.status !== 'running') return
    // Mid-turn attach: no turn/start was observed. Synthesize the running
    // baseline so the card opens and the beat patches it; per-turn counters
    // count from the attach moment (no history replay by design).
    if (!this.runState.running) {
      this.runState.running = true
      this.runState.turnStartedAt = this.now()
    }
    void this.openCard()
  }

  /** Status beat: patch the open card only when rendered content changed. */
  private beat(): void {
    if (this.cardMessageId === undefined || !this.runState.running) return
    const { card, hash } = buildStatusCard(this.runState, {
      sessionLabel: this.sessionLabel(),
      displayThink: this.store.get().displayThink,
      now: this.now(),
    })
    if (hash === this.cardHash) return
    this.cardHash = hash
    void this.lark.patchCard(this.cardMessageId, card)
  }

  /** turn/end: finalize the card, then send the assistant body. */
  private async finalizeTurn(): Promise<void> {
    const chatId = this.store.get().lastChatId
    if (chatId === undefined) {
      this.cardMessageId = undefined
      return
    }
    const { card } = buildStatusCard(this.runState, {
      sessionLabel: this.sessionLabel(),
      displayThink: this.store.get().displayThink,
      now: this.now(),
    })
    if (this.cardMessageId !== undefined) {
      const ok = await this.lark.patchCard(this.cardMessageId, card)
      if (!ok) {
        // Patch failed (card too old / deleted) — the summary still matters:
        // fall back to sending the finalized card as a fresh message.
        await this.lark.sendCard(chatId, card)
      }
    }
    this.cardMessageId = undefined
    this.cardHash = undefined

    const body = lastTurnBody(this.runState)
    if (body !== '') {
      await this.replyLong(body)
    }
    if (this.turnOriginMessageId !== undefined) {
      const origin = this.turnOriginMessageId
      this.turnOriginMessageId = undefined
      await this.lark.react(origin, this.runState.turnEndReason === 'error' ? 'THUMBSDOWN' : EMOJI_DONE)
    }
  }

  /** Patch the open card into a detached state and forget it (/new). */
  private async closeCardAsDetached(): Promise<void> {
    const messageId = this.cardMessageId
    this.cardMessageId = undefined
    this.cardHash = undefined
    if (messageId === undefined) return
    const card: InteractiveCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `dsh · ${this.sessionLabel()} · 已解绑` },
        template: 'grey',
      },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: '⏏️ 会话已解绑（/resume 可重新进入）' } }],
    }
    await this.lark.patchCard(messageId, card)
  }

  /** Clear the run view (new binding / detach) — no history replay. */
  private resetRunView(): void {
    const fresh = initialRunState()
    Object.assign(this.runState, fresh)
    this.runState.subagents = fresh.subagents
    this.runState.runSeqToChild = fresh.runSeqToChild
    this.cardMessageId = undefined
    this.cardHash = undefined
    this.turnOriginMessageId = undefined
  }

  // --------------------------------------------------------------- /status --

  /** Effective bound id: live binding first, then the stored (not-yet-resumed) one. */
  private boundId(): string | undefined {
    return this.binder.getSessionId() ?? this.store.get().boundSessionId
  }

  private statusText(): string {
    const id = this.binder.getSessionId() ?? this.store.get().boundSessionId
    if (id === undefined) {
      return ['🧷 未绑定会话。发 /resume 查看可进入的会话。', '', helpText(false)].join('\n')
    }
    const agent = this.binder.getAgent()
    const state = this.runState
    const lines = [`🧷 绑定：${id.slice(0, 8)}（${agent === undefined ? '未激活' : agent.status === 'running' ? '运行中' : '空闲'}）`]
    if (state.running || state.turnEndedAt !== undefined) {
      const parts = [`rounds ${state.rounds}`]
      if (state.toolsDone > 0 || state.toolsFailed > 0) parts.push(`tools ✔${state.toolsDone} ✘${state.toolsFailed}`)
      if (state.retries > 0) parts.push(`↻${state.retries}`)
      const live = subagentRows(state).filter(row => row.outcome === undefined).length
      if (live > 0) parts.push(`🧵 ×${live}`)
      lines.push(`▶ 本轮：${parts.join(' · ')}`)
      if (state.lastAssistantLine !== undefined) lines.push(`最后输出：${clipLine(state.lastAssistantLine, 120)}`)
    }
    lines.push(`🖥 think 尾行：${this.store.get().displayThink ? 'on' : 'off'}（/display think on|off）`)
    return lines.join('\n')
  }
}
