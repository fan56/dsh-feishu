/**
 * Inbound Feishu event parsing — pure translation of the
 * `im.message.receive_v1` payload into the one shape the bot reasons about.
 * Kept dependency-free (structurally typed against the SDK's payload) so the
 * parsing table is unit-testable without a Lark connection.
 */

/** A parsed inbound message. */
export interface InboundMessage {
  /** Sender open_id — the allowlist key. */
  readonly openId: string
  /** Chat to reply into. */
  readonly chatId: string
  /** `p2p` or `group` — v1 handles p2p only. */
  readonly chatType: string
  /** The message the reply/reaction targets. */
  readonly messageId: string
  /** Message type (`text`, `image`, …). */
  readonly messageType: string
  /** Plain text body for `text` messages; undefined otherwise. */
  readonly text: string | undefined
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
  }
}

/**
 * Parse one receive event. Returns undefined when the payload is structurally
 * unusable (no sender/chat/message id) — the caller drops it silently.
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
  let text: string | undefined
  if (messageType === 'text') {
    // Text message content is a JSON envelope: {"text":"..."} — degrade to
    // raw string when the envelope is not JSON (defensive; SDK sends JSON).
    const raw = message?.content ?? ''
    try {
      const parsed: unknown = JSON.parse(raw)
      text = typeof parsed === 'object' && parsed !== null
        ? String((parsed as { text?: unknown }).text ?? '')
        : raw
    } catch {
      text = raw
    }
  }
  return { openId, chatId, chatType: message?.chat_type ?? '', messageId, messageType, text }
}
