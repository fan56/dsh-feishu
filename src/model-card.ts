/**
 * /model interactive selection cards: two-step flow — pick a provider, then
 * pick one of its models. Pure builders/parsers over the llm service's
 * provider/model metadata; same card.action.trigger mechanics as the ask
 * and resume cards (submit buttons MUST carry a `value` — 200340).
 *
 * Applying the choice is the bot's job: live-switch when the bound session
 * carries a bot-owned selection ref, otherwise store it as the phone-side
 * default for future /new sessions.
 */

import type { Schema2Card } from './card.ts'

/** Marker for the provider-step submit button's `value.action`. */
export const MODEL_PROVIDER_ACTION = 'dsh_feishu_model_provider'

/** Marker for the model-step submit button's `value.action`. */
export const MODEL_SUBMIT_ACTION = 'dsh_feishu_model_submit'

const PROVIDER_SUBMIT_NAME_PREFIX = 'dsh_feishu_model_provider_'
const MODEL_SUBMIT_NAME_PREFIX = 'dsh_feishu_model_submit_'

/** Minimal provider/model metadata the cards render (llm service shapes). */
export interface ModelProviderInfo {
  readonly id: string
  readonly name: string
}

export interface ModelInfo {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One recognized provider-step submit. */
export interface ParsedModelProviderAction {
  readonly provider: string
  readonly flowId: string
}

/** One recognized model-step submit. */
export interface ParsedModelSubmitAction {
  readonly flowId: string
  readonly model: string
}

/**
 * Recognize the provider-step submit: button `value` carries our action
 * marker + the provider id; the button `name` doubles as the fallback id
 * carrier. Undefined for anything else.
 */
export function parseModelProviderAction(data: unknown): ParsedModelProviderAction | undefined {
  const action = actionOf(data)
  if (action === undefined) return undefined
  const formValue = objectOf((action as { form_value?: unknown }).form_value)
  const provider = formValue === undefined ? undefined : (formValue as { provider?: unknown }).provider
  if (typeof provider !== 'string' || provider === '') return undefined
  const flowId = flowIdOf(action, MODEL_PROVIDER_ACTION, PROVIDER_SUBMIT_NAME_PREFIX)
  return flowId === undefined ? undefined : { provider, flowId }
}

/**
 * Recognize the model-step submit: button `value` carries our action marker
 * + the flow id; the model itself arrives in `form_value.model`.
 */
export function parseModelSubmitAction(data: unknown): ParsedModelSubmitAction | undefined {
  const action = actionOf(data)
  if (action === undefined) return undefined
  const formValue = objectOf((action as { form_value?: unknown }).form_value)
  const model = formValue === undefined ? undefined : (formValue as { model?: unknown }).model
  if (typeof model !== 'string' || model === '') return undefined
  const flowId = flowIdOf(action, MODEL_SUBMIT_ACTION, MODEL_SUBMIT_NAME_PREFIX)
  return flowId === undefined ? undefined : { flowId, model }
}

/**
 * The submit button's flow id: `value.flow_id` first (our marker must
 * match), then the button `name` prefix (SDK versions may strip values).
 * A value carrying a DIFFERENT action means a foreign button — undefined.
 */
function flowIdOf(action: Record<string, unknown>, marker: string, namePrefix: string): string | undefined {
  const buttonValue = objectOf((action as { value?: unknown }).value)
  const valueMarker = buttonValue === undefined ? undefined : (buttonValue as { action?: unknown }).action
  const flowId = buttonValue === undefined ? undefined : (buttonValue as { flow_id?: unknown }).flow_id
  if (valueMarker === marker && typeof flowId === 'string' && flowId !== '') return flowId
  if (typeof valueMarker === 'string') return undefined // foreign action
  const name = (action as { name?: unknown }).name
  if (typeof name === 'string' && name.startsWith(namePrefix)) {
    const id = name.slice(namePrefix.length)
    if (id !== '') return id
  }
  return undefined
}

/** The action object of a card.action.trigger payload, or undefined. */
function actionOf(data: unknown): Record<string, unknown> | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const action = (data as { action?: unknown }).action
  return action !== null && typeof action === 'object' ? (action as Record<string, unknown>) : undefined
}

/** object-or-undefined for optional payload fields. */
function objectOf(raw: unknown): Record<string, unknown> | undefined {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
}

/** Step-1 card: pick a provider (dropdown + submit), current route shown. */
export function buildModelProviderCard(
  providers: readonly ModelProviderInfo[],
  flowId: string,
  current?: { provider?: string; model?: string },
): Schema2Card {
  const options = providers.map(provider => ({
    text: { tag: 'plain_text', content: provider.name === provider.id ? provider.id : `${provider.name} (${provider.id})` },
    value: provider.id,
  }))
  const currentLine = current?.provider !== undefined && current?.model !== undefined
    ? `当前：**${current.provider} / ${current.model}**\n`
    : ''
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '🎛 选择模型 · 1/2 Provider' },
      subtitle: { tag: 'plain_text', content: 'dsh · 共 ' + providers.length + ' 个 provider' },
      template: 'blue',
    },
    body: {
      elements: [
        { tag: 'markdown', content: currentLine + '选择 provider，下一步选模型。' },
        {
          tag: 'form',
          name: 'dsh_feishu_model_provider_form',
          elements: [
            {
              tag: 'select_static',
              name: 'provider',
              placeholder: { tag: 'plain_text', content: '请选择 provider…' },
              options,
            },
            {
              tag: 'button',
              name: `${PROVIDER_SUBMIT_NAME_PREFIX}${flowId}`,
              value: { action: MODEL_PROVIDER_ACTION, flow_id: flowId },
              text: { tag: 'plain_text', content: '下一步' },
              type: 'primary',
              form_action_type: 'submit',
            },
          ],
        },
      ],
    },
  }
}

/**
 * Step-2 card: pick one of the provider's models. The provider rides in the
 * submit `value` so the handler does not need to remember it.
 */
export function buildModelPickCard(
  provider: string,
  models: readonly ModelInfo[],
  flowId: string,
): Schema2Card {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '🎛 选择模型 · 2/2 Model' },
      subtitle: { tag: 'plain_text', content: `dsh · ${provider} · 共 ${models.length} 个模型` },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'form',
          name: 'dsh_feishu_model_form',
          elements: [
            {
              tag: 'select_static',
              name: 'model',
              placeholder: { tag: 'plain_text', content: '请选择模型…' },
              options: models.map(model => ({
                text: { tag: 'plain_text', content: model.name === model.id ? model.id : `${model.name} (${model.id})` },
                value: model.id,
              })),
            },
            {
              tag: 'button',
              name: `${MODEL_SUBMIT_NAME_PREFIX}${flowId}`,
              value: { action: MODEL_SUBMIT_ACTION, flow_id: flowId, provider },
              text: { tag: 'plain_text', content: '✅ 切换' },
              type: 'primary',
              form_action_type: 'submit',
            },
          ],
        },
      ],
    },
  }
}

/** Terminal card: the selection was applied (green). */
export function buildModelSettledCard(provider: string, model: string, note?: string): Schema2Card {
  const noteLine = note === undefined ? '' : `\n${note}`
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '✅ 模型已切换' },
      subtitle: { tag: 'plain_text', content: `dsh · ${provider}` },
      template: 'green',
    },
    body: { elements: [{ tag: 'markdown', content: `**${provider} / ${model}**${noteLine}` }] },
  }
}
