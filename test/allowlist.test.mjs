import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAllowlist, isOperator } from '../lib/allowlist.js'

test('buildAllowlist merges config and env, trims and dedupes', () => {
  const allowlist = buildAllowlist([' ou_a ', '', 'ou_b'], { DSH_FEISHU_OPERATORS: 'ou_b,ou_c,' })
  assert.deepEqual([...allowlist].sort(), ['ou_a', 'ou_b', 'ou_c'])
})

test('buildAllowlist without env yields the config list only', () => {
  const allowlist = buildAllowlist(['ou_a'], {})
  assert.deepEqual([...allowlist], ['ou_a'])
})

test('an empty allowlist authorizes nobody', () => {
  const allowlist = buildAllowlist([], {})
  assert.equal(allowlist.size, 0)
  assert.equal(isOperator('ou_a', allowlist), false)
})

test('isOperator matches membership exactly', () => {
  const allowlist = buildAllowlist(['ou_a'], {})
  assert.equal(isOperator('ou_a', allowlist), true)
  assert.equal(isOperator('ou_A', allowlist), false)
  assert.equal(isOperator('ou_ab', allowlist), false)
  assert.equal(isOperator(undefined, allowlist), false)
  assert.equal(isOperator('', allowlist), false)
})
