/**
 * SQLiteStorageAdapter - Default storage backend using bun:sqlite
 * 
 * Wraps the existing SessionStore to implement StorageAdapter interface.
 * This is a thin adapter layer - all actual logic remains in SessionStore.
 */

import type {
  StorageAdapter,
  Session,
  Observation,
  Summary,
  UserPrompt,
  PendingMessage,
  QueryOptions,
  ObservationQueryOptions,
} from './StorageAdapter.js';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { DB_PATH } from '../shared/paths.js';

export class SQLiteStorageAdapter implements StorageAdapter {
  readonly name = 'sqlite';
  private store: SessionStore | null = null;
  private dbPath: string;

  constructor(dbPath: string = DB_PATH) {
    this.dbPath = dbPath;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    this.store = new SessionStore(this.dbPath);
  }

  async close(): Promise<void> {
    if (this.store) {
      this.store.close();
      this.store = null;
    }
  }

  private getStore(): SessionStore {
    if (!this.store) {
      throw new Error('SQLiteStorageAdapter not initialized. Call initialize() first.');
    }
    return this.store;
  }

  // ============================================================================
  // Sessions
  // ============================================================================

  async createSession(contentSessionId: string, project: string, userPrompt: string): Promise<number> {
    return this.getStore().createSDKSession(contentSessionId, project, userPrompt);
  }

  async getSessionById(id: number): Promise<Session | null> {
    const row = this.getStore().getSessionById(id);
    if (!row) return null;
    
    return {
      id: row.id,
      contentSessionId: row.content_session_id,
      memorySessionId: row.memory_session_id,
      project: row.project,
      userPrompt: row.user_prompt,
      startedAt: '', // Not returned by getSessionById
      startedAtEpoch: 0,
      completedAt: null,
      completedAtEpoch: null,
      status: 'active',
    };
  }

  async getSessionByContentId(contentSessionId: string): Promise<Session | null> {
    // SessionStore doesn't have this method directly, we'd need to add it
    // For now, use the db directly
    const store = this.getStore();
    const row = store.db.prepare(
      'SELECT * FROM sdk_sessions WHERE content_session_id = ? LIMIT 1'
    ).get(contentSessionId) as any;
    
    if (!row) return null;
    
    return {
      id: row.id,
      contentSessionId: row.content_session_id,
      memorySessionId: row.memory_session_id,
      project: row.project,
      userPrompt: row.user_prompt,
      startedAt: row.started_at,
      startedAtEpoch: row.started_at_epoch,
      completedAt: row.completed_at,
      completedAtEpoch: row.completed_at_epoch,
      status: row.status,
      workerPort: row.worker_port,
    };
  }

  async updateMemorySessionId(sessionDbId: number, memorySessionId: string): Promise<void> {
    this.getStore().updateMemorySessionId(sessionDbId, memorySessionId);
  }

  async getRecentSessions(project: string, limit: number = 10): Promise<Session[]> {
    const rows = this.getStore().getRecentSessionsWithStatus(project, limit);
    return rows.map(row => ({
      id: 0, // Not returned by this method
      contentSessionId: '',
      memorySessionId: row.memory_session_id,
      project,
      userPrompt: row.user_prompt,
      startedAt: row.started_at,
      startedAtEpoch: 0,
      completedAt: null,
      completedAtEpoch: null,
      status: row.status as 'active' | 'completed' | 'failed',
    }));
  }

  async getAllProjects(): Promise<string[]> {
    return this.getStore().getAllProjects();
  }

  // ============================================================================
  // Observations
  // ============================================================================

  async storeObservation(
    memorySessionId: string,
    project: string,
    observation: Omit<Observation, 'id' | 'memorySessionId' | 'project' | 'createdAt' | 'createdAtEpoch'>,
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number
  ): Promise<{ id: number; createdAtEpoch: number }> {
    return this.getStore().storeObservation(
      memorySessionId,
      project,
      {
        type: observation.type,
        title: observation.title,
        subtitle: observation.subtitle,
        facts: observation.facts,
        narrative: observation.narrative,
        concepts: observation.concepts,
        files_read: observation.filesRead,
        files_modified: observation.filesModified,
      },
      promptNumber,
      discoveryTokens,
      overrideTimestampEpoch
    );
  }

