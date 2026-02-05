/**
 * StorageAdapter - Interface for pluggable storage backends
 * 
 * Current implementations:
 * - SQLiteStorageAdapter (default, uses bun:sqlite)
 * 
 * Future implementations:
 * - PostgresStorageAdapter
 * - FileStorageAdapter
 * - SupabaseStorageAdapter
 */

// ============================================================================
// Core Types
// ============================================================================

export interface Session {
  id: number;
  contentSessionId: string;
  memorySessionId: string | null;
  project: string;
  userPrompt: string | null;
  startedAt: string;
  startedAtEpoch: number;
  completedAt: string | null;
  completedAtEpoch: number | null;
  status: 'active' | 'completed' | 'failed';
  workerPort?: number;
}

export interface Observation {
  id: number;
  memorySessionId: string;
  project: string;
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  title: string | null;
  subtitle: string | null;
  text: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
  promptNumber: number | null;
  discoveryTokens: number;
  createdAt: string;
  createdAtEpoch: number;
}

export interface Summary {
  id: number;
  memorySessionId: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  nextSteps: string | null;
  filesRead: string | null;
  filesEdited: string | null;
  notes: string | null;
  promptNumber: number | null;
  discoveryTokens: number;
  createdAt: string;
  createdAtEpoch: number;
}

export interface UserPrompt {
  id: number;
  contentSessionId: string;
  promptNumber: number;
  promptText: string;
  createdAt: string;
  createdAtEpoch: number;
}

export interface PendingMessage {
  id: number;
  sessionDbId: number;
  contentSessionId: string;
  messageType: 'observation' | 'summarize';
  toolName: string | null;
  toolInput: string | null;
  toolResponse: string | null;
  cwd: string | null;
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
  promptNumber: number | null;
  status: 'pending' | 'processing' | 'processed' | 'failed';
  retryCount: number;
  createdAtEpoch: number;
  startedProcessingAtEpoch: number | null;
  completedAtEpoch: number | null;
  failedAtEpoch: number | null;
}

// ============================================================================
// Query Options
// ============================================================================

export interface QueryOptions {
  limit?: number;
  offset?: number;
  orderBy?: 'date_asc' | 'date_desc';
}

export interface ObservationQueryOptions extends QueryOptions {
  project?: string;
  type?: string | string[];
  concepts?: string | string[];
  files?: string | string[];
}

// ============================================================================
// Storage Adapter Interface
// ============================================================================

export interface StorageAdapter {
  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;
  
  // Sessions
  createSession(contentSessionId: string, project: string, userPrompt: string): Promise<number>;
  getSessionById(id: number): Promise<Session | null>;
  getSessionByContentId(contentSessionId: string): Promise<Session | null>;
  updateMemorySessionId(sessionDbId: number, memorySessionId: string): Promise<void>;
  getRecentSessions(project: string, limit?: number): Promise<Session[]>;
  getAllProjects(): Promise<string[]>;
  
  // Observations
  storeObservation(
    memorySessionId: string,
    project: string,
    observation: Omit<Observation, 'id' | 'memorySessionId' | 'project' | 'createdAt' | 'createdAtEpoch'>,
    promptNumber?: number,
    discoveryTokens?: number,
    overrideTimestampEpoch?: number
  ): Promise<{ id: number; createdAtEpoch: number }>;
  
  getObservationById(id: number): Promise<Observation | null>;
  getObservationsByIds(ids: number[], options?: ObservationQueryOptions): Promise<Observation[]>;
  getObservationsForSession(memorySessionId: string): Promise<Observation[]>;
  getRecentObservations(project: string, limit?: number): Promise<Observation[]>;
  getAllRecentObservations(limit?: number): Promise<Observation[]>;
  
  // Summaries
  storeSummary(
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
    discoveryTokens?: number,
    overrideTimestampEpoch?: number
  ): Promise<{ id: number; createdAtEpoch: number }>;
  
  getSummaryForSession(memorySessionId: string): Promise<Summary | null>;
  getRecentSummaries(project: string, limit?: number): Promise<Summary[]>;
  getAllRecentSummaries(limit?: number): Promise<Summary[]>;
  
  // User Prompts
  saveUserPrompt(contentSessionId: string, promptNumber: number, promptText: string): Promise<number>;
  getUserPrompt(contentSessionId: string, promptNumber: number): Promise<string | null>;
  getLatestUserPrompt(contentSessionId: string): Promise<UserPrompt | null>;
  getPromptNumberFromUserPrompts(contentSessionId: string): Promise<number>;
  getAllRecentUserPrompts(limit?: number): Promise<UserPrompt[]>;
  
  // Pending Messages (queue)
  enqueuePendingMessage(message: Omit<PendingMessage, 'id' | 'status' | 'retryCount' | 'startedProcessingAtEpoch' | 'completedAtEpoch' | 'failedAtEpoch'>): Promise<number>;
  getPendingMessages(sessionDbId: number): Promise<PendingMessage[]>;
  claimPendingMessage(sessionDbId: number): Promise<PendingMessage | null>;
  completePendingMessage(messageId: number): Promise<void>;
  failPendingMessage(messageId: number): Promise<void>;
  
  // Batch operations
  storeObservations(
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
    discoveryTokens?: number,
    overrideTimestampEpoch?: number
  ): Promise<{ observationIds: number[]; summaryId: number | null; createdAtEpoch: number }>;
  
  // Files aggregation
  getFilesForSession(memorySessionId: string): Promise<{ filesRead: string[]; filesModified: string[] }>;
  
  // Adapter info
  readonly name: string;
}
