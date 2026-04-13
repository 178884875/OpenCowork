import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunks: string[] = []
  const chunkSize = 8192

  for (let index = 0; index < bytes.length; index += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + chunkSize)))
  }

  return btoa(chunks.join(''))
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex === -1) throw new Error('Invalid data URL')

  const metadata = dataUrl.slice(5, commaIndex)
  const data = dataUrl.slice(commaIndex + 1)
  const mimeType = metadata.split(';')[0] || 'application/octet-stream'

  if (metadata.includes(';base64')) {
    const binary = window.atob(data)
    const bytes = new Uint8Array(binary.length)

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }

    return new Blob([bytes], { type: mimeType })
  }

  return new Blob([decodeURIComponent(data)], { type: mimeType })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Failed to load image'))
    image.src = src
  })
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob)
        return
      }
      reject(new Error('Failed to export image'))
    }, 'image/png')
  })
}

async function convertBlobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob

  const objectUrl = URL.createObjectURL(blob)

  try {
    const image = await loadImage(objectUrl)
    const width = image.naturalWidth || image.width
    const height = image.naturalHeight || image.height

    if (!width || !height) {
      throw new Error('Image is not ready')
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas context unavailable')

    context.drawImage(image, 0, 0, width, height)
    return await canvasToPngBlob(canvas)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function writeImageBlobViaBrowserClipboard(blob: Blob): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    return false
  }

  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return true
  } catch (error) {
    console.warn('[Clipboard] Browser image write failed:', error)
    return false
  }
}

export async function writeImageBlobToClipboard(blob: Blob): Promise<void> {
  const pngBlob = await convertBlobToPng(blob)

  if (await writeImageBlobViaBrowserClipboard(pngBlob)) {
    return
  }

  const result = (await ipcClient.invoke(IPC.CLIPBOARD_WRITE_IMAGE, {
    data: arrayBufferToBase64(await pngBlob.arrayBuffer())
  })) as {
    success?: boolean
    error?: string
  }

  if (!result?.success) {
    throw new Error(result?.error || 'Clipboard write failed')
  }
}

export async function writeImageDataUrlToClipboard(dataUrl: string): Promise<void> {
  await writeImageBlobToClipboard(dataUrlToBlob(dataUrl))
}
