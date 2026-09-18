/**
 * dsh-feishu — drive an existing dsh session from Feishu/Lark.
 *
 * A companion cordis plugin (independent package + own bundle patch): it
 * holds the ONLY outbound Lark WebSocket, attaches to EXISTING sessions via
 * the /resume picker (it never calls agents.create), and renders one status
 * card per turn (in-place updates on a 30s beat, assistant body on turn/end).
 * Designed to coexist with dsh-tui-pi in the same profile — it never touches
 * the terminal — and to work without it.
 *
 * Startup is SILENT by design: the bot connects and listens, but sends
 * nothing until the operator writes first.
 *
 * @module @aiwayds/dsh-feishu
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
// Types only (erased at emit). The runtime import is deliberately avoided:
// the registry-published dsh-skill lib imports host-closure siblings
// (@deepseek-ai/dsh-scope, dsh-llm — peers of it, but absent from a plugin
// repo's own dependency graph), which dies under pnpm's isolated layout.
// The host injects the real service at runtime; these types only shape the
// provider object this plugin hands it.
import type { SkillCandidate, SkillDefinition, SkillProvider } from '@deepseek-ai/dsh-skill'

/** Mirrors dsh-skill's bundled-skill rank (a non-load-bearing ordering hint;
 *  the constant is hardcoded there too). Local copy — see the type-import
 *  note above for why dsh-skill is not loaded at runtime here. */
const BUNDLED_SKILL_RANK = 600
import { buildAllowlist } from './allowlist.ts'
import { FeishuBot } from './bot.ts'
import { SessionBinder } from './binder.ts'
import { Config, resolveConfig, type ResolvedConfig } from './config.ts'
import { LarkClient } from './lark-client.ts'
import { runOnboard, type AskSeam, type CredentialsSource } from './onboard.ts'
import { StateStore } from './state-store.ts'

export const name = 'dsh-feishu'

/** Seams consumed: the agent service that drives sessions, plus the skill
 *  registry that serves the bundled usage/config guide. */
export const inject = ['agents', 'skills']

export { Config, resolveConfig }
export type { ResolvedConfig }
export { FeishuBot, SessionBinder, StateStore, LarkClient, buildAllowlist, releaseLock }

// ------------------------------------------------------------ single instance --

/** Lock file path: one bot instance per machine (cluster mode has no broadcast). */
export function lockFilePath(): string {
  return join(tmpdir(), 'dsh-feishu-bot.lock')
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Acquire the single-instance lock (returns the open fd, or undefined when
 * another live instance holds it). A stale lock (dead pid) is stolen; a live
 * one means another dsh process runs this bot — this instance stays dormant,
 * because Lark's long-connection mode would otherwise randomly split events
 * between the two clients.
 */
export function acquireLock(path = lockFilePath()): number | undefined {
  const create = (): number => {
    const fd = openSync(path, 'wx', 0o644)
    try {
      writeSync(fd, `${process.pid}\n`)
    } catch {
      // The lock still works as an exclusive marker without the pid body.
    }
    return fd
  }
  try {
    return create()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
  }
  // Existing lock: steal it only when its pid is dead.
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) return undefined
    unlinkSync(path)
    return create()
  } catch {
    return undefined
  }
}

function releaseLock(fd: number | undefined, path = lockFilePath()): void {
  if (fd === undefined) return
  try { closeSync(fd) } catch { /* contained */ }
  try { unlinkSync(path) } catch { /* contained */ }
}

// -------------------------------------------------------------- credentials --

