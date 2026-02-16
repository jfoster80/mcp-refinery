/**
 * Research ingestion — stores findings that the agent produces.
 *
 * Flow: research_start → agent analyzes → research_store → consensus.
 * No external API calls. The Cursor agent (Claude) IS the research engine.
 */

import { randomUUID } from 'node:crypto';
import type { ResearchFeedEntry, ResearchPerspective, Finding } from '../types/index.js';
import { buildResearchPrompt, hashPrompt, validateFindings, type ResearchQuery } from './providers/base.js';
import { insertResearchFeed, indexVector, recordAudit } from '../storage/index.js';

/**
 * Generate research prompts for each perspective. Returns them for the agent to process.
 */
export function startResearch(
  query: ResearchQuery,
  perspectives: ResearchPerspective[] = ['general'],
): { prompts: Array<{ perspective: ResearchPerspective; prompt: string; prompt_hash: string }> } {
  const prompts = perspectives.map((p) => {
    const prompt = buildResearchPrompt(query, p);
    return { perspective: p, prompt, prompt_hash: hashPrompt(prompt) };
  });

  recordAudit('research.start', 'system', 'server', query.target_server_id, {
    perspectives, server_name: query.server_name,
  });

  return { prompts };
}

/**
 * Store research findings that the agent produced from a prompt.
 */
export function storeFindings(
  targetServerId: string,
  perspective: ResearchPerspective,
  promptHash: string,
  findings: Finding[],
): ResearchFeedEntry {
  const now = new Date().toISOString();
  const confidence = computeConfidence(findings);

  const entry: ResearchFeedEntry = {
    feed_id: randomUUID(),
    perspective,
    requested_at: now,
    completed_at: now,
    prompt_hash: promptHash,
    findings,
    target_server_id: targetServerId,
    confidence,
  };

  insertResearchFeed(entry);

  for (const f of findings) {
    indexVector(
      `finding:${entry.feed_id}:${randomUUID().slice(0, 8)}`,
      'findings',
      `${f.claim} ${f.recommendation}`,
      undefined,
      { feed_id: entry.feed_id, perspective, risk_level: f.risk.level, target: targetServerId },
    );
  }

  recordAudit('research.store', 'agent', 'research_feed', entry.feed_id, {
    perspective, findings_count: findings.length, confidence,
  });

  return entry;
}

function computeConfidence(findings: Finding[]): number {
  if (findings.length === 0) return 0.1;
  let score = 0.3;
  const totalEvidence = findings.reduce((s, f) => s + f.evidence.length, 0);
  score += Math.min((totalEvidence / findings.length) * 0.1, 0.3);
  const highQuality = findings.reduce((s, f) => s + f.evidence.filter((e) => e.quality === 'A').length, 0);
  score += Math.min(highQuality * 0.05, 0.2);
  if (findings.some((f) => f.evidence.some((e) => e.type === 'spec_reference'))) score += 0.1;
  return Math.min(score, 1.0);
}
