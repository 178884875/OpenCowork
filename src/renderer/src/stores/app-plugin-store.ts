import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { ProviderConfig } from '@renderer/lib/api/types'
import { configStorage } from '@renderer/lib/ipc/config-storage'
import { useProviderStore } from './provider-store'
import { useChatStore } from './chat-store'
import {
  APP_PLUGIN_DESCRIPTORS,
  DESKTOP_CONTROL_PLUGIN_ID,
  IMAGE_PLUGIN_ID,
  type AppPluginDescriptor,
  type AppPluginId,
  type AppPluginInstance
} from '@renderer/lib/app-plugin/types'

function createDefaultPlugin(id: AppPluginId): AppPluginInstance {
  return {
    id,
    enabled: false,
    useGlobalModel: true,
    providerId: null,
    modelId: null
  }
}

const GLOBAL_PROJECT_ID = '__global__'

function resolveProjectId(projectId?: string | null): string {
  return projectId ?? useChatStore.getState().activeProjectId ?? GLOBAL_PROJECT_ID
}

function provisionBuiltinPlugins(plugins: AppPluginInstance[]): AppPluginInstance[] {
  const next = plugins.map((plugin) => ({ ...plugin }))

  for (const descriptor of APP_PLUGIN_DESCRIPTORS) {
    const existing = next.find((plugin) => plugin.id === descriptor.id)
    if (!existing) {
      const created = createDefaultPlugin(descriptor.id)
      if (descriptor.id === DESKTOP_CONTROL_PLUGIN_ID) {
        created.enabled = false
      }
      next.push(created)
      continue
    }
    if (descriptor.id === DESKTOP_CONTROL_PLUGIN_ID) {
      existing.enabled = false
    }

    if (typeof existing.useGlobalModel !== 'boolean') {
      existing.useGlobalModel = true
    }
    if (existing.providerId === undefined) {
      existing.providerId = null
    }
    if (existing.modelId === undefined) {
      existing.modelId = null
    }
  }

  return next
}

function isImageModelEnabled(providerId: string, modelId: string): boolean {
  const provider = useProviderStore.getState().providers.find((item) => item.id === providerId)
  if (!provider || !provider.enabled) return false
  const model = provider.models.find((item) => item.id === modelId)
  if (!model || !model.enabled) return false
  return (model.category ?? 'chat') === 'image'
}

interface AppPluginStore {
  pluginsByProject: Record<string, AppPluginInstance[]>
  getDescriptors: () => AppPluginDescriptor[]
  getPlugin: (id: AppPluginId, projectId?: string | null) => AppPluginInstance | null
  updatePlugin: (id: AppPluginId, patch: Partial<AppPluginInstance>, projectId?: string | null) => void
  togglePluginEnabled: (id: AppPluginId, projectId?: string | null) => void
  getEnabledPlugins: (projectId?: string | null) => AppPluginInstance[]
  getResolvedImagePluginConfig: (projectId?: string | null) => ProviderConfig | null
  isImageToolAvailable: (projectId?: string | null) => boolean
  isDesktopControlToolAvailable: () => boolean
}

export const useAppPluginStore = create<AppPluginStore>()(
  persist(
    (set, get) => ({
      pluginsByProject: {
        [GLOBAL_PROJECT_ID]: provisionBuiltinPlugins([])
      },

      getDescriptors: () => APP_PLUGIN_DESCRIPTORS,

      getPlugin: (id, projectId) => {
        const resolvedProjectId = resolveProjectId(projectId)
        const plugins = get().pluginsByProject[resolvedProjectId] ?? provisionBuiltinPlugins([])
        return plugins.find((plugin) => plugin.id === id) ?? null
      },

      updatePlugin: (id, patch, projectId) => {
        const resolvedProjectId = resolveProjectId(projectId)
        set((state) => {
          const current = state.pluginsByProject[resolvedProjectId] ?? provisionBuiltinPlugins([])
          const next = current.map((plugin) =>
            plugin.id === id ? { ...plugin, ...patch } : plugin
          )
          return { pluginsByProject: { ...state.pluginsByProject, [resolvedProjectId]: next } }
        })
      },

      togglePluginEnabled: (id, projectId) => {
        const resolvedProjectId = resolveProjectId(projectId)
        set((state) => {
          const current = state.pluginsByProject[resolvedProjectId] ?? provisionBuiltinPlugins([])
          const next = current.map((plugin) =>
            plugin.id === id ? { ...plugin, enabled: !plugin.enabled } : plugin
          )
          return { pluginsByProject: { ...state.pluginsByProject, [resolvedProjectId]: next } }
        })
      },

      getEnabledPlugins: (projectId) =>
        (get().pluginsByProject[resolveProjectId(projectId)] ?? []).filter((plugin) => plugin.enabled),

      getResolvedImagePluginConfig: (projectId) => {
        const plugin = get().getPlugin(IMAGE_PLUGIN_ID, projectId)
        if (!plugin?.enabled) return null

        const providerStore = useProviderStore.getState()
        const providerId = plugin.useGlobalModel
          ? providerStore.activeImageProviderId
          : plugin.providerId
        const modelId = plugin.useGlobalModel ? providerStore.activeImageModelId : plugin.modelId

        if (!providerId || !modelId) return null
        if (!isImageModelEnabled(providerId, modelId)) return null

        return providerStore.getProviderConfigById(providerId, modelId)
      },

      isImageToolAvailable: (projectId) => get().getResolvedImagePluginConfig(projectId) !== null,

      isDesktopControlToolAvailable: () => false
    }),
    {
      name: 'opencowork-app-plugins',
      version: 2,
      storage: createJSONStorage(() => configStorage),
      migrate: (persisted) => {
        const state = (persisted ?? {}) as {
          plugins?: AppPluginInstance[]
          pluginsByProject?: Record<string, AppPluginInstance[]>
        }

        if (state.pluginsByProject) {
          return {
            pluginsByProject: Object.fromEntries(
              Object.entries(state.pluginsByProject).map(([projectId, plugins]) => [
                projectId,
                provisionBuiltinPlugins(Array.isArray(plugins) ? plugins : [])
              ])
            )
          }
        }

        return {
          pluginsByProject: {
            [GLOBAL_PROJECT_ID]: provisionBuiltinPlugins(Array.isArray(state.plugins) ? state.plugins : [])
          }
        }
      },
      partialize: (state) => ({
        pluginsByProject: state.pluginsByProject
      })
    }
  )
)

function ensureBuiltinPlugins(): void {
  const current = useAppPluginStore.getState().pluginsByProject
  const next = Object.fromEntries(
    Object.entries(current).map(([projectId, plugins]) => [
      projectId,
      provisionBuiltinPlugins(Array.isArray(plugins) ? plugins : [])
    ])
  )
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    useAppPluginStore.setState({ pluginsByProject: next })
  }
}

export function initAppPluginStore(): void {
  if (useAppPluginStore.persist.hasHydrated()) {
    ensureBuiltinPlugins()
  }

  useAppPluginStore.persist.onFinishHydration(() => {
    ensureBuiltinPlugins()
  })
}
