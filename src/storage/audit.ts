/**
 * Append-only audit log — JSONL file, zero external deps.
 * Hash-chained for tamper evidence.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import type { AuditEntry, AuditAction } from '../types/index.js';

function auditDir(): string {
  const dir = join(getConfig().storage.base_path, 'audit');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function auditFile(): string { return join(auditDir(), 'audit.jsonl'); }

function getLastHash(): string {
  const f = auditFile();
  if (!existsSync(f)) return '0'.repeat(64);
  const content = readFileSync(f, 'utf-8').trim();
  if (!content) return '0'.repeat(64);
  const lines = content.split('\n');
  try { return (JSON.parse(lines[lines.length - 1]) as { h: string }).h; }
  catch { return '0'.repeat(64); }
}

export function recordAudit(
  action: AuditAction, actor: string,
  targetType: string, targetId: string,
  details: Record<string, unknown> = {},
  correlationId?: string,
): AuditEntry {
  const entry: AuditEntry = {
    entry_id: randomUUID(),
    action, actor, target_type: targetType, target_id: targetId,
    details, timestamp: new Date().toISOString(),
    correlation_id: correlationId ?? randomUUID(),
  };
  const prev = getLastHash();
  const h = createHash('sha256').update(JSON.stringify(entry) + prev).digest('hex');
  appendFileSync(auditFile(), JSON.stringify({ ...entry, h }) + '\n');
  return entry;
}

export function queryAuditLog(filters: {
  action?: AuditAction; actor?: string; target_type?: string;
  target_id?: string; correlation_id?: string;
  since?: string; until?: string; limit?: number;
}): AuditEntry[] {
  const f = auditFile();
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean);
  let entries: AuditEntry[] = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  if (filters.action) entries = entries.filter((e) => e.action === filters.action);
  if (filters.actor) entries = entries.filter((e) => e.actor === filters.actor);
  if (filters.target_type) entries = entries.filter((e) => e.target_type === filters.target_type);
  if (filters.target_id) entries = entries.filter((e) => e.target_id === filters.target_id);
  if (filters.correlation_id) entries = entries.filter((e) => e.correlation_id === filters.correlation_id);
  if (filters.since) entries = entries.filter((e) => e.timestamp >= filters.since!);
  if (filters.until) entries = entries.filter((e) => e.timestamp <= filters.until!);

  entries.reverse();
  return entries.slice(0, filters.limit ?? 100);
}

export function getAuditStats(): { total_entries: number; actions_breakdown: Record<string, number>; recent_24h: number } {
  const f = auditFile();
  if (!existsSync(f)) return { total_entries: 0, actions_breakdown: {}, recent_24h: 0 };
  const lines = readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean);
  const entries: AuditEntry[] = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const since24h = new Date(Date.now() - 86400000).toISOString();
  const breakdown: Record<string, number> = {};
  let recent = 0;
  for (const e of entries) {
    breakdown[e.action] = (breakdown[e.action] ?? 0) + 1;
    if (e.timestamp >= since24h) recent++;
  }
  return { total_entries: entries.length, actions_breakdown: breakdown, recent_24h: recent };
}
