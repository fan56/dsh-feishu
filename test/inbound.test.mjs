import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseReceiveEvent } from '../lib/inbound.js'

function payload(overrides = {}) {
  return {
    sender: { sender_id: { open_id: 'ou_op' }, sender_type: 'user' },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: ' hello ' }),
      ...overrides,
    },
  }
}

test('parses a p2p text message', () => {
  const message = parseReceiveEvent(payload())
  assert.equal(message.openId, 'ou_op')
  assert.equal(message.chatId, 'oc_1')
  assert.equal(message.chatType, 'p2p')
  assert.equal(message.messageId, 'om_1')
  // Text is trimmed at parse (mention stripping requires it anyway); the
  // prompt channel always sent trimmed text, so p2p semantics are unchanged.
  assert.equal(message.text, 'hello')
})

test('non-text messages parse with text undefined', () => {
  const message = parseReceiveEvent(payload({ message_type: 'image', content: '{}' }))
  assert.equal(message.messageType, 'image')
  assert.equal(message.text, undefined)
})

test('image messages parse their image_key', () => {
  const message = parseReceiveEvent(payload({
    message_type: 'image',
    content: JSON.stringify({ image_key: 'img_v2_abc' }),
  }))
  assert.equal(message.imageKey, 'img_v2_abc')
  assert.equal(message.text, undefined)
})

test('image messages without a usable key degrade to undefined', () => {
  assert.equal(parseReceiveEvent(payload({ message_type: 'image', content: '{}' })).imageKey, undefined)
  assert.equal(parseReceiveEvent(payload({ message_type: 'image', content: 'not-json' })).imageKey, undefined)
})

test('group text strips mention placeholders and collects mention ids', () => {
  const message = parseReceiveEvent(payload({
    chat_type: 'group',
    content: JSON.stringify({ text: '@_user_1 帮我跑一下测试' }),
    mentions: [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'dsh' },
      { key: '@_user_2', id: { open_id: 'ou_peer' }, name: 'peer' },
    ],
  }))
  assert.equal(message.text, '帮我跑一下测试')
  assert.deepEqual(message.mentions.map(m => m.openId), ['ou_bot', 'ou_peer'])
})

test('group mention ids arrive as bare strings too (older payloads)', () => {
  const message = parseReceiveEvent(payload({
    chat_type: 'group',
    content: JSON.stringify({ text: '@_user_1 hi' }),
    mentions: [{ key: '@_user_1', id: 'ou_bot' }],
  }))
  assert.deepEqual(message.mentions.map(m => m.openId), ['ou_bot'])
  assert.equal(message.text, 'hi')
})

test('p2p messages carry no mentions', () => {
  const message = parseReceiveEvent(payload())
  assert.deepEqual(message.mentions, [])
})

test('malformed JSON content degrades to the raw string', () => {
  const message = parseReceiveEvent(payload({ content: 'plain' }))
  assert.equal(message.text, 'plain')
})

test('missing sender/chat/message-id yields undefined', () => {
  assert.equal(parseReceiveEvent(null), undefined)
  assert.equal(parseReceiveEvent({}), undefined)
  assert.equal(parseReceiveEvent(payload({ chat_id: '' })), undefined)
  assert.equal(
    parseReceiveEvent({ sender: { sender_id: {} }, message: { message_id: 'om_1', chat_id: 'oc_1' } }),
    undefined,
  )
})
