import type { Components } from 'react-markdown'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { IPC } from '../../ipc/channels'
import { ipcClient } from '../../ipc/ipc-client'
import { MermaidBlock } from './MermaidBlock'

const HTTP_URL_RE = /^https?:\/\//i
const FILE_URL_RE = /^file:\/\//i
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]/
const OTHER_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/
const ROOT_FILE_NAME_RE =
  /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|bun\.lock|tsconfig(?:\.[^.]+)?\.json|README(?:\.[A-Za-z0-9_-]+)?\.md|CHANGELOG\.md|LICENSE|AGENTS\.md|CLAUDE\.md|SOUL\.md|USER\.md|MEMORY\.md|Dockerfile|docker-compose(?:\.[A-Za-z0-9_-]+)?\.ya?ml|Makefile|\.env(?:\.[A-Za-z0-9_-]+)?)$/i
const SPECIAL_FILE_NAME_RE = /^(?:Dockerfile|Makefile|LICENSE)$/i
const EXPLICIT_LINE_RE = /(?::\d+(?::\d+)?)$|#L\d+(?:-L?\d+)?$/i

function getActiveSessionContext(): { workingFolder?: string; sshConnectionId?: string } {
  const chatState = useChatStore.getState()
  const activeSession = chatState.sessions.find(
    (session) => session.id === chatState.activeSessionId
  )

  return {
    workingFolder: activeSession?.workingFolder?.trim(),
    sshConnectionId: activeSession?.sshConnectionId
  }
}

function stripLocalPathDecorators(value: string): string {
  let normalized = value.trim()
  const queryIndex = normalized.indexOf('?')
  if (queryIndex >= 0) normalized = normalized.slice(0, queryIndex)
  const hashIndex = normalized.indexOf('#')
  if (hashIndex >= 0) normalized = normalized.slice(0, hashIndex)
  if (/(?<!^[a-zA-Z]):\d+(?::\d+)?$/.test(normalized)) {
    normalized = normalized.replace(/:\d+(?::\d+)?$/, '')
  }
  return normalized
}

function decodeFileUrlPath(value: string): string {
  try {
    const url = new URL(value)
    let pathname = decodeURIComponent(url.pathname || '')
    if (/^\/[a-zA-Z]:/.test(pathname)) pathname = pathname.slice(1)
    if (url.host) {
      return `//${decodeURIComponent(url.host)}${pathname}`
    }
    return pathname
  } catch {
    const raw = value.replace(FILE_URL_RE, '')
    const normalized = raw.startsWith('/') && /^\/[a-zA-Z]:/.test(raw) ? raw.slice(1) : raw
    try {
      return decodeURIComponent(normalized)
    } catch {
      return normalized
    }
  }
}

function hasFileLikeName(value: string): boolean {
  const lastSegment = value.split(/[\\/]/).pop()?.trim() ?? ''
  if (!lastSegment) return false
  return /\.[A-Za-z0-9._-]+$/.test(lastSegment) || SPECIAL_FILE_NAME_RE.test(lastSegment)
}

function joinPath(baseDir: string, relativePath: string): string {
  const trimmedBase = baseDir.replace(/[\\/]+$/, '')
  const trimmedRelative = relativePath.replace(/^\.[\\/]/, '')
  const separator = trimmedBase.includes('\\') && !trimmedBase.includes('/') ? '\\' : '/'
  return `${trimmedBase}${separator}${trimmedRelative}`
}

export function isLikelyLocalFilePath(value: string): boolean {
  const raw = value.trim()
  if (!raw || raw.startsWith('#') || HTTP_URL_RE.test(raw)) return false
  if (FILE_URL_RE.test(raw)) return true

  const normalized = stripLocalPathDecorators(raw)
  if (!normalized) return false
  if (OTHER_SCHEME_RE.test(normalized) && !WINDOWS_ABSOLUTE_PATH_RE.test(normalized)) return false

  if (
    WINDOWS_ABSOLUTE_PATH_RE.test(normalized) ||
    normalized.startsWith('\\\\') ||
    normalized.startsWith('/') ||
    normalized.startsWith('./') ||
    normalized.startsWith('../')
  ) {
    return hasFileLikeName(normalized)
  }

  if (normalized.includes('/') || normalized.includes('\\')) {
    return hasFileLikeName(normalized)
  }

  return ROOT_FILE_NAME_RE.test(normalized)
}

