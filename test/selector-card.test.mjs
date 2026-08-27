import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SELECTOR_ACTION,
  buildSelectorCancelledCard,
  buildSelectorCard,
  buildSelectorExpiredCard,
  buildSelectorSettledCard,
  parseSelectorAction,
} from '../lib/selector-card.js'

const SPEC = {
  title: '选择目标环境',
  description: '请选择要部署的环境。',
  options: [
    { value: 'staging', label: 'Staging', description: '测试环境' },
    { value: 'prod', label: 'Production' },
  ],
}

/** A card.action.trigger payload for a selector submit. */
function payload(overrides = {}) {
  return {
    operator: { open_id: 'ou_op' },
    action: {
      tag: 'button',
      name: 'dsh_feishu_sel_flow-1',
      value: { action: SELECTOR_ACTION, flow_id: 'flow-1' },
      form_value: {},
      ...overrides,
    },
  }
}

/** Every button element in the card body (form containers included). */
function buttonsOf(card) {
  const found = []
  const visit = node => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (node.tag === 'button') found.push(node)
    for (const value of Object.values(node)) visit(value)
  }
  visit(card.body.elements)
  return found
}

function formOf(card) {
  return card.body.elements.find(e => e.tag === 'form')
}

// ------------------------------------------------------------------ builder --

test('select mode builds a schema 2.0 form card whose submit carries a value (200340 guard)', () => {
  const card = buildSelectorCard({ id: 'flow-1', spec: SPEC })
  assert.equal(card.schema, '2.0')
  assert.equal(card.header.template, 'blue')
  assert.equal(card.header.title.content, '选择目标环境')
  assert.equal(JSON.stringify(card).includes('"tag":"note"'), false)

  const form = formOf(card)
  assert.equal(form.name, 'dsh_feishu_selector_form')
  const [select, submit] = form.elements
  assert.equal(select.tag, 'select_static')
  assert.deepEqual(select.options.map(o => o.value), ['staging', 'prod'])
  assert.equal(select.options[0].text.content, 'Staging — 测试环境')
  assert.equal(select.options[1].text.content, 'Production')

  assert.equal(submit.tag, 'button')
  assert.equal(submit.form_action_type, 'submit')
  assert.deepEqual(submit.value, { action: SELECTOR_ACTION, flow_id: 'flow-1' })
  assert.equal(submit.name, 'dsh_feishu_sel_flow-1')
  // Every button carries a value — the 200340 rejection is client-side.
  for (const button of buttonsOf(card)) assert.notEqual(button.value, undefined)
})

test('buttons mode renders one immediate button per option plus a cancel button', () => {
  const card = buildSelectorCard({ id: 'flow-2', spec: { ...SPEC, mode: 'buttons' } })
  assert.equal(formOf(card), undefined) // no form container
  assert.equal(JSON.stringify(card).includes('"tag":"note"'), false)
  const buttons = card.body.elements.filter(e => e.tag === 'button')
  assert.deepEqual(buttons.map(b => b.value.action), [SELECTOR_ACTION, SELECTOR_ACTION, SELECTOR_ACTION])
  assert.deepEqual(buttons.map(b => b.value.flow_id), ['flow-2', 'flow-2', 'flow-2'])
  assert.deepEqual(buttons.map(b => b.value.pick), ['staging', 'prod', undefined])
  assert.equal(buttons.at(-1).value.cancel, true)
  for (const button of buttons) assert.notEqual(button.value, undefined)
})

test('options past 50 are truncated instead of risking a rejected card', () => {
  const options = Array.from({ length: 60 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }))
  const selectCard = buildSelectorCard({ id: 'f', spec: { title: 't', options } })
  const select = formOf(selectCard).elements[0]
  assert.equal(select.options.length, 50)
  assert.equal(select.options.at(-1).value, 'v49')

  const buttonsCard = buildSelectorCard({ id: 'f', spec: { title: 't', options, mode: 'buttons' } })
  assert.equal(buttonsOf(buttonsCard).length, 51) // 50 picks + cancel
})

test('select option text is clipped to 48 characters with an ellipsis', () => {
  const spec = { title: 't', options: [{ value: 'v', label: 'L'.repeat(80), description: 'D'.repeat(80) }] }
  const card = buildSelectorCard({ id: 'f', spec })
  const text = formOf(card).elements[0].options[0].text.content
  assert.ok(text.length <= 48, `option text length ${text.length} exceeds 48`)
  assert.ok(text.endsWith('…'))
})

// ----------------------------------------------------------------- terminal --

