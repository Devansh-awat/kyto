FROM oven/bun:1.3.14

# Chromium for the owner's Slack browser (apps/bot/src/lib/slack-browser), which
# runs here rather than in the 1 GB sandbox Slack's page doesn't fit in;
# openssl mints its loopback proxy's certificate; tini is PID 1 so the processes
# Chromium orphans (its crash handler double-forks) are reaped, not left as
# zombies under bun.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation openssl tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Manifests first, source after: `COPY . .` ahead of the install made every
# commit a fresh `bun install` of the whole tree. Now the install layer is
# reused until a manifest or the lockfile changes. A new workspace package
# needs its package.json listed here.
COPY package.json bun.lock bunfig.toml ./
COPY apps/bot/package.json apps/bot/
COPY packages/ai/package.json packages/ai/
COPY packages/db/package.json packages/db/
COPY packages/logging/package.json packages/logging/
COPY packages/sandbox/package.json packages/sandbox/
COPY tooling/cspell/package.json tooling/cspell/
COPY tooling/github/package.json tooling/github/
COPY tooling/typescript/package.json tooling/typescript/
RUN bun install
# agent-browser's postinstall (which bun skips) is what marks its native
# binaries executable; the Slack browser spawns them directly.
RUN find node_modules -path '*agent-browser/bin/agent-browser-linux-*' -exec chmod 755 {} +
COPY . .

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "--cwd", "apps/bot", "start"]