/** The credentials-service surface used (structural, optional at runtime). */
interface CredentialsSeam {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/**
 * Obtain the (optional) credentials service, waiting bounded time for it to
 * activate: at plugin-apply time the service may not be started yet, and a
 * plain `ctx.get` would wrongly conclude "no credentials" and disarm the bot.
 */
function activeCredentials(ctx: Context, timeoutMs = 5000): Promise<CredentialsSeam | undefined> {
  const immediate = ctx.get('credentials') as CredentialsSeam | undefined
  if (immediate !== undefined) return Promise.resolve(immediate)
  return new Promise(resolve => {
    let settled = false
    const finish = (value: CredentialsSeam | undefined) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    try {
      ctx.inject(['credentials'], ictx => {
        finish((ictx as Context & { credentials: CredentialsSeam }).credentials)
        return () => { /* service gone — later resolves fail closed */ }
      })
    } catch {
      finish(undefined)
    }
    setTimeout(() => finish(undefined), timeoutMs).unref?.()
  })
}

/**
 * Resolve the Lark app credentials. Priority: static config/env (already
 * merged into the resolved config) → dsh credentials service refs. Returns
 * undefined when nothing supplies a complete pair — the plugin stays dormant
 * rather than retrying a connection that cannot authenticate.
 */
export async function resolveAppCredentials(
  ctx: Context,
  config: ResolvedConfig,
): Promise<{ appId: string; appSecret: string } | undefined> {
  if (config.appId !== undefined && config.appSecret !== undefined) {
    return { appId: config.appId, appSecret: config.appSecret }
  }
  const credentials = await activeCredentials(ctx)
  if (credentials === undefined) return undefined
  try {
    const [id, secret] = await Promise.all([
      config.appId === undefined ? credentials.resolve(config.appIdRef) : undefined,
      config.appSecret === undefined ? credentials.resolve(config.appSecretRef) : undefined,
    ])
    const appId = config.appId ?? id?.value
    const appSecret = config.appSecret ?? secret?.value
    if (appId === undefined || appId === '' || appSecret === undefined || appSecret === '') return undefined
    return { appId, appSecret }
  } catch {
    return undefined
  }
}

// ----------------------------------------------------------- bundled skill --

/** Provider name under `ctx.skills`; doubles as the skill name. */
const SKILL_PROVIDER_NAME = 'dsh-feishu-config'

/** Packaged skill body; `../skills/` resolves to the package root from both lib/ and src/. */
const SKILL_BODY_URL = new URL('../skills/dsh-feishu-config/SKILL.md', import.meta.url)

/** Resource base served with the skill so its relative links resolve. */
const SKILL_RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../skills/dsh-feishu-config/', import.meta.url)),
} as const

const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true } as const

/** Routing description; must stay identical to the SKILL.md frontmatter (asserted in tests). */
const SKILL_DESCRIPTION = 'dsh 飞书机器人插件（@aiwayds/dsh-feishu）使用与配置指南。凡涉及飞书/Lark 接入、机器人申请/创建、手机端控制 dsh、卡片交互、后台推送，或要配置 feishu 时先读本指南：首次配置优先引导桌面 TUI 运行 /feishu-onboard（扫码一键创建应用并自动写入凭据与 operators）；手动路径见指南：cordis.patch.yml 挂载块 config: 段 12 键（mode/domain/operators/appId/appSecret/凭据 refs/statusIntervalMs/bodySegmentChars/resumeListStyle/btwContextMessages/backgroundPush）、DSH_FEISHU_* 环境变量、ask_user_question 配置向导、operators 空=配对模式（首个私聊者点卡成为管理员）、settings.yaml dsh-feishu: 段是运行态非配置。触发词：飞书、feishu、lark、机器人、operators、配对、绑定、backgroundPush。'

