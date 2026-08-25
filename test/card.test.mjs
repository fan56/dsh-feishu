import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildBodyCard,
  buildFooter,
  buildProgressCard,
  buildSessionListAsMarkdown,
  buildSessionListCard,
  buildStatusCard,
  footerFieldsOf,
  roundNumber,
  shortModelName,
  turnEndIcon,
  turnHeaderTitle,
  turnPhase,
} from '../lib/card.js'
import { foldBoundEvent, foldChildEvent, initialRunState } from '../lib/run-state.js'

function event(type, data, time, seq) {
  return { type, data, time, seq }
}

/** Markdown content of the turn card (first body element). */
function md(card) {
  return card.body.elements[0].content
}

test('running turn opens a schema 2.0 card: Round header, thinking phase, activity section', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('assistant/chunk', { chunk: { type: 'reasoning-delta', text: 'pondering' } }, 1100, 2))
  const { card, hash } = buildStatusCard(state, { sessionLabel: 'repo · ab12cd34', displayThink: false, now: 2200 })
  assert.equal(card.schema, '2.0')
  assert.equal(card.header.template, 'blue')
  assert.equal(card.header.title.content, 'Round 1 · 🤔 thinking · 1s')
  assert.equal(card.header.subtitle.content, 'dsh · repo · ab12cd34')
  assert.equal(card.body.elements[0].tag, 'markdown')
  assert.match(md(card), /^##### 🧭 活动/)
  assert.match(md(card), /- 🤔 thinking · 1s/)
  assert.ok(hash.length > 0)
})

test('a fresh turn with no events yet shows a waiting placeholder', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  const card = buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 1000 }).card
  assert.equal(card.header.title.content, 'Round 1 · ⚙️ processing')
  assert.match(md(card), /- ⏳ 等待模型响应…/)
})

test('tool phase: header carries the tool name; settled tools list below; LLM message bullet', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('tool/call', { callId: 'c1', name: 'bash', arguments: '' }, 2000, 2))
  let card = buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 3000 }).card
  assert.equal(card.header.title.content, 'Round 1 · 🔧 bash · 1s')
  assert.match(md(card), /- 🔧 bash · ⏳ 1s/)
  foldBoundEvent(state, event('tool/result', { callId: 'c1', message: { content: [{ toolCallId: 'c1', isError: false, content: [] }] } }, 2600, 3))
  foldBoundEvent(state, event('assistant/message', { message: { content: [{ type: 'text', text: 'scanned the repo\nnext: fix tests' }] } }, 2700, 4))
  card = buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 3000 }).card
  assert.match(md(card), /- 🔧 bash · ✔ 1s/)
  // Latest LLM message renders as one clipped bullet (its last visible line).
  assert.match(md(card), /- 💬 _next: fix tests_/)
  // One assistant message landed → round 2 is now in flight.
  assert.equal(card.header.title.content, 'Round 2 · ⚙️ processing')
})

test('subagent phase: header shows pending subagents; section lists status + last line', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('tool-workflow/agent-start', { runId: 'r', seq: 1, label: 'oldfox', childId: 'c2aa' }, 1100, 2))
  foldBoundEvent(state, event('tool-workflow/agent-start', { runId: 'r', seq: 2, label: 'workhorse', childId: 'c1bb' }, 1200, 3))
  foldChildEvent(state, 'c1bb', event('tool/call', { callId: 't', name: 'bash', arguments: '' }, 1250, 4))
  foldChildEvent(state, 'c1bb', event('assistant/message', { message: { content: [{ type: 'text', text: 'digging' }] } }, 1300, 5))
  const card = buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 1400 }).card
  assert.equal(card.header.title.content, 'Round 1 · ⏳ subagent ×2')
  assert.match(md(card), /##### 🧵 子代理 · ⏳ ×2/)
  // Running row: label, rounds, last tool, then the last output line (italic).
  assert.match(md(card), /- workhorse·c1bb · ⏳ round 1 · 🔧 bash · _digging_/)
  assert.match(md(card), /- oldfox·c2aa · ⏳ round 0/)
})

