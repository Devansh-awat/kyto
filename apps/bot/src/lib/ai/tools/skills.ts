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
 * The owner's skill catalog. Registered for the owner only: a skill is prompt
 * text every user's turn may load.
 */
export function manageSkillsTool({ userId }: { userId: string }) {
  return tool({
    description:
      "Manage the skill catalog (owner only): `list`; `show` a skill's full text; `install` from a public GitHub skill folder or SKILL.md link; `write` a new or edited skill from its complete SKILL.md text (frontmatter with name + description, then the instructions); `remove` one (a built-in of the same name comes back). Skills are loaded by every user's turns, so read a third-party skill before installing it.",
    inputSchema: z.object({
      action: z.enum(['list', 'show', 'install', 'write', 'remove']),
      markdown: z
        .string()
        .max(60_000)
        .optional()
        .describe('write: the whole SKILL.md.'),
      name: z.string().optional().describe('show/remove: the skill name.'),
      url: z.string().url().optional().describe('install: the GitHub link.'),
    }),
    execute: async ({ action, markdown, name, url }) => {
      try {
        if (action === 'list') {
          return {
            skills: (await listSkills()).map((skill) => ({
              builtin: skill.builtin,
              description: skill.description,
              name: skill.name,
              ...(skill.source ? { source: skill.source } : {}),
            })),
            success: true,
          };
        }
        if (action === 'show') {
          const skill = name ? await getSkill(name) : undefined;
          return skill
            ? { skill, success: true }
            : { error: `No skill "${name ?? ''}".`, success: false };
        }
        if (action === 'install') {
          if (!url) {
            return { error: 'install needs a url.', success: false };
          }
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
        }
        if (action === 'write') {
          const parsed = parseSkill(markdown ?? '');
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
        }
        if (!name) {
          return { error: 'remove needs a name.', success: false };
        }
        return (await removeSkill(name))
          ? { success: true, summary: `Removed the ${name} skill.` }
          : {
              error: `"${name}" is not an installed or written skill (built-ins can only be overridden).`,
              success: false,
            };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
