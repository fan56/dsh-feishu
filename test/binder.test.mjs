import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { SessionBinder } from '../lib/binder.js'

function makeRegistry() {
  const calls = { resume: [], resumeRecords: [], create: 0 }
  const agentsById = new Map()
  const handles = []
  return {
    calls,
    handles,
    agentsById,
    addLive(id) {
      agentsById.set(id, {
        id,
        session: { id },
        status: 'idle',
        followup: [],
        followupMsg: null,
      })
    },
    agents: {
      get(id) { return agentsById.get(String(id)) },
      async resume(options) {
        calls.resume.push(String(options.resumeSessionId))
        calls.resumeRecords.push(options)
        const agent = {
          id: String(options.resumeSessionId),
          session: { id: String(options.resumeSessionId) },
          status: 'idle',
          disposed: false,
        }
        const handle = {
          agent,
          dispose: async () => { agent.disposed = true },
        }
        handles.push(handle)
        return handle
      },
      async create(options) {
        calls.create += 1
        calls.createMeta = options.meta
        calls.createOptions = options
        if (calls.createShouldFail) throw new Error('boom')
        const agent = {
          id: String(options.sessionId),
          session: { id: String(options.sessionId) },
          status: 'idle',
          disposed: false,
        }
        const handle = {
          agent,
          dispose: async () => { agent.disposed = true },
        }
        handles.push(handle)
        return handle
      },
      // create() is ONLY for the binder's explicit createNew (the /new flow);
      // the bind paths must never reach it — the tests below assert that by
      // checking calls.create stays 0 through attach/resume.
    },
  }
}

test('bind attaches to a live agent without resuming', async () => {
  const registry = makeRegistry()
  registry.addLive('sess-live')
  const binder = new SessionBinder({ agents: registry.agents })
  const result = await binder.bind('sess-live')
  assert.equal(result.mode, 'attached')
  assert.equal(result.sessionId, 'sess-live')
  assert.deepEqual(registry.calls.resume, [])
  assert.equal(binder.getAgent().id, 'sess-live')
})

test('bind resumes a persisted (not live) session once and owns the handle', async () => {
  const registry = makeRegistry()
  const binder = new SessionBinder({ agents: registry.agents })
  const result = await binder.bind('sess-cold')
  assert.equal(result.mode, 'resumed')
  assert.deepEqual(registry.calls.resume, ['sess-cold'])
  // Rebinding the same id must not resume again.
  const again = await binder.bind('sess-cold')
  assert.equal(again.mode, 'resumed')
  assert.deepEqual(registry.calls.resume, ['sess-cold'])
})

test('rebinding keeps the previously owned handle alive (adoptable); attach keeps foreign agents alive', async () => {
  const registry = makeRegistry()
  const binder = new SessionBinder({ agents: registry.agents })
  await binder.bind('a')
  const firstHandle = registry.handles[0]
  await binder.bind('b')
  // Never disposed: another surface may have adopted the live agent —
  // disposing on rebind killed it out from under them (live report).
  assert.equal(firstHandle.agent.disposed, false)

  // The session goes live under a foreign owner — attach to theirs; OUR
  // stale resume handle for the same id is dropped, theirs is untouched.
  registry.addLive('b')
  const result = await binder.bind('b')
  assert.equal(result.mode, 'attached')
  assert.equal(result.agent.disposed, undefined) // the foreign agent is untouched
  assert.equal(binder.getAgent(), result.agent)
})

test('rebinding our own still-live handle keeps ownership (no self-dispose)', async () => {
  const registry = makeRegistry()
  const binder = new SessionBinder({ agents: registry.agents })
  await binder.bind('a')
  // Our resumed agent is still registered — get(id) returns exactly it.
  registry.agentsById.set('a', registry.handles[0].agent)
  const result = await binder.bind('a')
  assert.equal(result.mode, 'resumed')
  assert.equal(registry.handles[0].agent.disposed, false)
  assert.deepEqual(registry.calls.resume, ['a'])
})

