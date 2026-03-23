import { randomBytes } from 'crypto'

export const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com'

export interface WeixinMessageItem {
  type?: number
  text_item?: { text?: string }
  voice_item?: { text?: string }
  image_item?: unknown
  file_item?: { file_name?: string }
  video_item?: unknown
}

export interface WeixinInboundMessage {
  seq?: number
  message_id?: number
  client_id?: string
  from_user_id?: string
  to_user_id?: string
  create_time_ms?: number
  message_type?: number
  message_state?: number
  item_list?: WeixinMessageItem[]
  context_token?: string
}

export interface GetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinInboundMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || DEFAULT_WEIXIN_BASE_URL).replace(/\/+$/, '')
}

function buildXWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0)
  const buf = Buffer.allocUnsafe(4)
  buf.writeUInt32BE(value, 0)
  return buf.toString('base64')
}

function buildHeaders(token?: string, routeTag?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': buildXWechatUin()
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  if (routeTag) {
    headers.SKRouteTag = routeTag
  }
  return headers
}

async function postJson<T>(params: {
  baseUrl: string
  path: string
  body: unknown
  token?: string
  routeTag?: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 40000)
  const signal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal

  try {
    const response = await fetch(`${normalizeBaseUrl(params.baseUrl)}/${params.path}`, {
      method: 'POST',
      headers: buildHeaders(params.token, params.routeTag),
      body: JSON.stringify(params.body),
      signal
    })

    const rawText = await response.text()
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${rawText || response.statusText}`)
    }

    return rawText ? (JSON.parse(rawText) as T) : ({} as T)
  } finally {
    clearTimeout(timeout)
  }
}

export class WeixinApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly routeTag?: string
  ) {}

  async getUpdates(
    syncBuf: string,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<GetUpdatesResponse> {
    return postJson<GetUpdatesResponse>({
      baseUrl: this.baseUrl,
      path: 'ilink/bot/getupdates',
      body: { get_updates_buf: syncBuf || '' },
      token: this.token,
      routeTag: this.routeTag,
      timeoutMs,
      signal
    })
  }

  async sendMessage(params: {
    toUserId: string
    text: string
    contextToken: string
  }): Promise<{ messageId: string }> {
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

    await postJson({
      baseUrl: this.baseUrl,
      path: 'ilink/bot/sendmessage',
      body: {
        msg: {
          from_user_id: '',
          to_user_id: params.toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [
            {
              type: 1,
              text_item: { text: params.text }
            }
          ],
          context_token: params.contextToken
        }
      },
      token: this.token,
      routeTag: this.routeTag,
      timeoutMs: 20000
    })

    return { messageId: clientId }
  }
}
