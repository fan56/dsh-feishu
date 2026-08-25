/**
 * Run-state fold: the pure event→state machine behind the Feishu status
 * card. Mirrors dsh-tui-pi's activity phase machine in spirit (fixed live
 * panels, O(1) per event) but renders nothing — the card builder projects
 * this state, the publisher pushes it on a 30s beat.
 *
 * Two entry points:
 * - {@link foldBoundEvent}: events of the BOUND session (turns, tools, todo,
 *   reasoning, retries, workflow agent-start/end markers).
 * - {@link foldChildEvent}: events of a discovered subagent child session
 *   (header-discovered by the bot; keeps per-child rounds + content tail).
 *
 * All payload reads go through `unknown` shapes and never throw — a malformed
 * event degrades to a no-op, never a crashed bridge.
 */

import type { SessionEvent } from './dsh-events.ts'
import { lastNonBlankLine, textOfContent } from './text.ts'

/** Cap on remembered settled-tool rows (the card shows the last few). */
export const TOOL_HISTORY_CAP = 8

/** Cap on the raw reasoning buffer (tail extraction only). */
const REASONING_CAP = 8192

/** Cap on the in-flight text buffer (streaming tail display only). */
const TEXT_CAP = 8192

/** One settled tool for the status line (`✔ bash 1.2s`). */
export interface ToolSettledRow {
  readonly name: string
  readonly ok: boolean
  readonly durationMs: number
}

/** One tracked subagent child (compact row on the status card). */
export interface SubagentRow {
  readonly childId: string
  /** Display label (`workhorse`, `subagent ab12cd34`, …). */
  label: string
  /** Assistant-message count — the child's LLM round-trips. */
  rounds: number
  /** Last visible output line (own content only, never a tool name). */
  tail: string | undefined
  /** Last invoked tool name, when any. */
  lastTool: string | undefined
  /** Settled marker; undefined while the child works. */
  outcome: 'completed' | 'failed' | 'cancelled' | undefined
}

/** Whole mutable run state of the bound session. */
export interface RunState {
  /** A turn is in flight on the bound session. */
  running: boolean
  turnStartedAt: number | undefined
  turnEndedAt: number | undefined
  turnEndReason: string | undefined
  /** assistant/message count within the current turn (the "rounds"). */
  rounds: number
  /** Epoch ms when the CURRENT round started (turn start or the previous round's message). */
  roundStartedAt: number | undefined
  /** Duration of the round that just settled — the settled card's header reads it. */
  lastRoundDurationMs: number | undefined
  /** Text blocks of the round that just settled — its verbatim body card. */
  lastRoundText: string
  /** Epoch ms of the latest reasoning delta (the thinking phase marker). */
  thinkingSince: number | undefined
  /** Raw reasoning buffer (capped) — tail source when think display is on. */
  reasoningBuffer: string
  /** In-flight text deltas of the round's growing message (capped) — streaming tail. */
  textBuffer: string
  /** Pending tool (between tool/call and tool/result). */
  currentTool: { name: string; startedAt: number } | undefined
  toolsDone: number
  toolsFailed: number
  toolHistory: ToolSettledRow[]
  /** Latest todo/write snapshot; cleared on turn/start (TUI semantics). */
  todo: readonly { content: string; status: string }[] | undefined
  /** Tracked subagent children keyed by child session id. */
  subagents: Map<string, SubagentRow>
  /** `${runId}:${seq}` → childId pairing for tool-workflow/agent-end. */
  runSeqToChild: Map<string, string>
  /** Latest llm/retry counters of the current turn. */
  retries: number
  maxRetries: number | undefined
  /** Last visible line of the latest assistant message (status snapshot). */
  lastAssistantLine: string | undefined
  /** Provider route of the latest `request/header` (undefined until seen). */
  provider: string | undefined
  /** Model id of the latest `request/header` (undefined until seen). */
  model: string | undefined
  /** Reasoning effort of the latest `request/header` (undefined = unknown/off). */
  reasoningEffort: string | undefined
  /** Context window in tokens from the latest `request/context`, when advertised. */
  contextWindow: number | undefined
  /** Billed context tokens (input+cache+output) of the latest usage snapshot. */
  lastUsageTokens: number | undefined
  /**
   * Characters streamed (text/reasoning deltas) since the latest usage
   * snapshot — a rough growth estimate, not a billed number.
   */
  pendingChars: number
  /**
   * Cache-hit accounting, SESSION-cumulative (operator's chosen scope):
   * hit rate = ΣcacheRead / (Σinput + ΣcacheRead + ΣcacheWrite) — output
   * tokens never enter the denominator (cache hit is an input-side metric);
   * cacheWrite counts as this request's miss (the premise of future hits).
   * Route changes do NOT reset the totals — the rate describes the whole
   * session's input traffic.
   */
  cacheInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Session hit rate in percent (Σread / ΣbilledInput), undefined before any usage. */
  cacheHitRate: number | undefined
}

