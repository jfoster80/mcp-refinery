/**
 * Task Classifier — determines complexity, risk, and model requirements.
 *
 * Uses heuristics on task metadata to decide:
 * - Which model tier (architect / workhorse / fast) is appropriate
 * - Whether multi-model deliberation is warranted
 * - How many models should review the problem
 */

import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getBestForTier, getArchitectPair, getModelsByTier } from './models.js';
import type { TaskClassification, TaskComplexity, ModelTier, RiskLevel } from '../types/index.js';

export interface ClassifyInput {
  description: string;
  domain?: string;
  risk_level?: RiskLevel;
  estimated_loc?: number;
  touches_security?: boolean;
  touches_auth?: boolean;
  is_architectural?: boolean;
  has_conflicting_adrs?: boolean;
  user_requested_multi?: boolean;
  proposal_count?: number;
}

export function classifyTask(input: ClassifyInput): TaskClassification {
  const complexity = computeComplexity(input);
  const risk = input.risk_level ?? inferRisk(input);
  const domain = input.domain ?? inferDomain(input);
  const tier = pickTier(complexity, risk, domain);
  const needsMulti = shouldUseMultiModel(complexity, risk, input);
  const models = selectModels(tier, needsMulti);

  return {
    task_id: randomUUID(),
    description: input.description,
    complexity,
    domain,
    risk_level: risk,
    requires_multi_model: needsMulti,
    recommended_tier: tier,
    recommended_models: models,
    reasoning: buildReasoning(complexity, risk, tier, needsMulti, input),
  };
}

function computeComplexity(input: ClassifyInput): TaskComplexity {
  let score = 0;

  if (input.touches_security) score += 3;
  if (input.touches_auth) score += 3;
  if (input.is_architectural) score += 4;
  if (input.has_conflicting_adrs) score += 3;
  if (input.user_requested_multi) score += 2;

  const loc = input.estimated_loc ?? 0;
  if (loc > 500) score += 3;
  else if (loc > 200) score += 2;
  else if (loc > 50) score += 1;

  const proposals = input.proposal_count ?? 0;
  if (proposals > 5) score += 2;
  else if (proposals > 2) score += 1;

  const riskScore: Record<string, number> = { low: 0, medium: 1, high: 3, critical: 5 };
  score += riskScore[input.risk_level ?? 'low'] ?? 0;

  const desc = input.description.toLowerCase();
  if (desc.includes('breaking change')) score += 4;
  if (desc.includes('migration')) score += 3;
  if (desc.includes('security vulnerability')) score += 4;
  if (desc.includes('architecture')) score += 3;
  if (desc.includes('performance critical')) score += 2;

  if (score >= 12) return 'critical';
  if (score >= 8) return 'complex';
  if (score >= 4) return 'moderate';
  if (score >= 2) return 'simple';
  return 'trivial';
}

function inferRisk(input: ClassifyInput): RiskLevel {
  if (input.touches_security || input.touches_auth) return 'high';
  if (input.is_architectural) return 'high';
  if (input.has_conflicting_adrs) return 'medium';
  if ((input.estimated_loc ?? 0) > 300) return 'medium';
  return 'low';
}

function inferDomain(input: ClassifyInput): string {
  const desc = input.description.toLowerCase();
  if (desc.includes('security') || desc.includes('auth') || desc.includes('vulnerability')) return 'security';
  if (desc.includes('architecture') || desc.includes('design') || desc.includes('structure')) return 'architecture';
  if (desc.includes('performance') || desc.includes('latency') || desc.includes('throughput')) return 'performance';
  if (desc.includes('review') || desc.includes('audit') || desc.includes('assess')) return 'review';
  if (desc.includes('doc') || desc.includes('readme') || desc.includes('comment')) return 'documentation';
  return 'code';
}

function pickTier(complexity: TaskComplexity, risk: RiskLevel, _domain: string): ModelTier {
  if (complexity === 'critical' || risk === 'critical') return 'architect';
  if (complexity === 'complex' || risk === 'high') return 'architect';
  if (complexity === 'moderate' || risk === 'medium') return 'workhorse';
  if (complexity === 'trivial') return 'fast';
  return 'workhorse';
}

function shouldUseMultiModel(complexity: TaskComplexity, risk: RiskLevel, input: ClassifyInput): boolean {
  if (input.user_requested_multi) return true;

  const threshold = getConfig().routing.multi_model_threshold;
  if (threshold === 'critical') return complexity === 'critical' || risk === 'critical';
  return complexity === 'critical' || complexity === 'complex' || risk === 'critical' || risk === 'high';
}

function selectModels(tier: ModelTier, needsMulti: boolean): string[] {
  if (needsMulti) {
    const pair = getArchitectPair();
    if (pair) return [pair[0].model_id, pair[1].model_id];
    // Fallback: pick two architects, preferring available ones
    const architects = getModelsByTier('architect').sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      return b.quality - a.quality;
    });
    if (architects.length >= 2) return [architects[0].model_id, architects[1].model_id];
    return [getBestForTier('architect').model_id];
  }
  return [getBestForTier(tier).model_id];
}

function buildReasoning(
  complexity: TaskComplexity, risk: RiskLevel, tier: ModelTier,
  needsMulti: boolean, input: ClassifyInput,
): string {
  const parts: string[] = [];
  parts.push(`Task classified as ${complexity} complexity, ${risk} risk.`);
  parts.push(`Recommended tier: ${tier}.`);

  if (input.touches_security) parts.push('Security-sensitive: elevated to architect tier.');
  if (input.is_architectural) parts.push('Architectural change: requires deep reasoning.');
  if (input.has_conflicting_adrs) parts.push('Conflicting ADRs exist: careful deliberation needed.');
  if (needsMulti) parts.push('Multi-model deliberation engaged: iron sharpens iron.');
  if (input.user_requested_multi) parts.push('User explicitly requested multi-model review.');

  return parts.join(' ');
}
