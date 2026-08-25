import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyChildBackfill,
  applyRouteBackfill,
  backfillFromChildLog,
  backfillRouteFromLog,
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

// ------------------------------------------------ child naming + backfill --

test('agent-start label reaches a row that child events already created (race fix)', () => {
  const state = initialRunState()
  // Child events arrive first — the row is created lazily with the fallback.
  foldChildEvent(state, 'c1bb44aa', event('assistant/message', { message: { content: [{ type: 'text', text: 'digging' }] } }, 1000, 1))
  assert.equal(state.subagents.get('c1bb44aa').label, 'subagent c1bb44aa')
  // Then the parent's agent-start lands with the real spawn label.
  foldBoundEvent(state, event('tool-workflow/agent-start', { runId: 'r', seq: 1, label: 'workhorse', childId: 'c1bb44aa' }, 1100, 2))
  assert.equal(state.subagents.get('c1bb44aa').label, 'workhorse')
  assert.equal(subagentDisplayLabel(state.subagents.get('c1bb44aa')), 'workhorse·c1bb')
})

test('backfillFromChildLog derives label, rounds, last tool and tail from the log', () => {
  const events = [
    event('subagent/descriptor', { version: 2, mode: 'one-shot', provider: 'registry', label: 'oldfox' }, 1000, 1),
    event('tool/call', { callId: 'a', name: 'bash', arguments: '' }, 1100, 2),
    event('assistant/message', { message: { content: [{ type: 'text', text: 'first pass' }] } }, 1200, 3),
    event('tool/call', { callId: 'b', name: 'Edit', arguments: '' }, 1300, 4),
    event('assistant/message', { message: { content: [{ type: 'text', text: 'fixed it\nship it' }] } }, 1400, 5),
    event('garbage', { nope: true }, 1500, 6),
  ]
  const backfill = backfillFromChildLog(events)
  assert.equal(backfill.label, 'oldfox')
  assert.equal(backfill.rounds, 2)
  assert.equal(backfill.lastTool, 'Edit')
  assert.equal(backfill.tail, 'ship it')
  // No descriptor → no label; malformed payloads degrade to no-ops.
  const bare = backfillFromChildLog([
    event('subagent/descriptor', { version: 2, mode: 'one-shot', provider: 'p' }, 100, 1),
    event('assistant/message', { message: { content: [{ type: 'text', text: 'x' }] } }, 200, 2),
  ])
  assert.equal(bare.label, undefined)
  assert.equal(bare.rounds, 1)
})

test('applyChildBackfill: label replaces fallback, rounds only correct UP, holes only filled', () => {
  const state = initialRunState()
  // Row exists with fallback label and one live-folded round already.
  foldChildEvent(state, 'c1bb44aa', event('assistant/message', { message: { content: [{ type: 'text', text: 'live tail' }] } }, 1000, 1))
  applyChildBackfill(state, 'c1bb44aa', { label: 'workhorse', rounds: 6, lastTool: 'Edit', tail: undefined })
  const row = state.subagents.get('c1bb44aa')
  assert.equal(row.label, 'workhorse')
  assert.equal(row.rounds, 6) // corrected up past the live count
  assert.equal(row.lastTool, 'Edit') // hole filled
  assert.equal(row.tail, 'live tail') // live value wins, not overwritten with undefined
  // Rounds never go DOWN; a fallback-pattern backfill label is ignored.
  applyChildBackfill(state, 'c1bb44aa', { label: 'subagent deadbeef', rounds: 2, lastTool: 'bash', tail: 'stale' })
  assert.equal(row.rounds, 6)
  assert.equal(row.label, 'workhorse')
  assert.equal(row.tail, 'live tail')
  // Unknown child id: no-op.
  applyChildBackfill(state, 'nope', { label: 'x', rounds: 9, lastTool: 'x', tail: 'x' })
  assert.equal(state.subagents.has('nope'), false)
})

// ------------------------------------------- cache-hit accounting + backfill --

