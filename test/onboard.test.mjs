/**
 * Offline tests for the /feishu-onboard core (src/onboard.ts): verification
 * outcome mapping, deep links, presets, registration outcomes, and the
 * runOnboard orchestration. fetch / ask / register are all injected fakes —
 * no network, no console output.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ONBOARD_CALLBACK_PRESET,
  ONBOARD_EVENT_PRESET,
  ONBOARD_SCOPE_PRESET,
  registerBotApp,
  runOnboard,
  scopeGrantDeepLink,
  verifyCredentials,
} from '../lib/onboard.js'

// ------------------------------------------------------------------- fakes --

/** Minimal Response stand-in. */
const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

/** Recording fetch fake: routes(url, init) decides each response. */
function fakeFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return routes(url, init)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

/** Scripted ask seam: one entry per ask call; `selected` for options, `custom` for free text. */
function fakeAsk(script) {
  const calls = []
  const ask = async request => {
    calls.push(request)
    const next = script.shift()
    if (next === undefined) throw new Error('ask script exhausted')
    return {
      answers: request.questions.map(q => ({ id: q.id, selected: next.selected ?? [], custom: next.custom })),
    }
  }
  return { ask, calls }
}

function fakeStore() {
  const ops = []
  return {
    ops,
    getPairedOperators: () => [...ops],
    addPairedOperator: async openId => { ops.push(openId) },
  }
}

function fakeCredentials() {
  const values = new Map()
  return {
    values,
    resolve: async ref => (values.has(ref) ? { value: values.get(ref) } : undefined),
    set: async (ref, value) => { values.set(ref, value) },
  }
}

/**
 * runScanBranch hard-wires printQrToTerminal into its showQr wrapper
 * (lib/onboard.js has no injection point), so the scan-branch fakes cannot stub
 * the QR render. Its bulk console output shares the child stdout stream the
 * node:test runner frames its IPC events on; under CI pipe backpressure the
 * writes interleave and the parent's readHeader() throws "Unable to deserialize
 * cloned data". The QR render is synchronous, so muting console for the call
 * keeps it off the runner stream without touching production behavior.
 */
function withQuietConsole(fn) {
  const log = console.log
  console.log = () => {}
  try {
    return fn()
  } finally {
    console.log = log
  }
}

function baseDeps(overrides = {}) {
  return {
    domain: 'feishu',
    existingCredentials: undefined,
    credentialsSource: 'refs',
    ask: undefined,
    credentials: undefined,
    store: undefined,
    log: () => {},
    ...overrides,
  }
}

// ------------------------------------------------------ verifyCredentials --

test('verifyCredentials maps a healthy pair to ok with bot name and open id', async () => {
  const fetchImpl = fakeFetch(url => {
    if (url === 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal') {
      return json({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7000 })
    }
    return json({ code: 0, msg: 'ok', bot: { app_name: 'dsh 机器人', open_id: 'ou_bot', activate_status: 1 } })
  })
  const outcome = await verifyCredentials({ appId: 'cli_a', appSecret: 'sec_a' }, 'feishu', { fetchImpl })
  assert.deepEqual(outcome, { status: 'ok', botName: 'dsh 机器人', botOpenId: 'ou_bot' })
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(fetchImpl.calls[0].url, 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal')
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { app_id: 'cli_a', app_secret: 'sec_a' })
  assert.equal(fetchImpl.calls[1].url, 'https://open.feishu.cn/open-apis/bot/v3/info')
  assert.equal(fetchImpl.calls[1].init.headers.Authorization, 'Bearer t-1')
})

test('verifyCredentials maps a non-zero token code to bad-credentials and skips bot info', async () => {
  const fetchImpl = fakeFetch(() => json({ code: 10003, msg: 'app id not exist' }))
  const outcome = await verifyCredentials({ appId: 'cli_a', appSecret: 'wrong' }, 'feishu', { fetchImpl })
  assert.deepEqual(outcome, { status: 'bad-credentials' })
  assert.equal(fetchImpl.calls.length, 1, 'bot/v3/info must not be called on token failure')
})

test('verifyCredentials maps bot-info code 11205 to no-bot', async () => {
  const fetchImpl = fakeFetch(url => (
    url.includes('tenant_access_token')
      ? json({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7000 })
      : json({ code: 11205, msg: 'bot capability not enabled' })
  ))
  const outcome = await verifyCredentials({ appId: 'cli_a', appSecret: 'sec_a' }, 'feishu', { fetchImpl })
  assert.deepEqual(outcome, { status: 'no-bot' })
})

