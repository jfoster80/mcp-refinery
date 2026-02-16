/**
 * Anti-oscillation engine (hysteretic decision enforcement).
 *
 * Prevents "ping-pong" updates by:
 * - Enforcing cooldown windows after ADR decisions
 * - Requiring monotonic improvement on primary scorecard metrics
 * - Using hysteresis thresholds for confidence before flipping decisions
 * - Requiring repeated confirmation across consecutive cycles
 * - Detecting and blocking no-op changes
 *
 * This is the core mechanism that makes recursive self-improvement stable.
 */

import { getConfig } from '../config.js';
import {
  getADR,
  listActiveADRs,
  getLatestScorecard,
  recordAudit,
  findSimilarDecisions,
} from '../storage/index.js';
import type {
  ImprovementProposal,
  OscillationCheck,
  ArchitectureDecisionRecord,
  ScorecardSnapshot,
} from '../types/index.js';

export interface FlipDecision {
  should_flip: boolean;
  reason: string;
  cooldown_remaining_ms: number;
  confidence_gap: number;
  consecutive_confirmations: number;
}

/**
 * Check if a proposal would cause oscillation relative to existing ADRs.
 *
 * Implements the hysteretic scorer from the architecture doc:
 * - Cooldown enforcement
 * - Confidence margin requirement
 * - Consecutive cycle confirmation
 * - Monotonic primary metric enforcement
 */
export function checkOscillation(
  proposal: ImprovementProposal,
  proposalConfidence: number,
): OscillationCheck {
  const config = getConfig();
  const now = new Date();

  const conflictingADR = findConflictingADR(proposal);

  if (!conflictingADR) {
    return {
      proposal_id: proposal.proposal_id,
      adr_id: null,
      would_flip: false,
      blocked: false,
      reason: 'No conflicting ADR found',
      cooldown_remaining_ms: 0,
      confidence_gap: 0,
      consecutive_confirmations: 0,
    };
  }

  const flipDecision = shouldFlip(conflictingADR, proposalConfidence, now);

  const baseline = getLatestScorecard(proposal.target_server_id);
  let primaryMetricsWorse = false;
  if (baseline && proposal.scorecard_target) {
    primaryMetricsWorse = wouldDegrade(baseline, proposal.scorecard_target);
  }

  const blocked = !flipDecision.should_flip || primaryMetricsWorse;
  const reason = buildBlockReason(flipDecision, primaryMetricsWorse, conflictingADR);

  if (blocked) {
    recordAudit(
      'oscillation.blocked',
      'anti_oscillation_engine',
      'proposal',
      proposal.proposal_id,
      {
        conflicting_adr: conflictingADR.adr_id,
        reason,
        confidence_gap: flipDecision.confidence_gap,
        cooldown_remaining_ms: flipDecision.cooldown_remaining_ms,
      },
    );
  }

  return {
    proposal_id: proposal.proposal_id,
    adr_id: conflictingADR.adr_id,
    would_flip: true,
    blocked,
    reason,
    cooldown_remaining_ms: flipDecision.cooldown_remaining_ms,
    confidence_gap: flipDecision.confidence_gap,
    consecutive_confirmations: flipDecision.consecutive_confirmations,
  };
}

/**
 * The hysteretic flip decision algorithm.
 *
 * A decision/ADR can only be reversed if:
 * 1. Cooldown window has elapsed
 * 2. New evidence confidence exceeds old decision confidence by margin
 * 3. The change has been confirmed across K consecutive cycles
 */
export function shouldFlip(
  decision: ArchitectureDecisionRecord,
  newConfidence: number,
  now: Date,
): FlipDecision {
  const cooldownUntil = new Date(decision.cooldown_until);
  const cooldownRemainingMs = Math.max(0, cooldownUntil.getTime() - now.getTime());

  if (cooldownRemainingMs > 0) {
    return {
      should_flip: false,
      reason: `Cooldown active: ${Math.ceil(cooldownRemainingMs / 3600000)}h remaining`,
      cooldown_remaining_ms: cooldownRemainingMs,
      confidence_gap: newConfidence - decision.confidence,
      consecutive_confirmations: 0,
    };
  }

  const confidenceGap = newConfidence - decision.confidence;
  if (confidenceGap < decision.min_confidence_margin) {
    return {
      should_flip: false,
      reason: `Confidence gap ${confidenceGap.toFixed(3)} below required margin ${decision.min_confidence_margin}`,
      cooldown_remaining_ms: 0,
      confidence_gap: confidenceGap,
      consecutive_confirmations: 0,
    };
  }

  const consecutiveConfirmations = countConsecutiveConfirmations(decision);
  if (consecutiveConfirmations < decision.min_consecutive_cycles) {
    return {
      should_flip: false,
      reason: `Only ${consecutiveConfirmations}/${decision.min_consecutive_cycles} consecutive confirmations`,
      cooldown_remaining_ms: 0,
      confidence_gap: confidenceGap,
      consecutive_confirmations: consecutiveConfirmations,
    };
  }

  return {
    should_flip: true,
    reason: 'All hysteresis conditions met',
    cooldown_remaining_ms: 0,
    confidence_gap: confidenceGap,
    consecutive_confirmations: consecutiveConfirmations,
  };
}

