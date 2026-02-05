# Storage Adapters

## Overview

Claude-mem supports pluggable storage backends via the **StorageAdapter** interface.
This enables:
- **Shared memory** across multiple machines (PostgreSQL, MySQL)
- **Simple deployments** with zero dependencies (file-based JSON)
- **Cloud-native setups** (Supabase, PlanetScale, etc.)
- **Custom backends** for specific needs

## Remote Worker Mode

Run a single claude-mem worker on a server and have multiple clients (laptops, Clawdbot) POST to it.

### Why Remote Mode?

- **Shared memory pool**: All devices see the same observations and context
- **No DB drivers on clients**: Clients just POST HTTP requests
- **Lower latency**: One HTTP call per event vs. many DB roundtrips

### Server Setup

```bash
# ~/.claude-mem/settings.json on server
{
  "CLAUDE_MEM_WORKER_HOST": "0.0.0.0",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_API_KEY": "sk-your-secure-random-key"
}
```

Then start the worker: `claude-mem worker start`

### Client Setup

```bash
# ~/.claude-mem/settings.json on laptop/client
{
  "CLAUDE_MEM_WORKER_URL": "https://mem.example.com:37777",
  "CLAUDE_MEM_API_KEY": "sk-your-secure-random-key"
}
```

Restart Claude Code — hooks will now POST to the remote server.

### Security Notes

- Use HTTPS (reverse proxy with nginx/caddy)
- Use a strong API key (32+ random chars)
- Consider firewall rules or VPN for extra security

## Quick Start

### Local (Default)
No configuration needed. Uses SQLite in `~/.claude-mem/`.

### File-Based Storage
```json
// ~/.claude-mem/settings.json
{
  "CLAUDE_MEM_STORAGE_ADAPTER": "file",
  "CLAUDE_MEM_STORAGE_DATA_DIR": "~/my-claude-memory"
}
```

### Shared PostgreSQL Server
```json
// ~/.claude-mem/settings.json
{
  "CLAUDE_MEM_STORAGE_ADAPTER": "postgres",
  "CLAUDE_MEM_STORAGE_CONNECTION_STRING": "postgres://user:pass@your-server:5432/claude_mem"
}
```

### Docker Compose (Self-Hosted Server)
```bash
# Clone and start
git clone https://github.com/thedotmack/claude-mem
cd claude-mem
docker-compose up -d

# Configure clients to connect
# See docker-compose.yml for details
```

## Available Adapters

| Adapter | Status | Use Case |
|---------|--------|----------|
| `sqlite` | ✅ Default | Local single-user |
| `file` | ✅ Ready | Zero dependencies, git-trackable |
| `postgres` | ✅ Ready | Shared multi-user, production |
| `mysql` | 🚧 TODO | Shared multi-user |

### PostgreSQL Setup

1. **Install pg package** (if not already):
   ```bash
   npm install pg
   # or: bun add pg
   ```

2. **Start a PostgreSQL server** (or use docker-compose):
   ```bash
   docker-compose up -d db
   ```

3. **Configure your client**:
   ```json
   // ~/.claude-mem/settings.json
   {
     "CLAUDE_MEM_STORAGE_ADAPTER": "postgres",
     "CLAUDE_MEM_STORAGE_CONNECTION_STRING": "postgres://claude-mem:changeme@localhost:5432/claude_mem"
   }
   ```

4. **Restart Claude Code** — it will now connect to the shared database.

## Implementing Your Own Adapter

Implement the `StorageAdapter` interface from `src/storage/StorageAdapter.ts`:

```typescript
import type { StorageAdapter } from 'claude-mem/storage';

export class MyStorageAdapter implements StorageAdapter {
  readonly name = 'my-adapter';
  
  async initialize(): Promise<void> { /* ... */ }
  async close(): Promise<void> { /* ... */ }
  
  // Sessions
  async createSession(...): Promise<number> { /* ... */ }
  async getSessionById(...): Promise<Session | null> { /* ... */ }
  // ... etc
}
```

See `src/storage/FileStorageAdapter.ts` for a complete reference implementation.

---

## Future: Additional Adapter Types

### Memory Format Adapters
Different memory representation formats  

### Platform Hook Adapters
Integration with non-Claude-Code platforms (Clawdbot, etc.)

---

## Architecture

### Current Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        claude-mem                                │
├─────────────────────────────────────────────────────────────────┤
│  Platform Adapters (src/cli/adapters/)                          │
│  ├── claude-code.ts  ← Normalizes Claude Code stdin/stdout      │
│  ├── cursor.ts       ← Normalizes Cursor stdin/stdout           │
│  └── raw.ts          ← Pass-through for testing                 │
├─────────────────────────────────────────────────────────────────┤
│  Search Strategies (src/services/worker/search/strategies/)     │
│  ├── ChromaSearchStrategy   ← Vector semantic search            │
│  ├── SQLiteSearchStrategy   ← Direct SQL queries                │
│  └── HybridSearchStrategy   ← Metadata filter + semantic        │
├─────────────────────────────────────────────────────────────────┤
│  Agent Providers (src/services/worker/)                         │
│  ├── SDKAgent.ts            ← Claude Agent SDK                  │
│  ├── GeminiAgent.ts         ← Google Gemini                     │
│  └── OpenRouterAgent.ts     ← OpenRouter multi-provider         │
├─────────────────────────────────────────────────────────────────┤
│  Storage (HARDCODED)                                            │
│  ├── SQLite (SessionStore, SessionSearch)                       │
│  └── ChromaDB (ChromaSync)                                      │
└─────────────────────────────────────────────────────────────────┘
```

## Proposed: Storage Adapters

### Why?
- SQLite + ChromaDB works well for local single-user but limits deployment options
- Production/multi-user needs PostgreSQL
- Simpler setups want file-based (no DB dependencies)
- Cloud-native wants Supabase/S3

### Interface

```typescript
// src/storage/StorageAdapter.ts
export interface StorageAdapter {
  // Session management
  createSession(session: SessionCreate): Promise<number>;
  getSession(id: number): Promise<Session | null>;
  getSessionByContentId(contentSessionId: string): Promise<Session | null>;
  updateSession(id: number, updates: Partial<Session>): Promise<void>;
  
