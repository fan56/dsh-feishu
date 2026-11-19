import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { FeishuBot } from '../lib/bot.js'
import { raceSurfaces } from '../lib/race.js'

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
const DOWN = { answers: [{ id: 'q1', selected: ['gui'] }] }

function uqError(message, code) {
  return new UserQuestionError(message, code)
}

// ------------------------------------------------------------------ arbiter --

test('R-D: a synchronous NO_CHAT card rejection is swallowed while downstream is pending', async () => {
  let resolveDownstream
  const downstream = new Promise(resolve => { resolveDownstream = resolve })
  const observed = []
  const arb = raceSurfaces(Promise.reject(uqError('no chat', 'NO_CHAT')), downstream, {
    onDownstreamWin: () => observed.push('downstream-win'),
    cardDeathCodes: ['NO_CHAT', 'CARD_SEND_FAILED'],
  })
  await tick()
  resolveDownstream(DOWN)
  assert.deepEqual(await arb, DOWN)
  assert.deepEqual(observed, ['downstream-win'])
})

test('R-D/R-F: an async CARD_SEND_FAILED rejection before downstream settle still returns downstream', async () => {
  let rejectCard
  let resolveDownstream
  const card = new Promise((_, reject) => { rejectCard = reject })
  const downstream = new Promise(resolve => { resolveDownstream = resolve })
  const arb = raceSurfaces(card, downstream, {
    onDownstreamWin() {},
    cardDeathCodes: ['NO_CHAT', 'CARD_SEND_FAILED'],
  })
  rejectCard(uqError('delivery failed', 'CARD_SEND_FAILED'))
  await tick()
  resolveDownstream(DOWN)
  assert.deepEqual(await arb, DOWN)
})

test('R-C: signal abort with downstream rejecting first passes the card ASK_ABORTED through', async () => {
  const controller = new AbortController()
  let rejectCard
  let rejectDownstream
  const card = new Promise((_, reject) => { rejectCard = reject })
  const downstream = new Promise((_, reject) => { rejectDownstream = reject })
  const arb = raceSurfaces(card, downstream, {
    signal: controller.signal,
    onDownstreamWin() {},
    cardDeathCodes: ['NO_CHAT', 'CARD_SEND_FAILED'],
  })
  controller.abort()
  rejectDownstream(uqError('gui aborted', 'NO_PROVIDER'))
  await tick()
  rejectCard(uqError('aborted', 'ASK_ABORTED'))
  await assert.rejects(arb, error => error.code === 'ASK_ABORTED')
})

test('double reject: NO_CHAT / CARD_SEND_FAILED fall back to the downstream error, other card codes win', async () => {
  const cardDeath = raceSurfaces(
    Promise.reject(uqError('no chat', 'NO_CHAT')),
    Promise.reject(uqError('gui failed', 'NO_PROVIDER')),
    { onDownstreamWin() {}, cardDeathCodes: ['NO_CHAT', 'CARD_SEND_FAILED'] },
  )
  await assert.rejects(cardDeath, error => error.code === 'NO_PROVIDER')

  const diagnostic = raceSurfaces(
    Promise.reject(uqError('answered elsewhere', 'ANSWERED_ELSEWHERE')),
    Promise.reject(uqError('gui failed', 'NO_PROVIDER')),
    { onDownstreamWin() {}, cardDeathCodes: ['NO_CHAT', 'CARD_SEND_FAILED'] },
  )
  await assert.rejects(diagnostic, error => error.code === 'ANSWERED_ELSEWHERE')
})

test('the settle gate is one-way: a late downstream rejection after a card win is swallowed', async () => {
  let rejectDownstream
  const card = Promise.resolve(DOWN)
  const downstream = new Promise((_, reject) => { rejectDownstream = reject })
  const observed = []
  const arb = raceSurfaces(card, downstream, {
    onDownstreamWin: () => observed.push('downstream-win'),
    cardDeathCodes: ['NO_CHAT', 'CARD_SEND_FAILED'],
  })
  assert.deepEqual(await arb, DOWN)
  rejectDownstream(new Error('late failure'))
  await tick()
  assert.deepEqual(observed, [], 'onDownstreamWin must not fire after the card won')
})

