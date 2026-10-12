/**
 * Plugin configuration: schema + validation + defaults. Sources, in ascending
 * priority: patch-file `config:` block, then `DSH_FEISHU_*` environment
 * variables. Secrets (app secret) are deliberately NOT accepted from the
 * static config schema except as an explicit escape hatch — prefer the dsh
 * credentials service or the env var; see README.
 */

import z from '@deepseek-ai/schemastery'

/** Plugin configuration as written in the patch-file `config:` block. */
export interface Config {
  /** `off` disables the plugin entirely (default `on`). */
  mode?: 'on' | 'off'
  /** Feishu tenant (default) or Lark. */
  domain?: 'feishu' | 'lark'
  /**
   * Operator open_id allowlist. REQUIRED to arm the bot — an empty list
   * leaves the bot inert (it connects to nothing and replies to nobody).
   */
  operators?: string[]
  /**
   * Plaintext app id (not secret). Preferred sources: credentials service ref
   * or DSH_FEISHU_APP_ID.
   */
  appId?: string
  /**
   * Plaintext app secret — escape hatch for local tests ONLY. Preferred
   * sources: credentials service ref or DSH_FEISHU_APP_SECRET.
   */
  appSecret?: string
  /** Credentials-service ref for the app id (default `DSH_FEISHU_APP_ID`). */
  appIdRef?: string
  /** Credentials-service ref for the app secret (default `DSH_FEISHU_APP_SECRET`). */
  appSecretRef?: string
  /** Status-card update beat in ms (default 5000 — pseudo-streaming; clamped to [5000, 600000]). */
  statusIntervalMs?: number
  /**
   * Minimum interval between mid-turn progress-card pushes in ms
   * (default 180000 = 3 min; clamped to [30000, 3600000]). Output produced
   * inside the window merges into the next push.
   */
  /** Long assistant bodies are segmented for Feishu at this size (default 3500). */
  bodySegmentChars?: number
  /**
   * `/resume` list rendering style (default `auto`): `auto` sends the native
   * table card first and falls back to a markdown ordered list when the send
   * fails; `table` / `list` force one renderer.
   */
  resumeListStyle?: 'auto' | 'table' | 'list'
  /**
   * Recent-conversation messages carried into a `/btw` side call
   * (default 6, clamped to [0, 50]; 0 = no snapshot). Parity with
   * dsh-tui-pi's DSH_TUI_BTW_CONTEXT_MESSAGES knob.
   */
  btwContextMessages?: number
  /**
   * Background completion push for sessions the phone is NOT bound to
   * (default `off` — the bot never messages unprompted unless told to):
   * `cron` pushes turns that carried a cron delivery or a subagent-settled
   * notice; `all` pushes every completed turn. Delivered to the last active
   * chat. Override: DSH_FEISHU_BACKGROUND_PUSH.
   */
  backgroundPush?: 'off' | 'cron' | 'all'
  /**
   * Quick-action buttons on the round cards (default `off`): `on` renders
   * ⛔ 停止 under the live card and ▶️ 继续 under the ended card. Off keeps
   * both buttons out — stopping still works via the `/stop` command (which
   * asks for a confirmation). Override: DSH_FEISHU_ROUND_BUTTONS.
   */
  roundButtons?: 'on' | 'off'
  /**
   * Surface tool arguments on the round card's activity section (default
   * `off`, which keeps today's output byte-for-byte). `brief` shows a
   * whitespace-folded, clipped single-line digest of the raw arguments JSON;
   * `full` keeps the multi-line shape, clipped at a larger budget.
   * Override: DSH_FEISHU_TOOL_DETAIL.
   */
  toolDetail?: 'off' | 'brief' | 'full'
  /**
   * Extra chats that see the SAME run cards as the active chat — one session,
   * several groups (default `[]` = single-chat behaviour, no change).
   *
   * The active chat stays `lastChatId` (the operator's most recent one) and is
   * the only one that drives the session; every run card addressed to it is
   * mirrored here, and each later patch lands on all of them. Per-chat
   * failures are logged and skipped, so a group the bot was removed from can
   * never break the primary card. Command replies, pairing cards and other
   * one-off messages are NOT mirrored — only the run card (status / round /
   * turn-end / detached), which is what "another window on the same session"
   * means. Override: DSH_FEISHU_MIRROR_CHAT_IDS (comma-separated).
   */
  mirrorChatIds?: string[]
}

