/**
 * /feishu-onboard core — one-shot Feishu bot setup.
 *
 * Three pillars, all exported for the command wiring and tests:
 *
 * - `verifyCredentials` — raw-HTTP credential check (tenant token + bot info),
 *   deliberately NOT through the SDK client so error shapes stay decidable;
 * - `registerBotApp` — QR scan-to-create via the SDK's `registerApp` (device
 *   flow), pre-filling bot capability, long-connection events and preset
 *   scopes through `addons`; the platform may ignore addons behind a gradual
 *   rollout, which is NOT an error — `verifyCredentials` is the backstop;
 * - `runOnboard` — the interactive orchestration (ask seam in, report out).
 *
 * Security contract: the app secret never reaches `log()` nor report text,
 * with exactly one exception — when the credentials service is unavailable
 * the report must carry a manual-write YAML block (with a rotation warning),
 * because the user has no other way to persist what the scan just created.
 *
 * @module
 */

import { createRequire } from 'node:module'
import { registerApp as sdkRegisterApp } from '@larksuiteoapi/node-sdk'

// ------------------------------------------------------------------ presets --

/** Feishu (default) or Lark (international). */
export type Domain = 'feishu' | 'lark'

/** A plaintext app-id/app-secret pair. */
export interface CredentialsPair {
  appId: string
  appSecret: string
}

/**
 * Scopes pre-selected for the freshly created app (bot messaging + the read
 * side the plugin actually uses). Exported so tests and docs cannot drift
 * from what the QR link requests.
 */
export const ONBOARD_SCOPE_PRESET: readonly string[] = [
  'im:message:send_as_bot',
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:message.resources:readonly',
  'im:message.reactions:write',
  'im:chat:readonly',
]

/** Events pre-subscribed (long-connection mode). */
export const ONBOARD_EVENT_PRESET: readonly string[] = ['im.message.receive_v1']

/** Card callbacks pre-subscribed (ask-user cards ride on this). */
export const ONBOARD_CALLBACK_PRESET: readonly string[] = ['card.action.trigger']

/** Open-platform base URL per domain. */
const OPEN_BASE: Record<Domain, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
}

/**
 * Permission pre-select deep link: opens the open-platform auth page with the
 * preset scopes already ticked (`op_from=openapi` is what the platform's own
 * deep links carry).
 */
export function scopeGrantDeepLink(appId: string, domain: Domain): string {
  return `${OPEN_BASE[domain]}/app/${appId}/auth?q=${ONBOARD_SCOPE_PRESET.join(',')}&op_from=openapi`
}

// -------------------------------------------------------------- verification --

/** Outcome of one credential-verification pass. */
export type VerifyOutcome =
  | { readonly status: 'ok'; readonly botName: string | undefined; readonly botOpenId: string | undefined }
  /** Tenant-token endpoint answered a non-zero code (wrong id/secret). */
  | { readonly status: 'bad-credentials' }
  /** Credentials pair is valid but the app has no bot capability (code 11205). */
  | { readonly status: 'no-bot' }
  | { readonly status: 'network'; readonly detail: string }
  | { readonly status: 'other'; readonly code: number | undefined; readonly msg: string }

interface TokenBody {
  readonly code?: unknown
  readonly msg?: unknown
  readonly tenant_access_token?: unknown
}

interface BotInfoBody {
  readonly code?: unknown
  readonly msg?: unknown
  readonly bot?: {
    readonly app_name?: unknown
    readonly open_id?: unknown
    readonly activate_status?: unknown
  }
}

/**
 * Verify one credentials pair against the open platform. Uses raw fetch (not
 * the SDK client) so non-zero codes stay plain to classify. Transport-level
 * failures (reject, non-2xx, non-JSON) map to `network`; business non-zero
 * codes decide between `bad-credentials` (token step) and `other`.
 */
export async function verifyCredentials(
  creds: CredentialsPair,
  domain: Domain,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<VerifyOutcome> {
  const doFetch = deps.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const base = OPEN_BASE[domain]
  let tokenResponse: Response
  try {
    tokenResponse = await doFetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    })
  } catch (error) {
    return { status: 'network', detail: `tenant_access_token: ${describeError(error)}` }
  }
  if (!tokenResponse.ok) {
    return { status: 'network', detail: `tenant_access_token: HTTP ${tokenResponse.status}` }
  }
  let tokenBody: TokenBody
  try {
    tokenBody = await tokenResponse.json() as TokenBody
  } catch {
    return { status: 'network', detail: 'tenant_access_token: non-JSON response' }
  }
  if (typeof tokenBody.code !== 'number') {
    return { status: 'other', code: undefined, msg: 'tenant_access_token: malformed response' }
  }
  if (tokenBody.code !== 0) return { status: 'bad-credentials' }
  if (typeof tokenBody.tenant_access_token !== 'string' || tokenBody.tenant_access_token === '') {
    return { status: 'other', code: tokenBody.code, msg: 'tenant_access_token: empty token in body' }
  }
  let botResponse: Response
  try {
    botResponse = await doFetch(`${base}/open-apis/bot/v3/info`, {
      headers: { Authorization: `Bearer ${tokenBody.tenant_access_token}` },
    })
  } catch (error) {
    return { status: 'network', detail: `bot/v3/info: ${describeError(error)}` }
  }
  if (!botResponse.ok) {
    return { status: 'network', detail: `bot/v3/info: HTTP ${botResponse.status}` }
  }
  let botBody: BotInfoBody
  try {
    botBody = await botResponse.json() as BotInfoBody
  } catch {
    return { status: 'network', detail: 'bot/v3/info: non-JSON response' }
  }
  if (typeof botBody.code !== 'number') {
    return { status: 'other', code: undefined, msg: 'bot/v3/info: malformed response' }
  }
  if (botBody.code === 11205) return { status: 'no-bot' }
  if (botBody.code !== 0) {
    return { status: 'other', code: botBody.code, msg: typeof botBody.msg === 'string' ? botBody.msg : '' }
  }
  return {
    status: 'ok',
    botName: typeof botBody.bot?.app_name === 'string' ? botBody.bot.app_name : undefined,
    botOpenId: typeof botBody.bot?.open_id === 'string' ? botBody.bot.open_id : undefined,
  }
}

