import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyInbound, helpText, refusedReply,
  PASSTHROUGH_COMMANDS, TUI_PI_COMMANDS, UNADAPTED_COMMANDS,
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
  for (const name of ['settings', 'preset', 'theme', 'reload', 'hotkeys', 'model-sync', 'skills']) {
    assert.deepEqual(classifyInbound(`/${name}`), { kind: 'rejected', name })
  }
})

test('every dsh-tui-pi command rejects instead of falling through as a prompt', () => {
  for (const name of TUI_PI_COMMANDS) {
    assert.deepEqual(classifyInbound(`/${name}`), { kind: 'rejected', name })
    assert.match(refusedReply(name), /dsh-tui-pi/)
  }
  // /login used to leak to the model as a prompt — pinned so it never returns.
  assert.match(refusedReply('login'), /电脑端/)
  // /session is adapted as an alias of /status, not refused.
  assert.deepEqual(classifyInbound('/session'), { kind: 'status' })
})

test('unadapted runtime commands refuse without claiming dsh-tui-pi ownership', () => {
  for (const name of UNADAPTED_COMMANDS) {
    assert.deepEqual(classifyInbound(`/${name}`), { kind: 'rejected', name })
    const reply = refusedReply(name)
    assert.match(reply, /电脑端/)
    assert.doesNotMatch(reply, /dsh-tui-pi/)
  }
})

test('refused dsh-tui-pi commands with a phone stand-in carry the hint', () => {
  assert.match(refusedReply('skills'), /\/select-skill/)
  assert.match(refusedReply('profile-cfg'), /\/profile-switch/)
  assert.doesNotMatch(refusedReply('theme'), /提示/) // no stand-in → no hint
})

test('interactive adapter commands route to their own intents', () => {
  assert.deepEqual(classifyInbound('/think'), { kind: 'think' })
  assert.deepEqual(classifyInbound('/think high'), { kind: 'think' }) // args ignored, like /model
  assert.deepEqual(classifyInbound('/select-skill'), { kind: 'select-skill' })
  assert.deepEqual(classifyInbound('/select-skill foo'), { kind: 'select-skill' })
  assert.deepEqual(classifyInbound('/profile-switch'), { kind: 'profile-switch' })
  assert.deepEqual(classifyInbound('/profile-switch work'), { kind: 'profile-switch' })
  // Bare /permission opens the picker; the explicit form rides passthrough.
  assert.deepEqual(classifyInbound('/permission'), { kind: 'permission' })
  assert.deepEqual(classifyInbound('/permission   '), { kind: 'permission' })
  assert.deepEqual(classifyInbound('/permission plan'), { kind: 'passthrough', name: 'permission', line: '/permission plan' })
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
    assert.match(text, /\/resume N/)
    assert.match(text, /\/new/)
    assert.match(text, /\/status/)
    assert.match(text, /\/stop/)
    assert.match(text, /\/sub N/)
    assert.match(text, /\/model/)
    assert.match(text, /\/feishu-plugin think/)
    assert.match(text, /\/think/)
    assert.match(text, /\/permission/)
    assert.match(text, /\/select-skill/)
    assert.match(text, /\/profile-switch/)
    assert.match(text, /\/help/)
    // group headers render as markdown bold
    assert.match(text, /\*\*会话\*\*/)
    assert.match(text, /\*\*模型与权限\*\*/)
    assert.match(text, /\*\*技能\*\*/)
  }
})

test('btw parses with and without a question', () => {
  assert.deepEqual(classifyInbound('/btw 这个报错是什么'), { kind: 'btw', line: '这个报错是什么' })
  assert.deepEqual(classifyInbound('/btw'), { kind: 'btw', line: '' })
  assert.deepEqual(classifyInbound('/btw   '), { kind: 'btw', line: '' })
  // multi-line questions ride the /s flag on COMMAND_RE
  assert.deepEqual(classifyInbound('/btw 第一行\n第二行'), { kind: 'btw', line: '第一行\n第二行' })
})

test('help text mentions /btw', () => {
  const text = helpText(true)
  assert.match(text, /\/btw/)
})
