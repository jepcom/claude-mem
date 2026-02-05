#!/usr/bin/env node
/**
 * Docker entrypoint for claude-mem worker
 * Starts the worker service in foreground mode (no daemon spawn)
 */
const fs = require('fs');
const path = require('path');

// The built worker-service.cjs exports WorkerService class
const workerPath = './plugin/scripts/worker-service.cjs';

// Write Claude CLI auth from environment variable if provided
function ensureClaudeAuth() {
  const authJson = process.env.CLAUDE_AUTH_JSON;
  if (!authJson) {
    console.log('[DOCKER] No CLAUDE_AUTH_JSON provided, skipping Claude CLI auth setup');
    return;
  }
  
  const authDir = '/root/.config/claude-code';
  const authPath = path.join(authDir, 'auth.json');
  
  // Check if auth already exists (from volume)
  if (fs.existsSync(authPath)) {
    console.log('[DOCKER] Claude auth.json already exists, skipping');
    return;
  }
  
  console.log('[DOCKER] Writing Claude CLI auth from CLAUDE_AUTH_JSON env var');
  fs.mkdirSync(authDir, { recursive: true });
  
  try {
    // Validate it's valid JSON
    JSON.parse(authJson);
    fs.writeFileSync(authPath, authJson);
    console.log('[DOCKER] Claude CLI auth configured successfully');
  } catch (e) {
    console.error('[DOCKER] Invalid CLAUDE_AUTH_JSON:', e.message);
  }
}

// Ensure settings directory exists and has correct host binding
function ensureSettings() {
  // Use home dir as that's where SettingsDefaultsManager looks by default
  const homeDir = process.env.HOME || '/root';
  const dataDir = path.join(homeDir, '.claude-mem');
  const settingsPath = path.join(dataDir, 'settings.json');
  
  console.log('[DOCKER] Creating settings in:', dataDir, '→', settingsPath);
  fs.mkdirSync(dataDir, { recursive: true });
  
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    console.log('[DOCKER] Existing settings file found');
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      console.log('[DOCKER] Could not parse existing settings, using defaults');
    }
  }
  
  // Override with environment variables for Docker
  const envOverrides = {
    CLAUDE_MEM_WORKER_HOST: process.env.CLAUDE_MEM_WORKER_HOST || '0.0.0.0',
    CLAUDE_MEM_WORKER_PORT: process.env.CLAUDE_MEM_WORKER_PORT || '37777',
    CLAUDE_MEM_DATA_DIR: dataDir,
    CLAUDE_MEM_API_KEY: process.env.CLAUDE_MEM_API_KEY || '',
    CLAUDE_MEM_LOG_LEVEL: process.env.CLAUDE_MEM_LOG_LEVEL || 'INFO'
  };
  
  settings = { ...settings, ...envOverrides };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log('[DOCKER] Settings configured:', { host: settings.CLAUDE_MEM_WORKER_HOST, port: settings.CLAUDE_MEM_WORKER_PORT });
  
  // Verify file was written
  const verifyContent = fs.readFileSync(settingsPath, 'utf8');
  const verified = JSON.parse(verifyContent);
  console.log('[DOCKER] Verified settings in file:', { host: verified.CLAUDE_MEM_WORKER_HOST });
}

async function main() {
  console.log('[DOCKER] Starting claude-mem worker in foreground mode...');
  
  // Configure Claude CLI auth if provided
  ensureClaudeAuth();
  
  // Configure settings before starting worker
  ensureSettings();
  
  // Import the built module
  const workerModule = require(workerPath);
  
  // WorkerService is exported from the built module
  const { WorkerService } = workerModule;
  
  if (!WorkerService) {
    console.error('[DOCKER] WorkerService not found in module exports');
    console.error('[DOCKER] Available exports:', Object.keys(workerModule));
    process.exit(1);
  }
  
  const worker = new WorkerService();
  
  // Handle graceful shutdown
  const shutdown = async (signal) => {
    console.log(`[DOCKER] Received ${signal}, shutting down...`);
    try {
      if (worker.shutdown) {
        await worker.shutdown();
      }
    } catch (err) {
      console.error('[DOCKER] Shutdown error:', err);
    }
    process.exit(0);
  };
  
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  
  try {
    await worker.start();
    console.log('[DOCKER] Worker started successfully');
    
    // Keep the process running
    await new Promise(() => {});
  } catch (err) {
    console.error('[DOCKER] Failed to start worker:', err);
    process.exit(1);
  }
}

main();
