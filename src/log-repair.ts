/**
 * Phone-side driver for the vendored repair tool (scripts/repair-session-
 * log.mjs, byte-identical with dsh-tui-pi's). The script is self-contained
 * (node builtins + an external `zstd` binary) and NEVER touches the original
 * log: `--apply` writes `<stem>.repaired.jsonl[.zstd]` beside it; swapping
 * the repaired file in is this module's job (with a .corrupt-bak kept).
 *
 * Script contract (verified empirically, 2026-08):
 * - dry-run (`no --apply`): exit 0 = clean · exit 3 = corruption diagnosed,
 *   NOTHING written · exit 2 = torn lines / usage / environment error.
 * - `--apply`: exit 0 = repaired file written (or "verdict: CLEAN" — no
 *   violations found, no file) · exit 2 = error. Missing input dies with an
 *   uncaught ENOENT (exit 1).
 * Exit 3 therefore only occurs in dry-runs, where it maps to `failed` (the
 * log is still corrupt) — `verifyClean` is the only dry-run consumer.
 */

import { spawnSync } from 'node:child_process'
import { chmod, rename, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Vendored script, resolved from lib/*.js at runtime → <pkg>/scripts/. */
const SCRIPT_PATH = new URL('../scripts/repair-session-log.mjs', import.meta.url)

/** One repair-tool outcome (an applied repair carries the generated path). */
export interface RepairResult {
  status: 'clean' | 'repaired' | 'failed'
  /** Failure reason (tool stderr/stdout snippet, spawn error, or timeout). */
  detail?: string
  /** The `*.repaired` file the script wrote (status 'repaired' only). */
  repairedPath?: string
}

/**
 * Injectable repair seam — the bot talks to THIS interface so tests swap the
 * process-spawning implementation for a fake.
 */
export interface RepairBackend {
  runRepair(logPath: string, options: { apply: boolean }): Promise<RepairResult>
  verifyClean(logPath: string): Promise<boolean>
  swapRepaired(logPath: string, repairedPath: string): Promise<void>
}

/** Hard runtime budget for one script invocation (logs can be long). */
const TIMEOUT_MS = 120_000

/** Mirror of the script's own output-name rule for `<stem>.repaired…`. */
export function repairedPathFor(logPath: string): string {
  const stem = basename(logPath).replace(/\.jsonl(\.zstd)?$/, '')
  const zstd = logPath.endsWith('.jsonl.zstd')
  return join(dirname(logPath), `${stem}.repaired.jsonl${zstd ? '.zstd' : ''}`)
}

/** First ~n chars of the given stream text, whitespace-trimmed. */
function snippet(text: string | undefined, max = 300): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** Run the vendored script once and map its exit onto a RepairResult. */
export async function runRepair(logPath: string, options: { apply: boolean }): Promise<RepairResult> {
  const args = [fileURLToPath(SCRIPT_PATH), logPath, ...(options.apply ? ['--apply'] : [])]
  let proc: ReturnType<typeof spawnSync>
  try {
    proc = spawnSync(process.execPath, args, { timeout: TIMEOUT_MS })
  } catch (error) {
    return { status: 'failed', detail: snippet(error instanceof Error ? error.message : String(error)) }
  }
  if (proc.error !== undefined) {
    const code = (proc.error as NodeJS.ErrnoException).code
    const detail = code === 'ENOENT'
      ? `${proc.error.message} — is the zstd binary installed?`
      : code === 'ETIMEDOUT' || proc.signal !== null
        ? `repair tool did not finish within ${TIMEOUT_MS / 1000}s`
        : proc.error.message
    return { status: 'failed', detail }
  }
  const output = snippet(proc.stderr?.toString('utf8')) || snippet(proc.stdout?.toString('utf8'))
  if (proc.status === 0) {
    if (!options.apply) return { status: 'clean' }
    // Apply ran to completion: 'repaired' only when the script actually
    // wrote its output file — a bare exit 0 without one is "verdict: CLEAN".
    const candidate = repairedPathFor(logPath)
    try {
      await stat(candidate)
      return { status: 'repaired', repairedPath: candidate }
    } catch {
      return { status: 'clean' }
    }
  }
  // Exit 3 (dry-run diagnosis: still corrupt), 2 (usage/torn lines), or an
  // unexpected code (e.g. 1 = uncaught ENOENT on the input) — all failures
  // for our purposes; the tool's own words ride along as the detail.
  return {
    status: 'failed',
    detail: output === '' ? `repair tool exited with code ${proc.status ?? 'signal ' + String(proc.signal)}` : output,
  }
}

/** Dry-run the log through the script; true only on a CLEAN verdict. */
export async function verifyClean(logPath: string): Promise<boolean> {
  return (await runRepair(logPath, { apply: false })).status === 'clean'
}

/**
 * Put the repaired log in place of the corrupted one. The original moves to
 * `<log>.corrupt-bak` (timestamped when that name is taken) — never deleted;
 * a failed swap-in restores it best-effort before rethrowing.
 */
export async function swapRepaired(logPath: string, repairedPath: string): Promise<void> {
  let backup = `${logPath}.corrupt-bak`
  try {
    await stat(backup)
    backup = `${logPath}.corrupt-bak.${Date.now()}`
  } catch {
    // Free name — use it.
  }
  await rename(logPath, backup)
  try {
    await rename(repairedPath, logPath)
  } catch (error) {
    await rename(backup, logPath).catch(() => undefined)
    throw error
  }
  await chmod(logPath, 0o600).catch(() => undefined)
}

/** The real, process-spawning backend (the bot's default). */
export const defaultRepairBackend: RepairBackend = { runRepair, verifyClean, swapRepaired }
