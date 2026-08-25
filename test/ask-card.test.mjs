import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ASK_SUBMIT_ACTION,
  buildAskAnsweredCard,
  buildAskCard,
  buildAskDismissedCard,
  parseAskAction,
  parseAskFormValue,
} from '../lib/ask-card.js'

const questions = () => [
  { id: 'q1', question: 'Which fruit?', header: 'Fruit', options: [{ label: 'apple', description: 'red' }, { label: 'banana' }] },
  { id: 'q2', question: 'Anything to add?', header: 'Notes' },
  { id: 'q3', question: 'Pick tools', header: 'Tools', multiSelect: true, options: [{ label: 'bash' }, { label: 'read' }] },
]

function triggerPayload(overrides = {}) {
  return {
    operator: { open_id: 'ou_op' },
    context: { open_chat_id: 'oc_x' },
    action: { tag: 'button', name: 'dsh_feishu_ask_submit_id-123', value: { action: ASK_SUBMIT_ACTION, question_id: 'id-123' }, form_value: {} },
    ...overrides,
  }
}

test('parseAskAction recognizes our submit via the button value marker', () => {
  const parsed = parseAskAction(triggerPayload({
    action: { tag: 'button', name: 'dsh_feishu_ask_submit_id-123', value: { action: ASK_SUBMIT_ACTION, question_id: 'id-123' }, form_value: { q_0: 'apple' } },
  }))
  assert.deepEqual(parsed, { questionId: 'id-123', formValue: { q_0: 'apple' } })
})

test('parseAskAction falls back to the button name when value is stripped', () => {
  const action = { tag: 'button', name: 'dsh_feishu_ask_submit_id-456', form_value: { q_0: 'x' } } // no value
  const parsed = parseAskAction(triggerPayload({ action }))
  assert.deepEqual(parsed, { questionId: 'id-456', formValue: { q_0: 'x' } })
})

test('parseAskAction ignores foreign actions and malformed payloads', () => {
  assert.equal(parseAskAction({ action: { tag: 'button', value: { action: 'something_else' } } }), undefined)
  assert.equal(parseAskAction({ action: { tag: 'button', name: 'other_prefix_1' } }), undefined)
  assert.equal(parseAskAction(null), undefined)
  assert.equal(parseAskAction('nope'), undefined)
  assert.equal(parseAskAction({}), undefined)
})

test('parseAskFormValue maps selects, custom text and multi-selects; blanks land in missing', () => {
  const result = parseAskFormValue(questions(), {
    q_0: 'apple',
    q_1: 'make it spicy',
    q_2: ['bash', 'read'],
  })
  assert.equal(result.kind, 'answers')
  assert.deepEqual(result.answers, [
    { id: 'q1', selected: ['apple'] },
    { id: 'q2', selected: [], custom: 'make it spicy' },
    { id: 'q3', selected: ['bash', 'read'] },
  ])

  const partial = parseAskFormValue(questions(), { q_0: 'banana' })
  assert.equal(partial.kind, 'missing')
  assert.deepEqual(partial.missing, ['Notes', 'Tools'])
})

test('buildAskCard: form container, per-question controls, submit button carries value (200340 guard)', () => {
  const card = buildAskCard(questions(), 'id-9')
  assert.equal(card.schema, '2.0')
  assert.equal(card.header.template, 'blue')
  const form = card.body.elements[0]
  assert.equal(form.tag, 'form')
  const submit = form.elements.at(-1)
  assert.equal(submit.tag, 'button')
  assert.equal(submit.form_action_type, 'submit')
  assert.deepEqual(submit.value, { action: ASK_SUBMIT_ACTION, question_id: 'id-9' })
  assert.equal(submit.name, 'dsh_feishu_ask_submit_id-9')
  // Controls: select for options, input for free text, multi-select flagged.
  const controls = form.elements.filter(e => e.tag === 'select_static' || e.tag === 'input' || e.tag === 'multi_select_static')
  assert.deepEqual(controls.map(c => [c.tag, c.name]), [['select_static', 'q_0'], ['input', 'q_1'], ['multi_select_static', 'q_2']])
  // No note elements anywhere (schema V2 rejects them).
  assert.equal(JSON.stringify(card).includes('"tag":"note"'), false)
})

test('terminal cards: answered green with answers, dismissed grey with a reason', () => {
  const answered = buildAskAnsweredCard(questions(), [{ id: 'q1', selected: ['apple'] }])
  assert.equal(answered.header.template, 'green')
  const body = JSON.stringify(answered)
  assert.ok(body.includes('apple'))

  const elsewhere = buildAskDismissedCard(questions(), 'elsewhere', 'dsh-tui')
  assert.equal(elsewhere.header.template, 'grey')
  assert.ok(JSON.stringify(elsewhere).includes('dsh-tui'))

  const cancelled = buildAskDismissedCard(questions(), 'cancelled', '')
  assert.ok(JSON.stringify(cancelled).includes('取消'))
})
