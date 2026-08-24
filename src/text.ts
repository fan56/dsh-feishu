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
 * Truncate a multi-line markdown body to ~`max` characters for a
 * phone-narrow progress card, keeping the text verbatim up to the cut
 * (formatting survives) and appending a visible omission notice when cut.
 * Returns at least the notice-free body when it already fits.
 */
export function truncateBody(text: string, max: number): string {
  const trimmed = text.trim()
  if (max < 20) throw new RangeError('truncateBody max must be at least 20')
  if (trimmed.length <= max) return trimmed
  const head = trimmed.slice(0, Math.max(0, max - 1)).trimEnd()
  return `${head}…\n\n_…内容过长，已截断_`
}

/** Marker info of a fence-opener/closer line (` ``` `, ` ~~~ `, 4 backticks…). */
interface FenceMarker {
  readonly char: string
  readonly length: number
}

/** The fence marker of `line` (``` or ~~~, optional lang), or undefined. */
function fenceMarker(line: string): FenceMarker | undefined {
  const match = /^\s*(`{3,}|~{3,})/.exec(line)
  if (match === null) return undefined
  const run = match[1]!
  return { char: run[0]!, length: run.length }
}

/** Does `marker` close a fence opened by `opener`? Same char, at least as long. */
function closesFence(marker: FenceMarker, opener: FenceMarker): boolean {
  return marker.char === opener.char && marker.length >= opener.length
}

/**
 * Segment a long body for Feishu messages: split at the last newline before
 * the size cap so paragraphs survive — but never at a newline inside a fenced
 * code block (an unclosed ``` renders the rest of the card as garbage). When
 * no usable boundary exists (over-long fence content forces a hard cut), the
 * dangling fence is closed and REOPENED at the top of the next segment so
 * every segment is independently valid markdown with balanced fences when the
 * input itself is balanced (an unclosed fence at end-of-input stays open in
 * the final segment).
 * Returns at least one segment for non-empty input.
 *
 * Fence tracking is marker-aware (a fence only closes on a SAME-CHARACTER
 * run at least as long as its opener), so a literal ``` inside a `~~~`
 * fence does not count. Known limitation: nesting the same marker inside
 * itself is not supported — an inner ``` inside an outer ``` fence closes
 * it early, exactly like plain CommonMark.
 */
export function segmentText(text: string, max: number): string[] {
  if (max < 8) throw new RangeError('segmentText max must be at least 8')
  const segments: string[] = []
  let rest = text.replace(/\r\n/g, '\n') // normalize CRLF so \r never leaks into cards
  let reopen: string | undefined // fence opener re-attached after a forced in-fence cut
  while (rest.length > max) {
    const cut = pickCut(rest, max)
    let head = rest.slice(0, cut)
    const tail = rest.slice(cut).replace(/^\n/, '')
    if (reopen !== undefined) {
      head = `${reopen}\n${head}`
      reopen = undefined
    }
    const open = openFenceOpener(head)
    if (open !== undefined) {
      head = `${head}\n${open.close}`
      reopen = open.reopen
    }
    segments.push(head)
    rest = tail
  }
  if (reopen !== undefined) rest = `${reopen}\n${rest}`
  if (rest !== '' || segments.length === 0) segments.push(rest)
  return segments
}

/**
 * Choose a cut index ≤ `max`: the last newline that sits OUTSIDE any open
 * fence, preferring one past half the cap (paragraph-sized cuts); falls back
 * to any outside-fence newline rather than splitting a block, and finally to
 * a hard cut at `max`. A fence closes only on a same-character marker at
 * least as long as its opener ({@link closesFence}).
 */
function pickCut(text: string, max: number): number {
  const minCut = Math.floor(max / 2)
  let preferred = -1
  let any = -1
  let opener: FenceMarker | undefined // undefined = outside any fence
  let offset = 0
  for (const line of text.split('\n')) {
    offset += line.length
    // Toggle BEFORE judging this boundary: a cut right after a closing fence
    // line (state now outside) is safe; right after an opening line it is not.
    const marker = fenceMarker(line)
    if (opener === undefined) {
      if (marker !== undefined) opener = marker
    } else if (marker !== undefined && closesFence(marker, opener)) {
      opener = undefined
    }
    // offset is the index of the '\n' ending this line (skipped for the tail).
    if (offset >= text.length) break
    if (opener === undefined && offset <= max) {
      if (offset > any) any = offset
      if (offset >= minCut && offset > preferred) preferred = offset
    }
    offset++ // step over the '\n' onto the next line
  }
  return preferred >= 0 ? preferred : any >= 0 ? any : max
}

/**
 * Opener line of the fence left unclosed by `segment`, or undefined when the
 * segment is fence-balanced. With marker-aware toggling (no nesting), an odd
 * marker count means the LAST qualifying marker line opened the still-open
 * fence. Returns both the trimmed opener line (to re-open the next segment)
 * and a matching-length closer (a ``` cannot close a ```` fence).
 */
function openFenceOpener(segment: string): { reopen: string; close: string } | undefined {
  let openerLine: string | undefined
  let opener: FenceMarker | undefined
  for (const line of segment.split('\n')) {
    const marker = fenceMarker(line)
    if (opener === undefined) {
      if (marker !== undefined) {
        opener = marker
        openerLine = line.trim()
      }
    } else if (marker !== undefined && closesFence(marker, opener)) {
      opener = undefined
    }
  }
  if (opener === undefined || openerLine === undefined) return undefined
  return { reopen: openerLine, close: opener.char.repeat(opener.length) }
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
