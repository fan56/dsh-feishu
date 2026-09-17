/**
 * Pairing mode (zero-config bootstrap) — pure decision + card builders.
 *
 * When the operator allowlist is completely empty (no `operators` config, no
 * `DSH_FEISHU_OPERATORS`, no persisted `pairedOperators`), the bot still arms
 * with valid credentials but answers NOBODY — except that the first person to
 * DM it gets a pairing confirmation card and may claim admin by tapping it.
 * The claim persists through the state store (`dsh-feishu.pairedOperators`)
 * and takes effect immediately (the bot re-reads the list per message).
 *
 * Groups never pair. Once ANY admin exists (config or paired), further DMs
 * from strangers are silently ignored again — the same close-world posture as
 * the pre-pairing allowlist gate.
 *
 * Everything here is a pure function so the truth table is unit-testable
 * without a Lark connection; {@link module:bot} owns the stateful flow
 * (card dedup per chat, callback handling, persistence).
 */

import type { Schema2Card } from './card.ts'

/** What one inbound message does under pairing mode. */
export type PairingDecision =
  | { readonly kind: 'allow' } // sender is on the (config ∪ paired) list — normal message flow
  | { readonly kind: 'offer-pairing' } // nobody can operate yet + p2p DM — trigger the pairing card
  | { readonly kind: 'ignore' } // silently ignore (the standing non-operator behavior)

/** Normalize one candidate id: trim and drop empties (mirrors allowlist.ts). */
function normalizeId(id: string): string | undefined {
  const value = id.trim()
  return value === '' ? undefined : value
}

/** The normalized id set of an operator list. */
function normalizeSet(ids: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>()
  for (const id of ids) {
    const value = normalizeId(id)
    if (value !== undefined) set.add(value)
  }
  return set
}

/**
 * Decide what to do with one inbound message. The config and paired lists are
 * unioned (either grants access); pairing is offered only when the union is
 * EMPTY and the message is a direct (p2p) chat from an identified sender —
 * groups never pair, and an empty sender id has no one to pair.
 */
export function decidePairing(input: {
  chatType: string
  senderOpenId: string
  configOperators: readonly string[]
  pairedOperators: readonly string[]
}): PairingDecision {
  const sender = normalizeId(input.senderOpenId)
  const config = normalizeSet(input.configOperators)
  const paired = normalizeSet(input.pairedOperators)
  if (sender !== undefined && (config.has(sender) || paired.has(sender))) return { kind: 'allow' }
  if (config.size === 0 && paired.size === 0 && input.chatType === 'p2p' && sender !== undefined) {
    return { kind: 'offer-pairing' }
  }
  return { kind: 'ignore' }
}

// ------------------------------------------------------------ pairing cards --

/** Marker written into the pairing button's `value.dsh_feishu`. */
export const PAIR_ACTION_VALUE = 'pair'

/** The pairing button's `name` — must be unique across the whole card
 *  (platform hard rule 230099); this card carries exactly one button. */
export const PAIR_BUTTON_NAME = 'pair_confirm'

/** The pairing confirmation card: explains the situation and offers the
 *  one-tap admin claim. Re-sends patch THIS card in place (the bot keeps the
 *  chatId → messageId map), so a chat never accumulates pairing cards. */
export function buildPairingOfferCard(): Schema2Card {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '🔗 dsh-feishu 管理员配对' },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '你不在本机器人的管理员白名单。点下方按钮把自己设为管理员（仅当 allowlist 完全为空时可用）。不是你的操作请忽略。',
        },
        {
          tag: 'button',
          name: PAIR_BUTTON_NAME,
          // value MUST exist: value-less interactive components are rejected
          // client-side with 200340 and the callback is never delivered.
          value: { dsh_feishu: PAIR_ACTION_VALUE },
          text: { tag: 'plain_text', content: '设我为管理员' },
          type: 'primary',
        },
      ],
    },
  }
}

/** Terminal state after a successful claim (green): the tapper is now an
 *  admin in this very process — no restart needed. */
export function buildPairingSuccessCard(): Schema2Card {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '✅ 配对完成' },
      template: 'green',
    },
    body: {
      elements: [{
        tag: 'markdown',
        content: '✅ 配对完成：你已加入管理员名单，直接发 /help 开始使用。',
      }],
    },
  }
}

/** Terminal state when someone tapped a stale pairing card after an admin
 *  already exists (grey): the claim is refused, nothing changed. */
export function buildPairingRejectedCard(): Schema2Card {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '🔗 dsh-feishu 管理员配对' },
      template: 'grey',
    },
    body: {
      elements: [{
        tag: 'markdown',
        content: '已有管理员，本次配对请求忽略。',
      }],
    },
  }
}

/** The user-visible note sent right after a successful claim. */
export const PAIRING_PERSIST_NOTE = '配置已持久化（settings.yaml dsh-feishu.pairedOperators），立即生效，无需重启。'

/**
 * Recognize OUR pairing button in a `card.action.trigger` payload; undefined
 * for anything else. Same fallback ladder as every interactive card here:
 * button `value` first, button `name` when an SDK strips values from submits.
 */
export function parsePairingAction(data: unknown): true | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const action = (data as { action?: unknown }).action
  if (action === null || typeof action !== 'object') return undefined
  const buttonValue = (action as { value?: unknown }).value
  if (buttonValue !== null && typeof buttonValue === 'object') {
    const marker = (buttonValue as Record<string, unknown>).dsh_feishu
    if (marker === PAIR_ACTION_VALUE) return true
    // A value carrying a DIFFERENT marker means this is not our button — the
    // name fallback below must not fire on foreign submits.
    if (typeof marker === 'string') return undefined
  }
  const name = (action as { name?: unknown }).name
  if (name === PAIR_BUTTON_NAME) return true
  return undefined
}

/** The card-action facts a pairing claim needs beyond the open_id. */
export interface PairingActionContext {
  /** Chat the tapped card lives in (the persistence note goes here). */
  readonly chatId: string | undefined
  /** Message the tapped card IS (the terminal patch targets it). */
  readonly messageId: string | undefined
}

/**
 * Extract the card message/chat ids from a `card.action.trigger` payload.
 * Current shape (observed from v2): ids are nested under `context`; top-level
 * variants kept as fallback for older/alternate surfaces — the same reading
 * the SDK payload documents.
 */
export function pairingActionContextOf(data: unknown): PairingActionContext {
  if (data === null || typeof data !== 'object') return { chatId: undefined, messageId: undefined }
  const context = (data as { context?: unknown }).context
  const nested = context !== null && typeof context === 'object'
    ? (context as Record<string, unknown>)
    : {}
  const readId = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined
  return {
    chatId: readId(nested.open_chat_id) ?? readId((data as Record<string, unknown>).open_chat_id),
    messageId: readId(nested.open_message_id) ?? readId((data as Record<string, unknown>).open_message_id),
  }
}
