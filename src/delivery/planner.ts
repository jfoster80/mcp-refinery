/**
 * Delivery Plan builder.
 *
 * Produces implementation plans with acceptance criteria, test strategies,
 * and rollback plans from triaged improvement proposals.
 */

import { randomUUID } from 'node:crypto';
import type { DeliveryPlan, ImprovementProposal } from '../types/index.js';
import { getProposal, insertDeliveryPlan, getTargetServer, recordAudit } from '../storage/index.js';
import { getConfig } from '../config.js';

export interface PlanInput {
  target_server_id: string;
  proposal_ids: string[];
  custom_test_strategy?: string;
  custom_rollback_plan?: string;
}

/**
 * Build a delivery plan from a set of approved proposals.
 */
export function buildDeliveryPlan(input: PlanInput): DeliveryPlan {
  const server = getTargetServer(input.target_server_id);
  const proposals: ImprovementProposal[] = [];

  for (const id of input.proposal_ids) {
    const proposal = getProposal(id);
    if (proposal) proposals.push(proposal);
  }

  if (proposals.length === 0) {
    throw new Error('No valid proposals found for delivery plan');
  }

  const acceptanceCriteria: Record<string, string[]> = {};
  for (const p of proposals) {
    acceptanceCriteria[p.proposal_id] = p.acceptance_criteria;
  }

  const totalLOC = proposals.reduce((s, p) => s + p.estimated_loc_change, 0);
  const maxRisk = proposals.reduce((max, p) => {
    const order = ['low', 'medium', 'high', 'critical'];
    return order.indexOf(p.risk_level) > order.indexOf(max) ? p.risk_level : max;
  }, 'low' as string);

  const testStrategy = input.custom_test_strategy ?? buildTestStrategy(proposals, maxRisk);
  const rollbackPlan = input.custom_rollback_plan ?? buildRollbackPlan(proposals, server?.name ?? input.target_server_id);

  const estimatedHours = estimateDuration(totalLOC, proposals.length, maxRisk);

  const plan: DeliveryPlan = {
    plan_id: randomUUID(),
    target_server_id: input.target_server_id,
    proposals: input.proposal_ids,
    acceptance_criteria: acceptanceCriteria,
    test_strategy: testStrategy,
    rollback_plan: rollbackPlan,
    estimated_duration_hours: estimatedHours,
    created_at: new Date().toISOString(),
    status: 'draft',
  };

  insertDeliveryPlan(plan);

  recordAudit(
    'delivery.plan',
    'planner',
    'delivery_plan',
    plan.plan_id,
    {
      proposal_count: proposals.length,
      total_loc: totalLOC,
      max_risk: maxRisk,
      estimated_hours: estimatedHours,
    },
  );

  return plan;
}

function buildTestStrategy(proposals: ImprovementProposal[], maxRisk: string): string {
  const lines = [
    '## Test Strategy\n',
    '### Unit Tests',
    '- Run full existing test suite, ensure zero regressions',
    '- Add unit tests for all new/modified functions',
    `- Target coverage: ${maxRisk === 'critical' ? '90%' : maxRisk === 'high' ? '85%' : '80%'}\n`,
    '### Protocol Compliance Tests',
    '- Validate all tool schemas against MCP spec (2025-11-25)',
    '- Test resource URI resolution and access patterns',
    '- Verify error responses conform to JSON-RPC 2.0\n',
    '### Integration Tests',
    '- End-to-end tool invocation tests via STDIO transport',
    '- Rate limit and retry behavior validation',
    '- Auth flow tests (if applicable)\n',
    '### Security Tests',
    '- Secret scanning on all changed files',
    '- Dependency vulnerability check (npm audit)',
    '- Input validation fuzzing for tool parameters\n',
    '### Scorecard Evaluation',
    '- Capture pre-change scorecard baseline',
    '- Capture post-change scorecard',
    '- Verify monotonic improvement on primary dimensions',
  ];

  if (['high', 'critical'].includes(maxRisk)) {
    lines.push('\n### Extended Validation (High Risk)');
    lines.push('- Manual code review required');
    lines.push('- Canary deployment with 10% traffic for 24h');
    lines.push('- Automated rollback if error rate exceeds 1%');
  }

  return lines.join('\n');
}

function buildRollbackPlan(proposals: ImprovementProposal[], serverName: string): string {
  return `## Rollback Plan for ${serverName}

### Immediate Rollback (< 5 minutes)
1. Revert the merge commit on the main branch
2. Trigger CI to rebuild and deploy the previous version
3. Verify scorecard metrics return to baseline

### Release Rollback (< 30 minutes)
1. Identify the previous stable release tag
2. Cut a patch release from the previous tag
3. Publish to registry and redeploy
4. Record rollback reason in audit log

### Post-Rollback
1. Create postmortem document
2. Update ADR if the approach was fundamentally flawed
3. Re-triage the rolled-back proposals with new evidence
4. Adjust anti-oscillation parameters if needed

### Affected Proposals
${proposals.map((p) => `- ${p.proposal_id}: ${p.title}`).join('\n')}
`;
}

function estimateDuration(totalLOC: number, proposalCount: number, maxRisk: string): number {
  let baseHours = totalLOC / 50;
  baseHours += proposalCount * 0.5;

  const riskMultiplier: Record<string, number> = {
    low: 1.0,
    medium: 1.3,
    high: 1.8,
    critical: 2.5,
  };
  baseHours *= riskMultiplier[maxRisk] ?? 1.0;

  return Math.max(1, Math.round(baseHours * 10) / 10);
}
