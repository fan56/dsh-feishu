/**
 * Generic selection card (selector FW): pure builders/parsers for one-shot
 * choice cards any adapter can present. Two modes:
 * - `select` — a select_static + submit button inside a form; the pick rides
 *   `form_value.pick` on submit;
 * - `buttons` — one immediate button per option (the pick rides the button
 *   `value`), plus a cancel button; no form container.
 *
 * Same card.action.trigger mechanics and hard-won constraints as the ask /
 * resume / model cards:
 * - every BUTTON must carry a `value` — the Feishu client rejects value-less
 *   interactive components with 200340 and never delivers the callback;
 * - the button `name` doubles as the flow-id carrier (some SDK versions
 *   strip `value` from submits);
 * - schema 2.0 cards must not contain `note` elements (server 200861) —
 *   footers ride a `---` line inside a markdown element.
 */

import type { Schema2Card } from './card.ts'
import { clipLine } from './text.ts'

/** Marker written into every selector button's `value.action`. */
export const SELECTOR_ACTION = 'dsh_feishu_sel'

/** Button name prefix; the flow id rides after it. */
const SELECTOR_NAME_PREFIX = 'dsh_feishu_sel_'

/** select_static option cap — the builder truncates instead of risking rejection. */
const MAX_OPTIONS = 50

/** select_static option-text clip (same limit the resume picker uses). */
const OPTION_TEXT_CLIP = 48

/** One choice the selector offers. */
export interface SelectorOption {
  readonly value: string
  readonly label: string
  readonly description?: string
}

/** `select` = dropdown + submit (default); `buttons` = one button per option. */
export type SelectorMode = 'select' | 'buttons'

/** What the caller wants to ask. */
export interface SelectorSpec {
  readonly title: string
  readonly description?: string
  readonly options: readonly SelectorOption[]
  readonly mode?: SelectorMode
  readonly submitLabel?: string
}

/** Builder/parser flow reference: the manager's live flow, projected. */
export interface SelectorFlowRef {
  readonly id: string
  readonly spec: SelectorSpec
}

/** One recognized card.action.trigger payload for a selector button. */
export interface ParsedSelectorAction {
  readonly flowId: string
  readonly pick?: string
  readonly cancel?: boolean
}

// ------------------------------------------------------------------ cards --

/** Option text as rendered in the dropdown: `label — description`, clipped. */
function optionText(option: SelectorOption): string {
  const text = option.description === undefined || option.description === ''
    ? option.label
    : `${option.label} — ${option.description}`
  return clipLine(text, OPTION_TEXT_CLIP)
}

/** Header subtitle of a selector card (title kept short for the phone). */
function subtitleOf(spec: SelectorSpec, count?: number): string {
  const title = clipLine(spec.title, 48)
  return count === undefined ? `dsh · ${title}` : `dsh · ${title} · 共 ${count} 个选项`
}

/**
 * The interactive selector card (blue). Options past 50 are truncated (the
 * select_static server cap) rather than risking a rejected card.
 */
export function buildSelectorCard(flow: SelectorFlowRef): Schema2Card {
  const options = flow.spec.options.slice(0, MAX_OPTIONS)
  const elements: Array<Record<string, unknown>> = []
  if (flow.spec.description !== undefined && flow.spec.description !== '') {
    elements.push({ tag: 'markdown', content: flow.spec.description })
  }
  if (flow.spec.mode === 'buttons') {
    for (const option of options) {
      elements.push({
        tag: 'button',
        name: `${SELECTOR_NAME_PREFIX}${flow.id}`,
        value: { action: SELECTOR_ACTION, flow_id: flow.id, pick: option.value },
        text: { tag: 'plain_text', content: option.label },
        type: 'primary',
      })
    }
    elements.push({
      tag: 'button',
      name: `${SELECTOR_NAME_PREFIX}${flow.id}`,
      value: { action: SELECTOR_ACTION, flow_id: flow.id, cancel: true },
      text: { tag: 'plain_text', content: '取消' },
      type: 'default',
    })
  } else {
    elements.push({
      tag: 'form',
      name: 'dsh_feishu_selector_form',
      elements: [
        {
          tag: 'select_static',
          name: 'pick',
          placeholder: { tag: 'plain_text', content: '请选择…' },
          options: options.map(option => ({
            text: { tag: 'plain_text', content: optionText(option) },
            value: option.value,
          })),
        },
        {
          tag: 'button',
          name: `${SELECTOR_NAME_PREFIX}${flow.id}`,
          // value MUST exist: value-less interactive components are rejected
          // client-side with 200340 and the callback is never delivered.
          value: { action: SELECTOR_ACTION, flow_id: flow.id },
          text: { tag: 'plain_text', content: flow.spec.submitLabel ?? '✅ 确认' },
          type: 'primary',
          form_action_type: 'submit',
        },
      ],
    })
  }
  // Schema V2 has no note component — the footer rides markdown after `---`.
  elements.push({ tag: 'markdown', content: '---\n\ndsh' })
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: flow.spec.title },
      subtitle: { tag: 'plain_text', content: subtitleOf(flow.spec, options.length) },
      template: 'blue',
    },
    body: { elements },
  }
}

