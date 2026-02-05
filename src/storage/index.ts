/**
 * Storage module - Pluggable storage backends for claude-mem
 * 
 * Usage:
 *   import { createStorageAdapter, StorageAdapter } from './storage';
 *   
 *   const storage = createStorageAdapter({ adapter: 'sqlite' });
 *   await storage.initialize();
 */

export type { StorageAdapter, Session, Observation, Summary, UserPrompt, PendingMessage, QueryOptions, ObservationQueryOptions } from './StorageAdapter.js';
export { SQLiteStorageAdapter } from './SQLiteStorageAdapter.js';
export { FileStorageAdapter } from './FileStorageAdapter.js';

import type { StorageAdapter } from './StorageAdapter.js';
import { SQLiteStorageAdapter } from './SQLiteStorageAdapter.js';
import { FileStorageAdapter } from './FileStorageAdapter.js';

export interface StorageConfig {
  adapter: 'sqlite' | 'postgres' | 'file';
  options?: {
    // SQLite
    dbPath?: string;
    // Postgres
    connectionString?: string;
    // File
    dataDir?: string;
  };
}

/**
 * Create a storage adapter based on configuration
 */
export function createStorageAdapter(config: StorageConfig): StorageAdapter {
  switch (config.adapter) {
    case 'sqlite':
      return new SQLiteStorageAdapter(config.options?.dbPath);
    
    case 'postgres':
      // TODO: Implement PostgresStorageAdapter
      throw new Error('PostgreSQL storage adapter not yet implemented');
    
    case 'file':
      return new FileStorageAdapter(config.options?.dataDir);
    
    default:
      throw new Error(`Unknown storage adapter: ${config.adapter}`);
  }
}

/**
 * Default storage adapter (SQLite)
 */
export function createDefaultStorageAdapter(): StorageAdapter {
  return new SQLiteStorageAdapter();
}
