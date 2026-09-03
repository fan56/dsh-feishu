/**
 * Background-push decision layer — pure fold over the session-event firehose
 * for sessions the phone is NOT bound to (bound sessions already have live
 * round cards; pushing them again would duplicate every turn).
 *
 * What it watches for (host event shapes verified in the dsh closure):
 * - cron deliveries land as `user/message` with
 *   `source = { kind: 'plugin', plugin: 'cron' }` (dsh-cron's framing);
 * - background-subagent settlements land as `user/message` with
 *   `source.kind === 'subagent-settled'` (dsh-subagent's continuation notices);
 * - plain turns are only interesting in `all` mode.
 *
 * The fold marks the flags DURING a turn and the caller decides on
 * `turn/end` — the completion moment — using the last assistant line as the
 * summary. All payload reads are defensive: malformed events are no-ops.
 */

import type { SessionEvent } from './dsh-events.ts'
import { lastNonBlankLine, textOfContent } from './text.ts'

/** Push mode: off (default — silent-start invariant), cron/subagent events only, or every turn. */
export type BackgroundPushMode = 'off' | 'cron' | 'all'

/** Per-session scratch the fold mutates; one per tracked session. */
export interface PushTrack {
  /** A turn is (or was recently) in flight — set by turn/start and any user/message. */
  turnActive: boolean
  /** Epoch ms the current turn started (duration display), from the event stream. */
  turnStartedAt: number | undefined
  /** The turn contained a cron delivery. */
  cronSeen: boolean
  /** The turn contained a subagent-settled notice. */
  subagentSettled: boolean
  /** Last visible line of the turn's latest assistant message. */
  lastAssistant: string | undefined
  /** turn/end reason kind, captured when the turn settles. */
  endReason: string | undefined
}

/** Fresh scratch for one session. */
export function initialPushTrack(): PushTrack {
  return {
    turnActive: false,
    turnStartedAt: undefined,
    cronSeen: false,
    subagentSettled: false,
    lastAssistant: undefined,
    endReason: undefined,
  }
}

/** Why a completed turn would be pushed (cause order: specific beats generic). */
export type PushCause = 'cron' | 'subagent-settled' | 'turn'

/** Object-or-empty record read (same defensive shape as run-state's `rec`). */
function rec(data: unknown): Record<string, any> {
  return (data !== null && typeof data === 'object' ? data : {}) as Record<string, any>
}

/**
 * Fold one firehose event into the track. On `turn/end` it returns the cause
 * the push decision should consider (specific events beat a plain turn);
 * undefined for everything else. Mutates `track` in place, O(1) per event.
 */
export function foldPushEvent(track: PushTrack, event: SessionEvent): PushCause | undefined {
  switch (event.type) {
    case 'turn/start': {
      Object.assign(track, initialPushTrack())
      track.turnActive = true
      track.turnStartedAt = typeof event.time === 'number' ? event.time : undefined
      return undefined
    }
    case 'user/message': {
      track.turnActive = true
      const source = rec(rec(event.data).source)
      if (source.kind === 'plugin' && source.plugin === 'cron') track.cronSeen = true
      if (source.kind === 'subagent-settled') track.subagentSettled = true
      return undefined
    }
    case 'assistant/message': {
      const text = textOfContent(rec(event.data).message?.content)
      if (text !== '') track.lastAssistant = lastNonBlankLine(text)
      return undefined
    }
    case 'turn/end': {
      track.turnActive = false
      track.endReason = typeof rec(event.data).reason?.kind === 'string' ? rec(event.data).reason.kind : undefined
      if (track.cronSeen) return 'cron'
      if (track.subagentSettled) return 'subagent-settled'
      return 'turn'
    }
    default:
      return undefined
  }
}

/** Whether `mode` pushes a completed turn with `cause`. */
export function shouldPush(mode: BackgroundPushMode, cause: PushCause): boolean {
  if (mode === 'off') return false
  if (mode === 'cron') return cause !== 'turn'
  return true
}

/** Cause header for the push card title. */
export function pushCauseLabel(cause: PushCause): string {
  switch (cause) {
    case 'cron': return '⏰ 定时任务'
    case 'subagent-settled': return '🧵 子代理完成'
    case 'turn': return '🖥️ 桌面回合完成'
  }
}
