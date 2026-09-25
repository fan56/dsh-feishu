import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { StateStore } from '../lib/state-store.js'

/** A printf-style logger double recording every formatted line. */
function spyLogger() {
  const lines = { info: [], warn: [] }
  const format = (fmt, ...args) => {
    let index = 0
    return fmt.replace(/%s/g, () => String(args[index++]))
  }
  return {
    lines,
    info(fmt, ...args) { lines.info.push(format(fmt, ...args)) },
    warn(fmt, ...args) { lines.warn.push(format(fmt, ...args)) },
  }
}

// --------------------------------------------------- legacy absorption (0.1.5 → 0.1.7) --

test('a single-line quoted pairedOperators list decodes to every operator, and the absorption lands on disk immediately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-state-'))
  const path = join(dir, 'dsh-feishu-state.json')
  await writeFile(join(dir, 'settings.yaml.imported'), [
    'dsh-feishu:',
    '  boundSessionId: sess-legacy',
    "  pairedOperators: '[\"ou_a\",\"ou_b\",\"ou_c\"]'",
    '  displayThink: false',
    ].join('\n'))
  const logger = spyLogger()
  const store = new StateStore({ inject() {} }, { path, logger })
  await store.ready()
  // The 0.1.5 writer encoded the list as ONE quoted JSON string — all three
  // operators must survive, not just the first.
  assert.deepEqual(store.getPairedOperators(), ['ou_a', 'ou_b', 'ou_c'])
  assert.equal(store.get().boundSessionId, 'sess-legacy')
  assert.equal(store.get().displayThink, false)
  // The absorbed state is persisted BEFORE any mutation: the state file must
  // exist the moment ready() settles, or the takeover is invisible on disk.
  assert.equal(existsSync(path), true, 'absorbed state must be persisted immediately')
  const onDisk = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(onDisk.pairedOperators, ['ou_a', 'ou_b', 'ou_c'])
  assert.equal(onDisk.boundSessionId, 'sess-legacy')
  // One info line names the source document and every absorbed key.
  assert.equal(logger.lines.info.length, 1)
  assert.match(logger.lines.info[0], /absorbed legacy settings state \(settings\.yaml\.imported\)/)
  assert.match(logger.lines.info[0], /pairedOperators=3/)
  assert.match(logger.lines.info[0], /boundSessionId=yes/)
  assert.match(logger.lines.info[0], /displayThink=no/)
  assert.deepEqual(logger.lines.warn, [])
})

test('a folded (line-wrapped) legacy scalar is reported as skipped in a warning line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-state-'))
  const path = join(dir, 'dsh-feishu-state.json')
  // The yaml writer folds long payloads at 80 columns; the opening quote never
  // closes on its line, so pairedOperators degrades to [] (not a half-read).
  await writeFile(join(dir, 'settings.yaml.imported'), [
    'dsh-feishu:',
    '  boundSessionId: sess-fold',
    "  pairedOperators: '[\"ou_xxxxxxxxxxxxxxxxxxxxxxxxxx",
    `    ${' '.repeat(17)}yyy\"]'`,
    ].join('\n'))
  const logger = spyLogger()
  const store = new StateStore({ inject() {} }, { path, logger })
  await store.ready()
  assert.equal(store.get().boundSessionId, 'sess-fold') // the readable key still lands
  assert.deepEqual(store.getPairedOperators(), [])
  assert.equal(existsSync(path), true) // partial absorption still persists
  // The skip is not silent: the operator must learn which key was lost.
  assert.equal(logger.lines.warn.length, 1)
  assert.match(logger.lines.warn[0], /not absorbed from settings\.yaml\.imported/)
  assert.match(logger.lines.warn[0], /pairedOperators/)
  assert.match(logger.lines.warn[0], /re-pairing may be required/)
})

test('an empty-shell legacy section (everything folded) logs a warning and writes NO state file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-state-'))
  const path = join(dir, 'dsh-feishu-state.json')
  await writeFile(join(dir, 'settings.yaml.imported'), [
    'dsh-feishu:',
    "  pairedOperators: '[\"ou_xxxxxxxxxxxxxxxxxxxxxxxxxx",
    `    ${' '.repeat(17)}yyy\"]'`,
    ].join('\n'))
  const logger = spyLogger()
  const store = new StateStore({ inject() {} }, { path, logger })
  await store.ready()
  assert.deepEqual(store.getPairedOperators(), [])
  assert.equal(store.get().boundSessionId, undefined)
  // Nothing was absorbed → nothing persisted (defaults stay off-disk).
  assert.equal(existsSync(path), false, 'an empty shell must not create a state file')
  // …but the loss is announced: one line naming the document AND the
  // degenerated key, so the operator knows a re-pair is needed.
  assert.equal(logger.lines.warn.length, 1)
  assert.match(logger.lines.warn[0], /carried no readable state/)
  assert.match(logger.lines.warn[0], /settings\.yaml\.imported/)
  assert.match(logger.lines.warn[0], /pairedOperators/)
  assert.match(logger.lines.warn[0], /re-pairing may be required/)
})

test('a fresh install (no legacy document) stays silent and writes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-state-'))
  const path = join(dir, 'dsh-feishu-state.json')
  const logger = spyLogger()
  const store = new StateStore({ inject() {} }, { path, logger })
  await store.ready()
  assert.deepEqual(store.getPairedOperators(), [])
  assert.equal(existsSync(path), false)
  assert.deepEqual(logger.lines.info, [])
  assert.deepEqual(logger.lines.warn, [])
})

test('without an injected logger the store still picks the plugin context logger up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-state-'))
  const path = join(dir, 'dsh-feishu-state.json')
  await writeFile(join(dir, 'settings.yaml.imported'), [
    'dsh-feishu:',
    '  boundSessionId: sess-ctx',
    ].join('\n'))
  const logger = spyLogger()
  // index.ts passes only the cordis context — the constructor must find
  // ctx.logger structurally (and a bare `{ inject }` test ctx stays silent).
  const store = new StateStore({ inject() {}, logger }, { path })
  await store.ready()
  assert.equal(store.get().boundSessionId, 'sess-ctx')
  assert.equal(logger.lines.info.length, 1)
  assert.match(logger.lines.info[0], /absorbed legacy settings state/)
})
