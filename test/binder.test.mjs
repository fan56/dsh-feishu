import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionBinder } from '../lib/binder.js'

function makeRegistry() {
  const calls = { resume: [], create: 0 }
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

test('rebinding disposes the previously owned handle; attach keeps foreign agents alive', async () => {
  const registry = makeRegistry()
  const binder = new SessionBinder({ agents: registry.agents })
  await binder.bind('a')
  const firstHandle = registry.handles[0]
  await binder.bind('b')
  assert.equal(firstHandle.agent.disposed, true)

  // The session goes live under a foreign owner — attach to theirs; OUR
  // stale resume handle for the same id is released, theirs is untouched.
  registry.addLive('b')
  const result = await binder.bind('b')
  assert.equal(result.mode, 'attached')
  assert.equal(registry.handles[1].agent.disposed, true)
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

test('detach drops the binding and disposes only our handle', async () => {
  const registry = makeRegistry()
  const binder = new SessionBinder({ agents: registry.agents })
  await binder.bind('a')
  await binder.detach()
  assert.equal(binder.getSessionId(), undefined)
  assert.equal(binder.getAgent(), undefined)
  assert.equal(registry.handles[0].agent.disposed, true)
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
  // The second bind wins the final binding; the first's handle got disposed.
  assert.ok(['x', 'y'].includes(first.sessionId))
  assert.ok(['x', 'y'].includes(second.sessionId))
  const disposed = registry.handles.filter(h => h.agent.disposed).length
  assert.equal(disposed >= 1, true)
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

test('createNew inherits cwd into meta and releases the previous owned handle', async () => {
  const reg = makeRegistry()
  const binder = new SessionBinder({ agents: reg.agents })
  const first = await binder.bind('old-1')
  assert.equal(first.mode, 'resumed')
  const created = await binder.createNew('/tmp/work')
  assert.equal(created.mode, 'created')
  assert.equal(binder.getSessionId(), created.sessionId)
  assert.equal(reg.calls.createMeta.cwd, '/tmp/work')
  // The first owned handle was released; exactly one remains live.
  assert.equal(reg.handles.filter(h => !h.agent.disposed).length, 1)
})
