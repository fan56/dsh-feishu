/**
 * Inbound command classification — the pure routing table. Mirrors the design
 * doc §4 three-way split:
 *
 * - bot-owned mirrors: /resume (picker), /new (detach), /status, /help,
 *   /stop, /feishu-plugin, /sub, /model — implemented here, no host
 *   involvement; plus the interactive adapters (/think /permission
 *   /select-skill /profile-switch) that present a selection card through the
 *   selector FW and apply the pick over an existing channel;
 * - host passthrough: a whitelist of agent-addressed dsh commands forwarded
 *   through ctx.commands.execute — currently EMPTY as a standing table (the
 *   former entries are interactive on the desktop and are answered with the
 *   "use the desktop" notice via REJECTED_COMMANDS); the /permission adapter
 *   hands its explicit `/permission <name>` form here directly;
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
  | { kind: 'model' }
  | { kind: 'think' }
  | { kind: 'permission' }
  | { kind: 'select-skill' }
  | { kind: 'profile-switch' }
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
 * render yet (v1 answers "use the desktop"). /think and /select-skill have
 * since left this table (interactive adapters); the /skills PANEL itself
 * (dsh's skill browser) is still desktop-only.
 */
export const DEFERRED_COMMANDS: readonly string[] = [
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
    case 'model': return { kind: 'model' }
    case 'think': return { kind: 'think' }
    case 'permission':
      // Bare /permission opens the preset picker (TUI parity); the explicit
      // `/permission <name>` form rides the passthrough execution directly.
      return rest === undefined || rest.trim() === ''
        ? { kind: 'permission' }
        : { kind: 'passthrough', name, line: trimmed }
    case 'select-skill': return { kind: 'select-skill' }
    case 'profile-switch': return { kind: 'profile-switch' }
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
    '**dsh-feishu — 手机驾驶舱**',
    bound ? '当前已绑定会话，直接发消息即派活（排队注入当前 turn 之后）。' : '当前未绑定会话。',
    '',
    '**会话**',
    '· /resume — 列出最近 10 个可恢复会话，点卡片进入',
    '· /resume N — 直接进入列表第 N 个会话',
    '· /new — 解绑当前会话（回到未绑定态）',
    '· /status — 绑定与运行状态',
    '· /stop — 停止当前正在运行的 turn',
    '· /sub N — 查看第 N 个子代理近况',
    '',
    '**模型与权限**（弹出选择卡，点选后按场景生效）',
    '· /model — 选模型（provider → model 两步卡片）',
    '· /think — 选推理档位（按当前模型支持的 effort）',
    '· /permission — 切换权限 preset',
    '· /profile-switch — 切换模型 profile（电脑端 /profile-cfg 维护）',
    '',
    '**技能**',
    '· /select-skill — 列出可用技能，点选后激活到当前会话',
    '',
    '**本插件**',
    '· /feishu-plugin think on|off — 开关回复尾部的思考显示（默认开）',
    '· /help — 显示本说明',
    '',
    '其余以 / 开头的内容会作为 prompt 发给模型；',
    '/goal /dcp /agents /skills /settings /preset /theme 等暂未适配手机，请电脑端操作。',
  ]
  return lines.join('\n')
}
