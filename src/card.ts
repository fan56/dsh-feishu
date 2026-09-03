/**
 * Turn-card builder: projects the pure {@link RunState} into a Feishu card
 * (JSON schema 2.0, native markdown element) plus a content hash the
 * publisher uses to skip no-op updates. One card per ROUND: opened when a
 * round starts (turn/start, or right after the previous round settled),
 * patched in place on the status beat (30s, hash-gated), settled to
 * "Round N · 💬 回复" when its assistant/message lands — the same message
 * ships verbatim as a body card — and the turn's final card carries the
 * end state (✅/❌/⛔ + total duration).
 *
 * Layout: the header carries the round number plus the live phase
 * (🤔 thinking / 🔧 tool / ⚙️ processing / ⏳ subagent / end icon); the body is
 * markdown sections — an activity list (thinking state, tool calls by name,
 * the latest LLM message), a subagent list (status + last output line), and a
 * GFM task-list todo section whose first line carries the ☑ x/z progress.
 * The stats line (elapsed · model · think level · CH% · tool calls) closes
 * the markdown body after an `---` divider — schema V2 cards REJECT the
 * legacy `note` tag (server error 200861), so no note element may appear in
 * a 2.0 body. The think tail text appears only when the operator turns it on
 * (`/feishu-plugin think off` hides it; on by default).
 */

import type { RunState } from './run-state.ts'
import { contextTokensEstimate, reasoningTail, streamingTextTail, subagentDisplayLabel, subagentRows } from './run-state.ts'
import { clipLine, formatDuration, formatWhen } from './text.ts'
import type { ResumeRow } from './resume-table.ts'

/**
 * Feishu card JSON schema 2.0 (sent as JSON string, msg_type stays
 * `interactive`): markdown elements in the body render headings, task lists,
 * fenced code blocks (with language highlighting) and GFM tables natively.
 * The header is optional — body cards ship without one (a reply should not
 * repeat the turn-card banner).
 */
export interface Schema2Card {
  schema: '2.0'
  config: { width_mode: string }
  header?: {
    title: { tag: 'plain_text'; content: string }
    subtitle?: { tag: 'plain_text'; content: string }
    template: 'blue' | 'green' | 'red' | 'grey' | 'orange'
  }
  body: { elements: Array<Record<string, unknown>> }
}

/** Any card shape the gateway can send. */
export type AnyCard = Schema2Card

/** Card build inputs beyond the run state. */
export interface CardContext {
  /** Bound session label (cwd basename · short id). */
  sessionLabel: string
  /** Whether the think tail line is shown (default off). */
  displayThink: boolean
  /** Rendering clock (epoch ms) — elapsed timers derive from it. */
  now: number
  /**
   * Present when settling a round card (its assistant/message just landed):
   * the header renders "Round N · 💬 回复 · <duration>" instead of the live
   * phase. The round count itself comes from the state (already incremented).
   */
  settledRoundMs?: number
  /**
   * Quick actions rendered as buttons under the body (taps arrive via
   * card.action.trigger → parseRoundCardAction). The running card carries the
   * stop gesture; the ended card offers a continue nudge. Absent = no buttons
   * (read-only views keep the card inert).
   */
  actions?: { readonly stop?: boolean; readonly continue?: boolean }
}

/** Tail-line clip for the think tail inside the activity list. */
const TAIL_CLIP = 200
/** Clip for the latest-LLM-message bullet. */
const MSG_CLIP = 120
/** Clip for a subagent's last output line. */
const SUB_TAIL_CLIP = 80
/** Clip for one todo task-list item. */
const TODO_CLIP = 60
/** Settled-tool rows listed in the activity section. */
const TOOL_ITEMS = 5
/** Subagent rows listed in the subagent section. */
const SUBAGENT_ITEMS = 5

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

// ------------------------------------------------------------------- phase --

/** Live phase of the turn, in header-priority order. */
export type TurnPhase =
  | { readonly kind: 'ended'; readonly reason: string | undefined }
  | { readonly kind: 'tool'; readonly name: string; readonly since: number }
  | { readonly kind: 'thinking'; readonly since: number }
  | { readonly kind: 'subagent'; readonly live: number }
  | { readonly kind: 'processing' }

