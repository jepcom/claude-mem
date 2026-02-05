# Claude-Mem Worker Server
#
# Runs the claude-mem worker as a centralized service
# for remote hook posting from multiple clients.

FROM oven/bun:1.1-alpine

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache python3

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

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:37777/api/health || exit 1

# Start worker
CMD ["bun", "plugin/scripts/worker-service.cjs", "start", "--foreground"]
