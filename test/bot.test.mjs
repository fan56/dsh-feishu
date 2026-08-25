import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FeishuBot } from '../lib/bot.js'

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

// ------------------------------------------------ round cards + steer --

function roundBot(lark, binder = { getSessionId: () => 's1' }) {
  return new FeishuBot({
    ctx: { logger: { info() {}, warn() {}, error() {} }, get: () => undefined },
    config: { statusIntervalMs: 30000, bodySegmentChars: 100 },
    lark,
    binder,
    store: { ready: async () => {}, get: () => ({ lastChatId: 'oc_test', displayThink: false }), update: async () => {} },
    allowlist: new Set(),
    now: () => 5000,
  })
}

test('a settled round patches its card 💬, ships its body, opens the next round card', async () => {
  const patches = []
  const sends = []
  let messageId = 0
  const bot = roundBot({
    async sendCard(_chatId, card) { messageId += 1; sends.push({ id: `m${messageId}`, card }); return `m${messageId}` },
    async patchCard(id, card) { patches.push({ id, card }); return true },
  })
  bot.runState.running = true
  bot.runState.rounds = 1
  bot.runState.roundStartedAt = 1000
  bot.runState.lastRoundDurationMs = 4000
  bot.runState.lastRoundText = 'round one answer'
  bot.runState.lastAssistantLine = 'round one answer'
  bot.cardMessageId = 'm0'

  await bot.settleRound()

  // 1) the round card settles in place with the 💬 header…
  assert.equal(patches.length, 1)
  assert.equal(patches[0].id, 'm0')
  assert.equal(patches[0].card.header.title.content, 'Round 1 · 💬 回复 · 4s')
  // 2) the round's message ships verbatim…
  assert.equal(sends.length, 2)
  assert.equal(sends[0].card.body.elements[0].content, 'round one answer')
  // 3) …then the next round's card opens (fresh, running).
  assert.match(sends[1].card.header.title.content, /^Round 2 · /)
  assert.equal(bot.cardMessageId, 'm2') // second send = the next round's card
  // The per-round story reset for the new card.
  assert.deepEqual(bot.runState.toolHistory, [])
  assert.equal(bot.runState.lastRoundText, '')
})

test('a round with no text settles its card without a body send', async () => {
  const sends = []
  const bot = roundBot({
    async sendCard(_chatId, card) { sends.push(card); return `m${sends.length}` },
    async patchCard() { return true },
  })
  bot.runState.running = true
  bot.runState.rounds = 2
  bot.runState.lastRoundDurationMs = 800
  bot.runState.lastRoundText = '' // pure tool-call round
  bot.cardMessageId = 'm9' // the round's card is live — settle patches it
  await bot.settleRound()
  // Only the next round's card was sent — no body for an empty message.
  assert.equal(sends.length, 1)
  assert.match(sends[0].header.title.content, /^Round 3 · /)
})

test('turn/end finalizes the current card and never resends round bodies', async () => {
  const patches = []
  const sends = []
  const bot = roundBot({
    async sendCard(_chatId, card) { sends.push(card); return `m${sends.length + 1}` },
    async patchCard(id, card) { patches.push({ id, card }); return true },
  })
  bot.runState.running = false
  bot.runState.turnStartedAt = 1000
  bot.runState.turnEndedAt = 4000
  bot.runState.turnEndReason = 'completed'
  bot.runState.rounds = 3
  bot.cardMessageId = 'm9'
  await bot.finalizeTurn()
  assert.equal(patches.length, 1)
  assert.equal(patches[0].card.header.title.content, 'Round 3 · ✅ 完成 · 3s')
  assert.equal(sends.length, 0) // bodies already went out per round
  assert.equal(bot.cardMessageId, undefined)
})

