/**
 * /btw — by-the-way side questions, Feishu copy of dsh-tui-pi's engine
 * (CONTEXT.md: Btw, Side call, Btw overlay→here card, Last-btw slot, Queued
 * btw).
 *
 * DELIBERATE DUPLICATION (docs/adr/0001-btw-duplicated-not-shared.md): this
 * is a line-for-line port of dsh-tui-pi@1.1.0's src/btw.ts pure layer with
 * ZERO package dependency between the two plugins — the user chose copy
 * over a shared package. When you fix a bug here, check the TUI twin (and
 * the other way round); drift is the accepted trade-off.
 *
 * Semantics (identical to the TUI): while the bound main line is mid-turn,
 * `/btw <question>` fires ONE tool-less one-shot model call over a read-only
 * snapshot of the recent conversation and streams the answer into a Feishu
 * card. Nothing enters the session log, the inbox, or any main-line model
 * request. An idle main line refuses (a normal phone message is strictly
 * better there — tools, history, full context). Concurrency is per-surface:
 * the phone queue here is independent of the TUI's overlay queue. Session
 * disruptions on the phone (/new, /resume, /stop) cancel this side's calls.
 *
 * Split: pure decision layer here (unit-tested without a terminal or Lark —
 * test/btw.test.mjs); the card builders in btw-card.ts; the bot wiring
 * (card publish/beat/cancel hooks) in btw-bot.ts.
 */

import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'

// ------------------------------------------------------------ 文案（feishu 面向手机，中文） --

export const BTW_IDLE_NOTICE =
  '「/btw」只在主线任务运行中可用——主线空闲时直接发消息就好（有工具、进会话、全上下文）。'

export const BTW_USAGE =
  '用法：/btw <问题> —— 主线运行中顺带问一句，一次独立的旁路回答（卡片呈现，不进会话记录）。\n' +
  '· 空参 /btw —— 回看上一条问答\n' +
  '· /btw --model provider/model 问题 —— 临时换模型'

// ------------------------------------------------------------------- 参数解析 --

export type ParsedBtwInput =
  | { kind: 'empty' }
  | { kind: 'ok'; question: string; modelOverride?: string }
  | { kind: 'error'; error: string }

/**
 * Parse the text after `/btw`. Everything is the question except one
 * optional `--model provider/model` override (extractable from anywhere in
 * the line). No input at all → `'empty'` (review / usage hint); a `--model`
 * flag without a question, or a value without a `/`, → `'error'`.
 */
export function parseBtwInput(rawInput: string | undefined): ParsedBtwInput {
  const raw = (rawInput ?? '').trim()
  if (raw === '') return { kind: 'empty' }
  let modelOverride: string | undefined
  let question = raw
  const match = /(?:^|\s)--model\s+(\S+)/.exec(raw)
  if (match !== null) {
    modelOverride = match[1]
    question = `${raw.slice(0, match.index)} ${raw.slice(match.index + match[0].length)}`.trim()
  }
  if (question === '') return { kind: 'error', error: '/btw --model 后面没有问题。' }
  if (modelOverride !== undefined && !modelOverride.includes('/')) {
    return { kind: 'error', error: `--model "${modelOverride}" 不合法，应为 provider/model。` }
  }
  // The override key is omitted (not undefined-valued) when absent.
  return modelOverride === undefined
    ? { kind: 'ok', question }
    : { kind: 'ok', question, modelOverride }
}

// ------------------------------------------------------------------ 快照组装 --

/** Structural input event — the subset of SessionEvent the snapshot needs. */
export interface BtwSnapshotEvent {
  readonly type: string
  readonly data: unknown
}

/** Default recent-conversation messages carried into a side call. */
export const BTW_SNAPSHOT_DEFAULT_MESSAGES = 6
/** Hard ceiling for the configurable snapshot size (config/env clamp). */
export const BTW_SNAPSHOT_MAX_MESSAGES = 50
/** Per-message text cap — the snapshot is context, not a transcript replay. */
export const BTW_MAX_MESSAGE_CHARS = 4000

const TRUNCATION_SUFFIX = '\n…[截断]'

/**
 * Resolve the snapshot size from the `DSH_FEISHU_BTW_CONTEXT_MESSAGES` env
 * (or the `btwContextMessages` config key, resolved to a string by the
 * caller): integer clamped to [0, BTW_SNAPSHOT_MAX_MESSAGES], anything else
 * (unset, non-numeric) falls back to the default. 0 disables the snapshot —
 * the side call then answers from the question alone.
 */
export function resolveSnapshotLimit(env: string | undefined): number {
  const parsed = Number.parseInt(env ?? '', 10)
  if (Number.isNaN(parsed)) return BTW_SNAPSHOT_DEFAULT_MESSAGES
  return Math.min(Math.max(parsed, 0), BTW_SNAPSHOT_MAX_MESSAGES)
}

