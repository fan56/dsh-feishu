import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FeishuBot } from '../lib/bot.js'
import {
  runPermissionCommand,
  runProfileSwitchCommand,
  runSelectSkillCommand,
  runThinkCommand,
} from '../lib/interactive.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

/** Bounded wait for a condition — fs-backed adapters race a bare tick. */
async function waitFor(condition, ms = 2000) {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) return false
    await tick()
  }
  return true
}

/**
 * Minimal FeishuBot with faked deps — the same convention as the /model
 * tests — plus direct access to the interactive host so adapters run against
 * the REAL apply/inject/current-selection cores.
 */
function interactiveBot({
  bound = 's1',
  unbound = false,
  selectionRef,
  agent,
  llm,
  presets,
  skills,
  commands,
  readOnly = false,
} = {}) {
  const sends = []
  const patches = []
  const boundId = unbound ? undefined : bound
  const state = { lastChatId: 'oc_test', displayThink: true, boundSessionId: boundId, picker: undefined, phoneModel: undefined }
  const agentRef = agent ?? {
    status: 'idle',
    steer() {},
    followup() {},
    session: { header: { cwd: '/w' } },
  }
  const bot = new FeishuBot({
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      get: key => (key === 'llm' ? llm
        : key === 'permissionPresets' ? presets
        : key === 'skills' ? skills
        : key === 'commands' ? commands
        : undefined),
    },
    config: { statusIntervalMs: 30000, bodySegmentChars: 3500 },
    lark: {
      async sendCard(_c, card) { sends.push(card); return `m${sends.length}` },
      async patchCard(id, card) { patches.push({ id, card }); return true },
      async react() {},
      async sendText() { return undefined },
      start: async () => {},
      close() {},
    },
    binder: {
      getSessionId: () => boundId,
      getAgent: () => agentRef,
      isReadOnlyView: () => readOnly,
    },
    store: { ready: async () => {}, get: () => state, async update(p) { Object.assign(state, p) } },
    allowlist: new Set(['ou_op']),
    now: () => 1000,
  })
  if (selectionRef !== undefined) bot.selectionRefs.set(boundId, selectionRef)
  return { bot, sends, patches, state, agentRef }
}

/** The selector flow id of a just-sent selector card (buttons or select). */
function flowIdOf(card) {
  for (const element of card.body.elements) {
    if (element.tag === 'button' && typeof element.value?.flow_id === 'string') return element.value.flow_id
    if (element.tag === 'form') {
      for (const inner of element.elements) {
        if (inner.tag === 'button' && typeof inner.value?.flow_id === 'string') return inner.value.flow_id
      }
    }
  }
  return undefined
}

/** Submit an operator pick on a pending selector flow. */
function pick(bot, flowId, value) {
  bot.onCardAction({
    operator: { open_id: 'ou_op' },
    action: { tag: 'button', value: { action: 'dsh_feishu_sel', flow_id: flowId, ...(value === undefined ? {} : { pick: value }) } },
  })
}

const EFFORTS = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low', description: 'fast' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
]

// -------------------------------------------------------------- /think --

test('/think lists the model adapter efforts with the default row first (buttons)', async () => {
  const resolveArgs = []
  const { bot, sends } = interactiveBot({
    llm: { async resolveModelInfo(provider, model) { resolveArgs.push([provider, model]); return { reasoning: { efforts: EFFORTS } } } },
  })
  bot.runState.provider = 'zhipu'
  bot.runState.model = 'glm-4.7'
  bot.runState.reasoningEffort = 'medium'

  const run = runThinkCommand(bot.host)
  await waitFor(() => sends.length > 0)

  assert.deepEqual(resolveArgs, [['zhipu', 'glm-4.7']])
  assert.equal(sends.length, 1)
  assert.equal(sends[0].header.title.content, '思考档位')
  assert.match(JSON.stringify(sends[0]), /当前 medium/)
  const buttons = sends[0].body.elements.filter(e => e.tag === 'button' && typeof e.value?.pick === 'string')
  assert.deepEqual(buttons.map(b => b.value.pick), ['default', 'off', 'low', 'medium', 'high'])
  assert.equal(buttons[0].text.content, '默认')

  pick(bot, flowIdOf(sends[0])) // cancel — the card assertions above are the point
  await run
})

