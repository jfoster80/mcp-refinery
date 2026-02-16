/**
 * Immutable artifact storage.
 *
 * Stores raw provider outputs, CI logs, compiled packages, SBOMs,
 * and provenance attestations as content-addressed files.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { getConfig } from '../config.js';

function artifactsDir(): string {
  const dir = join(getConfig().storage.base_path, 'artifacts');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface ArtifactMetadata {
  artifact_id: string;
  content_hash: string;
  content_type: string;
  category: 'raw_response' | 'ci_log' | 'package' | 'sbom' | 'provenance' | 'diff' | 'report';
  tags: Record<string, string>;
  size_bytes: number;
  created_at: string;
}

function computeHash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function metadataPath(artifactId: string): string {
  return join(artifactsDir(), `${artifactId}.meta.json`);
}

function contentPath(artifactId: string): string {
  return join(artifactsDir(), `${artifactId}.dat`);
}

export function storeArtifact(
  artifactId: string,
  content: Buffer | string,
  contentType: string,
  category: ArtifactMetadata['category'],
  tags: Record<string, string> = {},
): ArtifactMetadata {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  const hash = computeHash(buf);

  const meta: ArtifactMetadata = {
    artifact_id: artifactId,
    content_hash: hash,
    content_type: contentType,
    category,
    tags,
    size_bytes: buf.length,
    created_at: new Date().toISOString(),
  };

  const dir = artifactsDir();
  mkdirSync(dirname(join(dir, artifactId)), { recursive: true });
  writeFileSync(contentPath(artifactId), buf);
  writeFileSync(metadataPath(artifactId), JSON.stringify(meta, null, 2));

  return meta;
}

export function loadArtifact(artifactId: string): { meta: ArtifactMetadata; content: Buffer } | null {
  const mp = metadataPath(artifactId);
  const cp = contentPath(artifactId);
  if (!existsSync(mp) || !existsSync(cp)) return null;

  const meta = JSON.parse(readFileSync(mp, 'utf-8')) as ArtifactMetadata;
  const content = readFileSync(cp);

  const actualHash = computeHash(content);
  if (actualHash !== meta.content_hash) {
    throw new Error(`Artifact integrity check failed for ${artifactId}: expected ${meta.content_hash}, got ${actualHash}`);
  }

  return { meta, content };
}

export function loadArtifactText(artifactId: string): { meta: ArtifactMetadata; text: string } | null {
  const result = loadArtifact(artifactId);
  if (!result) return null;
  return { meta: result.meta, text: result.content.toString('utf-8') };
}

export function listArtifacts(category?: ArtifactMetadata['category']): ArtifactMetadata[] {
  const dir = artifactsDir();
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
  const metas: ArtifactMetadata[] = files.map((f) => {
    return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as ArtifactMetadata;
  });

  if (category) return metas.filter((m) => m.category === category);
  return metas;
}

export function verifyArtifactIntegrity(artifactId: string): boolean {
  try {
    loadArtifact(artifactId);
    return true;
  } catch {
    return false;
  }
}
