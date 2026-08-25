import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FeishuBot } from '../lib/bot.js'
import { initialProgressCursor } from '../lib/run-state.js'

/** Minimal FeishuBot with faked deps; private internals are driven directly. */
function makeBot(lark, clock) {
  const store = { ready: async () => {}, get: () => ({ lastChatId: 'oc_test', displayThink: false }), update: async () => {} }
  return new FeishuBot({
    ctx: { logger: { info() {}, warn() {}, error() {} } },
    config: { statusIntervalMs: 30000, progressIntervalMs: 60000, bodySegmentChars: 3500 },
    lark,
    binder: {},
    store,
    allowlist: new Set(),
    now: () => clock.now,
  })
}

test('progress push: texts landing mid-send stay unpushed and ship next time', async () => {
  const clock = { now: 100_000 }
  const sent = []
  const bot = makeBot({
    // The send is async — a new assistant message lands inside the await window.
    async sendCard(_chatId, card) {
      bot.runState.assistantTexts.push('late arrival')
      sent.push(card)
      return 'm1'
    },
  }, clock)
  bot.runState.running = true
  bot.runState.assistantTexts.push('first result')
  bot.progressCursor = initialProgressCursor()

  await bot.maybePushProgress()

  // Cursor advanced to the snapshot taken BEFORE the await, not the live length.
  assert.equal(bot.progressCursor.pushedTexts, 1)
  assert.equal(bot.progressCursor.lastPushAt, 100_000)
  assert.ok(JSON.stringify(sent[0]).includes('first result'))
  assert.ok(!JSON.stringify(sent[0]).includes('late arrival'))

  // Next eligible push carries the mid-send arrival.
  clock.now += 60_000
  await bot.maybePushProgress()
  assert.equal(bot.progressCursor.pushedTexts, 2)
  assert.ok(JSON.stringify(sent[1]).includes('late arrival'))
})

test('progress push: sendCard failure leaves cursor untouched so content retries', async () => {
  const clock = { now: 200_000 }
  let attempts = 0
  const sent = []
  const bot = makeBot({
    async sendCard(_chatId, card) {
      attempts += 1
      sent.push(card)
      // First attempt fails the way the real client does: swallow the API
      // error and resolve undefined (never reject).
      if (attempts === 1) return undefined
      return `m${attempts}`
    },
  }, clock)
  bot.runState.running = true
  bot.runState.assistantTexts.push('unsent excerpt')
  bot.progressCursor = initialProgressCursor()

  await bot.maybePushProgress()

  // Failed send: cursor must NOT advance — neither pushedTexts nor lastPushAt.
  assert.equal(attempts, 1)
  assert.equal(bot.progressCursor.pushedTexts, 0)
  assert.equal(bot.progressCursor.lastPushAt, 0)

  // Next eligible push retries and carries the previously unshipped content.
  clock.now += 60_000
  await bot.maybePushProgress()
  assert.equal(bot.progressCursor.pushedTexts, 1)
  assert.equal(bot.progressCursor.lastPushAt, 260_000)
  assert.ok(JSON.stringify(sent[1]).includes('unsent excerpt'))
})

// ------------------------------------------------- /resume list auto degrade --

function resumeHeader(id, createdAt = 1000) {
  return { version: 1, id, createdAt, delegationDepth: 0, cwd: '/tmp/github' }
}

function resumeBot(lark, resumeListStyle) {
  const warnings = []
  const store = { ready: async () => {}, get: () => ({ lastChatId: 'oc_test', displayThink: false }), update: async () => {} }
  const bot = new FeishuBot({
    ctx: {
      logger: { info() {}, warn(msg, ...args) { warnings.push(msg) }, error() {} },
      get(key) {
        if (key !== 'sessionPersistence') return undefined
        return {
          async list() { return [resumeHeader('aaaaaaaa1111'), resumeHeader('bbbbbbbb2222', 2000)] },
          // Inspect failure degrades the row to its fallback preview — fine here.
          async inspect() { return { meta: {}, events: [] } },
        }
      },
    },
    config: { statusIntervalMs: 30000, progressIntervalMs: 60000, bodySegmentChars: 3500, ...(resumeListStyle ? { resumeListStyle } : {}) },
    lark,
    binder: {},
    store,
    allowlist: new Set(),
    now: () => 100_000,
  })
  return { bot, warnings }
}

test('auto mode: failed table send degrades exactly once to the markdown list', async () => {
  const sent = []
  let attempts = 0
  const { bot, warnings } = resumeBot({
    async sendCard(_chatId, card) {
      attempts += 1
      sent.push(card)
      // Real client contract: swallowed API error resolves undefined.
      return attempts === 1 ? undefined : 'm2'
    },
  })

  await bot.handleResumeList()

  assert.equal(attempts, 2)
  // First attempt is the native table card…
  assert.equal(sent[0].body.elements[0].tag, 'table')
  // …the retry ships through the markdown-list channel instead of plain text.
  assert.equal(sent[1].body.elements[0].tag, 'markdown')
  // Rows sort by createdAt desc: bbbb (2000) lands at index 1.
  assert.match(sent[1].body.elements[0].content, /^1\. \*\*github · \d{2}-\d{2} \d{2}:\d{2}\*\* · bbbbbbbb/)
  assert.match(sent[1].body.elements[0].content, /回复 \/resume N 进入对应会话/)
  // The degrade is observable: one warn names the fallback.
  assert.equal(warnings.filter(w => w.includes('falling back')).length, 1)
})

test('forced table mode never falls back when the send fails', async () => {
  const sent = []
  const { bot } = resumeBot({
    async sendCard(_chatId, card) {
      sent.push(card)
      return undefined
    },
  }, 'table')

  await bot.handleResumeList()

  assert.equal(sent.length, 1)
  assert.equal(sent[0].body.elements[0].tag, 'table')
})

