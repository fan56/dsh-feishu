/**
 * Persisted bot state (bound session, think-display preference, last chat,
 * pairing admins) — a small JSON file in the dsh home
 * (`<dsh home>/dsh-feishu-state.json`).
 *
 * Why not the settings service (the pre-0.1.7 backend): dsh 0.1.7 replaced
 * the settings registry with plugin `static Config` projections where ONLY
 * user-editable `.volatile()` fields are writable at runtime — machine state
 * (pickers, cursors, pairing claims) is exactly what must NOT be volatile
 * (it would surface on the settings page and rewrite the profile patch on
 * every bot event). So the state moved to its own file: same in-memory
 * mirror + write-through semantics as before, zero settings dependency.
 *
 * Upgrade path: a fresh install (no state file yet) absorbs the 0.1.5-era
 * remnants from `<dsh home>/settings.yaml.imported` (or `settings.yaml`)
 * — the host renames the old document on first 0.1.7 boot — by reading the
 * `dsh-feishu:` section with a deliberately conservative flat-scalar parser
 * (anything nested, folded across lines or otherwise unexpected is skipped;
 * the decoders below fail closed). Without it, pairing claims would not
 * survive the upgrade and the bot would re-open pairing mode.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ResumeRow } from './resume-table.ts'

/** A persisted /resume selection awaiting its index reply. */
export interface StoredPicker {
  /** Matches the interactive picker card's submit button. */
  id: string
  rows: readonly ResumeRow[]
  expiresAt: number
}

/** What the bot persists. */
export interface BotState {
  /** Bound root session id, when the bot is attached to one. */
  boundSessionId: string | undefined
  /** Whether the think tail line is rendered on the round card (default on). */
  displayThink: boolean
  /** Last chat the operator wrote from — where status cards go. */
  lastChatId: string | undefined
  /**
   * Latest /resume picker. Persisted (not just in-memory) so a dsh restart
   * within the TTL does not strand the operator's `/resume N` reply — the
   * picker's 5-minute TTL still bounds staleness.
   */
  picker: StoredPicker | undefined
  /**
   * Phone-selected default model (/model on the phone, plus the reasoning
   * effort the interactive /think and /profile-switch adapters may carry):
   * applied live to bot-created sessions and used by /new when no previous
   * route exists.
   */
  phoneModel: { provider: string; model: string; reasoningEffort?: string } | undefined
  /**
   * Admins added through pairing mode (the zero-config bootstrap): the first
   * p2p chat to tap the pairing card when the allowlist is completely empty.
   * Persisted so a claim survives restarts; unioned with the configured
   * operators on every gate check (read fresh — a claim must take effect
   * in-process immediately).
   */
  pairedOperators: readonly string[]
}

const DEFAULT_STATE: BotState = {
  boundSessionId: undefined,
  displayThink: true,
  lastChatId: undefined,
  picker: undefined,
  phoneModel: undefined,
  pairedOperators: [],
}

/** On-disk shape: native JSON values (versioned for future migrations). */
const STATE_FILE_VERSION = 1

/** The state file, relative to the resolved dsh home. */
export const STATE_FILENAME = 'dsh-feishu-state.json'

/** The old settings document the 0.1.5 host kept bot state in. */
const LEGACY_SETTINGS_FILENAME = 'settings.yaml'

/** What the host renames that document to on first 0.1.7 boot. */
const LEGACY_IMPORTED_FILENAME = 'settings.yaml.imported'

/** Constructor options — tests inject an explicit `path` to stay off the real home. */
export interface StateStoreOptions {
  /** Full state-file path. Default: `<dsh home>/dsh-feishu-state.json`. */
  path?: string
}

/**
 * Resolve the dsh home the same way the host does, without importing it:
 * the profile context's home when mounted (structural read — absent in
 * tests/minimal hosts), else `$DSH_HOME`, else `~/.dsh`.
 */
export function resolveDshHome(ctx?: Context): string {
  const fromProfile = (ctx as { profileContext?: { home?: unknown } } | undefined)?.profileContext?.home
  if (typeof fromProfile === 'string' && fromProfile !== '') return fromProfile
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv === '~' ? homedir()
      : fromEnv.startsWith('~/') ? join(homedir(), fromEnv.slice(2))
      : fromEnv
  }
  return join(homedir(), '.dsh')
}

/**
 * Decode a persisted picker payload. Defensive: the stored JSON is only as
 * trustworthy as the last writer — anything malformed, empty or missing its
 * expiry degrades to "no picker" rather than surfacing garbage rows. Accepts
 * the native object shape and the pre-0.1.7 JSON-string encoding alike.
 */
