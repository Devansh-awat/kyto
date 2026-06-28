import { E2BSandboxProvider } from '@repo/sandbox';
import { env } from '@/env';
import logger from '@/lib/logger';

// Email now runs host-side as a first-class tool (see lib/ai/tools/email.ts),
// so the AgentMail key is no longer injected into the sandbox.
export const sandbox = new E2BSandboxProvider({
  apiKey: env.E2B_API_KEY,
  logger,
});