/** Fresh state (no turn observed). */
export function initialRunState(): RunState {
  return {
    running: false,
    turnStartedAt: undefined,
    turnEndedAt: undefined,
    turnEndReason: undefined,
    rounds: 0,
    roundStartedAt: undefined,
    lastRoundDurationMs: undefined,
    lastRoundText: '',
    thinkingSince: undefined,
    reasoningBuffer: '',
    textBuffer: '',
    currentTool: undefined,
    toolsDone: 0,
    toolsFailed: 0,
    toolHistory: [],
    todo: undefined,
    subagents: new Map(),
    runSeqToChild: new Map(),
    retries: 0,
    maxRetries: undefined,
    lastAssistantLine: undefined,
    provider: undefined,
    model: undefined,
    reasoningEffort: undefined,
    contextWindow: undefined,
    lastUsageTokens: undefined,
    pendingChars: 0,
    cacheInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRate: undefined,
  }
}

/**
 * Per-turn reset. The route/window fields (provider, model, reasoningEffort,
 * contextWindow) are turn-INDEPENDENT — they describe the session's current
 * request route and survive across turns; only per-turn counters clear.
 */
function beginTurn(state: RunState, time: number): void {
  state.running = true
  state.turnStartedAt = time
  state.turnEndedAt = undefined
  state.turnEndReason = undefined
  state.rounds = 0
  state.roundStartedAt = time
  state.lastRoundDurationMs = undefined
  state.lastRoundText = ''
  state.thinkingSince = undefined
  state.reasoningBuffer = ''
  state.textBuffer = ''
  state.currentTool = undefined
  state.toolsDone = 0
  state.toolsFailed = 0
  state.toolHistory = []
  state.todo = undefined
  state.subagents.clear()
  state.runSeqToChild.clear()
  state.retries = 0
  state.maxRetries = undefined
  state.lastAssistantLine = undefined
  // The billed-context baseline SURVIVES turn boundaries — context only
  // grows between turns, and the backfilled baseline of a mid-run bind must
  // not be wiped by the next turn/start (TUI semantics: occupancy is
  // session-level, never turn-level).
  state.pendingChars = 0
}

function endTurn(state: RunState, time: number, reason: string): void {
  state.running = false
  state.turnEndedAt = time
  state.turnEndReason = reason
  state.thinkingSince = undefined
  state.currentTool = undefined
}

/**
 * Per-round reset (the bot calls it right after a round's card settled):
 * the next round's card starts with a fresh activity story — this round's
 * tools, reasoning tail and message line belong to the settled card only.
 * Turn-level state (todo, subagents, cache accounting, rounds) survives.
 */
export function beginRound(state: RunState): void {
  state.currentTool = undefined
  state.thinkingSince = undefined
  state.reasoningBuffer = ''
  state.textBuffer = ''
  state.toolHistory = []
  state.lastAssistantLine = undefined
  state.lastRoundText = ''
  state.lastRoundDurationMs = undefined
}

