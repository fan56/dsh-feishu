/**
 * Pure text helpers shared by the renderer and the /resume table. No dsh or
 * Lark imports — everything here is unit-testable string arithmetic.
 */

/** Strip ANSI SGR escape sequences (the only escapes that reach assistant text). */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Collapse CRLF/CR onto LF and fold runs of whitespace to single spaces. */
export function foldLine(line: string): string {
  return line.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+/g, ' ').trim()
}

/**
 * Last visible non-blank line of a text body (whitespace-folded), or undefined
 * when the body has no visible line. Used for reasoning tails and subagent
 * compact rows — the same "is it alive" signal dsh-tui-pi's editor shows.
 */
export function lastNonBlankLine(text: string): string | undefined {
  const body = stripAnsi(text)
  const lines = body.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const folded = foldLine(lines[i]!)
    if (folded !== '') return folded
  }
  return undefined
}

/** Clip a one-line string to `max` characters, appending an ellipsis when cut. */
export function clipLine(text: string, max: number): string {
  const oneLine = foldLine(text)
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Segment a long body for Feishu text messages: split at the last newline
 * before the size cap so paragraphs survive; a single over-long line is hard
 * cut. Returns at least one segment for non-empty input.
 */
export function segmentText(text: string, max: number): string[] {
  if (max < 8) throw new RangeError('segmentText max must be at least 8')
  const segments: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < Math.floor(max / 2)) cut = max
    segments.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest !== '' || segments.length === 0) segments.push(rest)
  return segments
}

/** Join the text blocks of a message content array into one trimmed string. */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const blockText = (block as { text?: unknown }).text
      if (typeof blockText === 'string') text += blockText + ' '
    }
  }
  return text.trim()
}

/** Format an elapsed duration in ms as a compact human string (`1m23s`, `45s`). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s === 0 ? `${m}m` : `${m}m${s}s`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

/** Format an epoch-ms timestamp for the /resume table rows (local time, minute precision). */
export function formatWhen(epochMs: number, now = Date.now()): string {
  const date = new Date(epochMs)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  const pad = (n: number) => String(n).padStart(2, '0')
  const base = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return sameYear ? base : `${date.getFullYear()}-${base}`
}
