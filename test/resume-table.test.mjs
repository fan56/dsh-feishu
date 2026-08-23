import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildResumeRows,
  formatResumeTable,
  isResumableSessionHeader,
  pickResumeRow,
  previewOfEvents,
} from '../lib/resume-table.js'

function header(id, createdAt, overrides = {}) {
  return { version: 1, id, createdAt, delegationDepth: 0, ...overrides }
}

function userEvent(text, kind = 'user') {
  return { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text }], source: { kind } } }
}

function assistantEvent(text) {
  return { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text }] } } }
}

function persistence(headers, eventsById = new Map()) {
  return {
    async list() { return headers },
    async inspect(id) {
      const events = eventsById.get(String(id))
      if (events === undefined) throw new Error('missing')
      return { meta: headers.find(h => String(h.id) === String(id)), events }
    },
  }
}

test('root-session filter uses VALUE tests on delegationDepth', () => {
  assert.equal(isResumableSessionHeader(header('a', 1)), true)
  // jsonl restore materialises delegationDepth: 0 — presence must not exclude.
  assert.equal(isResumableSessionHeader({ ...header('b', 1), delegationDepth: 0 }), true)
  assert.equal(isResumableSessionHeader({ ...header('c', 1), delegationDepth: undefined }), true)
  assert.equal(isResumableSessionHeader(header('d', 1, { origin: 'subagent', delegationDepth: 1 })), false)
  assert.equal(isResumableSessionHeader(header('e', 1, { delegationDepth: 2 })), false)
})

test('rows sort by createdAt desc and cap at the limit', async () => {
  const headers = [
    header('old', 100),
    header('newest', 300),
    header('middle', 200),
    header('sub', 400, { origin: 'subagent', delegationDepth: 1 }),
  ]
  const rows = await buildResumeRows(persistence(headers), 2)
  assert.deepEqual(rows.map(r => r.sessionId), ['newest', 'middle'])
  assert.deepEqual(rows.map(r => r.index), [1, 2])
})

test('preview prefers the first direct human prompt and skips injected noise', () => {
  const events = [
    userEvent('workspace instructions', 'agent-instructions'),
    userEvent('tool output', 'tool'),
    userEvent('real question'),
    assistantEvent('answer'),
  ]
  assert.equal(previewOfEvents(events), 'real question')
  // Falls back to non-injected user text, then assistant text.
  assert.equal(previewOfEvents([userEvent('goal prompt', 'cron'), assistantEvent('a')]), 'goal prompt')
  assert.equal(previewOfEvents([assistantEvent('only answer')]), 'only answer')
  assert.equal(previewOfEvents([]), undefined)
})

test('inspect enriches preview and lastTime; failures degrade to a fallback', async () => {
  const headers = [header('rich', 100, { cwd: '/home/me/repo' }), header('broken', 50, { cwd: '/tmp' })]
  const events = new Map([
    ['rich', [userEvent('hello world this is the first prompt'), { type: 'turn/end', seq: 9, time: 123456, data: {} }]],
  ])
  const rows = await buildResumeRows(persistence(headers, events))
  const rich = rows.find(r => r.sessionId === 'rich')
  assert.equal(rich.preview, 'hello world this is the first prompt')
  assert.equal(rich.lastTime, 123456)
  assert.equal(rich.dir, 'repo')
  const broken = rows.find(r => r.sessionId === 'broken')
  assert.match(broken.preview, /^tmp · broken$/) // cwd basename + short id fallback
  assert.equal(broken.lastTime, undefined)
})

test('formatResumeTable renders index rows and the reply hint', () => {
  const rows = [
    { index: 1, sessionId: 'abcdefgh1234', dir: 'repo', createdAt: 100, lastTime: 200, preview: 'first prompt' },
    { index: 2, sessionId: 'zz', dir: 'tmp', createdAt: 50, lastTime: undefined, preview: 'tmp · zz' },
  ]
  const text = formatResumeTable(rows, 1000)
  assert.match(text, /📋 可恢复会话（最近）：/)
  assert.match(text, /1\. repo · .* · first prompt/)
  assert.match(text, /2\. tmp · .* · tmp · zz/)
  assert.match(text, /回复 \/resume N 进入对应会话/)
  assert.equal(formatResumeTable([], 0), '没有可恢复的会话。')
})

test('pickResumeRow bounds-checks the index', () => {
  const rows = [
    { index: 1, sessionId: 'a', dir: 'x', createdAt: 1, lastTime: 1, preview: 'p' },
    { index: 2, sessionId: 'b', dir: 'x', createdAt: 1, lastTime: 1, preview: 'q' },
  ]
  assert.equal(pickResumeRow(rows, 1).sessionId, 'a')
  assert.equal(pickResumeRow(rows, 2).sessionId, 'b')
  assert.equal(pickResumeRow(rows, 0), undefined)
  assert.equal(pickResumeRow(rows, 3), undefined)
  assert.equal(pickResumeRow(rows, 1.5), undefined)
})
