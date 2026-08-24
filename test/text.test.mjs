import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clipLine,
  formatDuration,
  formatWhen,
  lastNonBlankLine,
  segmentText,
  stripAnsi,
  truncateBody,
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

/** Count of ```/~~~ fence marker lines in a chunk — must be even per chunk. */
function fenceMarkerCount(chunk) {
  return chunk.split('\n').filter(line => /^\s*(`{3,}|~{3,})/.test(line)).length
}

test('segmentText moves the cut out of an open fence to an earlier boundary', () => {
  // 'a'*14 + \n + ```js + \n + b*16 + \n + b*16 + \n + ```  (58 chars)
  const body = ['a'.repeat(14), '```js', 'b'.repeat(16), 'b'.repeat(16), '```'].join('\n')
  // Cap 45: the naive last-newline cut lands at the newline INSIDE the fence
  // (index 37); the only usable boundary is right before the opening ```
  // (index 14), and the 43-char block then fits whole into the next segment.
  const segments = segmentText(body, 45)
  assert.deepEqual(segments, [
    'a'.repeat(14),
    ['```js', 'b'.repeat(16), 'b'.repeat(16), '```'].join('\n'),
  ])
  for (const seg of segments) {
    assert.equal(fenceMarkerCount(seg) % 2, 0, `unbalanced fence in segment: ${JSON.stringify(seg)}`)
  }
})

test('segmentText closes and reopens a dangling fence when forced to cut inside a block', () => {
  const inner = Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n') // 41 chars
  const body = '```js\n' + inner + '\n```' // 51 chars; every in-cap newline sits inside the fence
  const segments = segmentText(body, 20)
  assert.ok(segments.length > 1)
  for (const seg of segments) {
    assert.equal(fenceMarkerCount(seg) % 2, 0, `unbalanced fence in segment: ${JSON.stringify(seg)}`)
  }
  // First chunk was hard-cut inside the fence content and got a closer.
  assert.ok(segments[0].startsWith('```js\n'))
  assert.ok(segments[0].endsWith('\n```'))
  // Continuation chunks re-open the fence so they render as code too.
  for (let i = 1; i < segments.length - 1; i++) {
    assert.ok(segments[i].startsWith('```js\n'), `segment ${i} does not reopen the fence: ${JSON.stringify(segments[i])}`)
  }
})

test('segmentText balances fences across many blocks in a long mixed document', () => {
  const codeA = '```bash\necho one\necho two\necho three\necho four\n```'
  const codeB = '```python\nprint(1)\nprint(2)\nprint(3)\nprint(4)\n```'
  const filler = 'x'.repeat(20)
  const body = [filler, codeA, filler, codeB, filler].join('\n')
  const segments = segmentText(body, 25)
  assert.ok(segments.length > 2)
  let seenOpeners = 0
  for (const seg of segments) {
    assert.equal(fenceMarkerCount(seg) % 2, 0, `unbalanced fence in segment: ${JSON.stringify(seg)}`)
    if (seg.includes('echo one')) seenOpeners++
    if (seg.includes('print(1)')) seenOpeners++
  }
  assert.equal(seenOpeners, 2) // the body of both fenced blocks survives intact
})

test('segmentText treats ``` lines inside a ~~~ fence as literal content', () => {
  // The ``` pair inside the tilde fence must NOT count toward fence balance;
  // the only safe cut is before the ~~~ opener.
  const block = ['~~~', '```', 'b'.repeat(16), '```', 'b'.repeat(16), '~~~'].join('\n') // 49 chars
  const body = ['a'.repeat(14), block].join('\n')
  const segments = segmentText(body, 50)
  assert.deepEqual(segments, ['a'.repeat(14), block])
})

test('segmentText keeps ``` inside a 4-backtick fence literal', () => {
  // A same-character but SHORTER run does not close the outer ```` fence.
  const block = ['````', '```', 'b'.repeat(15), '```', 'b'.repeat(15), '````'].join('\n') // 49 chars
  const body = ['a'.repeat(14), block].join('\n')
  const segments = segmentText(body, 50)
  assert.deepEqual(segments, ['a'.repeat(14), block])
})

/** Marker-aware fence-balance check mirroring segmentText's own rule. */
function balancedFences(chunk) {
  let opener
  for (const line of chunk.split('\n')) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line)
    if (!match) continue
    const marker = { char: match[1][0], length: match[1].length }
    if (opener === undefined) opener = marker
    else if (marker.char === opener.char && marker.length >= opener.length) opener = undefined
  }
  return opener === undefined
}

test('segmentText closes and reopens a forced cut inside a 4-backtick fence', () => {
  // Too long to keep whole — hard cuts inside the fence must append a
  // matching-length ```` closer (a bare ``` would not close a ```` fence)
  // and re-open with ```` at the top of each continuation segment.
  const body = ['a'.repeat(14), '````', 'x'.repeat(120), '````'].join('\n')
  const segments = segmentText(body, 40)
  assert.ok(segments.length > 2)
  for (const seg of segments) {
    assert.ok(balancedFences(seg), `unbalanced fence in segment: ${JSON.stringify(seg)}`)
  }
  // The lead line survives as its own segment (its boundary sits outside).
  assert.equal(segments[0], 'a'.repeat(14))
  for (let i = 1; i < segments.length; i++) {
    assert.ok(segments[i].startsWith('````\n'), `segment ${i} lacks a 4-backtick reopen: ${JSON.stringify(segments[i])}`)
    if (i < segments.length - 1) {
      assert.ok(segments[i].endsWith('\n````'), `segment ${i} lacks a 4-backtick closer: ${JSON.stringify(segments[i])}`)
    }
  }
})

test('segmentText normalizes CRLF so no \\r leaks into segments', () => {
  const body = 'a'.repeat(10) + '\r\n' + 'b'.repeat(10) + '\r\n' + 'c'.repeat(10)
  const segments = segmentText(body, 15)
  assert.deepEqual(segments, ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10)])
  for (const seg of segmentText('x'.repeat(40) + '\r\nmore', 20)) {
    assert.ok(!seg.includes('\r'), `segment carries a stray CR: ${JSON.stringify(seg)}`)
  }
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

test('truncateBody keeps a fitting body verbatim (trimmed)', () => {
  assert.equal(truncateBody('  hello\nworld  ', 100), 'hello\nworld')
})

test('truncateBody cuts long bodies and appends an omission notice', () => {
  const body = 'x'.repeat(400)
  const out = truncateBody(body, 300)
  assert.ok(out.length < 320)
  assert.ok(out.startsWith('x'.repeat(299)))
  assert.ok(out.includes('…'))
  assert.match(out, /已截断/)
})

test('truncateBody enforces the minimum cap', () => {
  assert.throws(() => truncateBody('abc', 10), /at least 20/)
})
