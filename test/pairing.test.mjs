import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FeishuBot } from '../lib/bot.js'
import {
  buildPairingOfferCard,
  buildPairingRejectedCard,
  buildPairingSuccessCard,
  decidePairing,
  PAIR_ACTION_VALUE,
  PAIR_BUTTON_NAME,
  PAIRING_PERSIST_NOTE,
  pairingActionContextOf,
  parsePairingAction,
} from '../lib/pairing.js'
import { StateStore } from '../lib/state-store.js'
import { apply } from '../lib/index.js'

// ---------------------------------------------------- decidePairing truth table --

test('a sender on the config list is allowed in p2p and group', () => {
  const input = { senderOpenId: 'ou_a', configOperators: ['ou_a'], pairedOperators: [] }
  assert.deepEqual(decidePairing({ ...input, chatType: 'p2p' }), { kind: 'allow' })
  assert.deepEqual(decidePairing({ ...input, chatType: 'group' }), { kind: 'allow' })
})

test('a sender on the persisted paired list is allowed too (union)', () => {
  const input = { senderOpenId: 'ou_b', configOperators: ['ou_a'], pairedOperators: ['ou_b'] }
  assert.deepEqual(decidePairing({ ...input, chatType: 'p2p' }), { kind: 'allow' })
  assert.deepEqual(decidePairing({ ...input, chatType: 'group' }), { kind: 'allow' })
})

test('a stranger is ignored when any admin exists (p2p or group)', () => {
  const input = { senderOpenId: 'ou_x', configOperators: ['ou_a'], pairedOperators: [] }
  assert.deepEqual(decidePairing({ ...input, chatType: 'p2p' }), { kind: 'ignore' })
  assert.deepEqual(decidePairing({ ...input, chatType: 'group' }), { kind: 'ignore' })
  const pairedOnly = { senderOpenId: 'ou_x', configOperators: [], pairedOperators: ['ou_b'] }
  assert.deepEqual(decidePairing({ ...pairedOnly, chatType: 'p2p' }), { kind: 'ignore' })
})

test('an empty list offers pairing in p2p and never in a group', () => {
  const empty = { senderOpenId: 'ou_new', configOperators: [], pairedOperators: [] }
  assert.deepEqual(decidePairing({ ...empty, chatType: 'p2p' }), { kind: 'offer-pairing' })
  assert.deepEqual(decidePairing({ ...empty, chatType: 'group' }), { kind: 'ignore' })
  // Any other chatType is not a DM — no pairing either.
  assert.deepEqual(decidePairing({ ...empty, chatType: '' }), { kind: 'ignore' })
})

test('ids are normalized: trim on both lists and the sender, empties dropped', () => {
  assert.deepEqual(
    decidePairing({ chatType: 'p2p', senderOpenId: ' ou_a ', configOperators: ['ou_a', ''], pairedOperators: ['  '] }),
    { kind: 'allow' },
  )
  // A list of only blank entries still counts as EMPTY (pairing offered).
  assert.deepEqual(
    decidePairing({ chatType: 'p2p', senderOpenId: 'ou_new', configOperators: [''], pairedOperators: ['   '] }),
    { kind: 'offer-pairing' },
  )
})

test('an unidentified sender (no open id) is never offered pairing', () => {
  assert.deepEqual(
    decidePairing({ chatType: 'p2p', senderOpenId: '', configOperators: [], pairedOperators: [] }),
    { kind: 'ignore' },
  )
})

// --------------------------------------------------------- pairing card shapes --

test('the offer card carries exactly one uniquely-named button with the pair value', () => {
  const card = buildPairingOfferCard()
  assert.equal(card.schema, '2.0')
  assert.equal(card.header.title.content, '🔗 dsh-feishu 管理员配对')
  const buttons = card.body.elements.filter(element => element.tag === 'button')
  assert.equal(buttons.length, 1) // card-wide button names must be unique (rule 230099)
  assert.equal(buttons[0].name, PAIR_BUTTON_NAME)
  assert.deepEqual(buttons[0].value, { dsh_feishu: PAIR_ACTION_VALUE })
  assert.match(card.body.elements[0].content, /管理员白名单/)
  assert.match(card.body.elements[0].content, /不是你的操作请忽略/)
})