test('verifyCredentials maps a fetch rejection to network', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
  const outcome = await verifyCredentials({ appId: 'cli_a', appSecret: 'sec_a' }, 'feishu', { fetchImpl })
  assert.deepEqual(outcome, { status: 'network', detail: 'tenant_access_token: ECONNREFUSED' })
})

test('verifyCredentials maps HTTP 500 to network (transport-level, not a business code)', async () => {
  const fetchImpl = fakeFetch(() => json({ nothing: true }, 500))
  const outcome = await verifyCredentials({ appId: 'cli_a', appSecret: 'sec_a' }, 'feishu', { fetchImpl })
  assert.deepEqual(outcome, { status: 'network', detail: 'tenant_access_token: HTTP 500' })
})

test('verifyCredentials maps an unknown bot-info code to other', async () => {
  const fetchImpl = fakeFetch(url => (
    url.includes('tenant_access_token')
      ? json({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7000 })
      : json({ code: 99991663, msg: 'token invalid' })
  ))
  const outcome = await verifyCredentials({ appId: 'cli_a', appSecret: 'sec_a' }, 'feishu', { fetchImpl })
  assert.deepEqual(outcome, { status: 'other', code: 99991663, msg: 'token invalid' })
})

test('verifyCredentials targets open.larksuite.com for the lark domain', async () => {
  const fetchImpl = fakeFetch(url => (
    url.includes('tenant_access_token')
      ? json({ code: 0, msg: 'ok', tenant_access_token: 't-2', expire: 7000 })
      : json({ code: 0, msg: 'ok', bot: { app_name: 'Lark bot', open_id: 'ou_lark' } })
  ))
  const outcome = await verifyCredentials({ appId: 'cli_l', appSecret: 'sec_l' }, 'lark', { fetchImpl })
  assert.deepEqual(outcome, { status: 'ok', botName: 'Lark bot', botOpenId: 'ou_lark' })
  assert.ok(fetchImpl.calls.every(call => call.url.startsWith('https://open.larksuite.com/')))
})

// ------------------------------------------------- presets and deep links --

test('preset constants carry the onboard scope/event/callback set', () => {
  assert.deepEqual([...ONBOARD_SCOPE_PRESET], [
    'im:message:send_as_bot',
    'im:message.p2p_msg:readonly',
    'im:message.group_at_msg:readonly',
    'im:message.resources:readonly',
    'im:message.reactions:write',
    'im:chat:readonly',
  ])
  assert.deepEqual([...ONBOARD_EVENT_PRESET], ['im.message.receive_v1'])
  assert.deepEqual([...ONBOARD_CALLBACK_PRESET], ['card.action.trigger'])
})

test('scopeGrantDeepLink builds the permission pre-select link for both domains', () => {
  const csv = ONBOARD_SCOPE_PRESET.join(',')
  assert.equal(
    scopeGrantDeepLink('cli_a', 'feishu'),
    `https://open.feishu.cn/app/cli_a/auth?q=${csv}&op_from=openapi`,
  )
  assert.equal(
    scopeGrantDeepLink('cli_b', 'lark'),
    `https://open.larksuite.com/app/cli_b/auth?q=${csv}&op_from=openapi`,
  )
})

// ------------------------------------------------------------ registerBotApp --

test('registerBotApp resolves ok and forwards the QR url to showQr', async () => {
  const shown = []
  const outcome = await registerBotApp({
    domain: 'feishu',
    showQr: (url, expireIn) => shown.push([url, expireIn]),
    registerAppImpl: async options => {
      options.onQRCodeReady({ url: 'https://qr.example/abc', expireIn: 600 })
      return { client_id: 'cli_qr', client_secret: 'sec_qr', user_info: { open_id: 'ou_scan' } }
    },
  })
  assert.deepEqual(outcome, { status: 'ok', appId: 'cli_qr', appSecret: 'sec_qr', operatorOpenId: 'ou_scan' })
  assert.deepEqual(shown, [['https://qr.example/abc', 600]])
})