test('detach drops the binding and keeps our handle alive (adoptable)', async () => {
  const registry = makeRegistry()
  const binder = new SessionBinder({ agents: registry.agents })
  await binder.bind('a')
  await binder.detach()
  assert.equal(binder.getSessionId(), undefined)
  assert.equal(binder.getAgent(), undefined)
  // The agent stays live in the registry — another surface may adopt it.
  assert.equal(registry.handles[0].agent.disposed, false)
})

test('getAgent re-probes the registry after our reference went stale', async () => {
  const registry = makeRegistry()
  const binder = new SessionBinder({ agents: registry.agents })
  await binder.bind('a')
  // The TUI resumed the same id into its own handle — the registry now
  // serves a different agent object; the binder must follow.
  registry.addLive('a')
  const agent = binder.getAgent()
  assert.equal(agent.id, 'a')
  assert.notEqual(agent, registry.handles[0].agent)
})

test('concurrent binds serialize without leaking handles', async () => {
  const registry = makeRegistry()
  const binder = new SessionBinder({ agents: registry.agents })
  const [first, second] = await Promise.all([binder.bind('x'), binder.bind('y')])
  // The second bind wins the final binding; the first's handle stays live
  // (never disposed — adoptable by other surfaces).
  assert.ok(['x', 'y'].includes(first.sessionId))
  assert.ok(['x', 'y'].includes(second.sessionId))
  const disposed = registry.handles.filter(h => h.agent.disposed).length
  assert.equal(disposed, 0)
  assert.equal(binder.getSessionId(), 'y')
})

// ------------------------------------------------------ /new create arm --

test('createNew mints a fresh root session the binder owns', async () => {
  const reg = makeRegistry()
  const binder = new SessionBinder({ agents: reg.agents })
  const result = await binder.createNew('/Users/x/github')
  assert.equal(result.mode, 'created')
  assert.match(result.sessionId, /^[0-9a-f-]{36}$/) // a fresh UUID identity
  assert.equal(result.agent.session.id, result.sessionId)
  // The binder owns the handle — detach disposes it.
  const handle = reg.handles.find(h => String(h.agent.session.id) === result.sessionId)
  assert.ok(handle !== undefined)
  await binder.detach()
  assert.equal(binder.getSessionId(), undefined)
})

test('createNew forwards the inherited agent route into agents.create', async () => {
  const reg = makeRegistry()
  const binder = new SessionBinder({ agents: reg.agents })
  await binder.createNew('/tmp/work', { provider: 'zhipu', model: 'glm-4.7' })
  assert.deepEqual(reg.calls.createOptions.agentOptions, { provider: 'zhipu', model: 'glm-4.7' })
  // No route → no agentOptions key at all.
  await binder.createNew('/tmp/work')
  assert.equal(reg.calls.createOptions.agentOptions, undefined)
})

test('createNew inherits cwd into meta and keeps the previous handle alive', async () => {
  const reg = makeRegistry()
  const binder = new SessionBinder({ agents: reg.agents })
  const first = await binder.bind('old-1')
  assert.equal(first.mode, 'resumed')
  const created = await binder.createNew('/tmp/work')
  assert.equal(created.mode, 'created')
  assert.equal(binder.getSessionId(), created.sessionId)
  assert.equal(reg.calls.createMeta.cwd, '/tmp/work')
  // Handles stay live (adoptable) — nothing is ever disposed on rebind.
  assert.equal(reg.handles.filter(h => h.agent.disposed).length, 0)
})

// ---------------------------------------------------------------------------
// Cold-arm ownership refusal: the HOST's kernel write lease (0.1.5) refuses a
// cold resume of a session another process drives — the binder surfaces the
// error as-is and the bot degrades to a read-only watch. The registry double
// simulates the host refusal; no filesystem arbitration happens below.

function makeGuardContext({ headers = [], registry }) {
  return {
    agents: registry.agents,
    get(key) {
      if (key !== 'sessionPersistence') return undefined
      return { list: async () => headers }
    },
  }
}

