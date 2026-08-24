/**
 * Status-card builder: projects the pure {@link RunState} into a Feishu
 * interactive card (legacy JSON schema, `lark_md` text) plus a content hash
 * the publisher uses to skip no-op updates. One card per turn: created on
 * turn/open, patched in place on the status beat, finalized on turn/end —
 * never one message per event.
 *
 * Display policy (design doc §5): status info only — tool names, ✔/✘,
 * durations, rounds, todo done/total, compact subagent rows. The think tail
 * (last reasoning line) appears only when the operator turns it on
 * (`/display think on`).
 */

import type { RunState } from './run-state.ts'
import { contextTokensEstimate, reasoningTail, subagentDisplayLabel, subagentRows } from './run-state.ts'
import { clipLine, formatDuration, formatWhen } from './text.ts'
import type { ResumeRow } from './resume-table.ts'

/**
 * Feishu legacy interactive card (structural — sent as JSON string). Still the
 * status-card shape; assistant body cards have moved to {@link Schema2Card}.
 */
export interface InteractiveCard {
  config: { wide_screen_mode: boolean }
  /** Omitted for minimal body cards (a reply should not carry a big banner). */
  header?: {
    title: { tag: 'plain_text'; content: string }
    template: 'blue' | 'green' | 'red' | 'grey' | 'orange'
  }
  elements: Array<Record<string, unknown>>
}

/**
 * Feishu card JSON schema 2.0 (sent as JSON string, msg_type stays
 * `interactive`): markdown elements in the body render fenced code blocks
 * (with language highlighting) and GFM tables natively.
 */
export interface Schema2Card {
  schema: '2.0'
  config: { width_mode: string }
  body: { elements: Array<Record<string, unknown>> }
}

/** Any card shape the gateway can send. */
export type AnyCard = InteractiveCard | Schema2Card

/** Card build inputs beyond the run state. */
export interface CardContext {
  /** Bound session label (cwd basename · short id). */
  sessionLabel: string
  /** Whether the think tail line is shown (default off). */
  displayThink: boolean
  /** Rendering clock (epoch ms) — elapsed timers derive from it. */
  now: number
}

/** Tail-line clip for think/tool details. */
const TAIL_CLIP = 200

const TODO_ICON: Record<string, string> = {
  pending: '☐',
  in_progress: '◐',
  completed: '☑',
}

/** Emoji for a turn-end reason kind. */
export function turnEndIcon(reason: string | undefined): string {
  switch (reason) {
    case 'completed': return '✅'
    case 'error': return '❌'
    case 'aborted': return '⛔'
    case 'max-tokens': return '⚠️'
    case 'blocked': return '🚫'
    default: return '❕'
  }
}

/** Header title word for a turn-end reason kind (空 for mid-run). */
function turnEndWord(reason: string | undefined): string {
  switch (reason) {
    case 'completed': return '完成'
    case 'error': return '失败'
    case 'aborted': return '已停止'
    case 'max-tokens': return '达到长度上限'
    case 'blocked': return '被拦截'
    default: return '已结束'
  }
}

/** The phase badge line: 🤔 thinking / 🔧 tool / ⚙️ processing / done. */
export function statusLine(state: RunState, now: number): string {
  if (!state.running) {
    const reason = state.turnEndReason
    const elapsed = state.turnStartedAt !== undefined && state.turnEndedAt !== undefined
      ? state.turnEndedAt - state.turnStartedAt
      : 0
    return `${turnEndIcon(reason)} **${turnEndWord(reason)}** · ${formatDuration(elapsed)}`
  }
  const elapsed = state.turnStartedAt === undefined ? 0 : now - state.turnStartedAt
  if (state.currentTool !== undefined) {
    return `🔧 **${state.currentTool.name}** · ${formatDuration(Math.max(0, now - state.currentTool.startedAt))}`
  }
  if (state.thinkingSince !== undefined) {
    return `🤔 **thinking** · ${formatDuration(Math.max(0, now - state.thinkingSince))}`
  }
  return `⚙️ **processing** · ${formatDuration(elapsed)}`
}