test('registerBotApp passes presets, createOnly, hostname domain and the signal through', async () => {
  const controller = new AbortController()
  let seen
  const outcome = await registerBotApp({
    domain: 'lark',
    signal: controller.signal,
    registerAppImpl: async options => {
      seen = options
      return { client_id: 'cli_x', client_secret: 'sec_x' }
    },
  })
  assert.deepEqual(outcome, { status: 'ok', appId: 'cli_x', appSecret: 'sec_x', operatorOpenId: undefined })
  assert.equal(seen.domain, 'accounts.larksuite.com')
  assert.equal(seen.larkDomain, 'accounts.larksuite.com')
  assert.equal(seen.signal, controller.signal)
  assert.equal(seen.createOnly, true)
  assert.deepEqual(seen.appPreset, { name: 'dsh-feishu', desc: 'Drive dsh sessions from Feishu — dsh-feishu bot' })
  assert.deepEqual(seen.addons.scopes.tenant, [...ONBOARD_SCOPE_PRESET])
  assert.deepEqual(seen.addons.events.items.tenant, [...ONBOARD_EVENT_PRESET])
  assert.deepEqual(seen.addons.callbacks.items, [...ONBOARD_CALLBACK_PRESET])
})

test('registerBotApp maps an AbortError rejection to aborted', async () => {
  const outcome = await registerBotApp({
    domain: 'feishu',
    registerAppImpl: async () => { throw Object.assign(new Error('Registration was aborted'), { name: 'AbortError' }) },
  })
  assert.deepEqual(outcome, { status: 'aborted' })
})

test('registerBotApp maps the SDK plain {code:"abort"} rejection to aborted', async () => {
  // SDK 1.73.x rejects signal aborts with a plain object, not an Error.
  const outcome = await registerBotApp({
    domain: 'feishu',
    registerAppImpl: async () => { throw { code: 'abort', description: 'Registration was aborted' } },
  })
  assert.deepEqual(outcome, { status: 'aborted' })
})

test('registerBotApp maps other rejections to failed with the error message', async () => {
  const outcome = await registerBotApp({
    domain: 'feishu',
    registerAppImpl: async () => { throw new Error('boom') },
  })
  assert.deepEqual(outcome, { status: 'failed', detail: 'boom' })
})

test('registerBotApp returns aborted without calling registerApp when already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  let called = 0
  const outcome = await registerBotApp({
    domain: 'feishu',
    signal: controller.signal,
    registerAppImpl: async () => { called++ ; return { client_id: 'cli_x', client_secret: 'sec_x' } },
  })
  assert.deepEqual(outcome, { status: 'aborted' })
  assert.equal(called, 0)
})

// ---------------------------------------------------------------- runOnboard --

test('runOnboard degrades to the manual guide when ask is unavailable', async () => {
  const report = await runOnboard(baseDeps({ ask: undefined }))
  assert.equal(report.ok, true)
  assert.match(report.text, /手动/)
  assert.equal(report.credentialsWritten, false)
  assert.deepEqual(report.operatorsPaired, [])
  assert.equal(report.appId, undefined)
})

test('runOnboard keeps existing credentials when the user opts out of reconfiguration', async () => {
  let verifyCalls = 0
  const credentials = fakeCredentials()
  const report = await runOnboard(baseDeps({
    existingCredentials: { appId: 'cli_old', appSecret: 'sec_old' },
    credentialsSource: 'config',
    ask: fakeAsk([{ selected: ['保持现状（退出）'] }]),
    credentials,
    verifyImpl: async () => {
      verifyCalls++
      return { status: 'ok', botName: '旧机器人', botOpenId: 'ou_old' }
    },
  }))
  assert.equal(report.ok, true)
  assert.equal(verifyCalls, 1)
  assert.equal(report.credentialsWritten, false)
  assert.equal(report.appId, 'cli_old')
  assert.match(report.text, /旧机器人/)
  assert.match(report.text, /未做任何更改/)
  assert.equal(credentials.values.size, 0, 'nothing written')
})

