/**
 * Inbound command classification — the pure routing table. Mirrors the design
 * doc §4 three-way split:
 *
 * - bot-owned mirrors: /resume (picker), /new (detach), /status, /help,
 *   /stop, /feishu-plugin, /sub — implemented here, no host involvement;
 * - host passthrough: a whitelist of agent-addressed dsh commands forwarded
 *   through ctx.commands.execute — currently EMPTY: the former entries
 *   (/goal /dcp /export /agents /subagents) are interactive on the desktop
 *   (panels/selectors) and have no phone UI yet; they live in
 *   UNADAPTED_COMMANDS and answer with a "use the desktop" notice.
 *   Re-enabling one is a one-line move back into PASSTHROUGH_COMMANDS;
 * - rejected: config-class + not-yet-adapted commands answered with
 *   "operate on the desktop".
 *
 * Anything else — including syntactically-valid but unregistered slash names —
 * falls through as a prompt, matching dsh's own "unknown command goes to the
 * model" behavior.
 */

/** What one inbound text becomes. */
export type Intent =
  | { kind: 'prompt'; text: string }
  | { kind: 'resume' }
  | { kind: 'resume-pick'; n: number }
  | { kind: 'new' }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'stop' }
  | { kind: 'sub'; n: number }
  | { kind: 'display'; target: 'think'; value: 'on' | 'off' }
  | { kind: 'passthrough'; name: string; line: string }
  | { kind: 'rejected'; name: string }

/**
 * dsh commands forwarded verbatim to the host registry (design §4 透传表).
 * Deliberately EMPTY for now: the former entries are interactive on the
 * desktop (panels/selectors with no phone UI) — see UNADAPTED_COMMANDS.
 * A command becomes passthrough-eligible only when it acts on the
 * agent/session and returns plain text.
 */
export const PASSTHROUGH_COMMANDS: readonly string[] = []

/**
 * Commands the bot refuses with a "use the desktop" pointer: config-class
 * commands (design §4 不做表) plus the former passthrough entries that turn
 * out to need a desktop UI. /session is NOT here: its mirror is /status.
 */
export const REJECTED_COMMANDS: readonly string[] = [
  'settings',
  'preset',
  'theme',
  'reload',
  'hotkeys',
  'model-sync',
  'goal',
  'dcp',
  'export',
  'agents',
  'subagents',
]

/**
 * Commands that exist but are deferred: selector semantics the phone cannot
 * render yet (v1 answers "use the desktop"; a later version may add
 * list+index flows).
 */
export const DEFERRED_COMMANDS: readonly string[] = [
  'model',
  'think',
  'skills',
]

/** The reply text for refused commands. */
export function refusedReply(name: string): string {
  return `「/${name}」需要在电脑端操作（手机端暂未适配）。`
}

/** dsh's command-name charset: [a-z][a-z0-9_-]*. */
const COMMAND_RE = /^\/([a-z][a-z0-9_-]*)(?:\s+(.*))?$/s

/** Parse `/resume 3`-style arguments; undefined when the arg is not a plain int. */
function parseIntArg(rest: string | undefined): number | undefined {
  if (rest === undefined) return undefined
  const value = Number.parseInt(rest.trim(), 10)
  return Number.isInteger(value) && value >= 1 && String(value) === rest.trim() ? value : undefined
}

/**
 * Classify one inbound text. Slash-prefixed lines that parse as command names
 * route by the tables above; everything else is a prompt (also the fallback
 * for unknown commands, matching dsh's fall-through).
 */
export function classifyInbound(text: string): Intent {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'prompt', text }
  if (!trimmed.startsWith('/')) return { kind: 'prompt', text: trimmed }

  const match = COMMAND_RE.exec(trimmed)
  if (match === null) {
    // Slash line that is not a bare command token (e.g. "/foo bar/baz") —
    // treat the whole line as a prompt like dsh does.
    return { kind: 'prompt', text: trimmed }
  }
  const name = match[1]!
  const rest = match[2]

  switch (name) {
    case 'resume': {
      const n = parseIntArg(rest)
      return n === undefined ? { kind: 'resume' } : { kind: 'resume-pick', n }
    }
    case 'new': return { kind: 'new' }
    case 'status':
      // /session is the TUI's info panel — the bot's mirror of it is /status.
    case 'session': return { kind: 'status' }
    case 'help': return { kind: 'help' }
    case 'stop': return { kind: 'stop' }
    case 'sub': {
      const n = parseIntArg(rest)
      return n === undefined ? { kind: 'prompt', text: trimmed } : { kind: 'sub', n }
    }
    case 'feishu-plugin': {
      // Named after the plugin itself: ownership of phone-side commands
      // must be self-evident (a bare /display read as a dsh/TUI command
      // caused real confusion in live use).
      const args = (rest ?? '').trim().split(/\s+/)
      if (args[0] === 'think' && (args[1] === 'on' || args[1] === 'off')) {
        return { kind: 'display', target: 'think', value: args[1] }
      }
      return { kind: 'prompt', text: trimmed }
    }
    default:
      if (PASSTHROUGH_COMMANDS.includes(name)) return { kind: 'passthrough', name, line: trimmed }
      if (REJECTED_COMMANDS.includes(name) || DEFERRED_COMMANDS.includes(name)) {
        return { kind: 'rejected', name }
      }
      // Unknown command token → prompt (dsh fall-through semantics).
      return { kind: 'prompt', text: trimmed }
  }
}

/** The /help text. */
export function helpText(bound: boolean): string {
  const lines = [
    'dsh-feishu — 手机驾驶舱',
    bound ? '当前已绑定会话，直接发消息即派活（排队注入当前 turn 之后）。' : '当前未绑定会话。',
    '',
    '命令：',
    '· /resume — 列出最近 10 个可恢复会话',
    '· /resume N — 进入列表中第 N 个会话',
    '· /new — 解绑当前会话（回到未绑定态）',
    '· /stop — 停止当前正在运行的 turn',
    '· /status — 绑定与运行状态',
    '· /sub N — 查看第 N 个子代理近况',
    '· /feishu-plugin think on|off — 开关思考尾行显示（默认开）',
    '· /goal /dcp /agents 等暂未适配手机（电脑端操作）',
    '· 其余以 / 开头的内容会作为 prompt 发给模型',
    '· /settings /preset /theme 等配置类命令请在电脑端操作',
  ]
  return lines.join('\n')
}
