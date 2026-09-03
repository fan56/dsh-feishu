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
 * process or the attached session. All im/v1 calls go through
 * {@link requestFeishu}, which normalizes fulfilled non-zero-code bodies into
 * {@link FeishuApiError} and retries rate limits with exponential backoff.
 */

import * as lark from '@larksuiteoapi/node-sdk'
import type { AnyCard } from './card.ts'

/** Minimal outbound surface the bot depends on (mockable in tests). */
export interface LarkGateway {
  /** Open the event stream; `onMessage` is the sync enqueue-only callback. */
  start(onMessage: (data: unknown) => void): Promise<void>
  close(): void
  sendText(chatId: string, text: string): Promise<string | undefined>
  sendCard(chatId: string, card: AnyCard): Promise<string | undefined>
  patchCard(messageId: string, card: AnyCard): Promise<boolean>
  react(messageId: string, emojiType: string): Promise<void>
  /** Download one image resource; undefined on failure (best-effort). */
  downloadImage(messageId: string, imageKey: string): Promise<Uint8Array | undefined>
  /** The bot's own open_id (mention routing); undefined when unresolvable. */
  fetchBotOpenId(): Promise<string | undefined>
}

/** Best-effort error sink (`what` names the failed operation). */
export type LarkErrorSink = (what: string, error: unknown) => void

/** Severity a bridged SDK log line is delivered at. */
export type BridgedLogLevel = 'debug' | 'warn' | 'error'

/** Sink that receives bridged SDK log lines (wired to the plugin's logger). */
export type LarkLogSink = (level: BridgedLogLevel, message: string) => void

/**
 * The dispatcher's notice for events without a registered handler (read
 * receipts, reaction events, …) — expected traffic, not worth a warn.
 */
const NO_HANDLER_RE = /^no \S+ handle[r]?$/i

/**
 * Build an SDK `Logger` that routes every line into the plugin's log channel
 * instead of the SDK default (bare console writes that bypass the TUI
 * alt-screen renderer). Mapping: info/debug/trace → debug, warn → warn,
 * error → error; "no <event> handler" warnings downgrade to debug.
 */
export function bridgeSdkLogger(sink: LarkLogSink): lark.Logger {
  // The SDK's LoggerProxy forwards its collected arguments as ONE ARRAY, so
  // `warn(msg)` arrives here as `warn(['no x handler'])` — flatten that array
  // layer first or every string gets a JSON `["…"]` wrapper and pattern
  // matching against the plain text never fires.
  const flatten = (...msg: unknown[]): string =>
    msg.flat()
      .map(item => (typeof item === 'string' ? item : JSON.stringify(item)))
      .join(' ')
  return {
    error: (...msg) => { sink('error', flatten(...msg)) },
    warn: (...msg) => {
      const text = flatten(...msg)
      sink(NO_HANDLER_RE.test(text.trim()) ? 'debug' : 'warn', text)
    },
    info: (...msg) => { sink('debug', flatten(...msg)) },
    debug: (...msg) => { sink('debug', flatten(...msg)) },
    trace: () => { /* too chatty even for debug — drop */ },
  }
}

// ----------------------------------------------------- im/v1 request wrapper --

/**
 * Feishu business error: HTTP 200 but the response body carries a non-zero
 * `code` (the SDK fulfills instead of throwing on those).
 */
export class FeishuApiError extends Error {
  readonly feishuCode: number
  readonly msg: string

  constructor(feishuCode: number, msg: string) {
    super(`feishu api error code=${feishuCode}${msg === '' ? '' : ` msg=${msg}`}`)
    this.name = 'FeishuApiError'
    this.feishuCode = feishuCode
    this.msg = msg
  }
}

/** Exponential-backoff retry budget for rate-limited sends. */
const MAX_RETRIES = 2
const BASE_DELAY_MS = 500

/** Feishu rate-limit business codes treated like HTTP 429. */
const RETRYABLE_FEISHU_CODES = new Set([230020, 11232])

/** The `{ code, msg }` envelope every Feishu OpenAPI response body has. */
interface FeishuEnvelope {
  code?: unknown
  msg?: unknown
}

function envelopeOf(value: unknown): FeishuEnvelope | undefined {
  return value !== null && typeof value === 'object' ? value as FeishuEnvelope : undefined
}

