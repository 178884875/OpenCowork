export interface SelectFileTextSegment {
  type: 'text' | 'file'
  text: string
  raw: string
}

export interface SelectFileMentionQuery {
  start: number
  end: number
  query: string
}

export interface SelectFileTagRange {
  start: number
  end: number
  text: string
  raw: string
  syntax: 'tag' | 'token'
}

const SELECT_FILE_TAG_RE = /<select-file>([\s\S]*?)<\/select-file>/gi
const SELECT_FILE_TOKEN_RE = /@\{([^}\r\n]+)\}/g
const SELECT_FILE_TAG_TEST_RE = /<select-file>[\s\S]*?<\/select-file>/i
const SELECT_FILE_TOKEN_TEST_RE = /@\{[^}\r\n]+\}/

function decodeTagText(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function encodeTagText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function normalizeFilePath(value: string): string {
  return value.replace(/\\/g, '/').trim()
}

function collectSelectFileRanges(text: string): SelectFileTagRange[] {
  if (!text) return []

  const ranges: SelectFileTagRange[] = []

  for (const match of text.matchAll(SELECT_FILE_TAG_RE)) {
    const start = match.index ?? -1
    const raw = match[0] ?? ''
    if (start < 0 || !raw) continue
    ranges.push({
      start,
      end: start + raw.length,
      raw,
      text: normalizeFilePath(decodeTagText(match[1] ?? '')),
      syntax: 'tag'
    })
  }

  for (const match of text.matchAll(SELECT_FILE_TOKEN_RE)) {
    const start = match.index ?? -1
    const raw = match[0] ?? ''
    if (start < 0 || !raw) continue
    ranges.push({
      start,
      end: start + raw.length,
      raw,
      text: normalizeFilePath(match[1] ?? ''),
      syntax: 'token'
    })
  }

  ranges.sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start
    return left.end - right.end
  })

  const merged: SelectFileTagRange[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous && range.start < previous.end) continue
    if (!range.text) continue
    merged.push(range)
  }

  return merged
}

export function createSelectFileTag(filePath: string): string {
  const normalized = normalizeFilePath(filePath)
  if (!normalized) return ''
  return `<select-file>${encodeTagText(normalized)}</select-file>`
}

export function createSelectFileToken(filePath: string): string {
  const normalized = normalizeFilePath(filePath)
  if (!normalized || normalized.includes('}')) return ''
  return `@{${normalized}}`
}

export function parseSelectFileText(text: string): SelectFileTextSegment[] {
  if (!text) return []

  const segments: SelectFileTextSegment[] = []
  let lastIndex = 0

  for (const range of collectSelectFileRanges(text)) {
    if (range.start > lastIndex) {
      const plainText = text.slice(lastIndex, range.start)
      if (plainText) {
        segments.push({ type: 'text', text: plainText, raw: plainText })
      }
    }

    segments.push({
      type: 'file',
      text: range.text,
      raw: range.raw
    })

    lastIndex = range.end
  }

  if (lastIndex < text.length) {
    const plainText = text.slice(lastIndex)
    if (plainText) {
      segments.push({ type: 'text', text: plainText, raw: plainText })
    }
  }

  return segments
}

export function getSelectFileTagRanges(text: string): SelectFileTagRange[] {
  return collectSelectFileRanges(text)
}

export function hasSelectFileTag(text: string): boolean {
  return SELECT_FILE_TAG_TEST_RE.test(text) || SELECT_FILE_TOKEN_TEST_RE.test(text)
}

export function selectFileTextToPlainText(text: string): string {
  const segments = parseSelectFileText(text)
  if (segments.length === 0) return text
  return segments.map((segment) => segment.text).join('')
}

export function normalizeSelectFileText(text: string): string {
  if (!text) return ''
  const segments = parseSelectFileText(text)
  if (segments.length === 0) return text
  return segments
    .map((segment) => (segment.type === 'file' ? createSelectFileToken(segment.text) : segment.raw))
    .join('')
}

export function serializeSelectFileText(text: string): string {
  if (!text) return ''
  const segments = parseSelectFileText(text)
  if (segments.length === 0) return text
  return segments
    .map((segment) => (segment.type === 'file' ? createSelectFileTag(segment.text) : segment.raw))
    .join('')
}

export function findSelectFileTagAt(text: string, cursor: number): SelectFileTagRange | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length))
  for (const range of collectSelectFileRanges(text)) {
    if (safeCursor > range.start && safeCursor < range.end) {
      return range
    }
  }
  return null
}

export function getSelectFileMentionQuery(
  text: string,
  cursor: number
): SelectFileMentionQuery | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length))
  if (findSelectFileTagAt(text, safeCursor)) return null

  let mentionStart = -1

  for (let index = safeCursor - 1; index >= 0; index -= 1) {
    const char = text[index]
    if (/\s/.test(char)) break
    if (char === '}' || char === '<' || char === '>') return null
    if (char === '@') {
      if (text[index + 1] === '{') return null
      mentionStart = index
      break
    }
  }

  if (mentionStart < 0) return null

  const prefixChar = mentionStart > 0 ? text[mentionStart - 1] : ''
  if (prefixChar && /[A-Za-z0-9_./\\-]/.test(prefixChar)) {
    return null
  }

  return {
    start: mentionStart,
    end: safeCursor,
    query: text.slice(mentionStart + 1, safeCursor)
  }
}
