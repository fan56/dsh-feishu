/**
 * /new session-config card: ONE form the operator fills before a session is
 * minted — agent preset, model, and reasoning effort as three `select_static`
 * dropdowns, submitted together. Pure builders/parsers, same hard-won card
 * constraints as the ask / resume / model / selector cards:
 * - every BUTTON must carry a `value` (200340 client rejection otherwise);
 * - the button `name` doubles as the flow-id carrier (SDK versions may strip
 *   `value` from submits);
 * - schema 2.0 cards must not contain `note` elements (200861).
 *
 * Every dropdown is OPTIONAL at build time: a field the bot could not source
 * (no presets service on this profile, no models known) is omitted entirely
 * and its submit key simply stays absent — the bot falls back to its own
 * default-resolution chain for whatever the card did not offer.
 */

import type { Schema2Card } from './card.ts'
import { clipLine } from './text.ts'

/** Marker written into the form submit / cancel buttons' `value.action`. */
export const NEW_SESSION_ACTION = 'dsh_feishu_new'

/** Button name prefix; the flow id rides after it. */
const NEW_NAME_PREFIX = 'dsh_feishu_new_'

/**
 * Cancel button name prefix — DISTINCT from the submit's: Feishu rejects a
 * card whose form-submit button shares a `name` with any other button
 * (230099 "name duplicate"), even across the form boundary.
 */
const NEW_CANCEL_NAME_PREFIX = 'dsh_feishu_new_cancel_'

/** select_static option cap — truncate instead of risking rejection. */
const MAX_OPTIONS = 50

/** One dropdown choice: `value` rides form_value, `label` renders. */
export interface NewCardChoice {
  readonly value: string
  readonly label: string
}

/** The dropdowns the card offers; absent field = no dropdown. */
export interface NewSessionCardSpec {
  /**
   * EXISTING workspaces only (`value` = the workspace path, used verbatim as
   * the new session's cwd) — the operator never types a path. The caller
   * decides NA policy; an empty environment never reaches the card.
   */
  readonly workspaces?: readonly NewCardChoice[]
  readonly defaultWorkspace?: string
  /** Agent presets (`value` = preset id); `defaultPreset` preselects. */
  readonly presets?: readonly NewCardChoice[]
  readonly defaultPreset?: string
  /** Models of the resolved default provider (`value` = model id). */
  readonly models?: readonly NewCardChoice[]
  readonly defaultModel?: string
  /** Reasoning efforts of the default model; `defaultEffort` preselects. */
  readonly efforts?: readonly NewCardChoice[]
  readonly defaultEffort?: string
  /** Context line under the title (current route, provider notes). */
  readonly contextLine?: string
}

/** What the operator submitted (absent key = the field was not offered). */
export interface NewSessionPicks {
  /** Workspace PATH — used verbatim as the new session's cwd. */
  readonly workspace?: string
  readonly preset?: string
  readonly model?: string
  readonly effort?: string
}

/** Summary row of the created-confirmation card. */
export interface NewSummaryRow {
  readonly field: string
  readonly value: string
}

/** One dropdown component; `initial_option` preselects (absent → placeholder). */
function selectOf(name: string, placeholder: string, choices: readonly NewCardChoice[], initial?: string): Record<string, unknown> {
  const options = choices.slice(0, MAX_OPTIONS).map(choice => ({
    text: { tag: 'plain_text', content: clipLine(choice.label, 48) },
    value: choice.value,
  }))
  return {
    tag: 'select_static',
    name,
    placeholder: { tag: 'plain_text', content: placeholder },
    options,
    ...(initial === undefined || choices.some(choice => choice.value === initial) === false
      ? {}
      : { initial_option: initial }),
  }
}

/** The interactive config card (blue): fill the form, tap 开始新会话. */
export function buildNewSessionCard(spec: NewSessionCardSpec, flowId: string): Schema2Card {
  const elements: Array<Record<string, unknown>> = []
  if (spec.contextLine !== undefined && spec.contextLine !== '') {
    elements.push({ tag: 'markdown', content: spec.contextLine })
  }
  const form: Array<Record<string, unknown>> = []
  if (spec.workspaces !== undefined && spec.workspaces.length > 0) {
    form.push(selectOf('workspace', '选择 workspace…', spec.workspaces, spec.defaultWorkspace))
  }  if (spec.presets !== undefined && spec.presets.length > 0) {
    form.push(selectOf('preset', '选择 preset…', spec.presets, spec.defaultPreset))
  }
  if (spec.models !== undefined && spec.models.length > 0) {
    form.push(selectOf('model', '选择模型…', spec.models, spec.defaultModel))
  }
  if (spec.efforts !== undefined && spec.efforts.length > 0) {
    form.push(selectOf('effort', '选择 think 档位…', spec.efforts, spec.defaultEffort))
  }
  if (form.length === 0) {
    // Nothing to choose (no presets service, no model metadata) — the form
    // degenerates to confirm-only: tap to mint with the resolved defaults.
    elements.push({ tag: 'markdown', content: '当前环境没有可选项，直接按默认配置创建。' })
  }  elements.push({
    tag: 'form',
    name: 'dsh_feishu_new_form',
    elements: [
      ...form,
      {
        tag: 'button',
        name: `${NEW_NAME_PREFIX}${flowId}`,
        // value MUST exist: value-less interactive components are rejected
        // client-side with 200340 and the callback is never delivered.
        value: { action: NEW_SESSION_ACTION, flow_id: flowId },
        text: { tag: 'plain_text', content: '🚀 开始新会话' },
        type: 'primary',
        form_action_type: 'submit',
      },
    ],
  })
  elements.push({
    tag: 'button',
    name: `${NEW_CANCEL_NAME_PREFIX}${flowId}`,
    value: { action: NEW_SESSION_ACTION, flow_id: flowId, cancel: true },
    text: { tag: 'plain_text', content: '取消' },
    type: 'default',
  })
  elements.push({ tag: 'markdown', content: '---\n\ndsh' })
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '🆕 新会话配置' },
      subtitle: { tag: 'plain_text', content: 'dsh · 填好后开始新会话' },
      template: 'blue',
    },
    body: { elements },
  }
}