test('cold resume surfaces the host ownership refusal; no handle is kept', async () => {
  const reg = makeRegistry()
  reg.agents.resume = async () => {
    throw new SessionAlreadyOwnedError('sess-owned')
  }
  const binder = new SessionBinder(makeGuardContext({ registry: reg }))
  await assert.rejects(() => binder.bind('sess-owned'), SessionAlreadyOwnedError)
  assert.equal(reg.handles.length, 0, 'a refused resume leaves no handle behind')
})

test('a refused resume does not strand the previous binding', async () => {
  const reg = makeRegistry()
  const binder = new SessionBinder(makeGuardContext({ registry: reg }))
  const first = await binder.bind('old-1')
  assert.equal(first.mode, 'resumed')
  reg.agents.resume = async () => {
    throw new SessionAlreadyOwnedError('sess-owned')
  }
  await assert.rejects(() => binder.bind('sess-owned'), SessionAlreadyOwnedError)
  // The previous binding still answers — the bot keeps driving it.
  assert.equal(binder.getSessionId(), 'old-1')
  assert.notEqual(binder.getAgent(), undefined)
})

// ---------------------------------------------------------------------------
// Read-only remote view: cold-refused sessions degrade to a persisted-log
// watcher on the phone side; decoder injected — no real disk below the env.