test('/think picked effort applies to the live selection ref', async () => {
  const ref = { current: { provider: 'zhipu', model: 'glm-4.6' }, assembled: undefined }
  const { bot, sends, patches } = interactiveBot({
    selectionRef: ref,
    llm: { async resolveModelInfo() { return { reasoning: { efforts: EFFORTS } } } },
  })

  const run = runThinkCommand(bot.host)
  await waitFor(() => sends.length > 0)
  pick(bot, flowIdOf(sends[0]), 'high')
  await run
  await tick()

  assert.deepEqual(ref.current, { provider: 'zhipu', model: 'glm-4.6', reasoningEffort: 'high' })
  assert.equal(patches.at(-1).card.header.template, 'green')
  assert.match(JSON.stringify(sends.at(-1)), /思考档位：High/)
  assert.match(JSON.stringify(sends.at(-1)), /zhipu \/ glm-4\.6/)
})

test('/think picked default clears the effort override on the live ref', async () => {
  const ref = { current: { provider: 'zhipu', model: 'glm-4.6', reasoningEffort: 'high' }, assembled: undefined }
  const { bot, sends } = interactiveBot({
    selectionRef: ref,
    llm: { async resolveModelInfo() { return { reasoning: { efforts: EFFORTS } } } },
  })

  const run = runThinkCommand(bot.host)
  await waitFor(() => sends.length > 0)
  pick(bot, flowIdOf(sends[0]), 'default')
  await run

  assert.deepEqual(ref.current, { provider: 'zhipu', model: 'glm-4.6' })
  assert.equal('reasoningEffort' in ref.current, false)
})

test('/think on a desktop-driven session stores the phone default (effort kept)', async () => {
  const { bot, sends, state } = interactiveBot({
    llm: { async resolveModelInfo() { return { reasoning: { efforts: EFFORTS } } } },
  })
  bot.runState.provider = 'zhipu'
  bot.runState.model = 'glm-4.7'

  const run = runThinkCommand(bot.host)
  await waitFor(() => sends.length > 0)
  pick(bot, flowIdOf(sends[0]), 'low')
  await run

  assert.deepEqual(state.phoneModel, { provider: 'zhipu', model: 'glm-4.7', reasoningEffort: 'low' })
  assert.match(JSON.stringify(sends.at(-1)), /桌面驱动/)
})

test('/think without a known model selection asks for /model first', async () => {
  const { bot, sends } = interactiveBot({})
  await runThinkCommand(bot.host)
  assert.equal(sends.length, 1)
  assert.match(JSON.stringify(sends[0]), /先用 \/model 选择模型/)
})

test('/think with a model exposing no efforts answers with a pointer', async () => {
  const { bot, sends } = interactiveBot({
    llm: { async resolveModelInfo() { return { reasoning: undefined } } },
  })
  bot.runState.provider = 'zhipu'
  bot.runState.model = 'glm-4.7'
  await runThinkCommand(bot.host)
  assert.match(JSON.stringify(sends[0]), /没有可选的推理档位/)
})

test('/think without a binding answers with the unbound pointer', async () => {
  const { bot, sends } = interactiveBot({ unbound: true })
  await runThinkCommand(bot.host)
  assert.match(JSON.stringify(sends[0]), /尚未绑定会话/)
})

// ---------------------------------------------------------- /permission --

const presetService = {
  names: ['default', 'plan', 'danger-full-access'],
  optionOf(name) {
    return {
      value: name,
      name: name === 'danger-full-access' ? 'Full access' : name,
      description: 'sandbox: on · approval: ask',
    }
  },
}

test('/permission lists presets as buttons; the pick is replayed through /permission <name>', async () => {
  const executed = []
  const { bot, sends } = interactiveBot({
    presets: presetService,
    commands: {
      find: () => ({}),
      execute(...args) { executed.push(args); return Promise.resolve({ result: { kind: 'success', text: 'preset switched' } }) },
    },
  })

  const run = runPermissionCommand(bot.host)
  await waitFor(() => sends.length > 0)
  const flowId = flowIdOf(sends[0])
  assert.equal(sends[0].header.title.content, '权限 Preset')
  const buttons = sends[0].body.elements.filter(e => e.tag === 'button' && typeof e.value?.pick === 'string')
  assert.deepEqual(buttons.map(b => b.value.pick), ['default', 'plan', 'danger-full-access'])
  assert.equal(buttons[2].text.content, 'Full access')
  pick(bot, flowId, 'plan')
  await run
  await tick()

  assert.equal(executed.length, 1)
  assert.equal(executed[0][1], '/permission plan') // the canonical line, executed on the bound agent
  assert.match(JSON.stringify(sends.at(-1)), /preset switched/)
})