/**
 * The submit's summary as bold per-row lines (what the operator picked).
 * Deliberately NOT a GFM table — Feishu mobile clients render table markdown
 * as raw pipes (reads as mojibake); bullets render everywhere.
 */
export function newSummaryLines(rows: readonly NewSummaryRow[]): string {
  return rows.map(row => `- **${row.field}**：${row.value}`).join('\n')
}

/** Terminal card: the session was minted (green) with the pick summary. */
export function buildNewSessionCreatedCard(rows: readonly NewSummaryRow[], sessionId: string): Schema2Card {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: `🆕 新会话 · ${sessionId.slice(0, 8)}` },
      subtitle: { tag: 'plain_text', content: 'dsh · 已按配置创建' },
      template: 'green',
    },
    body: {
      elements: [
        { tag: 'markdown', content: newSummaryLines(rows) },
        { tag: 'markdown', content: '直接发消息即可派活；`/resume` 可回到旧会话。' },
      ],
    },
  }
}

/** Terminal card: creation failed after submit (orange) with the reason. */
export function buildNewSessionFailedCard(reason: string): Schema2Card {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '⚠️ 新会话创建失败' },
      subtitle: { tag: 'plain_text', content: 'dsh · 会话未创建' },
      template: 'orange',
    },
    body: { elements: [{ tag: 'markdown', content: clipLine(reason, 300) }] },
  }
}

/** Terminal card: cancelled (grey) — for the record. */
export function buildNewSessionCancelledCard(): Schema2Card {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '🚫 已取消新会话' },
      subtitle: { tag: 'plain_text', content: 'dsh · 未创建任何会话' },
      template: 'grey',
    },
    body: { elements: [{ tag: 'markdown', content: '配置已放弃，此卡片仅供留档。' }] },
  }
}

/** Terminal card: the flow expired before submit (grey). */
export function buildNewSessionExpiredCard(): Schema2Card {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '⏳ 新会话配置已过期' },
      subtitle: { tag: 'plain_text', content: 'dsh · 未创建任何会话' },
      template: 'grey',
    },
    body: { elements: [{ tag: 'markdown', content: '配置卡片已过期，如仍需要请重新 /new。' }] },
  }
}

// ----------------------------------------------------------------- parser --

/** object-or-undefined for optional payload fields. */
function objectOf(raw: unknown): Record<string, unknown> | undefined {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
}

function stringField(form: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = form?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * One recognized card.action.trigger payload for the /new card; undefined for
 * anything else. Same ladder as the selector parser: the button `value.action`
 * marker wins (flow id + cancel flag + the form_value picks); a DIFFERENT
 * string marker means a foreign button (undefined — the name fallback must
 * never fire on it); the `name` prefix fallback covers SDK versions that strip
 * submit values (picks still arrive via form_value; a stripped cancel degrades
 * to an empty submit, which the caller treats as defaults-only).
 */
export function parseNewSessionAction(data: unknown, buttonName?: string):
  | { flowId: string; cancelled?: boolean; picks: NewSessionPicks }
  | undefined {
  const root = objectOf(data)
  if (root === undefined) return undefined
  let action: Record<string, unknown>
  let buttonValue: Record<string, unknown> | undefined
  let formValue: Record<string, unknown> | undefined
  if (typeof root.action === 'string') {
    action = {}
    buttonValue = root
  } else {
    action = objectOf(root.action) ?? root
    buttonValue = objectOf(action.value)
    formValue = objectOf(action.form_value)
  }
  let flowId: string | undefined
  let cancelled = false
  if (buttonValue !== undefined) {
    const marker = buttonValue.action
    if (marker === NEW_SESSION_ACTION) {
      const id = buttonValue.flow_id
      if (typeof id !== 'string' || id === '') return undefined
      flowId = id
      cancelled = buttonValue.cancel === true
    } else if (typeof marker === 'string') {
      return undefined
    }
  }
  if (flowId === undefined) {
    const name = buttonName ?? action.name
    if (typeof name === 'string') {
      if (name.startsWith(NEW_NAME_PREFIX)) {
        const id = name.slice(NEW_NAME_PREFIX.length)
        if (id !== '') flowId = id
      } else if (name.startsWith(NEW_CANCEL_NAME_PREFIX)) {
        // Value-stripped cancel tap: the name alone carries cancel + flow id.
        const id = name.slice(NEW_CANCEL_NAME_PREFIX.length)
        if (id !== '') {
          flowId = id
          cancelled = true
        }
      }
    }
  }
  if (flowId === undefined) return undefined
  const picks: NewSessionPicks = {
    ...(stringField(formValue, 'workspace') === undefined ? {} : { workspace: stringField(formValue, 'workspace') }),
    ...(stringField(formValue, 'preset') === undefined ? {} : { preset: stringField(formValue, 'preset') }),
    ...(stringField(formValue, 'model') === undefined ? {} : { model: stringField(formValue, 'model') }),
    ...(stringField(formValue, 'effort') === undefined ? {} : { effort: stringField(formValue, 'effort') }),
  }
  return cancelled === true ? { flowId, cancelled: true, picks } : { flowId, picks }
}