export function resolveLocalFilePath(value: string, filePath?: string): string | null {
  if (!isLikelyLocalFilePath(value)) return null

  let target = FILE_URL_RE.test(value) ? decodeFileUrlPath(value) : stripLocalPathDecorators(value)
  try {
    target = decodeURIComponent(target)
  } catch {
    // ignore decode failures and keep original target
  }

  if (
    WINDOWS_ABSOLUTE_PATH_RE.test(target) ||
    target.startsWith('\\\\') ||
    target.startsWith('/')
  ) {
    return target
  }

  const baseDir =
    (filePath ? filePath.replace(/[\\/][^\\/]*$/, '') : getActiveSessionContext().workingFolder) ||
    ''
  if (!baseDir) return null

  return joinPath(baseDir, target)
}

export function openLocalFilePath(value: string, filePath?: string): boolean {
  const resolved = resolveLocalFilePath(value, filePath)
  if (!resolved) return false

  const { sshConnectionId } = getActiveSessionContext()
  const viewMode = EXPLICIT_LINE_RE.test(value.trim()) ? 'code' : undefined
  useUIStore.getState().openFilePreview(resolved, viewMode, sshConnectionId)
  return true
}

export function openMarkdownHref(href: string, filePath?: string): boolean {
  const link = href.trim()
  if (!link) return false
  if (HTTP_URL_RE.test(link)) {
    void ipcClient.invoke(IPC.SHELL_OPEN_EXTERNAL, link)
    return true
  }
  return openLocalFilePath(link, filePath)
}

export function createMarkdownComponents(filePath?: string): Components {
  const fileDir = filePath ? filePath.replace(/[\\/][^\\/]*$/, '') : ''

  return {
    a: ({ href, children, ...props }) => {
      const link = href?.trim() || ''

      return (
        <a
          {...props}
          href={link || href}
          className="text-primary underline underline-offset-2 hover:text-primary/80 break-all"
          title={link || href}
          onClick={(event) => {
            const handled = link ? openMarkdownHref(link, filePath) : false
            if (handled) event.preventDefault()
          }}
        >
          {children}
        </a>
      )
    },
    p: ({ children, ...props }) => (
      <p className="whitespace-pre-wrap break-words" {...props}>
        {children}
      </p>
    ),
    li: ({ children, ...props }) => (
      <li className="break-words [&>p]:whitespace-pre-wrap" {...props}>
        {children}
      </li>
    ),
    th: ({ children, ...props }) => (
      <th className="whitespace-pre-wrap break-words" {...props}>
        {children}
      </th>
    ),
    td: ({ children, ...props }) => (
      <td className="whitespace-pre-wrap break-words" {...props}>
        {children}
      </td>
    ),
    img: ({ src, alt, ...props }) => {
      let resolvedSrc = src || ''
      if (
        fileDir &&
        resolvedSrc &&
        !resolvedSrc.startsWith('http') &&
        !resolvedSrc.startsWith('data:') &&
        !resolvedSrc.startsWith('file://')
      ) {
        const sep = fileDir.includes('/') ? '/' : '\\'
        resolvedSrc = `file://${fileDir}${sep}${resolvedSrc.replace(/^\.[/\\]/, '')}`
      }
      return (
        <img
          {...props}
          src={resolvedSrc}
          alt={alt || ''}
          className="my-4 block max-w-full rounded-lg border border-border/50 shadow-sm"
          loading="lazy"
        />
      )
    },
    pre: ({ children }) => <>{children}</>,
    code: ({ children, className }) => {
      const code = String(children ?? '').replace(/\n$/, '')
      const languageMatch = /language-([\w-]+)/.exec(className || '')
      const language = languageMatch?.[1]?.toLowerCase()

      if (!className) {
        const resolvedPath = resolveLocalFilePath(code, filePath)
        if (resolvedPath) {
          return (
            <button
              type="button"
              className="cursor-pointer rounded bg-muted px-1 py-0.5 text-xs font-mono text-primary underline-offset-2 hover:underline"
              title={resolvedPath}
              onClick={() => {
                void openLocalFilePath(code, filePath)
              }}
            >
              {children}
            </button>
          )
        }
        return <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>
      }

      if (language === 'mermaid') {
        return <MermaidBlock code={code} />
      }

      return (
        <pre className="my-3 overflow-x-auto rounded-md bg-muted/60 p-3 text-xs">
          <code className={className}>{children}</code>
        </pre>
      )
    }
  }
}