  async getObservationById(id: number): Promise<Observation | null> {
    const row = this.getStore().getObservationById(id);
    if (!row) return null;
    return this.mapObservationRow(row);
  }

  async getObservationsByIds(ids: number[], options?: ObservationQueryOptions): Promise<Observation[]> {
    const rows = this.getStore().getObservationsByIds(ids, {
      orderBy: options?.orderBy,
      limit: options?.limit,
      project: options?.project,
      type: options?.type,
      concepts: options?.concepts,
      files: options?.files,
    });
    return rows.map(row => this.mapObservationRow(row));
  }

  async getObservationsForSession(memorySessionId: string): Promise<Observation[]> {
    const rows = this.getStore().getObservationsForSession(memorySessionId);
    return rows.map(row => ({
      id: 0,
      memorySessionId,
      project: '',
      type: 'discovery' as const,
      title: row.title,
      subtitle: row.subtitle,
      text: null,
      facts: [],
      narrative: null,
      concepts: [],
      filesRead: [],
      filesModified: [],
      promptNumber: row.prompt_number,
      discoveryTokens: 0,
      createdAt: '',
      createdAtEpoch: 0,
    }));
  }

  async getRecentObservations(project: string, limit: number = 20): Promise<Observation[]> {
    const rows = this.getStore().getRecentObservations(project, limit);
    return rows.map(row => ({
      id: 0,
      memorySessionId: '',
      project,
      type: row.type as Observation['type'],
      title: null,
      subtitle: null,
      text: row.text,
      facts: [],
      narrative: null,
      concepts: [],
      filesRead: [],
      filesModified: [],
      promptNumber: row.prompt_number,
      discoveryTokens: 0,
      createdAt: row.created_at,
      createdAtEpoch: 0,
    }));
  }

  async getAllRecentObservations(limit: number = 100): Promise<Observation[]> {
    const rows = this.getStore().getAllRecentObservations(limit);
    return rows.map(row => ({
      id: row.id,
      memorySessionId: '',
      project: row.project,
      type: row.type as Observation['type'],
      title: row.title,
      subtitle: row.subtitle,
      text: row.text,
      facts: [],
      narrative: null,
      concepts: [],
      filesRead: [],
      filesModified: [],
      promptNumber: row.prompt_number,
      discoveryTokens: 0,
      createdAt: row.created_at,
      createdAtEpoch: row.created_at_epoch,
    }));
  }

  // ============================================================================
  // Summaries
  // ============================================================================