/**
 * Classify the turn's current phase: a running tool beats thinking, thinking
 * beats waiting on subagents, everything else running is "processing". The
 * subagent phase means the main agent is between rounds while child sessions
 * still work (no live tool call, no reasoning deltas).
 */
export function turnPhase(state: RunState): TurnPhase {
  if (!state.running) return { kind: 'ended', reason: state.turnEndReason }
  if (state.currentTool !== undefined) {
    return { kind: 'tool', name: state.currentTool.name, since: state.currentTool.startedAt }
  }
  if (state.thinkingSince !== undefined) return { kind: 'thinking', since: state.thinkingSince }
  const live = subagentRows(state).filter(row => row.outcome === undefined).length
  if (live > 0) return { kind: 'subagent', live }
  return { kind: 'processing' }
}

/**
 * Round number for the header: the round IN FLIGHT while running (completed
 * rounds + 1 — "Round 1 · 🤔 thinking" reads as the first round underway),
 * the total count once the turn ended.
 */
export function roundNumber(state: RunState): number {
  return state.running ? state.rounds + 1 : state.rounds
}

/**
 * Header title line: `Round 3 · 🔧 bash · 8s` while running,
 * `Round 3 · ✅ 完成 · 3m12s` once ended.
 */
export function turnHeaderTitle(state: RunState, now: number, settledRoundMs?: number): string {
  const round = roundNumber(state)
  if (settledRoundMs !== undefined && state.running) {
    return `Round ${state.rounds} · 💬 回复 · ${formatDuration(settledRoundMs)}`
  }
  const phase = turnPhase(state)
  switch (phase.kind) {
    case 'ended': {
      const elapsed = state.turnStartedAt !== undefined && state.turnEndedAt !== undefined
        ? state.turnEndedAt - state.turnStartedAt
        : 0
      return `Round ${round} · ${turnEndIcon(phase.reason)} ${turnEndWord(phase.reason)} · ${formatDuration(elapsed)}`
    }
    case 'tool':
      return `Round ${round} · 🔧 ${phase.name} · ${formatDuration(Math.max(0, now - phase.since))}`
    case 'thinking':
      return `Round ${round} · 🤔 thinking · ${formatDuration(Math.max(0, now - phase.since))}`
    case 'subagent':
      return `Round ${round} · ⏳ subagent ×${phase.live}`
    case 'processing':
      return `Round ${round} · ⚙️ processing`
  }
}

/** Header color: blue while running, green on completion, red on failure, grey otherwise. */
function turnTemplate(state: RunState): NonNullable<Schema2Card['header']>['template'] {
  if (state.running) return 'blue'
  if (state.turnEndReason === 'completed') return 'green'
  return state.turnEndReason === undefined ? 'grey' : 'red'
}

// ---------------------------------------------------------------- sections --

/**
 * Activity list items: the recent settled tools (name + ✔/✘ + duration), a
 * retry counter when retrying, the latest LLM message line, then the live
 * items (running tool, thinking state — with the think tail when display is
 * on). Reads chronologically: what it did, what it said, what it is doing.
 */
function activityItems(state: RunState, now: number, displayThink: boolean): string[] {
  const items: string[] = []
  for (const row of state.toolHistory.slice(-TOOL_ITEMS)) {
    items.push(`- 🔧 ${row.name} · ${row.ok ? '✔' : '✘'} ${formatDuration(row.durationMs)}`)
  }
  if (state.retries > 0) {
    items.push(`- ↻ retry ${state.retries}${state.maxRetries !== undefined ? `/${state.maxRetries}` : ''}`)
  }
  if (state.lastAssistantLine !== undefined) {
    items.push(`- 💬 _${clipLine(state.lastAssistantLine, MSG_CLIP)}_`)
  }
  if (state.currentTool !== undefined) {
    items.push(`- 🔧 ${state.currentTool.name} · ⏳ ${formatDuration(Math.max(0, now - state.currentTool.startedAt))}`)
  }
  const tail = reasoningTail(state)
  if (state.thinkingSince !== undefined) {
    const duration = formatDuration(Math.max(0, now - state.thinkingSince))
    const suffix = displayThink && tail !== undefined ? ` — _${clipLine(tail, TAIL_CLIP)}_` : ''
    items.push(`- 🤔 thinking · ${duration}${suffix}`)
  }
  const streaming = streamingTextTail(state)
  if (streaming !== undefined) {
    items.push(`- ✍️ _${clipLine(streaming, TAIL_CLIP)}_`)
  }
  return items
}

