import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildStatusCard, statusLine, todoLine, turnEndIcon } from '../lib/card.js'
import { foldBoundEvent, foldChildEvent, initialRunState } from '../lib/run-state.js'

function event(type, data, time, seq) {
  return { type, data, time, seq }
}

test('running turn renders a blue card with the thinking badge', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('assistant/chunk', { chunk: { type: 'reasoning-delta', text: 'pondering' } }, 1100, 2))
  const { card, hash } = buildStatusCard(state, { sessionLabel: 'repo · ab12cd34', displayThink: false, now: 2200 })
  assert.equal(card.header.template, 'blue')
  assert.match(card.header.title.content, /运行中/)
  const md = card.elements[0].text.content
  assert.match(md, /🤔 \*\*thinking\*\* · 1s/)
  assert.ok(hash.length > 0)
})

test('tool phase shows the tool name and settled tools line up', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('tool/call', { callId: 'c1', name: 'bash', arguments: '' }, 2000, 2))
  let md = buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 3000 }).card.elements[0].text.content
  assert.match(md, /🔧 \*\*bash\*\* · 1s/)
  foldBoundEvent(state, event('tool/result', { callId: 'c1', message: { content: [{ toolCallId: 'c1', isError: false, content: [] }] } }, 2600, 3))
  md = buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 3000 }).card.elements[0].text.content
  assert.match(md, /bash ✔/)
  assert.match(md, /rounds 0/)
})

test('completed turn finalizes green; error turn finalizes red', () => {
  const ok = initialRunState()
  foldBoundEvent(ok, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(ok, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4000, 2))
  const okCard = buildStatusCard(ok, { sessionLabel: 'x', displayThink: false, now: 4000 }).card
  assert.equal(okCard.header.template, 'green')
  assert.match(okCard.elements[0].text.content, /✅ \*\*完成\*\* · 3s/)

  const bad = initialRunState()
  foldBoundEvent(bad, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(bad, event('turn/end', { turn: 1, reason: { kind: 'error', error: {} } }, 4000, 2))
  const badCard = buildStatusCard(bad, { sessionLabel: 'x', displayThink: false, now: 4000 }).card
  assert.equal(badCard.header.template, 'red')
  assert.match(badCard.elements[0].text.content, /❌ \*\*失败\*\*/)
})

test('todo line hides once all items are done', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('todo/write', { todos: [
    { content: 'one', status: 'completed' },
    { content: 'two', status: 'in_progress' },
  ] }, 1100, 2))
  assert.match(todoLine(state), /☑ 1\/2/)
  assert.match(todoLine(state), /◐ two/)
  foldBoundEvent(state, event('todo/write', { todos: [
    { content: 'one', status: 'completed' },
    { content: 'two', status: 'completed' },
  ] }, 1200, 3))
  assert.equal(todoLine(state), undefined)
})

test('subagent rows render compactly with running-first order', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('tool-workflow/agent-start', { runId: 'r', seq: 1, label: 'oldfox', childId: 'c2' }, 1100, 2))
  foldBoundEvent(state, event('tool-workflow/agent-start', { runId: 'r', seq: 2, label: 'workhorse', childId: 'c1' }, 1200, 3))
  foldChildEvent(state, 'c1', event('assistant/message', { message: { content: [{ type: 'text', text: 'digging' }] } }, 1300, 4))
  const md = buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 1400 }).card.elements[0].text.content
  assert.match(md, /🧵 ×2/)
  assert.match(md, /├ workhorse ↻ · round 1 · digging/)
  assert.match(md, /├ oldfox ↻ · round 0/)
})

test('think tail renders only when displayThink is on', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('assistant/chunk', { chunk: { type: 'reasoning-delta', text: 'deep thought' } }, 1100, 2))
  const off = buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 2000 }).card.elements[0].text.content
  assert.doesNotMatch(off, /deep thought/)
  const on = buildStatusCard(state, { sessionLabel: 'x', displayThink: true, now: 2000 }).card.elements[0].text.content
  assert.match(on, /_deep thought_/)
})

test('hash changes with content, not with an identical rebuild', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  const context = { sessionLabel: 'x', displayThink: false, now: 2000 }
  const first = buildStatusCard(state, context)
  assert.equal(first.hash, buildStatusCard(state, context).hash)
  foldBoundEvent(state, event('tool/call', { callId: 'c', name: 'bash', arguments: '' }, 2100, 2))
  assert.notEqual(first.hash, buildStatusCard(state, context).hash)
})

test('statusLine and turnEndIcon cover the remaining reasons', () => {
  assert.equal(turnEndIcon('aborted'), '⛔')
  assert.equal(turnEndIcon('max-tokens'), '⚠️')
  assert.match(statusLine(initialRunState(), 0), /❕/)
})
