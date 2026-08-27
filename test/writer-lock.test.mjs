import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireWriterLock, releaseOwnedWriterLock, writerLockPath } from '../lib/writer-lock.js'

function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `dsh-feishu-wlock-${name}-`))
}

/** A genuinely live foreign pid: a sleeping child process. */
function liveForeignPid() {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  return { pid: child.pid, stop: () => child.kill('SIGKILL') }
}

/** A genuinely dead pid: run a child to completion, then reuse its pid. */
async function deadPid() {
  const child = spawn('true')
  await new Promise(resolve => child.on('exit', resolve))
  return child.pid
}

test('acquire writes our pid beside the session dir; establishing release removes it', async () => {
  const dir = tempDir('roundtrip')
  const ok = await acquireWriterLock(dir)
  assert.deepEqual(ok, { ok: true })
  const stored = JSON.parse(readFile())
  assert.equal(stored.pid, process.pid)
  assert.equal(stored.holder, 'feishu')

  // Same-process reacquire is a cooperative inherit: succeeds without
  // rewriting (createdAt unchanged) and the release below still works,
  // because THIS process established the original.
  const firstCreated = JSON.parse(readFile()).createdAt
  await new Promise(resolve => setTimeout(resolve, 5))
  const again = await acquireWriterLock(dir)
  assert.equal(again.ok, true)
  assert.equal(JSON.parse(readFile()).createdAt, firstCreated)

  await releaseOwnedWriterLock(dir)
  assertReaddirWithout('writer.lock')
  rmSync(dir, { recursive: true, force: true })

  function readFile() {
    return readFileSync(writerLockPath(dir), 'utf8')
  }
  function assertReaddirWithout(name) {
    assert.equal(readdirSync(dir).includes(name), false)
  }
})

test('a live foreign holder refuses with its identity recorded', async () => {
  const dir = tempDir('foreign-live')
  const foreign = liveForeignPid()
  try {
    writeFileSync(writerLockPath(dir), JSON.stringify({ pid: foreign.pid, createdAt: '2026-08-27T00:00:00Z', holder: 'tui' }))
    const result = await acquireWriterLock(dir)
    assert.notEqual(result.ok, true)
    if (!result.ok) {
      assert.equal(result.holder.pid, foreign.pid)
      assert.equal(result.holder.holder, 'tui')
    }
    assert.equal(readdirSync(dir).filter(name => name.startsWith('writer.lock.stale-')).length, 0, 'a live holder is never stolen aside')
  } finally {
    foreign.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale lock (dead pid) is stolen and the residue renamed aside', async () => {
  const dir = tempDir('steal')
  const dead = await deadPid()
  writeFileSync(writerLockPath(dir), JSON.stringify({ pid: dead, createdAt: '', holder: 'feishu' }))
  const result = await acquireWriterLock(dir)
  assert.deepEqual(result, { ok: true })
  assert.equal(JSON.parse(readFileSync(writerLockPath(dir), 'utf8')).pid, process.pid)
  const residues = readdirSync(dir).filter(name => name.startsWith('writer.lock.stale-'))
  assert.equal(residues.length, 1, 'the stolen residue must be kept aside, never deleted silently')
  rmSync(dir, { recursive: true, force: true })
})

test('release on a dir we never established is a no-op for foreign files', async () => {
  const dir = tempDir('noop-release')
  writeFileSync(writerLockPath(dir), JSON.stringify({ pid: process.pid + 1_000_000, createdAt: '', holder: 'other' }))
  await releaseOwnedWriterLock(dir)
  assert.equal(readdirSync(dir).includes('writer.lock'), true)
  rmSync(dir, { recursive: true, force: true })
})