test('/permission without the preset service answers with a pointer', async () => {
  const { bot, sends } = interactiveBot({})
  await runPermissionCommand(bot.host)
  assert.match(JSON.stringify(sends[0]), /没有权限 preset 服务/)
})

test('/permission with an empty preset table answers with a pointer', async () => {
  const { bot, sends } = interactiveBot({ presets: { names: [], optionOf: () => ({ value: '', name: '' }) } })
  await runPermissionCommand(bot.host)
  assert.match(JSON.stringify(sends[0]), /没有可用的权限 preset/)
})

// -------------------------------------------------------- /select-skill --

function recordingAgent(status = 'idle') {
  const record = { steered: [], followups: [] }
  const agent = {
    status,
    steer(message) { record.steered.push(message) },
    followup(message) { record.followups.push(message) },
    session: { header: { cwd: '/repo' } },
  }
  return { agent, record }
}

test('/select-skill filters user-invocable skills, sorts by name, passes agent scope + header cwd', async () => {
  const listArgs = []
  const { agent, record } = recordingAgent()
  const { bot, sends } = interactiveBot({
    agent,
    skills: {
      async list(options) {
        listArgs.push(options)
        return [
          { name: 'zzz', description: 'last', invocation: { modelInvocable: true, userInvocable: true } },
          { name: 'aaa', description: 'first', invocation: { modelInvocable: false, userInvocable: true } },
          { name: 'model-only', description: 'no', invocation: { modelInvocable: true, userInvocable: false } },
          { name: 'no-policy', description: 'invocation missing' },
        ]
      },
    },
  })

  const run = runSelectSkillCommand(bot.host)
  await waitFor(() => sends.length > 0)

  assert.equal(listArgs.length, 1)
  assert.equal(listArgs[0].cwd, '/repo')
  assert.equal(listArgs[0].scope, agent)
  // Dropdown (select mode) with the two user-invocable skills, name-sorted.
  const form = sends[0].body.elements.find(e => e.tag === 'form')
  const select = form.elements.find(e => e.tag === 'select_static')
  assert.deepEqual(select.options.map(o => o.value), ['aaa', 'zzz'])
  assert.match(select.options[0].text.content, /first/)

  pick(bot, flowIdOf(sends[0]), 'aaa')
  await run

  assert.equal(record.followups.length, 1)
  assert.equal(record.followups[0].content[0].text, '/aaa')
  assert.equal(record.followups[0].source.kind, 'user') // the harness's skill gesture
  assert.match(JSON.stringify(sends.at(-1)), /已注入技能 \/aaa/)
})

test('/select-skill steers into a running turn', async () => {
  const { agent, record } = recordingAgent('running')
  const { bot, sends } = interactiveBot({
    agent,
    skills: { async list() { return [{ name: 'fix', description: 'd', invocation: { modelInvocable: true, userInvocable: true } }] } },
  })
  const run = runSelectSkillCommand(bot.host)
  await waitFor(() => sends.length > 0)
  pick(bot, flowIdOf(sends[0]), 'fix')
  await run

  assert.equal(record.steered.length, 1)
  assert.equal(record.steered[0].content[0].text, '/fix')
  assert.equal(record.followups.length, 0)
})

test('/select-skill notes the total when the list is truncated at 50', async () => {
  const many = Array.from({ length: 55 }, (_, i) => ({
    name: `skill-${String(i).padStart(2, '0')}`,
    description: 'd',
    invocation: { modelInvocable: true, userInvocable: true },
  }))
  const { bot, sends } = interactiveBot({ skills: { async list() { return many } } })
  const run = runSelectSkillCommand(bot.host)
  await waitFor(() => sends.length > 0)

  assert.match(JSON.stringify(sends[0]), /共 55 个技能，仅显示前 50 个/)
  const form = sends[0].body.elements.find(e => e.tag === 'form')
  const select = form.elements.find(e => e.tag === 'select_static')
  assert.equal(select.options.length, 50)

  pick(bot, flowIdOf(sends[0])) // cancel
  await run
})

test('/select-skill degraded paths: unbound, no service, empty list', async () => {
  const unbound = interactiveBot({ unbound: true })
  await runSelectSkillCommand(unbound.bot.host)
  assert.match(JSON.stringify(unbound.sends[0]), /尚未绑定会话/)

  const noService = interactiveBot({})
  await runSelectSkillCommand(noService.bot.host)
  assert.match(JSON.stringify(noService.sends[0]), /没有 skills 服务/)

  const empty = interactiveBot({ skills: { async list() { return [{ name: 'x', invocation: { userInvocable: false } }] } } })
  await runSelectSkillCommand(empty.bot.host)
  assert.match(JSON.stringify(empty.sends[0]), /没有可供调用的技能/)
})

