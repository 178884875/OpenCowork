import * as React from 'react'
import { useTheme } from 'next-themes'

type AsyncLightHighlighter = React.ComponentType<Record<string, unknown>> & {
  registerLanguage?: (name: string, grammar: unknown) => void
}

interface HighlighterRuntime {
  Highlighter: AsyncLightHighlighter
  darkStyle: Record<string, React.CSSProperties>
  lightStyle: Record<string, React.CSSProperties>
}

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  sh: 'bash',
  shell: 'bash',
  cs: 'csharp',
  yml: 'yaml',
  md: 'markdown',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  text: 'plaintext'
}

const LANGUAGE_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import('react-syntax-highlighter/dist/esm/languages/prism/typescript'),
  javascript: () => import('react-syntax-highlighter/dist/esm/languages/prism/javascript'),
  python: () => import('react-syntax-highlighter/dist/esm/languages/prism/python'),
  bash: () => import('react-syntax-highlighter/dist/esm/languages/prism/bash'),
  json: () => import('react-syntax-highlighter/dist/esm/languages/prism/json'),
  css: () => import('react-syntax-highlighter/dist/esm/languages/prism/css'),
  scss: () => import('react-syntax-highlighter/dist/esm/languages/prism/scss'),
  less: () => import('react-syntax-highlighter/dist/esm/languages/prism/less'),
  jsx: () => import('react-syntax-highlighter/dist/esm/languages/prism/jsx'),
  tsx: () => import('react-syntax-highlighter/dist/esm/languages/prism/tsx'),
  markdown: () => import('react-syntax-highlighter/dist/esm/languages/prism/markdown'),
  yaml: () => import('react-syntax-highlighter/dist/esm/languages/prism/yaml'),
  rust: () => import('react-syntax-highlighter/dist/esm/languages/prism/rust'),
  go: () => import('react-syntax-highlighter/dist/esm/languages/prism/go'),
  sql: () => import('react-syntax-highlighter/dist/esm/languages/prism/sql'),
  graphql: () => import('react-syntax-highlighter/dist/esm/languages/prism/graphql'),
  c: () => import('react-syntax-highlighter/dist/esm/languages/prism/c'),
  csharp: () => import('react-syntax-highlighter/dist/esm/languages/prism/csharp'),
  cpp: () => import('react-syntax-highlighter/dist/esm/languages/prism/cpp'),
  java: () => import('react-syntax-highlighter/dist/esm/languages/prism/java'),
  kotlin: () => import('react-syntax-highlighter/dist/esm/languages/prism/kotlin'),
  ruby: () => import('react-syntax-highlighter/dist/esm/languages/prism/ruby'),
  php: () => import('react-syntax-highlighter/dist/esm/languages/prism/php'),
  swift: () => import('react-syntax-highlighter/dist/esm/languages/prism/swift'),
  docker: () => import('react-syntax-highlighter/dist/esm/languages/prism/docker'),
  makefile: () => import('react-syntax-highlighter/dist/esm/languages/prism/makefile'),
  r: () => import('react-syntax-highlighter/dist/esm/languages/prism/r'),
  lua: () => import('react-syntax-highlighter/dist/esm/languages/prism/lua'),
  dart: () => import('react-syntax-highlighter/dist/esm/languages/prism/dart'),
  toml: () => import('react-syntax-highlighter/dist/esm/languages/prism/toml'),
  ini: () => import('react-syntax-highlighter/dist/esm/languages/prism/ini'),
  markup: () => import('react-syntax-highlighter/dist/esm/languages/prism/markup')
}

let runtimePromise: Promise<HighlighterRuntime> | null = null
const loadedLanguages = new Set<string>()
const loadingLanguages = new Map<string, Promise<void>>()

function normalizeLanguage(language?: string): string {
  if (!language) return 'plaintext'
  const normalized = language.toLowerCase().trim()
  return LANGUAGE_ALIASES[normalized] ?? normalized
}

async function ensureRuntime(): Promise<HighlighterRuntime> {
  if (runtimePromise) return runtimePromise
  runtimePromise = Promise.all([
    import('react-syntax-highlighter/dist/esm/prism-async-light'),
    import('react-syntax-highlighter/dist/esm/styles/prism')
  ]).then(([highlighterMod, styleMod]) => ({
    Highlighter: highlighterMod.default as unknown as AsyncLightHighlighter,
    darkStyle: styleMod.oneDark,
    lightStyle: styleMod.oneLight
  }))
  return runtimePromise
}

async function ensureLanguageLoaded(language: string): Promise<void> {
  if (loadedLanguages.has(language)) return
  if (loadingLanguages.has(language)) {
    await loadingLanguages.get(language)
    return
  }

  const load = async (): Promise<void> => {
    const loader = LANGUAGE_LOADERS[language]
    if (!loader) return
    const runtime = await ensureRuntime()
    if (loadedLanguages.has(language)) return
    const languageModule = await loader()
    runtime.Highlighter.registerLanguage?.(language, languageModule.default)
    loadedLanguages.add(language)
  }

  const promise = load()
    .catch(() => {})
    .finally(() => loadingLanguages.delete(language))

  loadingLanguages.set(language, promise)
  await promise
}

type LazySyntaxHighlighterProps = Record<string, unknown> & {
  language?: string
  children: string
  className?: string
  customStyle?: React.CSSProperties
  codeTagProps?: React.HTMLAttributes<HTMLElement>
}

export function LazySyntaxHighlighter({
  language,
  children,
  className,
  customStyle,
  codeTagProps,
  ...rest
}: LazySyntaxHighlighterProps): React.JSX.Element {
  const { resolvedTheme } = useTheme()
  const [runtime, setRuntime] = React.useState<HighlighterRuntime | null>(null)
  const normalizedLanguage = normalizeLanguage(language)
  const canHighlight = normalizedLanguage !== 'plaintext' && normalizedLanguage in LANGUAGE_LOADERS

  React.useEffect(() => {
    if (!canHighlight) return
    let cancelled = false
    ensureRuntime().then((loaded) => {
      if (!cancelled) setRuntime(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [canHighlight])

  React.useEffect(() => {
    if (!runtime || !canHighlight) return
    void ensureLanguageLoaded(normalizedLanguage)
  }, [runtime, normalizedLanguage, canHighlight])

  if (!runtime || !canHighlight) {
    return (
      <pre
        className={className ?? 'text-xs'}
        style={{
          margin: 0,
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          ...(customStyle ?? {})
        }}
      >
        <code
          {...codeTagProps}
          style={{
            fontFamily: 'inherit',
            fontSize: 'inherit',
            ...(codeTagProps?.style ?? {})
          }}
        >
          {children}
        </code>
      </pre>
    )
  }

  const Highlighter = runtime.Highlighter
  return (
    <Highlighter
      language={normalizedLanguage}
      style={resolvedTheme === 'light' ? runtime.lightStyle : runtime.darkStyle}
      className={className}
      customStyle={customStyle}
      codeTagProps={codeTagProps}
      {...rest}
    >
      {children}
    </Highlighter>
  )
}