// --------------------------------------------------------------- bot harness --

function fakeEvents() {
  const hooks = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: () => undefined,
    on(event, fn, options) {
      if (!hooks.has(event)) hooks.set(event, [])
      hooks.get(event).push({ fn, options })
      return () => true
    },
  }
  return {
    ctx,
    hooks,
    listeners: event => (hooks.get(event) ?? []).map(h => h.fn),
    options: event => (hooks.get(event) ?? []).map(h => h.options),
  }
}

function makeBot({ lark, ctx, config = {}, binder, onUnhandled } = {}) {
  const events = ctx === undefined ? fakeEvents() : { ctx, hooks: new Map() }
  const state = { lastChatId: 'oc_test', displayThink: false, boundSessionId: 's1', picker: undefined }
  const bot = new FeishuBot({
    ctx: events.ctx,
    config: { statusIntervalMs: 60000, bodySegmentChars: 3500, askRace: true, ...config },
    lark: lark ?? {
      async sendCard() { return 'm1' },
      async patchCard() { return true },
      async start() {},
      close() {},
    },
    binder: binder ?? { getSessionId: () => 's1', isReadOnlyView: () => false, dispose: async () => {} },
    store: { ready: async () => {}, get: () => state, async update(p) { Object.assign(state, p) } },
    allowlist: new Set(['ou_op']),
    now: () => 1000,
  })
  return { bot, events, unhandled: onUnhandled }
}

const askRequest = () => ({
  questions: [{ id: 'q1', question: 'Proceed?', header: 'Go', options: [{ label: 'phone' }, { label: 'gui' }] }],
  agent: { session: { id: 's1' } },
})

// -------------------------------------------------------- ask registration --

test('ask: race on registers with { prepend:true }; race off registers with no options (byte-equivalent legacy)', () => {
  const on = makeBot({ config: { askRace: true } })
  on.bot.registerAskSurface()
  assert.deepEqual(on.events.options('user-questions/request'), [{ prepend: true }])

  const off = makeBot({ config: { askRace: false } })
  off.bot.registerAskSurface()
  assert.deepEqual(off.events.options('user-questions/request'), [undefined])
})

test('real cordis EventsService: a later prepend listener runs before an earlier tail listener', async () => {
  const ctx = new Context()
  const order = []
  ctx.on('user-questions/request', async (_req, next) => {
    order.push('tail')
    return next()
  })
  const tail = ctx.events._hooks['user-questions/request'][0].callback
  ctx.on('user-questions/request', async (_req, next) => {
    order.push('prepended')
    return next()
  }, { prepend: true })

  const hooks = ctx.events._hooks['user-questions/request']
  assert.equal(hooks.length, 2)
  assert.notEqual(hooks[0].callback, tail, 'the prepended hook is at the head')
  assert.equal(hooks[1].callback, tail, 'the earlier tail hook was pushed back')

  await ctx.waterfall('user-questions/request', {}, async () => {
    order.push('inner')
    return 'inner-answer'
  })
  assert.deepEqual(order, ['prepended', 'tail', 'inner'])
})

test('askRouterTakeover: with a router present, takeover=true skips router.register and prepends; false keeps router', () => {
  let registered = 0
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: key => key === 'askSurfaces' ? { register() { registered += 1; return () => {} } } : undefined,
    on(event, _fn, options) {
      ctx.seen = { event, options }
      return () => true
    },
  }
  const takeover = makeBot({ ctx, config: { askRouterTakeover: true } })
  takeover.bot.registerAskSurface()
  assert.equal(registered, 0, 'takeover never double-registers with the router')
  assert.deepEqual(ctx.seen, { event: 'user-questions/request', options: { prepend: true } })

  const legacy = makeBot({ ctx, config: { askRouterTakeover: false } })
  legacy.bot.registerAskSurface()
  assert.equal(registered, 1, 'router path unchanged when takeover is off')
})

