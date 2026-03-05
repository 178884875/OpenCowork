import type { ProviderConfig } from './types'

const IMAGE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000

export type OpenAIImagesRequestErrorCode =
  | 'timeout'
  | 'network'
  | 'request_aborted'
  | 'api_error'
  | 'unknown'

export class OpenAIImagesRequestError extends Error {
  readonly code: OpenAIImagesRequestErrorCode
  readonly statusCode?: number

  constructor(message: string, options: { code: OpenAIImagesRequestErrorCode; statusCode?: number }) {
    super(message)
    this.name = 'OpenAIImagesRequestError'
    this.code = options.code
    this.statusCode = options.statusCode
  }
}

export interface Base64ImageInput {
  dataUrl: string
  mediaType?: string
}

interface OpenAiImageResponseItem {
  b64_json?: string
  url?: string
  revised_prompt?: string
}

export interface GeneratedImage {
  sourceType: 'base64' | 'url'
  data: string
  mediaType: string
}

function getBaseUrl(config: ProviderConfig): string {
  return (config.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '')
}

function ensureApiKey(config: ProviderConfig): void {
  if (!config.apiKey) {
    throw new Error('Missing API key for OpenAI image request')
  }
}

function dataUrlToBlob(input: Base64ImageInput): Blob {
  const [header, data] = input.dataUrl.split(',')
  if (!data) {
    throw new Error('Invalid data URL for image attachment')
  }
  const mimeMatch = /data:(.*?);base64/.exec(header)
  const mediaType = input.mediaType || mimeMatch?.[1] || 'application/octet-stream'
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mediaType })
}

function normalizeImageResults(items: OpenAiImageResponseItem[]): GeneratedImage[] {
  return items
    .map((item) => {
      if (item.b64_json) {
        // Detect media type from base64 data (first few bytes)
        let mediaType = 'image/png'
        try {
          const header = item.b64_json.substring(0, 20)
          const binary = atob(header)
          // PNG signature: 89 50 4E 47
          if (binary.charCodeAt(0) === 0x89 && binary.charCodeAt(1) === 0x50) {
            mediaType = 'image/png'
          }
          // JPEG signature: FF D8 FF
          else if (binary.charCodeAt(0) === 0xFF && binary.charCodeAt(1) === 0xD8) {
            mediaType = 'image/jpeg'
          }
          // WebP signature: RIFF....WEBP
          else if (binary.substring(0, 4) === 'RIFF' && binary.substring(8, 12) === 'WEBP') {
            mediaType = 'image/webp'
          }
        } catch (e) {
          console.warn('[OpenAI Images] Failed to detect image type, defaulting to PNG:', e)
        }
        return { sourceType: 'base64', data: item.b64_json, mediaType }
      }
      if (item.url) {
        return { sourceType: 'url', data: item.url, mediaType: 'url' }
      }
      return null
    })
    .filter((item): item is GeneratedImage => Boolean(item))
}

function createRequestSignal(signal?: AbortSignal): {
  signal: AbortSignal
  didTimeout: () => boolean
  cleanup: () => void
} {
  const timeoutController = new AbortController()
  let timedOut = false
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const onParentAbort = (): void => {
    timeoutController.abort(signal?.reason)
  }

  if (signal?.aborted) {
    timeoutController.abort(signal.reason)
  } else {
    signal?.addEventListener('abort', onParentAbort, { once: true })
  }

  if (!timeoutController.signal.aborted) {
    timeoutId = setTimeout(() => {
      timedOut = true
      timeoutController.abort(new DOMException('Image request timed out', 'TimeoutError'))
    }, IMAGE_REQUEST_TIMEOUT_MS)
  }

  return {
    signal: timeoutController.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      signal?.removeEventListener('abort', onParentAbort)
    },
  }
}

function mapFetchError(error: unknown, didTimeout: boolean): OpenAIImagesRequestError {
  if (didTimeout) {
    return new OpenAIImagesRequestError('Image request timed out after 10 minutes', {
      code: 'timeout',
    })
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new OpenAIImagesRequestError('Image request was cancelled', {
      code: 'request_aborted',
    })
  }

  if (error instanceof TypeError) {
    return new OpenAIImagesRequestError(
      `Network request failed while generating image. Please check your network, proxy, and Base URL settings. (${error.message})`,
      { code: 'network' }
    )
  }

  if (error instanceof OpenAIImagesRequestError) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  return new OpenAIImagesRequestError(message || 'Unknown image request error', {
    code: 'unknown',
  })
}