test('runOnboard existing-app happy path writes both refs, pairs the open_id, leaks no secret', async () => {
  const credentials = fakeCredentials()
  const store = fakeStore()
  const logs = []
  const seenCreds = []
  const ask = fakeAsk([
    { selected: ['已有应用 — 我提供 App ID 和 Secret'] },
    { custom: 'cli_myapp' },
    { custom: 'sec_myapp' },
    { selected: ['我知道我的 open_id（输入）'] },
    { custom: 'ou_me1' },
  ])
  const report = await runOnboard(baseDeps({
    ask,
    credentials,
    store,
    credentialsSource: 'env',
    log: (level, message) => logs.push([level, message]),
    verifyImpl: async creds => {
      seenCreds.push(creds)
      return { status: 'ok', botName: 'b', botOpenId: 'ou_b' }
    },
  }))
  assert.equal(report.ok, true)
  assert.equal(report.credentialsWritten, true)
  assert.equal(report.appId, 'cli_myapp')
  assert.deepEqual([...credentials.values.entries()], [
    ['DSH_FEISHU_APP_ID', 'cli_myapp'],
    ['DSH_FEISHU_APP_SECRET', 'sec_myapp'],
  ])
  assert.deepEqual(store.ops, ['ou_me1'])
  assert.deepEqual(report.operatorsPaired, ['ou_me1'])
  assert.deepEqual(seenCreds, [{ appId: 'cli_myapp', appSecret: 'sec_myapp' }])
  assert.match(report.text, /激活/)
  assert.match(report.text, /DSH_FEISHU_APP_ID/, 'credentialsSource=env must add the env warning')
  assert.ok(!report.text.includes('sec_myapp'), 'secret must not appear in the report text')
  assert.ok(!logs.some(([, message]) => message.includes('sec_myapp')), 'secret must not appear in logs')
})

test('runOnboard manual-guide option returns the guide without writing anything', async () => {
  const credentials = fakeCredentials()
  const report = await runOnboard(baseDeps({
    ask: fakeAsk([{ selected: ['只要手动申请指南'] }]),
    credentials,
  }))
  assert.equal(report.ok, true)
  assert.match(report.text, /手动申请指南/)
  assert.match(report.text, /im\.message\.receive_v1/)
  assert.equal(report.credentialsWritten, false)
  assert.equal(report.appId, undefined)
  assert.equal(credentials.values.size, 0)
})

test('runOnboard scan happy path writes credentials, pairs the scan user, reports the bot name', async () => {
  const credentials = fakeCredentials()
  const store = fakeStore()
  let registerDeps
  const report = await runOnboard(baseDeps({
    ask: fakeAsk([
      { selected: ['没有 — 扫码一键创建（推荐）'] },
      { selected: ['我已完成确认'] },
    ]),
    credentials,
    store,
    verifyImpl: async () => ({ status: 'ok', botName: '新机器人', botOpenId: 'ou_newbot' }),
    registerImpl: async deps => {
      registerDeps = deps
      withQuietConsole(() => deps.showQr('https://launcher.example/scan-1', 600))
      return { status: 'ok', appId: 'cli_new', appSecret: 'sec_new', operatorOpenId: 'ou_scan' }
    },
  }))
  assert.equal(report.ok, true)
  assert.equal(registerDeps.domain, 'feishu')
  assert.deepEqual([...credentials.values.entries()], [
    ['DSH_FEISHU_APP_ID', 'cli_new'],
    ['DSH_FEISHU_APP_SECRET', 'sec_new'],
  ])
  assert.deepEqual(store.ops, ['ou_scan'])
  assert.deepEqual(report.operatorsPaired, ['ou_scan'])
  assert.equal(report.appId, 'cli_new')
  assert.match(report.text, /新机器人/)
  assert.match(report.text, /管理员/)
  assert.match(report.text, /激活/)
  assert.ok(!report.text.includes('sec_new'), 'secret must not appear in the report text')
})

test('runOnboard scan branch presents the launcher link through the ask card', async () => {
  const asks = []
  const ask = {
    ask: async request => {
      asks.push(request)
      const next = asks.length === 1
        ? { selected: ['没有 — 扫码一键创建（推荐）'] }
        : { selected: ['我已完成确认'] }
      return { answers: request.questions.map(q => ({ id: q.id, selected: next.selected, custom: undefined })) }
    },
  }
  const report = await runOnboard(baseDeps({
    ask,
    credentials: fakeCredentials(),
    store: fakeStore(),
    verifyImpl: async () => ({ status: 'ok', botName: 'b', botOpenId: undefined }),
    registerImpl: async deps => {
      withQuietConsole(() => deps.showQr('https://launcher.example/web-card', 600))
      return { status: 'ok', appId: 'cli_link', appSecret: 'sec_link', operatorOpenId: undefined }
    },
  }))
  assert.equal(report.ok, true)
  assert.equal(asks.length, 2, 'path question + launcher-link confirmation')
  assert.match(asks[1].questions[0].detail, /launcher\.example\/web-card/, 'the ask card detail must carry the launcher link')
  assert.match(asks[1].questions[0].question, /确认/)
})

