import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SelectorManager } from '../lib/selector.js'
import { SELECTOR_ACTION } from '../lib/selector-card.js'

const SPEC = {
  title: '挑选一个分支',
  options: [
    { value: 'main', label: 'Main' },
    { value: 'dev', label: 'Dev' },
    { value: 'exp', label: 'Experiment' },
  ],
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

/** Manager over an inline LarkGateway subset (no SDK mocking — lib contract). */
function makeManager(overrides = {}) {
  const sent = []
  const patches = []
  const warns = []
  const deps = {
    async sendCard(_chatId, card) { sent.push({ id: `m${sent.length + 1}`, card }); return `m${sent.length}` },
    async patchCard(id, card) { patches.push({ id, card }); return true },
    allowlisted: openId => openId === 'ou_op',
    logger: { info() {}, warn(message) { warns.push(message) }, error() {} },
    ...overrides,
  }
  const manager = new SelectorManager(deps)
  return { manager, sent, patches, warns, deps }
}

/** The flow id of a select-mode selector card captured by the fake send. */
function flowIdOf(card) {
  const form = card.body.elements.find(e => e.tag === 'form')
  return form.elements.at(-1).value.flow_id
}

test('present sends the card; an operator pick resolves picked and patches the green terminal card', async () => {
  const { manager, sent, patches } = makeManager()
  const pending = manager.present('oc1', SPEC)
  await tick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].card.header.template, 'blue')
  assert.equal(manager.pendingCount, 1)

  manager.handleAction({ flowId: flowIdOf(sent[0].card), pick: 'dev' }, 'ou_op')

  assert.deepEqual(await pending, { status: 'picked', value: 'dev', label: 'Dev' })
  await tick()
  assert.equal(patches.length, 1)
  assert.equal(patches[0].id, 'm1')
  assert.equal(patches[0].card.header.template, 'green')
  assert.ok(JSON.stringify(patches[0].card).includes('Dev'))
  assert.equal(manager.pendingCount, 0)
})

test('the cancel button settles the flow as cancelled with a grey card', async () => {
  const { manager, sent, patches } = makeManager()
  const pending = manager.present('oc1', { ...SPEC, mode: 'buttons' })
  await tick()
  const cancel = sent[0].card.body.elements.filter(e => e.tag === 'button').at(-1)
  assert.equal(cancel.value.cancel, true)

  manager.handleAction({ flowId: cancel.value.flow_id, cancel: true }, 'ou_op')

  assert.deepEqual(await pending, { status: 'cancelled' })
  await tick()
  assert.equal(patches.length, 1)
  assert.equal(patches[0].card.header.template, 'grey')
})

test('a pick matching no option is treated as a cancel and warned', async () => {
  const { manager, sent, patches, warns } = makeManager()
  const pending = manager.present('oc1', SPEC)
  await tick()
  manager.handleAction({ flowId: flowIdOf(sent[0].card), pick: 'ghost' }, 'ou_op')
  assert.deepEqual(await pending, { status: 'cancelled' })
  await tick()
  assert.equal(patches.length, 1)
  assert.equal(patches[0].card.header.template, 'grey')
  assert.equal(warns.length, 1)
})

test('non-operators are ignored silently — the flow stays pending and settleable', async () => {
  const { manager, sent, patches } = makeManager()
  const pending = manager.present('oc1', SPEC)
  await tick()
  const flowId = flowIdOf(sent[0].card)

  manager.handleAction({ flowId, pick: 'main' }, 'ou_stranger')
  manager.handleAction({ flowId, pick: 'main' }, undefined)

  let settled = false
  void pending.then(() => { settled = true })
  await tick()
  assert.equal(settled, false, 'a stranger cannot settle the flow')
  assert.equal(patches.length, 0)
  assert.equal(manager.pendingCount, 1)
  // The legitimate operator can still settle it afterwards.
  manager.handleAction({ flowId, pick: 'exp' }, 'ou_op')
  assert.deepEqual(await pending, { status: 'picked', value: 'exp', label: 'Experiment' })
})

test('unknown and replayed flowIds are no-ops (exactly-once settle, one patch)', async () => {
  const { manager, sent, patches } = makeManager()
  const pending = manager.present('oc1', SPEC)
  await tick()
  const flowId = flowIdOf(sent[0].card)

  manager.handleAction({ flowId: 'no-such-flow', pick: 'main' }, 'ou_op') // unknown → no-op
  manager.handleAction({ flowId, pick: 'main' }, 'ou_op')
  assert.deepEqual(await pending, { status: 'picked', value: 'main', label: 'Main' })

  manager.handleAction({ flowId, pick: 'dev' }, 'ou_op') // replay → no-op
  manager.handleAction({ flowId, cancel: true }, 'ou_op')
  await tick()
  assert.equal(patches.length, 1)
  assert.equal(manager.pendingCount, 0)
})