// --------------------------------------------------------- ask race outcomes --

test('ask: downstream wins while the card send is in flight → grey card, next() once, zombie submit ignored', async () => {
  const patches = []
  const sends = []
  let resolveSend
  const lark = {
    sendCard(_chat, card) {
      sends.push(card)
      return new Promise(resolve => { resolveSend = resolve })
    },
    async patchCard(id, card) { patches.push({ id, card }); return true },
    async start() {},
    close() {},
  }
  const { bot, events } = makeBot({ lark })
  bot.registerAskSurface()
  let nextCalls = 0
  const pending = events.listeners('user-questions/request')[0](askRequest(), async () => {
    nextCalls += 1
    return DOWN
  })
  await tick()
  assert.equal(nextCalls, 1, 'next() called exactly once')
  assert.equal(sends.length, 1, 'the card was still being sent when downstream won')

  resolveSend('m1')
  await tick()
  assert.deepEqual(await pending, DOWN)
  assert.ok(patches.some(p => p.id === 'm1' && JSON.stringify(p.card).includes('取消')),
    'the in-flight card is patched grey once its messageId lands')

  const questionId = sends[0].body.elements[0].elements.at(-1).value.question_id
  bot.onCardAction({
    operator: { open_id: 'ou_op' },
    action: { tag: 'button', value: { action: 'dsh_feishu_ask_submit', question_id: questionId }, form_value: { q_0: 'phone' } },
  })
  await tick()
  const answer = await pending
  assert.deepEqual(answer, DOWN, 'a late card submit is ignored after downstream won')
})

test('ask: card wins and downstream result is discarded (still exactly one next())', async () => {
  const lark = {
    async sendCard(_chat, card) { this.card = card; return 'm1' },
    async patchCard() { return true },
    async start() {},
    close() {},
  }
  const { bot, events } = makeBot({ lark })
  bot.registerAskSurface()
  let nextCalls = 0
  let lateDownstream
  const pending = events.listeners('user-questions/request')[0](askRequest(), () => {
    nextCalls += 1
    return new Promise(resolve => { lateDownstream = resolve })
  })
  await tick()
  const questionId = lark.card.body.elements[0].elements.at(-1).value.question_id
  bot.onCardAction({
    operator: { open_id: 'ou_op' },
    action: { tag: 'button', value: { action: 'dsh_feishu_ask_submit', question_id: questionId }, form_value: { q_0: 'phone' } },
  })
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['phone'] }] })
  lateDownstream(DOWN) // a late GUI answer must be discarded, not fail the arbiter
  await tick()
  assert.equal(nextCalls, 1)
})

test('R-E: dispose during a race kills only the card path; downstream still answers', async () => {
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  let resolveDownstream
  const lark = {
    async sendCard() { return 'm1' },
    async patchCard() { return true },
    async start() {},
    close() {},
  }
  const { bot, events } = makeBot({ lark })
  bot.registerAskSurface()
  const pending = events.listeners('user-questions/request')[0](askRequest(), () => new Promise(resolve => {
    resolveDownstream = resolve
  }))
  await tick()
  await bot.dispose()
  resolveDownstream(DOWN)
  assert.deepEqual(await pending, DOWN, 'unload must not fail the whole ask with ASK_ABORTED')
  await tick()
  assert.deepEqual(unhandled, [], 'the disposed card rejection is swallowed by the arbiter')
  process.off('unhandledRejection', onUnhandled)
})

test('R-C bot: signal abort passthrough with downstream rejecting first', async () => {
  const controller = new AbortController()
  const lark = {
    async sendCard() { return 'm1' },
    async patchCard() { return true },
    async start() {},
    close() {},
  }
  const { bot, events } = makeBot({ lark })
  bot.registerAskSurface()
  let nextReject
  const pending = events.listeners('user-questions/request')[0](
    { ...askRequest(), signal: controller.signal },
    () => new Promise((_, reject) => { nextReject = reject }),
  )
  await tick()
  nextReject(uqError('gui aborted', 'NO_PROVIDER'))
  await tick()
  controller.abort()
  await assert.rejects(pending, error => error.code === 'ASK_ABORTED')
})

