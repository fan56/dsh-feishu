/**
 * Inbound Feishu event parsing — pure translation of the
 * `im.message.receive_v1` payload into the one shape the bot reasons about.
 * Kept dependency-free (structurally typed against the SDK's payload) so the
 * parsing table is unit-testable without a Lark connection.
 */

/** One @mention parsed off a group message (open_id only — the allowlist key). */
export interface InboundMention {
  /** The mentioned entity's open_id (the bot's own id included). */
  readonly openId: string
}

/** A parsed inbound message. */
export interface InboundMessage {
  /** Sender open_id — the allowlist key. */
  readonly openId: string
  /** Chat to reply into. */
  readonly chatId: string
  /** `p2p` or `group`. */
  readonly chatType: string
  /** The message the reply/reaction targets. */
  readonly messageId: string
  /** Message type (`text`, `image`, …). */
  readonly messageType: string
  /** Plain text body for `text` messages (mention placeholders stripped); undefined otherwise. */
  readonly text: string | undefined
  /** `image_key` for `image` messages; undefined otherwise. */
  readonly imageKey: string | undefined
  /** @mentions carried by the message (group traffic; empty in p2p). */
  readonly mentions: readonly InboundMention[]
}

/** Structural shape of one SDK mention entry. */
interface MentionEntry {
  key?: string
  id?: { open_id?: string } | string
  name?: string
}

/**
 * Structural shape of the SDK's `im.message.receive_v1` data — declared
 * locally so this module has no runtime dependency on the SDK types.
 */
export interface ReceiveV1Payload {
  sender?: { sender_id?: { open_id?: string }; sender_type?: string }
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: string
    message_type?: string
    content?: string
    mentions?: MentionEntry[]
  }
}

/** The open_id of one SDK mention entry; undefined for malformed entries. */
function mentionOpenIdOf(entry: MentionEntry | undefined): string | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const id = entry.id
  if (typeof id === 'string') return id === '' ? undefined : id
  const openId = (id as { open_id?: unknown } | null | undefined)?.open_id
  return typeof openId === 'string' && openId !== '' ? openId : undefined
}

/** Placeholder text (@_user_N style) the sender's text carries per mention. */
function mentionKeyOf(entry: MentionEntry | undefined): string | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const key = entry.key
  return typeof key === 'string' && key !== '' ? key : undefined
}

/**
 * Parse one receive event. Returns undefined when the payload is structurally
 * unusable (no sender/chat/message id) — the caller drops it silently.
 *
 * Group text carries the @bot placeholder inline (`@_user_1 任务…`); every
 * mention placeholder is stripped from the text so the remaining body is the
 * actual dispatch/command. Group messages also may carry NO text at all
 * (a bare @) — text degrades to '' and the caller ignores it.
 */
export function parseReceiveEvent(payload: unknown): InboundMessage | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const data = payload as ReceiveV1Payload
  const openId = data.sender?.sender_id?.open_id
  const message = data.message
  const chatId = message?.chat_id
  const messageId = message?.message_id
  if (openId === undefined || openId === '' || chatId === undefined || chatId === '' || messageId === undefined || messageId === '') {
    return undefined
  }
  const messageType = message?.message_type ?? ''
  const mentionEntries = message?.mentions ?? []
  const mentions: InboundMention[] = []
  for (const entry of mentionEntries) {
    const id = mentionOpenIdOf(entry)
    if (id !== undefined) mentions.push({ openId: id })
  }
  let text: string | undefined
  let imageKey: string | undefined
  if (messageType === 'text') {
    // Text message content is a JSON envelope: {"text":"..."} — degrade to
    // raw string when the envelope is not JSON (defensive; SDK sends JSON).
    const raw = message?.content ?? ''
    let parsedText = raw
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const value = (parsed as { text?: unknown }).text
        parsedText = typeof value === 'string' ? value : raw
      }
    } catch {
      // keep raw
    }
    // Strip every mention placeholder so group dispatches read naturally;
    // p2p text has no placeholders, so the pass is a no-op there.
    for (const entry of mentionEntries) {
      const key = mentionKeyOf(entry)
      if (key !== undefined) parsedText = parsedText.split(key).join(' ')
    }
    text = parsedText.trim()
  } else if (messageType === 'image') {
    // Image content is a JSON envelope: {"image_key":"..."}.
    try {
      const parsed: unknown = JSON.parse(message?.content ?? '')
      const key = (parsed as { image_key?: unknown }).image_key
      if (typeof key === 'string' && key !== '') imageKey = key
    } catch {
      // no usable key — the caller treats it as an unsupported message
    }
  }
  return {
    openId,
    chatId,
    chatType: message?.chat_type ?? '',
    messageId,
    messageType,
    text,
    imageKey,
    mentions,
  }
}
