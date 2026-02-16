/**
 * Triage and prioritization engine.
 *
 * Clusters recommendations, estimates impact, and proposes priority ordering
 * for improvement proposals. Integrates with the policy engine and
 * anti-oscillation checks to produce actionable, governance-aware backlogs.
 */

import { randomUUID } from 'node:crypto';
import type {
  ConsensusResult,
  ConsensusFinding,
  ImprovementProposal,
  TriageResult,
  TriagedProposal,
  ChangeCategory,
  RiskLevel,
  TargetServerConfig,
} from '../types/index.js';
import { getTargetServer, insertProposal, recordAudit } from '../storage/index.js';
import { evaluatePolicy } from './policy.js';
import { checkOscillation, isNoOpChange } from './anti-oscillation.js';
import { getConfig } from '../config.js';

/**
 * Triage consensus findings into prioritized improvement proposals.
 */
export function triageFindings(
  consensus: ConsensusResult,
): TriageResult {
  const server = getTargetServer(consensus.target_server_id);
  const config = getConfig();
  const proposals: ImprovementProposal[] = [];
  const triagedProposals: TriagedProposal[] = [];
  const escalations: string[] = [];

  for (const finding of consensus.findings) {
    if (finding.agreement_score < 0.33 && finding.combined_confidence < 0.5) {
      escalations.push(
        `Low-agreement finding needs human review: "${finding.claim}" ` +
        `(agreement: ${finding.agreement_score.toFixed(2)}, ` +
        `confidence: ${finding.combined_confidence.toFixed(2)})`,
      );
      continue;
    }

    const proposal = createProposalFromFinding(finding, consensus.target_server_id);
    proposals.push(proposal);

    const policyEval = evaluatePolicy(proposal);
    const oscillationCheck = checkOscillation(proposal, finding.combined_confidence);
    const noOp = isNoOpChange(proposal);

    const priorityScore = computePriorityScore(finding, server);
    const riskAdjustedImpact = computeRiskAdjustedImpact(finding);

    const triaged: TriagedProposal = {
      proposal_id: proposal.proposal_id,
      priority_score: priorityScore,
      risk_adjusted_impact: riskAdjustedImpact,
      blocked_by_oscillation: oscillationCheck.blocked,
      requires_human_approval: policyEval.requires_approval || !policyEval.allowed,
      reason: buildTriageReason(policyEval.allowed, oscillationCheck.blocked, noOp, finding),
    };

    if (noOp) {
      triaged.reason = 'Blocked: no measurable impact on scorecards';
      triaged.blocked_by_oscillation = true;
    }

    triagedProposals.push(triaged);

    proposal.priority = Math.round(priorityScore * 100);
    insertProposal(proposal);

    recordAudit(
      'proposal.triage',
      'triage_engine',
      'proposal',
      proposal.proposal_id,
      {
        priority_score: priorityScore,
        risk_adjusted_impact: riskAdjustedImpact,
        blocked: oscillationCheck.blocked,
        requires_approval: triaged.requires_human_approval,
      },
    );
  }

  triagedProposals.sort((a, b) => b.priority_score - a.priority_score);

  const totalLOC = proposals.reduce((sum, p) => sum + p.estimated_loc_change, 0);
  const budgetRemaining = (server?.change_budget_per_window ?? config.defaults.change_budget_per_window) -
    triagedProposals.filter((t) => !t.blocked_by_oscillation).length;

  return {
    proposals: triagedProposals,
    total_estimated_loc: totalLOC,
    budget_remaining: Math.max(0, budgetRemaining),
    escalations,
  };
}

function createProposalFromFinding(
  finding: ConsensusFinding,
  targetServerId: string,
): ImprovementProposal {
  const now = new Date().toISOString();

  return {
    proposal_id: randomUUID(),
    target_server_id: targetServerId,
    title: finding.claim.slice(0, 200),
    description: `${finding.claim}\n\nRecommendation: ${finding.recommendation}`,
    category: inferCategory(finding),
    status: 'triaged',
    priority: 0,
    risk_level: finding.risk_level,
    consensus_finding_ref: `${finding.claim.slice(0, 50)}`,
    acceptance_criteria: buildAcceptanceCriteria(finding),
    estimated_loc_change: estimateLOC(finding),
    created_at: now,
    updated_at: now,
    adr_refs: [],
    scorecard_baseline: null,
    scorecard_target: null,
  };
}

