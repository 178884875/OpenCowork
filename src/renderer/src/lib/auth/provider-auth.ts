import { useProviderStore } from '@renderer/stores/provider-store'
import type { AIProvider, OAuthConfig, OAuthToken } from '@renderer/lib/api/types'
import { startOAuthFlow, refreshOAuthFlow, type StartOAuthFlowOptions } from './oauth'
import {
  clearCopilotQuota,
  exchangeCopilotToken,
  isCopilotProvider,
  resolveCopilotApiKey,
  syncCopilotQuota
} from './copilot'
import { sendChannelCode, verifyChannelCode, fetchChannelUserInfo } from './channel'

const REFRESH_SKEW_MS = 2 * 60 * 1000

function getProviderById(providerId: string): AIProvider | null {
  const providers = useProviderStore.getState().providers
  return providers.find((p) => p.id === providerId) ?? null
}

function resolveOAuthConfig(provider: AIProvider): OAuthConfig | null {
  if (provider.oauthConfig?.authorizeUrl && provider.oauthConfig?.tokenUrl)
    return provider.oauthConfig
  return provider.oauthConfig ?? null
}

function parseExpiryTimestamp(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) {
      return numeric > 10_000_000_000 ? Math.floor(numeric) : Math.floor(numeric * 1000)
    }
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || undefined
  }
  if (typeof value === 'number') {
    return String(value)
  }
  return undefined
}

function parseManualOAuthPayload(raw: string): AIProvider['oauth'] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('invalid_json')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('invalid_json_object')
  }
  const payload = data as Record<string, unknown>
  const accessToken = asString(
    payload.access_token ??
      payload.accessToken ??
      payload.authorization_token ??
      payload.authorizationToken ??
      payload.auth_token ??
      payload.authToken ??
      payload.token
  )
  if (!accessToken) {
    throw new Error('missing_access_token')
  }

  const refreshToken = asString(payload.refresh_token ?? payload.refreshToken)
  const scope = asString(payload.scope)
  const tokenType = asString(payload.token_type ?? payload.tokenType)
  const accountId = asString(payload.account_id ?? payload.accountId)
  const idToken = asString(payload.id_token ?? payload.idToken)
  const copilotAccessToken = asString(
    payload.copilot_access_token ?? payload.copilotAccessToken ?? payload.oauth_token
  )
  const copilotTokenType = asString(payload.copilot_token_type ?? payload.copilotTokenType)
  const copilotApiUrl = asString(payload.copilot_api_url ?? payload.copilotApiUrl)
  const copilotSku = asString(payload.sku ?? payload.copilotSku)
  const copilotTelemetry = asString(payload.telemetry ?? payload.copilotTelemetry)
  const copilotChatEnabledRaw = payload.chat_enabled ?? payload.copilotChatEnabled
  const copilotChatEnabled =
    typeof copilotChatEnabledRaw === 'boolean'
      ? copilotChatEnabledRaw
      : typeof copilotChatEnabledRaw === 'string'
        ? ['true', '1', 'yes', 'enabled'].includes(copilotChatEnabledRaw.trim().toLowerCase())
        : undefined

  const expiresAt =
    parseExpiryTimestamp(
      payload.expires_at ??
        payload.expiresAt ??
        payload.expired ??
        payload.expireAt ??
        payload.expire_at
    ) ??
    (() => {
      const expiresInRaw = payload.expires_in ?? payload.expiresIn
      const expiresIn =
        typeof expiresInRaw === 'number'
          ? expiresInRaw
          : typeof expiresInRaw === 'string'
            ? Number(expiresInRaw)
            : NaN
      return Number.isFinite(expiresIn) ? Date.now() + (expiresIn as number) * 1000 : undefined
    })()

  const copilotExpiresAt =
    parseExpiryTimestamp(payload.copilot_expires_at ?? payload.copilotExpiresAt) ??
    (() => {
      const expiresInRaw = payload.copilot_expires_in ?? payload.copilotExpiresIn
      const expiresIn =
        typeof expiresInRaw === 'number'
          ? expiresInRaw
          : typeof expiresInRaw === 'string'
            ? Number(expiresInRaw)
            : NaN
      return Number.isFinite(expiresIn) ? Date.now() + (expiresIn as number) * 1000 : undefined
    })()

  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(scope ? { scope } : {}),
    ...(tokenType ? { tokenType } : {}),
    ...(accountId ? { accountId } : {}),
    ...(idToken ? { idToken } : {}),
    ...(copilotAccessToken ? { copilotAccessToken } : {}),
    ...(copilotTokenType ? { copilotTokenType } : {}),
    ...(copilotExpiresAt ? { copilotExpiresAt } : {}),
    ...(copilotApiUrl ? { copilotApiUrl } : {}),
    ...(copilotSku ? { copilotSku } : {}),
    ...(copilotTelemetry ? { copilotTelemetry } : {}),
    ...(copilotChatEnabled !== undefined ? { copilotChatEnabled } : {})
  }
}

