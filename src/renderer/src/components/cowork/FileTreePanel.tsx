import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import {
  FolderOpen,
  Folder,
  File,
  FileCode,
  FileJson,
  FileText,
  Image,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  FolderPlus,
  FilePlus2,
  Copy,
  Check,
  AlertCircle,
  Pencil,
  Trash2
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@renderer/components/ui/context-menu'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { createSelectFileTag } from '@renderer/lib/select-file-tags'
import { cn } from '@renderer/lib/utils'
import { AnimatePresence, motion } from 'motion/react'

// --- Types ---

interface FileEntry {
  name: string
  type: 'file' | 'directory'
  path: string
}

interface TreeNode extends FileEntry {
  children?: TreeNode[]
  loaded?: boolean
  expanded?: boolean
}

// --- File icon helper ---

const EXT_ICONS: Record<string, React.ReactNode> = {
  '.ts': <FileCode className="size-3.5 text-blue-400" />,
  '.tsx': <FileCode className="size-3.5 text-blue-400" />,
  '.js': <FileCode className="size-3.5 text-yellow-500" />,
  '.jsx': <FileCode className="size-3.5 text-yellow-500" />,
  '.py': <FileCode className="size-3.5 text-green-500" />,
  '.rs': <FileCode className="size-3.5 text-orange-400" />,
  '.go': <FileCode className="size-3.5 text-cyan-400" />,
  '.json': <FileJson className="size-3.5 text-amber-400" />,
  '.md': <FileText className="size-3.5 text-muted-foreground" />,
  '.txt': <FileText className="size-3.5 text-muted-foreground" />,
  '.yaml': <FileText className="size-3.5 text-pink-400" />,
  '.yml': <FileText className="size-3.5 text-pink-400" />,
  '.css': <FileCode className="size-3.5 text-purple-400" />,
  '.html': <FileCode className="size-3.5 text-orange-400" />,
  '.svg': <Image className="size-3.5 text-green-400" />,
  '.png': <Image className="size-3.5 text-green-400" />,
  '.jpg': <Image className="size-3.5 text-green-400" />,
  '.gif': <Image className="size-3.5 text-green-400" />
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'out',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.idea',
  '.vscode',
  'target',
  'coverage',
  '.turbo',
  '.parcel-cache'
])

function fileIcon(name: string): React.ReactNode {
  const ext = name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : ''
  return EXT_ICONS[ext] ?? <File className="size-3.5 text-muted-foreground/60" />
}

// --- Sort: directories first, then alphabetical ---
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function countTreeStats(nodes: TreeNode[]): { folders: number; files: number } {
  return nodes.reduce(
    (acc, node) => {
      if (node.type === 'directory') {
        acc.folders += 1
        if (node.children?.length) {
          const childStats = countTreeStats(node.children)
          acc.folders += childStats.folders
          acc.files += childStats.files
        }
      } else {
        acc.files += 1
      }
      return acc
    },
    { folders: 0, files: 0 }
  )
}

function collapseTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => ({
    ...node,
    expanded: false,
    children: node.children ? collapseTree(node.children) : node.children
  }))
}

function DepthGuides({ depth }: { depth: number }): React.JSX.Element | null {
  if (depth <= 0) return null

  return (
    <div className="absolute inset-y-0 left-0 pointer-events-none">
      {Array.from({ length: depth }).map((_, index) => (
        <span
          key={index}
          className="absolute inset-y-0 w-px bg-border/50"
          style={{ left: `${index * 14 + 9}px` }}
        />
      ))}
    </div>
  )
}

// --- Tree Node Component ---

// --- Inline input for rename / new item ---

function InlineInput({
  defaultValue,
  depth,
  icon,
  onConfirm,
  onCancel
}: {
  defaultValue: string
  depth: number
  icon: React.ReactNode
  onConfirm: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    // Auto-focus and select filename without extension
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = defaultValue.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : defaultValue.length)
  }, [defaultValue])

  return (
    <div
      className="flex items-center gap-1 py-[1px] pr-2 text-[12px]"
      style={{ paddingLeft: `${depth * 14 + 4 + 16}px` }}
    >
      {icon}
      <input
        ref={ref}
        className="flex-1 min-w-0 bg-muted/60 border border-border rounded px-1 py-0 text-[12px] text-foreground outline-none focus:ring-1 focus:ring-ring"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) onConfirm(value.trim())
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={() => onCancel()}
      />
    </div>
  )
}

