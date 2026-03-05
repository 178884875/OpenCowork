import type {
  APIProvider,
  ImageErrorCode,
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  UnifiedMessage,
  ContentBlock,
  ImageBlock,
} from './types'
import {
  generateImagesFromText,
  editImageWithPrompt,
  OpenAIImagesRequestError,
  type Base64ImageInput,
} from './openai-images'
import { registerProvider } from './provider'

function normalizeImageProviderError(error: unknown): { code: ImageErrorCode; message: string } {
  if (error instanceof OpenAIImagesRequestError) {
    return {
      code: error.code,
      message: error.message
    }
  }

  if (error instanceof TypeError) {
    return {
      code: 'network',
      message: `Network request failed while generating image. ${error.message}`
    }
  }

  return {
    code: 'unknown',
    message: error instanceof Error ? error.message : String(error)
  }
}

class OpenAIImagesProvider implements APIProvider {
  readonly name = 'OpenAI Images'
  readonly type = 'openai-images' as const

  async *sendMessage(
    messages: UnifiedMessage[],
    _tools: ToolDefinition[],
    config: ProviderConfig,
    signal?: AbortSignal
  ): AsyncIterable<StreamEvent> {
    const requestStartedAt = Date.now()

    console.log('[OpenAI Images Provider] sendMessage called with config:', {
      type: config.type,
      model: config.model,
      baseUrl: config.baseUrl
    })

    try {
      yield { type: 'message_start' }

      // Extract the last user message
      const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
      if (!lastUserMessage) {
        throw new Error('No user message found')
      }

      // Extract text prompt and check for images
      let textPrompt = ''
      let imageInput: Base64ImageInput | null = null

      if (typeof lastUserMessage.content === 'string') {
        textPrompt = lastUserMessage.content
      } else {
        const contentBlocks = lastUserMessage.content as ContentBlock[]
        for (const block of contentBlocks) {
          if (block.type === 'text') {
            textPrompt += block.text
          } else if (block.type === 'image' && !imageInput) {
            // Use the first image for editing
            const imgBlock = block as ImageBlock
            if (imgBlock.source.type === 'base64') {
              imageInput = {
                dataUrl: `data:${imgBlock.source.mediaType || 'image/png'};base64,${imgBlock.source.data}`,
                mediaType: imgBlock.source.mediaType,
              }
            } else if (imgBlock.source.type === 'url' && imgBlock.source.url) {
              // For URL images, we'd need to fetch and convert to base64
              // For now, skip URL images
              continue
            }
          }
        }
      }

      if (!textPrompt.trim()) {
        textPrompt = 'Edit this image'
      }

      // Call appropriate API based on whether we have an image
      let results
      if (imageInput) {
        // Image editing - no text delta, just generate
        results = await editImageWithPrompt({
          config,
          prompt: textPrompt,
          image: imageInput,
          signal,
        })
      } else {
        // Text-to-image generation - no text delta, just generate
        results = await generateImagesFromText({
          config,
          prompt: textPrompt,
          signal,
        })
      }

      // Yield each generated image as an image_generated event
      for (const img of results) {
        const imageBlock: ImageBlock = {
          type: 'image',
          source:
            img.sourceType === 'base64'
              ? { type: 'base64', mediaType: img.mediaType, data: img.data }
              : { type: 'url', url: img.data },
        }
        yield { type: 'image_generated', imageBlock }
      }

      // Yield completion event with image results
      const requestCompletedAt = Date.now()
      yield {
        type: 'message_end',
        stopReason: 'stop',
        timing: {
          totalMs: requestCompletedAt - requestStartedAt,
          ttftMs: requestCompletedAt - requestStartedAt,
        },
      }
    } catch (error) {
      const normalizedError = normalizeImageProviderError(error)
      console.error('[OpenAI Images Provider] Error:', normalizedError.message, error)

      // Yield a structured image error so UI can render a friendly card
      yield {
        type: 'image_error',
        imageError: {
          code: normalizedError.code,
          message: normalizedError.message
        }
      }

      const requestCompletedAt = Date.now()
      yield {
        type: 'message_end',
        stopReason: 'error',
        timing: {
          totalMs: requestCompletedAt - requestStartedAt,
          ttftMs: requestCompletedAt - requestStartedAt,
        },
      }

      return
    }
  }

  formatMessages(messages: UnifiedMessage[]): unknown {
    void messages
    return []
  }

  formatTools(tools: ToolDefinition[]): unknown {
    void tools
    return []
  }
}

export function registerOpenAIImagesProvider(): void {
  registerProvider('openai-images', () => new OpenAIImagesProvider())
}
