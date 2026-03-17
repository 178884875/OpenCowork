import type { ToolHandler } from './tool-types'
import { toolRegistry } from '../agent/tool-registry'
import { ipcClient } from '../ipc/ipc-client'
import { encodeToolError } from './tool-result-format'

type SkillMeta = { name: string; description: string }

let registeredSkills: SkillMeta[] = []

export function getRegisteredSkills(): SkillMeta[] {
  return registeredSkills.slice()
}

function buildSkillDescription(): string {
  return `Load a skill by name to get detailed instructions or knowledge for a specific task. Returns the full content of the skill's SKILL.md file as context.

You have access to **Skills** — pre-defined expert scripts for specialized tasks. Skills are your MOST RELIABLE way to handle these tasks.
**BEFORE using Shell, Read, Write, or ANY other tool, check if the user's request matches a Skill listed in the session's \`<system-reminder>\` context.**

### How to use Skills
1. **Match**: Before starting any task, check if it matches one of the available Skills in the session context.
2. **Load first**: Call the Skill tool as your FIRST tool call for matching tasks. Do NOT attempt ad-hoc solutions — Skills contain curated scripts with proper error handling that ad-hoc approaches will miss.
3. **Read carefully**: After loading, read the Skill's content thoroughly before taking any action.
4. **Follow strictly**: Execute the Skill's instructions step-by-step. Do NOT skip steps, reorder them, or substitute your own approach.
5. **Retry on failure**: If a Skill's script fails, fix the issue and **re-run the exact same script command**. NEVER replace a Skill's script with your own inline code or ad-hoc scripts.
6. If the user's message begins with "[Skill: <name>]", immediately call that Skill as your first action.`
}

function createSkillHandler(): ToolHandler {
  return {
    definition: {
      name: 'Skill',
      description: buildSkillDescription(),
      inputSchema: {
        type: 'object',
        properties: {
          SkillName: {
            type: 'string',
            description: 'The name of the skill to load. Must match one of the available skills.',
          },
        },
        required: ['SkillName'],
      },
    },
    execute: async (input, ctx) => {
      const skillName = input.SkillName as string
      if (!skillName) {
        return encodeToolError('SkillName is required')
      }
      try {
        const result = await ctx.ipc.invoke('skills:load', { name: skillName }) as
          | { content: string; workingDirectory: string }
          | { error: string }
        if ('error' in result) {
          return encodeToolError(result.error)
        }
        return `<skill_context>\n<working_directory>${result.workingDirectory}</working_directory>\n<instruction>CRITICAL: When executing any script mentioned in this skill, you MUST prepend the working_directory to form an absolute path. For example, if the skill says "python scripts/foo.py", you must run "python ${result.workingDirectory}/scripts/foo.py". NEVER run scripts using bare relative paths like "python scripts/foo.py" — they will fail because your cwd is not the skill directory.</instruction>\n</skill_context>\n\n${result.content}`
      } catch (err) {
        return encodeToolError(err instanceof Error ? err.message : String(err))
      }
    },
    requiresApproval: () => false,
  }
}

/**
 * Load available skills from ~/agents/skills/ via IPC,
 * then register the Skill tool with a stable description.
 *
 * This is async because it reads skill metadata via IPC from the main process.
 * Similar pattern to registerBuiltinSubAgents().
 */
export async function registerSkillTools(): Promise<void> {
  let skills: SkillMeta[] = []
  try {
    const result = await ipcClient.invoke('skills:list')
    if (Array.isArray(result)) {
      skills = result as SkillMeta[]
    }
  } catch (err) {
    console.error('[Skills] Failed to load skills from IPC:', err)
  }

  registeredSkills = skills
  toolRegistry.register(createSkillHandler())
}