  // Observations
  saveObservation(obs: Observation): Promise<number>;
  getObservations(sessionId: number, options?: QueryOptions): Promise<Observation[]>;
  
  // Summaries
  saveSummary(summary: Summary): Promise<number>;
  getSummaries(sessionId: number): Promise<Summary[]>;
  
  // Search (delegates to search strategy)
  search(query: SearchQuery): Promise<SearchResults>;
  
  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;
}

// Implementations
// src/storage/adapters/SQLiteAdapter.ts     ← Current behavior
// src/storage/adapters/PostgresAdapter.ts   ← Production-ready
// src/storage/adapters/FileAdapter.ts       ← No dependencies
// src/storage/adapters/SupabaseAdapter.ts   ← Cloud-native
```

### Configuration

```json
// ~/.claude-mem/settings.json
{
  "storage": {
    "adapter": "sqlite",  // sqlite | postgres | file | supabase
    "options": {
      // adapter-specific options
    }
  }
}
```

## Proposed: Memory Format Adapters

### Why?
Different tools expect different memory formats:
- **Clawdbot** uses MEMORY.md + memory/*.md (human-readable markdown)
- **claude-mem** uses SQLite + ChromaDB (structured + vectors)
- **MCP servers** may want JSON-LD or other formats

### Interface

```typescript
// src/formats/MemoryFormatAdapter.ts
export interface MemoryFormatAdapter {
  // Export to format
  exportSession(session: Session): Promise<string>;
  exportObservations(obs: Observation[]): Promise<string>;
  exportSummary(summary: Summary): Promise<string>;
  
  // Import from format
  importSession(data: string): Promise<SessionCreate>;
  importObservations(data: string): Promise<Observation[]>;
  
  // Format metadata
  readonly name: string;
  readonly fileExtension: string;
  readonly mimeType: string;
}

// Implementations
// src/formats/adapters/MarkdownAdapter.ts   ← MEMORY.md style
// src/formats/adapters/JSONAdapter.ts       ← Structured JSON
// src/formats/adapters/JSONLDAdapter.ts     ← Semantic web
```

### Use Cases

1. **Export to MEMORY.md** for Clawdbot integration
2. **Import from MEMORY.md** when migrating to claude-mem
3. **Interop** between different memory systems

## Proposed: Platform Hook Adapters

### Why?
Claude-mem's hooks are tightly coupled to Claude Code's stdin/stdout format.
Other platforms (Clawdbot, custom agents, Discord bots) need different integration.

### Current Flow

```
Claude Code → hooks (stdin JSON) → claude-mem → hooks (stdout JSON)
```

### Proposed Interface

```typescript
// src/hooks/HookAdapter.ts
export interface HookAdapter {
  // Receive events from platform
  onSessionStart(event: SessionStartEvent): Promise<void>;
  onToolUse(event: ToolUseEvent): Promise<void>;
  onSessionEnd(event: SessionEndEvent): Promise<void>;
  
  // Push context back to platform
  getContext(sessionId: string): Promise<ContextPayload>;
  
  // Platform-specific
  readonly platform: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

// Implementations
// src/hooks/adapters/ClaudeCodeHookAdapter.ts  ← Current (stdin/stdout)
// src/hooks/adapters/ClawdbotHookAdapter.ts   ← Clawdbot integration
// src/hooks/adapters/HTTPHookAdapter.ts       ← Webhook-based
// src/hooks/adapters/MCPHookAdapter.ts        ← MCP protocol
```

### Clawdbot Integration Example

```typescript
// src/hooks/adapters/ClawdbotHookAdapter.ts
export class ClawdbotHookAdapter implements HookAdapter {
  readonly platform = 'clawdbot';
  
  // Connect to Clawdbot's session events
  async connect() {
    // Subscribe to Clawdbot session events via file watch or socket
  }
  
  // Translate Clawdbot tool calls to observations
  async onToolUse(event: ToolUseEvent) {
    // Map Clawdbot's tool format to claude-mem observations
  }
  
  // Return context as MEMORY.md snippet or inject into CLAUDE.md
  async getContext(sessionId: string) {
    // Fetch relevant memories, format for Clawdbot
  }
}
```

## Implementation Priorities

1. **Storage Adapters** (High) - Most impactful for different deployment scenarios
2. **Memory Format Adapters** (Medium) - Enables interop with Clawdbot/others
3. **Platform Hook Adapters** (Medium) - Enables non-Claude-Code platforms

## Migration Path

1. Extract current SQLite/Chroma logic into `SQLiteAdapter`
2. Define `StorageAdapter` interface based on extracted API
3. Add adapter factory with configuration
4. Implement additional adapters as needed

## Related Issues/PRs

- [ ] Storage adapter interface definition
- [ ] PostgreSQL adapter for production deployments
- [ ] Memory format export/import for Clawdbot interop
- [ ] Hook adapter for HTTP webhook integration

---

*This is a proposal for discussion. Feedback welcome.*