/** Outcome words for a settled subagent row. */
const SUBAGENT_OUTCOME: Record<string, string> = {
  completed: '✔ 完成',
  failed: '✘ 失败',
  cancelled: '⛔ 已取消',
}

/**
 * Subagent list items: status info first (running marker + rounds + last
 * tool, or the settled outcome), then the child's last output line.
 */
function subagentItems(state: RunState): string[] {
  return subagentRows(state).slice(0, SUBAGENT_ITEMS).map(row => {
    if (row.outcome !== undefined) {
      return `- ${subagentDisplayLabel(row)} · ${SUBAGENT_OUTCOME[row.outcome] ?? row.outcome}`
    }
    const parts = [`- ${subagentDisplayLabel(row)} · ⏳ round ${row.rounds}`]
    if (row.lastTool !== undefined) parts.push(`🔧 ${row.lastTool}`)
    if (row.tail !== undefined) parts.push(`_${clipLine(row.tail, SUB_TAIL_CLIP)}_`)
    return parts.join(' · ')
  })
}

/**
 * Todo section lines: the `☑ x/z` status on the FIRST line, then one GFM
 * task-list item per entry — `- [x]` done, `- [ ]` pending, in-progress
 * carries a ◐ marker (a task list has no native in-progress state). Items
 * with an empty title are counted in the progress but not rendered. Unlike
 * the old one-line todo, the section stays visible when everything is done —
 * an all-checked list is the turn's closing state, not noise.
 */
function todoSectionLines(state: RunState): string[] | undefined {
  const todo = state.todo
  if (todo === undefined || todo.length === 0) return undefined
  const done = todo.filter(item => item.status === 'completed').length
  const header = `##### 📋 Todo · ☑ ${done}/${todo.length}${done === todo.length ? ' · 全部完成' : ''}`
  const items = todo
    .filter(item => item.content.trim() !== '')
    .map(item => {
      if (item.status === 'completed') return `- [x] ${clipLine(item.content, TODO_CLIP)}`
      if (item.status === 'in_progress') return `- [ ] ◐ ${clipLine(item.content, TODO_CLIP)}`
      return `- [ ] ${clipLine(item.content, TODO_CLIP)}`
    })
  return [header, ...items]
}

// ------------------------------------------------------------------ footer --

/**
 * Optional fields of the shared stats footer. Every field is independent —
 * unavailable data simply stays out of the line and its separator never
 * renders. `ctx` (context occupancy) and `CH` (prompt-cache hit rate) are
 * TWO separate indicators: occupancy = billed context tokens vs the model's
 * window; hit rate = cacheRead / (input + cacheRead + cacheWrite), output
 * excluded, route-segment cumulative (TUI footer semantics).
 */
