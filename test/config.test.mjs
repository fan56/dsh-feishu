import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../lib/config.js'

test('defaults apply for an empty config', () => {
  const resolved = resolveConfig({}, {})
  assert.equal(resolved.mode, 'on')
  assert.equal(resolved.domain, 'feishu')
  assert.deepEqual(resolved.operators, [])
  assert.equal(resolved.statusIntervalMs, 5000)
  assert.equal(resolved.bodySegmentChars, 3500)
  assert.equal(resolved.appIdRef, 'dsh-feishu-app-id')
  assert.equal(resolved.appSecretRef, 'dsh-feishu-app-secret')
  assert.equal(resolved.appId, undefined)
  assert.equal(resolved.appSecret, undefined)
})

test('unknown config keys throw (a typo must not silently disarm)', () => {
  assert.throws(() => resolveConfig({ operator: ['ou_a'] }, {}), /unknown config key "operator"/)
})

test('env supplies credentials when config omits them', () => {
  const resolved = resolveConfig({}, {
    DSH_FEISHU_APP_ID: 'cli_a',
    DSH_FEISHU_APP_SECRET: 'sec',
  })
  assert.equal(resolved.appId, 'cli_a')
  assert.equal(resolved.appSecret, 'sec')
})

test('config credentials win over env', () => {
  const resolved = resolveConfig(
    { appId: 'cli_config', appSecret: 'sec_config' },
    { DSH_FEISHU_APP_ID: 'cli_env', DSH_FEISHU_APP_SECRET: 'sec_env' },
  )
  assert.equal(resolved.appId, 'cli_config')
  assert.equal(resolved.appSecret, 'sec_config')
})

test('mode off and domain lark are honored', () => {
  const resolved = resolveConfig({ mode: 'off', domain: 'lark' }, {})
  assert.equal(resolved.mode, 'off')
  assert.equal(resolved.domain, 'lark')
})

test('out-of-range numeric options throw', () => {
  assert.throws(() => resolveConfig({ statusIntervalMs: 1000 }, {}), /statusIntervalMs/)
  assert.throws(() => resolveConfig({ bodySegmentChars: 100 }, {}), /bodySegmentChars/)
})

test('progressIntervalMs is gone with the progress-card feature (unknown key)', () => {
  assert.throws(() => resolveConfig({ progressIntervalMs: 60000 }, {}), /unknown config key "progressIntervalMs"/)
})

test('resumeListStyle defaults to auto', () => {
  assert.equal(resolveConfig({}, {}).resumeListStyle, 'auto')
})

test('resumeListStyle accepts table/list overrides', () => {
  assert.equal(resolveConfig({ resumeListStyle: 'table' }, {}).resumeListStyle, 'table')
  assert.equal(resolveConfig({ resumeListStyle: 'list' }, {}).resumeListStyle, 'list')
})

test('unknown resumeListStyle value throws', () => {
  // The static schema rejects it at runtime via the unknown-value union.
  assert.throws(() => resolveConfig({ resumeListStyle: 'plain' }, {}), /resumeListStyle/)
})

test('btwContextMessages defaults to 6', () => {
  assert.equal(resolveConfig({}, {}).btwContextMessages, 6)
})

test('btwContextMessages accepts 0..50 and rejects the rest', () => {
  assert.equal(resolveConfig({ btwContextMessages: 0 }, {}).btwContextMessages, 0)
  assert.equal(resolveConfig({ btwContextMessages: 50 }, {}).btwContextMessages, 50)
  assert.throws(() => resolveConfig({ btwContextMessages: 51 }, {}), /btwContextMessages/)
  assert.throws(() => resolveConfig({ btwContextMessages: -1 }, {}), /btwContextMessages/)
  assert.throws(() => resolveConfig({ btwContextMessages: 1.5 }, {}), /btwContextMessages/)
})
