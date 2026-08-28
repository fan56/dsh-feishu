import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateSessionLog, repairedPathFor, runRepair, swapRepaired, verifyClean } from '../lib/log-repair.js'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-logrepair-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const CLEAN_LOG = '{"type":"user/message","seq":0,"time":1,"data":{}}\n{"type":"user/message","seq":1,"time":2,"data":{}}\n'
// Double-writer shape: seq 1 arrives twice.
const CORRUPT_LOG = `${CLEAN_LOG}{"type":"user/message","seq":1,"time":3,"data":{}}\n`

test('repairedPathFor mirrors the script output-name rule', () => {
  assert.equal(repairedPathFor('/x/y/session.jsonl.zstd'), '/x/y/session.repaired.jsonl.zstd')
  assert.equal(repairedPathFor('/x/y/session.jsonl'), '/x/y/session.repaired.jsonl')
})

test('dry-run: clean log verifies, corrupt log does not', async () => {
  const { dir, cleanup } = scratch()
  try {
    const clean = join(dir, 'clean.jsonl')
    writeFileSync(clean, CLEAN_LOG)
    assert.equal(await verifyClean(clean), true)

    const torn = join(dir, 'torn.jsonl')
    writeFileSync(torn, CORRUPT_LOG)
    // Dry-run exit 3 (diagnosed, nothing written) is NOT clean — and no file appears.
    assert.equal(await verifyClean(torn), false)
    assert.ok(!existsSync(join(dir, 'torn.repaired.jsonl')))
  } finally {
    cleanup()
  }
})

test('apply on a corrupt log repairs it beside the original and swap puts it in place', async () => {
  const { dir, cleanup } = scratch()
  try {
    const log = join(dir, 'session.jsonl')
    writeFileSync(log, CORRUPT_LOG)

    const applied = await runRepair(log, { apply: true })
    assert.equal(applied.status, 'repaired')
    assert.equal(applied.repairedPath, join(dir, 'session.repaired.jsonl'))
    assert.ok(existsSync(applied.repairedPath))
    // The original is byte-identical until the swap.
    assert.equal(readFileSync(log, 'utf8'), CORRUPT_LOG)

    // The rebuilt log passes the dry-run verdict.
    assert.equal(await verifyClean(applied.repairedPath), true)

    const repairedContent = readFileSync(applied.repairedPath, 'utf8')
    await swapRepaired(log, applied.repairedPath)
    // The repaired file was MOVED in, not copied — the log holds its content.
    assert.equal(readFileSync(log, 'utf8'), repairedContent)
    const backup = readFileSync(join(dir, 'session.jsonl.corrupt-bak'), 'utf8')
    assert.equal(backup, CORRUPT_LOG, 'the original survives as .corrupt-bak')
  } finally {
    cleanup()
  }
})

test('apply on an already-clean log reports clean without writing anything', async () => {
  const { dir, cleanup } = scratch()
  try {
    const log = join(dir, 'clean.jsonl')
    writeFileSync(log, CLEAN_LOG)
    const applied = await runRepair(log, { apply: true })
    assert.equal(applied.status, 'clean')
    assert.equal(applied.repairedPath, undefined)
    assert.ok(!existsSync(join(dir, 'clean.repaired.jsonl')))
  } finally {
    cleanup()
  }
})

test('a stale repaired artifact from an earlier run is never swapped in', async () => {
  const { dir, cleanup } = scratch()
  try {
    const log = join(dir, 'session.jsonl')
    writeFileSync(log, CLEAN_LOG)
    // Leftover output of an earlier repair — since-rendered obsolete. The
    // CLEAN verdict alone must classify this run; the pre-apply unlink is
    // the second belt so the artifact cannot even linger.
    const stale = join(dir, 'session.repaired.jsonl')
    writeFileSync(stale, 'stale bytes\n')

    const applied = await runRepair(log, { apply: true })
    assert.equal(applied.status, 'clean', 'verdict CLEAN wins over any file on disk')
    assert.equal(applied.repairedPath, undefined)
    assert.ok(!existsSync(stale), 'the stale artifact was cleared before the run')
    assert.equal(readFileSync(log, 'utf8'), CLEAN_LOG, 'the intact log was not touched')
  } finally {
    cleanup()
  }
})

test('locateSessionLog prefers the zstd log and falls back to the raw jsonl', async () => {
  const { dir, cleanup } = scratch()
  try {
    assert.equal(await locateSessionLog(dir), undefined)

    const raw = join(dir, 'session.jsonl')
    writeFileSync(raw, CLEAN_LOG)
    assert.equal(await locateSessionLog(dir), raw)

    const packed = join(dir, 'session.jsonl.zstd')
    writeFileSync(packed, 'packed')
    assert.equal(await locateSessionLog(dir), packed)
  } finally {
    cleanup()
  }
})

test('missing input and torn lines come back as failures with the tool detail', async () => {
  const { dir, cleanup } = scratch()
  try {
    const missing = await runRepair(join(dir, 'nope.jsonl'), { apply: true })
    assert.equal(missing.status, 'failed')
    assert.match(missing.detail ?? '', /ENOENT/)

    const torn = join(dir, 'torn.jsonl')
    writeFileSync(torn, '{"type":"a","seq":0,"time":1,"data":{}}\n{"type":"b","seq":1,"tim\n')
    const result = await runRepair(torn, { apply: true })
    assert.equal(result.status, 'failed')
    assert.match(result.detail ?? '', /torn\/unparseable/)
    // The original was not touched by the failed attempt.
    assert.ok(readFileSync(torn, 'utf8').includes('"tim'))
  } finally {
    cleanup()
  }
})

test('a second swap timestamps its backup instead of clobbering the first', async () => {
  const { dir, cleanup } = scratch()
  try {
    const log = join(dir, 'session.jsonl')
    writeFileSync(log, CORRUPT_LOG)
    const repairedA = join(dir, 'a.repaired.jsonl')
    writeFileSync(repairedA, '{"type":"a","seq":0,"time":1,"data":{}}\n')
    await swapRepaired(log, repairedA)
    const repairedB = join(dir, 'b.repaired.jsonl')
    writeFileSync(repairedB, '{"type":"b","seq":0,"time":9,"data":{}}\n')
    const bContent = readFileSync(repairedB, 'utf8')
    await swapRepaired(log, repairedB)
    // First backup intact under its plain name; the log now holds B.
    assert.equal(readFileSync(join(dir, 'session.jsonl.corrupt-bak'), 'utf8'), CORRUPT_LOG)
    assert.equal(readFileSync(log, 'utf8'), bContent)
    assert.ok(!existsSync(repairedB), 'the swapped-in file was moved, not copied')
  } finally {
    cleanup()
  }
})

test('the zstd path writes session.repaired.jsonl.zstd (skipped without a zstd binary)', async t => {
  const probe = spawnSync('zstd', ['--version'])
  if (probe.error !== undefined || probe.status !== 0) {
    t.skip('no zstd binary on PATH')
    return
  }
  const { dir, cleanup } = scratch()
  try {
    const plain = join(dir, 'session.jsonl')
    writeFileSync(plain, CORRUPT_LOG)
    const log = join(dir, 'session.jsonl.zstd')
    const packed = spawnSync('zstd', ['-q', '-f', plain, '-o', log])
    assert.equal(packed.status, 0)

    const applied = await runRepair(log, { apply: true })
    assert.equal(applied.status, 'repaired')
    assert.equal(applied.repairedPath, join(dir, 'session.repaired.jsonl.zstd'))
    assert.ok(existsSync(applied.repairedPath))
  } finally {
    cleanup()
  }
})
