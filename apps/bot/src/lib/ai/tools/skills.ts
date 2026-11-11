import { tool } from 'ai';
import { z } from 'zod';
import {
  fetchGithubSkill,
  getSkill,
  listSkills,
  removeSkill,
  type Skill,
  writeSkill,
} from '@/lib/skills';
import { parseSkill } from '@/lib/skills/parse';
import { errorMessage } from '@/lib/utils/error';

/**
 * Load a skill. The INDEX is the description, so the model sees every skill's
 * name and when to use it without a round trip; `skills` must be in a stable
 * order, since tool schemas are part of the cached prompt prefix.
 */
export function loadSkillTool({ skills }: { skills: Skill[] }) {
  const index = skills
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join('\n');
  return tool({
    description: `Load a skill: step-by-step instructions for a kind of task. When a request matches one below, load it BEFORE starting and follow it. \`file\` loads one of the reference files a skill mentions.\n\nSkills:\n${index || '(none yet)'}`,
    inputSchema: z.object({
      file: z
        .string()
        .optional()
        .describe('A reference file the skill names, e.g. references/api.md.'),
      name: z.string().describe('The skill name.'),
    }),
    execute: async ({ file, name }) => {
      const skill = await getSkill(name);
      if (!skill) {
        return {
          error: `No skill "${name}". Available: ${skills.map((entry) => entry.name).join(', ')}.`,
          success: false,
        };
      }
      if (file) {
        const content = skill.files[file];
        return content === undefined
          ? {
              error: `The ${name} skill has no file "${file}". It has: ${Object.keys(skill.files).join(', ') || 'none'}.`,
              success: false,
            }
          : { content, file, success: true };
      }
      return {
        instructions: skill.body,
        name: skill.name,
        ...(Object.keys(skill.files).length > 0
          ? { referenceFiles: Object.keys(skill.files) }
          : {}),
        success: true,
      };
    },
  });
}

/**
 * The owner's skill catalog, one tool per verb so each verb's own fields are
 * required in the schema the model sees (#184). Registered for the owner only:
 * a skill is prompt text every user's turn may load.
 */
export function manageSkillsTools({ userId }: { userId: string }) {
  const guarded =
    <Input>(run: (input: Input) => Promise<Record<string, unknown>>) =>
    async (input: Input) => {
      try {
        return await run(input);
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    };
  return {
    installSkill: tool({
      description:
        "Install a skill from a public GitHub skill folder or SKILL.md link (owner only). Skills are loaded by every user's turns, so read a third-party skill (showSkill, or fetch it) before installing it.",
      inputSchema: z.object({
        url: z.string().url().describe('The GitHub link.'),
      }),
      execute: guarded(async ({ url }) => {
        const fetched = await fetchGithubSkill(url);
        if (!fetched.ok) {
          return { error: fetched.error, success: false };
        }
        await writeSkill({
          files: fetched.files,
          skill: fetched.skill,
          source: fetched.source,
          userId,
        });
        return {
          installed: fetched.skill.name,
          referenceFiles: Object.keys(fetched.files),
          success: true,
          summary: `Installed the ${fetched.skill.name} skill.`,
        };
      }),
    }),
    listSkills: tool({
      description: 'List the skill catalog (owner only).',
      inputSchema: z.object({}),
      execute: guarded(async () => ({
        skills: (await listSkills()).map((skill) => ({
          builtin: skill.builtin,
          description: skill.description,
          name: skill.name,
          ...(skill.source ? { source: skill.source } : {}),
        })),
        success: true,
      })),
    }),
    removeSkill: tool({
      description:
        'Remove an installed or written skill (owner only); a built-in of the same name comes back.',
      inputSchema: z.object({
        name: z.string().min(1).describe('The skill name.'),
      }),
      execute: guarded(async ({ name }) =>
        (await removeSkill(name))
          ? { success: true, summary: `Removed the ${name} skill.` }
          : {
              error: `"${name}" is not an installed or written skill (built-ins can only be overridden).`,
              success: false,
            }
      ),
    }),
    showSkill: tool({
      description: "A skill's full text (owner only).",
      inputSchema: z.object({
        name: z.string().min(1).describe('The skill name.'),
      }),
      execute: guarded(async ({ name }) => {
        const skill = await getSkill(name);
        return skill
          ? { skill, success: true }
          : { error: `No skill "${name}".`, success: false };
      }),
    }),
    writeSkill: tool({
      description:
        'Write a new or edited skill from its complete SKILL.md text: frontmatter with name + description, then the instructions (owner only).',
      inputSchema: z.object({
        markdown: z.string().min(1).max(60_000).describe('The whole SKILL.md.'),
      }),
      execute: guarded(async ({ markdown }) => {
        const parsed = parseSkill(markdown);
        if (!parsed.ok) {
          return { error: parsed.error, success: false };
        }
        const existing = await getSkill(parsed.skill.name);
        await writeSkill({
          files: existing?.builtin ? {} : (existing?.files ?? {}),
          skill: parsed.skill,
          userId,
        });
        return {
          success: true,
          summary: `Saved the ${parsed.skill.name} skill.`,
        };
      }),
    }),
  };
}