const SKILL_CANDIDATE: SkillCandidate = {
  name: SKILL_PROVIDER_NAME,
  description: SKILL_DESCRIPTION,
  invocation: SKILL_INVOCATION,
  provider: SKILL_PROVIDER_NAME,
  source: 'bundled',
  resourceBase: SKILL_RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const skillProvider: SkillProvider = {
  name: SKILL_PROVIDER_NAME,
  list: () => Promise.resolve([SKILL_CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: SKILL_CANDIDATE.name,
      description: SKILL_CANDIDATE.description,
      invocation: SKILL_CANDIDATE.invocation,
      provider: SKILL_CANDIDATE.provider,
      source: SKILL_CANDIDATE.source,
      resourceBase: SKILL_RESOURCE_BASE,
      content: stripFrontmatter(await readFile(SKILL_BODY_URL, 'utf8')),
    }
  },
}

/**
 * Strip a leading YAML frontmatter block (`---` / body / `---`) from a skill
 * markdown file. `SkillDefinition.content` must be the instruction body after
 * metadata removal — the same shape the filesystem provider serves — so the
 * bundled SKILL.md, which keeps its frontmatter for the GitHub/manual install
 * paths, has the block removed when served through {@link skillProvider.get}.
 * Tolerant by design: input that does not open with a `---` line, or whose
 * frontmatter block is never closed, is returned unchanged. Mirrors the
 * delimiter semantics of the upstream skill-filesystem provider.
 */
export function stripFrontmatter(raw: string): string {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return raw
  let lineStart = firstLineEnd + 1
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1).trim()
    }
    if (nextNewline < 0) return raw
    lineStart = nextNewline + 1
  }
  return raw
}

// ------------------------------------------------------------------- apply --

/** Structural shape of the host's command invocation (dsh-commands). */
interface CommandInvocationLike {
  readonly rawInput: string
  readonly signal: AbortSignal
  /**
   * The exact receiving agent (live runtime root) the host executes this
   * command against. Carried into the ask requests so they dispatch on the
   * AGENT-scoped waterfall — the only surface the web bridge forwards to the
   * browser (a plain agent-less ask is declined by the bridge and dies as
   * NO_PROVIDER, since the web answerer registers per agent scope). Optional:
   * host invocations always supply it, test mocks may not.
   */
  readonly agent?: unknown
}

/** dsh-commands CommandResult (structural). */
type CommandResultLike =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** Structural registration surface of the host's commands service. */
interface CommandsSeam {
  register(definition: {
    readonly name: string
    readonly description: string
    readonly handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
  }): () => void
}

/**
 * The host's structured ask service (dsh-user-questions), passed to onboard
 * only when it really exposes `.ask` — anything else degrades the command to
 * its guide-only mode. Never throws: a mock/partial ctx just yields undefined.
 */
