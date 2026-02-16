/**
 * Governance gate enforcement.
 *
 * Implements the human-in-the-loop checkpoints required by MCP's security model.
 * Manages approvals, escalations, and audit trails for all governance decisions.
 */

import { randomUUID } from 'node:crypto';
import type {
  GovernanceApproval,
  ImprovementProposal,
  DeliveryPlan,
  ReleaseRecord,
  AutonomyLevel,
} from '../types/index.js';
import {
  insertGovernanceApproval,
  hasApproval,
  getTargetServer,
  recordAudit,
} from '../storage/index.js';

export interface ApprovalRequest {
  target_type: 'proposal' | 'plan' | 'release' | 'adr_override';
  target_id: string;
  risk_level: string;
  summary: string;
  rollback_plan: string;
  changes_description: string;
}

export interface ApprovalResponse {
  approved: boolean;
  approval_id: string | null;
  reason: string;
}

/**
 * Check if a governance action is allowed based on the autonomy level and existing approvals.
 */
export function checkGovernanceGate(
  targetType: 'proposal' | 'plan' | 'release' | 'adr_override',
  targetId: string,
  serverId: string,
  riskLevel: string,
): {
  allowed: boolean;
  requires_approval: boolean;
  has_approval: boolean;
  reason: string;
} {
  const server = getTargetServer(serverId);
  const autonomy = server?.autonomy_level ?? 'advisory';
  const approved = hasApproval(targetType, targetId);

  const needsApproval = doesRequireApproval(autonomy, targetType, riskLevel);

  if (!needsApproval) {
    return {
      allowed: true,
      requires_approval: false,
      has_approval: approved,
      reason: `Autonomy level "${autonomy}" allows automatic ${targetType} for ${riskLevel} risk`,
    };
  }

  if (approved) {
    return {
      allowed: true,
      requires_approval: true,
      has_approval: true,
      reason: `Approved: governance approval exists for ${targetType} ${targetId}`,
    };
  }

  return {
    allowed: false,
    requires_approval: true,
    has_approval: false,
    reason: `Blocked: ${targetType} requires human approval (autonomy: ${autonomy}, risk: ${riskLevel})`,
  };
}

/**
 * Record a governance approval decision.
 */
export function recordApproval(
  targetType: 'proposal' | 'plan' | 'release' | 'adr_override',
  targetId: string,
  approvedBy: string,
  riskAcknowledged: boolean,
  rollbackPlanAcknowledged: boolean,
  notes: string,
): GovernanceApproval {
  const approval: GovernanceApproval = {
    approval_id: randomUUID(),
    target_type: targetType,
    target_id: targetId,
    approved_by: approvedBy,
    risk_acknowledged: riskAcknowledged,
    rollback_plan_acknowledged: rollbackPlanAcknowledged,
    notes,
    created_at: new Date().toISOString(),
  };

  insertGovernanceApproval(approval);

  recordAudit(
    'governance.approval',
    approvedBy,
    targetType,
    targetId,
    {
      risk_acknowledged: riskAcknowledged,
      rollback_acknowledged: rollbackPlanAcknowledged,
      notes,
    },
  );

  return approval;
}

/**
 * Escalate a decision to human arbitration.
 */
export function escalateToHuman(
  reason: string,
  context: {
    target_type: string;
    target_id: string;
    provider_disagreement?: boolean;
    low_confidence?: boolean;
    high_risk?: boolean;
  },
): {
  escalation_id: string;
  message: string;
} {
  const escalationId = randomUUID();

  recordAudit(
    'governance.escalation',
    'governance_gate',
    context.target_type,
    context.target_id,
    {
      escalation_id: escalationId,
      reason,
      ...context,
    },
  );

  const triggers: string[] = [];
  if (context.provider_disagreement) triggers.push('providers disagree');
  if (context.low_confidence) triggers.push('low confidence');
  if (context.high_risk) triggers.push('high risk level');

  return {
    escalation_id: escalationId,
    message: `Human review required for ${context.target_type} "${context.target_id}": ${reason}. Triggers: ${triggers.join(', ')}.`,
  };
}

/**
 * Build an approval request with all context needed for human decision.
 */
export function buildApprovalRequest(
  proposal: ImprovementProposal,
  plan: DeliveryPlan | null,
): ApprovalRequest {
  return {
    target_type: 'proposal',
    target_id: proposal.proposal_id,
    risk_level: proposal.risk_level,
    summary: `${proposal.title}\n\n${proposal.description}`,
    rollback_plan: plan?.rollback_plan ?? 'Revert merge commit and redeploy previous version',
    changes_description: `Category: ${proposal.category}\nEstimated LOC: ${proposal.estimated_loc_change}\nAcceptance Criteria:\n${proposal.acceptance_criteria.map((c) => `  - ${c}`).join('\n')}`,
  };
}

function doesRequireApproval(
  autonomy: AutonomyLevel,
  targetType: string,
  riskLevel: string,
): boolean {
  if (autonomy === 'advisory') return true;

  if (autonomy === 'pr_only') return true;

  if (autonomy === 'auto_merge') {
    if (['high', 'critical'].includes(riskLevel)) return true;
    if (targetType === 'release') return true;
    if (targetType === 'adr_override') return true;
    return false;
  }

  if (autonomy === 'auto_release') {
    if (riskLevel === 'critical') return true;
    if (targetType === 'adr_override') return true;
    return false;
  }

  return true;
}