/** Null-safe record read: any non-object (null included) reads as empty. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rec<T = any>(data: unknown): T {
  return (data !== null && typeof data === 'object' ? data : {}) as T
}

/** Read `{chunk:{type,text}}` off a chunk event's data; undefined for other shapes. */
function chunkOf(data: unknown): { type?: string; text?: string } | undefined {
  return rec<{ chunk?: { type?: string; text?: string } }>(data).chunk
}

/** Whether one tool/result reports failure (event-error or isError block). */
export function toolResultFailed(data: unknown): boolean {
  if (rec<{ error?: unknown }>(data).error !== undefined) return true
  const block = rec<{ message?: { content?: unknown[] } }>(data).message?.content?.[0]
  return rec<{ isError?: boolean }>(block).isError === true
}

/** Extract the text blocks of an assistant/message event into one string. */
function assistantTextOf(data: unknown): string {
  const content = rec(data).message?.content
  return textOfContent(content)
}

/** Normalized usage components of an assistant/message snapshot. */
interface UsageComponents {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/**
 * Billed usage of an assistant/message usage snapshot, or undefined when the
 * event carries no usage (adapter reported none). Cache components default to
 * zero — gateways that do not report caching (e.g. zhipu GLM) simply never
 * grow them, and the CH footer field stays absent.
 */
function usageComponentsOf(data: unknown): UsageComponents | undefined {
  const usage = rec<{ usage?: { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown } }>(data).usage
  if (usage === undefined) return undefined
  const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined
  const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined
  if (input === undefined || output === undefined) return undefined
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0,
    cacheWriteTokens: typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0,
  }
}

/** Route scalars off a `request/header` event (`data.header.config`). */
function headerConfigOf(data: unknown): { provider?: string; model?: string; reasoningEffort?: string } | undefined {
  const config = rec<{ header?: { config?: Record<string, unknown> } }>(data).header?.config
  if (config === undefined) return undefined
  const out: { provider?: string; model?: string; reasoningEffort?: string } = {}
  if (typeof config.provider === 'string') out.provider = config.provider
  if (typeof config.model === 'string') out.model = config.model
  if (typeof config.reasoningEffort === 'string') out.reasoningEffort = config.reasoningEffort
  return out
}

/**
 * Fold one event of the BOUND session into the state. Mutates `state` in
 * place for O(1) cost; returns it for chaining.
 */