test('settled subagents keep their outcome row and drop the live counter', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('tool-workflow/agent-start', { runId: 'r', seq: 1, label: 'oldfox', childId: 'c2aa' }, 1100, 2))
  foldBoundEvent(state, event('tool-workflow/agent-start', { runId: 'r', seq: 2, label: 'workhorse', childId: 'c1bb' }, 1200, 3))
  foldBoundEvent(state, event('tool-workflow/agent-end', { runId: 'r', seq: 1, outcome: 'completed' }, 1300, 4))
  const card = buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 1400 }).card
  assert.equal(card.header.title.content, 'Round 1 · ⏳ subagent ×1')
  assert.match(md(card), /##### 🧵 子代理 · ⏳ ×1/)
  assert.match(md(card), /- oldfox·c2aa · ✔ 完成/)
})

test('completed turn finalizes green with total rounds; error turn finalizes red', () => {
  const ok = initialRunState()
  foldBoundEvent(ok, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(ok, event('assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } }, 2000, 2))
  foldBoundEvent(ok, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4000, 3))
  const okCard = buildStatusCard(ok, { sessionLabel: 'x', displayThink: false, now: 4000 }).card
  assert.equal(okCard.header.template, 'green')
  assert.equal(okCard.header.title.content, 'Round 1 · ✅ 完成 · 3s')

  const bad = initialRunState()
  foldBoundEvent(bad, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(bad, event('turn/end', { turn: 1, reason: { kind: 'error', error: {} } }, 4000, 2))
  const badCard = buildStatusCard(bad, { sessionLabel: 'x', displayThink: false, now: 4000 }).card
  assert.equal(badCard.header.template, 'red')
  assert.match(badCard.header.title.content, /❌ 失败/)
})

test('todo section: ☑ x/z status on the first line, GFM task list below', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('todo/write', { todos: [
    { content: 'one', status: 'completed' },
    { content: 'two', status: 'in_progress' },
    { content: 'three', status: 'pending' },
  ] }, 1100, 2))
  const lines = md(buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 1200 }).card).split('\n')
  const todoStart = lines.findIndex(line => line.startsWith('##### 📋 Todo'))
  assert.equal(lines[todoStart], '##### 📋 Todo · ☑ 1/3')
  assert.equal(lines[todoStart + 1], '- [x] one')
  assert.equal(lines[todoStart + 2], '- [ ] ◐ two')
  assert.equal(lines[todoStart + 3], '- [ ] three')
})

test('todo section stays visible when everything is done', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('todo/write', { todos: [
    { content: 'one', status: 'completed' },
    { content: '', status: 'completed' },
  ] }, 1100, 2))
  const lines = md(buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 1200 }).card).split('\n')
  assert.equal(lines.find(line => line.startsWith('##### 📋 Todo')), '##### 📋 Todo · ☑ 2/2 · 全部完成')
  // The empty-title item still counts toward x/z but renders no bullet.
  assert.ok(!lines.includes('- [x] '))
})

test('think tail renders in the activity bullet only when displayThink is on', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('assistant/chunk', { chunk: { type: 'reasoning-delta', text: 'deep thought' } }, 1100, 2))
  const off = md(buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 2000 }).card)
  assert.doesNotMatch(off, /deep thought/)
  const on = md(buildStatusCard(state, { sessionLabel: 'x', displayThink: true, now: 2000 }).card)
  assert.match(on, /- 🤔 thinking · 1s — _deep thought_/)
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

// ------------------------------------------------------------------- phase --

test('turnPhase: tool beats thinking beats subagents; processing is the fallback', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  assert.equal(turnPhase(state).kind, 'processing')
  foldBoundEvent(state, event('assistant/chunk', { chunk: { type: 'reasoning-delta', text: 'hmm' } }, 1100, 2))
  assert.equal(turnPhase(state).kind, 'thinking')
  foldBoundEvent(state, event('tool-workflow/agent-start', { runId: 'r', seq: 1, label: 'w', childId: 'c1' }, 1200, 3))
  assert.equal(turnPhase(state).kind, 'thinking') // thinking still wins
  foldBoundEvent(state, event('tool/call', { callId: 'c', name: 'bash', arguments: '' }, 1300, 4))
  assert.equal(turnPhase(state).kind, 'tool') // a live tool beats everything
  foldBoundEvent(state, event('tool/result', { message: { content: [] } }, 1400, 5))
  foldBoundEvent(state, event('assistant/message', { message: { content: [{ type: 'text', text: 'x' }] } }, 1500, 6)) // clears thinking
  assert.equal(turnPhase(state).kind, 'subagent') // children still running
  foldBoundEvent(state, event('tool-workflow/agent-end', { runId: 'r', seq: 1, outcome: 'completed' }, 1600, 7))
  assert.equal(turnPhase(state).kind, 'processing')
  foldBoundEvent(state, event('turn/end', { reason: { kind: 'completed' } }, 1700, 8))
  assert.equal(turnPhase(state).kind, 'ended')
})

