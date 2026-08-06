import { env } from '@/env';
import {
  githubProxyEnv,
  githubProxyGitConfig,
  registerGithubProxyToken,
  revokeGithubProxyToken,
} from '@/lib/github-proxy';
import {
  registerProxyToken,
  revokeProxyToken,
  slackHelperInstall,
  slackProxyEnv,
} from '@/lib/slack-proxy';

// Everything a sandbox needs to reach the two host-side proxies, in one place
// because there are three callers that must stay identical: a live turn, a
// `bash` reminder, and an `agent` reminder. The GitHub one in particular is a
// security boundary — a caller that quietly forgot it would not fail loudly,
// it would just run without GitHub credentials and look like a broken token.

export interface SandboxProxies {
  /** Runs at every materialization; installs the `slack` helper and points git at the proxy. */
  bootstrapCommand: string | undefined;
  /** Re-sent on EVERY command, so a resumed sandbox never uses a revoked token. */
  env: Record<string, string>;
  revoke(): void;
}

/**
 * Mint this turn's (or this reminder fire's) proxy tokens.
 *
 * Both proxies live on the sites server, so with `SITES_ENABLED` off there is
 * no Slack access and no GitHub CREDENTIAL from inside a sandbox at all —
 * anonymous public reads still work, writes fail at GitHub. That is the safe
 * direction: the fallback for a missing proxy is no privilege, never the old
 * egress brokering.
 */
export function openSandboxProxies({
  isOwner,
  threadId,
  userId,
}: {
  isOwner: boolean;
  threadId?: string;
  /** The principal every GitHub write through this sandbox is guarded as. */
  userId?: string;
}): SandboxProxies {
  if (!env.SITES_ENABLED) {
    return { bootstrapCommand: undefined, env: {}, revoke: () => undefined };
  }
  const host = env.SITES_PUBLIC_HOST;
  const slackSecret = registerProxyToken();
  const githubSecret = registerGithubProxyToken({ isOwner, threadId, userId });
  return {
    bootstrapCommand: [slackHelperInstall(), githubProxyGitConfig(host)].join(
      '\n'
    ),
    env: {
      ...slackProxyEnv(slackSecret, host),
      ...githubProxyEnv(githubSecret, host),
    },
    revoke: () => {
      revokeProxyToken(slackSecret);
      revokeGithubProxyToken(githubSecret);
    },
  };
}
