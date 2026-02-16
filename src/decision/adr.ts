/**
 * Architecture Decision Record (ADR) management.
 *
 * ADRs are binding tie-breakers: once accepted, agents must respect them
 * unless the anti-oscillation engine allows a flip.
 */

import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { insertADR, getADR, listActiveADRs, supersedeADR, recordAudit, indexVector, findSimilarDecisions } from '../storage/index.js';
import type { ArchitectureDecisionRecord, ImprovementProposal } from '../types/index.js';

export interface CreateADRInput {
  title: string;
  context: string;
  decision: string;
  rationale: string;
  consequences: string[];
  alternatives_considered: string[];
  confidence: number;
  related_proposals: string[];
  cooldown_hours?: number;
  min_confidence_margin?: number;
  min_consecutive_cycles?: number;
}

export function createADR(input: CreateADRInput): ArchitectureDecisionRecord {
  const config = getConfig();
  const now = new Date();
  const cooldownHours = input.cooldown_hours ?? config.defaults.cooldown_hours;

  const adr: ArchitectureDecisionRecord = {
    adr_id: randomUUID(),
    title: input.title,
    status: 'accepted',
    context: input.context,
    decision: input.decision,
    rationale: input.rationale,
    consequences: input.consequences,
    alternatives_considered: input.alternatives_considered,
    confidence: input.confidence,
    cooldown_until: new Date(now.getTime() + cooldownHours * 3600000).toISOString(),
    min_confidence_margin: input.min_confidence_margin ?? config.defaults.min_confidence_margin,
    min_consecutive_cycles: input.min_consecutive_cycles ?? config.defaults.min_consecutive_cycles,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    superseded_by: null,
    related_proposals: input.related_proposals,
  };

  insertADR(adr);
  indexVector(`adr:${adr.adr_id}`, 'decisions', `${adr.title} ${adr.decision} ${adr.rationale}`, undefined, { adr_id: adr.adr_id, confidence: adr.confidence });
  recordAudit('adr.record', 'decision_plane', 'adr', adr.adr_id, { title: adr.title, confidence: adr.confidence, cooldown_hours: cooldownHours });
  return adr;
}

export function replaceADR(oldId: string, newInput: CreateADRInput): { old: ArchitectureDecisionRecord; new: ArchitectureDecisionRecord } | null {
  const oldAdr = getADR(oldId);
  if (!oldAdr) return null;
  const newAdr = createADR({ ...newInput, related_proposals: [...newInput.related_proposals, ...oldAdr.related_proposals] });
  supersedeADR(oldId, newAdr.adr_id);
  recordAudit('adr.supersede', 'decision_plane', 'adr', oldId, { superseded_by: newAdr.adr_id });
  return { old: oldAdr, new: newAdr };
}

export function getActiveADRs(): ArchitectureDecisionRecord[] { return listActiveADRs(); }

export function findRelatedADRs(proposal: ImprovementProposal): ArchitectureDecisionRecord[] {
  const similar = findSimilarDecisions(`${proposal.title} ${proposal.description}`, 5);
  const adrs: ArchitectureDecisionRecord[] = [];
  const seen = new Set<string>();
  for (const s of similar) {
    const id = s.entry.metadata?.adr_id as string | undefined;
    if (id && s.similarity > 0.5 && !seen.has(id)) {
      seen.add(id);
      const adr = getADR(id);
      if (adr && adr.status === 'accepted') adrs.push(adr);
    }
  }
  return adrs;
}

export function formatADRMarkdown(adr: ArchitectureDecisionRecord): string {
  return `# ADR: ${adr.title}\n\n**Status**: ${adr.status} | **Confidence**: ${(adr.confidence * 100).toFixed(0)}% | **Cooldown Until**: ${adr.cooldown_until}\n\n## Context\n${adr.context}\n\n## Decision\n${adr.decision}\n\n## Rationale\n${adr.rationale}\n\n## Consequences\n${adr.consequences.map((c) => `- ${c}`).join('\n')}\n\n## Alternatives\n${adr.alternatives_considered.map((a) => `- ${a}`).join('\n')}${adr.superseded_by ? `\n\n**Superseded by**: ${adr.superseded_by}` : ''}`;
}