test('runOnboard scan branch reports failure when no launcher link arrives in time', async () => {
  let report
  const started = Date.now()
  report = await runOnboard(baseDeps({
    ask: fakeAsk([{ selected: ['没有 — 扫码一键创建（推荐）'] }]),
    scanUrlWaitMs: 20,
    registerImpl: async () => new Promise(() => {}), // never shows a URL, never settles
  }))
  assert.equal(report.ok, false)
  assert.match(report.text, /等待创建链接超时/)
  assert.ok(Date.now() - started < 5_000, 'the wait must be bounded by scanUrlWaitMs')
})

test('runOnboard scan branch gives up when confirmation is clicked but registration never settles', async () => {
  const report = await runOnboard(baseDeps({
    ask: fakeAsk([
      { selected: ['没有 — 扫码一键创建（推荐）'] },
      { selected: ['我已完成确认'] },
    ]),
    scanConfirmGraceMs: 20,
    registerImpl: async deps => {
      withQuietConsole(() => deps.showQr('https://launcher.example/stuck', 600))
      return new Promise(() => {}) // user "confirmed" but the SDK never observes it
    },
  }))
  assert.equal(report.ok, false)
  assert.match(report.text, /未检测到创建完成/)
})

test('runOnboard scan branch stops cleanly when the confirm card cannot be delivered', async () => {
  const calls = []
  const report = await runOnboard(baseDeps({
    ask: {
      ask: async request => {
        calls.push(request)
        if (calls.length === 1) {
          return { answers: [{ id: request.questions[0].id, selected: ['没有 — 扫码一键创建（推荐）'], custom: undefined }] }
        }
        throw new Error('NO_PROVIDER')
      },
    },
    registerImpl: async deps => {
      withQuietConsole(() => deps.showQr('https://launcher.example/orphan', 600))
      return { status: 'ok', appId: 'cli_x', appSecret: 'sec_x', operatorOpenId: undefined }
    },
  }))
  assert.equal(report.ok, false, 'an undeliverable confirm card must not proceed to an orphan app')
  assert.match(report.text, /未能送达/)
  assert.equal(report.credentialsWritten, false)
})

test('runOnboard no-bot branch still saves credentials and shows the fix list', async () => {
  const credentials = fakeCredentials()
  const store = fakeStore()
  const report = await runOnboard(baseDeps({
    ask: fakeAsk([
      { selected: ['已有应用 — 我提供 App ID 和 Secret'] },
      { custom: 'cli_nb' },
      { custom: 'sec_nb' },
      { selected: ['保存并显示修复清单'] },
      { selected: ['稍后配对：激活后私聊机器人点卡片 pairing（推荐）'] },
    ]),
    credentials,
    store,
    verifyImpl: async () => ({ status: 'no-bot' }),
  }))
  assert.equal(report.ok, true)
  assert.equal(report.credentialsWritten, true)
  assert.equal(credentials.values.get('DSH_FEISHU_APP_ID'), 'cli_nb')
  assert.equal(credentials.values.get('DSH_FEISHU_APP_SECRET'), 'sec_nb')
  assert.deepEqual(report.operatorsPaired, [])
  assert.match(report.text, /修复/)
  assert.match(report.text, /「机器人」/)
  assert.match(report.text, /长连接/)
})

test('runOnboard falls back to YAML instructions when the credentials service is missing', async () => {
  const report = await runOnboard(baseDeps({
    ask: fakeAsk([
      { selected: ['已有应用 — 我提供 App ID 和 Secret'] },
      { custom: 'cli_sm' },
      { custom: 'sec_sm' },
      { selected: ['跳过'] },
    ]),
    credentials: undefined,
    store: undefined,
    verifyImpl: async () => ({ status: 'ok', botName: 'b', botOpenId: undefined }),
  }))
  assert.equal(report.ok, true)
  assert.equal(report.credentialsWritten, false)
  assert.match(report.text, /\.credentials\.yaml/)
  assert.match(report.text, /DSH_FEISHU_APP_ID: cli_sm/)
  assert.match(report.text, /DSH_FEISHU_APP_SECRET: sec_sm/)
  assert.match(report.text, /轮换/, 'the exposed-secret rotation warning is mandatory here')
})