/** Non-zero business code of an API result, when it is a number. */
function bodyCode(result: unknown): number | undefined {
  const code = envelopeOf(result)?.code
  return typeof code === 'number' ? code : undefined
}

/** HTTP status attached to a thrown SDK/axios error, when present. */
function httpStatusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const status = (error as { response?: { status?: unknown } }).response?.status
  return typeof status === 'number' ? status : undefined
}

/** Rate-limit classification: HTTP 429 or a known Feishu limit code. */
function isRateLimited(error: unknown): boolean {
  if (httpStatusOf(error) === 429) return true
  if (error instanceof FeishuApiError) return RETRYABLE_FEISHU_CODES.has(error.feishuCode)
  const data = envelopeOf((error as { response?: { data?: unknown } }).response?.data)
  const code = typeof data?.code === 'number' ? data.code : undefined
  return code !== undefined && RETRYABLE_FEISHU_CODES.has(code)
}

export interface RequestFeishuOptions {
  /** Injectable timer seam for tests (defaults to a real setTimeout sleep). */
  sleep?: (ms: number) => Promise<void>
  /** Base backoff delay in ms; doubles per retry. */
  baseDelayMs?: number
  /** Retry budget beyond the first attempt. */
  maxRetries?: number
}

/**
 * Unified wrapper around every im/v1 call: a fulfilled response whose body
 * carries `code !== 0` is rethrown as {@link FeishuApiError}, and rate-limit
 * failures (HTTP 429 or Feishu codes 230020/11232) are retried with
 * exponential backoff (500ms base, at most 2 retries). Everything else
 * propagates to the caller untouched.
 */
export async function requestFeishu<T>(
  request: () => Promise<T>,
  options: RequestFeishuOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const baseDelayMs = options.baseDelayMs ?? BASE_DELAY_MS
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  let delay = baseDelayMs
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await request()
      // The SDK may fulfill with a rate-limit/error body instead of throwing —
      // normalize it into FeishuApiError so classification sees one shape.
      const code = bodyCode(result)
      if (code !== undefined && code !== 0) {
        const msg = envelopeOf(result)?.msg
        throw new FeishuApiError(code, typeof msg === 'string' ? msg : '')
      }
      return result
    } catch (error) {
      if (attempt >= maxRetries || !isRateLimited(error)) throw error
      await sleep(delay)
      delay *= 2
    }
  }
}

export interface LarkClientOptions {
  readonly appId: string
  readonly appSecret: string
  readonly domain: 'feishu' | 'lark'
  readonly onError?: LarkErrorSink
  /** Receives every SDK log line, bridged into the plugin's log channel. */
  readonly onLog?: LarkLogSink
  /**
   * Card interaction callbacks (`card.action.trigger` over the long
   * connection — requires the app to subscribe the event in the developer
   * console). Undefined disables the handler entirely.
   */
  readonly onCardAction?: (data: unknown) => void
  /** Test seam: overrides the WS client factory. */
  readonly wsFactory?: (options: LarkClientOptions, onMessage: (data: unknown) => void, onError: LarkErrorSink) => LarkWsHandle
  /** Test seam: overrides the retry backoff timer (see requestFeishu). */
  readonly sleep?: (ms: number) => Promise<void>
}

/** The WSClient surface this wrapper needs (structural for testability). */
export interface LarkWsHandle {
  start(): Promise<void>
  close(): void
}

/**
 * The SDK's WSClient silently DROPS frames whose header type is "card"
 * (card.action.trigger callbacks) — only "event" frames reach the
 * dispatcher (same defect as oapi-sdk-python #126; openclaw-lark patches
 * around it in production). Rewrite the header before the original
 * handler runs; the card payload is already the v2 event shape, so the
 * dispatcher routes it to the registered card.action.trigger handler.
 * Instance-level patch: absent on a future SDK that handles card frames
 * natively, it becomes a no-op.
 */
function patchCardFrames(ws: unknown, onLog?: LarkLogSink): void {
  const handle = ws as { handleEventData?: (data: unknown) => Promise<void> }
  const orig = handle.handleEventData
  if (typeof orig !== 'function') return
  handle.handleEventData = (data: unknown) => {
    const headers = (data as { headers?: Array<{ key?: unknown; value?: unknown }> } | undefined)?.headers
    if (Array.isArray(headers)) {
      for (const header of headers) {
        if (header?.key === 'type' && header?.value === 'card') {
          header.value = 'event'
          onLog?.('debug', 'rewrote card frame header to event (card.action.trigger)')
          break
        }
      }
    }
    return orig.call(ws, data)
  }
}