test('terminal cards: settled green shows the pick, cancelled/expired grey, none interactive', () => {
  const flow = { id: 'flow-1', spec: SPEC }
  const settled = buildSelectorSettledCard(flow, SPEC.options[0])
  assert.equal(settled.header.template, 'green')
  assert.ok(JSON.stringify(settled).includes('Staging'))
  assert.ok(JSON.stringify(settled).includes('测试环境'))

  const cancelled = buildSelectorCancelledCard(flow)
  assert.equal(cancelled.header.template, 'grey')
  assert.ok(JSON.stringify(cancelled).includes('取消'))

  const expired = buildSelectorExpiredCard(flow)
  assert.equal(expired.header.template, 'grey')
  assert.ok(JSON.stringify(expired).includes('过期'))

  for (const card of [settled, cancelled, expired]) {
    assert.equal(card.schema, '2.0')
    assert.equal(JSON.stringify(card).includes('"tag":"note"'), false)
    assert.equal(buttonsOf(card).length, 0) // no interactive components
  }
})

// ------------------------------------------------------------------- parser --

test('parseSelectorAction recognizes our marker via the payload, bare action and bare value shapes', () => {
  assert.deepEqual(parseSelectorAction(payload()), { flowId: 'flow-1' })
  assert.deepEqual(parseSelectorAction(payload().action), { flowId: 'flow-1' })
  assert.deepEqual(parseSelectorAction({ action: SELECTOR_ACTION, flow_id: 'flow-1' }), { flowId: 'flow-1' })
  // An explicit button-name override does not displace a valid value.
  assert.deepEqual(parseSelectorAction({ action: SELECTOR_ACTION, flow_id: 'flow-1' }, 'dsh_feishu_sel_flow-9'), { flowId: 'flow-1' })
})

test('parseSelectorAction: buttons-mode pick and cancel ride the button value', () => {
  assert.deepEqual(
    parseSelectorAction(payload({ value: { action: SELECTOR_ACTION, flow_id: 'flow-1', pick: 'prod' } })),
    { flowId: 'flow-1', pick: 'prod' },
  )
  assert.deepEqual(
    parseSelectorAction(payload({ value: { action: SELECTOR_ACTION, flow_id: 'flow-1', cancel: true } })),
    { flowId: 'flow-1', cancel: true },
  )
  // Cancel wins when a payload somehow carries both flags.
  assert.deepEqual(
    parseSelectorAction(payload({ value: { action: SELECTOR_ACTION, flow_id: 'flow-1', pick: 'prod', cancel: true } })),
    { flowId: 'flow-1', cancel: true },
  )
})

test('parseSelectorAction: select-mode pick arrives via form_value', () => {
  assert.deepEqual(
    parseSelectorAction(payload({ form_value: { pick: 'staging' } })),
    { flowId: 'flow-1', pick: 'staging' },
  )
})

test('parseSelectorAction falls back to the button name when the value is stripped', () => {
  assert.deepEqual(
    parseSelectorAction(payload({ value: undefined, form_value: { pick: 'prod' } })),
    { flowId: 'flow-1', pick: 'prod' },
  )
  // Name-only submit without form_value → flow id only; the manager degrades
  // a missing pick to a cancel.
  assert.deepEqual(parseSelectorAction(payload({ value: undefined })), { flowId: 'flow-1' })
})

test('parseSelectorAction: the four foreign markers and foreign name prefixes never match', () => {
  for (const marker of ['dsh_feishu_resume', 'dsh_feishu_model_provider', 'dsh_feishu_model_submit', 'dsh_feishu_ask_submit']) {
    assert.equal(parseSelectorAction(payload({ value: { action: marker, flow_id: 'x' } })), undefined)
  }
  assert.equal(parseSelectorAction(payload({ value: undefined, name: 'dsh_feishu_ask_submit_x' })), undefined)
  assert.equal(parseSelectorAction(payload({ value: undefined, name: 'dsh_feishu_resume_submit_x' })), undefined)
})

test('parseSelectorAction: garbage payloads degrade to undefined, never throw', () => {
  assert.equal(parseSelectorAction(null), undefined)
  assert.equal(parseSelectorAction('nope'), undefined)
  assert.equal(parseSelectorAction(42), undefined)
  assert.equal(parseSelectorAction({}), undefined)
  assert.equal(parseSelectorAction({ action: { value: 'string-not-object' } }), undefined)
  assert.equal(parseSelectorAction({ action: { value: { action: 42 } } }), undefined)
  assert.equal(parseSelectorAction(payload({ value: { action: SELECTOR_ACTION } })), undefined) // no flow id
  assert.equal(parseSelectorAction(payload({ value: { action: SELECTOR_ACTION, flow_id: '' } })), undefined)
})
