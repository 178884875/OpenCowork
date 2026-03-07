import { ipcMain } from 'electron'
import { getDb } from '../db/database'
import * as sessionsDao from '../db/sessions-dao'
import * as projectsDao from '../db/projects-dao'
import * as messagesDao from '../db/messages-dao'
import * as plansDao from '../db/plans-dao'
import * as tasksDao from '../db/tasks-dao'

export function registerDbHandlers(): void {
  // Initialize DB on registration
  getDb()

  // --- Projects ---

  ipcMain.handle('db:projects:list', () => {
    return projectsDao.listProjects()
  })

  ipcMain.handle('db:projects:get', (_event, id: string) => {
    return projectsDao.getProject(id) ?? null
  })

  ipcMain.handle('db:projects:ensure-default', () => {
    return projectsDao.ensureDefaultProject()
  })

  ipcMain.handle(
    'db:projects:create',
    (
      _event,
      project: {
        id?: string
        name: string
        workingFolder?: string | null
        sshConnectionId?: string | null
        pluginId?: string | null
        createdAt?: number
        updatedAt?: number
      }
    ) => {
      return projectsDao.createProject(project)
    }
  )

  ipcMain.handle(
    'db:projects:update',
    (
      _event,
      args: {
        id: string
        patch: Partial<{
          name: string
          workingFolder: string | null
          sshConnectionId: string | null
          pluginId: string | null
          updatedAt: number
        }>
      }
    ) => {
      projectsDao.updateProject(args.id, args.patch)
      return { success: true }
    }
  )

  ipcMain.handle('db:projects:delete', (_event, id: string) => {
    return projectsDao.deleteProject(id)
  })

  // --- Sessions ---

  ipcMain.handle('db:sessions:list', () => {
    return sessionsDao.listSessions()
  })

  ipcMain.handle('db:sessions:get', (_event, id: string) => {
    const session = sessionsDao.getSession(id)
    if (!session) return null
    const messages = messagesDao.getMessages(id)
    return { session, messages }
  })

  ipcMain.handle(
    'db:sessions:create',
    (
      _event,
      session: {
        id: string
        title: string
        mode: string
        createdAt: number
        updatedAt: number
        projectId?: string
        workingFolder?: string
        sshConnectionId?: string
        pinned?: boolean
        pluginId?: string
        providerId?: string
        modelId?: string
      }
    ) => {
      let projectId = session.projectId
      let workingFolder = session.workingFolder
      let sshConnectionId = session.sshConnectionId

      if (!projectId) {
        const project = projectsDao.ensureDefaultProject()
        projectId = project.id
        if (workingFolder === undefined) workingFolder = project.working_folder ?? undefined
        if (sshConnectionId === undefined) sshConnectionId = project.ssh_connection_id ?? undefined
      } else {
        const project = projectsDao.getProject(projectId)
        if (project) {
          if (workingFolder === undefined) workingFolder = project.working_folder ?? undefined
          if (sshConnectionId === undefined) sshConnectionId = project.ssh_connection_id ?? undefined
        }
      }

      sessionsDao.createSession({
        ...session,
        projectId,
        workingFolder,
        sshConnectionId,
      })
      return { success: true }
    }
  )

  ipcMain.handle(
    'db:sessions:update',
    (
      _event,
      args: {
        id: string
        patch: Partial<{
          title: string
          mode: string
          updatedAt: number
          projectId: string | null
          workingFolder: string | null
          sshConnectionId: string | null
          pinned: boolean
        }>
      }
    ) => {
      sessionsDao.updateSession(args.id, args.patch)
      return { success: true }
    }
  )

  ipcMain.handle('db:sessions:delete', (_event, id: string) => {
    sessionsDao.deleteSession(id)
    return { success: true }
  })

  ipcMain.handle('db:sessions:clear-all', () => {
    sessionsDao.clearAllSessions()
    return { success: true }
  })

  // --- Messages ---

  ipcMain.handle('db:messages:list', (_event, sessionId: string) => {
    return messagesDao.getMessages(sessionId)
  })

  ipcMain.handle(
    'db:messages:list-page',
    (_event, args: { sessionId: string; limit: number; offset: number }) => {
      return messagesDao.getMessagesPage(args.sessionId, args.limit, args.offset)
    }
  )

  ipcMain.handle(
    'db:messages:add',
    (
      _event,
      msg: {
        id: string
        sessionId: string
        role: string
        content: string
        createdAt: number
        usage?: string | null
        sortOrder: number
      }
    ) => {
      // Ensure session exists to avoid FK constraint failure (race with fire-and-forget IPC)
      const existing = sessionsDao.getSession(msg.sessionId)
      if (!existing) {
        const project = projectsDao.ensureDefaultProject()
        sessionsDao.createSession({
          id: msg.sessionId,
          title: 'New Conversation',
          mode: 'chat',
          createdAt: msg.createdAt,
          updatedAt: msg.createdAt,
          projectId: project.id,
          workingFolder: project.working_folder ?? undefined,
          sshConnectionId: project.ssh_connection_id ?? undefined,
        })
      }
      messagesDao.addMessage(msg)
      return { success: true }
    }
  )

  ipcMain.handle(
    'db:messages:update',
    (_event, args: { id: string; patch: Partial<{ content: string; usage: string | null }> }) => {
      messagesDao.updateMessage(args.id, args.patch)
      return { success: true }
    }
  )

  ipcMain.handle('db:messages:clear', (_event, sessionId: string) => {
    messagesDao.clearMessages(sessionId)
    return { success: true }
  })

  ipcMain.handle(
    'db:messages:truncate-from',
    (_event, args: { sessionId: string; fromSortOrder: number }) => {
      messagesDao.truncateMessagesFrom(args.sessionId, args.fromSortOrder)
      return { success: true }
    }
  )

  ipcMain.handle('db:messages:count', (_event, sessionId: string) => {
    return messagesDao.getMessageCount(sessionId)
  })

  // --- Plans ---

  ipcMain.handle('db:plans:list', () => {
    return plansDao.listPlans()
  })

  ipcMain.handle('db:plans:get', (_event, id: string) => {
    return plansDao.getPlan(id) ?? null
  })

  ipcMain.handle('db:plans:get-by-session', (_event, sessionId: string) => {
    return plansDao.getPlanBySession(sessionId) ?? null
  })

  ipcMain.handle(
    'db:plans:create',
    (
      _event,
      plan: {
        id: string
        sessionId: string
        title: string
        status?: string
        filePath?: string
        content?: string
        specJson?: string
        createdAt: number
        updatedAt: number
      }
    ) => {
      plansDao.createPlan(plan)
      return { success: true }
    }
  )

  ipcMain.handle(
    'db:plans:update',
    (
      _event,
      args: {
        id: string
        patch: Partial<{
          title: string
          status: string
          filePath: string | null
          content: string | null
          specJson: string | null
          updatedAt: number
        }>
      }
    ) => {
      plansDao.updatePlan(args.id, args.patch)
      return { success: true }
    }
  )

  ipcMain.handle('db:plans:delete', (_event, id: string) => {
    plansDao.deletePlan(id)
    return { success: true }
  })

  // --- Tasks (session-bound) ---

  ipcMain.handle('db:tasks:list-by-session', (_event, sessionId: string) => {
    return tasksDao.listTasksBySession(sessionId)
  })

  ipcMain.handle('db:tasks:get', (_event, id: string) => {
    return tasksDao.getTask(id) ?? null
  })

  ipcMain.handle(
    'db:tasks:create',
    (
      _event,
      task: {
        id: string
        sessionId: string
        planId?: string
        subject: string
        description: string
        activeForm?: string
        status?: string
        owner?: string
        blocks?: string[]
        blockedBy?: string[]
        metadata?: Record<string, unknown>
        sortOrder: number
        createdAt: number
        updatedAt: number
      }
    ) => {
      tasksDao.createTask(task)
      return { success: true }
    }
  )

  ipcMain.handle(
    'db:tasks:update',
    (
      _event,
      args: {
        id: string
        patch: Partial<{
          subject: string
          description: string
          activeForm: string | null
          status: string
          owner: string | null
          blocks: string[]
          blockedBy: string[]
          metadata: Record<string, unknown> | null
          sortOrder: number
          updatedAt: number
        }>
      }
    ) => {
      tasksDao.updateTask(args.id, args.patch)
      return { success: true }
    }
  )

  ipcMain.handle('db:tasks:delete', (_event, id: string) => {
    tasksDao.deleteTask(id)
    return { success: true }
  })

  ipcMain.handle('db:tasks:delete-by-session', (_event, sessionId: string) => {
    tasksDao.deleteTasksBySession(sessionId)
    return { success: true }
  })
}
