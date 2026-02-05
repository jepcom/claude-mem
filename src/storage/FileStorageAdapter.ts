/**
 * FileStorageAdapter - File-based storage using JSON files
 * 
 * Stores data in a simple directory structure:
 *   dataDir/
 *     sessions/
 *       {contentSessionId}.json
 *     observations/
 *       {id}.json
 *     summaries/
 *       {id}.json
 *     prompts/
 *       {contentSessionId}/
 *         {promptNumber}.json
 *     pending/
 *       {id}.json
 *     index.json  (project list, counters)
 * 
 * Good for:
 * - Debugging (human-readable files)
 * - Testing (no dependencies)
 * - Git-tracked memory (version controlled)
 * - Simple deployments
 * 
 * Not good for:
 * - High concurrency
 * - Large datasets (no indexing)
 * - Complex queries
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type {
  StorageAdapter,
  Session,
  Observation,
  Summary,
  UserPrompt,
  PendingMessage,
  ObservationQueryOptions,
} from './StorageAdapter.js';

interface FileIndex {
  nextSessionId: number;
  nextObservationId: number;
  nextSummaryId: number;
  nextPromptId: number;
  nextPendingId: number;
  projects: string[];
}

export class FileStorageAdapter implements StorageAdapter {
  readonly name = 'file';
  private dataDir: string;
  private index: FileIndex | null = null;

  constructor(dataDir: string = '.claude-mem-data') {
    this.dataDir = dataDir;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    // Create directory structure
    const dirs = ['sessions', 'observations', 'summaries', 'prompts', 'pending'];
    for (const dir of dirs) {
      const path = join(this.dataDir, dir);
      if (!existsSync(path)) {
        mkdirSync(path, { recursive: true });
      }
    }
    
    // Load or create index
    const indexPath = join(this.dataDir, 'index.json');
    if (existsSync(indexPath)) {
      this.index = JSON.parse(readFileSync(indexPath, 'utf-8'));
    } else {
      this.index = {
        nextSessionId: 1,
        nextObservationId: 1,
        nextSummaryId: 1,
        nextPromptId: 1,
        nextPendingId: 1,
        projects: [],
      };
      this.saveIndex();
    }
  }

  async close(): Promise<void> {
    // Save index on close
    if (this.index) {
      this.saveIndex();
    }
  }

  private getIndex(): FileIndex {
    if (!this.index) {
      throw new Error('FileStorageAdapter not initialized. Call initialize() first.');
    }
    return this.index;
  }

  private saveIndex(): void {
    const indexPath = join(this.dataDir, 'index.json');
    writeFileSync(indexPath, JSON.stringify(this.index, null, 2));
  }

  // ============================================================================
  // Sessions
  // ============================================================================

  async createSession(contentSessionId: string, project: string, userPrompt: string): Promise<number> {
    const index = this.getIndex();
    const sessionsDir = join(this.dataDir, 'sessions');
    const sessionPath = join(sessionsDir, `${contentSessionId}.json`);
    
    // Check if session exists
    if (existsSync(sessionPath)) {
      const existing = JSON.parse(readFileSync(sessionPath, 'utf-8')) as Session;
      return existing.id;
    }
    
    const id = index.nextSessionId++;
    const now = new Date();
    
    const session: Session = {
      id,
      contentSessionId,
      memorySessionId: null,
      project,
      userPrompt,
      startedAt: now.toISOString(),
      startedAtEpoch: now.getTime(),
      completedAt: null,
      completedAtEpoch: null,
      status: 'active',
    };
    
    writeFileSync(sessionPath, JSON.stringify(session, null, 2));
    
    // Track project
    if (project && !index.projects.includes(project)) {
      index.projects.push(project);
    }
    
    this.saveIndex();
    return id;
  }

  async getSessionById(id: number): Promise<Session | null> {
    const sessionsDir = join(this.dataDir, 'sessions');
    const files = readdirSync(sessionsDir);
    
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const session = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8')) as Session;
      if (session.id === id) {
        return session;
      }
    }
    return null;
  }

  async getSessionByContentId(contentSessionId: string): Promise<Session | null> {
    const sessionPath = join(this.dataDir, 'sessions', `${contentSessionId}.json`);
    if (!existsSync(sessionPath)) return null;
    return JSON.parse(readFileSync(sessionPath, 'utf-8'));
  }

  async updateMemorySessionId(sessionDbId: number, memorySessionId: string): Promise<void> {
    const session = await this.getSessionById(sessionDbId);
    if (!session) return;
    
    session.memorySessionId = memorySessionId;
    const sessionPath = join(this.dataDir, 'sessions', `${session.contentSessionId}.json`);
    writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  }

  async getRecentSessions(project: string, limit: number = 10): Promise<Session[]> {
    const sessionsDir = join(this.dataDir, 'sessions');
    const files = readdirSync(sessionsDir);
    
    const sessions: Session[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const session = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8')) as Session;
      if (session.project === project) {
        sessions.push(session);
      }
    }
    
    return sessions
      .sort((a, b) => b.startedAtEpoch - a.startedAtEpoch)
      .slice(0, limit);
  }

  async getAllProjects(): Promise<string[]> {
    return [...this.getIndex().projects];
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
    const index = this.getIndex();
    const id = index.nextObservationId++;
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    
    const obs: Observation = {
      id,
      memorySessionId,
      project,
      ...observation,
      promptNumber: promptNumber ?? null,
      discoveryTokens,
      createdAt: new Date(timestampEpoch).toISOString(),
      createdAtEpoch: timestampEpoch,
    };
    
    const obsPath = join(this.dataDir, 'observations', `${id}.json`);
    writeFileSync(obsPath, JSON.stringify(obs, null, 2));
    this.saveIndex();
    
    return { id, createdAtEpoch: timestampEpoch };
  }

  async getObservationById(id: number): Promise<Observation | null> {
    const obsPath = join(this.dataDir, 'observations', `${id}.json`);
    if (!existsSync(obsPath)) return null;
    return JSON.parse(readFileSync(obsPath, 'utf-8'));
  }

  async getObservationsByIds(ids: number[], options?: ObservationQueryOptions): Promise<Observation[]> {
    const observations: Observation[] = [];
    
    for (const id of ids) {
      const obs = await this.getObservationById(id);
      if (obs) {
        // Apply filters
        if (options?.project && obs.project !== options.project) continue;
        if (options?.type) {
          const types = Array.isArray(options.type) ? options.type : [options.type];
          if (!types.includes(obs.type)) continue;
        }
        observations.push(obs);
      }
    }
    
    // Sort
    const orderBy = options?.orderBy || 'date_desc';
    observations.sort((a, b) => 
      orderBy === 'date_asc' 
        ? a.createdAtEpoch - b.createdAtEpoch 
        : b.createdAtEpoch - a.createdAtEpoch
    );
    
    // Limit
    if (options?.limit) {
      return observations.slice(0, options.limit);
    }
    
    return observations;
  }

  async getObservationsForSession(memorySessionId: string): Promise<Observation[]> {
    const obsDir = join(this.dataDir, 'observations');
    const files = readdirSync(obsDir);
    
    const observations: Observation[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const obs = JSON.parse(readFileSync(join(obsDir, file), 'utf-8')) as Observation;
      if (obs.memorySessionId === memorySessionId) {
        observations.push(obs);
      }
    }
    
    return observations.sort((a, b) => a.createdAtEpoch - b.createdAtEpoch);
  }

  async getRecentObservations(project: string, limit: number = 20): Promise<Observation[]> {
    const obsDir = join(this.dataDir, 'observations');
    const files = readdirSync(obsDir);
    
    const observations: Observation[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const obs = JSON.parse(readFileSync(join(obsDir, file), 'utf-8')) as Observation;
      if (obs.project === project) {
        observations.push(obs);
      }
    }
    
    return observations
      .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch)
      .slice(0, limit);
  }

  async getAllRecentObservations(limit: number = 100): Promise<Observation[]> {
    const obsDir = join(this.dataDir, 'observations');
    const files = readdirSync(obsDir);
    
    const observations: Observation[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      observations.push(JSON.parse(readFileSync(join(obsDir, file), 'utf-8')));
    }
    
    return observations
      .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch)
      .slice(0, limit);
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
    const index = this.getIndex();
    const id = index.nextSummaryId++;
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    
    const sum: Summary = {
      id,
      memorySessionId,
      project,
      request: summary.request,
      investigated: summary.investigated,
      learned: summary.learned,
      completed: summary.completed,
      nextSteps: summary.next_steps,
      filesRead: null,
      filesEdited: null,
      notes: summary.notes,
      promptNumber: promptNumber ?? null,
      discoveryTokens,
      createdAt: new Date(timestampEpoch).toISOString(),
      createdAtEpoch: timestampEpoch,
    };
    
    const sumPath = join(this.dataDir, 'summaries', `${id}.json`);
    writeFileSync(sumPath, JSON.stringify(sum, null, 2));
    this.saveIndex();
    
    return { id, createdAtEpoch: timestampEpoch };
  }

  async getSummaryForSession(memorySessionId: string): Promise<Summary | null> {
    const sumDir = join(this.dataDir, 'summaries');
    const files = readdirSync(sumDir);
    
    let latest: Summary | null = null;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const sum = JSON.parse(readFileSync(join(sumDir, file), 'utf-8')) as Summary;
      if (sum.memorySessionId === memorySessionId) {
        if (!latest || sum.createdAtEpoch > latest.createdAtEpoch) {
          latest = sum;
        }
      }
    }
    return latest;
  }

  async getRecentSummaries(project: string, limit: number = 10): Promise<Summary[]> {
    const sumDir = join(this.dataDir, 'summaries');
    const files = readdirSync(sumDir);
    
    const summaries: Summary[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const sum = JSON.parse(readFileSync(join(sumDir, file), 'utf-8')) as Summary;
      if (sum.project === project) {
        summaries.push(sum);
      }
    }
    
    return summaries
      .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch)
      .slice(0, limit);
  }

  async getAllRecentSummaries(limit: number = 50): Promise<Summary[]> {
    const sumDir = join(this.dataDir, 'summaries');
    const files = readdirSync(sumDir);
    
    const summaries: Summary[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      summaries.push(JSON.parse(readFileSync(join(sumDir, file), 'utf-8')));
    }
    
    return summaries
      .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch)
      .slice(0, limit);
  }

  // ============================================================================
  // User Prompts
  // ============================================================================

  async saveUserPrompt(contentSessionId: string, promptNumber: number, promptText: string): Promise<number> {
    const index = this.getIndex();
    const id = index.nextPromptId++;
    const now = new Date();
    
    const promptDir = join(this.dataDir, 'prompts', contentSessionId);
    if (!existsSync(promptDir)) {
      mkdirSync(promptDir, { recursive: true });
    }
    
    const prompt: UserPrompt = {
      id,
      contentSessionId,
      promptNumber,
      promptText,
      createdAt: now.toISOString(),
      createdAtEpoch: now.getTime(),
    };
    
    const promptPath = join(promptDir, `${promptNumber}.json`);
    writeFileSync(promptPath, JSON.stringify(prompt, null, 2));
    this.saveIndex();
    
    return id;
  }

  async getUserPrompt(contentSessionId: string, promptNumber: number): Promise<string | null> {
    const promptPath = join(this.dataDir, 'prompts', contentSessionId, `${promptNumber}.json`);
    if (!existsSync(promptPath)) return null;
    const prompt = JSON.parse(readFileSync(promptPath, 'utf-8')) as UserPrompt;
    return prompt.promptText;
  }

  async getLatestUserPrompt(contentSessionId: string): Promise<UserPrompt | null> {
    const promptDir = join(this.dataDir, 'prompts', contentSessionId);
    if (!existsSync(promptDir)) return null;
    
    const files = readdirSync(promptDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return null;
    
    // Find highest prompt number
    let latest: UserPrompt | null = null;
    for (const file of files) {
      const prompt = JSON.parse(readFileSync(join(promptDir, file), 'utf-8')) as UserPrompt;
      if (!latest || prompt.promptNumber > latest.promptNumber) {
        latest = prompt;
      }
    }
    return latest;
  }

  async getPromptNumberFromUserPrompts(contentSessionId: string): Promise<number> {
    const promptDir = join(this.dataDir, 'prompts', contentSessionId);
    if (!existsSync(promptDir)) return 0;
    const files = readdirSync(promptDir).filter(f => f.endsWith('.json'));
    return files.length;
  }

  async getAllRecentUserPrompts(limit: number = 100): Promise<UserPrompt[]> {
    const promptsDir = join(this.dataDir, 'prompts');
    if (!existsSync(promptsDir)) return [];
    
    const prompts: UserPrompt[] = [];
    const sessionDirs = readdirSync(promptsDir);
    
    for (const sessionDir of sessionDirs) {
      const sessionPath = join(promptsDir, sessionDir);
      const files = readdirSync(sessionPath).filter(f => f.endsWith('.json'));
      for (const file of files) {
        prompts.push(JSON.parse(readFileSync(join(sessionPath, file), 'utf-8')));
      }
    }
    
    return prompts
      .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch)
      .slice(0, limit);
  }

  // ============================================================================
  // Pending Messages
  // ============================================================================

  async enqueuePendingMessage(
    message: Omit<PendingMessage, 'id' | 'status' | 'retryCount' | 'startedProcessingAtEpoch' | 'completedAtEpoch' | 'failedAtEpoch'>
  ): Promise<number> {
    const index = this.getIndex();
    const id = index.nextPendingId++;
    
    const pending: PendingMessage = {
      id,
      ...message,
      status: 'pending',
      retryCount: 0,
      startedProcessingAtEpoch: null,
      completedAtEpoch: null,
      failedAtEpoch: null,
    };
    
    const pendingPath = join(this.dataDir, 'pending', `${id}.json`);
    writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
    this.saveIndex();
    
    return id;
  }

  async getPendingMessages(sessionDbId: number): Promise<PendingMessage[]> {
    const pendingDir = join(this.dataDir, 'pending');
    const files = readdirSync(pendingDir).filter(f => f.endsWith('.json'));
    
    const messages: PendingMessage[] = [];
    for (const file of files) {
      const msg = JSON.parse(readFileSync(join(pendingDir, file), 'utf-8')) as PendingMessage;
      if (msg.sessionDbId === sessionDbId && msg.status === 'pending') {
        messages.push(msg);
      }
    }
    
    return messages.sort((a, b) => a.createdAtEpoch - b.createdAtEpoch);
  }

  async claimPendingMessage(sessionDbId: number): Promise<PendingMessage | null> {
    const messages = await this.getPendingMessages(sessionDbId);
    if (messages.length === 0) return null;
    
    const msg = messages[0];
    msg.status = 'processing';
    msg.startedProcessingAtEpoch = Date.now();
    
    const pendingPath = join(this.dataDir, 'pending', `${msg.id}.json`);
    writeFileSync(pendingPath, JSON.stringify(msg, null, 2));
    
    return msg;
  }

  async completePendingMessage(messageId: number): Promise<void> {
    const pendingPath = join(this.dataDir, 'pending', `${messageId}.json`);
    if (existsSync(pendingPath)) {
      // Delete completed messages
      unlinkSync(pendingPath);
    }
  }

  async failPendingMessage(messageId: number): Promise<void> {
    const pendingPath = join(this.dataDir, 'pending', `${messageId}.json`);
    if (!existsSync(pendingPath)) return;
    
    const msg = JSON.parse(readFileSync(pendingPath, 'utf-8')) as PendingMessage;
    msg.status = 'failed';
    msg.failedAtEpoch = Date.now();
    msg.retryCount++;
    
    writeFileSync(pendingPath, JSON.stringify(msg, null, 2));
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
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const observationIds: number[] = [];
    
    for (const obs of observations) {
      const result = await this.storeObservation(
        memorySessionId,
        project,
        obs,
        promptNumber,
        discoveryTokens,
        timestampEpoch
      );
      observationIds.push(result.id);
    }
    
    let summaryId: number | null = null;
    if (summary) {
      const result = await this.storeSummary(
        memorySessionId,
        project,
        summary,
        promptNumber,
        discoveryTokens,
        timestampEpoch
      );
      summaryId = result.id;
    }
    
    return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
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
}
