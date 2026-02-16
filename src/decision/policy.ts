/**
 * Policy engine for the Decision Plane.
 *
 * Enforces scope constraints, change budgets, risk tiers, and autonomy levels.
 * Policies are stored as rules in the database and evaluated against proposals.
 */

import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import {
  listPolicyRules,
  insertPolicyRule,
  getTargetServer,
  listProposals,
  recordAudit,
} from '../storage/index.js';
import type {
  PolicyRule,
  ImprovementProposal,
  TargetServerConfig,
  AutonomyLevel,
} from '../types/index.js';

export interface PolicyEvaluation {
  proposal_id: string;
  allowed: boolean;
  requires_approval: boolean;
  violations: PolicyViolation[];
  applicable_rules: string[];
}

export interface PolicyViolation {
  rule_id: string;
  rule_name: string;
  reason: string;
  severity: 'warning' | 'blocking';
}

/**
 * Evaluate a proposal against all active policies.
 */
export function evaluatePolicy(proposal: ImprovementProposal): PolicyEvaluation {
  const rules = listPolicyRules(true);
  const server = getTargetServer(proposal.target_server_id);
  const config = getConfig();

  const violations: PolicyViolation[] = [];
  const applicableRules: string[] = [];
  let requiresApproval = false;

  for (const rule of rules) {
    const result = evaluateRule(rule, proposal, server, config);
    if (result.applies) {
      applicableRules.push(rule.rule_id);
      if (result.violation) {
        violations.push(result.violation);
      }
      if (result.requiresApproval) {
        requiresApproval = true;
      }
    }
  }

  if (server) {
    const budgetViolation = checkChangeBudget(proposal, server);
    if (budgetViolation) violations.push(budgetViolation);

    const categoryViolation = checkCategoryAllowed(proposal, server);
    if (categoryViolation) violations.push(categoryViolation);

    const locViolation = checkLOCBudget(proposal, config.defaults.max_loc_per_pr);
    if (locViolation) violations.push(locViolation);

    if (requiresApprovalForRisk(proposal, server.autonomy_level)) {
      requiresApproval = true;
    }
  }

  const blockingViolations = violations.filter((v) => v.severity === 'blocking');
  const allowed = blockingViolations.length === 0;

  if (!allowed) {
    recordAudit(
      'policy.violation',
      'policy_engine',
      'proposal',
      proposal.proposal_id,
      { violations: violations.map((v) => v.reason) },
    );
  }

  return {
    proposal_id: proposal.proposal_id,
    allowed,
    requires_approval: requiresApproval,
    violations,
    applicable_rules: applicableRules,
  };
}

interface RuleResult {
  applies: boolean;
  violation: PolicyViolation | null;
  requiresApproval: boolean;
}

function evaluateRule(
  rule: PolicyRule,
  proposal: ImprovementProposal,
  _server: TargetServerConfig | null,
  _config: ReturnType<typeof getConfig>,
): RuleResult {
  const result: RuleResult = { applies: false, violation: null, requiresApproval: false };

  if (rule.category === 'scope') {
    result.applies = true;
    const allowedServers = (rule.parameters.allowed_servers as string[]) ?? [];
    if (allowedServers.length > 0 && !allowedServers.includes(proposal.target_server_id)) {
      result.violation = {
        rule_id: rule.rule_id,
        rule_name: rule.name,
        reason: `Server ${proposal.target_server_id} is not in the allowed scope`,
        severity: 'blocking',
      };
    }
  }

  if (rule.category === 'risk_tier') {
    result.applies = true;
    const maxAutoRisk = (rule.parameters.max_auto_risk as string) ?? 'medium';
    const riskOrder = ['low', 'medium', 'high', 'critical'];
    if (riskOrder.indexOf(proposal.risk_level) > riskOrder.indexOf(maxAutoRisk)) {
      result.requiresApproval = true;
    }
  }

  if (rule.category === 'budget') {
    result.applies = true;
    const maxPerWindow = (rule.parameters.max_proposals_per_window as number) ?? 5;
    const existing = listProposals(proposal.target_server_id, 'in_progress');
    if (existing.length >= maxPerWindow) {
      result.violation = {
        rule_id: rule.rule_id,
        rule_name: rule.name,
        reason: `Change budget exhausted: ${existing.length}/${maxPerWindow} proposals already in progress`,
        severity: 'blocking',
      };
    }
  }

  if (rule.category === 'autonomy') {
    result.applies = true;
    const requiredLevel = (rule.parameters.min_autonomy_level as AutonomyLevel) ?? 'pr_only';
    const levels: AutonomyLevel[] = ['advisory', 'pr_only', 'auto_merge', 'auto_release'];
    if (levels.indexOf(requiredLevel) > levels.indexOf(_server?.autonomy_level ?? 'advisory')) {
      result.requiresApproval = true;
    }
  }

  return result;
}

