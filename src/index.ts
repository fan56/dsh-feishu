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
const SKILL_DESCRIPTION = 'dsh 飞书机器人插件（@aiwayds/dsh-feishu）使用与配置指南。凡涉及飞书/Lark 接入、机器人配对、手机端控制 dsh、卡片交互、后台推送，或要配置 feishu 时先读本指南：cordis.patch.yml 挂载块 config: 段 12 键（mode/domain/operators/appId/appSecret/凭据 refs/statusIntervalMs/bodySegmentChars/resumeListStyle/btwContextMessages/backgroundPush）、DSH_FEISHU_* 环境变量、ask_user_question 配置向导、operators 空则 bot 休眠、settings.yaml dsh-feishu: 段是运行态非配置。触发词：飞书、feishu、lark、机器人、operators、配对、绑定、backgroundPush。'

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
  if (policy.mode === 'off') return

  const allowlist = buildAllowlist(policy.operators)
  if (allowlist.size === 0) {
    ctx.logger.warn('dsh-feishu: no operators configured — plugin dormant (set operators[] in cordis.patch.yml or DSH_FEISHU_OPERATORS)')
    return
  }

  const lockFd = acquireLock()
  if (lockFd === undefined) {
    ctx.logger.warn('dsh-feishu: another instance holds the bot lock — this fiber stays dormant')
    return
  }

  let bot: FeishuBot | undefined
  let tornDown = false
  void (async () => {
    const creds = await resolveAppCredentials(ctx, policy)
    // Teardown may land while credentials resolve (the seam wait is bounded,
    // not instant): arming after disposal would open a WS nothing will ever
    // close and re-create the lock file the effect already released.
    if (tornDown) return
    if (creds === undefined) {
      releaseLock(lockFd)
      ctx.logger.warn(
        'dsh-feishu: no Lark credentials (tried config/env, then refs %s / %s) — plugin dormant',
        policy.appIdRef,
        policy.appSecretRef,
      )
      return
    }
    const instance = new FeishuBot({
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
        // Card interaction callbacks (ask-user submits) — the bot resolves
        // pending questions from these.
        onCardAction: data => bot?.onCardAction(data),
      }),
      binder: new SessionBinder(ctx),
      store: new StateStore(ctx),
      allowlist,
    })
    bot = instance
    try {
      await instance.start()
      ctx.logger.info('dsh-feishu: armed (%d operator(s), %s)', allowlist.size, policy.domain)
    } catch (error) {
      ctx.logger.error('dsh-feishu: startup failed — plugin dormant: %o', error)
      bot = undefined
      await instance.dispose().catch(() => undefined)
      releaseLock(lockFd)
    }
  })()

  ctx.effect(() => async () => {
    tornDown = true
    await bot?.dispose().catch(() => undefined)
    releaseLock(lockFd)
  }, 'dsh-feishu: stop bot and release lock')
}