function defaultWsFactory(
  options: LarkClientOptions,
  onMessage: (data: unknown) => void,
  onError: LarkErrorSink,
): LarkWsHandle {
  // Bridge the SDK logger so nothing writes to the console directly —
  // unregistered-event notices and transport warnings flow through onLog.
  const sdkLogger = bridgeSdkLogger(options.onLog ?? (() => {}))
  const dispatcher = new lark.EventDispatcher({ logger: sdkLogger }).register({
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
  if (options.onCardAction !== undefined) {
    dispatcher.register({
      'card.action.trigger': (data: unknown) => {
        try {
          options.onCardAction!(data)
        } catch (error) {
          onError('card-action-handler', error)
        }
      },
    })
  }
  const ws = new lark.WSClient({
    appId: options.appId,
    appSecret: options.appSecret,
    domain: options.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.warn,
    logger: sdkLogger,
    autoReconnect: true,
  })
  patchCardFrames(ws, options.onLog)
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
  private readonly sleep: ((ms: number) => Promise<void>) | undefined
  private readonly wsFactory: (options: LarkClientOptions, onMessage: (data: unknown) => void, onError: LarkErrorSink) => LarkWsHandle
  private ws: LarkWsHandle | undefined

  constructor(options: LarkClientOptions) {
    this.options = options
    this.onError = options.onError ?? (() => {})
    this.sleep = options.sleep
    this.wsFactory = options.wsFactory ?? defaultWsFactory
    this.client = new lark.Client({
      appId: options.appId,
      appSecret: options.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: options.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn,
      logger: bridgeSdkLogger(options.onLog ?? (() => {})),
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
      const response = await requestFeishu(
        () => this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        }),
        { sleep: this.sleep },
      )
      return response?.data?.message_id
    } catch (error) {
      this.onError('send-text', error)
      return undefined
    }
  }

  async sendCard(chatId: string, card: AnyCard): Promise<string | undefined> {
    try {
      const response = await requestFeishu(
        () => this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify(card),
          },
        }),
        { sleep: this.sleep },
      )
      return response?.data?.message_id
    } catch (error) {
      this.onError('send-card', error)
      return undefined
    }
  }

  async patchCard(messageId: string, card: AnyCard): Promise<boolean> {
    try {
      await requestFeishu(
        () => this.client.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(card) },
        }),
        { sleep: this.sleep },
      )
      return true
    } catch (error) {
      this.onError('patch-card', error)
      return false
    }
  }

  async react(messageId: string, emojiType: string): Promise<void> {
    try {
      await requestFeishu(
        () => this.client.im.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: emojiType } },
        }),
        { sleep: this.sleep },
      )
    } catch {
      // Reactions are a low-noise extra channel; never report their failure.
    }
  }

  async downloadImage(messageId: string, imageKey: string): Promise<Uint8Array | undefined> {
    try {
      const response = await requestFeishu(
        () => this.client.im.messageResource.get({
          params: { type: 'image' },
          path: { message_id: messageId, file_key: imageKey },
        }),
        { sleep: this.sleep },
      )
      const stream = response?.getReadableStream?.()
      if (stream === undefined) return undefined
      const chunks: Buffer[] = []
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
      }
      return new Uint8Array(Buffer.concat(chunks))
    } catch (error) {
      this.onError('download-image', error)
      return undefined
    }
  }

  async fetchBotOpenId(): Promise<string | undefined> {
    try {
      const response = await requestFeishu(
        () => this.client.request<{ data?: { open_id?: unknown } }>({
          url: '/open-apis/bot/v3/info',
          method: 'GET',
        }),
        { sleep: this.sleep },
      )
      const openId = response?.data?.open_id
      return typeof openId === 'string' && openId !== '' ? openId : undefined
    } catch (error) {
      this.onError('bot-info', error)
      return undefined
    }
  }
}

/** Emoji keys used by the bot (Feishu reaction API emoji_type values). */
export const EMOJI_SEEN = 'EYES'
export const EMOJI_DONE = 'THUMBSUP'
