import { nanoid } from 'nanoid'
import { joinFsPath } from '@renderer/lib/agent/memory-files'
import { createProvider } from '@renderer/lib/api/provider'
import type {
  ImageBlock,
  TextBlock,
  ToolResultContent,
  UnifiedMessage
} from '@renderer/lib/api/types'
import { IPC } from '@renderer/lib/ipc/channels'
import type { ToolContext, ToolHandler } from '@renderer/lib/tools/tool-types'
import { useAppPluginStore } from '@renderer/stores/app-plugin-store'
import { IMAGE_GENERATE_TOOL_NAME } from './types'

function normalizeCount(input: unknown): number {
  const parsed = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(parsed)) return 1
  return Math.max(1, Math.min(4, Math.floor(parsed)))
}

function isErrorResult(value: unknown): value is { error: string } {
  if (!value || typeof value !== 'object') return false
  const error = (value as { error?: unknown }).error
  return typeof error === 'string' && error.length > 0
}

function formatDateSegment(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function extensionFromMediaType(mediaType?: string): string {
  const normalized = mediaType?.split(';', 1)[0]?.trim().toLowerCase()

  switch (normalized) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'image/svg+xml':
      return 'svg'
    case 'image/png':
    default:
      return 'png'
  }
}

async function resolveImageOutputDir(ctx: ToolContext): Promise<string> {
  const homeDir = await ctx.ipc.invoke(IPC.APP_HOMEDIR)
  if (typeof homeDir !== 'string' || homeDir.trim().length === 0) {
    throw new Error('Failed to resolve current user home directory.')
  }

  return joinFsPath(homeDir, '.open-cowork', 'images', formatDateSegment())
}

async function resolveGeneratedImageBinary(
  image: ImageBlock,
  ctx: ToolContext
): Promise<{ data: string; mediaType: string }> {
  if (image.source.type === 'base64' && image.source.data) {
    return {
      data: image.source.data,
      mediaType: image.source.mediaType || 'image/png'
    }
  }

  if (image.source.type === 'url' && image.source.url) {
    const result = await ctx.ipc.invoke('image:fetch-base64', { url: image.source.url })
    if (isErrorResult(result)) {
      throw new Error(`Failed to download generated image: ${result.error}`)
    }

    const data = (result as { data?: unknown }).data
    const mimeType = (result as { mimeType?: unknown }).mimeType
    if (typeof data !== 'string' || data.length === 0) {
      throw new Error('Generated image download returned no data.')
    }

    return {
      data,
      mediaType: typeof mimeType === 'string' && mimeType ? mimeType : 'image/png'
    }
  }

  throw new Error('Generated image data is missing.')
}

async function persistGeneratedImage(
  image: ImageBlock,
  ctx: ToolContext,
  outputDir: string,
  index: number
): Promise<string> {
  const { data, mediaType } = await resolveGeneratedImageBinary(image, ctx)
  const fileName = `image-${Date.now()}-${index + 1}-${nanoid(8)}.${extensionFromMediaType(mediaType)}`
  const filePath = joinFsPath(outputDir, fileName)
  const writeResult = await ctx.ipc.invoke(IPC.FS_WRITE_FILE_BINARY, {
    path: filePath,
    data
  })

  if (isErrorResult(writeResult)) {
    throw new Error(`Failed to save generated image: ${writeResult.error}`)
  }

  return filePath
}

export const imageGenerateTool: ToolHandler = {
  definition: {
    name: IMAGE_GENERATE_TOOL_NAME,
    description:
      'Generate images when the user needs visual content. Use proactively whenever an image would help—whether they explicitly ask for one or imply a need (e.g. "show me", "what does X look like", creating illustrations/icons/diagrams, visualizing concepts). When writing the prompt: align with user intent, include subject/style/composition/mood, be specific and concrete, infer style from user wording. count defaults to 1, max 4.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'Complete visual prompt aligned with user intent. Include: subject, style (e.g. realistic, cartoon, minimalist), composition, lighting/mood. Be specific and concrete; infer style from user wording (e.g. "cute" → cute/kawaii style). Prefer concise, descriptive English; avoid vague or abstract phrasing.'
        },
        count: {
          type: 'number',
          description: 'How many images to generate. Defaults to 1 and is capped at 4.'
        }
      },
      required: ['prompt']
    }
  },
  execute: async (input, ctx): Promise<ToolResultContent> => {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    const count = normalizeCount(input.count)

    if (!prompt) {
      return JSON.stringify({ error: 'ImageGenerate requires a non-empty prompt.' })
    }

    const providerConfig = useAppPluginStore.getState().getResolvedImagePluginConfig()
    if (!providerConfig) {
      return JSON.stringify({
        error: 'Image plugin is disabled or has no valid image model configured.'
      })
    }

    const provider = createProvider(providerConfig)
    const outputDir = await resolveImageOutputDir(ctx)
    const images: ImageBlock[] = []
    const notes: TextBlock[] = []
    const savedPaths: string[] = []

    for (let index = 0; index < count; index += 1) {
      const userMessage: UnifiedMessage = {
        id: nanoid(),
        role: 'user',
        content: prompt,
        createdAt: Date.now()
      }

      let iterationFailed = false
      let iterationError = 'Unknown image generation error.'
      const iterationImages: ImageBlock[] = []

      for await (const event of provider.sendMessage(
        [userMessage],
        [],
        providerConfig,
        ctx.signal
      )) {
        if (event.type === 'image_generated' && event.imageBlock) {
          iterationImages.push(event.imageBlock)
        }

        if (event.type === 'image_error' && event.imageError) {
          iterationFailed = true
          iterationError = event.imageError.message
        }
      }

      if (iterationFailed) {
        if (images.length === 0) {
          return JSON.stringify({ error: iterationError })
        }

        notes.push({
          type: 'text',
          text: `Stopped after ${images.length} image(s). Request ${index + 1} failed: ${iterationError}`
        })
        break
      }

      try {
        const iterationSavedPaths: string[] = []
        for (const [imageIndex, image] of iterationImages.entries()) {
          const savedPath = await persistGeneratedImage(
            image,
            ctx,
            outputDir,
            savedPaths.length + imageIndex
          )
          iterationSavedPaths.push(savedPath)
        }

        images.push(...iterationImages)
        savedPaths.push(...iterationSavedPaths)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (images.length === 0) {
          return JSON.stringify({ error: message })
        }

        notes.push({
          type: 'text',
          text: `Stopped after ${images.length} image(s). Failed to persist image: ${message}`
        })
        break
      }
    }

    if (images.length === 0) {
      return JSON.stringify({ error: 'Image generation returned no images.' })
    }

    return [
      {
        type: 'text',
        text: `Saved image absolute paths:\n${savedPaths.join('\n')}`
      },
      ...images,
      ...notes
    ]
  },
  requiresApproval: () => false
}