// ------------------------------------------------------- approval race tests --

const approvalRequest = () => ({
  toolName: 'Bash',
  callId: 'c1',
  agent: { session: { id: 's1' } },
})

function flowIdOf(card) {
  const buttons = card.body.elements.filter(e => e.tag === 'button')
  return buttons[0].value.flow_id
}

test('approval: race on prepends; downstream wins dismisses the card and next() is called once', async () => {
  const patches = []
  const sends = []
  const { bot, events } = makeBot({
    lark: {
      async sendCard(_chat, card) { sends.push(card); return 'm1' },
      async patchCard(id, card) { patches.push({ id, card }); return true },
      async start() {},
      close() {},
    },
  })
  bot.registerApprovalSurface()
  assert.deepEqual(events.options('approval/request'), [{ prepend: true }])
  let nextCalls = 0
  const pending = events.listeners('approval/request')[0](approvalRequest(), async () => {
    nextCalls += 1
    return 'allowed-once'
  })
  assert.equal(await pending, 'allowed-once')
  await tick()
  assert.equal(nextCalls, 1)
  assert.equal(sends.length, 1)
  assert.equal(bot.selectors.pendingCount, 0)
  assert.ok(patches.some(p => p.id === 'm1' && p.card.header.template === 'grey'),
    'the approval card is patched grey on downstream win')

  // Zombie submit on the dismissed card is a no-op.
  const flowId = flowIdOf(sends[0])
  bot.onCardAction({
    operator: { open_id: 'ou_op' },
    action: { tag: 'button', value: { action: 'dsh_feishu_sel', flow_id: flowId, pick: 'deny' } },
  })
  await tick()
  assert.equal(await pending, 'allowed-once')
})

test('approval: card win returns the operator decision (allowed-once) and discards downstream', async () => {
  const sends = []
  const { bot, events } = makeBot({
    lark: {
      async sendCard(_chat, card) { sends.push(card); return 'm1' },
      async patchCard() { return true },
      async start() {},
      close() {},
    },
  })
  bot.registerApprovalSurface()
  let nextCalls = 0
  let lateDownstream
  const pending = events.listeners('approval/request')[0](approvalRequest(), () => {
    nextCalls += 1
    return new Promise(resolve => { lateDownstream = resolve })
  })
  await tick()
  const flowId = flowIdOf(sends[0])
  bot.onCardAction({
    operator: { open_id: 'ou_op' },
    action: { tag: 'button', value: { action: 'dsh_feishu_sel', flow_id: flowId, pick: 'allow' } },
  })
  assert.equal(await pending, 'allowed-once')
  lateDownstream('rejected')
  await tick()
  assert.equal(nextCalls, 1)
})

test('approval: R-D card send failure falls back to the downstream outcome', async () => {
  const { bot, events } = makeBot({
    lark: {
      async sendCard() { return undefined }, // delivery failed
      async patchCard() { return true },
      async start() {},
      close() {},
    },
  })
  bot.registerApprovalSurface()
  const pending = events.listeners('approval/request')[0](approvalRequest(), async () => 'rejected')
  assert.equal(await pending, 'rejected')
})

test('approval: R-E dispose during a race kills only the card path; downstream still decides', async () => {
  let resolveDownstream
  const { bot, events } = makeBot({
    lark: {
      async sendCard() { return 'm1' },
      async patchCard() { return true },
      async start() {},
      close() {},
    },
  })
  bot.registerApprovalSurface()
  const pending = events.listeners('approval/request')[0](approvalRequest(), () => new Promise(resolve => {
    resolveDownstream = resolve
  }))
  await tick()
  await bot.dispose()
  resolveDownstream('allowed-once')
  assert.equal(await pending, 'allowed-once')
})