test('terminal cards: success is green, rejected is grey with the refusal text', () => {
  const success = buildPairingSuccessCard()
  assert.equal(success.header.template, 'green')
  assert.match(success.body.elements[0].content, /配对完成：你已加入管理员名单/)
  const rejected = buildPairingRejectedCard()
  assert.equal(rejected.header.template, 'grey')
  assert.match(rejected.body.elements[0].content, /已有管理员，本次配对请求忽略/)
})

test('parsePairingAction recognizes value first, then the name fallback', () => {
  assert.equal(parsePairingAction({ action: { value: { dsh_feishu: 'pair' } } }), true)
  assert.equal(parsePairingAction({ action: { name: PAIR_BUTTON_NAME } }), true) // SDK stripped the value
  assert.equal(parsePairingAction({ action: { value: { dsh_feishu: 'other' }, name: PAIR_BUTTON_NAME } }), undefined)
  assert.equal(parsePairingAction({ action: { value: { action: 'dsh_feishu_round', op: 'stop' } } }), undefined)
  assert.equal(parsePairingAction({ action: {} }), undefined)
  assert.equal(parsePairingAction({}), undefined)
  assert.equal(parsePairingAction(null), undefined)
})

test('pairingActionContextOf reads nested context ids with root fallbacks', () => {
  assert.deepEqual(
    pairingActionContextOf({ context: { open_chat_id: 'oc_1', open_message_id: 'om_1' } }),
    { chatId: 'oc_1', messageId: 'om_1' },
  )
  assert.deepEqual(
    pairingActionContextOf({ open_chat_id: 'oc_2', open_message_id: 'om_2' }),
    { chatId: 'oc_2', messageId: 'om_2' },
  )
  assert.deepEqual(pairingActionContextOf({ context: {} }), { chatId: undefined, messageId: undefined })
  assert.deepEqual(pairingActionContextOf(null), { chatId: undefined, messageId: undefined })
})

// ------------------------------------------------- StateStore.pairedOperators --

test('pairedOperators roundtrip in memory mode with dedup-merge', async () => {
  const store = new StateStore({ inject() {} }) // no settings service → memory
  assert.deepEqual(store.getPairedOperators(), [])
  await store.update({ pairedOperators: ['ou_a'] })
  assert.deepEqual(store.getPairedOperators(), ['ou_a'])
  await store.addPairedOperator('ou_b')
  await store.addPairedOperator('ou_a') // dedupe
  await store.addPairedOperator('   ') // blank — dropped
  await store.addPairedOperator(' ou_c ') // trimmed
  assert.deepEqual(store.getPairedOperators(), ['ou_a', 'ou_b', 'ou_c'])
})

test('pairedOperators decode defensively: invalid JSON → [], junk entries filtered', async () => {
  for (const raw of ['{not json', JSON.stringify({ nope: 1 }), '5', 'null']) {
    const { store } = settingsBackedStore({ pairedOperators: raw })
    await store.ready()
    assert.deepEqual(store.getPairedOperators(), [], `raw ${JSON.stringify(raw)} must decode to []`)
  }
  const { store } = settingsBackedStore({ pairedOperators: JSON.stringify(['ou_a', '', 42, null, 'ou_b']) })
  await store.ready()
  assert.deepEqual(store.getPairedOperators(), ['ou_a', 'ou_b'])
})

test('pairedOperators persist as a JSON string (settings.yaml shape)', async () => {
  const { store, updates } = settingsBackedStore({})
  await store.ready()
  await store.addPairedOperator('ou_x')
  assert.equal(updates.length, 1)
  assert.equal(updates[0].pairedOperators, JSON.stringify(['ou_x']))
})

/** A StateStore over a fake settings service whose section starts at `section`. */
function settingsBackedStore(section) {
  const updates = []
  const scope = {
    get: () => section,
    update: async (patch) => {
      updates.push(patch)
      section = { ...section, ...patch }
    },
  }
  const ctx = {
    inject(_services, cb) {
      cb({ settings: { describe: () => [], register: () => scope } })
      return () => {}
    },
  }
  return { store: new StateStore(ctx), updates }
}