export interface FooterFields {
  /** Elapsed time of the turn (ms). */
  elapsedMs?: number
  /** Model id (`deepseek-v4`, provider prefix stripped here). */
  model?: string
  /** Context occupancy in percent (needs a known window; 0–100). */
  contextPercent?: number
  /** Fallback context size in tokens when no window is known. */
  contextTokens?: number
  /** Prompt-cache hit rate in percent — only when the gateway reports caching. */
  cacheHitPercent?: number
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
 * Assemble the stats-footer line, e.g.
 * `⏱ 12m34s · 🤖 deepseek-v4 · 🧠 high · 📊 ctx 43% · ⚡ CH 85.0% · 🔧 23 calls`.
 * The round lives in the card header, never here.
 * Fields with no value (or zero counters) are skipped; separators only join
 * fields that actually rendered. Returns '' when nothing is available.
 */
export function buildFooter(fields: FooterFields): string {
  const parts: string[] = []
  if (fields.elapsedMs !== undefined) parts.push(`⏱ ${formatDuration(fields.elapsedMs)}`)
  if (fields.model !== undefined && fields.model !== '') parts.push(`🤖 ${shortModelName(fields.model)}`)
  if (fields.thinking !== undefined) parts.push(`🧠 ${fields.thinking}`)
  if (fields.contextPercent !== undefined) {
    parts.push(`📊 ctx ${Math.min(100, Math.max(0, Math.round(fields.contextPercent)))}%`)
  } else if (fields.contextTokens !== undefined && fields.contextTokens > 0) {
    parts.push(`📊 ctx ${fmtTokens(fields.contextTokens)}`)
  }
  if (fields.cacheHitPercent !== undefined) parts.push(`⚡ CH ${fields.cacheHitPercent.toFixed(1)}%`)
  if (fields.toolCalls !== undefined && fields.toolCalls > 0) parts.push(`🔧 ${fields.toolCalls} calls`)
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
    model: state.model,
    contextPercent: tokens !== undefined && state.contextWindow !== undefined && state.contextWindow > 0
      ? (tokens / state.contextWindow) * 100
      : undefined,
    contextTokens: state.contextWindow !== undefined ? undefined : tokens,
    // CH renders only when the gateway actually reports cache usage — a
    // no-cache gateway (zhipu GLM reports neither component) leaves the
    // field absent rather than showing a meaningless 0.0%.
    cacheHitPercent: state.cacheReadTokens > 0 || state.cacheWriteTokens > 0
      ? state.cacheHitRate
      : undefined,
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

// --------------------------------------------------------------- turn card --

/**
 * Append the stats footer to a card's markdown body behind an `---` divider.
 * Schema V2 has no note component (server rejects `tag: note` with 200861),
 * so the footer rides the markdown element as its last line. An empty footer
 * leaves the body untouched (no dangling divider).
 */
function withStatsFooter(markdown: string, footer: string): string {
  return footer === '' ? markdown : `${markdown}\n\n---\n\n${footer}`
}

/**
 * Build the whole per-turn card. The returned hash covers every rendered
 * string (header title, sections, footer) so the publisher can skip a patch
 * when nothing visible changed — while any change (round advance, phase move,
 * tail growth, todo tick) triggers the 30s-beat patch.
 */
export function buildStatusCard(state: RunState, context: CardContext): { card: Schema2Card; hash: string } {
  const { sessionLabel, displayThink, now, settledRoundMs, actions } = context
  const title = turnHeaderTitle(state, now, settledRoundMs)
  const template = turnTemplate(state)

  const activity = activityItems(state, now, displayThink)
  const sections: string[] = []
  if (state.running) {
    // Live card: always show the section, placeholder while the round waits
    // for its first event.
    sections.push(['##### 🧭 活动', ...(activity.length > 0 ? activity : ['- ⏳ 等待模型响应…'])].join('\n'))
  } else if (activity.length > 0) {
    // End-state card: no placeholder — an empty round (settled right before
    // turn/end) simply omits the section instead of pretending to wait.
    sections.push(['##### 🧭 活动', ...activity].join('\n'))
  }
  const subs = subagentItems(state)
  if (subs.length > 0) {
    const live = subagentRows(state).filter(row => row.outcome === undefined).length
    sections.push([`##### 🧵 子代理${live > 0 ? ` · ⏳ ×${live}` : ''}`, ...subs].join('\n'))
  }
  const todo = todoSectionLines(state)
  if (todo !== undefined) sections.push(todo.join('\n'))
  const markdown = sections.join('\n\n')

  const footer = buildFooter(footerFieldsOf(state, now))

  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: withStatsFooter(markdown, footer) },
  ]
  if (actions?.stop === true) elements.push(roundActionButton('stop'))
  if (actions?.continue === true) elements.push(roundActionButton('continue'))

  const card: Schema2Card = {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: `dsh · ${sessionLabel}` },
      template,
    },
    body: { elements },
  }
  return { card, hash: JSON.stringify([template, title, sessionLabel, markdown, footer, elements.length]) }
}