test('roundNumber: in-flight round while running, total once ended', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  assert.equal(roundNumber(state), 1)
  foldBoundEvent(state, event('assistant/message', { message: { content: [{ type: 'text', text: 'x' }] } }, 1100, 2))
  assert.equal(roundNumber(state), 2)
  foldBoundEvent(state, event('turn/end', { reason: { kind: 'completed' } }, 1200, 3))
  assert.equal(roundNumber(state), 1)
})

test('turnHeaderTitle and turnEndIcon cover the remaining reasons', () => {
  assert.equal(turnEndIcon('aborted'), '⛔')
  assert.equal(turnEndIcon('max-tokens'), '⚠️')
  const idle = initialRunState()
  assert.match(turnHeaderTitle(idle, 0), /Round 0 · ❕ 已结束/)
})

test('buildBodyCard ships the body verbatim in a schema 2.0 markdown element', () => {
  const body = [
    '**done** · rounds 3',
    '- item one',
    '- item two',
    '```bash',
    'echo hi',
    '```',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\n')
  const card = buildBodyCard(body)
  assert.equal(card.schema, '2.0')
  assert.deepEqual(card.config, { width_mode: 'fill' })
  assert.equal(card.header, undefined)
  assert.equal(card.body.elements.length, 1)
  assert.equal(card.body.elements[0].tag, 'markdown')
  // Verbatim — no legacy downgrade conversion touches the body.
  assert.equal(card.body.elements[0].content, body)
})

// ------------------------------------------------------------------ footer --

test('buildFooter renders every field in order with · separators', () => {
  const line = buildFooter({
    elapsedMs: 754_000,
    rounds: 8,
    model: 'org/deepseek-v4',
    contextPercent: 43.2,
    cacheHitPercent: 85.04,
    toolCalls: 23,
    thinking: 'high',
  })
  assert.equal(line, '⏱ 12m34s · 🤖 deepseek-v4 · 🧠 high · 📊 ctx 43% · ⚡ CH 85.0% · 🔧 23 calls · Round 8')
})

test('buildFooter omits missing fields without leaving separators', () => {
  assert.equal(buildFooter({}), '')
  assert.equal(buildFooter({ model: 'deepseek-v4' }), '🤖 deepseek-v4')
  // Zero counters are noise, not data — skipped like unknown fields.
  assert.equal(buildFooter({ rounds: 0, toolCalls: 0, elapsedMs: 5000 }), '⏱ 5s')
})

test('buildFooter falls back from percent to raw tokens; CH stays absent without cache data', () => {
  const withPercent = buildFooter({ contextPercent: -5, contextTokens: 12_300 })
  assert.match(withPercent, /📊 ctx 0%/) // clamped, percent wins when present
  const tokensOnly = buildFooter({ contextTokens: 950 })
  assert.equal(tokensOnly, '📊 ctx 950')
  assert.equal(buildFooter({ contextTokens: 1_234_000 }), '📊 ctx 1.2M')
  // A gateway that reports no cache usage (zhipu GLM) → no CH segment at all.
  assert.ok(!buildFooter({ contextPercent: 43, cacheHitPercent: undefined }).includes('CH'))
})

test('buildFooter shows the thinking level only when known', () => {
  assert.equal(buildFooter({ thinking: 'medium' }), '🧠 medium')
  assert.equal(buildFooter({ thinking: 'off' }), '🧠 off')
  assert.equal(buildFooter({}), '')
})

test('footerFieldsOf derives fields from the run state and clock', () => {
  // No request/header seen yet → the thinking level is unknown, field omitted.
  assert.equal(footerFieldsOf(initialRunState(), 0).thinking, undefined)
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('request/header', { header: { config: { provider: 'p', model: 'org/deepseek-v4' } } }, 1100, 2))
  foldBoundEvent(state, event('request/context', { contextWindow: 1000 }, 1200, 3))
  foldBoundEvent(state, event('assistant/message', {
    usage: { inputTokens: 400, outputTokens: 100 },
    message: { content: [{ type: 'text', text: 'x' }] },
  }, 1300, 4))
  foldBoundEvent(state, event('tool/call', { callId: 'c', name: 'bash', arguments: '' }, 1400, 5))
  foldBoundEvent(state, event('tool/result', { message: { content: [] } }, 1500, 6))
  const fields = footerFieldsOf(state, 2000)
  assert.equal(fields.model, 'org/deepseek-v4')
  assert.equal(fields.rounds, 1)
  assert.equal(fields.elapsedMs, 1000)
  assert.equal(fields.toolCalls, 1)
  // 500 tokens of a 1000-token window → 50%.
  assert.equal(fields.contextPercent, 50)
  assert.equal(fields.contextTokens, undefined)
  // Usage carried no cache components → CH stays absent, not a fake 0.0%.
  assert.equal(fields.cacheHitPercent, undefined)
  // Header seen, effort absent → off (not omitted); a real level renders verbatim.
  assert.equal(fields.thinking, 'off')
})

