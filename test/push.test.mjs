import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldPushEvent, initialPushTrack, pushCauseLabel, shouldPush } from '../lib/push.js'

function event(type, data, time, seq) {
  return { type, data, time, seq }
}

test('off pushes nothing; cron pushes only cron/subagent causes; all pushes everything', () => {
  assert.equal(shouldPush('off', 'cron'), false)
  assert.equal(shouldPush('off', 'turn'), false)
  assert.equal(shouldPush('cron', 'cron'), true)
  assert.equal(shouldPush('cron', 'subagent-settled'), true)
  assert.equal(shouldPush('cron', 'turn'), false)
  assert.equal(shouldPush('all', 'turn'), true)
})

test('a cron fire inside a turn surfaces as the cron cause at turn/end', () => {
  const track = initialPushTrack()
  assert.equal(foldPushEvent(track, event('turn/start', { turn: 1 }, 1000, 1)), undefined)
  assert.equal(foldPushEvent(track, event('user/message', {
    content: [{ type: 'text', text: '[CRON FIRE] …' }],
    source: { kind: 'plugin', plugin: 'cron' },
    id: 'um_1',
  }, 1100, 2)), undefined)
  assert.equal(track.cronSeen, true)
  assert.equal(track.turnStartedAt, 1000)
  assert.equal(foldPushEvent(track, event('assistant/message', { message: { content: [{ type: 'text', text: '备份完成' }] } }, 2000, 3)), undefined)
  assert.equal(foldPushEvent(track, event('turn/end', { reason: { kind: 'completed' } }, 2500, 4)), 'cron')
  assert.equal(track.endReason, 'completed')
})

test('a subagent-settled notice surfaces as its own cause', () => {
  const track = initialPushTrack()
  foldPushEvent(track, event('turn/start', { turn: 1 }, 1000, 1))
  foldPushEvent(track, event('user/message', {
    content: [{ type: 'text', text: 'child finished' }],
    source: { kind: 'subagent-settled', form: 'notice', summary: 'x', senderSessionId: 's2' },
    id: 'um_2',
  }, 1100, 2))
  assert.equal(foldPushEvent(track, event('turn/end', { reason: { kind: 'completed' } }, 1500, 3)), 'subagent-settled')
})

test('a plain turn surfaces as the generic turn cause (only "all" pushes it)', () => {
  const track = initialPushTrack()
  foldPushEvent(track, event('turn/start', { turn: 1 }, 1000, 1))
  foldPushEvent(track, event('user/message', {
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
    id: 'um_3',
  }, 1050, 2))
  assert.equal(foldPushEvent(track, event('turn/end', { reason: { kind: 'completed' } }, 1400, 3)), 'turn')
})

test('each turn/start resets the previous turn flags', () => {
  const track = initialPushTrack()
  foldPushEvent(track, event('turn/start', { turn: 1 }, 1000, 1))
  foldPushEvent(track, event('user/message', { source: { kind: 'plugin', plugin: 'cron' }, id: 'a' }, 1100, 2))
  foldPushEvent(track, event('turn/end', { reason: { kind: 'completed' } }, 1200, 3))
  foldPushEvent(track, event('turn/start', { turn: 2 }, 2000, 4))
  assert.equal(track.cronSeen, false)
  assert.equal(track.subagentSettled, false)
  assert.equal(track.lastAssistant, undefined)
  assert.equal(track.turnStartedAt, 2000)
})

test('malformed payloads are no-ops, never throws', () => {
  const track = initialPushTrack()
  assert.equal(foldPushEvent(track, event('user/message', null, 1, 1)), undefined)
  assert.equal(foldPushEvent(track, event('assistant/message', { message: { content: 'weird' } }, 2, 2)), undefined)
  assert.equal(foldPushEvent(track, event('turn/end', {}, 3, 3)), 'turn')
  assert.equal(track.endReason, undefined)
})

test('cause labels are stable strings for the push card', () => {
  assert.equal(pushCauseLabel('cron'), '⏰ 定时任务')
  assert.equal(pushCauseLabel('subagent-settled'), '🧵 子代理完成')
  assert.equal(pushCauseLabel('turn'), '🖥️ 桌面回合完成')
})
