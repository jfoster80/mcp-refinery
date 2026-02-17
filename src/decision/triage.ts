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
  Evidence,
  ResearchPerspective,
} from '../types/index.js';
import { getTargetServer, insertProposal, recordAudit } from '../storage/index.js';
import { evaluatePolicy } from './policy.js';
import { checkOscillation, isNoOpChange } from './anti-oscillation.js';
import { getConfig } from '../config.js';

/**
 * Triage consensus findings into prioritized improvement proposals.
 *
 * Clusters related findings by category and keyword similarity before
 * creating proposals, so 41 findings become ~6–10 coherent work streams
 * instead of 41 separate proposals.
 */
export function triageFindings(
  consensus: ConsensusResult,
): TriageResult {
  const server = getTargetServer(consensus.target_server_id);
  const config = getConfig();
  const proposals: ImprovementProposal[] = [];
  const triagedProposals: TriagedProposal[] = [];
  const escalations: string[] = [];

  // Cluster related findings into coherent groups before creating proposals
  const clustered = clusterForTriage(consensus.findings);
  escalations.push(...clustered.escalations);

  for (const group of clustered.groups) {
    const representative = group.representative;
    const proposal = group.members.length === 1
      ? createProposalFromFinding(representative, consensus.target_server_id)
      : createProposalFromGroup(group, consensus.target_server_id);
    proposals.push(proposal);

    const policyEval = evaluatePolicy(proposal);
    const oscillationCheck = checkOscillation(proposal, representative.combined_confidence);
    const noOp = isNoOpChange(proposal);

    const priorityScore = computePriorityScore(representative, server);
    const riskAdjustedImpact = computeRiskAdjustedImpact(representative);

    const triaged: TriagedProposal = {
      proposal_id: proposal.proposal_id,
      priority_score: priorityScore,
      risk_adjusted_impact: riskAdjustedImpact,
      blocked_by_oscillation: oscillationCheck.blocked,
      requires_human_approval: policyEval.requires_approval || !policyEval.allowed,
      reason: buildTriageReason(policyEval.allowed, oscillationCheck.blocked, noOp, representative),
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
        cluster_size: group.members.length,
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

// ---------------------------------------------------------------------------
// Finding Clustering — groups related findings into coherent work streams
// ---------------------------------------------------------------------------

interface FindingGroup {
  representative: ConsensusFinding;
  members: ConsensusFinding[];
  category: ChangeCategory;
}

function clusterForTriage(
  findings: ConsensusFinding[],
): { groups: FindingGroup[]; escalations: string[] } {
  const escalations: string[] = [];
  const eligible: ConsensusFinding[] = [];

  for (const f of findings) {
    if (f.agreement_score < 0.33 && f.combined_confidence < 0.5) {
      escalations.push(
        `Low-agreement finding needs human review: "${f.claim}" ` +
        `(agreement: ${f.agreement_score.toFixed(2)}, confidence: ${f.combined_confidence.toFixed(2)})`,
      );
    } else {
      eligible.push(f);
    }
  }

  // Group by inferred category first
  const byCategory = new Map<ChangeCategory, ConsensusFinding[]>();
  for (const f of eligible) {
    const cat = inferCategory(f);
    const group = byCategory.get(cat) ?? [];
    group.push(f);
    byCategory.set(cat, group);
  }

  const groups: FindingGroup[] = [];
  for (const [cat, catFindings] of byCategory) {
    if (catFindings.length <= 2) {
      // Small groups: keep individual findings as separate proposals
      for (const f of catFindings) {
        groups.push({ representative: f, members: [f], category: cat });
      }
    } else {
      // Large groups: further cluster by keyword similarity, then merge
      const subClusters = clusterBySimilarity(catFindings, 0.15);
      for (const sub of subClusters) {
        const best = sub.reduce((a, b) =>
          b.combined_confidence * (1 + b.agreement_score) >
          a.combined_confidence * (1 + a.agreement_score) ? b : a,
        );
        groups.push({ representative: best, members: sub, category: cat });
      }
    }
  }

  return { groups, escalations };
}

function clusterBySimilarity(findings: ConsensusFinding[], threshold: number): ConsensusFinding[][] {
  const clusters: ConsensusFinding[][] = [];
  const used = new Set<number>();

  for (let i = 0; i < findings.length; i++) {
    if (used.has(i)) continue;
    const cluster = [findings[i]];
    used.add(i);

    for (let j = i + 1; j < findings.length; j++) {
      if (used.has(j)) continue;
      const sim = triageKeywordSim(
        findings[i].claim + ' ' + findings[i].recommendation,
        findings[j].claim + ' ' + findings[j].recommendation,
      );
      if (sim >= threshold) { cluster.push(findings[j]); used.add(j); }
    }

    clusters.push(cluster);
  }

  return clusters;
}

const TRIAGE_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'and', 'but', 'or', 'not', 'no', 'so', 'yet',
  'both', 'each', 'all', 'any', 'more', 'most', 'other', 'some', 'such',
  'only', 'own', 'same', 'than', 'too', 'very', 'that', 'this', 'these',
  'those', 'it', 'its', 'also', 'use', 'using', 'used', 'needs', 'need',
  'must', 'ensure', 'implement', 'add', 'create', 'update',
]);

function triageKeywordSim(a: string, b: string): number {
  const extract = (t: string): Set<string> => {
    const words = t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !TRIAGE_STOP_WORDS.has(w));
    return new Set(words);
  };
  const sa = extract(a), sb = extract(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function createProposalFromGroup(
  group: FindingGroup,
  targetServerId: string,
): ImprovementProposal {
  const { representative, members, category } = group;
  const now = new Date().toISOString();

  const descriptions = members.map((f) => `- ${f.claim}: ${f.recommendation}`);
  const combinedDesc = `${representative.claim}\n\nCombined recommendations (${members.length} related findings):\n${descriptions.join('\n')}`;

  const allCriteria = new Set<string>();
  for (const f of members) for (const c of buildAcceptanceCriteria(f)) allCriteria.add(c);

  const allPersp = new Set<ResearchPerspective>();
  for (const f of members) for (const p of f.supporting_perspectives) allPersp.add(p);

  const evidenceMap = new Map<string, Evidence>();
  for (const f of members) for (const e of f.merged_evidence) evidenceMap.set(`${e.type}:${e.value}`, e);

  const riskOrder: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  const maxRisk = riskOrder[Math.max(...members.map((f) => riskOrder.indexOf(f.risk_level)))];

  return {
    proposal_id: randomUUID(),
    target_server_id: targetServerId,
    title: `[${category}] ${representative.claim.slice(0, 150)} (+${members.length - 1} related)`,
    description: combinedDesc,
    category,
    status: 'triaged',
    priority: 0,
    risk_level: maxRisk,
    consensus_finding_ref: members.map((f) => f.claim.slice(0, 50)).join(' | '),
    acceptance_criteria: [...allCriteria],
    estimated_loc_change: members.reduce((sum, f) => sum + estimateLOC(f), 0),
    created_at: now,
    updated_at: now,
    adr_refs: [],
    scorecard_baseline: null,
    scorecard_target: null,
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