export function foldBoundEvent(state: RunState, event: SessionEvent): RunState {
  switch (event.type) {
    case 'turn/start':
      beginTurn(state, event.time)
      break
    case 'turn/end': {
      const reason = rec(event.data).reason?.kind
      endTurn(state, event.time, reason ?? 'unknown')
      break
    }
    case 'assistant/message': {
      const text = assistantTextOf(event.data)
      if (text !== '') state.lastAssistantLine = lastNonBlankLine(text)
      // One message = one settled round: capture its duration and verbatim
      // text for the settled card + body, then the next round starts now.
      state.lastRoundText = text
      state.textBuffer = '' // the streamed text just landed in full
      state.lastRoundDurationMs = state.roundStartedAt === undefined
        ? 0
        : Math.max(0, event.time - state.roundStartedAt)
      state.roundStartedAt = event.time
      state.rounds += 1
      // A landed message proves the request round-tripped — clear retry and
      // thinking markers (dsh emits no retry-cleared event).
      state.retries = 0
      state.maxRetries = undefined
      state.thinkingSince = undefined
      // Usage snapshot finalizes the billed context; the streamed estimate
      // restarts from what follows this message. The same components feed the
      // route-segment cache-hit accounting (output stays out of it).
      const usage = usageComponentsOf(event.data)
      if (usage !== undefined) {
        state.lastUsageTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
        state.cacheInputTokens += usage.inputTokens
        state.cacheReadTokens += usage.cacheReadTokens
        state.cacheWriteTokens += usage.cacheWriteTokens
        const billedInput = state.cacheInputTokens + state.cacheReadTokens + state.cacheWriteTokens
        state.cacheHitRate = billedInput > 0 ? (state.cacheReadTokens / billedInput) * 100 : undefined
      }
      state.pendingChars = 0
      break
    }
    case 'assistant/chunk': {
      const chunk = chunkOf(event.data)
      if (chunk?.type === 'reasoning-delta' && (chunk.text ?? '') !== '') {
        state.thinkingSince ??= event.time
        let buffer = state.reasoningBuffer + (chunk.text ?? '')
        if (buffer.length > REASONING_CAP) buffer = buffer.slice(-Math.floor(REASONING_CAP / 2))
        state.reasoningBuffer = buffer
      }
      // Text deltas also grow the in-flight message buffer — the streaming
      // tail the activity list shows between beats (capped like reasoning).
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        let buffer = state.textBuffer + chunk.text
        if (buffer.length > TEXT_CAP) buffer = buffer.slice(-Math.floor(TEXT_CAP / 2))
        state.textBuffer = buffer
      }
      // Both text and reasoning deltas grow the next request's context —
      // price them into the live estimate (~3 chars/token, CJK-lean).
      if (
        (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta')
        && typeof chunk.text === 'string' && chunk.text !== ''
      ) {
        state.pendingChars += chunk.text.length
      }
      break
    }
    case 'request/header': {
      const config = headerConfigOf(event.data)
      if (config === undefined) break
      if (config.provider !== undefined) state.provider = config.provider
      if (config.model !== undefined) state.model = config.model
      // undefined means the field is ABSENT from the header — keep the last
      // known value; an explicit off is not representable here.
      if (config.reasoningEffort !== undefined) state.reasoningEffort = config.reasoningEffort
      // No cache-accumulator reset on a route change: the CH rate is
      // session-cumulative by design (Σread / Σbilled-input over the whole
      // session's input traffic, whatever routes carried it).
      break
    }
    case 'request/context': {
      const window = rec<{ contextWindow?: unknown }>(event.data).contextWindow
      if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
        state.contextWindow = window
      }
      break
    }
    case 'tool/call': {
      const name = rec(event.data).name
      if (name !== undefined && name !== '') {
        state.currentTool = { name, startedAt: event.time }
        state.thinkingSince = undefined
      }
      break
    }
    case 'tool/result': {
      const pending = state.currentTool
      if (pending !== undefined) {
        const ok = !toolResultFailed(event.data)
        const row: ToolSettledRow = { name: pending.name, ok, durationMs: Math.max(0, event.time - pending.startedAt) }
        if (ok) state.toolsDone += 1
        else state.toolsFailed += 1
        state.toolHistory.push(row)
        if (state.toolHistory.length > TOOL_HISTORY_CAP) state.toolHistory.shift()
        state.currentTool = undefined
      }
      break
    }
    case 'todo/write': {
      const todos = rec(event.data).todos
      if (Array.isArray(todos)) {
        state.todo = todos.map(item => ({
          content: String((item as { content?: unknown }).content ?? ''),
          status: String((item as { status?: unknown }).status ?? 'pending'),
        }))
      }
      break
    }
    case 'llm/retry': {
      const retry = rec(event.data).retry
      if (typeof retry === 'number') state.retries = retry
      const maxRetries = rec(event.data).maxRetries
      state.maxRetries = typeof maxRetries === 'number' ? maxRetries : undefined
      break
    }
    case 'tool-workflow/agent-start': {
      const data = rec(event.data)
      const childId = data.childId
      // Only a real string label is kept; anything else falls back to the
      // hash-derived placeholder (a numeric label must not leak in).
      const label = typeof data.label === 'string' && data.label !== '' ? data.label : undefined
      if (childId !== undefined && !state.subagents.has(childId)) {
        state.subagents.set(childId, {
          childId,
          label: label ?? `subagent ${childId.slice(0, 8)}`,
          rounds: 0,
          tail: undefined,
          lastTool: undefined,
          outcome: undefined,
        })
      }
      if (childId !== undefined) {
        const runId = rec(event.data).runId
        const seq = rec(event.data).seq
        if (typeof runId === 'string' && typeof seq === 'number') {
          state.runSeqToChild.set(`${runId}:${seq}`, childId)
        }
        // The spawn label is authoritative — it must also reach a row that a
        // child event already created lazily (cross-session delivery order is
        // not guaranteed, so the child's first events can beat the parent's
        // agent-start append).
        if (label !== undefined) {
          const row = state.subagents.get(childId)
          if (row !== undefined) row.label = label
        }
      }
      break
    }
    case 'tool-workflow/agent-end': {
      const outcome = rec(event.data).outcome
      if (outcome === undefined) break
      // Pair by runId:seq — never settle other running children (the TUI's
      // runSeqToChild pairing, one map instead of a global sweep).
      const runId = rec(event.data).runId
      const seq = rec(event.data).seq
      const childId = typeof runId === 'string' && typeof seq === 'number'
        ? state.runSeqToChild.get(`${runId}:${seq}`)
        : undefined
      const row = childId === undefined ? undefined : state.subagents.get(childId)
      if (row !== undefined && row.outcome === undefined) row.outcome = outcome
      break
    }
    default:
      break
  }
  return state
}