function askSeamOf(ctx: Context): AskSeam | undefined {
  try {
    const service = ctx.get('userQuestions') as { ask?: unknown } | undefined
    if (service !== null && typeof service === 'object' && typeof service.ask === 'function') {
      return service as unknown as AskSeam
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Outcome of one arm attempt; `detail` is a one-sentence failure reason. */
interface ArmOutcome {
  readonly armed: boolean
  readonly detail: string
}

/** Clip a raw error message into a one-line reason for user-facing text. */
function oneLineReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
}

export function apply(ctx: Context, config: Config = {}): void {
  // `inject = ['skills']` guarantees the service exists on every real host;
  // register unconditionally (before the dormant early-returns below) so a
  // missing service fails loud instead of silently dropping the bundled
  // guide — which matters most exactly when the bot is not configured yet.
  ctx.skills.registerProvider(() => skillProvider)
  let policy: ResolvedConfig
  try {
    policy = resolveConfig(config)
  } catch (error) {
    ctx.logger.error('dsh-feishu: invalid config — plugin disabled: %o', error)
    return
  }

  // Constructed BEFORE every early-return: pairing claims and the onboard
  // command persist through it even while the bot never arms (construction
  // itself degrades safely to memory when no settings service exists).
  const store = new StateStore(ctx)

  // Arm lifecycle shared by startup and the onboard hot-activation.
  let bot: FeishuBot | undefined
  let tornDown = false
  let lockFd: number | undefined
  let armed = false
  let arming: Promise<ArmOutcome> | undefined

  const releaseArmLock = (): void => {
    releaseLock(lockFd)
    lockFd = undefined
  }

  /** The effective admin list: config/env operators ∪ persisted pairing admins. */
  const effectiveOperators = (): ReadonlySet<string> => {
    const ids = new Set<string>(buildAllowlist(policy.operators))
    for (const id of store.getPairedOperators()) {
      const value = id.trim()
      if (value !== '') ids.add(value)
    }
    return ids
  }

  /**
   * Connect the bot (single instance, credentials resolved, pairing mode when
   * the admin list is empty). Single-flight: an in-flight attempt is joined
   * and a settled SUCCESS short-circuits — the WS must never connect twice
   * and the lock must never be raced by our own fiber. A FAILED attempt is
   * retryable (its slot clears on settle): the dormant startup must not
   * poison a later /feishu-onboard hot-activation, whose whole point is that
   * the blockers it just removed (credentials, admins) are re-checked fresh.
   * Returns a one-sentence reason on failure so the onboard flow can tell
   * the operator what happened.
   */
  const tryArm = (): Promise<ArmOutcome> => {
    if (armed) return Promise.resolve({ armed: true, detail: 'already armed' })
    if (arming !== undefined) return arming
    const attempt = (async (): Promise<ArmOutcome> => {
      // Bounded — makes the persisted pairing admins visible before the
      // effective-operator reads below.
      await store.ready()
      const fd = acquireLock()
      if (fd === undefined) {
        ctx.logger.warn('dsh-feishu: another instance holds the bot lock — this fiber stays dormant')
        return { armed: false, detail: '另一实例持有机器人锁' }
      }
      lockFd = fd
      let instance: FeishuBot | undefined
      try {
        const creds = await resolveAppCredentials(ctx, policy)
        // Teardown may land while credentials resolve (the seam wait is bounded,
        // not instant): arming after disposal would open a WS nothing will ever
        // close and re-create the lock file the effect already released.
        if (tornDown) {
          releaseArmLock()
          return { armed: false, detail: '插件正在卸载' }
        }
        if (creds === undefined) {
          releaseArmLock()
          if (effectiveOperators().size === 0) {
            ctx.logger.warn(
              'dsh-feishu: no Lark credentials and no operators —— 在桌面 TUI 运行 /feishu-onboard 一键配置',
            )
          } else {
            ctx.logger.warn(
              'dsh-feishu: no Lark credentials (tried config/env, then refs %s / %s) — plugin dormant',
              policy.appIdRef,
              policy.appSecretRef,
            )
          }
          return { armed: false, detail: '未解析到可用的飞书凭据' }
        }
        // Pairing mode: credentials but an EMPTY admin list still arms — the
        // bot's decidePairing gate offers the first p2p DM the pairing card
        // and a claim lands in-process immediately. The allowlist handed to
        // the bot is the config-side union; the bot unions the persisted
        // pairing list per message (pairing.ts keeps both consistent).
        const operators = effectiveOperators()
        if (operators.size === 0) {
          ctx.logger.warn('dsh-feishu: no operators configured — pairing mode (first DM can claim admin via pairing card)')
        }
        instance = new FeishuBot({
          ctx,
          config: policy,
          lark: new LarkClient({
            appId: creds.appId,
            appSecret: creds.appSecret,
            domain: policy.domain,
            onError: (what, error) => ctx.logger.warn('dsh-feishu: %s failed: %o', what, error),
            // Bridge SDK log lines into the plugin channel so nothing from the
            // Lark SDK ever touches the console/stderr behind the TUI's back.
            onLog: (level, message) => ctx.logger[level]('dsh-feishu[lark-sdk]: %s', message),
            // Card interaction callbacks (ask-user submits, pairing taps) —
            // the bot resolves pending questions and claims from these.
            onCardAction: data => bot?.onCardAction(data),
          }),
          binder: new SessionBinder(ctx),
          store,
          allowlist: operators,
        })
        bot = instance
        await instance.start()
        armed = true
        ctx.logger.info('dsh-feishu: armed (%d operator(s), %s)', operators.size, policy.domain)
        return { armed: true, detail: operators.size === 0 ? 'armed in pairing mode' : 'armed' }
      } catch (error) {
        ctx.logger.error('dsh-feishu: startup failed — plugin dormant: %o', error)
        bot = undefined
        await instance?.dispose().catch(() => undefined)
        releaseArmLock()
        return { armed: false, detail: `启动失败：${oneLineReason(error)}` }
      }
    })()
    arming = attempt
    // Settle-hook: a failed attempt clears its slot so a later call retries;
    // a successful one keeps `armed` set, which short-circuits regardless.
    void attempt.then(() => {
      if (arming === attempt && !armed) arming = undefined
    })
    return attempt
  }

  /** The /feishu-onboard command handler: orchestrate onboarding, then hot-arm. */
  const runOnboardCommand = async (invocation: CommandInvocationLike): Promise<CommandResultLike> => {
    // Credential provenance, highest priority first: plaintext config beats
    // env beats refs. resolveAppCredentials applies the same priority and
    // yields the ACTUAL values (config/env were merged into `policy`; refs
    // resolved live). `existing` === undefined ⇔ source 'none'.
    const configSupplied = typeof config.appId === 'string' && config.appId.trim() !== ''
      && typeof config.appSecret === 'string' && config.appSecret.trim() !== ''
    const envSupplied = (process.env.DSH_FEISHU_APP_ID?.trim() ?? '') !== ''
      && (process.env.DSH_FEISHU_APP_SECRET?.trim() ?? '') !== ''
    const existingCredentials = await resolveAppCredentials(ctx, policy)
    const credentialsSource: CredentialsSource = configSupplied
      ? 'config'
      : envSupplied
        ? 'env'
        : existingCredentials !== undefined ? 'refs' : 'none'
    const report = await runOnboard({
      domain: policy.domain,
      existingCredentials,
      credentialsSource,
      ask: askSeamOf(ctx),
      // The invoking session's live root agent: ask requests carry it so the
      // host dispatches them on the agent-scoped waterfall — how the web UI
      // (browser answerer, per-agent scope) actually receives them.
      agent: invocation.agent !== null && typeof invocation.agent === 'object'
        ? invocation.agent
        : undefined,
      credentials: await activeCredentials(ctx),
      store,
      log: (level, message) => ctx.logger[level]('dsh-feishu[onboard]: %s', message),
      signal: invocation.signal,
    })
    let text = report.text
    // Hot activation: when onboarding changed anything the bot can use right
    // now (credentials written or admins paired), arm THIS process instead of
    // demanding a restart — and report the outcome inline.
    if (report.credentialsWritten || report.operatorsPaired.length > 0) {
      const arm = await tryArm()
      text += arm.armed
        ? '\n\n✅ 机器人已在本进程激活，现在就可以在飞书私聊它了'
        : `\n\n⚠️ 本进程激活失败（${arm.detail}），重启 dsh 后生效`
    }
    return report.ok ? { kind: 'success', text } : { kind: 'error', text }
  }

  // /feishu-onboard — registered BEFORE every dormant early-return so the
  // first-config path exists even (especially) when the bot cannot arm. The
  // commands service may be absent (minimal profiles, test mocks): a missing
  // or failing registration only warns — it must never take the plugin down.
  try {
    const commands = ctx.get('commands') as CommandsSeam | undefined
    if (commands !== undefined && typeof commands.register === 'function') {
      ctx.effect(() => commands.register({
        name: 'feishu-onboard',
        description: '配置飞书机器人：扫码一键创建应用或绑定已有应用，自动写入凭据与管理员白名单',
        handler: invocation => runOnboardCommand(invocation),
      }), 'dsh-feishu: /feishu-onboard')
    }
  } catch (error) {
    ctx.logger.warn('dsh-feishu: /feishu-onboard registration failed: %o', error)
  }

  if (policy.mode === 'off') return

  void tryArm()

  ctx.effect(() => async () => {
    tornDown = true
    const current = bot
    bot = undefined
    armed = false
    await current?.dispose().catch(() => undefined)
    releaseArmLock()
  }, 'dsh-feishu: stop bot and release lock')
}
