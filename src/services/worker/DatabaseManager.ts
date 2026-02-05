/**
 * DatabaseManager: Single long-lived database connection
 *
 * Responsibility:
 * - Manage database connection for worker lifetime
 * - Provide centralized access to storage (via StorageAdapter)
 * - High-level database operations
 * - ChromaSync integration
 * 
 * Storage adapter is selected from ~/.claude-mem/settings.json:
 *   CLAUDE_MEM_STORAGE_ADAPTER: 'sqlite' | 'postgres' | 'file'
 *   CLAUDE_MEM_STORAGE_CONNECTION_STRING: connection URL for postgres
 */

import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { logger } from '../../utils/logger.js';
import { createStorageAdapterFromSettings, type StorageAdapter } from '../../storage/index.js';
import { SQLiteStorageAdapter } from '../../storage/SQLiteStorageAdapter.js';
import type { DBSession } from '../worker-types.js';

export class DatabaseManager {
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private chromaSync: ChromaSync | null = null;
  private storageAdapter: StorageAdapter | null = null;

  /**
   * Initialize database connection (once, stays open)
   */
  async initialize(): Promise<void> {
    // Create storage adapter from settings
    this.storageAdapter = createStorageAdapterFromSettings();
    await this.storageAdapter.initialize();
    
    logger.info('DB', `Storage adapter initialized: ${this.storageAdapter.name}`);

    // For backwards compatibility: if using SQLite adapter, also set up SessionStore/Search
    // This allows existing code to keep working during migration
    if (this.storageAdapter instanceof SQLiteStorageAdapter) {
      this.sessionStore = this.storageAdapter.getRawStore();
      this.sessionSearch = new SessionSearch();
      logger.info('DB', 'SQLite mode: SessionStore and SessionSearch available');
    } else {
      // For non-SQLite adapters, SessionSearch isn't available
      // Code using SessionSearch will need to use adapter methods instead
      logger.info('DB', `${this.storageAdapter.name} mode: Using StorageAdapter interface`);
    }

    // Initialize ChromaSync (lazy - connects on first search, not at startup)
    this.chromaSync = new ChromaSync('claude-mem');

    logger.info('DB', 'Database initialized');
  }

  /**
   * Close database connection and cleanup all resources
   */
  async close(): Promise<void> {
    // Close ChromaSync first (terminates uvx/python processes)
    if (this.chromaSync) {
      await this.chromaSync.close();
      this.chromaSync = null;
    }

    // Close storage adapter
    if (this.storageAdapter) {
      await this.storageAdapter.close();
      this.storageAdapter = null;
    }

    // Clear references (SessionStore is closed via adapter)
    this.sessionStore = null;
    this.sessionSearch = null;

    logger.info('DB', 'Database closed');
  }

  /**
   * Get StorageAdapter instance (preferred method)
   */
  getStorageAdapter(): StorageAdapter {
    if (!this.storageAdapter) {
      throw new Error('Database not initialized');
    }
    return this.storageAdapter;
  }

  /**
   * Get SessionStore instance (throws if not initialized or not using SQLite)
   * 
   * @deprecated Use getStorageAdapter() for new code. This is for backwards compatibility.
   */
  getSessionStore(): SessionStore {
    if (!this.sessionStore) {
      if (this.storageAdapter && !(this.storageAdapter instanceof SQLiteStorageAdapter)) {
        throw new Error(
          `SessionStore not available with ${this.storageAdapter.name} adapter.\n` +
          'Use getStorageAdapter() methods instead.'
        );
      }
      throw new Error('Database not initialized');
    }
    return this.sessionStore;
  }

  /**
   * Get SessionSearch instance (throws if not initialized or not using SQLite)
   * 
   * @deprecated SessionSearch is SQLite-specific. Use StorageAdapter search methods for other backends.
   */
  getSessionSearch(): SessionSearch {
    if (!this.sessionSearch) {
      if (this.storageAdapter && !(this.storageAdapter instanceof SQLiteStorageAdapter)) {
        throw new Error(
          `SessionSearch not available with ${this.storageAdapter.name} adapter.\n` +
          'Search functionality uses Chroma for all adapters.'
        );
      }
      throw new Error('Database not initialized');
    }
    return this.sessionSearch;
  }

