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
  assert.equal(message.text, ' hello ')
})

test('non-text messages parse with text undefined', () => {
  const message = parseReceiveEvent(payload({ message_type: 'image', content: '{}' }))
  assert.equal(message.messageType, 'image')
  assert.equal(message.text, undefined)
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