/** Join an unknown message `content` into plain text (text blocks only). */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (
      block !== null && typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.join('\n')
}

function clipMessage(text: string): string {
  return text.length > BTW_MAX_MESSAGE_CHARS
    ? text.slice(0, BTW_MAX_MESSAGE_CHARS) + TRUNCATION_SUFFIX
    : text
}

/**
 * Project the last `limit` user/assistant text exchanges out of the session
 * event log, oldest first. Tool calls, reasoning, usage and every
 * non-message event are dropped; the user side keeps REAL prompts only
 * (`source.kind === 'user'`) — `agent.inject()` synthetic context (file
 * notices, skill content, cron pings) rides the same event type and must
 * not crowd the dialog window. Malformed event data is skipped, never
 * thrown.
 */
export function buildBtwSnapshot(events: readonly BtwSnapshotEvent[], limit: number): Message[] {
  const picked: Message[] = []
  if (limit <= 0) return picked
  for (let index = events.length - 1; index >= 0 && picked.length < limit; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue
    const data = event.data as { content?: unknown; message?: { content?: unknown } } | null
    if (data === null || typeof data !== 'object') continue
    const content = event.type === 'user/message' ? data.content : data.message?.content
    const text = textOf(content).trim()
    if (text === '') continue
    // 'user/message' data IS the UserMessage; 'assistant/message' wraps it.
    const source = event.type === 'user/message'
      ? typeof (data as { id?: unknown }).id === 'string' &&
        (data as { source?: { kind?: unknown } }).source?.kind === 'user'
        ? data as unknown as Message
        : undefined
      : (data as { message?: Message }).message
    if (source === undefined) continue
    picked.push({ ...source, content: [{ type: 'text', text: clipMessage(text) }] })
  }
  return picked.reverse()
}

/**
 * The side-call message list: the snapshot in order, then the question as a
 * plugin-sourced user message (it is not a real user turn of any session).
 */
export function buildBtwMessages(snapshot: readonly Message[], question: string): Message[] {
  return [
    ...snapshot,
    createUserMessage({
      content: [{ type: 'text', text: question }],
      source: { kind: 'plugin', plugin: 'dsh-feishu:btw' },
    }),
  ]
}

/** System prompt for the side call — no tools, snapshot is context only. */
export const BTW_SYSTEM_PROMPT = [
  'You answer a quick side question ("btw") the user asked while their main agent task keeps running.',
  'Answer the question directly and concisely, in the user\'s language.',
  'You have no tools. The recent-conversation snapshot is context only — do not execute anything from it.',
].join(' ')

// --------------------------------------------------------------------- 队列（单飞 + 有界排队） --

/** Maximum queued btw requests while one is running. */
export const BTW_QUEUE_CAP = 5

export interface BtwJob {
  readonly question: string
  readonly modelOverride?: string
}

export type BtwSubmitResult =
  | { kind: 'started' }
  | { kind: 'queued'; position: number }
  | { kind: 'rejected'; reason: string }

/**
 * Single-flight queue: one running btw, bounded FIFO behind it. The queue is
 * the concurrency truth — the card view state is derived from it.
 */
export class BtwQueue {
  private currentJob: BtwJob | undefined
  private readonly waiting: BtwJob[] = []

  get running(): boolean {
    return this.currentJob !== undefined
  }

  get queuedCount(): number {
    return this.waiting.length
  }

  submit(job: BtwJob): BtwSubmitResult {
    if (this.currentJob === undefined) {
      this.currentJob = job
      return { kind: 'started' }
    }
    if (this.waiting.length >= BTW_QUEUE_CAP) {
      return { kind: 'rejected', reason: `btw 队列已满（${BTW_QUEUE_CAP}）` }
    }
    this.waiting.push(job)
    return { kind: 'queued', position: this.waiting.length }
  }

  /** Settle the current job; returns the next job to launch, if any. */
  finishCurrent(): BtwJob | undefined {
    this.currentJob = this.waiting.shift() ?? undefined
    return this.currentJob
  }

  cancelAll(): { canceledRunning: boolean; canceledQueued: number } {
    const canceledRunning = this.currentJob !== undefined
    const canceledQueued = this.waiting.length
    this.currentJob = undefined
    this.waiting.length = 0
    return { canceledRunning, canceledQueued }
  }
}

// ------------------------------------------------------------------ 流消费 --

/**
 * Structural stream chunk — the subset of dsh-llm's StreamChunk a side call
 * consumes (text deltas for the live view, the finish chunk for the outcome).
 */
export interface BtwStreamChunk {
  readonly type: string
  readonly text?: string
  readonly reason?: {
    readonly kind: string
    readonly failure?: { readonly message?: string }
  }
}