// ------------------------------------------------------ /profile-switch --

async function withProfilesDoc(doc) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-profiles-'))
  const path = join(dir, 'model-profiles.json')
  await writeFile(path, JSON.stringify(doc))
  return { dir, path }
}

const PROFILES_DOC = {
  version: 1,
  current: 'work',
  profiles: [
    { name: 'work', defaultModel: { provider: 'zhipu', model: 'glm-4.7', reasoningEffort: 'high' }, agents: {} },
    { name: 'personal', agents: {} }, // no default route → not offerable
  ],
}

test('/profile-switch lists routable profiles with their route summary; pick applies to the live ref', async () => {
  const ref = { current: { provider: 'zhipu', model: 'glm-4.6' }, assembled: undefined }
  const { bot, sends, patches } = interactiveBot({ selectionRef: ref })
  const { dir, path } = await withProfilesDoc(PROFILES_DOC)
  try {
    const run = runProfileSwitchCommand(bot.host, path)
    await waitFor(() => sends.length > 0)
    const card = sends[0]
    assert.equal(card.header.title.content, '切换模型 Profile')
    assert.match(JSON.stringify(card), /当前：work/)
    const form = card.body.elements.find(e => e.tag === 'form')
    const select = form.elements.find(e => e.tag === 'select_static')
    assert.deepEqual(select.options.map(o => o.value), ['work'])
    assert.match(select.options[0].text.content, /zhipu \/ glm-4\.7 · effort high/)

    pick(bot, flowIdOf(card), 'work')
    await run
    await tick()

    assert.deepEqual(ref.current, { provider: 'zhipu', model: 'glm-4.7', reasoningEffort: 'high' })
    assert.equal(patches.at(-1).card.header.template, 'green')
    assert.match(JSON.stringify(sends.at(-1)), /已应用 profile「work」/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('/profile-switch pick lands in the phone default when no live ref exists', async () => {
  const { bot, sends, state } = interactiveBot({})
  const { dir, path } = await withProfilesDoc(PROFILES_DOC)
  try {
    const run = runProfileSwitchCommand(bot.host, path)
    await waitFor(() => sends.length > 0)
    pick(bot, flowIdOf(sends[0]), 'work')
    await run
    assert.deepEqual(state.phoneModel, { provider: 'zhipu', model: 'glm-4.7', reasoningEffort: 'high' })
    assert.match(JSON.stringify(sends.at(-1)), /桌面驱动/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('/profile-switch with a missing file answers with a pointer', async () => {
  const { bot, sends } = interactiveBot({})
  await runProfileSwitchCommand(bot.host, join(tmpdir(), 'dsh-feishu-no-such-dir', 'model-profiles.json'))
  assert.match(JSON.stringify(sends[0]), /不存在或不可读/)
})

test('/profile-switch without any configured route answers with a pointer', async () => {
  const { bot, sends } = interactiveBot({})
  const { dir, path } = await withProfilesDoc({ version: 1, profiles: [{ name: 'empty', agents: {} }] })
  try {
    await runProfileSwitchCommand(bot.host, path)
    assert.match(JSON.stringify(sends[0]), /没有配置默认模型/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------ dispatch --

test('inbound /think reaches the adapter through the dispatch switch', async () => {
  const { bot, sends } = interactiveBot({
    llm: { async resolveModelInfo() { return { reasoning: { efforts: EFFORTS } } } },
  })
  bot.runState.provider = 'zhipu'
  bot.runState.model = 'glm-4.7'
  const dispatch = bot.process({ openId: 'ou_op', chatId: 'oc_test', chatType: 'p2p', messageId: 'om1', messageType: 'text', text: '/think' })
  await waitFor(() => sends.length > 0)
  assert.equal(sends[0].header.title.content, '思考档位')
  pick(bot, flowIdOf(sends[0])) // cancel
  await dispatch
})

test('inbound /preset (unsupported) still answers with the desktop pointer', async () => {
  const { bot, sends } = interactiveBot({})
  await bot.process({ openId: 'ou_op', chatId: 'oc_test', chatType: 'p2p', messageId: 'om1', messageType: 'text', text: '/preset' })
  assert.match(JSON.stringify(sends[0]), /电脑端/)
})
