import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireLock, lockFilePath, releaseLock } from '../lib/index.js'

function tempPath(name) {
  return join(mkdtempSync(join(tmpdir(), `dsh-feishu-test-${name}-`)), 'bot.lock')
}

test('acquire writes our pid and release clears the file', () => {
  const path = tempPath('basic')
  const fd = acquireLock(path)
  assert.notEqual(fd, undefined)
  assert.equal(Number.parseInt(readFileSync(path, 'utf8').trim(), 10), process.pid)
  releaseLock(fd, path)
  assert.throws(() => readFileSync(path))
})

test('a second live instance is refused', () => {
  const path = tempPath('double')
  const first = acquireLock(path)
  assert.notEqual(first, undefined)
  assert.equal(acquireLock(path), undefined)
  releaseLock(first, path)
})

test('a stale lock (dead pid) is stolen', () => {
  const path = tempPath('stale')
  writeFileSync(path, '999999999\n') // no such pid
  const fd = acquireLock(path)
  assert.notEqual(fd, undefined)
  releaseLock(fd, path)
})

test('the default lock path lives in tmpdir', () => {
  assert.ok(lockFilePath().includes('dsh-feishu-bot.lock'))
})