function inferCategory(finding: ConsensusFinding): ChangeCategory {
  const text = (finding.claim + ' ' + finding.recommendation).toLowerCase();

  if (text.includes('security') || text.includes('auth') || text.includes('vulnerability')) return 'security';
  if (text.includes('dependency') || text.includes('package') || text.includes('supply chain')) return 'dependency';
  if (text.includes('refactor') || text.includes('restructure') || text.includes('clean up')) return 'refactor';
  if (text.includes('documentation') || text.includes('readme') || text.includes('comment')) return 'docs';
  if (text.includes('prompt') || text.includes('template') || text.includes('instruction')) return 'prompt_only';

  return 'behavioral';
}

function buildAcceptanceCriteria(finding: ConsensusFinding): string[] {
  const criteria: string[] = [];

  criteria.push(`Implementation addresses: "${finding.claim}"`);

  if (finding.merged_impact.security > 0.3) {
    criteria.push('Security scan passes with no new vulnerabilities');
  }
  if (finding.merged_impact.reliability > 0.3) {
    criteria.push('All existing tests continue to pass');
    criteria.push('New tests added for the changed behavior');
  }
  if (finding.merged_impact.performance > 0.3) {
    criteria.push('Performance benchmarks show no regression');
  }

  criteria.push('Scorecard overall score does not decrease');

  return criteria;
}

function estimateLOC(finding: ConsensusFinding): number {
  const impactMagnitude =
    Math.abs(finding.merged_impact.reliability) +
    Math.abs(finding.merged_impact.security) +
    Math.abs(finding.merged_impact.devex) +
    Math.abs(finding.merged_impact.performance);

  if (finding.risk_level === 'critical') return Math.round(impactMagnitude * 200);
  if (finding.risk_level === 'high') return Math.round(impactMagnitude * 150);
  if (finding.risk_level === 'medium') return Math.round(impactMagnitude * 100);
  return Math.round(impactMagnitude * 50);
}

function computePriorityScore(
  finding: ConsensusFinding,
  server: TargetServerConfig | null,
): number {
  const weights = server?.scorecard_weights ?? {};

  const impactScore =
    (finding.merged_impact.security * (weights.security ?? 0.3)) +
    (finding.merged_impact.reliability * (weights.reliability ?? 0.25)) +
    (finding.merged_impact.devex * (weights.devex ?? 0.2)) +
    (finding.merged_impact.performance * (weights.performance ?? 0.15));

  const agreementBonus = finding.agreement_score * 0.2;
  const confidenceBonus = finding.combined_confidence * 0.15;

  const riskPenalty: Record<RiskLevel, number> = {
    low: 0,
    medium: -0.05,
    high: -0.1,
    critical: -0.15,
  };

  return Math.max(
    0,
    Math.min(1, impactScore + agreementBonus + confidenceBonus + riskPenalty[finding.risk_level]),
  );
}

function computeRiskAdjustedImpact(finding: ConsensusFinding): number {
  const rawImpact =
    Math.abs(finding.merged_impact.reliability) +
    Math.abs(finding.merged_impact.security) +
    Math.abs(finding.merged_impact.devex) +
    Math.abs(finding.merged_impact.performance);

  const riskMultiplier: Record<RiskLevel, number> = {
    low: 1.0,
    medium: 0.8,
    high: 0.6,
    critical: 0.4,
  };

  return rawImpact * riskMultiplier[finding.risk_level] * finding.combined_confidence;
}

function buildTriageReason(
  policyAllowed: boolean,
  oscillationBlocked: boolean,
  noOp: boolean,
  finding: ConsensusFinding,
): string {
  if (noOp) return 'No-op: change has no measurable scorecard impact';
  if (oscillationBlocked) return 'Blocked by anti-oscillation engine';
  if (!policyAllowed) return 'Blocked by policy violation';

  const perspectives = finding.supporting_perspectives.join(', ');
  return `Supported by ${finding.supporting_perspectives.length} perspective(s) (${perspectives}) with ${(finding.agreement_score * 100).toFixed(0)}% agreement`;
}
