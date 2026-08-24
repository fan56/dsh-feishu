import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contextTokensEstimate,
  foldBoundEvent,
  foldChildEvent,
  initialProgressCursor,
  initialRunState,
  lastTurnBody,
  progressBodySince,
  reasoningTail,
  shouldPushProgress,
  subagentDisplayLabel,
  subagentRows,
  toolResultFailed,
} from '../lib/run-state.js'

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

test('request/header and request/context fold the route fields', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('request/header', { header: { config: { provider: 'deepseek', model: 'org/deepseek-v4', reasoningEffort: 'medium' } } }, 1000, 1))
  foldBoundEvent(state, event('request/context', { provider: 'deepseek', model: 'org/deepseek-v4', contextWindow: 128000 }, 1100, 2))
  assert.equal(state.provider, 'deepseek')
  assert.equal(state.model, 'org/deepseek-v4')
  assert.equal(state.reasoningEffort, 'medium')
  assert.equal(state.contextWindow, 128000)
})

test('route fields survive turn/start (they are session-scoped)', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('request/header', { header: { config: { provider: 'p', model: 'm', reasoningEffort: 'low' } } }, 1000, 1))
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 2000, 2))
  assert.equal(state.model, 'm')
  assert.equal(state.reasoningEffort, 'low')
})

test('malformed chunk text (truthy non-string) is a no-op for the estimate', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  // A truthy non-string text must not poison pendingChars with NaN.
  foldBoundEvent(state, event('assistant/chunk', { chunk: { type: 'text-delta', text: 42 } }, 1100, 2))
  assert.equal(state.pendingChars, 0)
  assert.equal(contextTokensEstimate(state), undefined)
})

test('usage snapshot prices the context; streamed deltas estimate the growth', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  // No usage yet — undefined until a billed message or pending chars exist.
  assert.equal(contextTokensEstimate(state), undefined)
  foldBoundEvent(state, event('assistant/chunk', chunk('text-delta', 'x'.repeat(300)), 1100, 2))
  assert.equal(contextTokensEstimate(state), Math.ceil(300 / 3))
  foldBoundEvent(state, event('assistant/message', {
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 50 },
    message: { content: [{ type: 'text', text: 'done' }] },
  }, 1200, 3))
  // Billed snapshot replaces the pending estimate.
  assert.equal(state.lastUsageTokens, 1750)
  assert.equal(contextTokensEstimate(state), 1750)
  foldBoundEvent(state, event('assistant/chunk', chunk('reasoning-delta', 'y'.repeat(90)), 1300, 4))
  assert.equal(contextTokensEstimate(state), 1750 + 30)
  // A usage-less message keeps the baseline but restarts pending.
  foldBoundEvent(state, event('assistant/message', { message: { content: [{ type: 'text', text: 'no usage' }] } }, 1400, 5))
  assert.equal(contextTokensEstimate(state), 1750)
})

test('subagent/descriptor on the child log refines the label', () => {
  const state = initialRunState()
  foldChildEvent(state, 'child1', event('assistant/message', { message: { content: [{ type: 'text', text: 'hi' }] } }, 1000, 1))
  assert.match(state.subagents.get('child1').label, /^subagent /)
  foldChildEvent(state, 'child1', event('subagent/descriptor', { version: 2, mode: 'one-shot', provider: 'workhorse', label: 'workhorse' }, 1100, 2))
  assert.equal(state.subagents.get('child1').label, 'workhorse')
})

test('subagentDisplayLabel appends a short hash or falls back to it', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('tool-workflow/agent-start', { runId: 'r', seq: 1, label: 'workhorse', childId: '49a621b2abcd' }, 1000, 1))
  foldBoundEvent(state, event('tool-workflow/agent-start', { runId: 'r', seq: 2, childId: 'abcdef123456' }, 1100, 2))
  const rows = subagentRows(state)
  assert.equal(subagentDisplayLabel(rows[0]), 'workhorse·49a6')
  // No real name in the events — raw hash prefix stands in.
  assert.equal(subagentDisplayLabel(rows[1]), 'abcdef12')
})

test('agent-start with a non-string label falls back to the hash placeholder', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('tool-workflow/agent-start', { runId: 'r', seq: 1, label: 42, childId: '49a621b2abcd' }, 1000, 1))
  // A numeric label must not leak into the state — hash fallback applies.
  assert.equal(state.subagents.get('49a621b2abcd').label, 'subagent 49a621b2')
})

test('progress throttle: substantive text after the interval pushes', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  const cursor = initialProgressCursor()
  // Pure tool round — nothing to push even past the interval.
  foldBoundEvent(state, event('tool/call', { callId: 'c', name: 'bash', arguments: '' }, 1100, 2))
  assert.equal(shouldPushProgress(state, cursor, 999_000, 180_000), false)
  // Substantive text lands but the interval has not elapsed since turn start.
  foldBoundEvent(state, event('assistant/message', { message: { content: [{ type: 'text', text: 'step one done' }] } }, 1200, 3))
  assert.equal(shouldPushProgress(state, cursor, 2000, 180_000), false)
  assert.equal(progressBodySince(state, cursor), 'step one done')
  // Past the interval — push fires.
  assert.equal(shouldPushProgress(state, cursor, 1000 + 180_000, 180_000), true)
  // Advance the cursor like the bot would; nothing new to push now.
  cursor.pushedTexts = state.assistantTexts.length
  cursor.lastPushAt = 181_000
  assert.equal(shouldPushProgress(state, cursor, 200_000, 180_000), false)
  // New text inside the window merges (stays unpushed)…
  foldBoundEvent(state, event('assistant/message', { message: { content: [{ type: 'text', text: 'step two done' }] } }, 210_000, 4))
  assert.equal(shouldPushProgress(state, cursor, 300_000, 180_000), false)
  assert.equal(progressBodySince(state, cursor), 'step two done')
  // …and ships once the interval passes.
  assert.equal(shouldPushProgress(state, cursor, 362_000, 180_000), true)
})

test('progress throttle never fires outside a running turn', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('assistant/message', { message: { content: [{ type: 'text', text: 'body' }] } }, 1100, 2))
  foldBoundEvent(state, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 500_000, 3))
  const cursor = initialProgressCursor()
  assert.equal(shouldPushProgress(state, cursor, 900_000, 180_000), false)
})