// ------------------------------------------------------------ scan-to-create --

export type RegisterOutcome =
  | { readonly status: 'ok'; readonly appId: string; readonly appSecret: string; readonly operatorOpenId: string | undefined }
  | { readonly status: 'aborted' }
  | { readonly status: 'failed'; readonly detail: string }

export interface RegisterDeps {
  readonly domain: Domain
  readonly signal?: AbortSignal
  /** QR/link presentation (terminal rendering). */
  readonly showQr?: (url: string, expireIn: number) => void
  /** Test seam; defaults to the SDK `registerApp`. */
  readonly registerAppImpl?: (options: unknown) => Promise<{
    client_id: string
    client_secret: string
    user_info?: { open_id?: string }
  }>
}

/**
 * Render the one-click-creation QR in the desktop terminal: ASCII QR plus the
 * plain URL (the command only ever runs on a desktop where the URL is a
 * usable fallback). The SDK itself prints nothing, so this callback owns the
 * entire presentation.
 */
export function printQrToTerminal(url: string, expireIn: number): void {
  console.log('\n请用「飞书」App（Lark 用户用 Lark App）扫码，并在手机上确认创建：')
  try {
    // qrcode-terminal is CJS-only and ships no type declarations; go through
    // require so the compiler never needs types for it.
    const require = createRequire(import.meta.url)
    const qr = require('qrcode-terminal') as { generate: (text: string, options?: { small?: boolean }) => void }
    qr.generate(url, { small: true })
  } catch {
    // QR rendering is best-effort — the plain URL below always works.
  }
  console.log(`\n二维码 ${expireIn} 秒内有效；无法扫码时可在手机浏览器打开同一链接：\n${url}\n`)
}

/**
 * The SDK rejects signal-aborts with a plain `{ code: 'abort', description }`
 * object (not an Error) — accept both shapes, plus a pre-aborted signal.
 */
function isAbortRejection(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (error instanceof Error && error.name === 'AbortError') return true
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'abort'
}

/**
 * Drive the SDK device-flow registration: shows the QR, polls until the user
 * confirms on the phone, and resolves with the created app credentials.
 * `createOnly` hides the "bind existing app" entry — updating someone's
 * existing app config behind their back is the scan branch's one forbidden
 * move (users with an app take the manual-input branch instead).
 */
export async function registerBotApp(deps: RegisterDeps): Promise<RegisterOutcome> {
  if (deps.signal?.aborted) return { status: 'aborted' }
  const showQr = deps.showQr ?? printQrToTerminal
  const impl = deps.registerAppImpl ?? (async options => sdkRegisterApp(options as Parameters<typeof sdkRegisterApp>[0]))
  const options = {
    // registerApp expects bare hostnames (baseUrl = `https://${domain}`) — the
    // values below are the SDK's own defaults for the two domains.
    domain: deps.domain === 'lark' ? 'accounts.larksuite.com' : 'accounts.feishu.cn',
    larkDomain: 'accounts.larksuite.com',
    signal: deps.signal,
    createOnly: true,
    appPreset: {
      name: 'dsh-feishu',
      desc: 'Drive dsh sessions from Feishu — dsh-feishu bot',
    },
    addons: {
      preset: true,
      scopes: { tenant: [...ONBOARD_SCOPE_PRESET] },
      events: { items: { tenant: [...ONBOARD_EVENT_PRESET] } },
      callbacks: { items: [...ONBOARD_CALLBACK_PRESET] },
    },
    onQRCodeReady: (info: { url: string; expireIn: number }): void => {
      showQr(info.url, info.expireIn)
    },
  }
  let result: { client_id: string; client_secret: string; user_info?: { open_id?: string } }
  try {
    result = await impl(options)
  } catch (error) {
    if (isAbortRejection(error, deps.signal)) return { status: 'aborted' }
    return { status: 'failed', detail: describeError(error) }
  }
  if (
    typeof result?.client_id !== 'string' || result.client_id === ''
    || typeof result.client_secret !== 'string' || result.client_secret === ''
  ) {
    return { status: 'failed', detail: '注册结果缺少 client_id / client_secret' }
  }
  return {
    status: 'ok',
    appId: result.client_id,
    appSecret: result.client_secret,
    operatorOpenId: result.user_info?.open_id,
  }
}

