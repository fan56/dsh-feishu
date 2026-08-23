/**
 * Lark/Feishu client wrapper — the plugin's ONLY outbound surface. One
 * WebSocket (official SDK WSClient, outbound connect, no public port) carries
 * inbound events; sends go through the SDK's REST client (tenant token).
 *
 * Hard constraints honored here (design §1):
 * - the receive handler must return within ~3s — it only enqueues (the
 *   callback handed to `start` is the bot's sync push);
 * - cluster mode does not broadcast — exactly one bot instance per app may
 *   connect (the single-instance lock in index.ts enforces the local side).
 *
 * Every send is best-effort: failures are reported to `onError` and degrade
 * to a skipped message/patch — a Feishu outage must never crash the dsh
 * process or the attached session.
 */

import * as lark from '@larksuiteoapi/node-sdk'
import type { InteractiveCard } from './card.ts'

/** Minimal outbound surface the bot depends on (mockable in tests). */
export interface LarkGateway {
  /** Open the event stream; `onMessage` is the sync enqueue-only callback. */
  start(onMessage: (data: unknown) => void): Promise<void>
  close(): void
  sendText(chatId: string, text: string): Promise<string | undefined>
  sendCard(chatId: string, card: InteractiveCard): Promise<string | undefined>
  patchCard(messageId: string, card: InteractiveCard): Promise<boolean>
  react(messageId: string, emojiType: string): Promise<void>
}

/** Best-effort error sink (`what` names the failed operation). */
export type LarkErrorSink = (what: string, error: unknown) => void

export interface LarkClientOptions {
  readonly appId: string
  readonly appSecret: string
  readonly domain: 'feishu' | 'lark'
  readonly onError?: LarkErrorSink
  /** Test seam: overrides the WS client factory. */
  readonly wsFactory?: (options: LarkClientOptions, onMessage: (data: unknown) => void, onError: LarkErrorSink) => LarkWsHandle
}

/** The WSClient surface this wrapper needs (structural for testability). */
export interface LarkWsHandle {
  start(): Promise<void>
  close(): void
}

function defaultWsFactory(
  options: LarkClientOptions,
  onMessage: (data: unknown) => void,
  onError: LarkErrorSink,
): LarkWsHandle {
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': (data: unknown) => {
      // Enqueue-only: the bot's handler is synchronous and cheap; the 3s
      // window belongs to the SDK's ack, not to our processing.
      try {
        onMessage(data)
      } catch (error) {
        onError('event-handler', error)
      }
    },
  })
  const ws = new lark.WSClient({
    appId: options.appId,
    appSecret: options.appSecret,
    domain: options.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.warn,
    autoReconnect: true,
  })
  return {
    start: () => ws.start({ eventDispatcher: dispatcher }),
    close: () => ws.close({ force: true }),
  }
}

/** Connected Lark client: WS receive + REST send. */
export class LarkClient implements LarkGateway {
  private readonly options: LarkClientOptions
  private readonly client: lark.Client
  private readonly onError: LarkErrorSink
  private readonly wsFactory: (options: LarkClientOptions, onMessage: (data: unknown) => void, onError: LarkErrorSink) => LarkWsHandle
  private ws: LarkWsHandle | undefined

  constructor(options: LarkClientOptions) {
    this.options = options
    this.onError = options.onError ?? (() => {})
    this.wsFactory = options.wsFactory ?? defaultWsFactory
    this.client = new lark.Client({
      appId: options.appId,
      appSecret: options.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: options.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn,
    })
  }

  /** Open the event WebSocket; resolves once the connection attempt settles. */
  async start(onMessage: (data: unknown) => void): Promise<void> {
    const ws = this.wsFactory(this.options, onMessage, this.onError)
    this.ws = ws
    await ws.start()
  }

  close(): void {
    try {
      this.ws?.close()
    } catch (error) {
      this.onError('ws-close', error)
    }
    this.ws = undefined
  }

  async sendText(chatId: string, text: string): Promise<string | undefined> {
    try {
      const response = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      })
      return response?.data?.message_id
    } catch (error) {
      this.onError('send-text', error)
      return undefined
    }
  }

  async sendCard(chatId: string, card: InteractiveCard): Promise<string | undefined> {
    try {
      const response = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      })
      return response?.data?.message_id
    } catch (error) {
      this.onError('send-card', error)
      return undefined
    }
  }

  async patchCard(messageId: string, card: InteractiveCard): Promise<boolean> {
    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
      return true
    } catch (error) {
      this.onError('patch-card', error)
      return false
    }
  }

  async react(messageId: string, emojiType: string): Promise<void> {
    try {
      await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      })
    } catch {
      // Reactions are a low-noise extra channel; never report their failure.
    }
  }
}

/** Emoji keys used by the bot (Feishu reaction API emoji_type values). */
export const EMOJI_SEEN = 'EYES'
export const EMOJI_DONE = 'THUMBSUP'