// ------------------------------------------------------------ quick actions --

/** Marker written into every round-card action button's `value.action`. */
export const ROUND_ACTION = 'dsh_feishu_round'

/** Button name prefix; the operation rides after it (SDK value-strip fallback). */
const ROUND_NAME_PREFIX = 'dsh_feishu_round_'

/** Which quick action a round-card button performs. */
export type RoundActionOp = 'stop' | 'continue'

/** One round-card action button (value carries the op; the name is the fallback). */
function roundActionButton(op: RoundActionOp): Record<string, unknown> {
  return {
    tag: 'button',
    name: `${ROUND_NAME_PREFIX}${op}`,
    // value MUST exist: value-less interactive components are rejected
    // client-side with 200340 and the callback is never delivered.
    value: { action: ROUND_ACTION, op },
    text: { tag: 'plain_text', content: op === 'stop' ? '⛔ 停止' : '▶️ 继续' },
    type: op === 'stop' ? 'danger' : 'primary',
  }
}

/**
 * Recognize OUR round-card action in a `card.action.trigger` payload;
 * undefined for anything else. Value first, then the name-prefix fallback
 * (SDK versions may strip values from submits) — the same ladder every
 * interactive card here uses.
 */
export function parseRoundCardAction(data: unknown): RoundActionOp | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const action = (data as { action?: unknown }).action
  if (action === null || typeof action !== 'object') return undefined
  const buttonValue = (action as { value?: unknown }).value
  if (buttonValue !== null && typeof buttonValue === 'object') {
    const marker = (buttonValue as { action?: unknown }).action
    const op = (buttonValue as { op?: unknown }).op
    if (marker === ROUND_ACTION && (op === 'stop' || op === 'continue')) return op
    // A value carrying a DIFFERENT action means this is not our button —
    // the name fallback below must not fire on foreign submits.
    if (typeof marker === 'string') return undefined
  }
  const name = (action as { name?: unknown }).name
  if (typeof name === 'string' && name.startsWith(ROUND_NAME_PREFIX)) {
    const op = name.slice(ROUND_NAME_PREFIX.length)
    if (op === 'stop' || op === 'continue') return op
  }
  return undefined
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

// ---------------------------------------------------------- background push --

/**
 * The completion push card for a session the phone is not bound to (background
 * mode): header = cause + end state, body = the turn's last visible output
 * line. Deliberately compact — the full round-card pipeline only covers the
 * bound session; this card's job is "something finished over there, here is
 * the one-line gist".
 */
export function buildPushCard(input: {
  readonly cause: string
  readonly reason: string | undefined
  readonly sessionLabel: string
  readonly lastAssistant: string | undefined
  readonly durationMs: number | undefined
}): Schema2Card {
  const icon = turnEndIcon(input.reason)
  const word = input.reason === undefined ? '已结束' : turnEndWord(input.reason)
  const duration = input.durationMs !== undefined ? ` · ${formatDuration(input.durationMs)}` : ''
  const lines = [`**会话 ${input.sessionLabel}** · ${icon} ${word}${duration}`]
  if (input.lastAssistant !== undefined && input.lastAssistant !== '') {
    lines.push(`> ${clipLine(input.lastAssistant, 160)}`)
  }
  lines.push('_(后台会话的完成推送；/resume 进入该会话查看全貌)_')
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: `${input.cause} · ${icon} ${word}` },
      subtitle: { tag: 'plain_text', content: `dsh · ${input.sessionLabel}` },
      template: input.reason === 'error' ? 'red' : 'blue',
    },
    body: { elements: [{ tag: 'markdown', content: lines.join('\n\n') }] },
  }
}

/**
 * Shared `/resume` index contract: rows must arrive contiguous from 1 **in
 * input order** — `pickResumeRow` resolves `/resume N` positionally against
 * the caller's array (`rows[n - 1]`), so a merely-sortable input would render
 * numbers that pick the wrong session without any error. Assert before any
 * normalization; a violation is a caller bug, so fail loudly. Sorting (kept
 * in the builders as defensive normalization) no longer carries this duty.
 */
