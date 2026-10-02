FROM oven/bun:1.3.14

# Chromium for the owner's Slack browser (apps/bot/src/lib/slack-browser), which
# runs here rather than in the 1 GB sandbox Slack's page doesn't fit in;
# openssl mints its loopback proxy's certificate.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN bun install

EXPOSE 8080
CMD ["bun", "run", "--cwd", "apps/bot", "start"]
