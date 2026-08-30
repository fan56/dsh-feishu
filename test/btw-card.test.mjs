/**
 * btw card builders (src/btw-card.ts → lib/btw-card.js) — pure JSON in/out:
 * header template per run status, question quote-folding, the answer tail
 * window, and the footer note. No Lark, no terminal.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBtwCard, btwAnswerTail } from '../lib/btw-card.js'

const run = overrides => ({
  question: '这个报错是什么意思？',
  modelLabel: 'glm/glm-4.6',
  status: 'streaming',
  answerText: '',
  ...overrides,
})

test('streaming with no answer: blue thinking card', () => {
  const card = buildBtwCard(run(), 0)
  assert.equal(card.header.template, 'blue')
  assert.equal(card.header.title.content, '⌘ btw · 思考中')
  assert.equal(card.header.subtitle.content, 'dsh · glm/glm-4.6')
  const body = card.body.elements[0].content
  assert.match(body, /旁路调用运行中/)
  assert.match(body, /这个报错是什么意思/)
})

test('streaming with a partial answer shows the growing text', () => {
  const card = buildBtwCard(run({ answerText: '这是类型错误' }), 0)
  assert.equal(card.header.title.content, '⌘ btw · 回答中')
  assert.match(card.body.elements[0].content, /这是类型错误/)
})

test('done: green card with the full answer and the not-persisted footer', () => {
  const card = buildBtwCard(run({ status: 'done', answerText: '答案是 42' }), 0)
  assert.equal(card.header.template, 'green')
  assert.equal(card.header.title.content, '✅ btw')
  const body = card.body.elements[0].content
  assert.match(body, /答案是 42/)
  assert.match(body, /不进会话记录/)
})

test('error: red card carries the failure line', () => {
  const card = buildBtwCard(run({ status: 'error', error: 'socket died' }), 0)
  assert.equal(card.header.template, 'red')
  assert.equal(card.header.title.content, '❌ btw 失败')
  assert.match(card.body.elements[0].content, /✘ socket died/)
})

test('canceled: grey card', () => {
  const card = buildBtwCard(run({ status: 'canceled' }), 0)
  assert.equal(card.header.template, 'grey')
  assert.equal(card.header.title.content, '⛔ btw 已取消')
})

test('empty settled answer renders the explicit no-text placeholder', () => {
  const body = buildBtwCard(run({ status: 'done', answerText: '' }), 0).body.elements[0].content
  assert.match(body, /（无回答文本）/)
})

test('queued count rides the footer', () => {
  const streaming = buildBtwCard(run(), 2).body.elements[0].content
  assert.match(streaming, /排队 2/)
  const done = buildBtwCard(run({ status: 'done', answerText: 'x' }), 2).body.elements[0].content
  assert.match(done, /排队 2/)
  assert.ok(!/排队 2/.test(buildBtwCard(run(), 0).body.elements[0].content))
})

test('multi-line questions fold into one blockquote', () => {
  const body = buildBtwCard(run({ question: '第一行\n第二行' }), 0).body.elements[0].content
  assert.match(body, /> 第一行\n> 第二行/)
})

test('answer tail: long answers keep the tail and name the hidden prefix', () => {
  const long = 'a'.repeat(1300) + 'END'
  const tail = btwAnswerTail(long)
  assert.match(tail, /^…（前文 \d+ 字）/)
  assert.ok(tail.endsWith('END'))
  assert.ok(tail.length < long.length)
  // Short answers pass through untouched.
  assert.equal(btwAnswerTail('short'), 'short')
})
