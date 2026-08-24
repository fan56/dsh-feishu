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
