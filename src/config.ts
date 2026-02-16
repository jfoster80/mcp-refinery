/**
 * Configuration — zero external dependencies.
 * Reads optional refinery.config.json, otherwise uses sensible defaults.
 * Data path resolves relative to where the process is launched.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RefineryConfig } from './types/index.js';

function resolveDataPath(): string {
  if (process.env.REFINERY_DATA_PATH) return resolve(process.env.REFINERY_DATA_PATH);
  return resolve(process.cwd(), 'data');
}

/**
 * Resolve the refinery's own source/project root.
 * Priority: REFINERY_SOURCE_PATH env > infer from module location.
 */
function resolveSourcePath(): string {
  if (process.env.REFINERY_SOURCE_PATH) return resolve(process.env.REFINERY_SOURCE_PATH);
  try {
    // In ESM dev mode, resolve from this file's location (src/config.ts -> project root)
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const candidate = resolve(thisDir, '..');
    if (existsSync(resolve(candidate, 'package.json'))) return candidate;
  } catch { /* bundled CJS — import.meta.url may not work */ }
  // Fallback: look for package.json relative to cwd
  if (existsSync(resolve(process.cwd(), 'package.json'))) return process.cwd();
  return '';
}

const DEFAULT_CONFIG: RefineryConfig = {
  defaults: {
    autonomy_level: 'pr_only',
    change_budget_per_window: 5,
    window_hours: 24,
    cooldown_hours: 72,
    min_confidence_margin: 0.25,
    min_consecutive_cycles: 2,
    max_loc_per_pr: 500,
  },
  storage: {
    base_path: resolveDataPath(),
    source_path: resolveSourcePath(),
  },
  routing: {
    multi_model_threshold: 'critical',
    default_architect: 'claude-opus',
    default_workhorse: 'claude-sonnet',
    default_fast: 'claude-haiku',
  },
};

let _config: RefineryConfig | null = null;

export function loadConfig(configPath?: string): RefineryConfig {
  if (_config) return _config;

  const candidates = [
    configPath,
    process.env.REFINERY_CONFIG,
    resolve(process.cwd(), 'refinery.config.json'),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf-8');
        const file = JSON.parse(raw);
        _config = {
          defaults: { ...DEFAULT_CONFIG.defaults, ...(file.defaults ?? {}) },
          storage: { ...DEFAULT_CONFIG.storage, ...(file.storage ?? {}) },
          routing: { ...DEFAULT_CONFIG.routing, ...(file.routing ?? {}) },
        };
        return _config;
      } catch { /* fall through */ }
    }
  }

  _config = { ...DEFAULT_CONFIG };
  return _config;
}

export function getConfig(): RefineryConfig {
  if (!_config) return loadConfig();
  return _config;
}