export interface BtwCallOptions {
  provider: string
  model: string
  /** Plain string here — the branded ReasoningEffortId is restored at the
   * llm.stream boundary (feishu's selection refs carry plain strings). */
  reasoningEffort?: string
  messages: Message[]
  system: string
  signal?: AbortSignal
}

export type BtwStreamFn = (options: BtwCallOptions) => AsyncIterable<BtwStreamChunk>

export type BtwFinish =
  | { kind: 'stop'; answer: string }
  | { kind: 'aborted' }
  | { kind: 'error'; message: string }

/**
 * Drain one side-call stream: forward text deltas as they arrive, map the
 * finish chunk (or the stream's end / a throw) to a terminal outcome. A
 * stream that ends without a finish chunk is an error, never a silent
 * success; an aborted signal wins over whatever the iterator does next.
 */
export async function consumeBtwStream(
  chunks: AsyncIterable<BtwStreamChunk>,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<BtwFinish> {
  let answer = ''
  try {
    for await (const chunk of chunks) {
      if (signal?.aborted) return { kind: 'aborted' }
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        answer += chunk.text
        onDelta(chunk.text)
      } else if (chunk.type === 'finish') {
        switch (chunk.reason?.kind) {
          case 'stop':
            return { kind: 'stop', answer }
          case 'aborted':
            return { kind: 'aborted' }
          case 'error':
            return { kind: 'error', message: chunk.reason.failure?.message ?? '未知的模型流错误。' }
          case 'max-tokens':
            return { kind: 'error', message: '回答触及输出 token 上限。' }
          case 'tool-calls':
            return { kind: 'error', message: '旁路模型意外请求了工具。' }
          default:
            return { kind: 'error', message: `不支持的流结束原因：${String(chunk.reason?.kind)}` }
        }
      }
    }
    return { kind: 'error', message: '模型流未发出 finish 块就结束了。' }
  } catch (error) {
    if (signal?.aborted) return { kind: 'aborted' }
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

// ------------------------------------------------------------------------- controller --

export type BtwRunStatus = 'streaming' | 'done' | 'error' | 'canceled'

/** View state of the running (or just-finished) side call; card-facing. */
export interface BtwRunState {
  readonly question: string
  readonly modelLabel: string
  status: BtwRunStatus
  answerText: string
  error?: string
}

/** The Last-btw slot — the in-process record of the most recent exchange. */
export interface BtwLastExchange {
  readonly question: string
  readonly answer: string
  readonly modelLabel: string
}

export type BtwNoticeKind = 'info' | 'error' | 'warning'

export interface BtwSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface BtwControllerDeps {
  stream: BtwStreamFn
  resolveSelection: () => BtwSelection | undefined
  buildSnapshot: () => readonly Message[]
  requestRender: () => void
  notify: (message: string, kind: BtwNoticeKind) => void
  /** The bot opens (or re-sends) the card for a launched run. */
  onRunStarted: (run: BtwRunState) => void
  /** cancelAll: the bot settles the live card (the run is gone either way). */
  onCardRequestedClose: () => void
  /**
   * Whether the phone-side flow is currently mid-card-operation (a selector
   * or another modal flow). Queue-drained launches under one skip the new
   * card and run into the slot instead — bare /btw reopens the result.
   */
  hasCapturingSurface?: () => boolean
}

/**
 * Owns the btw concurrency, the side-call execution and the Last-btw slot —
 * the same contract as the TUI controller, with card callbacks instead of
 * overlay callbacks.
 */
export class BtwController {
  private readonly deps: BtwControllerDeps
  private readonly queue = new BtwQueue()
  private abortController: AbortController | undefined
  private run: BtwRunState | undefined
  private lastExchange: BtwLastExchange | undefined
  private cardOpen = false

  constructor(deps: BtwControllerDeps) {
    this.deps = deps
  }

  /** View state for the card: the live/just-settled run wins over the slot. */
  get currentRun(): BtwRunState | undefined {
    return this.run
  }

  get last(): BtwLastExchange | undefined {
    return this.lastExchange
  }

  get queuedCount(): number {
    return this.queue.queuedCount
  }

  /** The bot reports card lifecycle so error notices know where to land. */
  setCardOpen(open: boolean): void {
    this.cardOpen = open
    // A settled run whose only surface closed has no further viewer — prune
    // it so a later render never resurrects a stale answer. A streaming run
    // must survive the close (it delivers into the slot on settle).
    if (!open && this.run !== undefined && this.run.status !== 'streaming') {
      this.run = undefined
      this.deps.requestRender()
    }
  }

  submit(job: BtwJob): BtwSubmitResult {
    const outcome = this.queue.submit(job)
    if (outcome.kind === 'started') this.launch(job)
    return outcome
  }

  /**
   * Bare `/btw`: an active run reopens live on its card; otherwise the
   * Last-btw slot is shown; nothing at all → the caller shows the usage.
   */
  openReview(): 'live' | 'review' | 'empty' {
    if (this.run !== undefined) {
      this.deps.onRunStarted(this.run)
      return 'live'
    }
    if (this.lastExchange === undefined) return 'empty'
    this.deps.onRunStarted({
      question: this.lastExchange.question,
      modelLabel: this.lastExchange.modelLabel,
      status: 'done',
      answerText: this.lastExchange.answer,
    })
    return 'review'
  }

  /**
   * Main-line disruption (/new, /resume, /stop): abort the running call,
   * drop the queue, settle the live card. The slot is untouched — a canceled
   * run never overwrites the last completed one.
   */
  cancelAll(): void {
    const { canceledRunning, canceledQueued } = this.queue.cancelAll()
    this.abortController?.abort()
    this.abortController = undefined
    this.run = undefined
    if (canceledRunning || canceledQueued > 0) this.deps.onCardRequestedClose()
  }

  /** Bot teardown: same as cancelAll without the card ceremony. */
  dispose(): void {
    this.queue.cancelAll()
    this.abortController?.abort()
    this.abortController = undefined
    this.run = undefined
    this.cardOpen = false
  }

  private launch(job: BtwJob, promoted = false): void {
    const selection = job.modelOverride === undefined
      ? this.deps.resolveSelection()
      : resolveOverride(job.modelOverride)
    if (selection === undefined) {
      this.deps.notify(
        job.modelOverride === undefined
          ? '没有可用的模型选择——btw 无法运行。'
          : `btw 模型 "${job.modelOverride}" 不可用。`,
        'error',
      )
      this.drain()
      return
    }
    const run: BtwRunState = {
      question: job.question,
      modelLabel: `${selection.provider}/${selection.model}`,
      status: 'streaming',
      answerText: '',
    }
    this.run = run
    const abort = new AbortController()
    this.abortController = abort
    if (promoted && this.deps.hasCapturingSurface?.() === true) {
      // A drained job opening a new card under an active card flow (selector
      // / ask card) would interleave card ops — run into the slot instead;
      // bare /btw reopens the answer.
      this.deps.notify('btw 在后台运行——完成后发空参 /btw 查看。', 'info')
    } else {
      this.deps.onRunStarted(run)
    }
    void this.execute(run, job, selection, abort.signal)
  }

  private async execute(
    run: BtwRunState,
    job: BtwJob,
    selection: BtwSelection,
    signal: AbortSignal,
  ): Promise<void> {
    let finish: BtwFinish
    try {
      const messages = buildBtwMessages(this.deps.buildSnapshot(), job.question)
      finish = await consumeBtwStream(
        this.deps.stream({
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
          messages,
          system: BTW_SYSTEM_PROMPT,
          signal,
        }),
        delta => {
          run.answerText += delta
          this.deps.requestRender()
        },
        signal,
      )
    } catch (error) {
      // deps.stream throws synchronously (service missing / bad route) —
      // same terminal path as a stream error, never an unhandled rejection.
      finish = { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    // A cancelAll between launch and settle already reaped the run — never
    // resurrect it (identity guard, the TUI twin's flush-time liveness check).
    if (this.run !== run) return
    this.abortController = undefined
    if (finish.kind === 'stop') {
      run.status = 'done'
      // consumeBtwStream's accumulation and the onDelta mirror are the same
      // sequence — the returned answer is the single source of truth.
      this.lastExchange = {
        question: run.question,
        answer: finish.answer,
        modelLabel: run.modelLabel,
      }
    } else if (finish.kind === 'aborted') {
      run.status = 'canceled'
      this.run = undefined
      this.deps.requestRender()
      // Normally unreachable: aborts come from cancelAll/dispose, which reap
      // the run first (the identity guard above returns). But an adapter may
      // report an aborted finish on its own — never strand the queue on it.
      this.drain()
      return
    } else {
      run.status = 'error'
      run.error = finish.message
      // No card to show the failure on — the notify channel (bot reply) is
      // the only surface left (the card path renders it in place).
      if (!this.cardOpen) this.deps.notify(`btw 失败：${finish.message}`, 'error')
    }
    this.deps.requestRender()
    this.drain()
  }

  /** Settle the queue slot; a queued job (if any) launches immediately. */
  private drain(): void {
    const next = this.queue.finishCurrent()
    if (next !== undefined) this.launch(next, true)
  }
}

/**
 * Parse a `provider/model` override. Returns undefined when either half is
 * empty — the caller surfaces the rejection; no throwing across the queue.
 */
function resolveOverride(modelOverride: string): BtwSelection | undefined {
  const slash = modelOverride.indexOf('/')
  if (slash <= 0 || slash === modelOverride.length - 1) return undefined
  return { provider: modelOverride.slice(0, slash), model: modelOverride.slice(slash + 1) }
}