function decodePicker(raw: unknown): StoredPicker | undefined {
  const parsed = typeof raw === 'string' && raw !== ''
    ? tryParseJson(raw)
    : raw !== null && typeof raw === 'object' ? raw : undefined
  if (parsed === undefined || typeof parsed !== 'object') return undefined
  const record = parsed as { id?: unknown; rows?: unknown; expiresAt?: unknown }
  if (typeof record.id !== 'string' || record.id === '' || !Array.isArray(record.rows) || typeof record.expiresAt !== 'number') {
    return undefined
  }
  const rows = record.rows.filter((row): row is ResumeRow =>
    row !== null && typeof row === 'object'
    && typeof (row as ResumeRow).index === 'number'
    && typeof (row as ResumeRow).sessionId === 'string')
  if (rows.length === 0) return undefined
  return { id: record.id, rows, expiresAt: record.expiresAt }
}

/** tryParseJson: undefined on any failure — callers never see thrown syntax errors. */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Decode a persisted phone-selected default model (effort optional). */
function decodePhoneModel(raw: unknown): { provider: string; model: string; reasoningEffort?: string } | undefined {
  const parsed = typeof raw === 'string' && raw !== ''
    ? tryParseJson(raw)
    : raw !== null && typeof raw === 'object' ? raw : undefined
  if (parsed === undefined || typeof parsed !== 'object') return undefined
  const record = parsed as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  if (typeof record.provider === 'string' && record.provider !== '' && typeof record.model === 'string' && record.model !== '') {
    return {
      provider: record.provider,
      model: record.model,
      ...(typeof record.reasoningEffort === 'string' && record.reasoningEffort !== ''
        ? { reasoningEffort: record.reasoningEffort }
        : {}),
    }
  }
  return undefined
}

/**
 * Decode the persisted pairing-admin list. Defensive: a malformed blob (not
 * JSON, not an array, junk entries, empty strings) degrades to a filtered
 * list or [] rather than surfacing garbage into the authorization gate.
 */
function decodePairedOperators(raw: unknown): readonly string[] {
  const parsed = typeof raw === 'string' && raw !== ''
    ? tryParseJson(raw)
    : Array.isArray(raw) ? raw : undefined
  if (!Array.isArray(parsed)) return []
  return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
}

function fromSection(section: unknown): BotState {
  const value = (section ?? {}) as Partial<Record<keyof BotState, unknown>>
  return {
    boundSessionId: typeof value.boundSessionId === 'string' && value.boundSessionId !== ''
      ? value.boundSessionId
      : undefined,
    // Absent means the default (on) — only an explicit false turns it off.
    displayThink: value.displayThink !== false,
    lastChatId: typeof value.lastChatId === 'string' && value.lastChatId !== ''
      ? value.lastChatId
      : undefined,
    picker: decodePicker(value.picker),
    phoneModel: decodePhoneModel(value.phoneModel),
    pairedOperators: decodePairedOperators(value.pairedOperators),
  }
}

// ------------------------------------------------------------- legacy import --

/**
 * Decode one YAML scalar of the old settings document — the shapes the 0.1.5
 * writer actually produced for this section (plain strings, booleans, and
 * single-quoted JSON-string payloads). A value that opens a quote it does not
 * close on the same line is a FOLDED long scalar (the yaml package wraps at
 * 80 columns): unparseable here by design, so the key is skipped and the
 * decoder's own defaults apply — never a half-read value.
 */
function decodeLegacyScalar(raw: string): unknown {
  const value = raw.trim()
  if (value === '' || value === 'null' || value === '~') return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  const quote = value[0]
  const closed = value.length >= 2 && value[value.length - 1] === quote
  if (quote === "'" || quote === '"') {
    if (!closed || value.length < 2) return undefined // folded / unterminated — skip
    if (quote === '"') return tryParseJson(value) // JSON-compatible escapes; else undefined
    return value.slice(1, -1).replace(/''/g, "'")
  }
  const hash = value.indexOf(' #')
  return hash >= 0 ? value.slice(0, hash).trim() : value
}

/**
 * Extract the top-level `dsh-feishu:` section of the old settings document.
 * Conservative on purpose: flat `key: value` lines only — nested maps,
 * lists, comments and blank-line runs never decode (the section this plugin
 * ever wrote WAS flat). undefined = no section found.
 */
