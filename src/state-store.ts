/**
 * Persisted bot state (bound session, think-display preference, last chat).
 * Preferred backend: the dsh settings service, under this plugin's own
 * `dsh-feishu` namespace (schema-validated, survives restarts, visible in
 * dsh's settings surfaces). Degrades to an in-memory copy when no settings
 * provider is mounted — the bot still works, it just re-binds after a
 * restart.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
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
   * Phone-selected default model (/model on the phone): applied live to
   * bot-created sessions and used by /new when no previous route exists.
   */
  phoneModel: { provider: string; model: string } | undefined
}

const DEFAULT_STATE: BotState = {
  boundSessionId: undefined,
  displayThink: true,
  lastChatId: undefined,
  picker: undefined,
  phoneModel: undefined,
}

/**
 * Decode a persisted picker payload. Defensive: the stored JSON is only as
 * trustworthy as the last writer — anything malformed, empty or missing its
 * expiry degrades to "no picker" rather than surfacing garbage rows.
 */
function decodePicker(raw: unknown): StoredPicker | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; rows?: unknown; expiresAt?: unknown }
    if (typeof parsed.id !== 'string' || parsed.id === '' || !Array.isArray(parsed.rows) || typeof parsed.expiresAt !== 'number') {
      return undefined
    }
    const rows = parsed.rows.filter((row): row is ResumeRow =>
      row !== null && typeof row === 'object'
      && typeof (row as ResumeRow).index === 'number'
      && typeof (row as ResumeRow).sessionId === 'string')
    if (rows.length === 0) return undefined
    return { id: parsed.id, rows, expiresAt: parsed.expiresAt }
  } catch {
    return undefined
  }
}

/** Decode a persisted phone-selected default model. */
function decodePhoneModel(raw: unknown): { provider: string; model: string } | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw) as { provider?: unknown; model?: unknown }
    if (typeof parsed.provider === 'string' && parsed.provider !== '' && typeof parsed.model === 'string' && parsed.model !== '') {
      return { provider: parsed.provider, model: parsed.model }
    }
    return undefined
  } catch {
    return undefined
  }
}

const STATE_NAMESPACE = settingsNamespace('dsh-feishu')

const STATE_SCHEMA = z.object({
  boundSessionId: z.string().default(''),
  displayThink: z.boolean().default(true),
  lastChatId: z.string().default(''),
  picker: z.string().default(''),
  phoneModel: z.string().default(''),
}) as unknown as z<{ boundSessionId: string; displayThink: boolean; lastChatId: string; picker: string; phoneModel: string }>

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
  }
}

/**
 * Settings-backed state store. Construction registers the namespace through
 * `ctx.inject(['settings'])` (no-op without the service); `ready()` resolves
 * once registration settled so early reads see the persisted values.
 */
export class StateStore {
  private readonly memory: BotState = { ...DEFAULT_STATE }
  private scope: SettingsScope<{ boundSessionId: string; displayThink: boolean; lastChatId: string; picker: string; phoneModel: string }> | undefined
  private readonly registration: Promise<void>

  constructor(ctx: Context) {
    this.registration = new Promise<void>(resolve => {
      let settled = false
      const finish = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      ctx.inject(['settings'], sctx => {
        try {
          if (!sctx.settings.describe().some(d => d.ns === STATE_NAMESPACE)) {
            this.scope = sctx.settings.register(STATE_NAMESPACE, STATE_SCHEMA, {
              base: { boundSessionId: '', displayThink: true, lastChatId: '', picker: '', phoneModel: '' },
              applies: 'live',
            })
          }
          // Already-registered (plugin reload / second mount): the provider
          // hands a scope only to the registrant, so this instance degrades
          // to the in-memory copy — binding survives, persistence does not.
        } catch {
          // Registration failed — degrade to memory.
        }
        finish()
        return () => {
          this.scope = undefined
        }
      })
      // The injection rides the settings fiber; do not block state reads
      // forever when it never fires (no settings service in this profile).
      setTimeout(finish, 2000).unref?.()
    })
  }

  /** Wait (bounded) for the settings registration so first reads see disk. */
  async ready(): Promise<void> {
    await this.registration
  }

  /** Current snapshot. */
  get(): BotState {
    if (this.scope !== undefined) {
      try {
        return fromSection(this.scope.get())
      } catch {
        return { ...this.memory }
      }
    }
    return { ...this.memory }
  }

  /** Merge a patch and persist it. Never throws. */
  async update(patch: Partial<BotState>): Promise<void> {
    const next = { ...this.get(), ...patch }
    Object.assign(this.memory, next)
    if (this.scope === undefined) return
    try {
      await this.scope.update({
        boundSessionId: next.boundSessionId ?? '',
        displayThink: next.displayThink,
        lastChatId: next.lastChatId ?? '',
        picker: next.picker === undefined ? '' : JSON.stringify(next.picker),
        phoneModel: next.phoneModel === undefined ? '' : JSON.stringify(next.phoneModel),
      })
    } catch {
      // Persistence failed — the in-memory copy still serves this run.
    }
  }
}
