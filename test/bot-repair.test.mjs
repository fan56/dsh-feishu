import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FeishuBot } from '../lib/bot.js'
import { locateSessionLog, repairedPathFor } from '../lib/log-repair.js'
import { WriterLockedError } from '../lib/writer-lock.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

/** Repeat ticks until `cond()` holds or the budget runs out. */
async function until(cond, ms = 2000) {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) return false
    await tick()
  }
  return true
}

const CORRUPT_ERROR = () => new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record')

/** Fake repair backend: records every call; runRepair notes the lock state. */
function fakeRepair(overrides = {}) {
  const calls = { locate: [], run: [], verify: [], swap: [] }
  return {
    calls,
    // Delegate to the REAL locator so dir-probing behavior is under test.
    async locateSessionLog(dir) {
      const found = await locateSessionLog(dir)
      calls.locate.push({ dir, found })
      return found
    },
    async runRepair(logPath, options) {
      const lockHeld = existsSync(join(logPath, '..', 'writer.lock'))
      calls.run.push({ logPath, options, lockHeld })
      return { status: 'repaired', repairedPath: repairedPathFor(logPath) }
    },
    async verifyClean(logPath) {
      calls.verify.push(logPath)
      return true
    },
    async swapRepaired(logPath, repairedPath) {
      calls.swap.push({ logPath, repairedPath })
    },
    ...overrides,
  }
}

/**
 * Bot wired for the corrupt-repair flow: the picker targets one corrupt
 * session, the binder locates it in a REAL tmp dir (the writer lock runs
 * for real), and the first `corruptFails` binds throw the corrupt error
 * (later binds follow `bindImpl`). The dir holds a session log file (raw
 * when `rawOnly`, else zstd) for the real locator to find; the first
 * `sendFailures` lark sends reject to exercise failure containment.
 */