test('footerFieldsOf carries the segment cache-hit rate once cache usage arrives', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('request/header', { header: { config: { provider: 'p', model: 'm' } } }, 1100, 2))
  foldBoundEvent(state, event('assistant/message', {
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 400 },
    message: { content: [{ type: 'text', text: 'cold start' }] },
  }, 1200, 3))
  // Pure cache-write round: 0% so far — but the field is PRESENT (activity > 0).
  assert.equal(footerFieldsOf(state, 1300).cacheHitPercent, 0)
  foldBoundEvent(state, event('assistant/message', {
    usage: { inputTokens: 20, outputTokens: 30, cacheReadTokens: 380, cacheWriteTokens: 30 },
    message: { content: [{ type: 'text', text: 'warm' }] },
  }, 1400, 4))
  // read 380 / (120 input + 380 read + 430 write) — output never in the denominator.
  assert.equal(footerFieldsOf(state, 1500).cacheHitPercent, 380 / 930 * 100)
})

test('shortModelName strips the provider path', () => {
  assert.equal(shortModelName('deepseek-v4'), 'deepseek-v4')
  assert.equal(shortModelName('org/nested/deepseek-v4'), 'deepseek-v4')
})

test('the turn card closes with a stats footer line behind a divider (no Round repeat)', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('request/header', { header: { config: { provider: 'p', model: 'm', reasoningEffort: 'high' } } }, 1100, 2))
  foldBoundEvent(state, event('request/context', { contextWindow: 1000 }, 1200, 3))
  foldBoundEvent(state, event('assistant/message', {
    usage: { inputTokens: 400, outputTokens: 100 },
    message: { content: [{ type: 'text', text: 'x' }] },
  }, 1300, 4))
  const { card, hash } = buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 2000 })
  // Schema V2 rejects `tag: note` (server 200861) — stats ride the markdown.
  assert.equal(card.body.elements.length, 1)
  assert.equal(card.body.elements[0].tag, 'markdown')
  const body = card.body.elements[0].content
  assert.ok(body.includes('\n---\n\n⏱ 1s · 🤖 m · 🧠 high · 📊 ctx 50%'))
  // The round lives in the card header — the footer must not repeat it.
  assert.ok(!body.includes('Round '))
  // The hash covers the footer so beat patches follow it.
  assert.ok(hash.includes('🧠 high'))
})

test('no built card ever carries a note element (schema V2 rejects it)', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  const turn = buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 2000 }).card
  for (const card of [turn, buildProgressCard('b', '⏱ 1s'), buildProgressCard('b', ''), buildBodyCard('b')]) {
    assert.equal(JSON.stringify(card).includes('"tag":"note"'), false)
  }
})

// ----------------------------------------------------------- progress card --

test('buildProgressCard appends the stats footer behind a divider in one markdown element', () => {
  const card = buildProgressCard('step one done', '⏱ 30s · Round 2')
  assert.equal(card.schema, '2.0')
  assert.deepEqual(card.config, { width_mode: 'fill' })
  assert.equal(card.body.elements.length, 1)
  assert.equal(card.body.elements[0].tag, 'markdown')
  assert.equal(card.body.elements[0].content, 'step one done\n\n---\n\n⏱ 30s · Round 2')
})

