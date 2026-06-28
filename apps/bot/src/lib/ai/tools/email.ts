import { AgentMailClient } from 'agentmail';
import { tool } from 'ai';
import { z } from 'zod';
import { errorMessage } from '@/lib/utils/error';

// Email runs on the host (not the sandbox): AgentMail is a plain HTTP API, so a
// first-class tool is more reliable and visible than asking the model to write
// sandbox code. The API key lives on the host only.

const recipientsSchema = z
  .union([z.string(), z.array(z.string())])
  .describe('Recipient email address(es).');

async function resolveInboxId(
  client: AgentMailClient,
  inboxId?: string
): Promise<string> {
  if (inboxId) {
    return inboxId;
  }
  const { inboxes } = await client.inboxes.list();
  const first = inboxes.at(0);
  if (!first) {
    throw new Error(
      'No AgentMail inbox exists yet. Create one in AgentMail first.'
    );
  }
  return first.inboxId;
}

export function sendEmailTool({ apiKey }: { apiKey: string }) {
  const client = new AgentMailClient({ apiKey });
  return tool({
    description:
      "Send an email from kyto's own inbox (via AgentMail). Use for sending messages, notifications, or replies to external email addresses.",
    inputSchema: z.object({
      to: recipientsSchema,
      subject: z.string().min(1).max(998),
      text: z.string().min(1).describe('Plain-text body of the email.'),
      cc: recipientsSchema.optional(),
      bcc: recipientsSchema.optional(),
      html: z.string().optional().describe('Optional HTML body.'),
      inboxId: z
        .string()
        .optional()
        .describe('Sending inbox id. Defaults to the first inbox.'),
    }),
    execute: async ({ bcc, cc, html, inboxId, subject, text, to }) => {
      try {
        const resolvedInbox = await resolveInboxId(client, inboxId);
        const result = await client.inboxes.messages.send(resolvedInbox, {
          to,
          subject,
          text,
          ...(html ? { html } : {}),
          ...(cc ? { cc } : {}),
          ...(bcc ? { bcc } : {}),
        });
        const recipients = Array.isArray(to) ? to.join(', ') : to;
        return {
          success: true,
          messageId: result.messageId,
          summary: `Sent email "${subject}" to ${recipients}.`,
        };
      } catch (error) {
        return {
          success: false,
          error: errorMessage(error),
          summary: `Failed to send email: ${errorMessage(error)}`,
        };
      }
    },
  });
}

export function checkInboxTool({ apiKey }: { apiKey: string }) {
  const client = new AgentMailClient({ apiKey });
  return tool({
    description:
      "Read recent messages from kyto's own email inbox (via AgentMail).",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).default(10),
      inboxId: z
        .string()
        .optional()
        .describe('Inbox id to read. Defaults to the first inbox.'),
    }),
    execute: async ({ inboxId, limit }) => {
      try {
        const resolvedInbox = await resolveInboxId(client, inboxId);
        const { messages } = await client.inboxes.messages.list(resolvedInbox, {
          limit,
        });
        return {
          success: true,
          messageCount: messages.length,
          messages: messages.map((message) => ({
            id: message.messageId,
            from: message.from,
            subject: message.subject,
            preview: message.preview,
          })),
          summary: `Found ${messages.length} message${messages.length === 1 ? '' : 's'} in the inbox.`,
        };
      } catch (error) {
        return {
          success: false,
          error: errorMessage(error),
          summary: `Failed to read inbox: ${errorMessage(error)}`,
        };
      }
    },
  });
}

export function replyEmailTool({ apiKey }: { apiKey: string }) {
  const client = new AgentMailClient({ apiKey });
  return tool({
    description:
      "Reply to a message in kyto's email inbox (via AgentMail). Use the message id from checkInbox.",
    inputSchema: z.object({
      messageId: z.string().min(1),
      text: z.string().min(1).describe('Plain-text reply body.'),
      html: z.string().optional(),
      inboxId: z
        .string()
        .optional()
        .describe('Inbox id the message belongs to. Defaults to the first.'),
    }),
    execute: async ({ html, inboxId, messageId, text }) => {
      try {
        const resolvedInbox = await resolveInboxId(client, inboxId);
        const result = await client.inboxes.messages.reply(
          resolvedInbox,
          messageId,
          { text, ...(html ? { html } : {}) }
        );
        return {
          success: true,
          messageId: result.messageId,
          summary: `Replied to email ${messageId}.`,
        };
      } catch (error) {
        return {
          success: false,
          error: errorMessage(error),
          summary: `Failed to reply: ${errorMessage(error)}`,
        };
      }
    },
  });
}