// ------------------------------------------------------ bot-level pairing flow --

function pairingMessage(openId, text, chatType = 'p2p', chatId = 'oc_test') {
  return { openId, chatId, chatType, messageId: 'om1', messageType: 'text', text, mentions: [], imageKey: undefined }
}

/** A FeishuBot with a faked lark/store, defaulting to a COMPLETELY empty admin list. */
function pairingBot({ paired = [], configured = [] } = {}) {
  const sends = []
  const patches = []
  const texts = []
  const addedOps = []
  const state = { lastChatId: undefined, displayThink: true, pairedOperators: [...paired] }
  const bot = new FeishuBot({
    ctx: { logger: { info() {}, warn() {}, error() {} }, get: () => undefined },
    config: { statusIntervalMs: 30000, bodySegmentChars: 3500 },
    lark: {
      async sendCard(_chatId, card) { sends.push(card); return `m${sends.length}` },
      async patchCard(id, card) { patches.push({ id, card }); return true },
      async sendText(_chatId, text) { texts.push(text); return `t${texts.length}` },
      async react() {},
    },
    binder: { getSessionId: () => undefined, getAgent: () => undefined, isReadOnlyView: () => false },
    store: {
      ready: async () => {},
      get: () => state,
      async update(patch) { Object.assign(state, patch) },
      async addPairedOperator(openId) {
        addedOps.push(openId)
        state.pairedOperators = [...state.pairedOperators, openId]
      },
      getPairedOperators: () => state.pairedOperators,
    },
    allowlist: new Set(configured),
    now: () => 1000,
  })
  return { bot, sends, patches, texts, addedOps, state }
}

function settle(ms = 10) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('zero operators + p2p DM sends the pairing offer card; groups stay silent', async () => {
  const { bot, sends } = pairingBot()
  await bot.process(pairingMessage('ou_new', '你好'))
  assert.equal(sends.length, 1)
  assert.equal(sends[0].header.title.content, '🔗 dsh-feishu 管理员配对')

  const { bot: groupBot, sends: groupSends } = pairingBot()
  await groupBot.process(pairingMessage('ou_new', '@bot 你好', 'group'))
  assert.equal(groupSends.length, 0)
})

test('a repeated DM in the same chat patches the existing card instead of stacking', async () => {
  const { bot, sends, patches } = pairingBot()
  await bot.process(pairingMessage('ou_new', '你好'))
  await bot.process(pairingMessage('ou_new', '在吗'))
  assert.equal(sends.length, 1) // no second card
  assert.equal(patches.length, 1)
  assert.equal(patches[0].id, 'm1') // the offer card was patched in place
})

test('tapping the card claims the TAPPER as admin and takes effect in-process', async () => {
  const { bot, sends, patches, texts, addedOps } = pairingBot()
  await bot.process(pairingMessage('ou_new', '你好'))

  bot.onCardAction({
    operator: { open_id: 'ou_new' },
    context: { open_chat_id: 'oc_test', open_message_id: 'm1' },
    action: { tag: 'button', value: { dsh_feishu: 'pair' } },
  })
  await settle()

  // The event's open_id was persisted (addPairedOperator), the original card
  // became the green success terminal, and the persistence note went out.
  assert.deepEqual(addedOps, ['ou_new'])
  assert.equal(patches.at(-1).id, 'm1')
  assert.equal(patches.at(-1).card.header.template, 'green')
  assert.match(patches.at(-1).card.body.elements[0].content, /配对完成：你已加入管理员名单/)
  assert.deepEqual(texts, [PAIRING_PERSIST_NOTE])

  // Same-process activation: the previously-stranger DM now rides the normal
  // message flow (a /help reply, NOT another pairing card).
  const before = sends.length
  await bot.process(pairingMessage('ou_new', '/help'))
  assert.equal(sends.length, before + 1)
  assert.match(JSON.stringify(sends.at(-1)), /手机驾驶舱/)
})

