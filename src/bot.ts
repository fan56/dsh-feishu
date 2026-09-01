/**
 * The bot orchestrator: inbound queue → command routing → session binding →
 * status-card lifecycle.
 *
 * Lifecycle rules (design doc §2/§5 定稿):
 * - silent startup — the bot never sends anything unprompted;
 * - binding only through /resume; unbound input gets one hint line;
 * - prompts inject via `agent.steer` while a turn runs (join the CURRENT
 *   turn's next round — the operator's mid-course corrections land
 *   immediately) and `agent.followup` when idle (open the next turn);
 * - one card per ROUND: opened when the round starts (turn/start, or right
 *   after the previous round settled), patched in place on the 5s status
 *   beat ONLY when content changed (pseudo-streaming: in-flight text grows
 *   a ✍️ tail between beats), settled to "Round N · 💬 回复" when its
 *   assistant/message lands — the round's text ships verbatim as a body
 *   card right after — and the turn's last card carries the end state;
 * - card operations serialize on a chain so settle-patch → body → next-open
 *   never interleave with the beat or turn/end;
 * - no replay of session history on bind (live events from bind time on).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type LlmRuntime, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { isOperator } from './allowlist.ts'
import {
  buildAskAnsweredCard,
  buildAskCard,
  buildAskDismissedCard,
  parseAskAction,
  parseAskFormValue,
} from './ask-card.ts'
import { acquireWriterLock, releaseOwnedWriterLock, WriterLockedError, type WriterLockAcquisition } from './writer-lock.ts'
import { defaultRepairBackend, type RepairBackend } from './log-repair.ts'
import {
  buildModelPickCard,
  buildModelProviderCard,
  buildModelProviderSettledCard,
  buildModelSettledCard,
  parseModelProviderAction,
  parseModelSubmitAction,
  type ModelInfo,
  type ModelProviderInfo,
} from './model-card.ts'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { SelectorManager, type SelectorOutcome } from './selector.ts'
import { parseSelectorAction, type SelectorSpec } from './selector-card.ts'
import {
  runPermissionCommand,
  runProfileSwitchCommand,
  runSelectSkillCommand,
  runThinkCommand,
  type CurrentSelection,
  type InteractiveHost,
  type ModelSelectionUpdate,
} from './interactive.ts'
import { buildResumePickerCard, buildResumePickedCard, parseResumeAction, type ParsedResumeAction } from './card.ts'
import { buildBodyCard, buildSessionListAsMarkdown, buildSessionListCard, buildStatusCard, type Schema2Card } from './card.ts'
import { classifyInbound, helpText, refusedReply } from './commands.ts'
import { buildBtwSnapshot, type BtwStreamChunk } from './btw.ts'
import { BtwManager } from './btw-bot.ts'
import type { ResolvedConfig } from './config.ts'
import { parseReceiveEvent, type InboundMessage } from './inbound.ts'
import { EMOJI_DONE, EMOJI_SEEN, type LarkGateway } from './lark-client.ts'
import { buildResumeRows, loadSessionLastUpdates, pickResumeRow, type ResumeRow, type SessionPersistenceLike } from './resume-table.ts'
import {
  applyChildBackfill,
  applyRouteBackfill,
  backfillFromChildLog,
  backfillRouteFromLog,
  beginRound,
  foldBoundEvent,
  foldChildEvent,
  initialRunState,
  type RunState,
  subagentRows,
} from './run-state.ts'
import type { BindResult, SessionBinder } from './binder.ts'
import type { StateStore } from './state-store.ts'
import { clipLine, segmentText } from './text.ts'

/** A pending /resume table awaiting its index reply (5-minute lifetime). */
interface PendingPicker {
  /** Matches the interactive picker card's submit button (card callback path). */
  id: string
  rows: readonly ResumeRow[]
  expiresAt: number
}

/**
 * Structural view of dsh's ask request (the fields the phone side needs).
 * The agent reference identifies the asking session for claim routing.
 */
interface AskRequestLike {
  questions: AskUserQuestionItem[]
  agent?: { session?: { id?: unknown } }
  signal?: AbortSignal
}

/** Structural view of the ask-router's surface registry (dsh-ask-router). */
interface AskSurfacesLike {
  register(surface: {
    name: string
    claim(request: AskRequestLike): boolean
    ask(request: AskRequestLike): Promise<AskUserQuestionAnswer>
    settled?(request: AskRequestLike, by: string): void
  }): () => void
}

/** One live question whose card is out on the operator's phone. */
interface PendingAsk {
  readonly questions: AskUserQuestionItem[]
  messageId: string | undefined
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  readonly reject: (error: Error) => void
}

/** The operator open_id a card.action payload carries, when well-formed. */
function cardOperatorOf(data: unknown): string | undefined {
  const operator = (data as { operator?: { open_id?: unknown } }).operator?.open_id
  return typeof operator === 'string' ? operator : undefined
}

/** Localize the lock holder's timestamp for the phone card; empty stays empty. */
function formatHolderSince(iso: string): string {
  if (iso === '') return ''
  try {
    const at = new Date(iso)
    if (!Number.isNaN(at.getTime())) return `，自 ${at.toLocaleString('zh-CN', { hour12: false })}`
  } catch {
    // Informational only — fall through to the bare form.
  }
  return ''
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
  /** Corrupt-log repair seam (tests inject a fake; default spawns the tool). */
  readonly repair?: RepairBackend
}

export class FeishuBot {
  private readonly ctx: Context
  private readonly config: ResolvedConfig
  private readonly lark: LarkGateway
  private readonly binder: SessionBinder
  private readonly store: StateStore
  private readonly allowlist: ReadonlySet<string>
  private readonly now: () => number
  private readonly repair: RepairBackend

