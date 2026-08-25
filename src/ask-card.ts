/**
 * Ask-user interactive card: pure builders/parsers for the Feishu side of
 * dsh's `ctx.userQuestions` protocol. One form card per ask request — every
 * control is value-less (no per-component callbacks, no loading flicker);
 * the single submit button carries the question id in BOTH `name` and
 * `value` and delivers all answers at once via `form_value`.
 *
 * Hard-won constraints baked in (see the research doc):
 * - the submit button MUST carry a `value` — the Feishu client rejects
 *   value-less interactive components with 200340 and never delivers the
 *   callback;
 * - `name` doubles as the fallback id carrier (some SDK versions strip
 *   `value` from form submits);
 * - schema V2 cards must not contain `note` elements (server 200861).
 */

import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { Schema2Card } from './card.ts'

/** Marker written into the submit button's `value.action`. */
export const ASK_SUBMIT_ACTION = 'dsh_feishu_ask_submit'

/** Submit button name prefix; the question id rides after it. */
const SUBMIT_NAME_PREFIX = 'dsh_feishu_ask_submit_'

/** Form control name for question index i. */
function fieldName(i: number): string {
  return `q_${i}`
}

/** One recognized card.action.trigger payload for our submit button. */
export interface ParsedAskAction {
  readonly questionId: string
  readonly formValue: Record<string, unknown>
}

/**
 * Recognize OUR submit action in a `card.action.trigger` payload; undefined
 * for anything else (other buttons, foreign cards). Defensive — malformed
 * payloads degrade to undefined, never throw.
 */
export function parseAskAction(data: unknown): ParsedAskAction | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const action = (data as { action?: unknown }).action
  if (action === null || typeof action !== 'object') return undefined
  const formValue = (action as { form_value?: unknown }).form_value
  const value = formValue === null || typeof formValue === 'object' && !Array.isArray(formValue)
    ? (formValue ?? {}) as Record<string, unknown>
    : {}
  // Primary: the button's value carries our action marker + question id.
  const buttonValue = (action as { value?: unknown }).value
  if (buttonValue !== null && typeof buttonValue === 'object') {
    const marker = (buttonValue as { action?: unknown }).action
    const questionId = (buttonValue as { question_id?: unknown }).question_id
    if (marker === ASK_SUBMIT_ACTION && typeof questionId === 'string' && questionId !== '') {
      return { questionId, formValue: value }
    }
  }
  // Fallback: the button name (SDK versions may strip value on form submits).
  const name = (action as { name?: unknown }).name
  if (typeof name === 'string' && name.startsWith(SUBMIT_NAME_PREFIX)) {
    const questionId = name.slice(SUBMIT_NAME_PREFIX.length)
    if (questionId !== '') return { questionId, formValue: value }
  }
  return undefined
}

/** Outcome of parsing a submitted form against the asked questions. */
export type AskParseResult =
  | { readonly kind: 'answers'; readonly answers: AskUserQuestionAnswerItem[] }
  | { readonly kind: 'missing'; readonly missing: string[] }

/**
 * Parse `form_value` into the dsh answer shape. Selects arrive as the option
 * label (single: string, multi: array); free-text inputs become `custom`
 * answers with an empty selection. A question with no usable value lands in
 * `missing` (headers preferred for the reminder list).
 */
export function parseAskFormValue(
  questions: readonly AskUserQuestionItem[],
  formValue: Record<string, unknown>,
): AskParseResult {
  const answers: AskUserQuestionAnswerItem[] = []
  const missing: string[] = []
  questions.forEach((question, i) => {
    const raw = formValue[fieldName(i)]
    if (Array.isArray(raw)) {
      const selected = raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      if (selected.length > 0) {
        answers.push({ id: question.id, selected })
        return
      }
    } else if (typeof raw === 'string' && raw.trim() !== '') {
      const text = raw.trim()
      if ((question.options?.length ?? 0) > 0) answers.push({ id: question.id, selected: [text] })
      else answers.push({ id: question.id, selected: [], custom: text })
      return
    }
    missing.push(question.header ?? question.question)
  })
  return missing.length > 0 ? { kind: 'missing', missing } : { kind: 'answers', answers }
}

// ------------------------------------------------------------------ cards --