/** The counters line: rounds · tools ✔/✘ · retries · subagents. */
export function countersLine(state: RunState): string {
  const parts: string[] = [`rounds ${state.rounds}`]
  if (state.toolsDone > 0 || state.toolsFailed > 0) {
    parts.push(`tools ✔${state.toolsDone}${state.toolsFailed > 0 ? ` ✘${state.toolsFailed}` : ''}`)
  }
  if (state.retries > 0) {
    parts.push(`↻${state.retries}${state.maxRetries !== undefined ? `/${state.maxRetries}` : ''}`)
  }
  const running = subagentRows(state).filter(row => row.outcome === undefined).length
  if (running > 0) parts.push(`🧵 ×${running}`)
  return parts.join(' · ')
}

/** The last-settled-tools line (`bash ✔1.2s · read ✘0.3s`), omitted when none. */
export function toolsLine(state: RunState): string | undefined {
  if (state.toolHistory.length === 0) return undefined
  const recent = state.toolHistory.slice(-4)
  return recent
    .map(row => `${row.name} ${row.ok ? '✔' : '✘'}${formatDuration(row.durationMs)}`)
    .join(' · ')
}

/** The todo line (`☑ 3/7 · ◐ 当前项…`), hidden once all done (TUI semantics). */
export function todoLine(state: RunState): string | undefined {
  const todo = state.todo
  if (todo === undefined || todo.length === 0) return undefined
  const done = todo.filter(item => item.status === 'completed').length
  if (done === todo.length) return undefined
  // Phone-narrow single-line form: `x/z` plus at most a clipped in-progress
  // title — never the per-item list.
  const current = todo.find(item => item.status === 'in_progress')
  // Skip the segment entirely when the in-progress title is empty — a bare
  // icon with a dangling separator reads as garbage on a phone line.
  const icon = current === undefined || current.content.trim() === ''
    ? ''
    : `${TODO_ICON['in_progress']} ${clipLine(current.content, 24)} · `
  return `${icon}☑ ${done}/${todo.length}`
}

/** Compact subagent rows (`├ workhorse·49a6 ↻ · round 2 · tail…`). */
export function subagentLines(state: RunState): string[] {
  return subagentRows(state).slice(0, 5).map(row => {
    const mark = row.outcome === undefined
      ? '↻'
      : row.outcome === 'completed' ? '✔' : row.outcome === 'failed' ? '✘' : '⛔'
    const parts = [`├ ${subagentDisplayLabel(row)} ${mark} · round ${row.rounds}`]
    if (row.tail !== undefined) parts.push(clipLine(row.tail, 60))
    return parts.join(' · ')
  })
}

/** The think tail line (display-on only), or undefined when there is none. */
export function thinkTailLine(state: RunState): string | undefined {
  const tail = reasoningTail(state)
  if (tail === undefined) return undefined
  const icon = state.currentTool !== undefined ? `🔧 ${state.currentTool.name}` : '🤔'
  return `${icon} _${clipLine(tail, TAIL_CLIP)}_`
}

// ------------------------------------------------------------------ footer --

/**
 * Optional fields of the shared note footer. Every field is independent —
 * unavailable data simply stays out of the line and its separator never
 * renders.
 */
export interface FooterFields {
  /** Elapsed time of the turn (ms). */
  elapsedMs?: number
  /** Assistant rounds of the current turn ("Turn N"). */
  rounds?: number
  /** Model id (`deepseek-v4`, provider prefix stripped here). */
  model?: string
  /** Context occupancy in percent (needs a known window; 0–100). */
  contextPercent?: number
  /** Fallback context size in tokens when no window is known. */
  contextTokens?: number
  /** Settled tool-call count of the current turn. */
  toolCalls?: number
  /**
   * Reasoning-effort level as rendered (`high`, `medium`, `low`, or `off`;
   * undefined = unknown — field omitted entirely).
   */
  thinking?: string
}

/** Compact token count for narrow screens (`950`, `12.3k`, `1.2M`). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n)}`
}

/** Short display name of a model id: last path segment (`org/deepseek-v4` → `deepseek-v4`). */
export function shortModelName(model: string): string {
  const last = model.split('/').pop() ?? model
  return last === '' ? model : last
}

