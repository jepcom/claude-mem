/**
 * Storage module - Pluggable storage backends for claude-mem
 * 
 * Usage:
 *   import { createStorageAdapter, createStorageAdapterFromSettings } from './storage';
 *   
 *   // From explicit config
 *   const storage = createStorageAdapter({ adapter: 'sqlite' });
 *   
 *   // From ~/.claude-mem/settings.json
 *   const storage = createStorageAdapterFromSettings();
 *   
 *   await storage.initialize();
 */

export type { StorageAdapter, Session, Observation, Summary, UserPrompt, PendingMessage, QueryOptions, ObservationQueryOptions } from './StorageAdapter.js';
export { SQLiteStorageAdapter } from './SQLiteStorageAdapter.js';
export { FileStorageAdapter } from './FileStorageAdapter.js';
export { PostgresStorageAdapter } from './PostgresStorageAdapter.js';

import type { StorageAdapter } from './StorageAdapter.js';
import { SQLiteStorageAdapter } from './SQLiteStorageAdapter.js';
import { FileStorageAdapter } from './FileStorageAdapter.js';
import { PostgresStorageAdapter } from './PostgresStorageAdapter.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../shared/paths.js';

export interface StorageConfig {
  adapter: 'sqlite' | 'postgres' | 'mysql' | 'file' | string;
  options?: {
    // SQLite
    dbPath?: string;
    // Postgres/MySQL
    connectionString?: string;
    // File
    dataDir?: string;
  };
}

/**
 * Create a storage adapter based on explicit configuration
 */
export function createStorageAdapter(config: StorageConfig): StorageAdapter {
  switch (config.adapter) {
    case 'sqlite':
      return new SQLiteStorageAdapter(config.options?.dbPath);
    
    case 'file':
      return new FileStorageAdapter(config.options?.dataDir);
    
    case 'postgres':
    case 'postgresql':
      if (!config.options?.connectionString) {
        throw new Error(
          'PostgreSQL requires a connection string.\n' +
          'Set CLAUDE_MEM_STORAGE_CONNECTION_STRING in ~/.claude-mem/settings.json'
        );
      }
      return new PostgresStorageAdapter(config.options.connectionString);
    
    case 'mysql':
      // TODO: Community contribution welcome
      throw new Error(
        'MySQL storage adapter not yet implemented.\n' +
        'Implement StorageAdapter interface and submit a PR!\n' +
        'See: src/storage/StorageAdapter.ts'
      );
    
    default:
      throw new Error(
        `Unknown storage adapter: ${config.adapter}\n` +
        'Available adapters: sqlite, file\n' +
        'To add a new adapter, implement StorageAdapter interface.'
      );
  }
}

/**
 * Create a storage adapter from ~/.claude-mem/settings.json
 * 
 * Settings:
 *   CLAUDE_MEM_STORAGE_ADAPTER: 'sqlite' | 'file' | 'postgres' | ...
 *   CLAUDE_MEM_STORAGE_CONNECTION_STRING: database connection URL
 *   CLAUDE_MEM_STORAGE_DATA_DIR: directory for file-based storage
 */
export function createStorageAdapterFromSettings(): StorageAdapter {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  
  const adapter = settings.CLAUDE_MEM_STORAGE_ADAPTER || 'sqlite';
  const connectionString = settings.CLAUDE_MEM_STORAGE_CONNECTION_STRING || undefined;
  const dataDir = settings.CLAUDE_MEM_STORAGE_DATA_DIR || undefined;
  
  return createStorageAdapter({
    adapter,
    options: {
      connectionString,
      dataDir,
    },
  });
}

/**
 * Default storage adapter (SQLite, for backwards compatibility)
 */
export function createDefaultStorageAdapter(): StorageAdapter {
  return new SQLiteStorageAdapter();
}