  /**
   * Get ChromaSync instance (throws if not initialized)
   */
  getChromaSync(): ChromaSync {
    if (!this.chromaSync) {
      throw new Error('ChromaSync not initialized');
    }
    return this.chromaSync;
  }

  /**
   * Check if using SQLite adapter (for conditional compatibility code)
   */
  isUsingSQLite(): boolean {
    return this.storageAdapter instanceof SQLiteStorageAdapter;
  }

  /**
   * Get session by ID (throws if not found)
   * Works with any storage adapter.
   */
  async getSessionByIdAsync(sessionDbId: number): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    user_prompt: string;
  }> {
    const adapter = this.getStorageAdapter();
    const session = await adapter.getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    // Map to legacy format expected by existing code
    return {
      id: session.id,
      content_session_id: session.contentSessionId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt || '',
    };
  }

  /**
   * Get session by ID (sync version, SQLite only)
   * @deprecated Use getSessionByIdAsync() for adapter compatibility
   */
  getSessionById(sessionDbId: number): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    user_prompt: string;
  } {
    const session = this.getSessionStore().getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }

  // ============================================================================
  // Adapter-agnostic helper methods (use these for new code)
  // ============================================================================

  /**
   * Create or get existing session by content session ID
   * Works with any storage adapter.
   */
  async createOrGetSession(contentSessionId: string, project: string, userPrompt: string): Promise<number> {
    return this.getStorageAdapter().createSession(contentSessionId, project, userPrompt);
  }

  /**
   * Get prompt number from user prompts
   * Works with any storage adapter.
   */
  async getPromptNumber(contentSessionId: string): Promise<number> {
    return this.getStorageAdapter().getPromptNumberFromUserPrompts(contentSessionId);
  }

  /**
   * Get latest user prompt for a session
   * Works with any storage adapter.
   */
  async getLatestPrompt(contentSessionId: string): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string;
    project: string;
    prompt_number: number;
    prompt_text: string;
    created_at_epoch: number;
  } | null> {
    const adapter = this.getStorageAdapter();
    const prompt = await adapter.getLatestUserPrompt(contentSessionId);
    if (!prompt) return null;
    
    // Get session to get memory_session_id and project
    const session = await adapter.getSessionByContentId(contentSessionId);
    
    return {
      id: prompt.id,
      content_session_id: prompt.contentSessionId,
      memory_session_id: session?.memorySessionId || '',
      project: session?.project || '',
      prompt_number: prompt.promptNumber,
      prompt_text: prompt.promptText,
      created_at_epoch: prompt.createdAtEpoch,
    };
  }

  /**
   * Update memory session ID
   * Works with any storage adapter.
   */
  async updateMemorySession(sessionDbId: number, memorySessionId: string): Promise<void> {
    return this.getStorageAdapter().updateMemorySessionId(sessionDbId, memorySessionId);
  }

  /**
   * Store observation batch with optional summary
   * Works with any storage adapter.
   */
  async storeObservationsAndSummary(
    memorySessionId: string,
    project: string,
    observations: Array<{
      type: string;
      title: string | null;
      subtitle: string | null;
      facts: string[];
      narrative: string | null;
      concepts: string[];
      files_read: string[];
      files_modified: string[];
    }>,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    } | null,
    promptNumber?: number,
    discoveryTokens?: number,
    overrideTimestampEpoch?: number
  ): Promise<{ observationIds: number[]; summaryId: number | null; createdAtEpoch: number }> {
    const adapter = this.getStorageAdapter();
    
    // Map to adapter format
    const mappedObs = observations.map(obs => ({
      type: obs.type as any,
      title: obs.title,
      subtitle: obs.subtitle,
      text: null,
      facts: obs.facts,
      narrative: obs.narrative,
      concepts: obs.concepts,
      filesRead: obs.files_read,
      filesModified: obs.files_modified,
      promptNumber: promptNumber ?? null,
      discoveryTokens: discoveryTokens ?? 0,
    }));

    return adapter.storeObservations(
      memorySessionId,
      project,
      mappedObs,
      summary,
      promptNumber,
      discoveryTokens,
      overrideTimestampEpoch
    );
  }

  /**
   * Get user prompt text by session and prompt number
   * Works with any storage adapter.
   */
  async getUserPromptText(contentSessionId: string, promptNumber: number): Promise<string | null> {
    return this.getStorageAdapter().getUserPrompt(contentSessionId, promptNumber);
  }
}
