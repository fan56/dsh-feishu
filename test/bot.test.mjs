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
