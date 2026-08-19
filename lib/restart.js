#!/usr/bin/env node
/**
 * DSH Restart Helper Script
 *
 * Spawned as a detached process by the dsh-web-remote plugin.
 * Reads a JSON config file, waits, kills the old DSH process, and starts a new one.
 *
 * Usage: node lib/restart.js <config-path>
 * Config JSON: { pid, command, args, cwd }
 */

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const configPath = process.argv[2];
if (!configPath) {
  console.error('[restart] No config path provided');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf-8'));
} catch (e) {
  console.error('[restart] Failed to read config:', e.message);
  process.exit(1);
}

const { pid, command, args, cwd } = config;
console.log(`[restart] Config loaded: pid=${pid}, command=${command}, args=${JSON.stringify(args)}, cwd=${cwd}`);

// Wait 8 seconds for the WeChat reply to be sent
console.log('[restart] Waiting 8 seconds for reply to send...');
setTimeout(() => {
  // Kill the old DSH process
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[restart] Sent SIGTERM to PID ${pid}`);
  } catch (e) {
    console.log(`[restart] Kill failed (process may already be gone): ${e.message}`);
  }

  // Wait 2 seconds for process to exit, then start new DSH
  setTimeout(() => {
    console.log('[restart] Starting new DSH instance...');
    try {
      const child = spawn(command, args, {
        cwd: cwd || process.cwd(),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      console.log(`[restart] New DSH started (PID: ${child.pid})`);
      console.log('[restart] Restart complete, exiting helper.');
    } catch (e) {
      console.error('[restart] Failed to start DSH:', e.message);
      console.error('[restart] Please start DSH manually.');
    }
    process.exit(0);
  }, 2000);
}, 8000);