function assertIndexContract(rows: readonly ResumeRow[]): void {
  rows.forEach((row, i) => {
    if (row.index !== i + 1) {
      throw new Error(`session list index contract broken: rows[${i}].index = ${row.index}, expected ${i + 1}`)
    }
  })
}

/**
 * Build the `/resume` picker as a plain GFM ordered list shipped through the
 * same {@link buildBodyCard} channel as assistant bodies. This is the
 * send-time degradation path: it fires only when the table-card send fails on
 * our side — server rejection, rate-limit retries exhausted, or a transport
 * error. An old client that receives the table but renders it silently blank
 * fails AFTER delivery and is undetectable at send time; that scenario needs
 * `resumeListStyle: 'list'` to force this renderer outright. Numbering MUST
 * agree with `pickResumeRow`'s positional lookup (`rows[n - 1]`), so the same
 * 1-based contiguity contract as {@link buildSessionListCard} is enforced.
 */
export function buildSessionListAsMarkdown(rowsInput: readonly ResumeRow[], now = Date.now()): Schema2Card {
  assertIndexContract(rowsInput)
  const rows = [...rowsInput].sort((a, b) => a.index - b.index)
  if (rows.length === 0) return buildBodyCard('没有可恢复的会话。')
  const lines = rows.map(row => {
    // Same information as the table's `session` cell (preview · dir), with
    // the preview clipped so a phone line survives. The dir sits in the bold
    // head; when the preview is the inspect-failed fallback (`dir · short-id`,
    // same exact-prefix rule as {@link sessionCell}) it would only duplicate
    // what the head already shows, so it stays out.
    const parts = [`${row.index}. **${row.dir} · ${formatWhen(row.lastTime ?? row.createdAt, now)}** · ${row.sessionId.slice(0, 8)}`]
    if (row.preview !== '' && !row.preview.startsWith(`${row.dir} ·`)) parts.push(clipLine(row.preview, 32))
    return parts.join(' · ')
  })
  lines.push('回复 /resume N 进入对应会话')
  return buildBodyCard(lines.join('\n'))
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

/** Marker written into the resume picker submit button's `value.action`. */
export const RESUME_SUBMIT_ACTION = 'dsh_feishu_resume'

/** Submit button name prefix; the picker id rides after it. */
const RESUME_SUBMIT_NAME_PREFIX = 'dsh_feishu_resume_submit_'

/** One recognized card.action.trigger payload for our resume picker. */
export interface ParsedResumeAction {
  readonly pickerId: string
  readonly index: number
}

/**
 * Recognize OUR resume submit in a `card.action.trigger` payload; undefined
 * for anything else. Same fallback ladder as the ask card: button `value`
 * first, button `name` when an SDK strips values from form submits.
 */
export function parseResumeAction(data: unknown): ParsedResumeAction | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const action = (data as { action?: unknown }).action
  if (action === null || typeof action !== 'object') return undefined
  const formValue = (action as { form_value?: unknown }).form_value
  const value = formValue !== null && typeof formValue === 'object' && !Array.isArray(formValue)
    ? (formValue ?? {}) as Record<string, unknown>
    : {}
  const rawIndex = (value as { session?: unknown }).session
  const index = typeof rawIndex === 'number'
    ? rawIndex
    : typeof rawIndex === 'string' && /^\d+$/.test(rawIndex) ? Number.parseInt(rawIndex, 10) : Number.NaN
  const buttonValue = (action as { value?: unknown }).value
  if (buttonValue !== null && typeof buttonValue === 'object') {
    const marker = (buttonValue as { action?: unknown }).action
    const pickerId = (buttonValue as { picker_id?: unknown }).picker_id
    if (marker === RESUME_SUBMIT_ACTION && typeof pickerId === 'string' && pickerId !== '' && Number.isInteger(index)) {
      return { pickerId, index }
    }
    // A value carrying a DIFFERENT action means this is not our button —
    // the name fallback below must not fire on foreign submits.
    if (typeof marker === 'string') return undefined
  }
  const name = (action as { name?: unknown }).name
  if (typeof name === 'string' && name.startsWith(RESUME_SUBMIT_NAME_PREFIX)) {
    const pickerId = name.slice(RESUME_SUBMIT_NAME_PREFIX.length)
    if (pickerId !== '' && Number.isInteger(index)) return { pickerId, index }
  }
  return undefined
}

