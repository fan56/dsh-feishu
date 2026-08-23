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
  /** Epoch ms of the latest reasoning delta (the thinking phase marker). */
  thinkingSince: number | undefined
  /** Raw reasoning buffer (capped) — tail source when think display is on. */
  reasoningBuffer: string
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
  /** Text blocks of every assistant message this turn — the turn/end body. */
  assistantTexts: string[]
  /** Last visible line of the latest assistant message (status snapshot). */
  lastAssistantLine: string | undefined
}

/** Fresh state (no turn observed). */
export function initialRunState(): RunState {
  return {
    running: false,
    turnStartedAt: undefined,
    turnEndedAt: undefined,
    turnEndReason: undefined,
    rounds: 0,
    thinkingSince: undefined,
    reasoningBuffer: '',
    currentTool: undefined,
    toolsDone: 0,
    toolsFailed: 0,
    toolHistory: [],
    todo: undefined,
    subagents: new Map(),
    runSeqToChild: new Map(),
    retries: 0,
    maxRetries: undefined,
    assistantTexts: [],
    lastAssistantLine: undefined,
  }
}

/** Per-turn reset — also clears the whole-run counters (card scope is one turn). */
function beginTurn(state: RunState, time: number): void {
  state.running = true
  state.turnStartedAt = time
  state.turnEndedAt = undefined
  state.turnEndReason = undefined
  state.rounds = 0
  state.thinkingSince = undefined
  state.reasoningBuffer = ''
  state.currentTool = undefined
  state.toolsDone = 0
  state.toolsFailed = 0
  state.toolHistory = []
  state.todo = undefined
  state.subagents.clear()
  state.runSeqToChild.clear()
  state.retries = 0
  state.maxRetries = undefined
  state.assistantTexts = []
  state.lastAssistantLine = undefined
}

function endTurn(state: RunState, time: number, reason: string): void {
  state.running = false
  state.turnEndedAt = time
  state.turnEndReason = reason
  state.thinkingSince = undefined
  state.currentTool = undefined
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
      if (text !== '') {
        state.assistantTexts.push(text)
        state.lastAssistantLine = lastNonBlankLine(text)
      }
      state.rounds += 1
      // A landed message proves the request round-tripped — clear retry and
      // thinking markers (dsh emits no retry-cleared event).
      state.retries = 0
      state.maxRetries = undefined
      state.thinkingSince = undefined
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
      const childId = rec(event.data).childId
      if (childId !== undefined && !state.subagents.has(childId)) {
        state.subagents.set(childId, {
          childId,
          label: rec(event.data).label ?? `subagent ${childId.slice(0, 8)}`,
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

/** Joined assistant body of the last turn (empty string when no text). */
export function lastTurnBody(state: RunState): string {
  return state.assistantTexts.join('\n\n').trim()
}

/** Reasoning tail — last visible line of the capped reasoning buffer. */
export function reasoningTail(state: RunState): string | undefined {
  return state.reasoningBuffer === '' ? undefined : lastNonBlankLine(state.reasoningBuffer)
}
