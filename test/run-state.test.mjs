import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldBoundEvent, foldChildEvent, initialRunState, lastTurnBody, reasoningTail, subagentRows, toolResultFailed } from '../lib/run-state.js'

function event(type, data, time, seq) {
  return { type, data, time, seq }
}

function chunk(type, text) {
  return { chunk: { type, text } }
}

test('a full turn folds into counters, body and final reason', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('assistant/chunk', chunk('reasoning-delta', 'thinking...\nabout it'), 1100, 2))
  foldBoundEvent(state, event('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' }, 1200, 3))
  foldBoundEvent(state, event('tool/result', { callId: 'c1', message: { content: [{ toolCallId: 'c1', isError: false, content: [] }] } }, 2400, 4))
  foldBoundEvent(state, event('assistant/message', { message: { content: [{ type: 'text', text: 'first answer' }] } }, 2500, 5))
  foldBoundEvent(state, event('tool/call', { callId: 'c2', name: 'read', arguments: '{}' }, 2600, 6))
  foldBoundEvent(state, event('tool/result', { callId: 'c2', message: { content: [{ toolCallId: 'c2', isError: true, content: [] }] } }, 2700, 7))
  foldBoundEvent(state, event('todo/write', { todos: [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
  ] }, 2800, 8))
  foldBoundEvent(state, event('assistant/message', { message: { content: [{ type: 'text', text: 'final\nanswer' }] } }, 2900, 9))
  foldBoundEvent(state, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3000, 10))

  assert.equal(state.running, false)
  assert.equal(state.turnEndReason, 'completed')
  assert.equal(state.rounds, 2)
  assert.equal(state.toolsDone, 1)
  assert.equal(state.toolsFailed, 1)
  assert.equal(state.toolHistory.length, 2)
  assert.deepEqual(state.toolHistory[1], { name: 'read', ok: false, durationMs: 100 })
  assert.equal(state.todo.length, 2)
  assert.equal(state.lastAssistantLine, 'answer')
  assert.equal(lastTurnBody(state), 'first answer\n\nfinal\nanswer')
  assert.equal(reasoningTail(state), 'about it')
  // thinkingSince is a live-phase marker: cleared by the landed assistant
  // messages and by turn/end — not retained after the turn.
  assert.equal(state.thinkingSince, undefined)
})

test('turn/start resets every per-turn field', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('assistant/message', { message: { content: [{ type: 'text', text: 'x' }] } }, 1100, 2))
  foldBoundEvent(state, event('tool/call', { callId: 'c', name: 'bash', arguments: '' }, 1200, 3))
  foldBoundEvent(state, event('todo/write', { todos: [{ content: 't', status: 'pending' }] }, 1300, 4))
  foldBoundEvent(state, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1400, 5))
  foldBoundEvent(state, event('turn/start', { turn: 2 }, 2000, 6))

  assert.equal(state.running, true)
  assert.equal(state.rounds, 0)
  assert.equal(state.currentTool, undefined)
  assert.equal(state.todo, undefined)
  assert.equal(state.toolHistory.length, 0)
  assert.equal(lastTurnBody(state), '')
})

test('llm/retry counters update and assistant/message clears them', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('llm/retry', { retry: 1, maxRetries: 5 }, 1100, 2))
  assert.equal(state.retries, 1)
  assert.equal(state.maxRetries, 5)
  foldBoundEvent(state, event('llm/retry', { retry: 2, maxRetries: 5 }, 1200, 3))
  assert.equal(state.retries, 2)
  foldBoundEvent(state, event('assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } }, 1300, 4))
  assert.equal(state.retries, 0)
  assert.equal(state.maxRetries, undefined)
})

test('reasoning buffer is capped', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  const big = 'x'.repeat(6000)
  foldBoundEvent(state, event('assistant/chunk', chunk('reasoning-delta', big), 1100, 2))
  foldBoundEvent(state, event('assistant/chunk', chunk('reasoning-delta', big), 1200, 3))
  foldBoundEvent(state, event('assistant/chunk', chunk('reasoning-delta', big), 1300, 4))
  assert.ok(state.reasoningBuffer.length <= 8192)
  assert.equal(reasoningTail(state), 'x'.repeat(4096).slice(0, 4096))
})

test('workflow agent-start/end track children on the parent fold', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('tool-workflow/agent-start', { runId: 'r', seq: 1, label: 'workhorse', childId: 'child1' }, 1100, 2))
  foldBoundEvent(state, event('tool-workflow/agent-start', { runId: 'r', seq: 2, label: 'oldfox', childId: 'child2' }, 1200, 3))
  foldBoundEvent(state, event('tool-workflow/agent-end', { runId: 'r', seq: 2, outcome: 'completed' }, 1300, 4))
  const rows = subagentRows(state)
  assert.equal(rows.length, 2)
  // Running children sort before settled ones.
  assert.equal(rows[0].childId, 'child1')
  assert.equal(rows[0].outcome, undefined)
  assert.equal(rows[1].childId, 'child2')
  assert.equal(rows[1].outcome, 'completed')
})

test('child fold counts rounds and keeps the content tail', () => {
  const state = initialRunState()
  foldChildEvent(state, 'child1', event('assistant/chunk', chunk('text-delta', 'working\non it'), 1100, 2))
  foldChildEvent(state, 'child1', event('assistant/message', { message: { content: [{ type: 'text', text: 'step done' }] } }, 1200, 3))
  foldChildEvent(state, 'child1', event('tool/call', { callId: 'c', name: 'grep', arguments: '' }, 1300, 4))
  const row = state.subagents.get('child1')
  assert.equal(row.rounds, 1)
  assert.equal(row.tail, 'step done')
  assert.equal(row.lastTool, 'grep')
  // Child turn/end settles it.
  foldChildEvent(state, 'child1', event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1400, 5))
  assert.equal(state.subagents.get('child1').outcome, 'completed')
})

test('malformed events never throw', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('tool/result', { unexpected: true }, 1000, 1))
  foldBoundEvent(state, event('todo/write', { todos: 'not-an-array' }, 1100, 2))
  foldBoundEvent(state, event('assistant/chunk', { nope: 1 }, 1200, 3))
  foldBoundEvent(state, event('turn/end', {}, 1300, 4))
  foldChildEvent(state, 'c', event('assistant/chunk', null, 1400, 5))
  assert.equal(state.turnEndReason, 'unknown')
})

test('tool result failure detection covers the error field and isError block', () => {
  assert.equal(toolResultFailed({ error: { name: 'x' } }), true)
  assert.equal(toolResultFailed({ message: { content: [{ toolCallId: 'c', isError: true, content: [] }] } }), true)
  assert.equal(toolResultFailed({ message: { content: [{ toolCallId: 'c', isError: false, content: [] }] } }), false)
  assert.equal(toolResultFailed({}), false)
})