/**
 * Assemble the note-footer statistics line, e.g.
 * `⏱ 12m34s · Turn 8 · 🤖 deepseek-v4 · 📊 ctx 43% · 🔧 23 calls · 🧠 high`.
 * Fields with no value (or zero counters) are skipped; separators only join
 * fields that actually rendered. Returns '' when nothing is available.
 */
export function buildFooter(fields: FooterFields): string {
  const parts: string[] = []
  if (fields.elapsedMs !== undefined) parts.push(`⏱ ${formatDuration(fields.elapsedMs)}`)
  if (fields.rounds !== undefined && fields.rounds > 0) parts.push(`Turn ${fields.rounds}`)
  if (fields.model !== undefined && fields.model !== '') parts.push(`🤖 ${shortModelName(fields.model)}`)
  if (fields.contextPercent !== undefined) {
    parts.push(`📊 ctx ${Math.min(100, Math.max(0, Math.round(fields.contextPercent)))}%`)
  } else if (fields.contextTokens !== undefined && fields.contextTokens > 0) {
    parts.push(`📊 ctx ${fmtTokens(fields.contextTokens)}`)
  }
  if (fields.toolCalls !== undefined && fields.toolCalls > 0) parts.push(`🔧 ${fields.toolCalls} calls`)
  if (fields.thinking !== undefined) parts.push(`🧠 ${fields.thinking}`)
  return parts.join(' · ')
}

/**
 * Derive the footer fields from the run state + rendering clock. Percent
 * needs a known context window; without it the raw estimate stands in.
 * The thinking field only appears once a request/header was observed
 * (before that we cannot distinguish "off" from "unknown").
 */
export function footerFieldsOf(state: RunState, now: number): FooterFields {
  const elapsedMs = !state.running && state.turnStartedAt !== undefined && state.turnEndedAt !== undefined
    ? state.turnEndedAt - state.turnStartedAt
    : state.turnStartedAt !== undefined
      ? now - state.turnStartedAt
      : undefined
  const tokens = contextTokensEstimate(state)
  const toolCalls = state.toolsDone + state.toolsFailed
  return {
    elapsedMs,
    rounds: state.rounds,
    model: state.model,
    contextPercent: tokens !== undefined && state.contextWindow !== undefined && state.contextWindow > 0
      ? (tokens / state.contextWindow) * 100
      : undefined,
    contextTokens: state.contextWindow !== undefined ? undefined : tokens,
    toolCalls,
    // A seen header proves the route is known; effort absent from it means
    // reasoning is off for that route. We KEEP `🧠 off` in that case rather
    // than omitting the field: the footer's all-fields-optional design already
    // uses omission to mean "unknown", so rendering off preserves the three-way
    // distinction (unknown / off / level) the status card promises.
    thinking: state.model === undefined
      ? undefined
      : state.reasoningEffort !== undefined && state.reasoningEffort !== 'off'
        ? state.reasoningEffort
        : 'off',
  }
}

/**
 * Build the whole card. The returned hash covers every rendered line so the
 * publisher can skip a patch when nothing visible changed.
 */
export function buildStatusCard(state: RunState, context: CardContext): { card: InteractiveCard; hash: string } {
  const { sessionLabel, displayThink, now } = context
  const running = state.running
  const template: NonNullable<InteractiveCard['header']>['template'] = !running
    ? state.turnEndReason === 'completed' ? 'green' : state.turnEndReason === undefined ? 'grey' : 'red'
    : 'blue'
  const headerTitle = running
    ? `dsh · ${sessionLabel} · 运行中`
    : `dsh · ${sessionLabel} · ${turnEndWord(state.turnEndReason)}`

  const mdLines: string[] = [statusLine(state, now)]
  const counters = countersLine(state)
  if (counters !== '') mdLines.push(counters)
  const tools = toolsLine(state)
  if (tools !== undefined) mdLines.push(tools)
  const subagents = subagentLines(state)
  for (const line of subagents) mdLines.push(line)
  const todo = todoLine(state)
  if (todo !== undefined) mdLines.push(`📋 ${todo}`)
  if (displayThink) {
    const tail = thinkTailLine(state)
    if (tail !== undefined) mdLines.push(tail)
  }

  const footer = buildFooter(footerFieldsOf(state, now))
  // The note carries the shared statistics footer first, the static hint last.
  const noteElements: Array<Record<string, unknown>> = []
  if (footer !== '') noteElements.push({ tag: 'plain_text', content: footer })
  noteElements.push({ tag: 'plain_text', content: 'dsh-feishu · /help 查看命令' })

  const card: InteractiveCard = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: headerTitle },
      template,
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: mdLines.join('\n') } },
      { tag: 'note', elements: noteElements },
    ],
  }
  return { card, hash: JSON.stringify([template, headerTitle, mdLines, footer]) }
}