/** Runtime schema for {@link Config} (cordis validates the patch config with it). */
export const Config = z.object({
  mode: z.union([z.const('on'), z.const('off')]).default('on'),
  domain: z.union([z.const('feishu'), z.const('lark')]).default('feishu'),
  operators: z.array(z.string()).default([]),
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  appIdRef: z.string().default('DSH_FEISHU_APP_ID'),
  appSecretRef: z.string().default('DSH_FEISHU_APP_SECRET'),
  statusIntervalMs: z.number().min(5000).max(600000).step(1).default(5000),
  bodySegmentChars: z.number().min(500).max(30000).step(1).default(3500),
  resumeListStyle: z.union([z.const('auto'), z.const('table'), z.const('list')]).default('auto'),
  btwContextMessages: z.number().min(0).max(50).step(1).default(6),
  backgroundPush: z.union([z.const('off'), z.const('cron'), z.const('all')]).default('off'),
  roundButtons: z.union([z.const('on'), z.const('off')]).default('off'),
  toolDetail: z.union([z.const('off'), z.const('brief'), z.const('full')]).default('off'),
  mirrorChatIds: z.array(z.string()).default([]),
}) as unknown as z<Config>

/** Fully resolved, immutable runtime configuration. */
export interface ResolvedConfig {
  readonly mode: 'on' | 'off'
  readonly domain: 'feishu' | 'lark'
  readonly operators: readonly string[]
  readonly appId: string | undefined
  readonly appSecret: string | undefined
  readonly appIdRef: string
  readonly appSecretRef: string
  readonly statusIntervalMs: number
  readonly bodySegmentChars: number
  readonly resumeListStyle: 'auto' | 'table' | 'list'
  readonly btwContextMessages: number
  readonly backgroundPush: 'off' | 'cron' | 'all'
  readonly roundButtons: 'on' | 'off'
  readonly toolDetail: 'off' | 'brief' | 'full'
  readonly mirrorChatIds: readonly string[]
}

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'mode', 'domain', 'operators', 'appId', 'appSecret', 'appIdRef', 'appSecretRef',
  'statusIntervalMs', 'bodySegmentChars', 'resumeListStyle', 'btwContextMessages',
  'backgroundPush', 'roundButtons', 'toolDetail', 'mirrorChatIds',
])

function envString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * Validate, default, and merge the static config with `DSH_FEISHU_*` env
 * overrides (`DSH_FEISHU_OPERATORS` is APPENDED to the config list; the rest
 * are first-wins). Throws on unknown keys (a typo'd patch config must not
 * silently disarm the bot).
 */