/**
 * Build the `/resume` session-picker card (schema 2.0): a native table element
 * (`tag: 'table'`, card JSON 2.0; Feishu client ≥7.20) with three narrow columns
 — `#` for the `/resume N` index, `会话` (`preview · dir`), `时间` — so the
 * list stays readable on a phone. The `时间` column shows each row's
 * last-update time: in mtime mode it IS the sort key (jsonl log mtime); in
 * fallback mode (no mtime map / map miss) it is an event-tail approximation
 * and may diverge from the row's actual sort key (`createdAt`). Rows arrive already truncated by
 * {@link buildResumeRows}; an empty list degrades to a plain markdown notice
 * instead of rendering an empty table.
 */
export function buildSessionListCard(rowsInput: readonly ResumeRow[], now = Date.now()): Schema2Card {
  return buildResumePickerCard(rowsInput, 'legacy', now)
}

/** Terminal card for the interactive resume picker: the chosen session (green). */
export function buildResumePickedCard(row: ResumeRow): Schema2Card {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '🚪 已进入会话' },
      subtitle: { tag: 'plain_text', content: `dsh · ${row.dir}` },
      template: 'green',
    },
    body: {
      elements: [{
        tag: 'markdown',
        content: `**#${row.index}** ${row.preview === '' ? row.sessionId.slice(0, 8) : row.preview}`,
      }],
    },
  }
}

/**
 * The `/resume` picker card (schema 2.0): the session table for browsing,
 * then a form — select one session and 🚪 submit (interactive path, needs
 * the console's card.action.trigger subscription), with the `/resume N`
 * text path spelled out right above it as the always-works fallback. Both
 * paths read the same pending picker.
 */
export function buildResumePickerCard(
  rowsInput: readonly ResumeRow[],
  pickerId: string,
  now = Date.now(),
): Schema2Card {
  // The rendered `#` column must agree with `pickResumeRow`'s positional
  // `/resume N` lookup (`rows[n - 1]`). Assert the 1-based contiguity contract
  // on the INPUT order (see {@link assertIndexContract}) — a violation is a
  // caller bug that would render a misleading picker, so fail loudly rather
  // than display numbers that pick another row. The defensive sort below only
  // normalizes; it no longer carries the contract.
  assertIndexContract(rowsInput)
  const rows = [...rowsInput].sort((a, b) => a.index - b.index)
  const elements: Array<Record<string, unknown>> = []
  if (rows.length === 0) {
    elements.push({ tag: 'markdown', content: '没有可恢复的会话。' })
    return { schema: '2.0', config: { width_mode: 'fill' }, body: { elements } }
  }
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
  elements.push({
    tag: 'markdown',
    content: '回复 **/resume N** 进入对应会话；或在下方选择后点 **🚪 进入**。',
  })
  elements.push({
    tag: 'form',
    name: 'dsh_feishu_resume_form',
    elements: [
      {
        tag: 'select_static',
        name: 'session',
        placeholder: { tag: 'plain_text', content: '选择要进入的会话…' },
        options: rows.map(row => ({
          text: {
            tag: 'plain_text',
            content: clipLine(`#${row.index} · ${sessionCell(row)} · ${formatWhen(row.lastTime ?? row.createdAt, now)}`, 48),
          },
          value: String(row.index),
        })),
      },
      {
        tag: 'button',
        name: `${RESUME_SUBMIT_NAME_PREFIX}${pickerId}`,
        // value MUST exist: value-less interactive components are rejected
        // client-side with 200340 and the callback is never delivered.
        value: { action: RESUME_SUBMIT_ACTION, picker_id: pickerId },
        text: { tag: 'plain_text', content: '🚪 进入' },
        type: 'primary',
        form_action_type: 'submit',
      },
    ],
  })
  return { schema: '2.0', config: { width_mode: 'fill' }, body: { elements } }
}