export async function generateImagesFromText(params: {
  config: ProviderConfig
  prompt: string
  size?: string
  quality?: 'standard' | 'hd'
  signal?: AbortSignal
}): Promise<GeneratedImage[]> {
  const { config, prompt, signal } = params
  ensureApiKey(config)
  const url = `${getBaseUrl(config)}/images/generations`
  const body: Record<string, unknown> = {
    model: config.model,
    prompt,
  }

  const requestSignal = createRequestSignal(signal)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        ...(config.organization ? { 'OpenAI-Organization': config.organization } : {}),
        ...(config.project ? { 'OpenAI-Project': config.project } : {}),
      },
      body: JSON.stringify(body),
      signal: requestSignal.signal,
    })
  } catch (error) {
    throw mapFetchError(error, requestSignal.didTimeout())
  } finally {
    requestSignal.cleanup()
  }

  if (!response.ok) {
    let errorMessage = `Image generation failed: ${response.status}`
    try {
      const errorData = await response.json()
      if (errorData.error?.message) {
        errorMessage = errorData.error.message
      } else if (errorData.message) {
        errorMessage = errorData.message
      } else {
        errorMessage = JSON.stringify(errorData)
      }
    } catch {
      const errorText = await response.text().catch(() => 'Unknown error')
      errorMessage = errorText
    }
    console.error('[OpenAI Images] Generation failed:', errorMessage)
    throw new OpenAIImagesRequestError(errorMessage, {
      code: 'api_error',
      statusCode: response.status,
    })
  }

  const data = (await response.json()) as { data?: OpenAiImageResponseItem[] }
  const items = data.data ?? []
  if (items.length === 0) {
    throw new OpenAIImagesRequestError('Image generation returned no results', {
      code: 'api_error',
    })
  }

  console.log('[OpenAI Images] Generation response:', items)
  return normalizeImageResults(items)
}

export async function editImageWithPrompt(params: {
  config: ProviderConfig
  prompt: string
  image: Base64ImageInput
  size?: string
  signal?: AbortSignal
}): Promise<GeneratedImage[]> {
  const { config, prompt, image, signal } = params
  ensureApiKey(config)
  const url = `${getBaseUrl(config)}/images/edits`

  const formData = new FormData()
  formData.append('model', config.model)
  formData.append('prompt', prompt)
  formData.append('image', dataUrlToBlob(image), 'image.png')

  const requestSignal = createRequestSignal(signal)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(config.organization ? { 'OpenAI-Organization': config.organization } : {}),
        ...(config.project ? { 'OpenAI-Project': config.project } : {}),
      },
      body: formData,
      signal: requestSignal.signal,
    })
  } catch (error) {
    throw mapFetchError(error, requestSignal.didTimeout())
  } finally {
    requestSignal.cleanup()
  }

  if (!response.ok) {
    let errorMessage = `Image edit failed: ${response.status}`
    try {
      const errorData = await response.json()
      if (errorData.error?.message) {
        errorMessage = errorData.error.message
      } else if (errorData.message) {
        errorMessage = errorData.message
      } else {
        errorMessage = JSON.stringify(errorData)
      }
    } catch {
      const errorText = await response.text().catch(() => 'Unknown error')
      errorMessage = errorText
    }
    console.error('[OpenAI Images] Edit failed:', errorMessage)
    throw new OpenAIImagesRequestError(errorMessage, {
      code: 'api_error',
      statusCode: response.status,
    })
  }

  const data = (await response.json()) as { data?: OpenAiImageResponseItem[] }
  const items = data.data ?? []
  if (items.length === 0) {
    throw new OpenAIImagesRequestError('Image edit returned no results', {
      code: 'api_error',
    })
  }

  console.log('[OpenAI Images] Edit response:', items)
  return normalizeImageResults(items)
}
