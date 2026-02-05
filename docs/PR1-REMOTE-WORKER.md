# PR1: Remote Worker Mode

## Goal
Enable claude-mem hooks to POST to a remote worker server, allowing:
- Multiple laptops → one central memory pool
- Clawdbot → same memory pool
- No DB drivers needed on clients

## Architecture

```
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│     Laptop 1     │      │     Laptop 2     │      │    Clawdbot      │
│  (Claude Code)   │      │  (Claude Code)   │      │  (Hook Adapter)  │
└────────┬─────────┘      └────────┬─────────┘      └────────┬─────────┘
         │                         │                         │
         │ POST /api/sessions/*    │ POST                    │ POST
         │ + Bearer token          │                         │
         └─────────────────────────┼─────────────────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │    Central Worker Server     │
                    │   https://mem.exerun.com     │
                    │                              │
                    │  ┌─────────────────────────┐ │
                    │  │  Auth Middleware        │ │
                    │  │  (API key validation)   │ │
                    │  └───────────┬─────────────┘ │
                    │              │               │
                    │  ┌───────────▼─────────────┐ │
                    │  │  Worker (existing)      │ │
                    │  │  - SessionRoutes        │ │
                    │  │  - SearchRoutes         │ │
                    │  │  - SDKAgent             │ │
                    │  └───────────┬─────────────┘ │
                    │              │               │
                    │  ┌───────────▼─────────────┐ │
                    │  │  SQLite (local)         │ │
                    │  │  ~/.claude-mem/db.sqlite│ │
                    │  └─────────────────────────┘ │
                    └──────────────────────────────┘
```

## New Settings

```typescript
// ~/.claude-mem/settings.json

// CLIENT (laptop) settings:
{
  "CLAUDE_MEM_WORKER_URL": "https://mem.exerun.com:37777",  // Remote URL (empty = local)
  "CLAUDE_MEM_API_KEY": "sk-your-shared-secret"            // Auth token for remote
}

// SERVER (central worker) settings:
{
  "CLAUDE_MEM_WORKER_HOST": "0.0.0.0",    // Bind to all interfaces
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_API_KEY": "sk-your-shared-secret"  // Required key for incoming requests
}
```

## Changes Required

### 1. Settings (`src/shared/SettingsDefaultsManager.ts`)

```typescript
// Add new settings
CLAUDE_MEM_WORKER_URL: string;   // Full URL to remote worker (empty = local mode)
CLAUDE_MEM_API_KEY: string;      // API key for auth

// Defaults
CLAUDE_MEM_WORKER_URL: '',       // Empty = local mode (http://127.0.0.1:{port})
CLAUDE_MEM_API_KEY: '',          // Empty = no auth required
```

### 2. Worker URL Helper (`src/shared/worker-utils.ts`)

```typescript
/**
 * Get the base URL for the worker API
 * Uses CLAUDE_MEM_WORKER_URL if set, otherwise constructs from host:port
 */
export function getWorkerBaseUrl(): string {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  
  // Remote mode: use explicit URL
  const remoteUrl = settings.CLAUDE_MEM_WORKER_URL;
  if (remoteUrl) {
    return remoteUrl.replace(/\/$/, '');  // Strip trailing slash
  }
  
  // Local mode: construct from host:port
  return `http://${getWorkerHost()}:${getWorkerPort()}`;
}

/**
 * Get headers for worker API requests
 * Includes auth token if configured
 */
export function getWorkerHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const apiKey = settings.CLAUDE_MEM_API_KEY;
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  
  return headers;
}
```

### 3. Update Handlers

**Files to update:**
- `src/cli/handlers/session-init.ts`
- `src/cli/handlers/observation.ts`
- `src/cli/handlers/file-edit.ts`
- `src/cli/handlers/summarize.ts`

**Pattern:**
```typescript
// Before
const port = getWorkerPort();
await fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(...)
});