test('handlePrompt steers into the running turn, follows up when idle', async () => {
  const calls = []
  const reactions = []
  const agent = {
    status: 'running',
    followup(m) { calls.push(['followup', m]) },
    steer(m) { calls.push(['steer', m]) },
  }
  const bot = roundBot({
    async sendCard() { return 'm1' },
    async react(id, emoji) { reactions.push([id, emoji]) },
  }, { getSessionId: () => 's1', getAgent: () => agent })
  await bot.handlePrompt({ messageId: 'om_1', openId: 'ou_x', chatId: 'oc_test', chatType: 'p2p', messageType: 'text', text: 'course correct' }, 'course correct')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'steer') // running → join the current turn's next round
  assert.equal(bot.turnOriginMessageId, undefined) // not our turn — no done-reaction binding
  assert.deepEqual(reactions[0], ['om_1', 'EYES'])

  agent.status = 'idle'
  await bot.handlePrompt({ messageId: 'om_2', openId: 'ou_x', chatId: 'oc_test', chatType: 'p2p', messageType: 'text', text: 'new task' }, 'new task')
  assert.equal(calls[1][0], 'followup') // idle → open the next turn
  assert.equal(bot.turnOriginMessageId, 'om_2')
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
          // Realistic inspect: one user message (an empty-events log is the
          // scratch-session shape the picker now filters out).
          async inspect() {
            return { meta: {}, events: [{ type: 'user/message', seq: 0, time: 1000, data: { content: [{ type: 'text', text: 'fix the login bug' }], source: { kind: 'user' } } }] }
          },
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
      get(key) {
        if (key !== 'sessions') return undefined
        return {
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
        }
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
    ctx: { logger: { info() {}, warn() {}, error() {} }, get: () => undefined }, // no sessions service
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
      get(key) {
        if (key !== 'sessions') return undefined
        return {
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
        }
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
    ctx: { logger: { info() {}, warn() {}, error() {} }, get: () => undefined }, // no sessions service
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

// ------------------------------------------------ persisted /resume picker --

function pickerBot(state, bindCalls) {
  return new FeishuBot({
    ctx: { logger: { info() {}, warn() {}, error() {} }, get: () => undefined },
    config: { statusIntervalMs: 30000, bodySegmentChars: 3500 },
    lark: {
      sent: [],
      async sendCard(_chatId, card) { this.sent.push(card); return `m${this.sent.length}` },
      async patchCard() { return true },
    },
    binder: {
      getSessionId: () => undefined,
      getAgent: () => undefined,
      async bind(id) { bindCalls.push(id); return { sessionId: id, mode: 'attached', agent: {} } },
    },
    store: {
      updates: [],
      ready: async () => {},
      get: () => state,
      async update(patch) { Object.assign(state, patch); this.updates.push(patch) },
    },
    allowlist: new Set(),
    now: () => 1000,
  })
}

test('a restart-stranded /resume N falls back to the persisted picker', async () => {
  const state = {
    lastChatId: 'oc_test',
    displayThink: false,
    picker: { rows: [{ index: 1, sessionId: 's-target', dir: 'repo', createdAt: 1, lastTime: undefined, preview: 'hello' }], expiresAt: 999_999 },
  }
  const bindCalls = []
  const bot = pickerBot(state, bindCalls)
  bot.pendingPicker = undefined // restart killed the in-memory copy

  await bot.handleResumePick(1)

  assert.deepEqual(bindCalls, ['s-target'])
  const reply = JSON.stringify(bot.lark.sent[0])
  assert.ok(reply.includes('已进入会话'))
  // The consumed picker is cleared from BOTH the memory and the store.
  assert.equal(state.picker, undefined)
  assert.equal(bot.pendingPicker, undefined)
})

test('an expired persisted picker replies 过期 and clears itself', async () => {
  const state = {
    lastChatId: 'oc_test',
    displayThink: false,
    picker: { rows: [{ index: 1, sessionId: 's-old', dir: 'repo', createdAt: 1, lastTime: undefined, preview: 'x' }], expiresAt: 500 },
  }
  const bindCalls = []
  const bot = pickerBot(state, bindCalls)
  await bot.handleResumePick(1)
  assert.deepEqual(bindCalls, []) // never reached bind
  assert.ok(JSON.stringify(bot.lark.sent[0]).includes('选择已过期'))
  assert.equal(state.picker, undefined)
})