// ---------------------------------------------------------------- orchestration --

/** Structured ask seam (mirrors the host `ctx.userQuestions.ask` shape). */
export interface OnboardQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>
  readonly multiSelect?: boolean
}

export interface AskSeam {
  ask(request: {
    questions: OnboardQuestion[]
    signal?: AbortSignal
    /**
     * The calling agent (live runtime root). The host requires it for
     * agent-scoped dispatch — the ONLY path the web UI's answerer (which
     * registers per agent scope and receives forwarded scoped waterfalls)
     * actually sees; an agent-less request dies as NO_PROVIDER there.
     * Structural: mirrors `AskUserQuestionRequest.agent`.
     */
    agent?: unknown
  }): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>
}

/** Credentials service seam — the host handles file locking and chmod. */
export interface CredentialsWriteSeam {
  resolve(ref: string): Promise<{ value: string } | undefined>
  set?(ref: string, value: string): Promise<void>
}

/** Operator allowlist storage seam. */
export interface OnboardStoreSeam {
  getPairedOperators(): readonly string[]
  addPairedOperator(openId: string): Promise<void>
}

export type CredentialsSource = 'config' | 'env' | 'refs' | 'none'

export interface OnboardDeps {
  readonly domain: Domain
  /** Credentials resolved at command start (undefined when none). */
  readonly existingCredentials: CredentialsPair | undefined
  readonly credentialsSource: CredentialsSource
  /** Host ask service; undefined or throwing degrades to guide-only mode. */
  readonly ask: AskSeam | undefined
  /**
   * The invoking command's receiving agent (live runtime root), threaded into
   * every ask request. With it, asks ride the agent-scoped waterfall and the
   * web profile's browser answerer receives them (its bridge declines
   * agent-less requests). An ask that fails WITH the agent is retried once
   * without it — the fallback path global-only answerers (e.g. this plugin's
   * own phone cards) can still claim.
   */
  readonly agent?: unknown
  readonly credentials: CredentialsWriteSeam | undefined
  readonly store: OnboardStoreSeam | undefined
  readonly log: (level: 'info' | 'warn' | 'error', message: string) => void
  readonly signal?: AbortSignal
  /** Scan-branch: how long to wait for the launcher link (default 60s). */
  readonly scanUrlWaitMs?: number
  /** Scan-branch: grace after the confirm click before giving up (default 120s). */
  readonly scanConfirmGraceMs?: number
  // Test seams.
  readonly verifyImpl?: typeof verifyCredentials
  readonly registerImpl?: typeof registerBotApp
}

export interface OnboardReport {
  readonly ok: boolean
  /**
   * Multi-line markdown for the command result. NEVER contains the app
   * secret — the one exception is the missing-credentials-service fallback,
   * which must carry the YAML block plus a rotation warning.
   */
  readonly text: string
  readonly credentialsWritten: boolean
  readonly operatorsPaired: readonly string[]
  readonly appId: string | undefined
}

const APP_ID_REF = 'dsh-feishu-app-id'
const APP_SECRET_REF = 'dsh-feishu-app-secret'
const CREDENTIALS_FILE = '~/.dsh/.credentials.yaml'
const ACTIVATION_NOTE = '无需重启：正在尝试在本进程直接激活机器人…'
const GUIDE_UNAVAILABLE_PREFIX = '交互问询不可用，以下为手动指南。'

// Answer labels — kept as constants so question definitions and matching
// cannot drift apart.
const OPT_KEEP = '保持现状（退出）'
const OPT_RECONFIGURE = '重新配置'
const OPT_EXISTING_APP = '已有应用 — 我提供 App ID 和 Secret'
const OPT_SCAN = '没有 — 扫码一键创建（推荐）'
const OPT_GUIDE_ONLY = '只要手动申请指南'
const OPT_RETRY_INPUT = '重新输入'
const OPT_EXIT = '退出'
const OPT_SAVE_FIX = '保存并显示修复清单'
const OPT_INPUT_OPENID = '我知道我的 open_id（输入）'
const OPT_PAIR_LATER = '稍后配对：激活后私聊机器人点卡片 pairing（推荐）'
const OPT_SKIP = '跳过'

const NO_BOT_FIX_LIST = [
  '⚠️ 应用还没有开启「机器人」能力，激活前请修复：',
  '1. 开发者后台 → 应用能力 → 添加「机器人」；',
  '2. 「事件与回调」→ 订阅方式选择「长连接」；',
  '3. 改动后到「版本管理与发布」创建版本并发布，使其生效。',
].join('\n')