  private readonly runState: RunState = initialRunState()
  /** Serializes card operations (open/patch/settle/finalize) in event order. */
  private cardChain: Promise<unknown> = Promise.resolve()
  private pendingPicker: PendingPicker | undefined
  private cardMessageId: string | undefined
  private cardHash: string | undefined
  /** Session id whose route facts were already backfilled from its log. */
  private routeBackfilledFor: string | undefined
  /** Live ask-user questions keyed by the card's question id. */
  private readonly pendingAsks = new Map<string, PendingAsk>()
  /** ask() request object → question id (router settled() arrives per-request). */
  private readonly askRequestIds = new WeakMap<object, string>()
  /** The interactive /resume picker card awaiting a form submit. */
  private resumeCardMessageId: string | undefined
  /** Bot-created sessions' model selection refs (/model live-switch). */
  private readonly selectionRefs = new Map<string, ModelSelectionRef>()
  /** /btw side-question manager (phone surface; per-surface by design). */
  private readonly btw: BtwManager
  /** The in-flight /model two-step flow. */
  private modelFlow: {
    id: string
    provider: string | undefined
    providerCardMessageId: string | undefined
    cardMessageId: string | undefined
  } | undefined
  /** Generic selection-card flows (selector FW; driven via presentSelection). */
  private readonly selectors: SelectorManager
  /** Session ids with a corrupt-repair confirmation card currently out. */
  private readonly repairFlows = new Set<string>()
  /** Bot-side surfaces the interactive adapters drive (selector-FW commands). */
  private readonly host: InteractiveHost
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
    this.repair = deps.repair ?? defaultRepairBackend
    this.selectors = new SelectorManager({
      // Card ops ride the same serial chain as every other card lifecycle
      // step so selector sends/patches never interleave with a settle.
      sendCard: (chatId, card) => this.chain(() => this.lark.sendCard(chatId, card as Schema2Card)),
      patchCard: (messageId, card) => this.chain(() => this.lark.patchCard(messageId, card as Schema2Card)),
      allowlisted: openId => isOperator(openId, this.allowlist),
      logger: this.ctx.logger,
    })
    this.host = {
      ctx: this.ctx,
      store: this.store,
      binder: this.binder,
      reply: text => this.reply(text),
      presentSelection: (chatId, spec) => this.presentSelection(chatId, spec),
      applyModelSelection: selection => this.applyModelSelection(selection),
      injectPrompt: text => this.injectPrompt(text),
      executeCommand: (name, line) => this.handlePassthrough(name, line),
      currentSelection: () => this.currentModelSelection(),
      boundAgent: () => this.ensureBoundAgent(),
    }
    // /btw — by-the-way side questions (phone copy of dsh-tui-pi's engine,
    // docs/adr/0001-btw-duplicated-not-shared.md). Per-surface by design:
    // this queue/slot/cancellation is independent of the TUI's overlay.
    this.btw = new BtwManager({
      stream: options => {
        const llm = this.ctx.get('llm') as LlmRuntime | undefined
        if (llm === undefined) throw new Error('LLM 服务不可用。')
        return llm.stream({
          provider: options.provider,
          model: options.model,
          ...(options.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: options.reasoningEffort as ReasoningEffortId }),
          messages: options.messages,
          system: options.system,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }) as AsyncIterable<BtwStreamChunk>
      },
      sendCard: (chatId, card) => this.chain(() => this.lark.sendCard(chatId, card as Schema2Card)),
      patchCard: (messageId, card) => this.chain(() => this.lark.patchCard(messageId, card as Schema2Card)),
      notify: text => { void this.reply(text).catch(() => undefined) },
      resolveSelection: () => {
        // Sync projection only: a running main line always has a live route
        // (selectionRef / runState) — the persistence fallback is irrelevant
        // for a btw, which requires the main line to be running.
        const bound = this.binder.getSessionId()
        const ref = bound === undefined ? undefined : this.selectionRefs.get(bound)?.current
        if (ref !== undefined && ref.provider !== undefined && ref.model !== undefined) {
          return {
            provider: ref.provider,
            model: ref.model,
            ...(ref.reasoningEffort === undefined ? {} : { reasoningEffort: ref.reasoningEffort }),
          }
        }
        if (this.runState.provider !== undefined && this.runState.model !== undefined) {
          return {
            provider: this.runState.provider,
            model: this.runState.model,
            ...(this.runState.reasoningEffort === undefined ? {} : { reasoningEffort: this.runState.reasoningEffort }),
          }
        }
        return undefined
      },
      buildSnapshot: () => {
        const agent = this.binder.getAgent()
        return agent === undefined
          ? []
          : buildBtwSnapshot(agent.session.snapshotEvents(), this.config.btwContextMessages)
      },
      isMainRunning: () => this.binder.getAgent()?.status === 'running',
      isReadOnlyView: () => this.binder.isReadOnlyView(),
      beatMs: this.config.statusIntervalMs,
      logger: this.ctx.logger,
    })
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
    this.registerAskSurface()
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
          this.backfillRoute()
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
    this.btw.dispose()
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

  /** Run a card operation after every previously queued one completes. */
  private chain<T>(op: () => Promise<T>): Promise<T> {
    const run = this.cardChain.then(op, op)
    this.cardChain = run.catch(() => undefined)
    return run
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

  /** Reply with a body card — markdown renders in lark_md, not in msg_type=text. */
  private async reply(text: string): Promise<void> {
    const chatId = this.store.get().lastChatId
    if (chatId === undefined) return
    await this.lark.sendCard(chatId, buildBodyCard(text))
  }

  /** Reply with a long body, segmented at the configured size; each segment ships as its own card. */
  private async replyLong(text: string): Promise<void> {
    const chatId = this.store.get().lastChatId
    if (chatId === undefined) return
    for (const segment of segmentText(text, this.config.bodySegmentChars)) {
      await this.lark.sendCard(chatId, buildBodyCard(segment))
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
      case 'model': await this.handleModel(); break
      case 'think': await this.interactiveCommand(runThinkCommand); break
      case 'permission': await this.interactiveCommand(runPermissionCommand); break
      case 'select-skill': await this.interactiveCommand(runSelectSkillCommand); break
      case 'profile-switch': await this.interactiveCommand(runProfileSwitchCommand); break
      case 'btw': await this.handleBtw(message, intent.line); break
      case 'display':
        await this.store.update({ displayThink: intent.value === 'on' })
        await this.reply(intent.value === 'on' ? '已开启思考尾行显示。' : '已关闭思考尾行显示（/feishu-plugin think on 重新开启）。')
        break
      case 'rejected':
        await this.reply(refusedReply(intent.name))
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
      // Same last-update ordering as the TUI picker (jsonl mtimes; the walk
      // is best-effort and never throws — an unknown store root degrades to
      // createdAt ordering).
      rows = await buildResumeRows(persistence, await loadSessionLastUpdates())
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: /resume list failed: %o', error)
      await this.reply('读取会话列表失败，请稍后再试。')
      return
    }
    const pickerId = randomUUID()
    this.pendingPicker = { id: pickerId, rows, expiresAt: this.now() + PICKER_TTL_MS }
    await this.store.update({ picker: this.pendingPicker })
    const chatId = this.store.get().lastChatId
    if (chatId === undefined) return
    const style = this.config.resumeListStyle ?? 'auto'
    if (style === 'list') {
      await this.lark.sendCard(chatId, buildSessionListAsMarkdown(rows, this.now()))
      return
    }
    // sendCard swallows API errors and resolves undefined — that is the only
    // failure signal we get at send time: server rejection, rate-limit retries
    // exhausted, or a transport error. An old client that receives the card but
    // silently renders the table element blank fails AFTER delivery, which is
    // undetectable here — that scenario needs `resumeListStyle: 'list'` to
    // force the markdown list outright. In `auto` mode degrade exactly once on
    // a send-time failure; a second failure falls through to the existing
    // onError sink.
    const messageId = await this.lark.sendCard(chatId, buildResumePickerCard(rows, pickerId, this.now()))
    if (messageId === undefined && style === 'auto') {
      this.ctx.logger.warn('dsh-feishu: /resume picker card failed to send — falling back to markdown list')
      await this.lark.sendCard(chatId, buildSessionListAsMarkdown(rows, this.now()))
      return
    }
    this.resumeCardMessageId = messageId
  }

  /**
   * The effective picker: the in-memory one wins, the PERSISTED one is the
   * fallback after a restart (bot state survives reboots; the raw picker
   * previously died with the process, stranding `/resume N` replies).
   */
  private currentPicker(): PendingPicker | undefined {
    return this.pendingPicker ?? this.store.get().picker
  }

  private async handleResumePick(n: number): Promise<void> {
    await this.resumePickCore(n)
  }

  /** Interactive picker submit (card.action.trigger) → same core as /resume N. */
  private async handleResumeAction(parsed: ParsedResumeAction): Promise<void> {
    const picker = this.currentPicker()
    if (picker === undefined || picker.id !== parsed.pickerId) {
      // A stale card from an earlier list — its picker id no longer matches.
      this.reply('选择已过期（旧列表的卡片）。先发 /resume 刷新。').catch(() => undefined)
      return
    }
    await this.resumePickCore(parsed.index)
  }

  /** Shared bind flow for the text path (/resume N) and the card submit. */
  private async resumePickCore(n: number): Promise<void> {
    const picker = this.currentPicker()
    if (picker === undefined || picker.expiresAt < this.now()) {
      this.pendingPicker = undefined
      await this.store.update({ picker: undefined })
      this.resumeCardMessageId = undefined
      await this.reply('选择已过期。先发 /resume 查看会话列表。')
      return
    }
    const row = pickResumeRow(picker.rows, n)
    if (row === undefined) {
      await this.reply(`序号超出范围（1–${picker.rows.length}）。重新发 /resume 刷新列表。`)
      return
    }
    try {
      await this.bindAndAnnounce(row)
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: bind %s failed: %o', row.sessionId, error)
      if (error instanceof WriterLockedError) {
        await this.degradeToRemoteWatch(row, error)
        return
      }
      // The reason rides along (clipped): a bare "failed" on the phone gave
      // nothing to debug from — the whole /resume investigation stalled on it.
      const reason = clipLine(String(error instanceof Error ? error.message : error), 200)
      if (/corrupt .*(session|zstandard) log/i.test(reason)) {
        // Torn record inside a complete zstd frame — historical double-writer
        // damage. The phone can repair it in place (vendored tool + backup);
        // without a locatable log dir, keep pointing at the desktop tool.
        await this.offerCorruptRepair(row)
        return
      }
      await this.reply(`进入会话失败：${reason === '' ? '未知错误' : reason}`)
    }
  }

  /**
   * The single-writer guard fired on a bind: another live process drives the
   * session. Degrade to a READ-ONLY view over its persisted log instead of a
   * dead end — the same fold pipeline paints round cards, so every turn's
   * final reply still lands on the phone (poll-delayed). Shared by the
   * /resume failure path and the post-repair re-entry (a racer can steal the
   * session in the gap between the repair lock release and the bind).
   */
  private async degradeToRemoteWatch(row: ResumeRow, error: WriterLockedError): Promise<void> {
    // Read-only watching is not a live main line — btw has nothing to run
    // alongside; cancel any in-flight side call on the switch.
    this.btw.cancelAll()
    try {
      const since = formatHolderSince(error.holder.createdAt)
      await this.binder.watchRemote(row.sessionId, async events => {
        for (const event of events) {
          // Stub session header matching the bound id — turn cards,
          // tool rows and todo updates reuse the live pipeline verbatim.
          this.onSessionEvent({ id: row.sessionId } as Session, event as unknown as SessionEvent)
        }
      })
      // Queued follow-ups drive an automatic takeover at the next idle.
      this.binder.setOnPromotable(async () => {
        await this.store.update({ boundSessionId: row.sessionId })
        this.resetRunView()
        this.backfillRoute()
        this.binder.drainOutboxIntoAgent()
        await this.reply('已自动接管该会话，排队消息已发送；本轮起由此端驱动。')
      })
      await this.store.update({ boundSessionId: row.sessionId })
      await this.reply(
        `已进入只读旁观：${row.preview}\n`
        + `该会话正由另一进程驱动（pid ${error.holder.pid}${since}），为避免日志分叉不能从这里派活；\n`
        + '对面的最终回复会同步到这里。/resume 或 /new 可切换。',
      )
    } catch (watchError: unknown) {
      this.ctx.logger.warn('dsh-feishu: watch remote %s failed: %o', row.sessionId, watchError)
      // Watching is best-effort — its own failure gets a plain refusal.
      const reason = clipLine(String(watchError instanceof Error ? watchError.message : watchError), 200)
      await this.reply(`只读旁观失败：${reason === '' ? '未知错误' : reason}`)
    }
  }

  /**
   * The bind + first-reply + picker-settle half of a successful /resume —
   * shared by the picker path and the post-repair re-entry (whose picker is
   * long gone; the row alone is enough). `notice`, when given, prefixes the
   * announcement so a repair lands as ONE message after the bind succeeded.
   */
  private async bindAndAnnounce(row: ResumeRow, notice?: string): Promise<BindResult> {
    // Switching sessions strands the btw context snapshot — cancel first.
    this.btw.cancelAll()
    const bound = await this.binder.bind(row.sessionId, await this.resolveResumeRoute(row.sessionId))
    await this.store.update({ boundSessionId: row.sessionId, picker: undefined })
    this.pendingPicker = undefined
    this.resetRunView()
    this.backfillRoute()
    await this.reply(
      (notice === undefined ? '' : `${notice}\n`)
      + `已进入会话：${row.preview}\n`
      + `（${bound.mode === 'attached' ? '附着正在运行的会话' : '已从持久化恢复'} · ${row.sessionId.slice(0, 8)}）\n`
      + '直接发消息即可派活；/help 查看全部命令。',
    )
    // Settle the interactive picker card (best-effort; absent after restart).
    if (this.resumeCardMessageId !== undefined) {
      const cardId = this.resumeCardMessageId
      this.resumeCardMessageId = undefined
      void this.chain(() => this.lark.patchCard(cardId, buildResumePickedCard(row)))
    }
    this.maybeOpenCardForRunningAgent()
    return bound
  }

  // -------------------------------------------------------- corrupt repair --

  /**
   * A /resume died on a corrupt log: resolve the session's storage dir and
   * put up a repair confirmation card. The interactive part runs DETACHED —
   * resumePickCore can be executing inside a card-chain task (card submit
   * path), and presentSelection dead-locks when awaited from that chain
   * (its sends enqueue on the very same chain).
   */
  private async offerCorruptRepair(row: ResumeRow): Promise<void> {
    const dir = await this.binder.sessionDirOf(row.sessionId)
    const chatId = this.store.get().lastChatId
    if (dir === undefined || chatId === undefined) {
      await this.reply(this.corruptPointerText())
      return
    }
    if (this.repairFlows.has(row.sessionId)) {
      await this.reply('修复确认卡已在上面，请在原卡片上操作。')
      return
    }
    this.repairFlows.add(row.sessionId)
    // Detached — see the invariant above. The catch mirrors the interactive
    // command wrapper: log, then ONE best-effort reply (itself allowed to
    // fail), so a flaky Lark send never surfaces as an unhandled rejection
    // in this long-lived process.
    void this.repairFlow(row, dir, chatId)
      .catch(async error => {
        this.ctx.logger.warn('dsh-feishu: repair flow for %s failed: %o', row.sessionId, error)
        await this.reply('修复流程异常中断，原文件未动。').catch(() => undefined)
      })
      .finally(() => {
        this.repairFlows.delete(row.sessionId)
      })
  }

  /** The desktop-tool pointer (degrade path when no log dir is resolvable). */
  private corruptPointerText(): string {
    return '该会话日志已损坏（多为历史双写者写入所致），无法从这里进入。\n'
      + '修复要在电脑端做：关闭使用该会话的 dsh 进程后，运行 dsh-tui-pi 的\n'
      + 'scripts/repair-session-log.mjs <session.jsonl.zstd> --apply，\n'
      + '按提示把 *.repaired 换回原位，再重试 /resume。'
  }

  /** Confirmation card → one-shot repair → re-enter the session. */
  private async repairFlow(row: ResumeRow, dir: string, chatId: string): Promise<void> {
    let outcome: SelectorOutcome
    try {
      outcome = await this.presentSelection(chatId, {
        title: '会话日志已损坏',
        description: '（多为历史双写者写入所致）修复会重建日志并保留备份，原文件不会删除。',
        options: [
          { value: 'repair', label: '🛠 修复并进入' },
          { value: 'skip', label: '先不修' },
        ],
        mode: 'buttons',
      })
    } catch (error) {
      // The card never went out — degrade to the desktop-tool pointer.
      this.ctx.logger.warn('dsh-feishu: repair card for %s failed: %o', row.sessionId, error)
      await this.reply(this.corruptPointerText())
      return
    }
    // Expired stays silent: the framework already patched the card grey, and
    // the operator who left it to expire should not get pinged afterwards.
    if (outcome.status === 'expired') return
    if (outcome.status !== 'picked' || outcome.value !== 'repair') {
      await this.reply('好的，未做修改。')
      return
    }
    await this.repairAndEnter(row, dir)
  }

  /**
   * The guarded repair: hold the session's single-writer lock from BEFORE the
   * rebuild until the swap lands (no process can start driving the session
   * mid-way — TOCTOU), verify the rebuilt log actually loads, then swap and
   * re-enter. Every failure path releases the lock and leaves the original
   * byte-identical. The lock is dropped BEFORE the re-entry bind — a racer
   * that steals the session in that window degrades to the same read-only
   * watch a refused /resume gets.
   */
  private async repairAndEnter(row: ResumeRow, dir: string): Promise<void> {
    // Compressed or raw — sessions written without zstd exist on disk.
    const logPath = await this.repair.locateSessionLog(dir)
    if (logPath === undefined) {
      await this.reply('修复失败：会话目录下没有日志文件，原文件未动。')
      return
    }
    let claim: WriterLockAcquisition
    try {
      claim = await acquireWriterLock(dir)
    } catch (error) {
      const reason = clipLine(String(error instanceof Error ? error.message : error), 200)
      await this.reply(`修复失败：${reason === '' ? '无法确认会话写者状态' : reason}，原文件未动。`)
      return
    }
    if (!claim.ok) {
      await this.reply(`会话正被 pid ${claim.holder.pid} 驱动，不能修；先在桌面关闭该会话后再试。`)
      return
    }
    try {
      const applied = await this.repair.runRepair(logPath, { apply: true })
      if (applied.status === 'failed') {
        await this.reply(`修复失败：${applied.detail ?? '未知原因'}，原文件未动。`)
        return
      }
      if (applied.status !== 'repaired' || applied.repairedPath === undefined) {
        // The tool found no seq violations — the bind failure had another
        // shape; touching nothing is the only safe answer.
        await this.reply('修复检查未发现可修的损坏，原文件未动；请重新 /resume 看具体报错。')
        return
      }
      if (!(await this.repair.verifyClean(applied.repairedPath))) {
        await this.reply('修复失败：重建的日志未通过完整性校验，未换入，原文件未动。')
        return
      }
      await this.repair.swapRepaired(logPath, applied.repairedPath)
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: repair %s failed: %o', logPath, error)
      await this.reply(`修复失败：${clipLine(String(error instanceof Error ? error.message : error), 200) || '未知原因'}，原文件未动。`)
      return
    } finally {
      await releaseOwnedWriterLock(dir)
    }
    // Bind FIRST, announce after: replying (a network round-trip) between
    // the lock release and the bind would widen the steal window for no
    // gain — and the bind's own WriterLockedError now has a degrade path.
    try {
      await this.bindAndAnnounce(row, '✅ 已修复并换入（原件备份为 .corrupt-bak）。')
    } catch (error) {
      if (error instanceof WriterLockedError) {
        await this.degradeToRemoteWatch(row, error)
        return
      }
      const reason = clipLine(String(error instanceof Error ? error.message : error), 200)
      if (/corrupt .*(session|zstandard) log/i.test(reason)) {
        await this.reply(`换入后仍报日志损坏（${reason}）——请改用电脑端工具核查。`)
        return
      }
      await this.reply(`进入会话失败：${reason === '' ? '未知错误' : reason}`)
    }
  }

  /**
   * /new: close the current binding and start a FRESH session bound to the
   * bot. The old stream gets its visual boundary — the last card greys out
   * (已解绑), then a 🆕 header card marks where the new session begins; the
   * chat history itself is never deleted (round cards are the operator's
   * record). The new session inherits the previous one's cwd when readable,
   * else the process cwd.
   */
  private async handleBtw(message: InboundMessage, rawInput: string): Promise<void> {
    const text = await this.btw.handleBtw(rawInput, message.chatId)
    await this.reply(text)
  }

  private async handleNew(): Promise<void> {
    // A fresh session strands the btw context snapshot — cancel first.
    this.btw.cancelAll()
    const previousId = this.binder.getSessionId() ?? this.store.get().boundSessionId
    let cwd = process.cwd()
    if (previousId !== undefined) {
      const sessions = this.ctx.get('sessions') as
        | { get(id: string): { header?: { cwd?: string } } | undefined }
        | undefined
      const headerCwd = sessions?.get(previousId)?.header?.cwd
      if (typeof headerCwd === 'string' && headerCwd !== '') cwd = headerCwd
    }
    // Model selection for the fresh agent (a bare agents.create has NO
    // provider/model — the first request dies with "agent has no
    // provider/model", Round 0 ❌ in live use). Resolution order:
    // 1. the previous session's own selection incl. reasoning effort
    //    (continuity: same model + effort, fresh context) from its log;
    // 2. the phone's own stored default (provider/model/effort saved by
    //    /model, /think or /profile-switch on the phone) — the operator's
    //    explicit pick beats the settings default;
    // 3. the settings' default model via ctx.agentDefaultModel — the same
    //    fallback the TUI seeds from before creating.
    let selection: ModelSelection | undefined
    if (previousId !== undefined) {
      const sessions = this.ctx.get('sessions') as
        | { get(id: string): { events?: unknown[] } | undefined }
        | undefined
      const events = sessions?.get(previousId)?.events
      if (Array.isArray(events) && events.length > 0) {
        const backfill = backfillRouteFromLog(events as SessionEvent[])
        if (backfill.provider !== undefined && backfill.model !== undefined) {
          selection = {
            provider: backfill.provider,
            model: backfill.model,
            ...(backfill.reasoningEffort === undefined ? {} : { reasoningEffort: backfill.reasoningEffort as ModelSelection['reasoningEffort'] }),
          }
        }
      }
    }
    if (selection === undefined) {
      const phone = this.store.get().phoneModel
      if (phone?.provider !== undefined && phone?.model !== undefined) {
        selection = {
          provider: phone.provider,
          model: phone.model,
          ...(phone.reasoningEffort === undefined ? {} : { reasoningEffort: phone.reasoningEffort as ModelSelection['reasoningEffort'] }),
        }
      }
    }
    if (selection === undefined) {
      const defaultModel = this.ctx.get('agentDefaultModel') as
        | { currentSelection?: () => ModelSelection | undefined }
        | undefined
      const fallback = defaultModel?.currentSelection?.()
      if (fallback?.provider !== undefined && fallback?.model !== undefined) {
        selection = fallback
      }
    }
    // Grey out the live card BEFORE resetRunView clears cardMessageId —
    // the original ordering made this patch dead code.
    await this.closeCardAsDetached()
    this.resetRunView()
    try {
      const created = await this.binder.createNew(cwd, selection)
      if (created.selectionRef !== undefined) {
        this.selectionRefs.set(created.sessionId, created.selectionRef)
      }
      await this.store.update({ boundSessionId: created.sessionId, picker: undefined })
      const chatId = this.store.get().lastChatId
      if (chatId !== undefined) {
        const card: Schema2Card = {
          schema: '2.0',
          config: { width_mode: 'fill' },
          header: {
            title: { tag: 'plain_text', content: `🆕 新会话 · ${created.sessionId.slice(0, 8)}` },
            subtitle: { tag: 'plain_text', content: `dsh · ${cwd.split('/').pop() ?? cwd}` },
            template: 'green',
          },
          body: {
            elements: [{
              tag: 'markdown',
              content: '以上是旧会话的记录；从这里开始是新会话。直接发消息即可派活，`/resume` 可回到旧会话。',
            }],
          },
        }
        await this.lark.sendCard(chatId, card)
      }
    } catch (error) {
      // Creation failed — ensure we stay cleanly unbound and say why.
      await this.binder.detach()
      await this.store.update({ boundSessionId: undefined })
      this.ctx.logger.warn('dsh-feishu: /new create failed: %o', error)
      const reason = clipLine(String(error instanceof Error ? error.message : error), 200)
      await this.reply(`新会话创建失败：${reason === '' ? '未知错误' : reason}`)
    }
  }

  private async handleStop(): Promise<void> {
    // The stop gesture is the everything-stop: phone-side btw calls die too.
    this.btw.cancelAll()
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
      | {
          execute(
            agent: Agent,
            line: string,
            images: readonly unknown[],
            signal: AbortSignal,
          ): Promise<{ result?: { kind?: string; text?: string } } | undefined>
          find?: (agent: Agent, name: string) => unknown
        }
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
      // alpha.3 signature: execute(agent, line, images, signal) — the images
      // array is mandatory (pass empty for text-only passthrough).
      const execution = commands.execute(agent, line, [], AbortSignal.timeout(30_000))
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

  /**
   * Shared prompt-injection channel (operator messages AND the interactive
   * adapters' skill activation): running turns get steered (join the CURRENT
   * turn's next round), idle sessions open the next turn. 'refused' covers
   * the read-only view and the missing binding — callers word their replies.
   */
  private async injectPrompt(text: string): Promise<'steered' | 'opened' | 'refused'> {
    if (text === '') return 'refused'
    if (this.binder.isReadOnlyView()) return 'refused'
    const agent = await this.ensureBoundAgent()
    if (agent === undefined) return 'refused'
    const userMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    if (agent.status === 'running') {
      // Default steer: mid-turn messages join the CURRENT turn's next round
      // (dsh inbox target next-step) so course corrections land immediately,
      // instead of waiting out the turn as a queued followup.
      agent.steer(userMessage)
      return 'steered'
    }
    agent.followup(userMessage)
    return 'opened'
  }

  private async handlePrompt(message: InboundMessage, text: string): Promise<void> {
    if (text === '') return
    const readOnly = this.binder.isReadOnlyView()
    const outcome = await this.injectPrompt(text)
    if (outcome === 'refused') {
      if (readOnly) {
        await this.reply('当前为只读旁观（该会话正由另一进程驱动）。发 /resume 切换会话，或在那边直接派活。')
      } else {
        await this.reply('尚未绑定会话。发 /resume 查看并进入一个会话；/help 查看命令。')
      }
      return
    }
    if (outcome === 'opened') {
      // Tie the done-reaction to this message only when OUR prompt opens the
      // next turn; a steered message belongs to a turn we do not own.
      this.turnOriginMessageId = message.messageId
    }
    await this.lark.react(message.messageId, EMOJI_SEEN)
  }

  /**
   * Model route for a COLD resume: the target session's own log route first
   * (sessions created before the route fix have none), then the settings'
   * default model. Without it a resumed agent can come back route-less and
   * every message dies with "agent has no provider/model".
   */
  private async resolveResumeRoute(sessionId: string): Promise<{ provider: string; model: string } | undefined> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (persistence !== undefined) {
      try {
        const { events } = await persistence.inspect(SessionId(sessionId))
        const backfill = backfillRouteFromLog(events)
        if (backfill.provider !== undefined && backfill.model !== undefined) {
          return { provider: backfill.provider, model: backfill.model }
        }
      } catch {
        // unreadable log — fall through to the default model
      }
    }
    const defaultModel = this.ctx.get('agentDefaultModel') as
      | { currentSelection?: () => { provider?: string; model?: string } | undefined }
      | undefined
    const fallback = defaultModel?.currentSelection?.()
    if (fallback?.provider !== undefined && fallback?.model !== undefined) {
      return { provider: fallback.provider, model: fallback.model }
    }
    return undefined
  }

  /** Resolve the bound session to a live agent, resuming it if needed. */
  private async ensureBoundAgent(): Promise<Agent | undefined> {
    const id = this.binder.getSessionId() ?? this.store.get().boundSessionId
    if (id === undefined) return undefined
    const live = this.binder.getAgent()
    if (live !== undefined) return live
    try {
      const bound = await this.binder.bind(id, await this.resolveResumeRoute(id))
      await this.store.update({ boundSessionId: id })
      this.backfillRoute()
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
        void this.chain(() => this.openCard())
      } else if (event.type === 'assistant/message') {
        void this.chain(() => this.settleRound())
      } else if (event.type === 'turn/end') {
        void this.chain(() => this.finalizeTurn())
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
      const known = this.runState.subagents.has(sessionId)
      foldChildEvent(this.runState, sessionId, event)
      if (!known) this.backfillChild(sessionId)
    }
  }

  /**
   * Backfill the route facts (provider/model/think level/context window and
   * the cache-hit segment) from the BOUND session's own log. The route events
   * are appended only at session start or on a route change, so a mid-run
   * bind never sees them live — without this the footer shows no model, no
   * think level and a windowless ctx. Runs once per bound session; best-effort.
   */
  private backfillRoute(): void {
    const id = this.binder.getSessionId()
    if (id === undefined || this.routeBackfilledFor === id) return
    // ctx.get (NOT property access): a service not declared in `inject`
    // throws "cannot get property ... without inject" on property access —
    // this bug turned successful binds into failure replies in live use.
    const sessions = this.ctx.get('sessions') as
      | { get(id: string): { events?: unknown[] } | undefined }
      | undefined
    if (sessions === undefined) return
    try {
      const events = sessions.get(id)?.events
      if (!Array.isArray(events) || events.length === 0) return
      applyRouteBackfill(this.runState, backfillRouteFromLog(events as SessionEvent[]))
      this.routeBackfilledFor = id
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: route backfill for %s failed: %o', id, error)
    }
  }

  /**
   * Backfill a newly discovered child row from the child's OWN session log.
   * Discovery can happen long after spawn (mid-turn attach) or with the
   * child's events beating the parent's agent-start — either way the naming
   * events never reach the live firehose, and without this the card shows the
   * bare hash prefix instead of the agent name. Best-effort: no sessions
   * service or an unreadable log just keeps the fallback label.
   */
  private backfillChild(childId: string): void {
    // ctx.get (NOT property access): a service not declared in `inject`
    // throws "cannot get property ... without inject" on property access —
    // this bug turned successful binds into failure replies in live use.
    const sessions = this.ctx.get('sessions') as
      | { get(id: string): { events?: unknown[] } | undefined }
      | undefined
    if (sessions === undefined) return
    try {
      const events = sessions.get(childId)?.events
      if (!Array.isArray(events) || events.length === 0) return
      applyChildBackfill(this.runState, childId, backfillFromChildLog(events as SessionEvent[]))
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: child backfill for %s failed: %o', childId, error)
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
    } else {
      // sendCard swallows the API error; without this warn an open failure is
      // invisible (no card, no beat, finalize skips) — exactly how a rejected
      // card JSON went unnoticed in live use.
      this.ctx.logger.warn('dsh-feishu: turn card send failed — no live card this turn')
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
      this.runState.roundStartedAt = this.now()
    }
    void this.chain(() => this.openCard())
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
    void this.chain(() => this.lark.patchCard(this.cardMessageId!, card))
  }

  /**
   * One assistant/message landed = one round settled (the fold already
   * incremented rounds and captured the round's duration/text). Settle the
   * round's card to "Round N · 💬 回复", ship the round's message verbatim,
   * then open the next round's card. Runs serialized on the card chain.
   */
  private async settleRound(): Promise<void> {
    if (this.disposed) return
    const chatId = this.store.get().lastChatId
    const roundText = this.runState.lastRoundText
    if (chatId !== undefined) {
      const { card } = buildStatusCard(this.runState, {
        sessionLabel: this.sessionLabel(),
        displayThink: this.store.get().displayThink,
        now: this.now(),
        settledRoundMs: this.runState.lastRoundDurationMs,
      })
      if (this.cardMessageId !== undefined) {
        const ok = await this.lark.patchCard(this.cardMessageId, card)
        if (!ok) await this.lark.sendCard(chatId, card)
      } else {
        await this.lark.sendCard(chatId, card)
      }
      // The round's own message ships verbatim (code blocks, tables) — the
      // card's activity line is only a clipped preview of it.
      if (roundText !== '') {
        await this.replyLong(roundText)
      }
    }
    this.cardMessageId = undefined
    this.cardHash = undefined
    beginRound(this.runState)
    if (chatId !== undefined) {
      await this.openCard()
    }
  }

  /** turn/end: finalize the current card into the turn's end state. */
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
    } else {
      // No live card (turn opened before binding, or the open send failed) —
      // the finalized summary still ships as a fresh message instead of
      // vanishing entirely. Round bodies already went out per round.
      await this.lark.sendCard(chatId, card)
    }
    this.cardMessageId = undefined
    this.cardHash = undefined
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
    const card: Schema2Card = {
      schema: '2.0',
      config: { width_mode: 'fill' },
      header: {
        title: { tag: 'plain_text', content: `dsh · ${this.sessionLabel()} · 已解绑` },
        template: 'grey',
      },
      body: { elements: [{ tag: 'markdown', content: '⏏️ 会话已解绑（/resume 可重新进入）' }] },
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
    this.resumeCardMessageId = undefined
    this.modelFlow = undefined
    this.turnOriginMessageId = undefined
    this.routeBackfilledFor = undefined
    // Pending selection cards die with the old view — the new binding must
    // not inherit submits meant for it.
    this.selectors.cancelAll('run view reset')
  }

  // ------------------------------------------------------------- /model --

  /** The llm service surface the model cards need (structural). */
  private llm(): { listProviders(): readonly ModelProviderInfo[]; listModels(provider: string): Promise<readonly ModelInfo[]> } | undefined {
    return this.ctx.get('llm') as
      | { listProviders(): readonly ModelProviderInfo[]; listModels(provider: string): Promise<readonly ModelInfo[]> }
      | undefined
  }

  /**
   * /model step 1: list the registered providers (grouped classification —
   * the next step lists the chosen provider's models).
   */
  private async handleModel(): Promise<void> {
    const chatId = this.store.get().lastChatId
    const llm = this.llm()
    if (chatId === undefined || llm === undefined || typeof llm.listProviders !== 'function') {
      await this.reply('当前 profile 没有 llm 服务，无法列出模型。')
      return
    }
    const providers = [...llm.listProviders()].sort((a, b) => a.name.localeCompare(b.name))
    if (providers.length === 0) {
      await this.reply('没有已注册的 provider。')
      return
    }
    const flowId = randomUUID()
    this.modelFlow = { id: flowId, provider: undefined, providerCardMessageId: undefined, cardMessageId: undefined }
    const current = this.runState.provider !== undefined && this.runState.model !== undefined
      ? { provider: this.runState.provider, model: this.runState.model }
      : undefined
    const messageId = await this.lark.sendCard(chatId, buildModelProviderCard(providers, flowId, current))
    if (messageId !== undefined) this.modelFlow.providerCardMessageId = messageId
  }

  /** /model step 2: list the chosen provider's models. */
  private async handleModelProviderPicked(parsed: { provider: string; flowId: string }): Promise<void> {
    if (this.modelFlow === undefined || this.modelFlow.id !== parsed.flowId) return
    const llm = this.llm()
    if (llm === undefined || typeof llm.listModels !== 'function') return
    let models: readonly ModelInfo[]
    try {
      models = await llm.listModels(parsed.provider)
    } catch (error) {
      await this.reply(`列出模型失败：${clipLine(String(error instanceof Error ? error.message : error), 200)}`)
      return
    }
    if (models.length === 0) {
      await this.reply(`provider ${parsed.provider} 没有可用模型。`)
      return
    }
    this.modelFlow.provider = parsed.provider
    const chatId = this.store.get().lastChatId
    if (chatId === undefined) return
    const messageId = await this.lark.sendCard(chatId, buildModelPickCard(parsed.provider, models, parsed.flowId))
    if (this.modelFlow === undefined) return
    // Grey out the provider card — the flow moved on; a stale submit there
    // would otherwise be a silent no-op.
    if (this.modelFlow.providerCardMessageId !== undefined) {
      const providerCardId = this.modelFlow.providerCardMessageId
      void this.chain(() => this.lark.patchCard(providerCardId, buildModelProviderSettledCard(parsed.provider)))
      this.modelFlow.providerCardMessageId = undefined
    }
    if (messageId !== undefined) this.modelFlow.cardMessageId = messageId
  }

  /**
   * Shared model-selection apply core — /model submits AND the interactive
   * adapters (/think, /profile-switch) land here so the live-switch and
   * phone-default branches cannot drift apart. Live-switches bot-created
   * sessions through their selection ref (an absent effort CLEARS any
   * inherited one — installModelSelection's contract); otherwise remembers
   * the pick as the phone default (used by /new, honored on the next live
   * bind).
   */
  private async applyModelSelection(selection: ModelSelectionUpdate): Promise<'live' | 'phone-default'> {
    const bound = this.binder.getSessionId()
    const ref = bound === undefined ? undefined : this.selectionRefs.get(bound)
    if (ref !== undefined) {
      ref.current = {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selection.reasoningEffort as ModelSelection['reasoningEffort'] }),
      }
      return 'live'
    }
    await this.store.update({
      phoneModel: selection.reasoningEffort === undefined
        ? { provider: selection.provider, model: selection.model }
        : { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort },
    })
    return 'phone-default'
  }

  /**
   * Best-effort current model selection of the BOUND session — the data
   * source for the interactive /think adapter. Chain (mirrors the /model
   * and cold-resume routes): the bot-owned selection ref, the run view
   * (live route folds + the bind-time log backfill), the persisted log
   * itself, then the settings' default model. Undefined = nothing known.
   */
  private async currentModelSelection(): Promise<CurrentSelection | undefined> {
    const bound = this.binder.getSessionId() ?? this.store.get().boundSessionId
    if (bound !== undefined) {
      const refSelection = this.selectionRefs.get(bound)?.current
      if (refSelection?.provider !== undefined && refSelection.model !== undefined) {
        return {
          provider: refSelection.provider,
          model: refSelection.model,
          ...(refSelection.reasoningEffort === undefined ? {} : { reasoningEffort: refSelection.reasoningEffort }),
        }
      }
    }
    if (this.runState.provider !== undefined && this.runState.model !== undefined) {
      return {
        provider: this.runState.provider,
        model: this.runState.model,
        ...(this.runState.reasoningEffort === undefined ? {} : { reasoningEffort: this.runState.reasoningEffort }),
      }
    }
    if (bound !== undefined) {
      const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
      if (persistence !== undefined) {
        try {
          const { events } = await persistence.inspect(SessionId(bound))
          const backfill = backfillRouteFromLog(events)
          if (backfill.provider !== undefined && backfill.model !== undefined) {
            return {
              provider: backfill.provider,
              model: backfill.model,
              ...(backfill.reasoningEffort === undefined ? {} : { reasoningEffort: backfill.reasoningEffort }),
            }
          }
        } catch {
          // unreadable log — fall through to the default model
        }
      }
      const defaultModel = this.ctx.get('agentDefaultModel') as
        | { currentSelection?: () => ModelSelection | undefined }
        | undefined
      const fallback = defaultModel?.currentSelection?.()
      if (fallback?.provider !== undefined && fallback?.model !== undefined) {
        return { provider: fallback.provider, model: fallback.model }
      }
    }
    return undefined
  }

  /**
   * /model submit: live-switch bot-created sessions through their selection
   * ref; otherwise remember the pick as the phone default (used by /new)
   * and point desktop-driven sessions at the desktop switcher.
   */
  private async handleModelSubmitted(parsed: { flowId: string; model: string }): Promise<void> {
    const flow = this.modelFlow
    if (flow === undefined || flow.id !== parsed.flowId || flow.provider === undefined) return
    this.modelFlow = undefined
    const selection: ModelSelectionUpdate = { provider: flow.provider, model: parsed.model }
    const target = await this.applyModelSelection(selection)
    const bound = this.binder.getSessionId()
    const chatId = this.store.get().lastChatId
    if (chatId !== undefined) {
      const note = target === 'live'
        ? undefined
        : bound === undefined
          ? '已存为手机默认模型（/new 的新会话将使用它）。'
          : '已存为手机默认模型；当前会话由桌面驱动，请在电脑端 /model 切换。'
      const cardId = flow.cardMessageId
      if (cardId !== undefined) {
        void this.chain(() => this.lark.patchCard(cardId, buildModelSettledCard(selection.provider, selection.model, note)))
      } else {
        await this.reply(`✅ ${selection.provider} / ${selection.model}${note === undefined ? '' : '\n' + note}`)
      }
    }
  }

  // ---------------------------------------------------------- ask surface --

  /**
   * Register the phone as an ask-user surface. With dsh-ask-router present
   * this registers as one surface among several (first answer wins across
   * surfaces). Without it: a claim-scoped 'user-questions/request' cordis
   * waterfall answerer — answer by returning, delegate unclaimed asks via
   * next(). (alpha.3 removed the rc-era registerProvider slot along with its
   * DUPLICATE_PROVIDER yield protocol; the waterfall is the host's single
   * dispatch.)
   */
  private registerAskSurface(): void {
    const ask = (request: AskRequestLike): Promise<AskUserQuestionAnswer> => this.askViaCard(request)
    const router = this.ctx.get('askSurfaces') as AskSurfacesLike | undefined
    if (router !== undefined && typeof router.register === 'function') {
      const dispose = router.register({
        name: 'feishu',
        claim: request => this.claimsAskSession(request),
        ask,
        settled: (request, by) => this.dismissAsk(request, by),
      })
      this.cleanupFns.push(dispose)
      return
    }
    // Standalone path: answerers compose on the Agent-scoped
    // 'user-questions/request' cordis waterfall. The event is not part of the
    // dsh-user-questions type surface this plugin imports, hence the
    // structural cast.
    const registerWaterfall = (this.ctx.on as unknown as (
      event: 'user-questions/request',
      listener: (request: AskRequestLike, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>,
    ) => () => boolean)
    this.cleanupFns.push(registerWaterfall('user-questions/request', (request, next) => (
      this.claimsAskSession(request) ? ask(request) : next()
    )))
  }

  /** Whether the bound session is the one asking (claim routing). */
  private claimsAskSession(request: AskRequestLike): boolean {
    const bound = this.binder.getSessionId()
    if (bound === undefined) return false
    const asking = request.agent?.session?.id
    return asking === undefined ? true : String(asking) === bound
  }

  /**
   * Send the interactive ask card and resolve when the operator submits
   * (or reject when the owning turn aborts). The card stays submittable
   * until answered or aborted — no TTL: expiring would fail the agent's
   * tool call just because the phone sat in a pocket.
   */
  private askViaCard(request: AskRequestLike): Promise<AskUserQuestionAnswer> {
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const chatId = this.store.get().lastChatId
      if (chatId === undefined) {
        reject(new UserQuestionError('ask_user_question has no operator chat on the phone', 'NO_CHAT'))
        return
      }
      const questionId = randomUUID()
      const entry: PendingAsk = { questions: [...request.questions], messageId: undefined, resolve, reject }
      this.pendingAsks.set(questionId, entry)
      this.askRequestIds.set(request, questionId)
      request.signal?.addEventListener('abort', () => {
        if (!this.pendingAsks.delete(questionId)) return
        this.patchAskCard(entry, buildAskDismissedCard(entry.questions, 'cancelled', ''))
        entry.reject(new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
      }, { once: true })
      void this.chain(async () => {
        const messageId = await this.lark.sendCard(chatId, buildAskCard(entry.questions, questionId))
        if (!this.pendingAsks.has(questionId)) {
          // Aborted while the send was in flight — dismiss the stray card.
          if (messageId !== undefined) await this.lark.patchCard(messageId, buildAskDismissedCard(entry.questions, 'cancelled', ''))
          return
        }
        if (messageId === undefined) {
          this.pendingAsks.delete(questionId)
          entry.reject(new UserQuestionError('the ask card could not be delivered', 'CARD_SEND_FAILED'))
          return
        }
        entry.messageId = messageId
      })
    })
  }

  /** Router notification: another surface answered — settle and dismiss. */
  private dismissAsk(request: AskRequestLike, by: string): void {
    const questionId = this.askRequestIds.get(request)
    if (questionId === undefined) return
    const entry = this.pendingAsks.get(questionId)
    if (entry === undefined) return
    this.pendingAsks.delete(questionId)
    this.patchAskCard(entry, buildAskDismissedCard(entry.questions, 'elsewhere', by))
    entry.reject(new UserQuestionError(`answered on ${by} before the phone submitted`, 'ANSWERED_ELSEWHERE'))
  }

  /** Best-effort terminal patch of an ask card. */
  private patchAskCard(entry: PendingAsk, card: ReturnType<typeof buildAskCard>): void {
    if (entry.messageId === undefined) return
    void this.chain(() => this.lark.patchCard(entry.messageId!, card))
  }

  /**
   * card.action.trigger entry (ask-card submits, selector FW submits).
   * Unknown actions and foreign cards are ignored; only allowlisted
   * operators may answer.
   */
  onCardAction(data: unknown): void {
    // Resume / model callbacks gate on the operator allowlist too — same
    // contract as the ask and selector branches below: non-operators (and
    // payloads without an operator) are silent no-ops, never errors.
    const operator = cardOperatorOf(data)
    const resume = parseResumeAction(data)
    if (resume !== undefined) {
      if (!isOperator(operator, this.allowlist)) return
      void this.chain(() => this.handleResumeAction(resume))
      return
    }
    const modelProvider = parseModelProviderAction(data)
    if (modelProvider !== undefined) {
      if (!isOperator(operator, this.allowlist)) return
      void this.chain(() => this.handleModelProviderPicked(modelProvider))
      return
    }
    const modelSubmit = parseModelSubmitAction(data)
    if (modelSubmit !== undefined) {
      if (!isOperator(operator, this.allowlist)) return
      void this.chain(() => this.handleModelSubmitted(modelSubmit))
      return
    }
    const parsed = parseAskAction(data)
    if (parsed === undefined) {
      // Selector FW submits ride LAST in the parser chain — the marker is
      // mutually exclusive with every parser above (ask included), so this
      // branch is only reachable for payloads none of them claimed.
      const selector = parseSelectorAction(data)
      if (selector === undefined) return
      this.selectors.handleAction(selector, operator)
      return
    }
    const entry = this.pendingAsks.get(parsed.questionId)
    if (entry === undefined) return
    if (!isOperator(operator, this.allowlist)) return
    const result = parseAskFormValue(entry.questions, parsed.formValue)
    if (result.kind === 'missing') {
      void this.reply(`还有未回答的问题：${result.missing.join('、')}`)
      return
    }
    this.pendingAsks.delete(parsed.questionId)
    void this.chain(async () => {
      if (entry.messageId !== undefined) {
        await this.lark.patchCard(entry.messageId, buildAskAnsweredCard(entry.questions, result.answers))
      }
      entry.resolve({ answers: result.answers })
    })
  }

  // ---------------------------------------------------- selector framework --

  /**
   * Present a generic selection card in a chat and resolve with the
   * operator's outcome (picked / cancelled / expired). Submits arrive via
   * onCardAction → SelectorManager, and resetRunView cancels flows pending
   * on a rebind.
   *
   * INVARIANT: never call from inside a card-chain task (a chain(() => …)
   * callback) — sendCard enqueues a NEW task on that same chain, so awaiting
   * the outcome from within the chain dead-locks. Callers must run at the
   * top level (command dispatch) or on their own async context.
   */
  presentSelection(chatId: string, spec: SelectorSpec): Promise<SelectorOutcome> {
    return this.selectors.present(chatId, spec)
  }

  // -------------------------------------------------- interactive commands --

  /**
   * Run one interactive command adapter (selector-FW consumer). The adapters
   * own their degraded replies; this wrapper only contains an unexpected
   * throw (e.g. a rejected selection card) so the dispatch loop survives.
   */
  private async interactiveCommand(run: (host: InteractiveHost) => Promise<void>): Promise<void> {
    try {
      await run(this.host)
    } catch (error) {
      this.ctx.logger.warn('dsh-feishu: interactive command failed: %o', error)
      await this.reply('交互选择失败，请稍后再试。')
    }
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
      if (state.lastAssistantLine !== undefined) lines.push(`最后输出：${clipLine(state.lastAssistantLine, 80)}`)
    }
    lines.push(`🖥 think 尾行：${this.store.get().displayThink ? 'on' : 'off'}（/display think on|off）`)
    return lines.join('\n')
  }
}
