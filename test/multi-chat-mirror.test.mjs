/**
 * Multi-chat mirror: one bound session, several groups.
 *
 * The ACTIVE chat (`lastChatId`) owns the primary run card; every chat listed in
 * `mirrorChatIds` gets a copy of the same card and every later patch. Per-chat
 * failures are contained, and only the run card mirrors — command replies stay
 * in the chat that asked.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FeishuBot } from '../lib/bot.js'

/** Bot with an active chat, optional mirrors, and a recording lark surface. */
function mirrorBot({ mirrorChatIds = [], failChats = [], failingPatch = [], active = 'oc_active' } = {}) {
  const calls = { sends: [], patches: [] }
  let seq = 0
  const lark = {
    async sendCard(chatId, card) {
      if (failChats.includes(chatId)) return undefined
      seq += 1
      const id = `m${seq}`
      calls.sends.push({ chatId, id, card })
      return id
    },
    async patchCard(id, card) {
      calls.patches.push({ id, card })
      return !failingPatch.includes(id)
    },
  }
  const bot = new FeishuBot({
    ctx: { logger: { info() {}, warn() {}, error() {} }, get: () => undefined },
    config: { statusIntervalMs: 30000, bodySegmentChars: 100, mirrorChatIds },
    lark,
    binder: { getSessionId: () => 's1', isReadOnlyView: () => false },
    store: { ready: async () => {}, get: () => ({ lastChatId: active, displayThink: false }), update: async () => {} },
    allowlist: new Set(),
    now: () => 5000,
  })
  return { bot, calls }
}

/** The run-view state openCard()/settleRound() render from. */
function running(bot) {
  bot.runState.running = true
  bot.runState.rounds = 1
  bot.runState.roundStartedAt = 1000
  bot.runState.turnStartedAt = 1000
  bot.runState.lastAssistantLine = 'working'
}

test('opening the run card sends it to the active chat and every mirror', async () => {
  const { bot, calls } = mirrorBot({ mirrorChatIds: ['oc_group_b', 'oc_group_c'] })
  running(bot)
  await bot.openCard()

  assert.deepEqual(calls.sends.map(send => send.chatId), ['oc_active', 'oc_group_b', 'oc_group_c'])
  // One card build, three deliveries — mirrors are copies, not re-renders.
  const titles = new Set(calls.sends.map(send => send.card.header.title.content))
  assert.equal(titles.size, 1)
  assert.equal(bot.cardMessageId, 'm1')
  assert.deepEqual([...bot.cardMirrors], [['oc_group_b', 'm2'], ['oc_group_c', 'm3']])
})

test('the active chat is never mirrored twice, even if it is listed', async () => {
  const { bot, calls } = mirrorBot({ mirrorChatIds: ['oc_active', 'oc_group_b', 'oc_group_b'] })
  running(bot)
  await bot.openCard()

  assert.deepEqual(calls.sends.map(send => send.chatId), ['oc_active', 'oc_group_b'])
  assert.deepEqual([...bot.cardMirrors.keys()], ['oc_group_b'])
})

test('a mirror that cannot be delivered is skipped without breaking the primary', async () => {
  const { bot, calls } = mirrorBot({ mirrorChatIds: ['oc_group_b', 'oc_group_broken'], failChats: ['oc_group_broken'] })
  running(bot)
  await bot.openCard()

  assert.equal(bot.cardMessageId, 'm1')
  assert.deepEqual(calls.sends.map(send => send.chatId), ['oc_active', 'oc_group_b'])
  assert.deepEqual([...bot.cardMirrors.keys()], ['oc_group_b'])
})

test('settling a round patches the primary and every mirror', async () => {
  const { bot, calls } = mirrorBot({ mirrorChatIds: ['oc_group_b'] })
  running(bot)
  bot.runState.lastRoundText = 'short answer' // ≤ bodySegmentChars → embeds
  await bot.openCard()
  calls.patches.length = 0
  await bot.settleRound()

  // The settle patch lands on the primary (m1) and the mirror copy (m2)…
  const settleIds = calls.patches.map(patch => patch.id)
  assert.ok(settleIds.includes('m1'), `primary patched: ${settleIds.join(',')}`)
  assert.ok(settleIds.includes('m2'), `mirror patched: ${settleIds.join(',')}`)
  // …then the next round's card opens for both chats again.
  assert.deepEqual(calls.sends.map(send => send.chatId), ['oc_active', 'oc_group_b', 'oc_active', 'oc_group_b'])
  assert.equal(bot.cardMessageId, 'm3')
  assert.deepEqual([...bot.cardMirrors], [['oc_group_b', 'm4']])
})

test('a mirror whose patch fails keeps the primary path intact', async () => {
  const { bot, calls } = mirrorBot({ mirrorChatIds: ['oc_group_b'], failingPatch: ['m2'] })
  running(bot)
  await bot.openCard()
  await bot.finalizeTurn()

  const ids = calls.patches.map(patch => patch.id)
  assert.ok(ids.includes('m1') && ids.includes('m2'))
  // The end-of-turn card cleared the live card in every chat.
  assert.equal(bot.cardMessageId, undefined)
  assert.equal(bot.cardMirrors.size, 0)
})

test('the end-of-turn card mirrors too, then the run card is forgotten everywhere', async () => {
  const { bot, calls } = mirrorBot({ mirrorChatIds: ['oc_group_b'] })
  running(bot)
  await bot.openCard()
  await bot.finalizeTurn()

  assert.deepEqual(calls.patches.map(patch => patch.id), ['m1', 'm2'])
  assert.equal(bot.cardMessageId, undefined)
  assert.equal(bot.cardMirrors.size, 0)
  assert.equal(bot.cardHash, undefined)
})

test('an unbound run view drops the mirror copies as well', async () => {
  const { bot } = mirrorBot({ mirrorChatIds: ['oc_group_b'] })
  running(bot)
  await bot.openCard()
  assert.equal(bot.cardMirrors.size, 1)

  bot.resetRunView()

  assert.equal(bot.cardMessageId, undefined)
  assert.equal(bot.cardMirrors.size, 0)
})

test('command replies stay in the chat that asked — only run cards mirror', async () => {
  const { bot, calls } = mirrorBot({ mirrorChatIds: ['oc_group_b'] })
  running(bot)
  await bot.openCard()
  calls.sends.length = 0

  await bot.reply('只有这个群能看到这句')

  assert.deepEqual(calls.sends.map(send => send.chatId), ['oc_active'])
})