test('cache hit is session-cumulative: output excluded, route changes never reset', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('request/header', { header: { config: { provider: 'p', model: 'm1' } } }, 1000, 1))
  foldBoundEvent(state, event('assistant/message', {
    usage: { inputTokens: 100, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 400 },
    message: { content: [{ type: 'text', text: 'cold' }] },
  }, 1100, 2))
  // Output tokens are huge but must not dilute: 0/(100+0+400) = 0%.
  assert.equal(state.cacheHitRate, 0)
  foldBoundEvent(state, event('assistant/message', {
    usage: { inputTokens: 20, outputTokens: 30, cacheReadTokens: 380, cacheWriteTokens: 30 },
    message: { content: [{ type: 'text', text: 'warm' }] },
  }, 1200, 3))
  assert.equal(state.cacheHitRate, 380 / 930 * 100)
  // A provider/model change (even a same-model re-emission) must NOT reset:
  // the rate describes the whole session's input traffic.
  foldBoundEvent(state, event('request/header', { header: { config: { provider: 'p', model: 'm2' } } }, 1400, 5))
  assert.equal(state.cacheHitRate, 380 / 930 * 100)
  assert.equal(state.cacheReadTokens, 380)
  assert.equal(state.model, 'm2')
})

test('usage without cache components (zhipu) leaves the CH accumulators at zero', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('assistant/message', {
    usage: { inputTokens: 28_995, outputTokens: 777 },
    message: { content: [{ type: 'text', text: 'x' }] },
  }, 1000, 1))
  assert.equal(state.cacheReadTokens + state.cacheWriteTokens, 0)
  assert.equal(state.lastUsageTokens, 28_995 + 777)
})

test('backfillRouteFromLog recovers route facts and segments the cache history', () => {
  const events = [
    event('request/header', { header: { config: { provider: 'openrouter', model: 'stealth/ox-alpha', reasoningEffort: 'high' } } }, 1000, 1),
    event('request/context', { provider: 'openrouter', model: 'stealth/ox-alpha', contextWindow: 1_048_576 }, 1100, 2),
    event('assistant/message', {
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 8000, cacheWriteTokens: 1500 },
      message: { content: [{ type: 'text', text: 'on route A' }] },
    }, 1200, 3),
    // Route switch mid-log: the cache segment restarts from here.
    event('request/header', { header: { config: { provider: 'p2', model: 'other-model' } } }, 1300, 4),
    event('assistant/message', {
      usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 100 },
      message: { content: [{ type: 'text', text: 'on route B' }] },
    }, 1400, 5),
  ]
  const backfill = backfillRouteFromLog(events)
  assert.equal(backfill.provider, 'p2')
  assert.equal(backfill.model, 'other-model')
  assert.equal(backfill.reasoningEffort, 'high') // persists from the earlier header
  assert.equal(backfill.contextWindow, 1_048_576)
  // BOTH routes' usage counts (session scope): 8300 / (1500 + 8300 + 1600).
  assert.equal(backfill.cacheHitRate, 8300 / 11_400 * 100)
})

test('applyRouteBackfill fills route holes and assigns the authoritative cache totals', () => {
  const state = initialRunState()
  applyRouteBackfill(state, backfillRouteFromLog([
    event('request/header', { header: { config: { provider: 'p', model: 'm', reasoningEffort: 'low' } } }, 1000, 1),
    event('request/context', { contextWindow: 200_000 }, 1100, 2),
    event('assistant/message', {
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 8000, cacheWriteTokens: 1500 },
      message: { content: [{ type: 'text', text: 'x' }] },
    }, 1200, 3),
  ]))
  assert.equal(state.model, 'm')
  assert.equal(state.reasoningEffort, 'low')
  assert.equal(state.contextWindow, 200_000)
  assert.equal(state.cacheHitRate, 8000 / 10_500 * 100)
  // The occupancy baseline rides along — ctx% renders on the very first card.
  assert.equal(state.lastUsageTokens, 1000 + 8000 + 1500 + 200)
  // Live values are never overwritten by a later backfill.
  state.model = 'live-model'
  applyRouteBackfill(state, backfillRouteFromLog([]))
  assert.equal(state.model, 'live-model')
})