/** One ask round-trip, fully contained: no throw ever escapes. */
type AskOutcome =
  | { readonly kind: 'answer'; readonly label: string; readonly text: string }
  | { readonly kind: 'guide' }
  | { readonly kind: 'aborted' }

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; description?: unknown }
    if (typeof record.code === 'string' && typeof record.description === 'string') {
      return `${record.code}: ${record.description}`
    }
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

function summarizeOutcome(outcome: VerifyOutcome): string {
  switch (outcome.status) {
    case 'ok': return `ok (bot=${outcome.botName ?? 'unknown'})`
    case 'network': return `network: ${outcome.detail}`
    case 'other': return `code=${outcome.code ?? 'unknown'} ${outcome.msg}`
    default: return outcome.status
  }
}

/**
 * The manual 6-step application guide (also the guide-only fallback text).
 * User-visible copy is Chinese per repo convention.
 */
export function guideText(domain: Domain, prefix?: string): string {
  const base = OPEN_BASE[domain]
  const lines = [
    ...(prefix === undefined ? [] : [prefix, '']),
    '## 飞书机器人手动申请指南',
    '',
    `1. **创建应用**：打开 ${base}/app（开发者后台）→ 创建「企业自建应用」，名称建议 dsh-feishu。`,
    '2. **复制凭证**：在「凭证与基础信息」页复制 App ID（cli_ 开头）与 App Secret；随后重跑 /feishu-onboard 选「已有应用」即可一步写入。',
    '3. **添加机器人能力**：左侧「应用能力」→ 添加「机器人」。',
    `4. **开通权限**：「权限管理」开通以下 ${ONBOARD_SCOPE_PRESET.length} 项：${ONBOARD_SCOPE_PRESET.join('、')}。`,
    `   - 已知 App ID 时可用深链一键预选：${scopeGrantDeepLink('{AppID}', domain)}（浏览器打开并登录确认）；App ID 还未创建时先做第 1 步，再回来跑本命令。`,
    '5. **事件与回调**：「事件与回调」→ 订阅方式选择「长连接」；添加事件 `im.message.receive_v1`；「回调订阅」添加 `card.action.trigger`。',
    '6. **可用范围与发布**：「可用范围」设为仅自己（或按需全员）；「版本管理与发布」→ 创建版本并提交发布（不发布不生效）。',
    '',
    '完成后重跑 /feishu-onboard 选「已有应用」，即可一步写入凭据并激活。',
  ]
  return lines.join('\n')
}

/**
 * Run the /feishu-onboard orchestration. Never throws: every seam failure
 * degrades (ask → guide-only, store/credentials → notes in the report), and
 * the secret is confined to the one documented fallback.
 */