  async storeSummary(
    memorySessionId: string,
    project: string,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    },
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number
  ): Promise<{ id: number; createdAtEpoch: number }> {
    return this.getStore().storeSummary(
      memorySessionId,
      project,
      summary,
      promptNumber,
      discoveryTokens,
      overrideTimestampEpoch
    );
  }

  async getSummaryForSession(memorySessionId: string): Promise<Summary | null> {
    const row = this.getStore().getSummaryForSession(memorySessionId);
    if (!row) return null;
    
    return {
      id: 0,
      memorySessionId,
      project: '',
      request: row.request,
      investigated: row.investigated,
      learned: row.learned,
      completed: row.completed,
      nextSteps: row.next_steps,
      filesRead: row.files_read,
      filesEdited: row.files_edited,
      notes: row.notes,
      promptNumber: row.prompt_number,
      discoveryTokens: 0,
      createdAt: row.created_at,
      createdAtEpoch: row.created_at_epoch,
    };
  }

  async getRecentSummaries(project: string, limit: number = 10): Promise<Summary[]> {
    const rows = this.getStore().getRecentSummaries(project, limit);
    return rows.map(row => ({
      id: 0,
      memorySessionId: '',
      project,
      request: row.request,
      investigated: row.investigated,
      learned: row.learned,
      completed: row.completed,
      nextSteps: row.next_steps,
      filesRead: row.files_read,
      filesEdited: row.files_edited,
      notes: row.notes,
      promptNumber: row.prompt_number,
      discoveryTokens: 0,
      createdAt: row.created_at,
      createdAtEpoch: 0,
    }));
  }

  async getAllRecentSummaries(limit: number = 50): Promise<Summary[]> {
    const rows = this.getStore().getAllRecentSummaries(limit);
    return rows.map(row => ({
      id: row.id,
      memorySessionId: '',
      project: row.project,
      request: row.request,
      investigated: row.investigated,
      learned: row.learned,
      completed: row.completed,
      nextSteps: row.next_steps,
      filesRead: row.files_read,
      filesEdited: row.files_edited,
      notes: row.notes,
      promptNumber: row.prompt_number,
      discoveryTokens: 0,
      createdAt: row.created_at,
      createdAtEpoch: row.created_at_epoch,
    }));
  }

  // ============================================================================
  // User Prompts
  // ============================================================================

  async saveUserPrompt(contentSessionId: string, promptNumber: number, promptText: string): Promise<number> {
    return this.getStore().saveUserPrompt(contentSessionId, promptNumber, promptText);
  }

  async getUserPrompt(contentSessionId: string, promptNumber: number): Promise<string | null> {
    return this.getStore().getUserPrompt(contentSessionId, promptNumber);
  }

  async getLatestUserPrompt(contentSessionId: string): Promise<UserPrompt | null> {
    const row = this.getStore().getLatestUserPrompt(contentSessionId);
    if (!row) return null;
    
    return {
      id: row.id,
      contentSessionId: row.content_session_id,
      promptNumber: row.prompt_number,
      promptText: row.prompt_text,
      createdAt: '',
      createdAtEpoch: row.created_at_epoch,
    };
  }

  async getPromptNumberFromUserPrompts(contentSessionId: string): Promise<number> {
    return this.getStore().getPromptNumberFromUserPrompts(contentSessionId);
  }

  async getAllRecentUserPrompts(limit: number = 100): Promise<UserPrompt[]> {
    const rows = this.getStore().getAllRecentUserPrompts(limit);
    return rows.map(row => ({
      id: row.id,
      contentSessionId: row.content_session_id,
      promptNumber: row.prompt_number,
      promptText: row.prompt_text,
      createdAt: row.created_at,
      createdAtEpoch: row.created_at_epoch,
    }));
  }

  // ============================================================================
  // Pending Messages
  // ============================================================================

  async enqueuePendingMessage(
    message: Omit<PendingMessage, 'id' | 'status' | 'retryCount' | 'startedProcessingAtEpoch' | 'completedAtEpoch' | 'failedAtEpoch'>
  ): Promise<number> {
    const store = this.getStore();
    const result = store.db.prepare(`
      INSERT INTO pending_messages
      (session_db_id, content_session_id, message_type, tool_name, tool_input, tool_response,
       cwd, last_user_message, last_assistant_message, prompt_number, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.sessionDbId,
      message.contentSessionId,
      message.messageType,
      message.toolName,
      message.toolInput,
      message.toolResponse,
      message.cwd,
      message.lastUserMessage,
      message.lastAssistantMessage,
      message.promptNumber,
      message.createdAtEpoch
    );
    return result.lastInsertRowid as number;
  }

  async getPendingMessages(sessionDbId: number): Promise<PendingMessage[]> {
    const store = this.getStore();
    const rows = store.db.prepare(`
      SELECT * FROM pending_messages WHERE session_db_id = ? AND status = 'pending'
      ORDER BY created_at_epoch ASC
    `).all(sessionDbId) as any[];
    
    return rows.map(row => this.mapPendingMessageRow(row));
  }

  async claimPendingMessage(sessionDbId: number): Promise<PendingMessage | null> {
    const store = this.getStore();
    const now = Date.now();
    
    // Atomic claim: update status and return the row
    const row = store.db.prepare(`
      UPDATE pending_messages
      SET status = 'processing', started_processing_at_epoch = ?
      WHERE id = (
        SELECT id FROM pending_messages
        WHERE session_db_id = ? AND status = 'pending'
        ORDER BY created_at_epoch ASC
        LIMIT 1
      )
      RETURNING *
    `).get(now, sessionDbId) as any;
    
    if (!row) return null;
    return this.mapPendingMessageRow(row);
  }

  async completePendingMessage(messageId: number): Promise<void> {
    const store = this.getStore();
    store.db.prepare(`
      UPDATE pending_messages
      SET status = 'processed', completed_at_epoch = ?
      WHERE id = ?
    `).run(Date.now(), messageId);
  }

  async failPendingMessage(messageId: number): Promise<void> {
    const store = this.getStore();
    store.db.prepare(`
      UPDATE pending_messages
      SET status = 'failed', failed_at_epoch = ?, retry_count = retry_count + 1
      WHERE id = ?
    `).run(Date.now(), messageId);
  }

  // ============================================================================
  // Batch Operations
  // ============================================================================

  async storeObservations(
    memorySessionId: string,
    project: string,
    observations: Array<Omit<Observation, 'id' | 'memorySessionId' | 'project' | 'createdAt' | 'createdAtEpoch'>>,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    } | null,
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number
  ): Promise<{ observationIds: number[]; summaryId: number | null; createdAtEpoch: number }> {
    // Map to SessionStore format
    const mappedObs = observations.map(obs => ({
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      facts: obs.facts,
      narrative: obs.narrative,
      concepts: obs.concepts,
      files_read: obs.filesRead,
      files_modified: obs.filesModified,
    }));
    
    return this.getStore().storeObservations(
      memorySessionId,
      project,
      mappedObs,
      summary,
      promptNumber,
      discoveryTokens,
      overrideTimestampEpoch
    );
  }

  // ============================================================================
  // Files
  // ============================================================================

  async getFilesForSession(memorySessionId: string): Promise<{ filesRead: string[]; filesModified: string[] }> {
    return this.getStore().getFilesForSession(memorySessionId);
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private mapObservationRow(row: any): Observation {
    return {
      id: row.id,
      memorySessionId: row.memory_session_id,
      project: row.project,
      type: row.type,
      title: row.title,
      subtitle: row.subtitle,
      text: row.text,
      facts: row.facts ? JSON.parse(row.facts) : [],
      narrative: row.narrative,
      concepts: row.concepts ? JSON.parse(row.concepts) : [],
      filesRead: row.files_read ? JSON.parse(row.files_read) : [],
      filesModified: row.files_modified ? JSON.parse(row.files_modified) : [],
      promptNumber: row.prompt_number,
      discoveryTokens: row.discovery_tokens || 0,
      createdAt: row.created_at,
      createdAtEpoch: row.created_at_epoch,
    };
  }

  private mapPendingMessageRow(row: any): PendingMessage {
    return {
      id: row.id,
      sessionDbId: row.session_db_id,
      contentSessionId: row.content_session_id,
      messageType: row.message_type,
      toolName: row.tool_name,
      toolInput: row.tool_input,
      toolResponse: row.tool_response,
      cwd: row.cwd,
      lastUserMessage: row.last_user_message,
      lastAssistantMessage: row.last_assistant_message,
      promptNumber: row.prompt_number,
      status: row.status,
      retryCount: row.retry_count,
      createdAtEpoch: row.created_at_epoch,
      startedProcessingAtEpoch: row.started_processing_at_epoch,
      completedAtEpoch: row.completed_at_epoch,
      failedAtEpoch: row.failed_at_epoch,
    };
  }
  
  /**
   * Get raw database access for advanced queries
   * (Escape hatch for code that needs direct DB access during migration)
   */
  getRawStore(): SessionStore {
    return this.getStore();
  }
}