/**
 * Fold one event of a CHILD (subagent) session into its compact row. The row
 * is created lazily when absent — child discovery may race its first event.
 */
export function foldChildEvent(
  state: RunState,
  childId: string,
  event: SessionEvent,
  label?: string,
): RunState {
  let row = state.subagents.get(childId)
  if (row === undefined) {
    row = {
      childId,
      label: label ?? `subagent ${childId.slice(0, 8)}`,
      rounds: 0,
      tail: undefined,
      lastTool: undefined,
      outcome: undefined,
    }
    state.subagents.set(childId, row)
  }
  if (label !== undefined && row.label !== label) row.label = label
  switch (event.type) {
    case 'subagent/descriptor': {
      // The child's own log refines the durable identity (the workflow
      // agent-start label is a fallback): last non-empty label wins.
      const descriptor = rec<{ label?: unknown }>(event.data)
      if (typeof descriptor.label === 'string' && descriptor.label !== '') row.label = descriptor.label
      break
    }
    case 'assistant/message': {
      row.rounds += 1
      const text = assistantTextOf(event.data)
      if (text !== '') row.tail = lastNonBlankLine(text)
      break
    }
    case 'assistant/chunk': {
      const delta = chunkOf(event.data)
      if ((delta?.type === 'text-delta' || delta?.type === 'reasoning-delta') && (delta.text ?? '') !== '') {
        const line = lastNonBlankLine(delta.text ?? '')
        if (line !== undefined) row.tail = line
      }
      break
    }
    case 'tool/call': {
      const name = rec(event.data).name
      if (name !== undefined && name !== '') row.lastTool = name
      break
    }
    case 'turn/end': {
      if (row.outcome === undefined) row.outcome = 'completed'
      break
    }
    default:
      break
  }
  return state
}

/** Subagent rows in stable order (insertion order), running ones first. */
export function subagentRows(state: RunState): SubagentRow[] {
  return [...state.subagents.values()].sort((a, b) => {
    const aLive = a.outcome === undefined ? 0 : 1
    const bLive = b.outcome === undefined ? 0 : 1
    return aLive - bLive
  })
}

/** Reasoning tail — last visible line of the capped reasoning buffer. */
export function reasoningTail(state: RunState): string | undefined {
  return state.reasoningBuffer === '' ? undefined : lastNonBlankLine(state.reasoningBuffer)
}