export function legacyFeishuSection(text: string): Record<string, unknown> | undefined {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^dsh-feishu:\s*(#.*)?$/.test(line))
  if (start < 0) return undefined
  const section: Record<string, unknown> = {}
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    if (/^\S/.test(line)) break // the next top-level key ends the section
    if (/^\s*#/.test(line)) continue
    const match = /^\s+([A-Za-z][A-Za-z0-9_-]*):[ \t]?(.*)$/.exec(line)
    if (match === null) continue // nested shape we do not model — skip the line
    section[match[1]] = decodeLegacyScalar(match[2])
  }
  return section
}

/**
 * Best-effort read of the 0.1.5 state remnants: the imported (preferred —
 * the host renamed it there) then the live old settings document. Any
 * failure (absent file, unreadable, garbage) resolves undefined — a bot
 * upgrade must never be blocked by a cleanup nicety.
 */
async function readLegacyState(home: string): Promise<BotState | undefined> {
  for (const name of [LEGACY_IMPORTED_FILENAME, LEGACY_SETTINGS_FILENAME]) {
    let text: string
    try {
      text = await readFile(join(home, name), 'utf8')
    } catch {
      continue
    }
    try {
      const section = legacyFeishuSection(text)
      if (section !== undefined) {
        const state = fromSection(section)
        // Only a section that decoded to SOMETHING counts; an empty shell
        // (e.g. the folded-everything edge) leaves defaults untouched.
        if (state.pairedOperators.length > 0 || state.boundSessionId !== undefined
          || state.lastChatId !== undefined || state.picker !== undefined
          || state.phoneModel !== undefined || state.displayThink === false) {
          return state
        }
      }
    } catch {
      // Unreadable legacy document — treat as absent.
    }
  }
  return undefined
}

// -------------------------------------------------------------------- store --

/**
 * File-backed state store. Construction starts the load (state file first,
 * legacy settings remnants on a fresh install); `ready()` resolves once the
 * load settled so early reads see the persisted values. Every mutation
 * mirrors into memory immediately and writes the file through a serialized
 * tmp+rename queue — persistence failures degrade to the in-memory copy
 * (the bot still works, it just re-binds after a restart), exactly the old
 * no-settings-service behavior.
 */
export class StateStore {
  private memory: BotState = { ...DEFAULT_STATE }
  private readonly path: string
  /** The directory the state file (and the legacy document) live in. */
  private readonly home: string
  private readonly loading: Promise<void>
  private writes: Promise<void> = Promise.resolve()

  constructor(ctx: Context, options: StateStoreOptions = {}) {
    this.path = options.path ?? join(resolveDshHome(ctx), STATE_FILENAME)
    this.home = options.path !== undefined ? dirname(options.path) : resolveDshHome(ctx)
    this.loading = this.load()
  }

  /** Wait for the initial load (a file read — settles on its own) so first reads see disk. */
  async ready(): Promise<void> {
    await this.loading
  }

  /** Current snapshot. */
  get(): BotState {
    return { ...this.memory }
  }

  /** Merge a patch and persist it. Never throws. */
  async update(patch: Partial<BotState>): Promise<void> {
    const next = { ...this.get(), ...patch }
    Object.assign(this.memory, next)
    await this.persist()
  }

  /**
   * The persisted pairing admins (OnboardStoreSeam shape): read fresh from
   * the store on every call so a claim lands in-process immediately.
   */
  getPairedOperators(): readonly string[] {
    return this.get().pairedOperators
  }

  /** Add a pairing admin (dedup-merge) and persist. Never throws. */
  async addPairedOperator(openId: string): Promise<void> {
    const value = openId.trim()
    if (value === '') return
    const current = this.getPairedOperators()
    if (current.includes(value)) return
    await this.update({ pairedOperators: [...current, value] })
  }

  /** Initial load: the state file, else one absorption pass over the legacy document. */
  private async load(): Promise<void> {
    let text: string | undefined
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      text = undefined
    }
    if (text !== undefined) {
      try {
        this.memory = fromSection(tryParseJson(text))
      } catch {
        // Corrupt state file — defaults apply; the next write replaces it.
      }
      return
    }
    const legacy = await readLegacyState(this.home)
    if (legacy !== undefined) {
      this.memory = { ...this.memory, ...legacy }
    }
  }

  /** Serialized write-through: one tmp+rename at a time, failures swallowed. */
  private persist(): Promise<void> {
    const task = this.writes.then(() => this.writeNow())
    this.writes = task.then(() => undefined, () => undefined)
    return task
  }

  private async writeNow(): Promise<void> {
    const value = this.memory
    const payload = `${JSON.stringify({
      version: STATE_FILE_VERSION,
      boundSessionId: value.boundSessionId ?? null,
      displayThink: value.displayThink,
      lastChatId: value.lastChatId ?? null,
      picker: value.picker ?? null,
      phoneModel: value.phoneModel ?? null,
      pairedOperators: [...value.pairedOperators],
    }, null, 2)}\n`
    const tmp = `${this.path}.tmp`
    try {
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this.path)
    } catch {
      // Persistence failed — the in-memory copy still serves this run.
    }
  }
}
