import { db } from '../client';
import { type IdentityProfile, identityProfiles } from '../schema/identity';

export type { IdentityProfile } from '../schema/identity';

export async function getIdentityProfiles(): Promise<IdentityProfile[]> {
  return await db.select().from(identityProfiles);
}

export async function setIdentityProfile(
  messageType: string,
  values: { icon: string | null; nameSuffix: string | null }
): Promise<void> {
  await db
    .insert(identityProfiles)
    .values({
      icon: values.icon,
      messageType,
      nameSuffix: values.nameSuffix,
    })
    .onConflictDoUpdate({
      set: { icon: values.icon, nameSuffix: values.nameSuffix },
      target: identityProfiles.messageType,
    });
}