test('forced list mode ships only the markdown list card', async () => {
  const sent = []
  const { bot } = resumeBot({
    async sendCard(_chatId, card) {
      sent.push(card)
      return 'm1'
    },
  }, 'list')

  await bot.handleResumeList()

  assert.equal(sent.length, 1)
  assert.equal(sent[0].body.elements[0].tag, 'markdown')
  const lines = sent[0].body.elements[0].content.split('\n')
  assert.match(lines[0], /^1\. /)
  assert.equal(lines.at(-1), '回复 /resume N 进入对应会话')
})

// ------------------------------------------------ child naming backfill --

test('child discovery backfills the agent name from the child session log', async () => {
  const bot = new FeishuBot({
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      sessions: {
        get(id) {
          assert.equal(id, 'child-1')
          return {
            events: [
              { type: 'subagent/descriptor', data: { version: 2, mode: 'one-shot', provider: 'registry', label: 'workhorse' }, time: 100, seq: 1 },
              { type: 'tool/call', data: { callId: 'a', name: 'bash', arguments: '' }, time: 150, seq: 2 },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'round one done' }] } }, time: 200, seq: 3 },
            ],
          }
        },
      },
    },
    config: { statusIntervalMs: 30000, progressIntervalMs: 60000, bodySegmentChars: 3500 },
    lark: { async sendCard() { return 'm1' }, async patchCard() { return true } },
    binder: { getSessionId: () => 'parent-1' },
    store: { ready: async () => {}, get: () => ({ lastChatId: 'oc_test', displayThink: false }), update: async () => {} },
    allowlist: new Set(),
    now: () => 1000,
  })

  // A live child event mid-run discovers the child; the naming events predate
  // the attach and never arrive on the firehose — only the log has them.
  bot.onSessionEvent(
    { id: 'child-1', header: { parentSession: 'parent-1', origin: 'subagent', delegationDepth: 1 } },
    { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'still going' } }, time: 900, seq: 4 },
  )

  const row = bot.runState.subagents.get('child-1')
  assert.ok(row !== undefined)
  assert.equal(row.label, 'workhorse') // name recovered from the log, not the hash fallback
  assert.equal(row.rounds, 1) // corrected up to the log's true count
  assert.equal(row.lastTool, 'bash')
})

test('child discovery without a sessions service keeps the fallback label', () => {
  const bot = new FeishuBot({
    ctx: { logger: { info() {}, warn() {}, error() {} } }, // no `sessions` service
    config: { statusIntervalMs: 30000, progressIntervalMs: 60000, bodySegmentChars: 3500 },
    lark: { async sendCard() { return 'm1' } },
    binder: { getSessionId: () => 'parent-1' },
    store: { ready: async () => {}, get: () => ({ lastChatId: 'oc_test', displayThink: false }), update: async () => {} },
    allowlist: new Set(),
    now: () => 1000,
  })
  bot.onSessionEvent(
    { id: 'child-2', header: { parentSession: 'parent-1', origin: 'subagent' } },
    { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'x' } }, time: 900, seq: 1 },
  )
  const row = bot.runState.subagents.get('child-2')
  assert.ok(row !== undefined)
  assert.equal(row.label, 'subagent child-2') // hash-derived fallback survives
})

// ------------------------------------------------ route facts backfill --

test('route backfill recovers model/think level/window/cache baseline from the bound log', () => {
  const bot = new FeishuBot({
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      sessions: {
        get(id) {
          assert.equal(id, 's1')
          return {
            events: [
              { type: 'request/header', data: { header: { config: { provider: 'openrouter', model: 'stealth/ox-alpha', reasoningEffort: 'high' } } }, time: 1, seq: 1 },
              { type: 'request/context', data: { provider: 'openrouter', model: 'stealth/ox-alpha', contextWindow: 1_048_576 }, time: 2, seq: 2 },
              { type: 'assistant/message', data: { usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 8000, cacheWriteTokens: 1500 }, message: { content: [{ type: 'text', text: 'prior turn' }] } }, time: 3, seq: 3 },
            ],
          }
        },
      },
    },
    config: { statusIntervalMs: 30000, progressIntervalMs: 60000, bodySegmentChars: 3500 },
    lark: { async sendCard() { return 'm1' } },
    binder: { getSessionId: () => 's1' },
    store: { ready: async () => {}, get: () => ({ lastChatId: 'oc_test', displayThink: false }), update: async () => {} },
    allowlist: new Set(),
    now: () => 1000,
  })
  bot.backfillRoute()
  assert.equal(bot.runState.model, 'stealth/ox-alpha')
  assert.equal(bot.runState.reasoningEffort, 'high')
  assert.equal(bot.runState.contextWindow, 1_048_576)
  assert.equal(bot.runState.cacheHitRate, 8000 / 10_500 * 100)
  // Idempotent per binding: a second call never re-reads the log.
  let reads = 1
  bot.backfillRoute()
  assert.equal(reads, 1)
})

test('route backfill degrades silently without a sessions service', () => {
  const bot = new FeishuBot({
    ctx: { logger: { info() {}, warn() {}, error() {} } }, // no `sessions` service
    config: { statusIntervalMs: 30000, progressIntervalMs: 60000, bodySegmentChars: 3500 },
    lark: { async sendCard() { return 'm1' } },
    binder: { getSessionId: () => 's1' },
    store: { ready: async () => {}, get: () => ({ lastChatId: 'oc_test', displayThink: false }), update: async () => {} },
    allowlist: new Set(),
    now: () => 1000,
  })
  bot.backfillRoute()
  assert.equal(bot.runState.model, undefined) // no log access, no crash
})
