# Adapter Architecture Proposal

## Overview

This document proposes adding adapter patterns to claude-mem in three key areas:
1. **Storage Adapters** - Pluggable persistence backends
2. **Memory Format Adapters** - Different memory representation formats  
3. **Platform Hook Adapters** - Integration with non-Claude-Code platforms

## Current Architecture

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
