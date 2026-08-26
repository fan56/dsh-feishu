import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyInbound, helpText,
  PASSTHROUGH_COMMANDS,
} from '../lib/commands.js'

test('plain text is a prompt (trimmed)', () => {
  assert.deepEqual(classifyInbound('  fix the bug  '), { kind: 'prompt', text: 'fix the bug' })
  assert.deepEqual(classifyInbound(''), { kind: 'prompt', text: '' })
})

test('bot-owned commands parse', () => {
  assert.deepEqual(classifyInbound('/resume'), { kind: 'resume' })
  assert.deepEqual(classifyInbound('/resume 3'), { kind: 'resume-pick', n: 3 })
  assert.deepEqual(classifyInbound('/resume abc'), { kind: 'resume' })
  assert.deepEqual(classifyInbound('/new'), { kind: 'new' })
  assert.deepEqual(classifyInbound('/status'), { kind: 'status' })
  assert.deepEqual(classifyInbound('/session'), { kind: 'status' }) // mirror of the TUI info panel
  assert.deepEqual(classifyInbound('/help'), { kind: 'help' })
  assert.deepEqual(classifyInbound('/stop'), { kind: 'stop' })
  assert.deepEqual(classifyInbound('/sub 2'), { kind: 'sub', n: 2 })
  assert.deepEqual(classifyInbound('/sub'), { kind: 'prompt', text: '/sub' })
  assert.deepEqual(classifyInbound('/feishu-plugin think on'), { kind: 'display', target: 'think', value: 'on' })
  assert.deepEqual(classifyInbound('/feishu-plugin think off'), { kind: 'display', target: 'think', value: 'off' })
  assert.deepEqual(classifyInbound('/feishu-plugin think maybe'), { kind: 'prompt', text: '/feishu-plugin think maybe' })
  // The old name no longer routes — unknown commands fall through as prompts.
  assert.deepEqual(classifyInbound('/display think on'), { kind: 'prompt', text: '/display think on' })
})

test('the passthrough table is deliberately empty (interactive desktop commands are not adapted)', () => {
  assert.deepEqual(PASSTHROUGH_COMMANDS, [])
  // The former entries now reject with the desktop pointer.
  for (const name of ['goal', 'dcp', 'export', 'agents', 'subagents']) {
    assert.deepEqual(classifyInbound(`/${name} extra args`), { kind: 'rejected', name })
  }
})

test('/model is now bot-owned; config-class and deferred commands are rejected', () => {
  assert.deepEqual(classifyInbound('/model'), { kind: 'model' })
  for (const name of ['settings', 'preset', 'theme', 'reload', 'hotkeys', 'model-sync', 'think', 'skills']) {
    assert.deepEqual(classifyInbound(`/${name}`), { kind: 'rejected', name })
  }
})

test('unknown slash commands fall through as prompts', () => {
  assert.deepEqual(classifyInbound('/totally-unknown'), { kind: 'prompt', text: '/totally-unknown' })
  assert.deepEqual(classifyInbound('not/a/command'), { kind: 'prompt', text: 'not/a/command' })
})

test('help text adapts to the binding state', () => {
  const bound = helpText(true)
  const unbound = helpText(false)
  assert.match(bound, /当前已绑定会话/)
  assert.match(unbound, /当前未绑定会话/)
  for (const text of [bound, unbound]) {
    assert.match(text, /\/resume/)
    assert.match(text, /\/stop/)
    assert.match(text, /\/feishu-plugin think/)
  }
})