/** Streaming text tail — last visible line of the round's in-flight message. */
export function streamingTextTail(state: RunState): string | undefined {
  return state.textBuffer === '' ? undefined : lastNonBlankLine(state.textBuffer)
}

/**
 * Live context-occupancy estimate in tokens: the latest billed usage
 * (input+cache+output) plus a rough ~3-chars-per-token estimate of what
 * streamed after it. Undefined before the first usage snapshot with no
 * streamed estimate either — footer omits the field then.
 */
export function contextTokensEstimate(state: RunState): number | undefined {
  const pending = Math.ceil(state.pendingChars / 3)
  if (state.lastUsageTokens === undefined) return pending > 0 ? pending : undefined
  return state.lastUsageTokens + pending
}

/** Default fallback label pattern (`subagent <id8>`) — not a real name. */
const FALLBACK_LABEL_RE = /^subagent [0-9a-f]{8}$/

// ---------------------------------------------------- route-log backfill --

/**
 * Route facts derivable from the BOUND session's own append-only log. The
 * route events (`request/header`, `request/context`) are appended only on
 * session start or on a route CHANGE — a bot that binds mid-run never sees
 * them on the live firehose, so model / think level / context window (and
 * the cache-hit baseline) must be recovered from the log. Same pattern as
 * the child-name backfill and dsh-tui-pi's round reconcile.
 */
export interface RouteBackfill {
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly reasoningEffort: string | undefined
  readonly contextWindow: number | undefined
  /** Billed context tokens of the LAST usage snapshot in the log (occupancy baseline). */
  readonly lastUsageTokens: number | undefined
  /** Session-cumulative cache totals at the end of the log (authoritative so far). */
  readonly cacheInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly cacheHitRate: number | undefined
}

/**
 * Scan a bound session's log for the route facts. Pure and defensive —
 * malformed payloads degrade to no-ops, never throw.
 */
export function backfillRouteFromLog(events: readonly SessionEvent[]): RouteBackfill {
  let provider: string | undefined
  let model: string | undefined
  let reasoningEffort: string | undefined
  let contextWindow: number | undefined
  let lastUsageTokens: number | undefined
  let cacheInput = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cacheHitRate: number | undefined
  for (const event of events) {
    switch (event.type) {
      case 'request/header': {
        const config = headerConfigOf(event.data)
        if (config === undefined) break
        if (config.provider !== undefined) provider = config.provider
        if (config.model !== undefined) model = config.model
        if (config.reasoningEffort !== undefined) reasoningEffort = config.reasoningEffort
        break
      }
      case 'request/context': {
        const window = rec<{ contextWindow?: unknown }>(event.data).contextWindow
        if (typeof window === 'number' && Number.isFinite(window) && window > 0) contextWindow = window
        break
      }
      case 'assistant/message': {
        const usage = usageComponentsOf(event.data)
        if (usage === undefined) break
        lastUsageTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
        cacheInput += usage.inputTokens
        cacheRead += usage.cacheReadTokens
        cacheWrite += usage.cacheWriteTokens
        const billedInput = cacheInput + cacheRead + cacheWrite
        cacheHitRate = billedInput > 0 ? (cacheRead / billedInput) * 100 : undefined
        break
      }
      default:
        break
    }
  }
  return { provider, model, reasoningEffort, contextWindow, lastUsageTokens, cacheInputTokens: cacheInput, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, cacheHitRate }
}

/**
 * Apply route backfill onto the run state. Route display fields only fill
 * holes (a live event is never overwritten); the cache totals are
 * ASSIGNED — the scan is authoritative for everything appended so far, and
 * live folds continue from its boundary without double counting.
 */
