/**
 * Phone-side btw card manager (src/btw-bot.ts → lib/btw-bot.js): the card
 * lifecycle bridge between the pure controller and the Lark surface. Focus:
 * the first-frame throttle — the FIRST text delta patches the card
 * immediately, later deltas defer to the beat.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { BtwManager } from '../lib/btw-bot.js'

const flush = () => new Promise(resolve => setImmediate(resolve))

async function* chunksOf(list) {
  yield* list
}

/** Manager rig: structural fakes + recorded outbound card ops. */
function makeRig(overrides = {}) {
  const calls = { sent: 0, patched: [], notified: [] }
  const deps = {
    stream: () => chunksOf(overrides.streamChunks ?? [{ type: 'finish', reason: { kind: 'stop' } }]),
    sendCard: async () => { calls.sent += 1; return overrides.messageId ?? 'msg-1' },
    patchCard: async (messageId, card) => {
      calls.patched.push({ messageId, status: card?.header?.title?.content })
      return true
    },
    notify: text => { calls.notified.push(text) },
    resolveSelection: () => ({ provider: 'p', model: 'm' }),
    buildSnapshot: () => [],
    isMainRunning: () => overrides.mainRunning ?? true,
    isReadOnlyView: () => overrides.readOnly ?? false,
    hasCapturingSurface: () => overrides.capturing ?? false,
    beatMs: 5000,
    logger: { warn: () => {} },
  }
  const manager = new BtwManager(deps)
  return { manager, calls }
}

test('btw: the first text delta patches the card immediately', async () => {
  const { manager, calls } = makeRig({
    streamChunks: [
      { type: 'text-delta', text: '你好' },
      { type: 'text-delta', text: '，世界' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  await manager.handleBtw('你好吗', 'chat-1')
  await flush()
  // First delta shipped the card right away; the second delta was throttled
  // to the beat (no patch until the 5s tick or the settle).
  assert.ok(calls.sent >= 1, 'card was sent')
  const immediate = calls.patched.filter(p => p.status?.includes('回答中') || p.status?.includes('思考中'))
  assert.equal(immediate.length, 1, 'exactly one immediate streaming patch')
  // The settle finalized the card in place (done state).
  const settled = calls.patched.some(p => p.status?.includes('✅ btw'))
  assert.ok(settled, 'the settle patches the done card')
})

test('btw: a run with no text deltas never ships an empty first frame', async () => {
  const { manager, calls } = makeRig({
    streamChunks: [{ type: 'finish', reason: { kind: 'stop' } }],
  })
  await manager.handleBtw('直接结束', 'chat-1')
  await flush()
  // No text — no streaming patch; only the settled done card.
  const streamingPatches = calls.patched.filter(p => p.status?.includes('思考中') || p.status?.includes('回答中'))
  assert.equal(streamingPatches.length, 0)
  assert.ok(calls.patched.some(p => p.status?.includes('✅ btw')))
})

test('btw: a failed run settles the card with the error, no streaming patch', async () => {
  const { manager, calls } = makeRig({
    streamChunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }],
  })
  await manager.handleBtw('会失败', 'chat-1')
  await flush()
  const streamingPatches = calls.patched.filter(p => p.status?.includes('思考中') || p.status?.includes('回答中'))
  assert.equal(streamingPatches.length, 0)
  assert.ok(calls.patched.some(p => p.status?.includes('❌ btw 失败')))
})