// --- Edit state passed down the tree ---

interface TreeEditState {
  renamingPath: string | null
  newItemParent: string | null
  newItemType: 'file' | 'directory'
}

interface TreeActions {
  onDelete: (nodePath: string, nodeName: string, isDir: boolean) => void
  onRenameStart: (nodePath: string, nodeName: string) => void
  onRenameConfirm: (value: string) => void
  onRenameCancel: () => void
  onNewFile: (dirPath: string) => void
  onNewFolder: (dirPath: string) => void
  onNewItemConfirm: (value: string) => void
  onNewItemCancel: () => void
}

function TreeItem({
  node,
  depth,
  activePath,
  onToggle,
  onCopyPath,
  onPreview,
  editState,
  actions
}: {
  node: TreeNode
  depth: number
  activePath: string | null
  onToggle: (path: string) => void
  onCopyPath: (path: string) => void
  onPreview: (path: string, name: string) => void
  editState: TreeEditState
  actions: TreeActions
}): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const [copied, setCopied] = useState(false)
  const isDir = node.type === 'directory'
  const isIgnored = isDir && IGNORED_DIRS.has(node.name)
  const safeEditState = editState ?? {
    renamingPath: null,
    newItemParent: null,
    newItemType: 'file' as const
  }
  const isRenaming = safeEditState.renamingPath === node.path
  const isActive = activePath === node.path

  const handleCopy = useCallback(() => {
    onCopyPath(node.path)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }, [node.path, onCopyPath])

  const rowContent = (
    <div
      className={cn(
        'group relative flex items-center gap-1 py-1 pr-2 text-[12px] cursor-pointer rounded-md transition-colors',
        isActive
          ? 'bg-primary/10 text-foreground ring-1 ring-primary/20'
          : isDir && node.expanded
            ? 'bg-muted/40'
            : 'hover:bg-muted/60',
        isIgnored && 'opacity-40'
      )}
      style={{ paddingLeft: `${depth * 14 + 4}px` }}
      onClick={() => (isDir && !isIgnored ? onToggle(node.path) : onPreview(node.path, node.name))}
      title={node.path}
    >
      <DepthGuides depth={depth} />
      {depth > 0 && (
        <span
          className="absolute top-1/2 h-px w-2 bg-border/60 pointer-events-none"
          style={{ left: `${(depth - 1) * 14 + 9}px` }}
        />
      )}

      {/* Expand chevron */}
      {isDir ? (
        node.expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground/50" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
        )
      ) : (
        <span className="size-3 shrink-0" />
      )}

      {/* Icon */}
      {isDir ? (
        node.expanded ? (
          <FolderOpen className="size-3.5 shrink-0 text-amber-400" />
        ) : (
          <Folder className="size-3.5 shrink-0 text-amber-400/70" />
        )
      ) : (
        fileIcon(node.name)
      )}

      {/* Name or rename input */}
      {isRenaming ? (
        <input
          autoFocus
          className="flex-1 min-w-0 bg-muted/60 border border-border rounded px-1 py-0 text-[12px] text-foreground outline-none focus:ring-1 focus:ring-ring"
          defaultValue={node.name}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const val = (e.target as HTMLInputElement).value.trim()
              if (val && val !== node.name) actions.onRenameConfirm(val)
              else actions.onRenameCancel()
            }
            if (e.key === 'Escape') actions.onRenameCancel()
          }}
          onBlur={() => actions.onRenameCancel()}
          onFocus={(e) => {
            const dot = node.name.lastIndexOf('.')
            e.target.setSelectionRange(0, dot > 0 && !isDir ? dot : node.name.length)
          }}
        />
      ) : (
        <span
          className={cn(
            'truncate',
            isDir ? 'text-foreground/80 font-medium' : 'text-muted-foreground'
          )}
        >
          {node.name}
        </span>
      )}

      {/* Copy button (files only, on hover) */}
      {!isDir && !isRenaming && (
        <button
          className="ml-auto hidden group-hover:block shrink-0 text-muted-foreground/30 hover:text-muted-foreground transition-colors"
          onClick={(e) => {
            e.stopPropagation()
            handleCopy()
          }}
          title={t('fileTree.copyPath')}
        >
          {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
        </button>
      )}
    </div>
  )

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{rowContent}</ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          {isDir && !isIgnored && (
            <>
              <ContextMenuItem
                className="gap-2 text-xs"
                onSelect={() => actions.onNewFile(node.path)}
              >
                <FilePlus2 className="size-3.5" /> {t('fileTree.newFile')}
              </ContextMenuItem>
              <ContextMenuItem
                className="gap-2 text-xs"
                onSelect={() => actions.onNewFolder(node.path)}
              >
                <FolderPlus className="size-3.5" /> {t('fileTree.newFolder')}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem
            className="gap-2 text-xs"
            onSelect={() => actions.onRenameStart(node.path, node.name)}
          >
            <Pencil className="size-3.5" /> {t('action.rename', { ns: 'common' })}
          </ContextMenuItem>
          <ContextMenuItem className="gap-2 text-xs" onSelect={handleCopy}>
            <Copy className="size-3.5" /> {t('action.copyPath', { ns: 'common' })}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="gap-2 text-xs text-destructive focus:text-destructive"
            onSelect={() => actions.onDelete(node.path, node.name, isDir)}
          >
            <Trash2 className="size-3.5" /> {t('action.delete', { ns: 'common' })}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* New item input (shown as first child of this directory) */}
      {isDir && node.expanded && safeEditState.newItemParent === node.path && (
        <InlineInput
          defaultValue={safeEditState.newItemType === 'file' ? 'untitled' : 'new-folder'}
          depth={depth + 1}
          icon={
            safeEditState.newItemType === 'file' ? (
              <File className="size-3.5 text-muted-foreground/60" />
            ) : (
              <Folder className="size-3.5 text-amber-400/70" />
            )
          }
          onConfirm={actions.onNewItemConfirm}
          onCancel={actions.onNewItemCancel}
        />
      )}

      {/* Children */}
      <AnimatePresence>
        {isDir && node.expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            {node.children?.length ? (
              node.children.map((child) => (
                <TreeItem
                  key={child.path}
                  node={child}
                  depth={depth + 1}
                  activePath={activePath}
                  onToggle={onToggle}
                  onCopyPath={onCopyPath}
                  onPreview={onPreview}
                  editState={editState}
                  actions={actions}
                />
              ))
            ) : (
              <div
                className="relative py-1 pl-8 text-[11px] text-muted-foreground/45"
                style={{ paddingLeft: `${(depth + 1) * 14 + 18}px` }}
              >
                <DepthGuides depth={depth + 1} />
                <span className="relative">{t('fileTree.empty')}</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

// --- Main Panel ---

export function FileTreePanel(): React.JSX.Element {
  const { t } = useTranslation('cowork')
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const workingFolder = activeSession?.workingFolder
  const previewPanelState = useUIStore((s) => s.previewPanelState)

  const [tree, setTree] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // --- Edit state for context menu actions ---
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [newItemParent, setNewItemParent] = useState<string | null>(null)
  const [newItemType, setNewItemType] = useState<'file' | 'directory'>('file')

  const loadDir = useCallback(async (dirPath: string): Promise<TreeNode[]> => {
    const result = (await ipcClient.invoke('fs:list-dir', { path: dirPath })) as
      | FileEntry[]
      | { error: string }
    if ('error' in result) throw new Error(String(result.error))
    const sorted = sortEntries(result as FileEntry[])
    return sorted.map((e) => ({
      ...e,
      expanded: false,
      loaded: e.type === 'file',
      children: e.type === 'directory' ? [] : undefined
    }))
  }, [])

  const loadRoot = useCallback(async () => {
    if (!workingFolder) return
    setLoading(true)
    setError(null)
    try {
      const nodes = await loadDir(workingFolder)
      setTree(nodes)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workingFolder, loadDir])

  useEffect(() => {
    loadRoot()
  }, [loadRoot])

  const handleToggle = useCallback(
    async (dirPath: string) => {
      const toggleNode = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
        return Promise.all(
          nodes.map(async (n) => {
            if (n.path === dirPath && n.type === 'directory') {
              if (n.expanded) {
                return { ...n, expanded: false }
              }
              if (!n.loaded) {
                try {
                  const children = await loadDir(dirPath)
                  return { ...n, expanded: true, loaded: true, children }
                } catch {
                  return { ...n, expanded: true, loaded: true, children: [] }
                }
              }
              return { ...n, expanded: true }
            }
            if (n.children) {
              return { ...n, children: await toggleNode(n.children) }
            }
            return n
          })
        )
      }
      setTree(await toggleNode(tree))
    },
    [tree, loadDir]
  )

  // Refresh a single directory's children in the tree (after create/rename/delete)
  const refreshDir = useCallback(
    async (dirPath: string) => {
      const refresh = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
        return Promise.all(
          nodes.map(async (n) => {
            if (n.path === dirPath && n.type === 'directory') {
              try {
                const children = await loadDir(dirPath)
                return { ...n, expanded: true, loaded: true, children }
              } catch {
                return n
              }
            }
            if (n.children) return { ...n, children: await refresh(n.children) }
            return n
          })
        )
      }
      setTree(await refresh(tree))
    },
    [tree, loadDir]
  )

  const handleCopyPath = useCallback(
    (filePath: string) => {
      // Make path relative to working folder if possible
      const rel =
        workingFolder && filePath.startsWith(workingFolder)
          ? filePath.slice(workingFolder.length).replace(/^[\\//]/, '')
          : filePath
      useUIStore.getState().setPendingInsertText(createSelectFileTag(rel))
      navigator.clipboard.writeText(filePath)
    },
    [workingFolder]
  )

  // --- Context menu action handlers ---

  const sep = workingFolder?.includes('/') ? '/' : '\\'

  const handleDelete = useCallback(
    async (nodePath: string, nodeName: string, isDir: boolean) => {
      const confirmed = await confirm({
        title: t('fileTree.deleteConfirm', {
          type: isDir ? t('fileTree.folder') : t('fileTree.file'),
          name: nodeName
        }),
        variant: 'destructive'
      })
      if (!confirmed) return
      try {
        await ipcClient.invoke('fs:delete', { path: nodePath })
        const parentDir = nodePath.substring(0, nodePath.lastIndexOf(sep))
        if (parentDir === workingFolder) {
          await loadRoot()
        } else {
          await refreshDir(parentDir)
        }
      } catch (err) {
        console.error('Delete failed:', err)
      }
    },
    [sep, t, workingFolder, loadRoot, refreshDir]
  )

  const handleRenameStart = useCallback((nodePath: string) => {
    setRenamingPath(nodePath)
    setNewItemParent(null)
  }, [])

  const handleRenameConfirm = useCallback(
    async (newName: string) => {
      if (!renamingPath) return
      const parentDir = renamingPath.substring(0, renamingPath.lastIndexOf(sep))
      const newPath = parentDir + sep + newName
      try {
        await ipcClient.invoke('fs:move', { from: renamingPath, to: newPath })
        setRenamingPath(null)
        if (parentDir === workingFolder) {
          await loadRoot()
        } else {
          await refreshDir(parentDir)
        }
      } catch (err) {
        console.error('Rename failed:', err)
      }
    },
    [renamingPath, sep, workingFolder, loadRoot, refreshDir]
  )

  const handleRenameCancel = useCallback(() => setRenamingPath(null), [])

  const handleNewFile = useCallback(
    async (dirPath: string) => {
      setNewItemParent(dirPath)
      setNewItemType('file')
      setRenamingPath(null)
      // Ensure the directory is expanded
      const expandNode = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
        return Promise.all(
          nodes.map(async (n) => {
            if (n.path === dirPath && n.type === 'directory' && !n.expanded) {
              if (!n.loaded) {
                const children = await loadDir(dirPath)
                return { ...n, expanded: true, loaded: true, children }
              }
              return { ...n, expanded: true }
            }
            if (n.children) return { ...n, children: await expandNode(n.children) }
            return n
          })
        )
      }
      setTree(await expandNode(tree))
    },
    [tree, loadDir]
  )

  const handleNewFolder = useCallback(
    async (dirPath: string) => {
      setNewItemParent(dirPath)
      setNewItemType('directory')
      setRenamingPath(null)
      const expandNode = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
        return Promise.all(
          nodes.map(async (n) => {
            if (n.path === dirPath && n.type === 'directory' && !n.expanded) {
              if (!n.loaded) {
                const children = await loadDir(dirPath)
                return { ...n, expanded: true, loaded: true, children }
              }
              return { ...n, expanded: true }
            }
            if (n.children) return { ...n, children: await expandNode(n.children) }
            return n
          })
        )
      }
      setTree(await expandNode(tree))
    },
    [tree, loadDir]
  )

  const handleNewItemConfirm = useCallback(
    async (name: string) => {
      if (!newItemParent) return
      const newPath = newItemParent + sep + name
      try {
        if (newItemType === 'directory') {
          await ipcClient.invoke('fs:mkdir', { path: newPath })
        } else {
          await ipcClient.invoke('fs:write-file', { path: newPath, content: '' })
        }
        setNewItemParent(null)
        await refreshDir(newItemParent)
      } catch (err) {
        console.error('Create failed:', err)
      }
    },
    [newItemParent, newItemType, sep, refreshDir]
  )

  const handleNewItemCancel = useCallback(() => setNewItemParent(null), [])

  const activePath = previewPanelState?.source === 'file' ? previewPanelState.filePath : null
  const treeStats = useMemo(() => countTreeStats(tree), [tree])

  const editState: TreeEditState = { renamingPath, newItemParent, newItemType }
  const treeActions: TreeActions = {
    onDelete: handleDelete,
    onRenameStart: handleRenameStart,
    onRenameConfirm: handleRenameConfirm,
    onRenameCancel: handleRenameCancel,
    onNewFile: handleNewFile,
    onNewFolder: handleNewFolder,
    onNewItemConfirm: handleNewItemConfirm,
    onNewItemCancel: handleNewItemCancel
  }

  const handlePreview = useCallback((filePath: string) => {
    useUIStore.getState().openFilePreview(filePath)
  }, [])

  const handleCollapseAll = useCallback(() => {
    setTree((current) => collapseTree(current))
  }, [])

  if (!workingFolder) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground/60">
        <FolderPlus className="size-8" />
        <p className="text-xs">{t('fileTree.selectFolder')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-background/60 overflow-hidden">
        <div className="flex items-center gap-2 px-2 py-2 border-b border-border/50 bg-muted/20">
          <FolderOpen className="size-3.5 text-amber-400 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-xs text-foreground truncate" title={workingFolder}>
              {workingFolder.split(/[\\/]/).pop()}
            </div>
            <div className="text-[10px] text-muted-foreground truncate" title={workingFolder}>
              {workingFolder}
            </div>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5">
              {treeStats.folders} {t('unit.folders', { ns: 'common' })}
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5">
              {treeStats.files} {t('unit.files', { ns: 'common' })}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={handleCollapseAll}
            disabled={tree.length === 0}
            title={t('action.showLess', { ns: 'common' })}
          >
            <ChevronDown className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={loadRoot}
            disabled={loading}
            title={t('action.refresh', { ns: 'common' })}
          >
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          </Button>
        </div>

        {error && (
          <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-destructive">
            <AlertCircle className="size-3 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        )}

        {loading && tree.length === 0 ? (
          <div className="flex items-center justify-center py-4">
            <RefreshCw className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="text-[12px] max-h-[calc(100vh-200px)] overflow-y-auto px-1 py-1">
            {tree.map((node) => (
              <TreeItem
                key={node.path}
                node={node}
                depth={0}
                activePath={activePath}
                onToggle={handleToggle}
                onCopyPath={handleCopyPath}
                onPreview={handlePreview}
                editState={editState}
                actions={treeActions}
              />
            ))}
          </div>
        )}

        {tree.length > 0 && (
          <div className="border-t border-border/50 px-2 py-1 text-[10px] text-muted-foreground/70">
            {t('fileTree.stats', {
              folders: treeStats.folders,
              files: treeStats.files
            })}
          </div>
        )}
      </div>
    </div>
  )
}
