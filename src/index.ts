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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { buildAllowlist } from './allowlist.ts'
import { FeishuBot } from './bot.ts'
import { SessionBinder } from './binder.ts'
import { Config, resolveConfig, type ResolvedConfig } from './config.ts'
import { LarkClient } from './lark-client.ts'
import { StateStore } from './state-store.ts'

export const name = 'dsh-feishu'
export const inject = ['agents']

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

// ------------------------------------------------------------------- apply --

export function apply(ctx: Context, config: Config = {}): void {
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