/** Terminal card: the operator picked an option (green). */
export function buildSelectorSettledCard(flow: SelectorFlowRef, picked: SelectorOption): Schema2Card {
  const detail = picked.description === undefined || picked.description === ''
    ? ''
    : `\n${picked.description}`
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '✅ 已选择' },
      subtitle: { tag: 'plain_text', content: subtitleOf(flow.spec) },
      template: 'green',
    },
    body: { elements: [{ tag: 'markdown', content: `**${picked.label}**${detail}` }] },
  }
}

/** Terminal card: cancelled (grey) — by the operator or a session rebind. */
export function buildSelectorCancelledCard(flow: SelectorFlowRef): Schema2Card {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '🚫 已取消选择' },
      subtitle: { tag: 'plain_text', content: subtitleOf(flow.spec) },
      template: 'grey',
    },
    body: { elements: [{ tag: 'markdown', content: '选择已取消，此卡片仅供留档。' }] },
  }
}

/** Terminal card: the flow expired before any submit (grey). */
export function buildSelectorExpiredCard(flow: SelectorFlowRef): Schema2Card {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '⏳ 选择已过期' },
      subtitle: { tag: 'plain_text', content: subtitleOf(flow.spec) },
      template: 'grey',
    },
    body: { elements: [{ tag: 'markdown', content: '该选择卡片已过期，如仍需要请重新发起。' }] },
  }
}

// ----------------------------------------------------------------- parser --

/** object-or-undefined for optional payload fields. */
function objectOf(raw: unknown): Record<string, unknown> | undefined {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
}

/** The pick a select submit carries in its form_value (`{ pick: <value> }`). */
function pickOfFormValue(formValue: Record<string, unknown> | undefined): string | undefined {
  const pick = formValue === undefined ? undefined : formValue.pick
  return typeof pick === 'string' ? pick : undefined
}

/**
 * Recognize OUR selector submit in a card.action.trigger payload; undefined
 * for anything else. Accepts three shapes defensively — the whole payload
 * (`{ action: {...} }`), the bare action object, or the bare button `value`
 * (whose `action` IS the marker string) — plus an optional explicit button
 * name override. Ladder, same as the other cards:
 * 1. button `value.action` === our marker → flow id (+ pick / cancel);
 * 2. a DIFFERENT string marker → undefined (foreign button — the name
 *    fallback must never fire on it);
 * 3. button `name` prefix fallback (SDK versions may strip values) — the
 *    pick still arrives via `form_value`; a stripped cancel button degrades
 *    to "no pick", which the manager settles as a cancel.
 */
export function parseSelectorAction(data: unknown, buttonName?: string): ParsedSelectorAction | undefined {
  const root = objectOf(data)
  if (root === undefined) return undefined
  let action: Record<string, unknown>
  let buttonValue: Record<string, unknown> | undefined
  let formValue: Record<string, unknown> | undefined
  if (typeof root.action === 'string') {
    // Bare button value — the marker itself, no form context around it.
    action = {}
    buttonValue = root
  } else {
    action = objectOf(root.action) ?? root
    buttonValue = objectOf(action.value)
    formValue = objectOf(action.form_value)
  }
  if (buttonValue !== undefined) {
    const marker = buttonValue.action
    if (marker === SELECTOR_ACTION) {
      const flowId = buttonValue.flow_id
      if (typeof flowId !== 'string' || flowId === '') return undefined
      if (buttonValue.cancel === true) return { flowId, cancel: true }
      const pick = typeof buttonValue.pick === 'string' ? buttonValue.pick : pickOfFormValue(formValue)
      return pick === undefined ? { flowId } : { flowId, pick }
    }
    // A value carrying a DIFFERENT action means this is not our button —
    // the name fallback below must not fire on foreign submits.
    if (typeof marker === 'string') return undefined
  }
  const name = buttonName ?? action.name
  if (typeof name === 'string' && name.startsWith(SELECTOR_NAME_PREFIX)) {
    const flowId = name.slice(SELECTOR_NAME_PREFIX.length)
    if (flowId === '') return undefined
    const pick = pickOfFormValue(formValue)
    return pick === undefined ? { flowId } : { flowId, pick }
  }
  return undefined
}
