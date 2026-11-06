import { tool } from 'ai';
import { z } from 'zod';
import { withdrawApproval } from '@/lib/approvals/request';
import { errorMessage } from '@/lib/utils/error';

/**
 * Take back a request the person queued for the owner's approval (#189). Only
 * ever their own: the claim matches the row's `requestedBy`, so this can't
 * touch anyone else's request and grants nothing.
 */
export function withdrawApprovalTool({
  authorUserId,
}: {
  authorUserId: string;
}) {
  return tool({
    description:
      'Withdraw a pending approval request (the owner\'s Approve/Deny card, "request #N") that the person talking to you queued, when they change their mind or it was sent another way. Only their OWN requests; the card is updated and the thread is told. The owner\'s decision buttons are unaffected for anything else.',
    inputSchema: z.object({
      id: z
        .number()
        .int()
        .positive()
        .describe('The request number, from "request #N".'),
    }),
    execute: async ({ id }) => {
      try {
        const result = await withdrawApproval({ id, userId: authorUserId });
        return result.ok
          ? { success: true, summary: result.detail }
          : { error: result.detail, success: false };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
