import { eq } from 'drizzle-orm';
import { db } from '../client';
import { skills } from '../schema';

export type StoredSkill = typeof skills.$inferSelect;

export async function listStoredSkills(): Promise<StoredSkill[]> {
  return await db.select().from(skills);
}

export async function saveSkill(
  skill: Omit<StoredSkill, 'updatedAt'>
): Promise<void> {
  const { name, ...rest } = skill;
  await db
    .insert(skills)
    .values(skill)
    .onConflictDoUpdate({
      set: { ...rest, updatedAt: new Date() },
      target: skills.name,
    });
}

/** True if there was one. */
export async function deleteSkill(name: string): Promise<boolean> {
  const rows = await db
    .delete(skills)
    .where(eq(skills.name, name))
    .returning({ name: skills.name });
  return rows.length > 0;
}