function repairBot({ bindImpl, repair, corruptFails = 1, rawOnly = false, sendFailures = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-repair-'))
  writeFileSync(join(dir, rawOnly ? 'session.jsonl' : 'session.jsonl.zstd'), '')
  const state = { lastChatId: 'oc_test', displayThink: false, boundSessionId: undefined, picker: undefined }
  const bindCalls = []
  const watchCalls = []
  const warnCalls = []
  const sends = []
  let sendAttempts = 0
  const bot = new FeishuBot({
    ctx: {
      logger: {
        info() {},
        warn: (...args) => warnCalls.push(args),
        error() {},
      },
      get: () => undefined,
    },
    config: { statusIntervalMs: 30000, bodySegmentChars: 3500 },
    lark: {
      async sendCard(_c, card) {
        if (sendAttempts++ < sendFailures) throw new Error('lark send failed')
        sends.push(card)
        return `m${sends.length}`
      },
      async patchCard() { return true },
    },
    binder: {
      getSessionId: () => undefined,
      getAgent: () => undefined,
      isReadOnlyView: () => false,
      detach: async () => {},
      sessionDirOf: async () => dir,
      watchRemote: async sessionId => { watchCalls.push(sessionId) },
      setOnPromotable() {},
      drainOutboxIntoAgent() {},
      async bind(id, options) {
        bindCalls.push({ id, options })
        if (bindCalls.length <= corruptFails) throw CORRUPT_ERROR()
        return bindImpl ? bindImpl(id, options) : { sessionId: id, mode: 'attached', agent: { status: 'idle' } }
      },
    },
    store: { ready: async () => {}, get: () => state, async update(p) { Object.assign(state, p) } },
    allowlist: new Set(['ou_op']),
    now: () => 1000,
    repair,
  })
  bot.pendingPicker = {
    id: 'p1',
    rows: [{ index: 1, sessionId: 'torn-log', dir: 'repo', createdAt: 1, lastTime: undefined, preview: 'x' }],
    expiresAt: 999_999,
  }
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  return { bot, dir, sends, bindCalls, watchCalls, warnCalls, state, cleanup }
}

/** The flow id carried by a buttons-mode selector card's buttons. */
function flowIdOf(card) {
  const button = card.body.elements.find(e => e.tag === 'button')
  assert.ok(button !== undefined, 'expected a buttons-mode selector card')
  return button.value.flow_id
}

/** Submit a pick on the given selector flow as the operator. */
function pick(bot, card, value) {
  bot.onCardAction({
    operator: { open_id: 'ou_op' },
    action: { tag: 'button', value: { action: 'dsh_feishu_sel', flow_id: flowIdOf(card), pick: value } },
  })
}

test('corrupt resume failure puts up a repair confirmation card (repair / skip buttons)', async () => {
  const repair = fakeRepair()
  const { bot, sends, cleanup } = repairBot({ repair })
  try {
    await bot.resumePickCore(1)
    await until(() => sends.length === 1)
    assert.equal(sends.length, 1, 'exactly the confirmation card went out')
    assert.equal(sends[0].header.title.content, '会话日志已损坏')
    const picks = sends[0].body.elements.filter(e => e.tag === 'button' && e.value.pick !== undefined)
    assert.deepEqual(picks.map(b => b.value.pick), ['repair', 'skip'])
    // No repair action until the operator confirms.
    assert.equal(repair.calls.run.length, 0)
    assert.equal(repair.calls.swap.length, 0)
  } finally {
    cleanup()
  }
})

test('picking repair swaps the rebuilt log in, pairs the lock, and re-enters the session', async () => {
  const repair = fakeRepair()
  const { bot, dir, sends, bindCalls, cleanup } = repairBot({ repair })
  try {
    await bot.resumePickCore(1)
    await until(() => sends.length === 1)
    pick(bot, sends[0], 'repair')

    await until(() => bindCalls.length >= 2)
    // Rebuild ran under the writer lock, swap followed, verify saw the candidate.
    assert.equal(repair.calls.run.length, 1)
    assert.equal(repair.calls.run[0].options.apply, true)
    assert.equal(repair.calls.run[0].lockHeld, true, 'the single-writer lock was held during the rebuild')
    assert.equal(repair.calls.verify.length, 1)
    assert.match(repair.calls.verify[0], /session\.repaired\.jsonl\.zstd$/)
    assert.deepEqual(repair.calls.swap, [{ logPath: join(dir, 'session.jsonl.zstd'), repairedPath: join(dir, 'session.repaired.jsonl.zstd') }])
    assert.equal(bindCalls[1].id, 'torn-log')
    // The lock was released once the swap landed…
    await until(() => !existsSync(join(dir, 'writer.lock')))
    assert.ok(!existsSync(join(dir, 'writer.lock')), 'writer.lock released after the swap')
    // …and the phone saw the success + entered announcements.
    const texts = sends.map(c => c.body?.elements?.[0]?.content ?? '')
    assert.ok(texts.some(t => t.includes('已修复并换入')), JSON.stringify(texts))
    assert.ok(texts.some(t => t.includes('已进入会话')), JSON.stringify(texts))
  } finally {
    cleanup()
  }
})

test('skipping the repair card touches nothing', async () => {
  const repair = fakeRepair()
  const { bot, sends, bindCalls, cleanup } = repairBot({ repair })
  try {
    await bot.resumePickCore(1)
    await until(() => sends.length === 1)
    pick(bot, sends[0], 'skip')

    await until(() => sends.length >= 2)
    assert.ok(sends[1].body.elements[0].content.includes('未做修改'))
    assert.equal(repair.calls.run.length, 0, 'no rebuild ran')
    assert.equal(repair.calls.swap.length, 0, 'nothing swapped')
    assert.equal(bindCalls.length, 1, 'only the initial (failing) bind attempt')
  } finally {
    cleanup()
  }
})

test('a held writer lock refuses the repair with the holder pid, no swap', async () => {
  const repair = fakeRepair()
  const { bot, dir, sends, bindCalls, cleanup } = repairBot({ repair })
  const foreign = spawn('sleep', ['30'], { stdio: 'ignore' })
  try {
    // A lock file held by a LIVE foreign pid — the exact refusal shape.
    writeFileSync(join(dir, 'writer.lock'), JSON.stringify({ pid: foreign.pid, createdAt: new Date().toISOString(), holder: 'tui' }))
    await bot.resumePickCore(1)
    await until(() => sends.length === 1)
    pick(bot, sends[0], 'repair')

    await until(() => sends.length >= 2)
    const text = sends[1].body.elements[0].content
    assert.match(text, /会话正被 pid \d+ 驱动/)
    assert.ok(text.includes(String(foreign.pid)), `refusal names the holder pid (${text})`)
    assert.equal(repair.calls.run.length, 0, 'no rebuild under a foreign lock')
    assert.equal(repair.calls.swap.length, 0)
    assert.equal(bindCalls.length, 1)
  } finally {
    foreign.kill('SIGKILL')
    cleanup()
  }
})

test('a failed rebuild replies with the detail and never swaps', async () => {
  const repair = fakeRepair({
    async runRepair() { return { status: 'failed', detail: 'cannot run zstd: ENOENT' } },
  })
  const { bot, dir, sends, bindCalls, cleanup } = repairBot({ repair })
  try {
    await bot.resumePickCore(1)
    await until(() => sends.length === 1)
    pick(bot, sends[0], 'repair')

    await until(() => sends.length >= 2)
    const text = sends[1].body.elements[0].content
    assert.ok(text.includes('修复失败'), text)
    assert.ok(text.includes('cannot run zstd: ENOENT'), text)
    assert.ok(text.includes('原文件未动'), text)
    assert.equal(repair.calls.swap.length, 0)
    assert.equal(repair.calls.verify.length, 0)
    assert.equal(bindCalls.length, 1, 'no re-entry after a failed rebuild')
    await until(() => !existsSync(join(dir, 'writer.lock')))
    assert.ok(!existsSync(join(dir, 'writer.lock')), 'lock released on the failure path too')
  } finally {
    cleanup()
  }
})

test('a rebuilt log that fails verification is not swapped in', async () => {
  const repair = fakeRepair({ async verifyClean() { return false } })
  const { bot, dir, sends, bindCalls, cleanup } = repairBot({ repair })
  try {
    await bot.resumePickCore(1)
    await until(() => sends.length === 1)
    pick(bot, sends[0], 'repair')

    await until(() => sends.length >= 2)
    const text = sends[1].body.elements[0].content
    assert.match(text, /未通过完整性校验/)
    assert.match(text, /原文件未动/)
    assert.equal(repair.calls.swap.length, 0)
    assert.equal(bindCalls.length, 1)
    await until(() => !existsSync(join(dir, 'writer.lock')))
    assert.ok(!existsSync(join(dir, 'writer.lock')))
  } finally {
    cleanup()
  }
})

test('a second corrupt failure for the same session reuses the card already out', async () => {
  const repair = fakeRepair()
  // Both binds fail corrupt — the second failure must reuse the live card.
  const { bot, sends, cleanup } = repairBot({ repair, corruptFails: 2 })
  try {
    await bot.resumePickCore(1)
    await until(() => sends.length === 1)
    await bot.resumePickCore(1)
    await until(() => sends.length >= 2)

    assert.equal(sends.length, 2, 'no second confirmation card')
    assert.equal(sends[0].header.title.content, '会话日志已损坏')
    assert.ok(sends[1].body.elements[0].content.includes('修复确认卡已在上面'), sends[1].body.elements[0].content)
    assert.equal(repair.calls.run.length, 0)
  } finally {
    cleanup()
  }
})

test('a re-entry bind failure after a successful swap keeps the ordinary failure reply', async () => {
  const repair = fakeRepair()
  const { bot, sends, bindCalls, cleanup } = repairBot({
    repair,
    bindImpl() { throw new Error('registry closed') },
  })
  try {
    await bot.resumePickCore(1)
    await until(() => sends.length === 1)
    pick(bot, sends[0], 'repair')

    await until(() => bindCalls.length >= 2)
    await until(() => sends.length >= 2)
    const text = sends.at(-1).body.elements[0].content
    assert.match(text, /进入会话失败：registry closed/)
    // The swap itself DID happen — only the re-entry failed.
    assert.equal(repair.calls.swap.length, 1)
  } finally {
    cleanup()
  }
})

test('a failing Lark send inside the repair flow is contained, not a crash', async () => {
  const repair = fakeRepair()
  // Send #1 (the confirmation card) and #2 (the pointer degrade reply) both
  // reject — the detached repairFlow rejects, and the outer catch must
  // swallow it (log + ONE best-effort reply) instead of crashing the bot.
  const { bot, sends, warnCalls, cleanup } = repairBot({ repair, sendFailures: 2 })
  try {
    await bot.resumePickCore(1)
    assert.ok(
      await until(() => warnCalls.length >= 2),
      `both failures were logged (${warnCalls.length} warns)`,
    )
    // Settle the best-effort reply (send #3) before asserting.
    await until(() => sends.length >= 1)
    assert.equal(sends.length, 1, 'exactly the containment reply went out')
    assert.ok(sends[0].body.elements[0].content.includes('修复流程异常中断'), sends[0].body.elements[0].content)
    assert.equal(repair.calls.run.length, 0, 'the flow never reached the rebuild')
  } finally {
    cleanup()
  }
})

test('a raw (uncompressed) session log is repaired at its own path', async () => {
  const repair = fakeRepair()
  const { bot, dir, sends, cleanup } = repairBot({ repair, rawOnly: true })
  try {
    await bot.resumePickCore(1)
    await until(() => sends.length === 1)
    pick(bot, sends[0], 'repair')

    await until(() => repair.calls.run.length >= 1)
    assert.equal(repair.calls.run[0].logPath, join(dir, 'session.jsonl'), 'the RAW log is the repair target')
    assert.deepEqual(repair.calls.swap, [{
      logPath: join(dir, 'session.jsonl'),
      repairedPath: join(dir, 'session.repaired.jsonl'),
    }])
    await until(() => !existsSync(join(dir, 'writer.lock')))
  } finally {
    cleanup()
  }
})

test('a lock stolen before the re-entry degrades to the read-only watch', async () => {
  const repair = fakeRepair()
  const { bot, dir, sends, bindCalls, watchCalls, cleanup } = repairBot({
    repair,
    // The post-repair bind loses the race: another process holds the lock.
    bindImpl() {
      throw new WriterLockedError({ pid: 4242, createdAt: new Date().toISOString(), holder: 'tui' })
    },
  })
  try {
    await bot.resumePickCore(1)
    await until(() => sends.length === 1)
    pick(bot, sends[0], 'repair')

    await until(() => watchCalls.length >= 1)
    assert.equal(bindCalls.length, 2, 'the re-entry bind was attempted')
    const texts = sends.map(c => c.body?.elements?.[0]?.content ?? '')
    assert.ok(texts.some(t => t.includes('已进入只读旁观')), JSON.stringify(texts))
    assert.ok(texts.some(t => t.includes('4242')), JSON.stringify(texts))
    // The swap DID land (the repair itself was not wasted)…
    assert.equal(repair.calls.swap.length, 1)
    // …and no success announcement preceded the degraded watch reply.
    assert.ok(!texts.some(t => t.includes('已修复并换入')), JSON.stringify(texts))
    await until(() => !existsSync(join(dir, 'writer.lock')))
    assert.ok(!existsSync(join(dir, 'writer.lock')), 'the repair lock was still released')
  } finally {
    cleanup()
  }
})
