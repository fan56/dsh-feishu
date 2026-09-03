import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageExtensionOf, sniffImageMediaType } from '../lib/image.js'

test('PNG magic bytes sniff as image/png', () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
  assert.equal(sniffImageMediaType(bytes), 'image/png')
})

test('JPEG magic bytes sniff as image/jpeg (third byte varies)', () => {
  assert.equal(sniffImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xdb])), 'image/jpeg')
})

test('GIF87a/89a magic bytes sniff as image/gif', () => {
  assert.equal(sniffImageMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])), 'image/gif')
  assert.equal(sniffImageMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif')
})

test('WEBP (RIFF…WEBP) magic bytes sniff as image/webp', () => {
  const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])
  assert.equal(sniffImageMediaType(bytes), 'image/webp')
})

test('unaccepted or truncated payloads yield undefined', () => {
  assert.equal(sniffImageMediaType(new Uint8Array([0x42, 0x4d])), undefined) // BMP
  assert.equal(sniffImageMediaType(new Uint8Array([0x89, 0x50]), ), undefined) // truncated PNG
  assert.equal(sniffImageMediaType(new Uint8Array(0)), undefined)
})

test('extensions map one-to-one to the accepted media types', () => {
  assert.equal(imageExtensionOf('image/png'), 'png')
  assert.equal(imageExtensionOf('image/jpeg'), 'jpg')
  assert.equal(imageExtensionOf('image/webp'), 'webp')
  assert.equal(imageExtensionOf('image/gif'), 'gif')
})
