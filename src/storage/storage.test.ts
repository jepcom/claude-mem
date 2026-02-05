/**
 * Storage Adapter Tests
 * 
 * Run: bun test src/storage/storage.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createStorageAdapter, type StorageAdapter } from './index.js';
import { rmSync, existsSync } from 'fs';

const TEST_DATA_DIR = '.test-storage-data';

describe('StorageAdapter', () => {
  describe('FileStorageAdapter', () => {
    let storage: StorageAdapter;

    beforeEach(async () => {
      // Clean up test directory
      if (existsSync(TEST_DATA_DIR)) {
        rmSync(TEST_DATA_DIR, { recursive: true });
      }
      
      storage = createStorageAdapter({
        adapter: 'file',
        options: { dataDir: TEST_DATA_DIR },
      });
      await storage.initialize();
    });

    afterEach(async () => {
      await storage.close();
      if (existsSync(TEST_DATA_DIR)) {
        rmSync(TEST_DATA_DIR, { recursive: true });
      }
    });

    it('creates and retrieves sessions', async () => {
      const sessionId = await storage.createSession('test-content-123', 'test-project', 'Test prompt');
      expect(sessionId).toBe(1);

      const session = await storage.getSessionById(sessionId);
      expect(session).not.toBeNull();
      expect(session!.contentSessionId).toBe('test-content-123');
      expect(session!.project).toBe('test-project');
      expect(session!.userPrompt).toBe('Test prompt');
    });

    it('returns existing session on duplicate create', async () => {
      const id1 = await storage.createSession('test-content-123', 'project', 'prompt');
      const id2 = await storage.createSession('test-content-123', 'project', 'prompt');
      expect(id1).toBe(id2);
    });

    it('stores and retrieves observations', async () => {
      await storage.createSession('test-content', 'test-project', 'prompt');
      
      const result = await storage.storeObservation(
        'mem-session-123',
        'test-project',
        {
          type: 'discovery',
          title: 'Test Discovery',
          subtitle: 'Found something interesting',
          text: null,
          facts: ['fact1', 'fact2'],
          narrative: 'This is what happened...',
          concepts: ['testing', 'storage'],
          filesRead: ['file1.ts'],
          filesModified: ['file2.ts'],
        },
        1,
        100
      );

      expect(result.id).toBe(1);

      const obs = await storage.getObservationById(result.id);
      expect(obs).not.toBeNull();
      expect(obs!.title).toBe('Test Discovery');
      expect(obs!.facts).toEqual(['fact1', 'fact2']);
      expect(obs!.concepts).toEqual(['testing', 'storage']);
    });

    it('stores and retrieves summaries', async () => {
      const result = await storage.storeSummary(
        'mem-session-123',
        'test-project',
        {
          request: 'Add a new feature',
          investigated: 'Looked at the codebase',
          learned: 'The architecture is modular',
          completed: 'Added the feature',
          next_steps: 'Write tests',
          notes: null,
        }
      );

      expect(result.id).toBe(1);

      const sum = await storage.getSummaryForSession('mem-session-123');
      expect(sum).not.toBeNull();
      expect(sum!.request).toBe('Add a new feature');
      expect(sum!.completed).toBe('Added the feature');
    });

    it('tracks projects', async () => {
      await storage.createSession('s1', 'project-a', 'prompt');
      await storage.createSession('s2', 'project-b', 'prompt');
      await storage.createSession('s3', 'project-a', 'prompt'); // duplicate

      const projects = await storage.getAllProjects();
      expect(projects).toContain('project-a');
      expect(projects).toContain('project-b');
      expect(projects.length).toBe(2);
    });

    it('handles user prompts', async () => {
      const id = await storage.saveUserPrompt('content-123', 1, 'First prompt');
      expect(id).toBe(1);

      await storage.saveUserPrompt('content-123', 2, 'Second prompt');

      const prompt = await storage.getUserPrompt('content-123', 1);
      expect(prompt).toBe('First prompt');

      const count = await storage.getPromptNumberFromUserPrompts('content-123');
      expect(count).toBe(2);

      const latest = await storage.getLatestUserPrompt('content-123');
      expect(latest!.promptNumber).toBe(2);
      expect(latest!.promptText).toBe('Second prompt');
    });

    it('batch stores observations and summary', async () => {
      const result = await storage.storeObservations(
        'mem-session-123',
        'test-project',
        [
          {
            type: 'decision',
            title: 'Decision 1',
            subtitle: null,
            text: null,
            facts: [],
            narrative: null,
            concepts: [],
            filesRead: [],
            filesModified: [],
          },
          {
            type: 'bugfix',
            title: 'Bugfix 1',
            subtitle: null,
            text: null,
            facts: [],
            narrative: null,
            concepts: [],
            filesRead: [],
            filesModified: [],
          },
        ],
        {
          request: 'Fix bugs',
          investigated: 'Found issues',
          learned: 'Root cause',
          completed: 'Fixed',
          next_steps: 'Test',
          notes: null,
        }
      );

      expect(result.observationIds.length).toBe(2);
      expect(result.summaryId).not.toBeNull();
    });
  });
});
