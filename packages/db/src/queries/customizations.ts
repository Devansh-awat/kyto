import { eq } from 'drizzle-orm';
import { db } from '../client';
import {
  type ModelMode,
  type UserCustomization,
  userCustomizations,
} from '../schema';

export type { ModelMode } from '../schema';

export async function getUserCustomization(
  userId: string
): Promise<UserCustomization | null> {
  const rows = await db
    .select({
      modelMode: userCustomizations.modelMode,
      prompt: userCustomizations.prompt,
      showUsageFooter: userCustomizations.showUsageFooter,
    })
    .from(userCustomizations)
    .where(eq(userCustomizations.userId, userId))
    .limit(1);

  return rows[0] ?? null;
}

/** Choose which models a person with their own key runs on (upserts). */
export async function setModelMode(
  userId: string,
  modelMode: ModelMode
): Promise<void> {
  await db
    .insert(userCustomizations)
    .values({ modelMode, prompt: '', userId })
    .onConflictDoUpdate({
      set: { modelMode, updatedAt: new Date() },
      target: userCustomizations.userId,
    });
}

/** Toggle the per-turn usage footer for a user (upserts a row if needed). */
export async function setUsageFooter(
  userId: string,
  showUsageFooter: boolean
): Promise<void> {
  await db
    .insert(userCustomizations)
    .values({ prompt: '', showUsageFooter, userId })
    .onConflictDoUpdate({
      set: { showUsageFooter, updatedAt: new Date() },
      target: userCustomizations.userId,
    });
}

export async function setUserCustomization(
  userId: string,
  customization: Pick<UserCustomization, 'prompt'>
): Promise<void> {
  await db
    .insert(userCustomizations)
    .values({ prompt: customization.prompt, userId })
    .onConflictDoUpdate({
      set: { prompt: customization.prompt, updatedAt: new Date() },
      target: userCustomizations.userId,
    });
}

export async function clearUserCustomization(userId: string): Promise<void> {
  await db
    .delete(userCustomizations)
    .where(eq(userCustomizations.userId, userId));
}
