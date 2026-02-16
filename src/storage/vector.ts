/**
 * Lightweight vector similarity index — JSON file backed, zero deps.
 * Uses bag-of-words embeddings and cosine similarity.
 */

import { JsonStore } from './json-store.js';
import { getConfig } from '../config.js';

interface VectorEntry { vector_id: string; namespace: string; content_text: string; embedding: number[]; metadata: Record<string, unknown>; created_at: string; [key: string]: unknown; }
interface VectorSearchResult { entry: VectorEntry; similarity: number; }

let _store: JsonStore<VectorEntry> | null = null;
function store(): JsonStore<VectorEntry> {
  if (!_store) _store = new JsonStore(getConfig().storage.base_path, 'vectors', 'vector_id');
  return _store;
}

export function generateSimpleEmbedding(text: string, dims = 256): number[] {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const emb = new Array(dims).fill(0);
  for (const w of words) { let h = 0; for (let i = 0; i < w.length; i++) h = ((h << 5) - h + w.charCodeAt(i)) | 0; emb[Math.abs(h) % dims] += 1; }
  const mag = Math.sqrt(emb.reduce((s: number, v: number) => s + v * v, 0));
  if (mag > 0) for (let i = 0; i < dims; i++) emb[i] /= mag;
  return emb;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, mA = 0, mB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; mA += a[i]*a[i]; mB += b[i]*b[i]; }
  const d = Math.sqrt(mA) * Math.sqrt(mB);
  return d > 0 ? dot / d : 0;
}

export function indexVector(id: string, ns: string, text: string, embedding?: number[], metadata: Record<string, unknown> = {}): void {
  store().insert({ vector_id: id, namespace: ns, content_text: text, embedding: embedding ?? generateSimpleEmbedding(text), metadata, created_at: new Date().toISOString() });
}

export function searchVectors(ns: string, queryText: string, topK = 5): VectorSearchResult[] {
  const qEmb = generateSimpleEmbedding(queryText);
  return store().list((v) => v.namespace === ns)
    .map((entry) => ({ entry, similarity: cosine(qEmb, entry.embedding) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

export function findSimilarDecisions(q: string, k = 5): VectorSearchResult[] { return searchVectors('decisions', q, k); }
export function findSimilarFixes(q: string, k = 5): VectorSearchResult[] { return searchVectors('fixes', q, k); }

export function getVectorStats(): { total: number; by_namespace: Record<string, number> } {
  const all = store().list();
  const ns: Record<string, number> = {};
  for (const v of all) ns[v.namespace] = (ns[v.namespace] ?? 0) + 1;
  return { total: all.length, by_namespace: ns };
}