export function resolveConfig(config: Config | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-feishu: unknown config key "${key}"`)
    }
  }
  const domain = config?.domain === 'lark' ? 'lark' : 'feishu'
  const statusIntervalMs = config?.statusIntervalMs ?? 5000
  if (!Number.isSafeInteger(statusIntervalMs) || statusIntervalMs < 5000 || statusIntervalMs > 600000) {
    throw new Error('dsh-feishu: statusIntervalMs must be an integer in [5000, 600000]')
  }
  const bodySegmentChars = config?.bodySegmentChars ?? 3500
  if (!Number.isSafeInteger(bodySegmentChars) || bodySegmentChars < 500 || bodySegmentChars > 30000) {
    throw new Error('dsh-feishu: bodySegmentChars must be an integer in [500, 30000]')
  }
  const resumeListStyle = config?.resumeListStyle ?? 'auto'
  if (resumeListStyle !== 'auto' && resumeListStyle !== 'table' && resumeListStyle !== 'list') {
    throw new Error('dsh-feishu: resumeListStyle must be one of "auto", "table", "list"')
  }
  const btwConfigValue = config?.btwContextMessages
  if (btwConfigValue !== undefined && (!Number.isSafeInteger(btwConfigValue) || btwConfigValue < 0 || btwConfigValue > 50)) {
    throw new Error('dsh-feishu: btwContextMessages must be an integer in [0, 50]')
  }
  const envPush = envString(env, 'DSH_FEISHU_BACKGROUND_PUSH')
  const pushValue = config?.backgroundPush ?? (envPush === 'cron' || envPush === 'all' ? envPush : undefined)
  const backgroundPush = pushValue === 'cron' || pushValue === 'all' ? pushValue : 'off'
  const envRoundButtons = envString(env, 'DSH_FEISHU_ROUND_BUTTONS')
  const buttonsValue = config?.roundButtons ?? (envRoundButtons === 'on' || envRoundButtons === 'off' ? envRoundButtons : undefined)
  const roundButtons = buttonsValue === 'on' ? 'on' : 'off'
  const envToolDetail = envString(env, 'DSH_FEISHU_TOOL_DETAIL')
  const toolDetailValue = config?.toolDetail
    ?? (envToolDetail === 'off' || envToolDetail === 'brief' || envToolDetail === 'full' ? envToolDetail : undefined)
  if (toolDetailValue !== undefined && toolDetailValue !== 'off' && toolDetailValue !== 'brief' && toolDetailValue !== 'full') {
    throw new Error('dsh-feishu: toolDetail must be one of "off", "brief", "full"')
  }
  const toolDetail = toolDetailValue ?? 'off'
  // DSH_FEISHU_MIRROR_CHAT_IDS (comma-separated oc_ ids) EXTENDS the config
  // list, same rule as DSH_FEISHU_OPERATORS: trimmed, empties dropped, and the
  // active chat is filtered out at delivery time (never here — the active chat
  // moves).
  const envMirror = env.DSH_FEISHU_MIRROR_CHAT_IDS
  const envMirrorList = envMirror === undefined || envMirror.trim() === ''
    ? []
    : envMirror.split(',').map(id => id.trim()).filter(id => id !== '')
  const mirrorChatIds = Object.freeze([...(config?.mirrorChatIds ?? []).map(id => id.trim()).filter(id => id !== ''), ...envMirrorList])
  const configAppId = config?.appId?.trim()
  const configAppSecret = config?.appSecret?.trim()
  // DSH_FEISHU_OPERATORS (comma-separated open_ids) EXTENDS the config list —
  // the dormant-state warning has long promised this variable to users, so the
  // resolver must actually read it. Entries are trimmed; empties are dropped.
  const envOperators = env.DSH_FEISHU_OPERATORS
  const envOperatorList = envOperators === undefined || envOperators.trim() === ''
    ? []
    : envOperators.split(',').map(id => id.trim()).filter(id => id !== '')
  // Ref names must be valid environment-variable-style identifiers — the host
  // credentials service rejects anything else (dsh-credentials REF_PATTERN),
  // and a ref written under an invalid name bricks the NEXT dsh boot with a
  // parse error. The v0.13.0 defaults carried hyphens (`dsh-feishu-app-id`);
  // any configured ref outside the grammar is swapped for the legal default.
  const REF_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
  const appIdRef = config?.appIdRef !== undefined && REF_NAME.test(config.appIdRef)
    ? config.appIdRef
    : 'DSH_FEISHU_APP_ID'
  const appSecretRef = config?.appSecretRef !== undefined && REF_NAME.test(config.appSecretRef)
    ? config.appSecretRef
    : 'DSH_FEISHU_APP_SECRET'
  return Object.freeze({
    mode: config?.mode === 'off' ? 'off' : 'on',
    domain,
    operators: Object.freeze([...(config?.operators ?? []), ...envOperatorList]),
    appId: configAppId && configAppId !== '' ? configAppId : envString(env, 'DSH_FEISHU_APP_ID'),
    appSecret: configAppSecret && configAppSecret !== ''
      ? configAppSecret
      : envString(env, 'DSH_FEISHU_APP_SECRET'),
    appIdRef,
    appSecretRef,
    statusIntervalMs,
    bodySegmentChars,
    resumeListStyle,
    btwContextMessages: btwConfigValue ?? 6,
    backgroundPush,
    roundButtons,
    toolDetail,
    mirrorChatIds,
  })
}
