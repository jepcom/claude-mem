/**
 * PostgresStorageAdapter - PostgreSQL storage for shared memory
 * 
 * Enables multiple Claude instances to share the same memory by
 * connecting to a central PostgreSQL database.
 * 
 * Usage:
 *   ~/.claude-mem/settings.json:
 *   {
 *     "CLAUDE_MEM_STORAGE_ADAPTER": "postgres",
 *     "CLAUDE_MEM_STORAGE_CONNECTION_STRING": "postgres://user:pass@host:5432/claude_mem"
 *   }
 */

import type {
  StorageAdapter,
  Session,
  Observation,
  Summary,
  UserPrompt,
  PendingMessage,
  ObservationQueryOptions,
} from './StorageAdapter.js';

// Dynamic import for pg to avoid bundling issues
let pg: any;

export class PostgresStorageAdapter implements StorageAdapter {
  readonly name = 'postgres';
  private pool: any = null;
  private connectionString: string;

  constructor(connectionString: string) {
    if (!connectionString) {
      throw new Error(
        'PostgreSQL connection string required.\n' +
        'Set CLAUDE_MEM_STORAGE_CONNECTION_STRING in ~/.claude-mem/settings.json'
      );
    }
    this.connectionString = connectionString;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    // Dynamic import pg
    try {
      pg = await import('pg');
    } catch (e) {
      throw new Error(
        'PostgreSQL adapter requires the "pg" package.\n' +
        'Install it: npm install pg\n' +
        'Or: bun add pg'
      );
    }

    this.pool = new pg.Pool({
      connectionString: this.connectionString,
    });

    // Test connection
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }

    // Initialize schema
    await this.initializeSchema();
  }

  private async initializeSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        -- Sessions table
        CREATE TABLE IF NOT EXISTS sdk_sessions (
          id SERIAL PRIMARY KEY,
          content_session_id TEXT UNIQUE NOT NULL,
          memory_session_id TEXT UNIQUE,
          project TEXT NOT NULL,
          user_prompt TEXT,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          started_at_epoch BIGINT NOT NULL,
          completed_at TIMESTAMPTZ,
          completed_at_epoch BIGINT,
          status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active',
          worker_port INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_sdk_sessions_content_id ON sdk_sessions(content_session_id);
        CREATE INDEX IF NOT EXISTS idx_sdk_sessions_memory_id ON sdk_sessions(memory_session_id);
        CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
        CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);

        -- Observations table
        CREATE TABLE IF NOT EXISTS observations (
          id SERIAL PRIMARY KEY,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
          title TEXT,
          subtitle TEXT,
          text TEXT,
          facts JSONB DEFAULT '[]',
          narrative TEXT,
          concepts JSONB DEFAULT '[]',
          files_read JSONB DEFAULT '[]',
          files_modified JSONB DEFAULT '[]',
          prompt_number INTEGER,
          discovery_tokens INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at_epoch BIGINT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_observations_memory_session ON observations(memory_session_id);
        CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
        CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
        CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);

        -- Session summaries table
        CREATE TABLE IF NOT EXISTS session_summaries (
          id SERIAL PRIMARY KEY,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          request TEXT,
          investigated TEXT,
          learned TEXT,
          completed TEXT,
          next_steps TEXT,
          files_read TEXT,
          files_edited TEXT,
          notes TEXT,
          prompt_number INTEGER,
          discovery_tokens INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at_epoch BIGINT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_session_summaries_memory_session ON session_summaries(memory_session_id);
        CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);

        -- User prompts table
        CREATE TABLE IF NOT EXISTS user_prompts (
          id SERIAL PRIMARY KEY,
          content_session_id TEXT NOT NULL,
          prompt_number INTEGER NOT NULL,
          prompt_text TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at_epoch BIGINT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_user_prompts_content_session ON user_prompts(content_session_id);
        CREATE INDEX IF NOT EXISTS idx_user_prompts_lookup ON user_prompts(content_session_id, prompt_number);

        -- Pending messages table (work queue)
        CREATE TABLE IF NOT EXISTS pending_messages (
          id SERIAL PRIMARY KEY,
          session_db_id INTEGER NOT NULL,
          content_session_id TEXT NOT NULL,
          message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
          tool_name TEXT,
          tool_input TEXT,
          tool_response TEXT,
          cwd TEXT,
          last_user_message TEXT,
          last_assistant_message TEXT,
          prompt_number INTEGER,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
          retry_count INTEGER NOT NULL DEFAULT 0,
          created_at_epoch BIGINT NOT NULL,
          started_processing_at_epoch BIGINT,
          completed_at_epoch BIGINT,
          failed_at_epoch BIGINT
        );

        CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id);
        CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status);
      `);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  private getPool(): any {
    if (!this.pool) {
      throw new Error('PostgresStorageAdapter not initialized. Call initialize() first.');
    }
    return this.pool;
  }

  // ============================================================================
  // Sessions
  // ============================================================================

  async createSession(contentSessionId: string, project: string, userPrompt: string): Promise<number> {
    const pool = this.getPool();
    const nowEpoch = Date.now();

    // Upsert - return existing if already exists
    const result = await pool.query(`
      INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at_epoch)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (content_session_id) DO UPDATE SET content_session_id = EXCLUDED.content_session_id
      RETURNING id
    `, [contentSessionId, project, userPrompt, nowEpoch]);

    return result.rows[0].id;
  }

  async getSessionById(id: number): Promise<Session | null> {
    const pool = this.getPool();
    const result = await pool.query(
      'SELECT * FROM sdk_sessions WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) return null;
    return this.mapSessionRow(result.rows[0]);
  }

  async getSessionByContentId(contentSessionId: string): Promise<Session | null> {
    const pool = this.getPool();
    const result = await pool.query(
      'SELECT * FROM sdk_sessions WHERE content_session_id = $1',
      [contentSessionId]
    );

    if (result.rows.length === 0) return null;
    return this.mapSessionRow(result.rows[0]);
  }

  async updateMemorySessionId(sessionDbId: number, memorySessionId: string): Promise<void> {
    const pool = this.getPool();
    await pool.query(
      'UPDATE sdk_sessions SET memory_session_id = $1 WHERE id = $2',
      [memorySessionId, sessionDbId]
    );
  }

  async getRecentSessions(project: string, limit: number = 10): Promise<Session[]> {
    const pool = this.getPool();
    const result = await pool.query(
      'SELECT * FROM sdk_sessions WHERE project = $1 ORDER BY started_at_epoch DESC LIMIT $2',
      [project, limit]
    );

    return result.rows.map((row: any) => this.mapSessionRow(row));
  }

  async getAllProjects(): Promise<string[]> {
    const pool = this.getPool();
    const result = await pool.query(
      "SELECT DISTINCT project FROM sdk_sessions WHERE project IS NOT NULL AND project != '' ORDER BY project"
    );

    return result.rows.map((row: any) => row.project);
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
    const pool = this.getPool();
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();

    const result = await pool.query(`
      INSERT INTO observations (
        memory_session_id, project, type, title, subtitle, text, facts, narrative,
        concepts, files_read, files_modified, prompt_number, discovery_tokens, created_at_epoch
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id
    `, [
      memorySessionId,
      project,
      observation.type,
      observation.title,
      observation.subtitle,
      observation.text,
      JSON.stringify(observation.facts),
      observation.narrative,
      JSON.stringify(observation.concepts),
      JSON.stringify(observation.filesRead),
      JSON.stringify(observation.filesModified),
      promptNumber,
      discoveryTokens,
      timestampEpoch,
    ]);

    return { id: result.rows[0].id, createdAtEpoch: timestampEpoch };
  }

  async getObservationById(id: number): Promise<Observation | null> {
    const pool = this.getPool();
    const result = await pool.query('SELECT * FROM observations WHERE id = $1', [id]);

    if (result.rows.length === 0) return null;
    return this.mapObservationRow(result.rows[0]);
  }

  async getObservationsByIds(ids: number[], options?: ObservationQueryOptions): Promise<Observation[]> {
    if (ids.length === 0) return [];

    const pool = this.getPool();
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    
    let query = `SELECT * FROM observations WHERE id IN (${placeholders})`;
    const params: any[] = [...ids];
    let paramIndex = ids.length + 1;

    if (options?.project) {
      query += ` AND project = $${paramIndex++}`;
      params.push(options.project);
    }

    if (options?.type) {
      const types = Array.isArray(options.type) ? options.type : [options.type];
      const typePlaceholders = types.map(() => `$${paramIndex++}`).join(',');
      query += ` AND type IN (${typePlaceholders})`;
      params.push(...types);
    }

    const orderBy = options?.orderBy === 'date_asc' ? 'ASC' : 'DESC';
    query += ` ORDER BY created_at_epoch ${orderBy}`;

    if (options?.limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    const result = await pool.query(query, params);
    return result.rows.map((row: any) => this.mapObservationRow(row));
  }

  async getObservationsForSession(memorySessionId: string): Promise<Observation[]> {
    const pool = this.getPool();
    const result = await pool.query(
      'SELECT * FROM observations WHERE memory_session_id = $1 ORDER BY created_at_epoch ASC',
      [memorySessionId]
    );

    return result.rows.map((row: any) => this.mapObservationRow(row));
  }

  async getRecentObservations(project: string, limit: number = 20): Promise<Observation[]> {
    const pool = this.getPool();
    const result = await pool.query(
      'SELECT * FROM observations WHERE project = $1 ORDER BY created_at_epoch DESC LIMIT $2',
      [project, limit]
    );

    return result.rows.map((row: any) => this.mapObservationRow(row));
  }

  async getAllRecentObservations(limit: number = 100): Promise<Observation[]> {
    const pool = this.getPool();
    const result = await pool.query(
      'SELECT * FROM observations ORDER BY created_at_epoch DESC LIMIT $1',
      [limit]
    );

    return result.rows.map((row: any) => this.mapObservationRow(row));
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
    const pool = this.getPool();
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();

    const result = await pool.query(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned, completed,
        next_steps, notes, prompt_number, discovery_tokens, created_at_epoch
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id
    `, [
      memorySessionId,
      project,
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      summary.notes,
      promptNumber,
      discoveryTokens,
      timestampEpoch,
    ]);

    return { id: result.rows[0].id, createdAtEpoch: timestampEpoch };
  }

  async getSummaryForSession(memorySessionId: string): Promise<Summary | null> {
    const pool = this.getPool();
    const result = await pool.query(
      'SELECT * FROM session_summaries WHERE memory_session_id = $1 ORDER BY created_at_epoch DESC LIMIT 1',
      [memorySessionId]
    );

    if (result.rows.length === 0) return null;
    return this.mapSummaryRow(result.rows[0]);
  }

  async getRecentSummaries(project: string, limit: number = 10): Promise<Summary[]> {
    const pool = this.getPool();
    const result = await pool.query(
      'SELECT * FROM session_summaries WHERE project = $1 ORDER BY created_at_epoch DESC LIMIT $2',
      [project, limit]
    );

    return result.rows.map((row: any) => this.mapSummaryRow(row));
  }

  async getAllRecentSummaries(limit: number = 50): Promise<Summary[]> {
    const pool = this.getPool();
    const result = await pool.query(
      'SELECT * FROM session_summaries ORDER BY created_at_epoch DESC LIMIT $1',
      [limit]
    );

    return result.rows.map((row: any) => this.mapSummaryRow(row));
  }

  // ============================================================================
  // User Prompts
  // ============================================================================

  async saveUserPrompt(contentSessionId: string, promptNumber: number, promptText: string): Promise<number> {
    const pool = this.getPool();
    const nowEpoch = Date.now();

    const result = await pool.query(`
      INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at_epoch)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [contentSessionId, promptNumber, promptText, nowEpoch]);

    return result.rows[0].id;
  }

  async getUserPrompt(contentSessionId: string, promptNumber: number): Promise<string | null> {
    const pool = this.getPool();
    const result = await pool.query(
      'SELECT prompt_text FROM user_prompts WHERE content_session_id = $1 AND prompt_number = $2 LIMIT 1',
      [contentSessionId, promptNumber]
    );

    if (result.rows.length === 0) return null;
    return result.rows[0].prompt_text;
  }

  async getLatestUserPrompt(contentSessionId: string): Promise<UserPrompt | null> {
    const pool = this.getPool();
    const result = await pool.query(
      'SELECT * FROM user_prompts WHERE content_session_id = $1 ORDER BY created_at_epoch DESC LIMIT 1',
      [contentSessionId]
    );

    if (result.rows.length === 0) return null;
    return this.mapUserPromptRow(result.rows[0]);
  }

  async getPromptNumberFromUserPrompts(contentSessionId: string): Promise<number> {
    const pool = this.getPool();
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = $1',
      [contentSessionId]
    );

    return parseInt(result.rows[0].count, 10);
  }

  async getAllRecentUserPrompts(limit: number = 100): Promise<UserPrompt[]> {
    const pool = this.getPool();
    const result = await pool.query(
      'SELECT * FROM user_prompts ORDER BY created_at_epoch DESC LIMIT $1',
      [limit]
    );

    return result.rows.map((row: any) => this.mapUserPromptRow(row));
  }

  // ============================================================================
  // Pending Messages
  // ============================================================================

  async enqueuePendingMessage(
    message: Omit<PendingMessage, 'id' | 'status' | 'retryCount' | 'startedProcessingAtEpoch' | 'completedAtEpoch' | 'failedAtEpoch'>
  ): Promise<number> {
    const pool = this.getPool();

    const result = await pool.query(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type, tool_name, tool_input, tool_response,
        cwd, last_user_message, last_assistant_message, prompt_number, created_at_epoch
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id
    `, [
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
      message.createdAtEpoch,
    ]);

    return result.rows[0].id;
  }

  async getPendingMessages(sessionDbId: number): Promise<PendingMessage[]> {
    const pool = this.getPool();
    const result = await pool.query(
      "SELECT * FROM pending_messages WHERE session_db_id = $1 AND status = 'pending' ORDER BY created_at_epoch ASC",
      [sessionDbId]
    );

    return result.rows.map((row: any) => this.mapPendingMessageRow(row));
  }

  async claimPendingMessage(sessionDbId: number): Promise<PendingMessage | null> {
    const pool = this.getPool();
    const now = Date.now();

    // Atomic claim using UPDATE ... RETURNING
    const result = await pool.query(`
      UPDATE pending_messages
      SET status = 'processing', started_processing_at_epoch = $1
      WHERE id = (
        SELECT id FROM pending_messages
        WHERE session_db_id = $2 AND status = 'pending'
        ORDER BY created_at_epoch ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `, [now, sessionDbId]);

    if (result.rows.length === 0) return null;
    return this.mapPendingMessageRow(result.rows[0]);
  }

  async completePendingMessage(messageId: number): Promise<void> {
    const pool = this.getPool();
    await pool.query(
      "UPDATE pending_messages SET status = 'processed', completed_at_epoch = $1 WHERE id = $2",
      [Date.now(), messageId]
    );
  }

  async failPendingMessage(messageId: number): Promise<void> {
    const pool = this.getPool();
    await pool.query(
      "UPDATE pending_messages SET status = 'failed', failed_at_epoch = $1, retry_count = retry_count + 1 WHERE id = $2",
      [Date.now(), messageId]
    );
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
    const pool = this.getPool();
    const client = await pool.connect();
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();

    try {
      await client.query('BEGIN');

      const observationIds: number[] = [];
      for (const obs of observations) {
        const result = await client.query(`
          INSERT INTO observations (
            memory_session_id, project, type, title, subtitle, text, facts, narrative,
            concepts, files_read, files_modified, prompt_number, discovery_tokens, created_at_epoch
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          RETURNING id
        `, [
          memorySessionId,
          project,
          obs.type,
          obs.title,
          obs.subtitle,
          obs.text,
          JSON.stringify(obs.facts),
          obs.narrative,
          JSON.stringify(obs.concepts),
          JSON.stringify(obs.filesRead),
          JSON.stringify(obs.filesModified),
          promptNumber,
          discoveryTokens,
          timestampEpoch,
        ]);
        observationIds.push(result.rows[0].id);
      }

      let summaryId: number | null = null;
      if (summary) {
        const result = await client.query(`
          INSERT INTO session_summaries (
            memory_session_id, project, request, investigated, learned, completed,
            next_steps, notes, prompt_number, discovery_tokens, created_at_epoch
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING id
        `, [
          memorySessionId,
          project,
          summary.request,
          summary.investigated,
          summary.learned,
          summary.completed,
          summary.next_steps,
          summary.notes,
          promptNumber,
          discoveryTokens,
          timestampEpoch,
        ]);
        summaryId = result.rows[0].id;
      }

      await client.query('COMMIT');
      return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // Files
  // ============================================================================

  async getFilesForSession(memorySessionId: string): Promise<{ filesRead: string[]; filesModified: string[] }> {
    const observations = await this.getObservationsForSession(memorySessionId);

    const filesReadSet = new Set<string>();
    const filesModifiedSet = new Set<string>();

    for (const obs of observations) {
      obs.filesRead.forEach(f => filesReadSet.add(f));
      obs.filesModified.forEach(f => filesModifiedSet.add(f));
    }

    return {
      filesRead: Array.from(filesReadSet),
      filesModified: Array.from(filesModifiedSet),
    };
  }

  // ============================================================================
  // Row Mappers
  // ============================================================================

  private mapSessionRow(row: any): Session {
    return {
      id: row.id,
      contentSessionId: row.content_session_id,
      memorySessionId: row.memory_session_id,
      project: row.project,
      userPrompt: row.user_prompt,
      startedAt: row.started_at?.toISOString() || '',
      startedAtEpoch: parseInt(row.started_at_epoch, 10),
      completedAt: row.completed_at?.toISOString() || null,
      completedAtEpoch: row.completed_at_epoch ? parseInt(row.completed_at_epoch, 10) : null,
      status: row.status,
      workerPort: row.worker_port,
    };
  }

  private mapObservationRow(row: any): Observation {
    return {
      id: row.id,
      memorySessionId: row.memory_session_id,
      project: row.project,
      type: row.type,
      title: row.title,
      subtitle: row.subtitle,
      text: row.text,
      facts: row.facts || [],
      narrative: row.narrative,
      concepts: row.concepts || [],
      filesRead: row.files_read || [],
      filesModified: row.files_modified || [],
      promptNumber: row.prompt_number,
      discoveryTokens: row.discovery_tokens || 0,
      createdAt: row.created_at?.toISOString() || '',
      createdAtEpoch: parseInt(row.created_at_epoch, 10),
    };
  }

  private mapSummaryRow(row: any): Summary {
    return {
      id: row.id,
      memorySessionId: row.memory_session_id,
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
      discoveryTokens: row.discovery_tokens || 0,
      createdAt: row.created_at?.toISOString() || '',
      createdAtEpoch: parseInt(row.created_at_epoch, 10),
    };
  }

  private mapUserPromptRow(row: any): UserPrompt {
    return {
      id: row.id,
      contentSessionId: row.content_session_id,
      promptNumber: row.prompt_number,
      promptText: row.prompt_text,
      createdAt: row.created_at?.toISOString() || '',
      createdAtEpoch: parseInt(row.created_at_epoch, 10),
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
      createdAtEpoch: parseInt(row.created_at_epoch, 10),
      startedProcessingAtEpoch: row.started_processing_at_epoch ? parseInt(row.started_processing_at_epoch, 10) : null,
      completedAtEpoch: row.completed_at_epoch ? parseInt(row.completed_at_epoch, 10) : null,
      failedAtEpoch: row.failed_at_epoch ? parseInt(row.failed_at_epoch, 10) : null,
    };
  }
}