test('buildProgressCard omits the divider when the footer is empty', () => {
  const card = buildProgressCard('body only', '')
  assert.equal(card.body.elements.length, 1)
  assert.equal(card.body.elements[0].content, 'body only')
})

// ------------------------------------------------------- /resume table card --

function resumeRow(overrides = {}) {
  return { index: 1, sessionId: 'abcdefgh1234', dir: 'repo', createdAt: 1000, lastTime: undefined, preview: '', ...overrides }
}

test('session list card renders a native schema 2.0 table with three columns', () => {
  const rows = [
    resumeRow({ index: 1, preview: 'first prompt', lastTime: 86_400_000 }),
    resumeRow({ index: 2, dir: 'tmp', createdAt: 3_600_000, preview: 'tmp · zz' }),
  ]
  const card = buildSessionListCard(rows, 100_000_000)
  assert.equal(card.schema, '2.0')
  assert.deepEqual(card.config, { width_mode: 'fill' })
  assert.equal(card.body.elements.length, 2)
  const table = card.body.elements[0]
  assert.equal(table.tag, 'table')
  // One page per delivered batch — buildResumeRows already capped the list.
  assert.equal(table.page_size, 2)
  assert.deepEqual(
    table.columns.map(c => c.display_name),
    ['#', '会话', '时间'],
  )
  assert.deepEqual(table.columns.map(c => [c.name, c.data_type]), [
    ['index', 'number'],
    ['session', 'text'],
    ['time', 'text'],
  ])
  // Rows render verbatim — no growth beyond the truncated input.
  assert.equal(table.rows.length, rows.length)
  assert.deepEqual(table.rows.map(r => r.index), [1, 2])
  // lastTime wins over createdAt; missing lastTime degrades to createdAt.
  assert.match(table.rows[0].time, /^\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(typeof table.rows[1].time, 'string')
  assert.equal(card.body.elements[1].tag, 'markdown')
  assert.equal(card.body.elements[1].content, '回复 /resume N 进入对应会话')
})

test('session list cell appends the project dir unless the fallback already has it', () => {
  const rows = [
    resumeRow({ preview: 'fix the login bug', dir: 'dsh-feishu' }),
    resumeRow({ index: 2, preview: 'repo · ab12cd34', dir: 'repo' }),
    // False-positive guard: the preview merely *contains* the dir but is not
    // the fallback form, so the dir must still be appended.
    resumeRow({ index: 3, preview: 'fix repo bugs', dir: 'repo' }),
  ]
  const { body } = buildSessionListCard(rows, 0)
  assert.equal(body.elements[0].rows[0].session, 'fix the login bug · dsh-feishu')
  // Fallback preview (`dir · short-id`) is not duplicated with a second dir.
  assert.equal(body.elements[0].rows[1].session, 'repo · ab12cd34')
  assert.equal(body.elements[0].rows[2].session, 'fix repo bugs · repo')
})

test('session list page_size clamps to the official [1, 10] range', () => {
  const many = Array.from({ length: 12 }, (_, i) => resumeRow({ index: i + 1 }))
  const table = buildSessionListCard(many, 0).body.elements[0]
  assert.equal(table.rows.length, 12)
  assert.equal(table.page_size, 10) // official upper bound
  const one = buildSessionListCard([resumeRow()], 0).body.elements[0]
  assert.equal(one.page_size, 1)
})

test('session list normalizes unsorted rows so # matches the /resume N position', () => {
  // Input arrives already in positional order (buildResumeRows assigns
  // indexes by position); the sort below is defensive normalization only.
  const rows = [
    resumeRow({ index: 1, preview: 'first' }),
    resumeRow({ index: 2, preview: 'second' }),
    resumeRow({ index: 3, preview: 'third' }),
  ]
  const { body } = buildSessionListCard(rows, 0)
  assert.deepEqual(body.elements[0].rows.map(r => r.session), ['first · repo', 'second · repo', 'third · repo'])
  assert.deepEqual(body.elements[0].rows.map(r => r.index), [1, 2, 3])
})

test('session list throws when indexes are not contiguous from 1 (caller bug)', () => {
  const rows = [
    resumeRow({ index: 1 }),
    resumeRow({ index: 3 }),
  ]
  assert.throws(() => buildSessionListCard(rows, 0), /index contract broken/)
})

// Out-of-order but contiguous input would render numbers that pick the wrong
// row via pickResumeRow's positional lookup — it must throw, not normalize.
// This closes the blind spot of asserting only after sorting.
test('session list throws on out-of-order input even when indexes are contiguous', () => {
  const rows = [
    resumeRow({ index: 2, preview: 'second' }),
    resumeRow({ index: 1, preview: 'first' }),
    resumeRow({ index: 3, preview: 'third' }),
  ]
  assert.throws(() => buildSessionListCard(rows, 0), /index contract broken/)
})

test('empty session list degrades to a markdown notice without a table', () => {
  const card = buildSessionListCard([], 0)
  assert.equal(card.schema, '2.0')
  assert.equal(card.body.elements.length, 1)
  assert.equal(card.body.elements[0].tag, 'markdown')
  assert.equal(card.body.elements[0].content, '没有可恢复的会话。')
})

// --------------------------------------------- /resume markdown list fallback --

test('markdown session list renders a GFM ordered list with preview and the hint tail line', () => {
  const rows = [
    resumeRow({ index: 1, dir: 'github', lastTime: 86_400_000, preview: 'fix the login bug' }),
    // Inspect-failed fallback preview (`dir · short-id`) duplicates the head —
    // it must be dropped, leaving no dangling separator.
    resumeRow({ index: 2, dir: 'tmp', createdAt: 3_600_000, sessionId: 'zz9876543210', preview: 'tmp · zz987654' }),
    resumeRow({ index: 3, dir: 'tmp', createdAt: 1_800_000, sessionId: 'yy7777777777', preview: '' }),
  ]
  const card = buildSessionListAsMarkdown(rows, 100_000_000)
  assert.equal(card.schema, '2.0')
  assert.deepEqual(card.config, { width_mode: 'fill' })
  // Ships through the buildBodyCard channel: one markdown element.
  assert.equal(card.body.elements.length, 1)
  assert.equal(card.body.elements[0].tag, 'markdown')
  const lines = card.body.elements[0].content.split('\n')
  // Ordered-list numbering matches rows[].index — /resume N picks by position.
  // The line carries the same info as the table's session cell (preview · dir):
  // dir sits in the bold head, the clipped preview follows the short id.
  assert.match(lines[0], /^1\. \*\*github · \d{2}-\d{2} \d{2}:\d{2}\*\* · abcdefgh · fix the login bug$/)
  assert.match(lines[1], /^2\. \*\*tmp · \d{2}-\d{2} \d{2}:\d{2}\*\* · zz987654$/)
  assert.match(lines[2], /^3\. \*\*tmp · \d{2}-\d{2} \d{2}:\d{2}\*\* · yy777777$/)
  assert.equal(lines.at(-1), '回复 /resume N 进入对应会话')
})

test('markdown session list clips long previews to keep phone lines readable', () => {
  const rows = [resumeRow({ index: 1, preview: 'x'.repeat(100) })]
  const lines = buildSessionListAsMarkdown(rows, 0).body.elements[0].content.split('\n')
  assert.ok(lines[0].length < 100)
  assert.match(lines[0], /· x+…$/)
})

test('markdown session list throws on non-contiguous indexes (caller bug)', () => {
  const rows = [resumeRow({ index: 1 }), resumeRow({ index: 3 })]
  assert.throws(() => buildSessionListAsMarkdown(rows, 0), /index contract broken/)
})

// Same blind-spot fix as the table card: contiguous but out-of-order input
// must throw instead of silently renumbering against pickResumeRow's lookup.
test('markdown session list throws on out-of-order input even when indexes are contiguous', () => {
  const rows = [
    resumeRow({ index: 2, sessionId: 'bbbb00000001' }),
    resumeRow({ index: 1, sessionId: 'aaaa00000001' }),
  ]
  assert.throws(() => buildSessionListAsMarkdown(rows, 0), /index contract broken/)
})

test('empty markdown session list reuses the shared empty notice', () => {
  const card = buildSessionListAsMarkdown([], 0)
  assert.equal(card.body.elements.length, 1)
  assert.equal(card.body.elements[0].content, '没有可恢复的会话。')
})
