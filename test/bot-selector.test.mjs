import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FeishuBot } from '../lib/bot.js'

const SPEC = {
  title: '挑选回滚策略',
  options: [
    { value: 'revert', label: 'Revert' },
    { value: 'fix', label: 'Fix forward' },
  ],
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

/** Minimal FeishuBot with faked deps; private internals are driven directly. */
function selectorBot(lark, allowlist = new Set(['ou_op'])) {
  const state = { lastChatId: 'oc_test', displayThink: false }
  return new FeishuBot({
    ctx: { logger: { info() {}, warn() {}, error() {} } },
    config: { statusIntervalMs: 30000, bodySegmentChars: 3500 },
    lark,
    binder: { getSessionId: () => 's1', isReadOnlyView: () => false },
    store: { ready: async () => {}, get: () => state, update: async () => {} },
    allowlist,
    now: () => 1000,
  })
}

test('presentSelection sends through the card chain; onCardAction routes the submit to the flow', async () => {
  const sends = []
  const patches = []
  const bot = selectorBot({
    async sendCard(_c, card) { sends.push({ id: `m${sends.length + 1}`, card }); return `m${sends.length}` },
    async patchCard(id, card) { patches.push({ id, card }); return true },
  })
  const pending = bot.presentSelection('oc_test', SPEC)
  await tick()
  assert.equal(sends.length, 1)
  assert.equal(sends[0].card.header.title.content, '挑选回滚策略')
  const form = sends[0].card.body.elements.find(e => e.tag === 'form')
  const flowId = form.elements.at(-1).value.flow_id

  bot.onCardAction({
    operator: { open_id: 'ou_op' },
    action: {
      tag: 'button',
      name: `dsh_feishu_sel_${flowId}`,
      value: { action: 'dsh_feishu_sel', flow_id: flowId },
      form_value: { pick: 'fix' },
    },
  })

  assert.deepEqual(await pending, { status: 'picked', value: 'fix', label: 'Fix forward' })
  await tick()
  assert.equal(patches.length, 1)
  assert.equal(patches[0].id, 'm1')
  assert.equal(patches[0].card.header.template, 'green')
  assert.equal(bot.selectors.pendingCount, 0)
})

test('selector submits from non-operators are ignored, the flow stays pending', async () => {
  const sends = []
  const bot = selectorBot({
    async sendCard(_c, card) { sends.push({ id: `m${sends.length + 1}`, card }); return `m${sends.length}` },
    async patchCard() { return true },
  })
  const pending = bot.presentSelection('oc_test', SPEC)
  await tick()
  const flowId = sends[0].card.body.elements.find(e => e.tag === 'form').elements.at(-1).value.flow_id

  bot.onCardAction({
    operator: { open_id: 'ou_stranger' },
    action: { tag: 'button', value: { action: 'dsh_feishu_sel', flow_id: flowId }, form_value: { pick: 'revert' } },
  })
  bot.onCardAction({
    operator: { open_id: 'ou_op' },
    action: { tag: 'button', value: { action: 'dsh_feishu_sel', flow_id: 'no-such-flow' }, form_value: { pick: 'revert' } },
  })

  let settled = false
  void pending.then(() => { settled = true })
  await tick()
  assert.equal(settled, false)
  assert.equal(bot.selectors.pendingCount, 1)

  bot.onCardAction({
    operator: { open_id: 'ou_op' },
    action: { tag: 'button', value: { action: 'dsh_feishu_sel', flow_id: flowId }, form_value: { pick: 'revert' } },
  })
  assert.deepEqual(await pending, { status: 'picked', value: 'revert', label: 'Revert' })
})

test('resetRunView cancels pending selection flows', async () => {
  const sends = []
  const patches = []
  const bot = selectorBot({
    async sendCard(_c, card) { sends.push({ id: `m${sends.length + 1}`, card }); return `m${sends.length}` },
    async patchCard(id, card) { patches.push({ id, card }); return true },
  })
  const pending = bot.presentSelection('oc_test', SPEC)
  await tick()
  assert.equal(bot.selectors.pendingCount, 1)

  bot.resetRunView()

  assert.deepEqual(await pending, { status: 'cancelled' })
  await tick()
  assert.equal(patches.length, 1)
  assert.equal(patches[0].card.header.template, 'grey')
  assert.equal(bot.selectors.pendingCount, 0)
})
