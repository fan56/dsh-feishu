import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clipLine,
  formatDuration,
  formatWhen,
  lastNonBlankLine,
  segmentText,
  stripAnsi,
} from '../lib/text.js'

test('segmentText splits at newline boundaries under the cap', () => {
  const body = 'a'.repeat(10) + '\n' + 'b'.repeat(10) + '\n' + 'c'.repeat(10)
  // 32 chars, cap 15: cut at the first newline (10), then the second (10),
  // the remainder fits.
  const segments = segmentText(body, 15)
  assert.deepEqual(segments, ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10)])
  // A cap that fits two lines keeps them together in one segment.
  assert.deepEqual(segmentText(body, 21), ['a'.repeat(10) + '\n' + 'b'.repeat(10), 'c'.repeat(10)])
})

test('segmentText hard-cuts a single over-long line', () => {
  const segments = segmentText('x'.repeat(40), 10)
  assert.deepEqual(segments, ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(10), 'x'.repeat(10)])
})

test('segmentText keeps empty and short input as one segment', () => {
  assert.deepEqual(segmentText('', 10), [''])
  assert.deepEqual(segmentText('hello', 10), ['hello'])
})

test('lastNonBlankLine strips ANSI, folds whitespace, skips blanks', () => {
  assert.equal(lastNonBlankLine('\x1b[31mred\x1b[0m\n\n  next   line  \n'), 'next line')
  assert.equal(lastNonBlankLine('   \n\t\n'), undefined)
})

test('stripAnsi removes SGR sequences only', () => {
  assert.equal(stripAnsi('a\x1b[1;32mb\x1b[0mc'), 'abc')
})

test('clipLine appends an ellipsis when cutting', () => {
  assert.equal(clipLine('hello world', 8), 'hello w…')
  assert.equal(clipLine('short', 10), 'short')
})

test('formatDuration renders compact durations', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(45_000), '45s')
  assert.equal(formatDuration(83_000), '1m23s')
  assert.equal(formatDuration(3_600_000), '1h0m')
})

test('formatWhen drops the year only when it matches now', () => {
  const now = new Date('2026-08-24T12:00:00').getTime()
  const sameYear = new Date('2026-08-23T09:05:00').getTime()
  assert.equal(formatWhen(sameYear, now), '08-23 09:05')
  const otherYear = new Date('2024-08-23T09:05:00').getTime()
  assert.equal(formatWhen(otherYear, now), '2024-08-23 09:05')
})
