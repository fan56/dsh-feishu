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
  /** Credentials-service ref for the app id (default `dsh-feishu-app-id`). */
  appIdRef?: string
  /** Credentials-service ref for the app secret (default `dsh-feishu-app-secret`). */
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
}

/** Runtime schema for {@link Config} (cordis validates the patch config with it). */
export const Config = z.object({
  mode: z.union([z.const('on'), z.const('off')]).default('on'),
  domain: z.union([z.const('feishu'), z.const('lark')]).default('feishu'),
  operators: z.array(z.string()).default([]),
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  appIdRef: z.string().default('dsh-feishu-app-id'),
  appSecretRef: z.string().default('dsh-feishu-app-secret'),
  statusIntervalMs: z.number().min(5000).max(600000).step(1).default(5000),
  bodySegmentChars: z.number().min(500).max(30000).step(1).default(3500),
  resumeListStyle: z.union([z.const('auto'), z.const('table'), z.const('list')]).default('auto'),
  btwContextMessages: z.number().min(0).max(50).step(1).default(6),
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
}

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'mode', 'domain', 'operators', 'appId', 'appSecret', 'appIdRef', 'appSecretRef',
  'statusIntervalMs', 'bodySegmentChars', 'resumeListStyle', 'btwContextMessages',
])

function envString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * Validate, default, and merge the static config with `DSH_FEISHU_*` env
 * overrides. Throws on unknown keys (a typo'd patch config must not silently
 * disarm the bot).
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
  const configAppId = config?.appId?.trim()
  const configAppSecret = config?.appSecret?.trim()
  return Object.freeze({
    mode: config?.mode === 'off' ? 'off' : 'on',
    domain,
    operators: Object.freeze([...(config?.operators ?? [])]),
    appId: configAppId && configAppId !== '' ? configAppId : envString(env, 'DSH_FEISHU_APP_ID'),
    appSecret: configAppSecret && configAppSecret !== ''
      ? configAppSecret
      : envString(env, 'DSH_FEISHU_APP_SECRET'),
    appIdRef: config?.appIdRef ?? 'dsh-feishu-app-id',
    appSecretRef: config?.appSecretRef ?? 'dsh-feishu-app-secret',
    statusIntervalMs,
    bodySegmentChars,
    resumeListStyle,
    btwContextMessages: btwConfigValue ?? 6,
  })
}