test('a pairing tap after an admin exists patches the refusal and claims nothing', async () => {
  const { bot, patches, addedOps, texts } = pairingBot({ paired: ['ou_admin'] })
  bot.onCardAction({
    operator: { open_id: 'ou_new' },
    context: { open_chat_id: 'oc_x', open_message_id: 'm9' },
    action: { tag: 'button', value: { dsh_feishu: 'pair' } },
  })
  await settle()
  assert.deepEqual(addedOps, [])
  assert.deepEqual(texts, [])
  assert.equal(patches.length, 1)
  assert.equal(patches[0].id, 'm9')
  assert.match(patches[0].card.body.elements[0].content, /已有管理员，本次配对请求忽略/)
})

test('pairing-card taps without an operator identity are silent no-ops', async () => {
  const { bot, patches, addedOps } = pairingBot()
  bot.onCardAction({ action: { value: { dsh_feishu: 'pair' } } })
  await settle()
  bot.onCardAction({ operator: { open_id: '' }, action: { value: { dsh_feishu: 'pair' } } })
  await settle()
  assert.deepEqual(addedOps, [])
  assert.equal(patches.length, 0)
})

test('the offer-card cache is capped at 32 chats (oldest evicted)', async () => {
  const { bot } = pairingBot()
  for (let i = 1; i <= 33; i++) {
    // Distinct chat per iteration so each offer is a fresh tracked card.
    await bot.process(pairingMessage(`ou_new_${i}`, '你好', 'p2p', `oc_chat_${i}`))
  }
  assert.equal(bot.pairingCards.size, 32)
  assert.equal(bot.pairingCards.has('oc_chat_1'), false) // oldest dropped
  assert.equal(bot.pairingCards.has('oc_chat_33'), true) // newest kept
})

test('a stranger is ignored once ANY admin exists (configured or paired)', async () => {
  const configured = pairingBot({ configured: ['ou_op'] })
  await configured.bot.process(pairingMessage('ou_new', '你好'))
  assert.equal(configured.sends.length, 0)

  const paired = pairingBot({ paired: ['ou_admin'] })
  await paired.bot.process(pairingMessage('ou_new', '你好'))
  assert.equal(paired.sends.length, 0)
})

test('phone-side /feishu-onboard gets the fixed desktop pointer, never the model', async () => {
  const { bot, sends } = pairingBot({ configured: ['ou_op'] })
  await bot.process(pairingMessage('ou_op', '/feishu-onboard'))
  assert.equal(sends.length, 1)
  assert.match(sends[0].body.elements[0].content, /「\/feishu-onboard」是桌面端首次配置命令/)
  assert.match(sends[0].body.elements[0].content, /电脑端 dsh 的 TUI/)
})

// ------------------------------------------------------- resolveConfig (env ops) --

// (resolveConfig DSH_FEISHU_OPERATORS cases live in test/config.test.mjs)

// ------------------------------------------------------------- apply() wiring --

test('apply registers /feishu-onboard on the host commands service (before dormant returns)', () => {
  const registered = []
  const { ctx } = applyMockCtx({
    commands: { register: definition => { registered.push(definition); return () => {} } },
  })
  // mode 'off' normally stops right after registration — the command must
  // already be in place (first-config works from a fully dormant plugin).
  apply(ctx, { mode: 'off' })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'feishu-onboard')
  assert.match(registered[0].description, /配置飞书机器人/)
  assert.equal(typeof registered[0].handler, 'function')
})

test('apply tolerates a missing commands service (warns, never throws)', () => {
  const { ctx, warnings } = applyMockCtx()
  assert.doesNotThrow(() => apply(ctx, { mode: 'off' }))
  assert.equal(ctx.registered.length, 1) // bundled skill still registered
})

/** Minimal cordis-like ctx (skills + effect slots, optional services). */
function applyMockCtx({ commands } = {}) {
  const registered = []
  const warnings = []
  const ctx = {
    registered,
    logger: {
      error() {},
      warn(msg, ...args) { warnings.push(msg) },
      info() {},
      debug() {},
    },
    effect(setup) { setup() }, // cordis runs the effect body immediately
    inject() {},
    get(key) {
      if (key === 'commands' && commands !== undefined) return commands
      return undefined
    },
    skills: {
      registerProvider(create) {
        const provider = create({ signal: new AbortController().signal, invalidate() {} })
        registered.push(provider)
        return () => {}
      },
    },
  }
  return { ctx, warnings }
}