/**
 * Build a minimal schema 2.0 card carrying one assistant body segment
 * verbatim as a native markdown element — fenced code blocks (with language
 * highlighting) and GFM tables render as-is, so no legacy downgrade
 * conversion runs here. No header — a reply should not repeat the big
 * status-card banner.
 */
export function buildBodyCard(body: string): Schema2Card {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    body: {
      elements: [{ tag: 'markdown', content: body }],
    },
  }
}

/**
 * Mid-turn progress card (schema 2.0): the excerpt of what the turn produced
 * since the previous push, verbatim as a native markdown element, plus the
 * shared note footer. A NEW message every time — never a patch of the status
 * card, which keeps its own in-place lifecycle.
 */
export function buildProgressCard(body: string, footer: string): Schema2Card {
  const elements: Array<Record<string, unknown>> = [{ tag: 'markdown', content: body }]
  if (footer !== '') {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: footer }] })
  }
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    body: { elements },
  }
}

// ---------------------------------------------------------- /resume picker --

/**
 * Session-cell text of a picker row: `preview · dir`, skipping the dir when
 * the inspect-failed fallback preview already embeds it. The fallback is
 * always exactly `${dir} · ${short-id}` (see {@link buildResumeRows}), so an
 * exact prefix match avoids the false positives a substring test would hit
 * (e.g. preview "fix repo bugs" with dir "repo").
 */
function sessionCell(row: ResumeRow): string {
  return row.preview.startsWith(`${row.dir} ·`) ? row.preview : `${row.preview} · ${row.dir}`
}

/**
 * Build the `/resume` session-picker card (schema 2.0): a native table element
 * (`tag: 'table'`, card JSON 2.0; Feishu client ≥7.20) with three narrow columns
 — `#` for the `/resume N` index, `会话` (`preview · dir`), `时间` — so the list
 * stays readable on a phone. Rows arrive already truncated by
 * {@link buildResumeRows}; an empty list degrades to a plain markdown notice
 * instead of rendering an empty table.
 */
export function buildSessionListCard(rowsInput: readonly ResumeRow[], now = Date.now()): Schema2Card {
  // The rendered `#` column must agree with `pickResumeRow`'s positional
  // `/resume N` lookup (`rows[n - 1]`). Normalize the order defensively (a
  // caller may hand over unsorted rows), then assert the 1-based contiguity
  // contract — a violation is a caller bug that would render a misleading
  // picker, so fail loudly rather than display numbers that pick another row.
  const rows = [...rowsInput].sort((a, b) => a.index - b.index)
  const elements: Array<Record<string, unknown>> = []
  if (rows.length === 0) {
    elements.push({ tag: 'markdown', content: '没有可恢复的会话。' })
  } else {
    rows.forEach((row, i) => {
      if (row.index !== i + 1) {
        throw new Error(`session list index contract broken: rows[${i}].index = ${row.index}, expected ${i + 1}`)
      }
    })
    // `page_size` is clamped to the official [1, 10] range; buildResumeRows
    // already caps the list at RESUME_ROW_LIMIT (=10), so this never hides a
    // row the operator could still pick.
    elements.push({
      tag: 'table',
      page_size: Math.min(rows.length, 10),
      row_height: 'low',
      columns: [
        { name: 'index', display_name: '#', data_type: 'number' },
        { name: 'session', display_name: '会话', data_type: 'text' },
        { name: 'time', display_name: '时间', data_type: 'text' },
      ],
      rows: rows.map(row => ({
        index: row.index,
        session: sessionCell(row),
        time: formatWhen(row.lastTime ?? row.createdAt, now),
      })),
    })
    elements.push({ tag: 'markdown', content: '回复 /resume N 进入对应会话' })
  }
  return { schema: '2.0', config: { width_mode: 'fill' }, body: { elements } }
}