// After
const baseUrl = getWorkerBaseUrl();
await fetch(`${baseUrl}/api/sessions/init`, {
  method: 'POST',
  headers: getWorkerHeaders(),
  body: JSON.stringify(...)
});
```

### 4. Auth Middleware (`src/services/worker/http/middleware.ts`)

```typescript
/**
 * API key authentication middleware
 * - If CLAUDE_MEM_API_KEY is not set: allow all (local mode)
 * - If set: require matching Bearer token
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const expectedKey = settings.CLAUDE_MEM_API_KEY;
  
  // No key configured = local mode, allow all
  if (!expectedKey) {
    return next();
  }
  
  // Extract Bearer token
  const authHeader = req.headers.authorization;
  const providedKey = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;
  
  if (providedKey !== expectedKey) {
    logger.warn('SECURITY', 'API key authentication failed', {
      endpoint: req.path,
      clientIp: req.ip
    });
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or missing API key'
    });
    return;
  }
  
  next();
}
```

### 5. Apply Auth to Routes

**Files to update:**
- `src/services/worker/http/routes/SessionRoutes.ts`
- `src/services/worker/http/routes/SearchRoutes.ts`

```typescript
// Apply auth middleware to session routes
router.use('/api/sessions', requireApiKey);

// Public routes (health, version) don't need auth
router.get('/api/health', healthHandler);
router.get('/api/version', versionHandler);
```

### 6. Fix Health Check (`src/shared/worker-utils.ts`)

```typescript
// isWorkerHealthy() currently hardcodes 127.0.0.1
// Update to use getWorkerBaseUrl()

async function isWorkerHealthy(): Promise<boolean> {
  const baseUrl = getWorkerBaseUrl();
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: getWorkerHeaders()  // Include auth for remote
  });
  return response.ok;
}
```

## Deployment

### Server Setup (mem.exerun.com)

```bash
# 1. Install claude-mem
npm install -g claude-mem

# 2. Configure as server
cat > ~/.claude-mem/settings.json << 'EOF'
{
  "CLAUDE_MEM_WORKER_HOST": "0.0.0.0",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_API_KEY": "sk-your-secure-random-key"
}
EOF

# 3. Start worker (via systemd, pm2, or screen)
claude-mem worker start

# 4. (Optional) Reverse proxy with nginx/caddy for HTTPS
```

### Client Setup (laptops)

```bash
# Configure to use remote worker
cat > ~/.claude-mem/settings.json << 'EOF'
{
  "CLAUDE_MEM_WORKER_URL": "https://mem.exerun.com:37777",
  "CLAUDE_MEM_API_KEY": "sk-your-secure-random-key"
}
EOF

# Restart Claude Code - hooks will now POST to remote
```

## Security Considerations

1. **API Key**: Use a strong random key (32+ chars)
2. **HTTPS**: Use reverse proxy (nginx/caddy) for TLS
3. **Firewall**: Only expose 37777 to trusted IPs or via tunnel
4. **Localhost-only routes**: Keep admin endpoints (settings, pending-queue) localhost-only

## Testing Plan

1. **Local mode** (no CLAUDE_MEM_WORKER_URL): Works as before
2. **Remote mode**:
   - Start worker on server with API key
   - Configure client with URL + key
   - Run Claude Code, verify observations stored on server
3. **Auth failure**: Invalid/missing key returns 401
4. **Health check**: Works for both local and remote

## Files Changed

```
src/shared/SettingsDefaultsManager.ts   # Add WORKER_URL, API_KEY
src/shared/worker-utils.ts              # Add getWorkerBaseUrl(), getWorkerHeaders()
src/cli/handlers/session-init.ts        # Use new helpers
src/cli/handlers/observation.ts         # Use new helpers
src/cli/handlers/file-edit.ts           # Use new helpers
src/cli/handlers/summarize.ts           # Use new helpers
src/services/worker/http/middleware.ts  # Add requireApiKey()
src/services/worker/http/routes/*.ts    # Apply auth middleware
docs/REMOTE-WORKER.md                   # User documentation
```

## Future: Clawdbot Integration

Once this PR lands, Clawdbot integration becomes simple:

```typescript
// Clawdbot hook adapter (future PR)
// Just POST to the same worker API

async function onToolUse(event: ToolUseEvent) {
  await fetch(`${CLAUDE_MEM_WORKER_URL}/api/sessions/observations`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CLAUDE_MEM_API_KEY}`
    },
    body: JSON.stringify({
      contentSessionId: event.sessionId,
      tool_name: event.toolName,
      tool_input: event.toolInput,
      tool_response: event.toolOutput,
      cwd: event.workingDir
    })
  });
}
```

---

## Status

- [x] Design document
- [ ] Implementation
- [ ] Tests
- [ ] Documentation
- [ ] PR to upstream
