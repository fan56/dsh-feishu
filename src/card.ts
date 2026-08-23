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
import { reasoningTail, subagentRows } from './run-state.ts'
import { clipLine, formatDuration } from './text.ts'

/** Feishu legacy interactive card (structural — sent as JSON string). */
export interface InteractiveCard {
  config: { wide_screen_mode: boolean }
  header: {
    title: { tag: 'plain_text'; content: string }
    template: 'blue' | 'green' | 'red' | 'grey' | 'orange'
  }
  elements: Array<Record<string, unknown>>
}

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

/** The todo line (`☑ 3/5 · ◐ 当前任务`), hidden once all done (TUI semantics). */
export function todoLine(state: RunState): string | undefined {
  const todo = state.todo
  if (todo === undefined || todo.length === 0) return undefined
  const done = todo.filter(item => item.status === 'completed').length
  if (done === todo.length) return undefined
  const current = todo.find(item => item.status === 'in_progress')
  const icon = current === undefined ? '' : `${TODO_ICON['in_progress']} ${clipLine(current.content, 60)} · `
  return `${icon}☑ ${done}/${todo.length}`
}

/** Compact subagent rows (`├ workhorse · round 2 · tail…`). */
export function subagentLines(state: RunState): string[] {
  return subagentRows(state).slice(0, 5).map(row => {
    const mark = row.outcome === undefined
      ? '↻'
      : row.outcome === 'completed' ? '✔' : row.outcome === 'failed' ? '✘' : '⛔'
    const parts = [`├ ${row.label} ${mark} · round ${row.rounds}`]
    if (row.tail !== undefined) parts.push(clipLine(row.tail, 80))
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

/**
 * Build the whole card. The returned hash covers every rendered line so the
 * publisher can skip a patch when nothing visible changed.
 */
export function buildStatusCard(state: RunState, context: CardContext): { card: InteractiveCard; hash: string } {
  const { sessionLabel, displayThink, now } = context
  const running = state.running
  const template: InteractiveCard['header']['template'] = !running
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

  const card: InteractiveCard = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: headerTitle },
      template,
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: mdLines.join('\n') } },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: 'dsh-feishu · /help 查看命令' }],
      },
    ],
  }
  return { card, hash: JSON.stringify([template, headerTitle, mdLines]) }
}