function checkChangeBudget(
  proposal: ImprovementProposal,
  server: TargetServerConfig,
): PolicyViolation | null {
  const windowStart = new Date(
    Date.now() - server.window_hours * 60 * 60 * 1000,
  ).toISOString();

  const recentProposals = listProposals(server.server_id).filter(
    (p) =>
      p.created_at >= windowStart &&
      ['in_progress', 'pr_open', 'testing', 'merged'].includes(p.status),
  );

  if (recentProposals.length >= server.change_budget_per_window) {
    return {
      rule_id: 'builtin:change_budget',
      rule_name: 'Change Budget',
      reason: `Change budget exhausted: ${recentProposals.length}/${server.change_budget_per_window} in the last ${server.window_hours}h`,
      severity: 'blocking',
    };
  }
  return null;
}

function checkCategoryAllowed(
  proposal: ImprovementProposal,
  server: TargetServerConfig,
): PolicyViolation | null {
  if (server.allowed_categories.length === 0) return null;
  if (!server.allowed_categories.includes(proposal.category)) {
    return {
      rule_id: 'builtin:category',
      rule_name: 'Category Restriction',
      reason: `Category "${proposal.category}" is not allowed for server ${server.name}`,
      severity: 'blocking',
    };
  }
  return null;
}

function checkLOCBudget(
  proposal: ImprovementProposal,
  maxLoc: number,
): PolicyViolation | null {
  if (proposal.estimated_loc_change > maxLoc) {
    return {
      rule_id: 'builtin:loc_budget',
      rule_name: 'LOC Budget',
      reason: `Estimated ${proposal.estimated_loc_change} LOC exceeds maximum ${maxLoc} per PR`,
      severity: 'warning',
    };
  }
  return null;
}

function requiresApprovalForRisk(
  proposal: ImprovementProposal,
  autonomyLevel: AutonomyLevel,
): boolean {
  if (autonomyLevel === 'advisory') return true;
  if (autonomyLevel === 'pr_only') return true;
  if (autonomyLevel === 'auto_merge') {
    return ['high', 'critical'].includes(proposal.risk_level);
  }
  if (autonomyLevel === 'auto_release') {
    return proposal.risk_level === 'critical';
  }
  return true;
}

/**
 * Seed the database with default policy rules.
 * Skips seeding if rules already exist (prevents duplicates on restart).
 */
export function seedDefaultPolicies(): void {
  const existing = listPolicyRules();
  if (existing.length > 0) return;

  const now = new Date().toISOString();
  const defaults: Omit<PolicyRule, 'rule_id'>[] = [
    {
      name: 'Default Risk Tier',
      description: 'Require human approval for high/critical risk changes',
      category: 'risk_tier',
      condition: 'proposal.risk_level in [high, critical]',
      action: 'require_approval',
      parameters: { max_auto_risk: 'medium' },
      enabled: true,
      created_at: now,
    },
    {
      name: 'Default Change Budget',
      description: 'Limit concurrent in-progress proposals per server',
      category: 'budget',
      condition: 'active_proposals >= max_proposals_per_window',
      action: 'deny',
      parameters: { max_proposals_per_window: 5 },
      enabled: true,
      created_at: now,
    },
    {
      name: 'Default Autonomy Gate',
      description: 'Enforce PR-only autonomy as the minimum level',
      category: 'autonomy',
      condition: 'server.autonomy_level < min_autonomy_level',
      action: 'require_approval',
      parameters: { min_autonomy_level: 'pr_only' },
      enabled: true,
      created_at: now,
    },
  ];

  for (const rule of defaults) {
    insertPolicyRule({ ...rule, rule_id: randomUUID() });
  }
}
