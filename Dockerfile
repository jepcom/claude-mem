# Claude-Mem Worker Server
#
# Runs the claude-mem worker as a centralized service
# for remote hook posting from multiple clients.

FROM oven/bun:1.1-alpine

WORKDIR /app

# Install system dependencies + Node.js for Claude CLI
RUN apk add --no-cache python3 nodejs npm

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create Claude config directories (both possible locations)
RUN mkdir -p /root/.config/claude-code /root/.claude

# Copy package files
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install --frozen-lockfile || bun install

# Copy source
COPY . .

# Build (if needed)
RUN bun run build || true

# Create data directory
RUN mkdir -p /data/.claude-mem

# Expose worker port
EXPOSE 37777

# Environment defaults
ENV CLAUDE_MEM_DATA_DIR=/data/.claude-mem
ENV CLAUDE_MEM_WORKER_HOST=0.0.0.0
ENV CLAUDE_MEM_WORKER_PORT=37777

# Health check (use 127.0.0.1, not localhost - IPv6 issue in Alpine)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:37777/api/health || exit 1

# Copy entrypoint
COPY docker-entrypoint.cjs .

# Start worker in foreground
CMD ["node", "docker-entrypoint.cjs"]
