import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildNewSessionCancelledCard,
  buildNewSessionCard,
  buildNewSessionCreatedCard,
  buildNewSessionExpiredCard,
  buildNewSessionFailedCard,
  newSummaryLines,
  parseNewSessionAction,
} from '../lib/new-card.js'

const SPEC = {
  workspaces: [{ value: '/Users/qingguee/proj', label: 'proj' }],
  defaultWorkspace: '/Users/qingguee/proj',
  presets: [
    { value: 'standard', label: '标准模式 ★' },
    { value: 'ptc', label: 'PTC 模式' },
  ],
  defaultPreset: 'standard',
  models: [
    { value: 'glm-4.7', label: 'GLM-4.7' },
    { value: 'glm-5.3', label: 'GLM-5.3' },
  ],
  defaultModel: 'glm-4.7',
  efforts: [
    { value: 'default', label: '默认' },
    { value: 'high', label: 'High' },
  ],
  defaultEffort: 'high',
  contextLine: 'provider：zhipu · cwd：qingguee',
}

function formOf(card) {
  return card.body.elements.find(element => element.tag === 'form')
}

function submitPayload(card, formValue, extra = {}) {
  const form = formOf(card)
  const submit = form.elements.find(element => element.tag === 'button' && element.form_action_type === 'submit')
  return {
    operator: { open_id: 'ou_op' },
    action: {
      tag: 'button',
      name: submit.name,
      value: { action: 'dsh_feishu_new', ...submit.value, ...extra },
      form_value: formValue,
    },
  }
}

test('buildNewSessionCard renders one form with four dropdowns + preselections', () => {
  const card = buildNewSessionCard(SPEC, 'flow-1')
  assert.equal(card.schema, '2.0')
  const form = formOf(card)
  const selects = form.elements.filter(element => element.tag === 'select_static')
  assert.deepEqual(selects.map(select => select.name), ['workspace', 'preset', 'model', 'effort'])
  assert.equal(selects[0].initial_option, '/Users/qingguee/proj')
  assert.equal(selects[1].initial_option, 'standard')
  assert.equal(selects[2].initial_option, 'glm-4.7')
  assert.equal(selects[3].initial_option, 'high')
  const submit = form.elements.find(element => element.form_action_type === 'submit')
  assert.equal(submit.value.action, 'dsh_feishu_new')
  assert.equal(submit.value.flow_id, 'flow-1')
  assert.ok(submit.value !== undefined && submit.name.includes('flow-1'))
  // Cancel lives OUTSIDE the form with its own cancel flag.
  const cancel = card.body.elements.find(element => element.tag === 'button' && element.value.cancel === true)
  assert.equal(cancel.value.flow_id, 'flow-1')
})

test('fields the bot could not source are omitted; degenerate card stays usable', () => {
  const card = buildNewSessionCard({}, 'flow-2')
  const form = formOf(card)
  assert.equal(form.elements.filter(element => element.tag === 'select_static').length, 0)
  const submit = form.elements.find(element => element.form_action_type === 'submit')
  assert.equal(submit.value.flow_id, 'flow-2')
  assert.match(card.body.elements[0].content, /默认配置/)
})

test('every button name on the card is unique (Feishu 230099 rejects duplicates)', () => {
  const card = buildNewSessionCard(SPEC, 'flow-1')
  const names = []
  const walk = elements => {
    for (const element of elements) {
      if (element.tag === 'form') walk(element.elements)
      else if (element.tag === 'button') names.push(element.name)
    }
  }
  walk(card.body.elements)
  assert.equal(new Set(names).size, names.length)
})

test('parseNewSessionAction reads the four picks from form_value', () => {
  const card = buildNewSessionCard(SPEC, 'flow-1')
  const parsed = parseNewSessionAction(submitPayload(card, { workspace: '/Users/qingguee/proj', preset: 'ptc', model: 'glm-5.3', effort: 'high' }))
  assert.deepEqual(parsed, { flowId: 'flow-1', picks: { workspace: '/Users/qingguee/proj', preset: 'ptc', model: 'glm-5.3', effort: 'high' } })
})

test('parseNewSessionAction: absent keys stay absent (defaults keep)', () => {
  const card = buildNewSessionCard({}, 'flow-3')
  const parsed = parseNewSessionAction(submitPayload(card, {}))
  assert.deepEqual(parsed, { flowId: 'flow-3', picks: {} })
})

test('parseNewSessionAction recognizes the cancel button', () => {
  const card = buildNewSessionCard(SPEC, 'flow-1')
  const cancel = card.body.elements.find(element => element.tag === 'button' && element.value.cancel === true)
  const parsed = parseNewSessionAction({
    operator: { open_id: 'ou_op' },
    action: { tag: 'button', value: cancel.value, form_value: {} },
  })
  assert.deepEqual(parsed, { flowId: 'flow-1', cancelled: true, picks: {} })
})

test('parseNewSessionAction falls back to the button name when value is stripped', () => {
  const card = buildNewSessionCard(SPEC, 'flow-9')
  const form = formOf(card)
  const submit = form.elements.find(element => element.form_action_type === 'submit')
  const parsed = parseNewSessionAction({
    action: {
      name: submit.name,
      form_value: { preset: 'standard' },
    },
  }, submit.name)
  assert.deepEqual(parsed, { flowId: 'flow-9', picks: { preset: 'standard' } })
})

test('parseNewSessionAction ignores foreign buttons', () => {
  assert.equal(parseNewSessionAction({
    action: { value: { action: 'dsh_feishu_ask_submit', flow_id: 'flow-1' }, form_value: {} },
  }), undefined)
  assert.equal(parseNewSessionAction(undefined), undefined)
  assert.equal(parseNewSessionAction({ operator: { open_id: 'x' } }), undefined)
})

test('summary table + terminal cards carry the right shapes', () => {
  const lines = newSummaryLines([{ field: 'Preset', value: 'standard' }, { field: 'Model', value: 'zhipu / glm-4.7' }])
  assert.match(lines, /- \*\*Preset\*\*：standard/)
  assert.match(lines, /- \*\*Model\*\*：zhipu \/ glm-4\.7/)
  // No GFM pipes anywhere — Feishu mobile renders table markdown as raw
  // pipes (reads as mojibake on the phone).
  assert.equal(lines.includes('|'), false)

  const created = buildNewSessionCreatedCard([{ field: 'Preset', value: 'ptc' }], 'abcd1234-ffff')
  assert.equal(created.header.template, 'green')
  assert.match(created.header.title.content, /abcd12/)

  const cancelled = buildNewSessionCancelledCard()
  assert.equal(cancelled.header.template, 'grey')
  const expired = buildNewSessionExpiredCard()
  assert.equal(expired.header.template, 'grey')
  const failed = buildNewSessionFailedCard('registry closed')
  assert.equal(failed.header.template, 'orange')
  assert.match(failed.body.elements[0].content, /registry closed/)
})