export async function runOnboard(deps: OnboardDeps): Promise<OnboardReport> {
  const { signal } = deps
  const log = (level: 'info' | 'warn' | 'error', message: string): void => {
    try {
      deps.log(level, message)
    } catch {
      // Logging must never break onboarding.
    }
  }
  const aborted = (): boolean => signal?.aborted === true
  const ABORTED: OnboardReport = {
    ok: false,
    text: '已取消：未做任何更改。',
    credentialsWritten: false,
    operatorsPaired: [],
    appId: undefined,
  }
  const guideReport = (prefix?: string): OnboardReport => ({
    ok: true,
    text: guideText(deps.domain, prefix),
    credentialsWritten: false,
    operatorsPaired: [],
    appId: undefined,
  })
  const askOne = async (question: OnboardQuestion): Promise<AskOutcome> => {
    if (deps.ask === undefined) return { kind: 'guide' }
    if (aborted()) return { kind: 'aborted' }
    // Agent-scoped first (the web answerer only sees scoped requests), then a
    // single agent-less retry for global-only answerer setups (validation
    // rejected the agent, or the surface registers at the root).
    const attempts: ReadonlyArray<{ agent?: unknown }> = deps.agent !== undefined
      ? [{ agent: deps.agent }, {}]
      : [{}]
    for (const attempt of attempts) {
      try {
        const result = await deps.ask.ask({ questions: [question], signal, ...attempt })
        if (aborted()) return { kind: 'aborted' }
        const answer = result.answers[0]
        if (answer === undefined) return { kind: 'guide' }
        const label = answer.selected[0] ?? ''
        // Free-text answers ride `custom`; option answers ride `selected`.
        const text = (answer.custom ?? '').trim() || label
        return { kind: 'answer', label, text }
      } catch {
        // NO_PROVIDER / CALLER_NOT_LIVE and friends — try the next shape,
        // then degrade to guide mode.
      }
    }
    return { kind: 'guide' }
  }
  const safeVerify = async (creds: CredentialsPair): Promise<VerifyOutcome> => {
    try {
      return await (deps.verifyImpl ?? verifyCredentials)(creds, deps.domain)
    } catch (error) {
      return { status: 'network', detail: describeError(error) }
    }
  }
  const writeCredentials = async (creds: CredentialsPair): Promise<{ written: boolean; fallbackNote?: string }> => {
    const set = deps.credentials?.set?.bind(deps.credentials)
    if (set === undefined) return { written: false, fallbackNote: fallbackYamlNote(creds) }
    try {
      // The secret value is never logged, never embedded in error text.
      await set(APP_ID_REF, creds.appId)
      await set(APP_SECRET_REF, creds.appSecret)
      return { written: true }
    } catch {
      log('error', 'dsh-feishu onboard: credentials.set failed; falling back to manual instructions')
      return { written: false, fallbackNote: fallbackYamlNote(creds) }
    }
  }

  const buildSummary = (input: {
    readonly appId: string
    readonly sourceNote: string
    readonly credentialsWritten: boolean
    readonly fallbackNote?: string
    readonly operators: readonly string[]
    readonly operatorsNote: string
    readonly noBot: boolean
    readonly extraLines: readonly string[]
    readonly envWarning: boolean
  }): string => {
    const lines: string[] = ['## ✅ 飞书机器人配置完成', '']
    lines.push(`- App ID：${input.appId}`)
    lines.push(input.credentialsWritten
      ? `- 凭据已写入凭据服务（refs ${APP_ID_REF} / ${APP_SECRET_REF}，来源：${input.sourceNote}）。`
      : '- 凭据未能自动写入，请按下面步骤手动落盘。')
    if (input.fallbackNote !== undefined) lines.push('', input.fallbackNote, '')
    if (input.operators.length > 0) {
      lines.push(`- 管理员白名单：已加入 ${input.operators.join('、')}（共 ${input.operators.length} 人）。`)
    } else if (input.operatorsNote !== '') {
      lines.push(`- 管理员白名单：${input.operatorsNote}`)
    } else {
      lines.push('- 管理员白名单：未改动。')
    }
    lines.push(
      `- ${ACTIVATION_NOTE}`,
      '- 激活后第一步：在飞书私聊机器人发送 /help。',
      '- 提醒：要让其他同事也能使用机器人，需到开放平台「版本管理与发布」创建版本并发布（仅自己使用则不需要）。',
    )
    if (input.envWarning) {
      lines.push('- ⚠️ 检测到 DSH_FEISHU_APP_ID / DSH_FEISHU_APP_SECRET 环境变量：其优先级高于凭据文件，不再使用时请清理，避免覆盖刚写入的凭据。')
    }
    if (input.noBot) lines.push('', NO_BOT_FIX_LIST)
    if (input.extraLines.length > 0) lines.push('', ...input.extraLines)
    return lines.join('\n')
  }

  /**
   * Branch: the user provides an existing app id/secret. Bounded re-ask
   * loops; the secret only ever lives in the local `creds` variable.
   */
  const runExistingAppBranch = async (): Promise<OnboardReport> => {
    let creds: CredentialsPair | undefined
    let noBot = false
    let round = 0
    while (creds === undefined) {
      if (round >= 3) {
        return {
          ok: false,
          text: '❌ 连续多次输入无效，已退出（未写入任何更改）。\n\n可重跑 /feishu-onboard 重试，或在入口选择「只要手动申请指南」。',
          credentialsWritten: false,
          operatorsPaired: [],
          appId: undefined,
        }
      }
      round++
      const idAnswer = await askOne({
        id: 'app-id',
        question: round === 1
          ? '请输入 App ID（开发者后台「凭证与基础信息」页复制，cli_ 开头）：'
          : 'App ID 需以 cli_ 开头，请重新输入：',
        header: 'App ID',
      })
      if (idAnswer.kind === 'guide') return guideReport(GUIDE_UNAVAILABLE_PREFIX)
      if (idAnswer.kind === 'aborted') return ABORTED
      const appId = idAnswer.text
      if (!appId.startsWith('cli_')) continue
      const secretAnswer = await askOne({
        id: 'app-secret',
        question: '请输入 App Secret（只写入本地凭据文件，不会出现在会话日志里）：',
        header: 'App Secret',
      })
      if (secretAnswer.kind === 'guide') return guideReport(GUIDE_UNAVAILABLE_PREFIX)
      if (secretAnswer.kind === 'aborted') return ABORTED
      const appSecret = secretAnswer.text
      if (appSecret === '') continue
      const outcome = await safeVerify({ appId, appSecret })
      if (aborted()) return ABORTED
      if (outcome.status === 'ok') {
        creds = { appId, appSecret }
        break
      }
      if (outcome.status === 'bad-credentials') {
        log('warn', `dsh-feishu onboard: credential verification failed (bad credentials) for ${appId}`)
        const retry = await askOne({
          id: 'retry-credentials',
          question: '凭据验证失败：App ID 或 Secret 不正确。重试还是退出？',
          header: '验证失败',
          options: [
            { label: OPT_RETRY_INPUT, description: '重新输入 App ID 和 Secret（最多再试 2 次）' },
            { label: OPT_EXIT, description: '退出，不写入任何更改' },
          ],
        })
        if (retry.kind === 'guide') return guideReport(GUIDE_UNAVAILABLE_PREFIX)
        if (retry.kind === 'aborted') return ABORTED
        if (retry.label === OPT_EXIT) return ABORTED
        continue
      }
      if (outcome.status === 'no-bot') {
        const save = await askOne({
          id: 'no-bot-save',
          question: '凭据有效，但该应用还没有开启「机器人」能力。仍保存凭据并显示修复清单吗？',
          header: '缺机器人能力',
          options: [
            { label: OPT_SAVE_FIX, description: '保存凭据；开放平台补开机器人能力后即可激活' },
            { label: OPT_EXIT, description: '退出，不写入任何更改' },
          ],
        })
        if (save.kind === 'guide') return guideReport(GUIDE_UNAVAILABLE_PREFIX)
        if (save.kind === 'aborted') return ABORTED
        if (save.label === OPT_EXIT) return ABORTED
        creds = { appId, appSecret }
        noBot = true
        break
      }
      // network / other — surface the error, write nothing.
      const detail = outcome.status === 'network'
        ? outcome.detail
        : `code=${outcome.code ?? '未知'} ${outcome.msg}`
      log('error', `dsh-feishu onboard: credential verification failed: ${summarizeOutcome(outcome)}`)
      return {
        ok: false,
        text: `❌ 凭据验证失败（${detail}），未写入任何更改。\n\n请检查网络或开放平台状态后重跑 /feishu-onboard。`,
        credentialsWritten: false,
        operatorsPaired: [],
        appId,
      }
    }
    if (aborted()) return ABORTED
    const write = await writeCredentials(creds)
    // Admin allowlist — skippable, never fatal.
    const operators: string[] = []
    let operatorsNote = ''
    if (deps.store === undefined) {
      operatorsNote = '存储服务不可用，未能写入管理员白名单：请把 open_id 手动加入 cordis.patch.yml 的 operators[]。'
    } else {
      if (aborted()) return ABORTED
      const admin = await askOne({
        id: 'admin-pairing',
        question: '把自己加入管理员白名单（operators）？',
        header: '管理员',
        options: [
          { label: OPT_INPUT_OPENID, description: '直接输入 open_id（ou_ 开头，开放平台「账号身份」或扫码返回可得）' },
          { label: OPT_PAIR_LATER, description: '激活后在飞书私聊机器人，点卡片上的 pairing 按钮完成配对' },
          { label: OPT_SKIP, description: '暂不配置白名单' },
        ],
      })
      if (admin.kind === 'aborted') return ABORTED
      if (admin.kind === 'guide') {
        operatorsNote = '交互问询不可用，未写入管理员白名单：请把 open_id 加入 cordis.patch.yml 的 operators[]。'
      } else if (admin.label === OPT_INPUT_OPENID) {
        let openId = ''
        for (let attempt = 0; attempt < 3 && openId === ''; attempt++) {
          if (aborted()) return ABORTED
          const input = await askOne({
            id: 'operator-open-id',
            question: attempt === 0 ? '请输入你的 open_id（ou_ 开头）：' : 'open_id 需以 ou_ 开头，请重新输入：',
            header: 'open_id',
          })
          if (input.kind === 'aborted') return ABORTED
          if (input.kind === 'guide') break
          if (input.text.startsWith('ou_')) openId = input.text
        }
        if (openId !== '') {
          try {
            await deps.store.addPairedOperator(openId)
            operators.push(openId)
          } catch {
            log('warn', 'dsh-feishu onboard: addPairedOperator failed')
            operatorsNote = '管理员白名单写入失败：请把 open_id 手动加入 operators[]。'
          }
        } else {
          operatorsNote = '未写入管理员白名单（未提供有效 open_id）：可激活后私聊机器人点卡片 pairing，或加入 operators[]。'
        }
      }
    }
    return {
      ok: true,
      text: buildSummary({
        appId: creds.appId,
        sourceNote: '手动输入的应用凭据',
        credentialsWritten: write.written,
        fallbackNote: write.fallbackNote,
        operators,
        operatorsNote,
        noBot,
        extraLines: [],
        envWarning: deps.credentialsSource === 'env',
      }),
      credentialsWritten: write.written,
      operatorsPaired: operators,
      appId: creds.appId,
    }
  }

  /** Branch: QR scan-to-create. */
  const runScanBranch = async (): Promise<OnboardReport> => {
    if (aborted()) return ABORTED
    log('info', 'dsh-feishu onboard: starting scan-to-create registration')
    // The launcher link MUST reach the operator through the ask card: on web
    // profiles the server console is invisible, and a QR printed to stdout
    // left the command looking stuck forever. The terminal keeps its rendered
    // QR (TTY surfaces), and the browser gets the same link as the question's
    // detail — open, confirm in Feishu, then tap "我已完成确认".
    let resolveUrl: ((url: string) => void) | undefined
    const urlPromise = new Promise<string>(resolve => { resolveUrl = resolve })
    const registration = (deps.registerImpl ?? registerBotApp)({
      domain: deps.domain,
      signal,
      showQr: (url, expireIn) => {
        printQrToTerminal(url, expireIn)
        resolveUrl?.(url)
      },
    })
    // Every give-up path below abandons this promise — keep rejections handled.
    registration.catch(() => {})
    const urlWaitMs = deps.scanUrlWaitMs ?? 60_000
    const confirmGraceMs = deps.scanConfirmGraceMs ?? 120_000
    const delayRace = (ms: number): Promise<{ kind: 'timeout' }> =>
      new Promise(resolve => { const timer = setTimeout(() => resolve({ kind: 'timeout' }), ms); (timer as { unref?: () => void }).unref?.() })

    const arrived = await Promise.race([
      urlPromise.then(value => ({ kind: 'url' as const, value })),
      registration.then(value => ({ kind: 'registration' as const, value })),
      delayRace(urlWaitMs),
    ])
    if (aborted()) return ABORTED
    if (arrived.kind === 'timeout') {
      log('error', `dsh-feishu onboard: no launcher link within ${urlWaitMs}ms`)
      return {
        ok: false,
        text: '❌ 创建会话未能建立（等待创建链接超时，可能是网络问题）。请重跑 /feishu-onboard 重试。',
        credentialsWritten: false,
        operatorsPaired: [],
        appId: undefined,
      }
    }
    if (arrived.kind === 'registration') return settleScan(await registration)

    const answer = await askOne({
      id: 'scan-confirm',
      header: '扫码创建',
      question: '请打开下面的链接完成应用创建确认（飞书 App 扫码，或手机/电脑浏览器打开后登录确认）；完成后点「我已完成确认」：',
      detail: arrived.value,
      options: [{ label: '我已完成确认' }],
    })
    if (answer.kind === 'aborted') return ABORTED
    if (answer.kind === 'guide') {
      // The card never landed — continuing would risk an orphan app (created
      // on Feishu but its credentials never captured). Stop and tell the user.
      return {
        ok: false,
        text: [
          '❓ 确认问询卡未能送达，已中止扫码流程（未创建任何应用）。',
          '请重跑 /feishu-onboard 重试；或选择「只要手动申请指南」。',
        ].join('\n'),
        credentialsWritten: false,
        operatorsPaired: [],
        appId: undefined,
      }
    }
    const observed = await Promise.race([
      registration.then(value => ({ kind: 'registration' as const, value })),
      delayRace(confirmGraceMs),
    ])
    if (aborted()) return ABORTED
    if (observed.kind === 'timeout') {
      return {
        ok: false,
        text: [
          '❌ 已点击确认，但未检测到创建完成：',
          '- 若飞书里还没确认：请完成确认后重跑 /feishu-onboard（选「已有应用」或重新扫码）；',
          '- 若已确认但本命令拿不到结果：多半是创建页超时，请重跑并重新扫码。',
        ].join('\n'),
        credentialsWritten: false,
        operatorsPaired: [],
        appId: undefined,
      }
    }
    return settleScan(observed.value)
  }

  /** Common tail of the scan branch: turn a settled registration into a report. */
  const settleScan = async (registrationOutcome: Awaited<ReturnType<typeof registerBotApp>>): Promise<OnboardReport> => {
    const registration = registrationOutcome
    if (registration.status === 'aborted') return ABORTED
    if (registration.status === 'failed') {
      log('error', `dsh-feishu onboard: registration failed: ${registration.detail}`)
      return {
        ok: false,
        text: [
          `❌ 扫码创建失败：${registration.detail}`,
          '',
          '可重跑 /feishu-onboard 重试；或在入口选择「只要手动申请指南」，按步骤自己创建应用。',
        ].join('\n'),
        credentialsWritten: false,
        operatorsPaired: [],
        appId: undefined,
      }
    }
    if (aborted()) return ABORTED
    const creds: CredentialsPair = { appId: registration.appId, appSecret: registration.appSecret }
    const write = await writeCredentials(creds)
    const operators: string[] = []
    let operatorsNote = ''
    if (registration.operatorOpenId !== undefined && registration.operatorOpenId !== '') {
      if (deps.store !== undefined) {
        try {
          await deps.store.addPairedOperator(registration.operatorOpenId)
          operators.push(registration.operatorOpenId)
          operatorsNote = `已把扫码用户设为管理员（${registration.operatorOpenId}）。`
        } catch {
          log('warn', 'dsh-feishu onboard: addPairedOperator failed')
          operatorsNote = '扫码用户白名单写入失败，请手动加入 operators[]。'
        }
      } else {
        operatorsNote = `扫码用户 open_id 为 ${registration.operatorOpenId}（存储不可用，请手动加入 operators[]）。`
      }
    } else {
      operatorsNote = '未获取到扫码用户 open_id：可激活后私聊机器人点卡片 pairing。'
    }
    // Backstop verification — addons may be ignored behind a platform rollout,
    // so state the real bot status in the summary instead of assuming.
    const outcome = await safeVerify(creds)
    let noBot = false
    let verifyLine: string
    switch (outcome.status) {
      case 'ok':
        verifyLine = `✅ 新应用验证通过：机器人「${outcome.botName ?? '未知名称'}」。`
        break
      case 'no-bot':
        noBot = true
        verifyLine = '⚠️ 新应用还没开启「机器人」能力：'
        break
      case 'bad-credentials':
        verifyLine = '⚠️ 新凭据验证失败（可能是平台同步延迟），稍后私聊机器人发 /help 再确认。'
        break
      case 'network':
        verifyLine = `⚠️ 验证因网络原因未完成（${outcome.detail}），不影响凭据写入与激活。`
        break
      case 'other':
        verifyLine = `⚠️ 验证返回未知结果（code=${outcome.code ?? '未知'} ${outcome.msg}）。`
        break
    }
    return {
      ok: true,
      text: buildSummary({
        appId: creds.appId,
        sourceNote: '扫码一键创建',
        credentialsWritten: write.written,
        fallbackNote: write.fallbackNote,
        operators,
        operatorsNote,
        noBot,
        extraLines: [verifyLine],
        envWarning: deps.credentialsSource === 'env',
      }),
      credentialsWritten: write.written,
      operatorsPaired: operators,
      appId: creds.appId,
    }
  }

  const run = async (): Promise<OnboardReport> => {
    if (aborted()) return ABORTED

    // Step 1 — existing credentials: verify first, short-circuit when healthy.
    if (deps.existingCredentials !== undefined) {
      const outcome = await safeVerify(deps.existingCredentials)
      if (aborted()) return ABORTED
      if (outcome.status === 'ok') {
        log('info', 'dsh-feishu onboard: existing credentials verified OK')
        const reconfirm = await askOne({
          id: 'reconfigure',
          question: `当前凭据验证可用（机器人：${outcome.botName ?? '未知名称'}）。要重新配置吗？`,
          header: '已配置',
          options: [
            { label: OPT_KEEP, description: '什么都不改，直接结束' },
            { label: OPT_RECONFIGURE, description: '重新走配置流程（会覆盖现有凭据）' },
          ],
        })
        if (reconfirm.kind === 'aborted') return ABORTED
        if (reconfirm.kind === 'guide') return guideReport(GUIDE_UNAVAILABLE_PREFIX)
        if (reconfirm.label !== OPT_RECONFIGURE) {
          // Fail-safe: only an explicit "reconfigure" proceeds to overwriting.
          return {
            ok: true,
            text: [
              '## ✅ 保持现状：现有凭据验证可用，未做任何更改',
              '',
              `- App ID：${deps.existingCredentials.appId}`,
              `- 机器人：${outcome.botName ?? '未知名称'}`,
              `- ${ACTIVATION_NOTE}`,
              '- 激活后第一步：在飞书私聊机器人发送 /help。',
              '- 提醒：要让其他同事也能使用机器人，需到开放平台「版本管理与发布」创建版本并发布（仅自己使用则不需要）。',
              ...(deps.credentialsSource === 'env'
                ? ['- ⚠️ 检测到 DSH_FEISHU_APP_ID / DSH_FEISHU_APP_SECRET 环境变量：其优先级高于凭据文件，不再使用时请清理。']
                : []),
            ].join('\n'),
            credentialsWritten: false,
            operatorsPaired: [],
            appId: deps.existingCredentials.appId,
          }
        }
      } else {
        log('warn', `dsh-feishu onboard: existing credentials check: ${summarizeOutcome(outcome)}`)
      }
    }

    // Step 2 — main path.
    const main = await askOne({
      id: 'main-path',
      question: '你有现成的飞书自建应用（机器人）吗？',
      header: '配置方式',
      options: [
        { label: OPT_EXISTING_APP, description: 'Secret 只写入本地凭据文件（凭据服务加锁落盘），不会进入会话日志' },
        { label: OPT_SCAN, description: '终端出二维码，用飞书 App 扫码确认后自动创建：自带机器人能力、长连接事件与预置权限' },
        { label: OPT_GUIDE_ONLY, description: '输出完整的开放平台申请步骤，自己操作' },
      ],
    })
    if (main.kind === 'aborted') return ABORTED
    if (main.kind === 'guide') return guideReport(GUIDE_UNAVAILABLE_PREFIX)
    if (main.label === OPT_SCAN) return runScanBranch()
    if (main.label === OPT_EXISTING_APP) return runExistingAppBranch()
    // The explicit guide option — and, fail-safe, any unrecognized answer.
    return guideReport(undefined)
  }

  try {
    return await run()
  } catch {
    // Last-resort guard: onboarding must never crash the command loop —
    // degrade to the manual guide.
    return guideReport(GUIDE_UNAVAILABLE_PREFIX)
  }
}

/** Fallback body when the credentials service cannot write: real YAML lines. */
function fallbackYamlNote(creds: CredentialsPair): string {
  return [
    `凭据服务不可用，请手动把以下两行写入 ${CREDENTIALS_FILE}：`,
    '',
    '```yaml',
    `${APP_ID_REF}: ${creds.appId}`,
    `${APP_SECRET_REF}: ${creds.appSecret}`,
    '```',
    '',
    '⚠️ Secret 已出现在命令输出中，建议配置完成后到开放平台重置 App Secret（轮换）。',
  ].join('\n')
}
