/**
 * The `/resume` picker: candidate rows + index reply, per the design doc's
 * settled interaction (rendering lives in `buildSessionListCard`, a native
 * schema 2.0 table card). Candidate filtering mirrors dsh-tui-pi's picker
 * exactly (root sessions only — value test on delegationDepth, never a
 * presence test). Ordering matches the TUI picker's "last update" sort:
 * the jsonl log's mtime when known (best-effort walk of the persistence
 * store, `loadSessionLastUpdates`), else the header's `createdAt` — so a
 * session touched yesterday but created last month surfaces above a
 * newer-created stale one, identically on phone and terminal. Only the
 * shortlist gets a bounded concurrent inspect for the preview/lastTime
 * columns (spike S2b: 10–33ms per session).
 *
 * `list()` is only ever called on an explicit `/resume` (spike S2c: cold
 * listing can take seconds on a long history) — never at startup.
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { clipLine, textOfContent } from './text.ts'

/** The `sessionPersistence` surface this module needs (structural). */
export interface SessionPersistenceLike {
  list(signal?: AbortSignal): Promise<SessionHeader[]>
  inspect(id: SessionId, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }>
}

/** One table row shown to the operator (preview/lastTime enrich during build). */
export interface ResumeRow {
  readonly index: number
  readonly sessionId: string
  /** cwd basename (or `?`). */
  readonly dir: string
  /** Created time, epoch ms. */
  readonly createdAt: number
  /** Last update time, epoch ms (jsonl log mtime; else the inspect event tail; undefined when both unavailable). */
  lastTime: number | undefined
  /** First-prompt preview (or fallback label). */
  preview: string
}

/** Rows shown per `/resume` (design: take the most recent 10). */
export const RESUME_ROW_LIMIT = 10

/** Concurrent inspects while enriching rows (TUI picker uses 6). */
export const RESUME_CONCURRENCY = 6

/** Hard character cap for a preview. */
export const PREVIEW_MAX_CHARS = 60

/**
 * The jsonl persistence root guess: `$DSH_SESSION_ROOT`, else
 * `$DSH_HOME/sessions`, else `~/.dsh/sessions` — the dsh CLI convention,
 * same as dsh-tui-pi's picker. Only used for the mtime-based last-update
 * enrichment; a mismatched root simply leaves rows sorted by `createdAt`.
 */