test('watchRemote backfills durable rows and detach clears the view', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-feishu-view-'))
  process.env.DSH_SESSION_ROOT = root
  try {
    const reg = makeRegistry()
    const log = [
      '{"type":"session","id":"sess-view"}',
      '{"type":"user/message","seq":0,"data":{}}',
      '{"type":"reasoning-chunks","seq0":1,"time0":1,"data":{"dt":[],"texts":["s"]}}',
      '{"type":"assistant/message","seq":2,"data":{}}',
      '{"type":"turn/end","seq":3,"data":{}}',
    ].join('\n')
    const binder = new SessionBinder(
      makeGuardContext({ headers: [{ id: 'sess-view', cwd: '/proj/v' }], registry: reg }),
      { viewerOptions: { intervalMs: 60_000, decode: async () => log } },
    )
    const seen = []
    await binder.watchRemote('sess-view', events => seen.push(...events.map(e => `${e.type}:${e.seq}`)))
    assert.deepEqual(seen, ['user/message:0', 'assistant/message:2', 'turn/end:3'],
      'streaming deltas and identity rows skipped; final reply present')
    assert.equal(binder.isReadOnlyView(), true)
    await binder.detach()
    assert.equal(binder.isReadOnlyView(), false)
  } finally {
    delete process.env.DSH_SESSION_ROOT
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Agent-preset composition (issue #2): a bare create/resume composes against
// the empty global layer — web/headless profiles load their tool plugins
// per-agent THROUGH the preset, so the agent publishes with only the `skill`
// tool. /new must join the default preset like the host's own creators do;
// a cold resume must rejoin the session's recorded preset. Every failure
// degrades to the bare composition (tui profiles resolve no presets and load
// tools globally — bare is correct there).

/** Fake factory-setup context: `installModelSelection` only needs `.on`. */
const fakeAgentCtx = { on: () => () => {} }

function makePresetsService({ defaultId = 'standard', failResolve = false, failMount = false } = {}) {
  const calls = { resolve: [], mount: [] }
  return {
    calls,
    async resolve(presetId) {
      calls.resolve.push(presetId)
      if (failResolve) throw new Error('no presets configured')
      return { id: presetId ?? defaultId }
    },
    async mount(agentCtx, presetId) {
      calls.mount.push({ agentCtx, presetId })
      if (failMount) throw new Error('preset exploded')
    },
  }
}

function makePresetContext({ registry, headers = [], presets, observation }) {
  return {
    agents: registry.agents,
    logger: { warnings: [], warn(...args) { this.warnings.push(args.join(' ')) } },
    get(key) {
      if (key === 'agentPresets') return presets
      if (key === 'sessionPersistence') return { list: async () => headers }
      if (key === 'sessionQuery') {
        return { observeSession: async () => observation ?? { projections: { values: {} } } }
      }
      return undefined
    },
  }
}

test('createNew joins the default preset: meta records it, setup mounts it', async () => {
  const reg = makeRegistry()
  const presets = makePresetsService({ defaultId: 'standard' })
  const binder = new SessionBinder(makePresetContext({ registry: reg, presets }))
  const result = await binder.createNew('/tmp/work')
  assert.equal(result.mode, 'created')
  // The DEFAULT preset (resolve called with no id), recorded in meta —
  // this is what keeps /resume and the projections consistent with
  // web-created sessions.
  assert.deepEqual(presets.calls.resolve, [undefined])
  assert.equal(reg.calls.createOptions.meta.agentPreset, 'standard')
  assert.equal(reg.calls.createOptions.meta.cwd, '/tmp/work')
  // The factory setup mounts the SAME preset id onto the agent context.
  await reg.calls.createOptions.setup(fakeAgentCtx)
  assert.deepEqual(presets.calls.mount, [{ agentCtx: fakeAgentCtx, presetId: 'standard' }])
})

test('createNew composes bare when the composition has no presets service (tui profile)', async () => {
  const reg = makeRegistry()
  // Plain {agents} context — no get(), no agentPresets: the tui shape.
  const binder = new SessionBinder({ agents: reg.agents })
  await binder.createNew('/tmp/work')
  assert.equal(reg.calls.createOptions.meta.agentPreset, undefined)
})

test('createNew degrades to bare when the default preset cannot resolve — and warns', async () => {
  const reg = makeRegistry()
  const presets = makePresetsService({ failResolve: true })
  const ctx = makePresetContext({ registry: reg, presets })
  const binder = new SessionBinder(ctx)
  // /new itself must survive: the agent publishes bare (host invariant
  // warning is the backstop), the phone-side flow never dies.
  const result = await binder.createNew('/tmp/work')
  assert.equal(result.mode, 'created')
  assert.equal(reg.calls.createOptions.meta.agentPreset, undefined)
  assert.ok(ctx.logger.warnings.some(w => w.includes('resolve failed')), 'resolve failure is logged')
})

test('preset mount failure degrades to bare — the create still succeeds', async () => {
  const reg = makeRegistry()
  const presets = makePresetsService({ failMount: true })
  const ctx = makePresetContext({ registry: reg, presets })
  const binder = new SessionBinder(ctx)
  const result = await binder.createNew('/tmp/work')
  assert.equal(result.mode, 'created')
  assert.equal(reg.calls.createOptions.meta.agentPreset, 'standard')
  await reg.calls.createOptions.setup(fakeAgentCtx)
  assert.equal(presets.calls.mount.length, 1)
  assert.ok(ctx.logger.warnings.some(w => w.includes('mount failed')), 'mount failure is logged')
})

test('cold resume rejoins the preset recorded in the session projection', async () => {
  const reg = makeRegistry()
  const presets = makePresetsService({ defaultId: 'standard' })
  const binder = new SessionBinder(makePresetContext({
    registry: reg,
    presets,
    // The durable record is the `agent-preset/selected` projection (the
    // presets service appends it on mount) — NOT the meta header.
    observation: { projections: { values: { agentPreset: 'standard' } } },
  }))
  // Fresh process: the session is not live — the cold arm runs.
  const result = await binder.bind('sess-preset')
  assert.equal(result.mode, 'resumed')
  await reg.calls.resumeRecords[0].setup(fakeAgentCtx)
  assert.deepEqual(presets.calls.mount, [{ agentCtx: fakeAgentCtx, presetId: 'standard' }])
})

test('cold resume of a preset-less session stays bare (no setup, no mount)', async () => {
  const reg = makeRegistry()
  const presets = makePresetsService()
  const binder = new SessionBinder(makePresetContext({
    registry: reg,
    presets,
    observation: { projections: { values: {} } },
  }))
  await binder.bind('sess-bare')
  assert.equal(reg.calls.resumeRecords[0].setup, undefined,
    'a session created before the fix has nothing to rejoin')
  assert.equal(presets.calls.mount.length, 0)
})

test('cold resume without a session query at all stays bare (tui profile)', async () => {
  const reg = makeRegistry()
  const binder = new SessionBinder({ agents: reg.agents })
  await binder.bind('sess-cold')
  assert.equal(reg.calls.resumeRecords[0].setup, undefined)
})
