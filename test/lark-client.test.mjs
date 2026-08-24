import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bridgeSdkLogger, FeishuApiError, LarkClient, requestFeishu } from '../lib/lark-client.js'

test('warn matching "no <event> handler" downgrades to debug', () => {
  const entries = []
  const logger = bridgeSdkLogger((level, message) => entries.push([level, message]))
  logger.warn('no im.message.message_read_v1 handler')
  logger.warn('  no im.message.reaction.created_v1 handle ')
  assert.deepEqual(entries, [
    ['debug', 'no im.message.message_read_v1 handler'],
    ['debug', '  no im.message.reaction.created_v1 handle '],
  ])
})

test('warn called with the LoggerProxy array shape still matches and downgrades', () => {
  // The SDK's LoggerProxy forwards its collected args as ONE ARRAY — the
  // flatten step must unwrap that layer or every match fails behind a
  // JSON `["…"]` wrapper.
  const entries = []
  const logger = bridgeSdkLogger((level, message) => entries.push([level, message]))
  logger.warn(['no im.message.message_read_v1 handler'])
  logger.warn(['no im.message.reaction.created_v1 handle'])
  // Real warnings in the same shape pass through at warn severity.
  logger.warn(['websocket connection lost, reconnecting'])
  assert.deepEqual(entries, [
    ['debug', 'no im.message.message_read_v1 handler'],
    ['debug', 'no im.message.reaction.created_v1 handle'],
    ['warn', 'websocket connection lost, reconnecting'],
  ])
})

test('real SDK warnings and errors keep their severity and content', () => {
  const entries = []
  const logger = bridgeSdkLogger((level, message) => entries.push([level, message]))
  logger.warn('websocket connection lost, reconnecting')
  logger.error('send message failed:', { code: 99991663 })
  logger.info('token refreshed')
  assert.deepEqual(entries, [
    ['warn', 'websocket connection lost, reconnecting'],
    ['error', 'send message failed: {"code":99991663}'],
    ['debug', 'token refreshed'],
  ])
})

test('no-handler downgrade is case-insensitive and rejects near misses', () => {
  const levels = []
  const logger = bridgeSdkLogger(level => levels.push(level))
  logger.warn('NO im.message.message_read_v1 HANDLER')
  logger.warn('no handler for event') // not the dispatcher's notice format
  assert.deepEqual(levels, ['debug', 'warn'])
})

// ------------------------------------------------- requestFeishu (P1 wrapper) --

/** Instant fake timer recording the requested backoff delays. */
function fakeSleep() {
  const delays = []
  return {
    delays,
    sleep: async ms => { delays.push(ms) },
  }
}

test('requestFeishu throws FeishuApiError on a fulfilled non-zero-code body', async () => {
  const { delays, sleep } = fakeSleep()
  await assert.rejects(
    requestFeishu(async () => ({ code: 99991663, msg: 'forbidden', data: {} }), { sleep }),
    error => {
      assert.ok(error instanceof FeishuApiError)
      assert.equal(error.feishuCode, 99991663)
      assert.equal(error.msg, 'forbidden')
      assert.match(error.message, /code=99991663/)
      return true
    },
  )
  // A plain business error is not rate-limited — no retry attempted.
  assert.deepEqual(delays, [])
})

test('requestFeishu passes a zero-code response through untouched', async () => {
  const result = await requestFeishu(async () => ({ code: 0, data: { message_id: 'om_1' } }))
  assert.deepEqual(result, { code: 0, data: { message_id: 'om_1' } })
})

test('requestFeishu retries HTTP 429 with backoff and then succeeds', async () => {
  const { delays, sleep } = fakeSleep()
  let calls = 0
  const result = await requestFeishu(async () => {
    calls++
    if (calls === 1) throw Object.assign(new Error('rate limited'), { response: { status: 429 } })
    return { code: 0, data: { ok: true } }
  }, { sleep })
  assert.deepEqual(result, { code: 0, data: { ok: true } })
  assert.equal(calls, 2)
  assert.deepEqual(delays, [500]) // exponential backoff base
})

test('requestFeishu retries a fulfilled rate-limit code body (11232)', async () => {
  const { delays, sleep } = fakeSleep()
  let calls = 0
  const result = await requestFeishu(async () => {
    calls++
    if (calls === 1) return { code: 11232, msg: 'too many requests' }
    return { code: 0, data: {} }
  }, { sleep })
  assert.equal(calls, 2)
  assert.deepEqual(delays, [500])
  assert.deepEqual(result, { code: 0, data: {} })
})

test('requestFeishu gives up after the retry budget under sustained limiting', async () => {
  const { delays, sleep } = fakeSleep()
  let calls = 0
  await assert.rejects(
    requestFeishu(async () => {
      calls++
      throw Object.assign(new Error('rate limited'), { response: { status: 429, data: { code: 230020 } } })
    }, { sleep }),
    // The original transport-shaped error propagates, not a wrapped one.
    error => error.message === 'rate limited',
  )
  assert.equal(calls, 3) // initial attempt + maxRetries=2
  assert.deepEqual(delays, [500, 1000]) // exponential schedule
})

test('requestFeishu does not retry non-rate-limit errors', async () => {
  const { delays, sleep } = fakeSleep()
  let calls = 0
  await assert.rejects(
    requestFeishu(async () => {
      calls++
      throw new Error('socket hang up')
    }, { sleep }),
    /socket hang up/,
  )
  assert.equal(calls, 1)
  assert.deepEqual(delays, [])
})

// ------------------------------------------------------- LarkClient.patchCard --

test('patchCard returns false when Feishu fulfills with a business error body', async () => {
  const errors = []
  const client = new LarkClient({
    appId: 'cli_test',
    appSecret: 'secret',
    domain: 'feishu',
    onError: (what, error) => errors.push([what, error]),
    sleep: async () => {},
  })
  // Test seam: replace the SDK transport method with one that FULFILLS an
  // error envelope — the historical bug was patchCard returning true here,
  // silently lying to finalizeTurn's fallback resend chain.
  ;(client.client.im.message).patch = async () => ({ code: 99991663, msg: 'forbidden' })
  const card = { config: { wide_screen_mode: true }, elements: [] }
  const ok = await client.patchCard('om_1', card)
  assert.equal(ok, false)
  assert.equal(errors.length, 1)
  assert.equal(errors[0][0], 'patch-card')
  assert.ok(errors[0][1] instanceof FeishuApiError)
  assert.equal(errors[0][1].feishuCode, 99991663)
})

test('patchCard returns true on a zero-code success body', async () => {
  const errors = []
  const client = new LarkClient({
    appId: 'cli_test',
    appSecret: 'secret',
    domain: 'feishu',
    onError: (what, error) => errors.push([what, error]),
    sleep: async () => {},
  })
  ;(client.client.im.message).patch = async () => ({ code: 0 })
  const card = { config: { wide_screen_mode: true }, elements: [] }
  assert.equal(await client.patchCard('om_1', card), true)
  assert.deepEqual(errors, [])
})