export function sessionLogRoot(): string {
  if (process.env.DSH_SESSION_ROOT !== undefined && process.env.DSH_SESSION_ROOT !== '') {
    return process.env.DSH_SESSION_ROOT
  }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** Physical log file names the jsonl backend writes (`logSuffix`). */
const LOG_FILE_NAMES = ['session.jsonl', 'session.jsonl.zstd'] as const

/**
 * Best-effort session-id → last-write time map from the jsonl store's file
 * mtimes — ported from dsh-tui-pi (`loadSessionLastUpdates`) so the phone
 * list and the TUI list order identically. One walk of
 * `<root>/<project>/<session>/session.jsonl[.zstd]`, stat per log; session
 * directory names are the path-encoded session ids (UUID ids encode to
 * themselves). Any failure resolves an empty map (rows degrade to
 * `createdAt` ordering) — never throws.
 */
export async function loadSessionLastUpdates(root: string = sessionLogRoot()): Promise<Map<string, number>> {
  const updates = new Map<string, number>()
  let projects: string[]
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return updates
  }
  for (const project of projects) {
    let sessionDirs: string[]
    try {
      sessionDirs = (await readdir(join(root, project), { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      continue
    }
    for (const dir of sessionDirs) {
      for (const name of LOG_FILE_NAMES) {
        try {
          const info = await stat(join(root, project, dir, name))
          if (info.mtimeMs > 0) updates.set(dir, info.mtimeMs)
          break
        } catch {
          // Not this suffix — try the next one.
        }
      }
    }
  }
  return updates
}

/**
 * Whether a persisted header is a resumable ROOT session — the exact filter
 * dsh-tui-pi applies (value test on delegationDepth; presence test would drop
 * every jsonl-restored header which materialises `delegationDepth: 0`).
 */
export function isResumableSessionHeader(header: SessionHeader): boolean {
  return header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
}

/**
 * The session's "first sentence": the first direct human prompt, falling back
 * to the first non-injected user-role text, then the first assistant message
 * (same ladder as the TUI picker, minus the TUI imports).
 */
export function previewOfEvents(events: readonly SessionEvent[]): string | undefined {
  let fallbackUser: string | undefined
  let fallbackAssistant: string | undefined
  for (const event of events) {
    if (event.type === 'user/message') {
      const message = event.data as { source?: { kind?: string }; content?: unknown }
      const text = textOfContent(message?.content)
      if (!text) continue
      const kind = message?.source?.kind
      if (kind === 'user') return text
      if (kind === 'tool' || kind === 'plugin' || kind === 'agent-instructions') continue
      if (fallbackUser === undefined) fallbackUser = text
    } else if (event.type === 'assistant/message') {
      const message = (event.data as { message?: { content?: unknown } }).message
      const text = textOfContent(message?.content)
      if (text && fallbackAssistant === undefined) fallbackAssistant = text
    }
  }
  return fallbackUser ?? fallbackAssistant
}

/**
 * Build the recent-rows table. Never throws: listing errors propagate (the
 * caller phrases the error), per-row inspect failures degrade to a fallback
 * preview and an absent lastTime.
 *
 * Ordering follows the TUI picker: `lastUpdates[id] ?? createdAt`, newest
 * first, ties broken by `createdAt` then id (deterministic). The map comes
 * from {@link loadSessionLastUpdates} (jsonl mtimes — a cheap stat walk, no
 * log reads); passing an empty/undefined map keeps the createdAt ordering.
 * Sorting and truncation happen BEFORE the inspect enrichment, so the index
 * contract below is assigned on the final order.
 */
export async function buildResumeRows(
  persistence: SessionPersistenceLike,
  lastUpdates?: ReadonlyMap<string, number>,
  limit = RESUME_ROW_LIMIT,
  concurrency = RESUME_CONCURRENCY,
): Promise<ResumeRow[]> {
  const headers = await persistence.list()
  const candidates = headers.filter(isResumableSessionHeader)
  candidates.sort((a, b) => {
    const at = lastUpdates?.get(String(a.id)) ?? a.createdAt
    const bt = lastUpdates?.get(String(b.id)) ?? b.createdAt
    if (bt !== at) return bt - at
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
    return String(b.id).localeCompare(String(a.id))
  })

  const rows: ResumeRow[] = candidates.slice(0, limit).map((header, position) => ({
    index: position + 1,
    sessionId: String(header.id),
    dir: basename(header.cwd ?? '?') || '?',
    createdAt: header.createdAt,
    // The mtime IS the last-update time; the inspect tail below only fills
    // this in when the store root was unknown (no mtime available).
    lastTime: lastUpdates?.get(String(header.id)),
    preview: '',
  }))

  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, rows.length)) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++]!
      try {
        const { events } = await persistence.inspect(SessionId(row.sessionId))
        const preview = previewOfEvents(events)
        row.preview = preview === undefined ? '' : clipLine(preview, PREVIEW_MAX_CHARS)
        if (row.lastTime === undefined) {
          const last = events.at(-1)
          if (last !== undefined) row.lastTime = last.time
        }
      } catch {
        // Inspect failed — the fallback label below keeps the row usable.
      }
    }
  })
  await Promise.all(workers)

  for (const row of rows) {
    if (row.preview === '') {
      row.preview = `${row.dir} · ${row.sessionId.slice(0, 8)}`
    }
  }
  return rows
}

/** Resolve `/resume N` against a pending table. */
export function pickResumeRow(rows: readonly ResumeRow[], n: number): ResumeRow | undefined {
  if (!Number.isInteger(n) || n < 1 || n > rows.length) return undefined
  return rows[n - 1]
}