/**
 * Detect no-op changes that don't measurably affect behavior or scorecards.
 */
export function isNoOpChange(proposal: ImprovementProposal): boolean {
  if (proposal.category === 'prompt_only') {
    return proposal.estimated_loc_change < 5;
  }

  if (proposal.scorecard_baseline && proposal.scorecard_target) {
    const baseScore = proposal.scorecard_baseline.overall_score;
    const targetScore = proposal.scorecard_target.overall_score;
    return Math.abs(targetScore - baseScore) < 0.001;
  }

  return false;
}

/**
 * Check if a change would cause a reversion of a prior change.
 * Uses vector similarity to find prior decisions that addressed the same area.
 */
export function detectReversion(proposal: ImprovementProposal): {
  is_reversion: boolean;
  similar_decisions: string[];
  similarity_score: number;
} {
  const queryText = `${proposal.title} ${proposal.description}`;
  const similar = findSimilarDecisions(queryText, 3);

  const highSimilarity = similar.filter((s) => s.similarity > 0.7);

  return {
    is_reversion: highSimilarity.length > 0,
    similar_decisions: highSimilarity.map((s) => s.entry.vector_id),
    similarity_score: highSimilarity.length > 0 ? highSimilarity[0].similarity : 0,
  };
}

/**
 * Compute the stability score: number of reversions / decision flips per release window.
 */
export function computeStabilityScore(serverId: string): {
  stability_score: number;
  flips_in_window: number;
  total_decisions: number;
} {
  const activeADRs = listActiveADRs();
  const serverADRs = activeADRs.filter((adr) =>
    adr.related_proposals.some((p) => p.includes(serverId)),
  );

  const recentFlips = serverADRs.filter((adr) => {
    if (!adr.superseded_by) return false;
    const updatedAt = new Date(adr.updated_at);
    const windowMs = getConfig().defaults.window_hours * 60 * 60 * 1000;
    return Date.now() - updatedAt.getTime() < windowMs;
  });

  const totalDecisions = serverADRs.length;
  const flipsInWindow = recentFlips.length;
  const stabilityScore = totalDecisions > 0
    ? 1 - (flipsInWindow / totalDecisions)
    : 1.0;

  return {
    stability_score: Math.max(0, stabilityScore),
    flips_in_window: flipsInWindow,
    total_decisions: totalDecisions,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function findConflictingADR(proposal: ImprovementProposal): ArchitectureDecisionRecord | null {
  const activeADRs = listActiveADRs();

  for (const adr of activeADRs) {
    if (proposal.adr_refs.includes(adr.adr_id)) {
      return adr;
    }
  }

  const queryText = `${proposal.title} ${proposal.description}`;
  const similar = findSimilarDecisions(queryText, 1);
  if (similar.length > 0 && similar[0].similarity > 0.75) {
    const adrId = similar[0].entry.metadata?.adr_id as string | undefined;
    if (adrId) {
      return getADR(adrId);
    }
  }

  return null;
}

function countConsecutiveConfirmations(decision: ArchitectureDecisionRecord): number {
  const queryText = `${decision.title} ${decision.decision}`;
  const similar = findSimilarDecisions(queryText, 10);
  let consecutive = 0;
  for (const s of similar) {
    if (s.similarity > 0.6) {
      consecutive++;
    } else {
      break;
    }
  }
  return consecutive;
}

function wouldDegrade(baseline: ScorecardSnapshot, target: ScorecardSnapshot): boolean {
  for (const dim of baseline.dimensions) {
    if (!dim.is_primary) continue;

    const targetDim = target.dimensions.find((d) => d.name === dim.name);
    if (!targetDim) continue;

    if (targetDim.score < dim.score) {
      return true;
    }
  }
  return false;
}

function buildBlockReason(
  flip: FlipDecision,
  primaryMetricsWorse: boolean,
  adr: ArchitectureDecisionRecord,
): string {
  const reasons: string[] = [];

  if (!flip.should_flip) {
    reasons.push(`Hysteresis check failed: ${flip.reason}`);
  }
  if (primaryMetricsWorse) {
    reasons.push('Change would degrade primary scorecard metrics');
  }
  if (reasons.length === 0) {
    reasons.push(`Conflicts with ADR "${adr.title}" (${adr.adr_id})`);
  }

  return reasons.join('; ');
}