export function applyRouteBackfill(state: RunState, backfill: RouteBackfill): void {
  if (state.provider === undefined && backfill.provider !== undefined) state.provider = backfill.provider
  if (state.model === undefined && backfill.model !== undefined) state.model = backfill.model
  if (state.reasoningEffort === undefined && backfill.reasoningEffort !== undefined) state.reasoningEffort = backfill.reasoningEffort
  if (state.contextWindow === undefined && backfill.contextWindow !== undefined) state.contextWindow = backfill.contextWindow
  if (state.lastUsageTokens === undefined && backfill.lastUsageTokens !== undefined) state.lastUsageTokens = backfill.lastUsageTokens
  state.cacheInputTokens = backfill.cacheInputTokens
  state.cacheReadTokens = backfill.cacheReadTokens
  state.cacheWriteTokens = backfill.cacheWriteTokens
  state.cacheHitRate = backfill.cacheHitRate
}

// --------------------------------------------------- child-log backfill --

/**
 * Facts derivable from a child session's own append-only log. A child
 * discovered mid-run (mid-turn attach) or after its events raced the parent's
 * `tool-workflow/agent-start` missed the naming events — the log is the
 * authoritative backfill source, the same pattern dsh-tui-pi uses for its
 * round-count reconcile.
 */
export interface ChildBackfill {
  /** Durable creation label from `subagent/descriptor` (the spawn agent name). */
  readonly label: string | undefined
  /** assistant/message count in the log (the child's true round count). */
  readonly rounds: number
  /** Last invoked tool name, when any. */
  readonly lastTool: string | undefined
  /** Last visible output line of the last assistant message. */
  readonly tail: string | undefined
}

/**
 * Scan a child session's log for the backfill facts. Pure and defensive —
 * malformed payloads degrade exactly like the live fold (no-op, no throw).
 */
export function backfillFromChildLog(events: readonly SessionEvent[]): ChildBackfill {
  let label: string | undefined
  let rounds = 0
  let lastTool: string | undefined
  let tail: string | undefined
  for (const event of events) {
    switch (event.type) {
      case 'subagent/descriptor': {
        const found = rec<{ label?: unknown }>(event.data).label
        if (typeof found === 'string' && found !== '') label = found
        break
      }
      case 'assistant/message': {
        rounds += 1
        const text = assistantTextOf(event.data)
        if (text !== '') tail = lastNonBlankLine(text)
        break
      }
      case 'tool/call': {
        const name = rec(event.data).name
        if (typeof name === 'string' && name !== '') lastTool = name
        break
      }
      default:
        break
    }
  }
  return { label, rounds, lastTool, tail }
}

/**
 * Apply backfill facts onto an existing child row. Rounds only correct UP
 * (never un-count live-folded events); lastTool/tail only fill holes so a
 * fresher live value always wins; a real label always replaces the fallback
 * placeholder.
 */
export function applyChildBackfill(state: RunState, childId: string, backfill: ChildBackfill): void {
  const row = state.subagents.get(childId)
  if (row === undefined) return
  if (backfill.label !== undefined && !FALLBACK_LABEL_RE.test(backfill.label)) row.label = backfill.label
  if (backfill.rounds > row.rounds) row.rounds = backfill.rounds
  if (row.lastTool === undefined) row.lastTool = backfill.lastTool
  if (row.tail === undefined) row.tail = backfill.tail
}

/**
 * Display label for a subagent row: real name + short-hash suffix when the
 * workflow/descriptor events carried one (`workhorse·49a6`, disambiguates
 * same-name instances), otherwise the raw hash prefix.
 */
export function subagentDisplayLabel(row: SubagentRow): string {
  const shortHash = row.childId.slice(0, 4)
  if (row.label !== '' && !FALLBACK_LABEL_RE.test(row.label)) {
    return `${row.label}·${shortHash}`
  }
  // TODO(subagent-name): use_agent children whose deployment emits neither
  // tool-workflow/agent-start labels nor subagent/descriptor payloads have no
  // name in the event stream — fall back to the hash prefix until a naming
  // source exists.
  return row.childId.slice(0, 8)
}
