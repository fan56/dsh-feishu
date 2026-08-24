/**
 * The `/resume` picker: candidate rows + index reply, per the design doc's
 * settled interaction (rendering lives in `buildSessionListCard`, a native
 * schema 2.0 table card). Candidate filtering mirrors dsh-tui-pi's picker
 * exactly (root sessions only — value test on delegationDepth, never a
 * presence test), sorting is CLIENT-side (persistence.list() order is
 * unspecified — spike S2a), and the "last time" column comes from a bounded
 * concurrent inspect of the shortlist (spike S2b: 10–33ms per session).
 *
 * `list()` is only ever called on an explicit `/resume` (spike S2c: cold
 * listing can take seconds on a long history) — never at startup.
 */

import { basename } from 'node:path'
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
  /** Last event time, epoch ms (undefined when inspect failed). */
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
 */
export async function buildResumeRows(
  persistence: SessionPersistenceLike,
  limit = RESUME_ROW_LIMIT,
  concurrency = RESUME_CONCURRENCY,
): Promise<ResumeRow[]> {
  const headers = await persistence.list()
  const candidates = headers
    .filter(isResumableSessionHeader)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)

  const rows: ResumeRow[] = candidates.map((header, position) => ({
    index: position + 1,
    sessionId: String(header.id),
    dir: basename(header.cwd ?? '?') || '?',
    createdAt: header.createdAt,
    lastTime: undefined,
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
        const last = events.at(-1)
        if (last !== undefined) row.lastTime = last.time
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