/** Interactive control for one question (value-less; form collects on submit). */
function controlFor(question: AskUserQuestionItem, i: number): Record<string, unknown> {
  const name = fieldName(i)
  if ((question.options?.length ?? 0) === 0) {
    return {
      tag: 'input',
      name,
      placeholder: { tag: 'plain_text', content: '输入回答…' },
    }
  }
  const options = question.options!.map(option => ({
    text: { tag: 'plain_text', content: option.label },
    value: option.label,
  }))
  return question.multiSelect === true
    ? {
      tag: 'multi_select_static',
      name,
      placeholder: { tag: 'plain_text', content: '可多选…' },
      options,
    }
    : {
      tag: 'select_static',
      name,
      placeholder: { tag: 'plain_text', content: '请选择…' },
      options,
    }
}

/** Render one question's answer line for the terminal cards. */
function answerText(question: AskUserQuestionItem, answer: AskUserQuestionAnswerItem | undefined): string {
  if (answer === undefined) return '—'
  if (answer.custom !== undefined && answer.custom !== '') return answer.custom
  return answer.selected.join('、')
}

/**
 * The interactive ask card (blue, 待回答): one form container holding every
 * question's label + control and the single primary submit button.
 */
export function buildAskCard(questions: readonly AskUserQuestionItem[], questionId: string): Schema2Card {
  const elements: Array<Record<string, unknown>> = []
  questions.forEach((question, i) => {
    if (i > 0) elements.push({ tag: 'hr' })
    if (question.header !== undefined && question.header !== '') {
      elements.push({ tag: 'markdown', content: `**${question.header}**` })
    }
    elements.push({ tag: 'markdown', content: question.question })
    if (question.detail !== undefined && question.detail !== '') {
      elements.push({ tag: 'markdown', content: question.detail, text_size: 'notation' })
    }
    elements.push(controlFor(question, i))
    const descriptions = (question.options ?? [])
      .filter(option => option.description !== undefined && option.description !== '')
      .map(option => `- **${option.label}**: ${option.description}`)
    if (descriptions.length > 0) {
      elements.push({ tag: 'markdown', content: descriptions.join('\n'), text_size: 'notation' })
    }
  })
  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'button',
    name: `${SUBMIT_NAME_PREFIX}${questionId}`,
    // value MUST exist: the Feishu client rejects value-less interactive
    // components with 200340 and the callback is never delivered.
    value: { action: ASK_SUBMIT_ACTION, question_id: questionId },
    text: { tag: 'plain_text', content: '📮 提交' },
    type: 'primary',
    form_action_type: 'submit',
  })
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '🙋 需要你的确认' },
      subtitle: { tag: 'plain_text', content: `dsh · 共 ${questions.length} 个问题` },
      template: 'blue',
    },
    body: { elements: [{ tag: 'form', name: 'dsh_feishu_ask_form', elements }] },
  }
}

/** Terminal card: answered (green) — every question with its chosen answer. */
export function buildAskAnsweredCard(questions: readonly AskUserQuestionItem[], answers: readonly AskUserQuestionAnswerItem[]): Schema2Card {
  const byId = new Map(answers.map(answer => [answer.id, answer]))
  const elements: Array<Record<string, unknown>> = questions.map((question, i) => {
    const line = `**${question.header ?? question.question}** · ✅ ${answerText(question, byId.get(question.id))}`
    return i === 0 ? { tag: 'markdown', content: line } : { tag: 'markdown', content: line }
  })
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '✅ 已收到回答' },
      subtitle: { tag: 'plain_text', content: `dsh · 共 ${questions.length} 个问题` },
      template: 'green',
    },
    body: { elements },
  }
}

/** Why an ask card left the interactive state without an answer from here. */
export type AskDismissReason = 'elsewhere' | 'cancelled'

/** Terminal card: dismissed (grey) — answered on another surface or aborted. */
export function buildAskDismissedCard(questions: readonly AskUserQuestionItem[], reason: AskDismissReason, by: string): Schema2Card {
  const note = reason === 'elsewhere'
    ? `已由 **${by}** 回答，此卡片自动收起。`
    : '提问已被取消（turn 中止或超时），此卡片自动收起。'
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: reason === 'elsewhere' ? '🙋 已在其他端回答' : '⏹ 提问已取消' },
      subtitle: { tag: 'plain_text', content: `dsh · 共 ${questions.length} 个问题` },
      template: 'grey',
    },
    body: { elements: [{ tag: 'markdown', content: note }] },
  }
}
