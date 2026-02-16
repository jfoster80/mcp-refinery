/**
 * Generic typed JSON file store — zero dependencies.
 *
 * Each collection is a directory. Each record is a JSON file named by its ID.
 * Provides synchronous CRUD that mirrors a database interface.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export class JsonStore<T extends Record<string, unknown>> {
  private dir: string;
  private idField: string;

  constructor(baseDir: string, collection: string, idField: string) {
    this.dir = join(baseDir, collection);
    this.idField = idField;
    mkdirSync(this.dir, { recursive: true });
  }

  private filePath(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.dir, `${safe}.json`);
  }

  get(id: string): T | null {
    const p = this.filePath(id);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf-8')) as T; }
    catch { return null; }
  }

  list(filter?: (item: T) => boolean): T[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    const items: T[] = [];
    for (const f of files) {
      try {
        const item = JSON.parse(readFileSync(join(this.dir, f), 'utf-8')) as T;
        if (!filter || filter(item)) items.push(item);
      } catch { /* skip corrupt */ }
    }
    return items;
  }

  insert(item: T): void {
    const id = String(item[this.idField]);
    writeFileSync(this.filePath(id), JSON.stringify(item, null, 2));
  }

  upsert(item: T): void {
    this.insert(item);
  }

  update(id: string, updates: Partial<T>): void {
    const existing = this.get(id);
    if (!existing) return;
    const updated = { ...existing, ...updates } as T;
    writeFileSync(this.filePath(id), JSON.stringify(updated, null, 2));
  }

  remove(id: string): void {
    const p = this.filePath(id);
    if (existsSync(p)) unlinkSync(p);
  }

  count(filter?: (item: T) => boolean): number {
    return this.list(filter).length;
  }

  has(id: string): boolean {
    return existsSync(this.filePath(id));
  }
}
