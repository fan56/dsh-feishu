import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildBodyCard,
  buildFooter,
  buildProgressCard,
  buildSessionListCard,
  buildStatusCard,
  footerFieldsOf,
  shortModelName,
  statusLine,
  todoLine,
  turnEndIcon,
} from '../lib/card.js'
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

test('todo line with an empty in-progress title drops the icon segment', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('todo/write', { todos: [
    { content: '', status: 'in_progress' },
    { content: 'two', status: 'pending' },
  ] }, 1100, 2))
  // No dangling `◐  · ` separator in front of the counter.
  assert.equal(todoLine(state), '☑ 0/2')
})

test('subagent rows render compactly with running-first order', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('tool-workflow/agent-start', { runId: 'r', seq: 1, label: 'oldfox', childId: 'c2aa' }, 1100, 2))
  foldBoundEvent(state, event('tool-workflow/agent-start', { runId: 'r', seq: 2, label: 'workhorse', childId: 'c1bb' }, 1200, 3))
  foldChildEvent(state, 'c1bb', event('assistant/message', { message: { content: [{ type: 'text', text: 'digging' }] } }, 1300, 4))
  const md = buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 1400 }).card.elements[0].text.content
  assert.match(md, /🧵 ×2/)
  // Display label = real name + short-hash suffix.
  assert.match(md, /├ workhorse·c1bb ↻ · round 1 · digging/)
  assert.match(md, /├ oldfox·c2aa ↻ · round 0/)
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
    toolCalls: 23,
    thinking: 'high',
  })
  assert.equal(line, '⏱ 12m34s · Turn 8 · 🤖 deepseek-v4 · 📊 ctx 43% · 🔧 23 calls · 🧠 high')
})

test('buildFooter omits missing fields without leaving separators', () => {
  assert.equal(buildFooter({}), '')
  assert.equal(buildFooter({ model: 'deepseek-v4' }), '🤖 deepseek-v4')
  // Zero counters are noise, not data — skipped like unknown fields.
  assert.equal(buildFooter({ rounds: 0, toolCalls: 0, elapsedMs: 5000 }), '⏱ 5s')
})

test('buildFooter falls back from percent to raw tokens', () => {
  const withPercent = buildFooter({ contextPercent: -5, contextTokens: 12_300 })
  assert.match(withPercent, /📊 ctx 0%/) // clamped, percent wins when present
  const tokensOnly = buildFooter({ contextTokens: 950 })
  assert.equal(tokensOnly, '📊 ctx 950')
  assert.equal(buildFooter({ contextTokens: 1_234_000 }), '📊 ctx 1.2M')
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
  // Header seen, effort absent → off (not omitted); a real level renders verbatim.
  assert.equal(fields.thinking, 'off')
})

test('shortModelName strips the provider path', () => {
  assert.equal(shortModelName('deepseek-v4'), 'deepseek-v4')
  assert.equal(shortModelName('org/nested/deepseek-v4'), 'deepseek-v4')
})

test('the status-card note carries the footer plus the help hint', () => {
  const state = initialRunState()
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('request/header', { header: { config: { provider: 'p', model: 'm', reasoningEffort: 'high' } } }, 1100, 2))
  const { card, hash } = buildStatusCard(state, { sessionLabel: 'x', displayThink: false, now: 2000 })
  const note = card.elements[1]
  assert.equal(note.tag, 'note')
  assert.match(note.elements[0].content, /🤖 m/)
  assert.match(note.elements[0].content, /🧠 high/)
  assert.equal(note.elements[1].content, 'dsh-feishu · /help 查看命令')
  // The hash covers the footer so beat patches follow it.
  assert.ok(hash.includes('🧠 high'))
})

// ----------------------------------------------------------- progress card --

test('buildProgressCard ships a schema 2.0 markdown body with note footer', () => {
  const card = buildProgressCard('step one done', '⏱ 30s · Turn 2')
  assert.equal(card.schema, '2.0')
  assert.deepEqual(card.config, { width_mode: 'fill' })
  assert.equal(card.body.elements.length, 2)
  assert.equal(card.body.elements[0].tag, 'markdown')
  assert.equal(card.body.elements[0].content, 'step one done')
  assert.equal(card.body.elements[1].tag, 'note')
  assert.equal(card.body.elements[1].elements[0].content, '⏱ 30s · Turn 2')
})

test('buildProgressCard omits the note when the footer is empty', () => {
  const card = buildProgressCard('body only', '')
  assert.equal(card.body.elements.length, 1)
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
  const rows = [
    resumeRow({ index: 2, preview: 'second' }),
    resumeRow({ index: 1, preview: 'first' }),
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

test('empty session list degrades to a markdown notice without a table', () => {
  const card = buildSessionListCard([], 0)
  assert.equal(card.schema, '2.0')
  assert.equal(card.body.elements.length, 1)
  assert.equal(card.body.elements[0].tag, 'markdown')
  assert.equal(card.body.elements[0].content, '没有可恢复的会话。')
})