test('runOnboard retries once after bad credentials and then succeeds', async () => {
  const credentials = fakeCredentials()
  const verifyCalls = []
  const report = await runOnboard(baseDeps({
    ask: fakeAsk([
      { selected: ['已有应用 — 我提供 App ID 和 Secret'] },
      { custom: 'cli_x' },
      { custom: 'sec_bad' },
      { selected: ['重新输入'] },
      { custom: 'cli_x' },
      { custom: 'sec_good' },
      { selected: ['跳过'] },
    ]),
    credentials,
    verifyImpl: async creds => {
      verifyCalls.push(creds.appSecret)
      return creds.appSecret === 'sec_bad' ? { status: 'bad-credentials' } : { status: 'ok', botName: 'b', botOpenId: undefined }
    },
  }))
  assert.equal(report.ok, true)
  assert.deepEqual(verifyCalls, ['sec_bad', 'sec_good'])
  assert.equal(credentials.values.get('DSH_FEISHU_APP_SECRET'), 'sec_good')
})

test('runOnboard falls back to the guide when the ask call throws (NO_PROVIDER)', async () => {
  const report = await runOnboard(baseDeps({
    ask: { ask: async () => { throw new Error('NO_PROVIDER') } },
  }))
  assert.equal(report.ok, true)
  assert.match(report.text, /交互问询不可用/)
  assert.match(report.text, /手动/)
  assert.equal(report.credentialsWritten, false)
})

test('runOnboard reports aborted when the signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  let verifyCalls = 0
  const report = await runOnboard(baseDeps({
    signal: controller.signal,
    existingCredentials: { appId: 'cli_old', appSecret: 'sec_old' },
    verifyImpl: async () => { verifyCalls++ ; return { status: 'ok', botName: 'b', botOpenId: undefined } },
  }))
  assert.equal(report.ok, false)
  assert.match(report.text, /已取消/)
  assert.equal(verifyCalls, 0)
  assert.equal(report.credentialsWritten, false)
  assert.equal(report.appId, undefined)
})

// ------------------------------------------------- ask agent-scoped dispatch --

test('runOnboard threads deps.agent into every ask request (web bridge requires it)', async () => {
  const agent = { id: 'agent-live-root' }
  const ask = fakeAsk([{ selected: ['只要手动申请指南'] }])
  const report = await runOnboard(baseDeps({ ask, agent }))
  assert.equal(report.ok, true)
  assert.equal(ask.calls.length, 1)
  assert.equal(ask.calls[0].agent, agent, 'the live root agent must ride the ask request')
})

test('runOnboard omits the agent from ask requests when none is supplied', async () => {
  const ask = fakeAsk([{ selected: ['只要手动申请指南'] }])
  const report = await runOnboard(baseDeps({ ask }))
  assert.equal(report.ok, true)
  assert.equal(ask.calls.length, 1)
  assert.equal(ask.calls[0].agent, undefined)
})

test('runOnboard retries ask once without the agent when the scoped ask throws', async () => {
  const agent = { id: 'agent-live-root' }
  const calls = []
  const ask = {
    ask: async request => {
      calls.push(request)
      if (request.agent !== undefined) throw new Error('CALLER_NOT_LIVE')
      return { answers: [{ id: request.questions[0].id, selected: ['只要手动申请指南'], custom: undefined }] }
    },
  }
  const report = await runOnboard(baseDeps({ ask, agent }))
  assert.equal(report.ok, true)
  assert.match(report.text, /手动/)
  assert.deepEqual(calls.map(call => call.agent), [agent, undefined], 'agent-less retry must follow the failed scoped ask')
})

test('runOnboard degrades to the guide when both agent-scoped and plain ask fail', async () => {
  const ask = { ask: async () => { throw new Error('NO_PROVIDER') } }
  const report = await runOnboard(baseDeps({ ask, agent: { id: 'a' } }))
  assert.equal(report.ok, true)
  assert.match(report.text, /交互问询不可用/)
})