test('TTL expiry resolves expired and patches the grey terminal card (injected sleep)', async () => {
  const gates = []
  const { manager, sent, patches } = makeManager({
    sleep: () => new Promise(resolve => gates.push(resolve)),
  })
  const pending = manager.present('oc1', SPEC)
  await tick()
  assert.equal(sent.length, 1)
  assert.equal(manager.pendingCount, 1)

  gates[0]() // fire the TTL

  assert.deepEqual(await pending, { status: 'expired' })
  await tick()
  assert.equal(patches.length, 1)
  assert.equal(patches[0].card.header.template, 'grey')
  assert.ok(JSON.stringify(patches[0].card).includes('过期'))
  assert.equal(manager.pendingCount, 0)
  // A late submit after expiry is a silent no-op.
  manager.handleAction({ flowId: flowIdOf(sent[0].card), pick: 'dev' }, 'ou_op')
  await tick()
  assert.equal(patches.length, 1)
})

test('an early settle cancels the pending TTL (fired timer is a no-op)', async () => {
  const gates = []
  const { manager, sent, patches } = makeManager({
    sleep: () => new Promise(resolve => gates.push(resolve)),
  })
  const pending = manager.present('oc1', SPEC)
  await tick()
  manager.handleAction({ flowId: flowIdOf(sent[0].card), pick: 'main' }, 'ou_op')
  assert.deepEqual(await pending, { status: 'picked', value: 'main', label: 'Main' })

  gates[0]() // the expired timer still fires afterwards — must not settle twice

  await tick()
  assert.equal(patches.length, 1)
  assert.equal(patches[0].card.header.template, 'green')
})

test('sendCard resolving undefined rejects present and removes the flow', async () => {
  const { manager } = makeManager({ sendCard: async () => undefined })
  await assert.rejects(manager.present('oc1', SPEC), /could not be delivered/)
  assert.equal(manager.pendingCount, 0)
})

test('sendCard throwing rejects instead of escaping', async () => {
  const { manager } = makeManager({ sendCard: async () => { throw new Error('transport down') } })
  await assert.rejects(manager.present('oc1', SPEC), /transport down/)
  assert.equal(manager.pendingCount, 0)
})

test('cancelAll settles every pending flow as cancelled and patches each card', async () => {
  const { manager, sent, patches } = makeManager()
  const p1 = manager.present('oc1', SPEC)
  const p2 = manager.present('oc2', SPEC)
  await tick()
  assert.equal(sent.length, 2)
  assert.equal(manager.pendingCount, 2)

  manager.cancelAll('test teardown')

  assert.deepEqual(await p1, { status: 'cancelled' })
  assert.deepEqual(await p2, { status: 'cancelled' })
  await tick()
  assert.equal(patches.length, 2)
  assert.ok(patches.every(p => p.card.header.template === 'grey'))
  assert.equal(manager.pendingCount, 0)
})

test('a flow settled while its send was still in flight dismisses the stray card', async () => {
  // The send resolves only after cancelAll already settled the flow.
  let releaseSend
  const { manager, sent, patches } = makeManager({
    sendCard: (_chatId, card) => new Promise(resolve => { sent.push({ card }); releaseSend = () => resolve('m1') }),
  })
  const pending = manager.present('oc1', SPEC)
  await tick()
  manager.cancelAll()
  assert.deepEqual(await pending, { status: 'cancelled' })

  releaseSend() // the messageId arrives late
  await tick()
  assert.equal(patches.length, 1)
  assert.equal(patches[0].id, 'm1')
  assert.equal(patches[0].card.header.template, 'grey')
})

test('marker sanity: the selector marker does not collide with the other cards', async () => {
  assert.equal(SELECTOR_ACTION, 'dsh_feishu_sel')
  for (const foreign of ['dsh_feishu_resume', 'dsh_feishu_model_provider', 'dsh_feishu_model_submit', 'dsh_feishu_ask_submit']) {
    assert.notEqual(SELECTOR_ACTION, foreign)
  }
})

test('an aborted spec signal settles the flow as cancelled and patches the grey card', async () => {
  const { manager, patches } = makeManager()
  const controller = new AbortController()
  const pending = manager.present('oc_1', { ...SPEC, signal: controller.signal })
  await tick()
  controller.abort()
  const outcome = await pending
  assert.deepEqual(outcome, { status: 'cancelled' })
  assert.match(patches.at(-1).card.header.title.content, /已取消/)
  assert.equal(manager.pendingCount, 0)
})