function setProviderAuth(providerId: string, patch: Partial<AIProvider>): void {
  useProviderStore.getState().updateProvider(providerId, patch)
}

function buildOAuthProviderPatch(provider: AIProvider, token: OAuthToken): Partial<AIProvider> {
  const apiKey = getProviderApiKey(provider, token)
  const patch: Partial<AIProvider> = {
    authMode: 'oauth',
    oauth: token,
    apiKey
  }
  if (isCopilotProvider(provider) && token.copilotApiUrl) {
    patch.baseUrl = token.copilotApiUrl
  }
  return patch
}

function requiresOAuthConnectConfig(config: OAuthConfig | null): boolean {
  if (!config?.tokenUrl || !config.clientId) return false
  if ((config.flowType ?? 'authorization_code') === 'device_code') {
    return !!config.deviceCodeUrl
  }
  return !!config.authorizeUrl
}

function getProviderApiKey(provider: AIProvider, token: OAuthToken): string {
  return isCopilotProvider(provider) ? resolveCopilotApiKey(token) : token.accessToken
}

async function finalizeOAuthToken(provider: AIProvider, token: OAuthToken): Promise<OAuthToken> {
  if (!isCopilotProvider(provider)) {
    return token
  }
  const next =
    token.copilotAccessToken &&
    token.copilotExpiresAt &&
    token.copilotExpiresAt - Date.now() > REFRESH_SKEW_MS
      ? token
      : await exchangeCopilotToken(provider, token)
  syncCopilotQuota(provider, next)
  return next
}

export async function startProviderOAuth(
  providerId: string,
  options?: AbortSignal | StartOAuthFlowOptions
): Promise<void> {
  const provider = getProviderById(providerId)
  if (!provider) throw new Error('Provider not found')
  const config = resolveOAuthConfig(provider)
  if (!requiresOAuthConnectConfig(config) || !config) {
    throw new Error('OAuth config is incomplete')
  }

  const token = await startOAuthFlow(config, options)
  const finalToken = await finalizeOAuthToken(provider, token)
  setProviderAuth(providerId, buildOAuthProviderPatch(provider, finalToken))
}

export function disconnectProviderOAuth(providerId: string): void {
  const provider = getProviderById(providerId)
  if (provider && isCopilotProvider(provider)) {
    clearCopilotQuota(provider)
  }
  setProviderAuth(providerId, { oauth: undefined, apiKey: '' })
}

export async function applyManualProviderOAuth(providerId: string, rawJson: string): Promise<void> {
  const provider = getProviderById(providerId)
  if (!provider) throw new Error('Provider not found')
  const token = parseManualOAuthPayload(rawJson)
  if (!token) throw new Error('Invalid OAuth payload')
  const finalToken = await finalizeOAuthToken(provider, token)
  setProviderAuth(providerId, buildOAuthProviderPatch(provider, finalToken))
}

export async function refreshProviderOAuth(providerId: string, force = false): Promise<boolean> {
  const provider = getProviderById(providerId)
  if (!provider || provider.authMode !== 'oauth') return false
  const config = resolveOAuthConfig(provider)
  if (!config || !config.tokenUrl || !config.clientId) return false
  const current = provider.oauth
  if (!current?.refreshToken) return false

  const expiresAt = current.expiresAt ?? 0
  if (!force && expiresAt && expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return true
  }

  const next = await refreshOAuthFlow(config, current.refreshToken)
  const mergedToken = {
    ...current,
    ...next,
    refreshToken: next.refreshToken ?? current.refreshToken
  }
  const finalToken = await finalizeOAuthToken(provider, mergedToken)
  setProviderAuth(providerId, buildOAuthProviderPatch(provider, finalToken))
  return true
}

