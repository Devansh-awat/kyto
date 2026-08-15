FROM oven/bun:1.3.14

WORKDIR /app
COPY . .
RUN bun install

EXPOSE 8080
CMD ["bun", "run", "--cwd", "apps/bot", "start"]
