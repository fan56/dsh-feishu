import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NewSessionFlowManager } from '../lib/new-flow.js'

function makeDeps({ sendOk = true } = {}) {
  const sends = []
  const patches = []
  const waits = []
  return {
    sends,
    patches,
    waits,
    deps: {
      async sendCard(_chatId, card) {
        sends.push(card)
        return sendOk ? `m${sends.length}` : undefined
      },
      async patchCard(messageId, card) {
        patches.push({ messageId, card })
        return true
      },
      logger: { warn() {} },
      ttlMs: 1000,
      sleep(ms) {
        return new Promise(resolve => {
          waits.push({ ms, resolve })
        })
      },
    },
  }
}

const SPEC = {
  presets: [{ value: 'standard', label: '标准模式' }],
  defaultPreset: 'standard',
}

/** The flow id a sent config card carries (submit button's value). */
function flowIdOf(card) {
  const form = card.body.elements.find(element => element.tag === 'form')
  const submit = form.elements.find(element => element.form_action_type === 'submit')
  return submit?.value?.flow_id
}

/** present() is async — its send lands a microtask later. */
function flush() {
  return new Promise(resolve => setImmediate(resolve))
}

test('present sends the config card and resolves on submit with picks + messageId', async () => {
  const { deps, sends, patches } = makeDeps()
  const flow = new NewSessionFlowManager(deps)
  const pending = flow.present('oc_test', SPEC)
  await flush()
  assert.equal(sends.length, 1)
  const flowId = flowIdOf(sends[0])
  assert.equal(typeof flowId, 'string')
  flow.handleAction({ flowId, picks: { preset: 'ptc' } })
  const outcome = await pending
  assert.equal(outcome.status, 'submitted')
  assert.deepEqual(outcome.picks, { preset: 'ptc' })
  assert.equal(outcome.messageId, 'm1')
  // submitted: NO grey terminal patch — the caller patches the created card.
  await flush()
  assert.equal(patches.length, 0)
})

test('cancel patches the grey cancelled card and resolves cancelled', async () => {
  const { deps, sends, patches } = makeDeps()
  const flow = new NewSessionFlowManager(deps)
  const pending = flow.present('oc_test', SPEC)
  await flush()
  const flowId = flowIdOf(sends[0])
  flow.handleAction({ flowId, cancelled: true, picks: {} })
  const outcome = await pending
  assert.equal(outcome.status, 'cancelled')
  assert.equal(outcome.messageId, 'm1')
  await flush()
  assert.equal(patches.length, 1)
  assert.equal(patches[0].messageId, 'm1')
  assert.equal(patches[0].card.header.template, 'grey')
  assert.match(patches[0].card.header.title.content, /取消/)
})

test('TTL expiry resolves expired and patches the grey expired card', async () => {
  const { deps, sends, patches, waits } = makeDeps()
  const flow = new NewSessionFlowManager(deps)
  const pending = flow.present('oc_test', SPEC)
  await flush()
  assert.equal(sends.length, 1)
  assert.equal(waits.length, 1)
  waits[0].resolve()
  const outcome = await pending
  assert.equal(outcome.status, 'expired')
  await flush()
  assert.equal(patches.length, 1)
  assert.match(patches[0].card.header.title.content, /过期/)
})

test('a second /new expires the pending flow first, then serves its own card', async () => {
  const { deps, sends, patches, waits } = makeDeps()
  const flow = new NewSessionFlowManager(deps)
  const first = flow.present('oc_test', SPEC)
  await flush()
  const second = flow.present('oc_test', SPEC)
  const firstOutcome = await first
  assert.equal(firstOutcome.status, 'expired')
  await flush()
  assert.equal(sends.length, 2)
  // The SECOND flow is the live one now.
  const flowId = flowIdOf(sends[1])
  flow.handleAction({ flowId, picks: {} })
  const secondOutcome = await second
  assert.equal(secondOutcome.status, 'submitted')
  assert.equal(waits.length, 2)
  assert.equal(patches.length, 1) // only the first flow's grey card
})

test('stale/foreign flow ids are no-ops', async () => {
  const { deps, sends, patches } = makeDeps()
  const flow = new NewSessionFlowManager(deps)
  const pending = flow.present('oc_test', SPEC)
  await flush()
  flow.handleAction({ flowId: 'nope', picks: {} })
  flow.handleAction({ flowId: '', picks: {} })
  await flush()
  // Still pending — settle it to keep the test clean.
  const flowId = flowIdOf(sends[0])
  flow.handleAction({ flowId, cancelled: true, picks: {} })
  const outcome = await pending
  assert.equal(outcome.status, 'cancelled')
  await flush()
  assert.equal(patches.length, 1)
})

test('a send failure resolves undefined without leaving state behind', async () => {
  const { deps } = makeDeps({ sendOk: false })
  const flow = new NewSessionFlowManager(deps)
  const outcome = await flow.present('oc_test', SPEC)
  assert.equal(outcome, undefined)
})