export async function ensureProviderAuthReady(providerId: string): Promise<boolean> {
  const provider = getProviderById(providerId)
  if (!provider) return false

  const authMode = provider.authMode ?? 'apiKey'
  if (authMode === 'apiKey') {
    if (provider.requiresApiKey === false) return true
    return !!provider.apiKey
  }

  if (authMode === 'oauth') {
    let latestProvider = provider
    let token = latestProvider.oauth
    if (!token?.accessToken) return false

    const expiresAt = token.expiresAt ?? 0
    if (expiresAt && expiresAt - Date.now() <= REFRESH_SKEW_MS) {
      try {
        const refreshed = await refreshProviderOAuth(providerId, true)
        if (!refreshed) return false
        latestProvider = getProviderById(providerId) ?? latestProvider
        token = latestProvider.oauth
        if (!token?.accessToken) return false
      } catch {
        return false
      }
    }

    if (isCopilotProvider(latestProvider)) {
      const copilotExpiresAt = token.copilotExpiresAt ?? 0
      if (
        !token.copilotAccessToken ||
        (copilotExpiresAt && copilotExpiresAt - Date.now() <= REFRESH_SKEW_MS)
      ) {
        try {
          const next = await exchangeCopilotToken(latestProvider, token)
          setProviderAuth(providerId, buildOAuthProviderPatch(latestProvider, next))
          return true
        } catch {
          return false
        }
      }
      const apiKey = resolveCopilotApiKey(token)
      if (!apiKey) return false
      if (
        latestProvider.apiKey !== apiKey ||
        (token.copilotApiUrl && latestProvider.baseUrl !== token.copilotApiUrl)
      ) {
        setProviderAuth(providerId, {
          apiKey,
          ...(token.copilotApiUrl ? { baseUrl: token.copilotApiUrl } : {})
        })
      }
      syncCopilotQuota(latestProvider, token)
      return true
    }

    if (!latestProvider.apiKey) {
      setProviderAuth(providerId, { apiKey: token.accessToken })
    }
    return true
  }

  if (authMode === 'channel') {
    const accessToken = provider.channel?.accessToken
    if (!accessToken) return false
    if (!provider.apiKey) {
      setProviderAuth(providerId, { apiKey: accessToken })
    }
    const expiresAt = provider.channel?.accessTokenExpiresAt
    if (expiresAt && Date.now() > expiresAt) {
      return false
    }
    return true
  }

  return false
}

export async function sendProviderChannelCode(args: {
  providerId: string
  channelType: 'sms' | 'email'
  mobile?: string
  email?: string
}): Promise<void> {
  const provider = getProviderById(args.providerId)
  if (!provider) throw new Error('Provider not found')
  if (!provider.channelConfig) throw new Error('Channel config missing')
  const appId =
    provider.channel?.appId?.trim() || provider.channelConfig?.defaultAppId?.trim() || ''
  const appToken = provider.channel?.appToken?.trim() || ''

  await sendChannelCode({
    config: provider.channelConfig,
    appId,
    appToken,
    channelType: args.channelType,
    mobile: args.mobile,
    email: args.email
  })
}

export async function verifyProviderChannelCode(args: {
  providerId: string
  channelType: 'sms' | 'email'
  code: string
  mobile?: string
  email?: string
}): Promise<void> {
  const provider = getProviderById(args.providerId)
  if (!provider) throw new Error('Provider not found')
  if (!provider.channelConfig) throw new Error('Channel config missing')
  const appId =
    provider.channel?.appId?.trim() || provider.channelConfig?.defaultAppId?.trim() || ''
  const appToken = provider.channel?.appToken?.trim() || ''

  const { accessToken } = await verifyChannelCode({
    config: provider.channelConfig,
    appId,
    appToken,
    channelType: args.channelType,
    code: args.code,
    mobile: args.mobile,
    email: args.email
  })

  let userInfo: Record<string, unknown> | undefined
  try {
    userInfo = await fetchChannelUserInfo(provider.channelConfig, accessToken)
  } catch {
    userInfo = undefined
  }

  setProviderAuth(args.providerId, {
    authMode: 'channel',
    channel: {
      appId,
      appToken,
      accessToken,
      channelType: args.channelType,
      userInfo
    },
    apiKey: accessToken
  })
}

export async function refreshProviderChannelUserInfo(providerId: string): Promise<void> {
  const provider = getProviderById(providerId)
  if (!provider?.channelConfig || !provider.channel?.accessToken) return
  const userInfo = await fetchChannelUserInfo(provider.channelConfig, provider.channel.accessToken)
  setProviderAuth(providerId, {
    channel: {
      ...(provider.channel ?? { appId: '', appToken: '' }),
      userInfo
    }
  })
}

export function clearProviderChannelAuth(providerId: string): void {
  setProviderAuth(providerId, { channel: undefined, apiKey: '' })
}
