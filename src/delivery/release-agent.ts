/**
 * Release Agent — manages semantic versioning, changelog generation,
 * and release lifecycle (plan -> candidate -> staging -> canary -> released).
 */

import { randomUUID } from 'node:crypto';
import type { ReleaseRecord, ReleaseStatus, DeliveryPlan, ImprovementProposal } from '../types/index.js';
import {
  insertRelease,
  getRelease,
  updateReleaseStatus,
  getLatestRelease,
  getDeliveryPlan,
  getProposal,
  getLatestScorecard,
  recordAudit,
  storeArtifact,
} from '../storage/index.js';

export interface ReleaseInput {
  target_server_id: string;
  plan_id: string;
  pr_ids: string[];
  version_bump?: 'major' | 'minor' | 'patch';
  custom_changelog?: string;
}

/**
 * Create a new release record from a completed delivery plan.
 */
export function createRelease(input: ReleaseInput): ReleaseRecord {
  const plan = getDeliveryPlan(input.plan_id);
  if (!plan) throw new Error(`Delivery plan ${input.plan_id} not found`);

  const previousRelease = getLatestRelease(input.target_server_id);
  const previousVersion = previousRelease?.version ?? '0.0.0';

  const bumpType = input.version_bump ?? determineBumpType(plan);
  const newVersion = semverInc(previousVersion, bumpType);

  const proposals: ImprovementProposal[] = plan.proposals
    .map((id) => getProposal(id))
    .filter((p): p is ImprovementProposal => p !== null);

  const changelog = input.custom_changelog ?? generateChangelog(newVersion, previousVersion, proposals);
  const scorecard = getLatestScorecard(input.target_server_id);

  const release: ReleaseRecord = {
    release_id: randomUUID(),
    target_server_id: input.target_server_id,
    version: newVersion,
    previous_version: previousVersion,
    plan_id: input.plan_id,
    pr_ids: input.pr_ids,
    proposal_ids: plan.proposals,
    changelog,
    status: 'planning',
    scorecard_at_release: scorecard,
    created_at: new Date().toISOString(),
    published_at: null,
    rolled_back_at: null,
    rollback_reason: null,
  };

  insertRelease(release);

  storeArtifact(
    `releases/${release.release_id}/changelog`,
    changelog,
    'text/markdown',
    'report',
    { version: newVersion, server_id: input.target_server_id },
  );

  recordAudit(
    'delivery.released',
    'release_agent',
    'release',
    release.release_id,
    {
      version: newVersion,
      previous_version: previousVersion,
      bump_type: bumpType,
      proposal_count: proposals.length,
    },
  );

  return release;
}

/**
 * Advance the release through its lifecycle stages.
 */
export function advanceRelease(
  releaseId: string,
  targetStatus: ReleaseStatus,
): { success: boolean; message: string } {
  const validTransitions: Record<ReleaseStatus, ReleaseStatus[]> = {
    planning: ['candidate'],
    candidate: ['staging', 'rolled_back'],
    staging: ['canary', 'rolled_back'],
    canary: ['released', 'rolled_back'],
    released: ['rolled_back'],
    rolled_back: [],
  };

  const release = getRelease(releaseId);
  if (!release) return { success: false, message: `Release ${releaseId} not found` };

  const allowed = validTransitions[release.status] ?? [];
  if (!allowed.includes(targetStatus)) {
    return {
      success: false,
      message: `Cannot transition from "${release.status}" to "${targetStatus}". Allowed: ${allowed.join(', ')}`,
    };
  }

  updateReleaseStatus(releaseId, targetStatus);

  recordAudit(
    targetStatus === 'rolled_back' ? 'delivery.rolled_back' : 'delivery.released',
    'release_agent',
    'release',
    releaseId,
    {
      from_status: release.status,
      to_status: targetStatus,
      version: release.version,
    },
  );

  return { success: true, message: `Release ${release.version} advanced to ${targetStatus}` };
}

/**
 * Rollback a release with a recorded reason.
 */
export function rollbackRelease(releaseId: string, reason: string): void {
  updateReleaseStatus(releaseId, 'rolled_back');

  recordAudit(
    'delivery.rolled_back',
    'release_agent',
    'release',
    releaseId,
    { reason },
  );
}

function determineBumpType(plan: DeliveryPlan): 'major' | 'minor' | 'patch' {
  const proposals: ImprovementProposal[] = plan.proposals
    .map((id) => getProposal(id))
    .filter((p): p is ImprovementProposal => p !== null);

  const hasBreaking = proposals.some((p) =>
    p.risk_level === 'critical' || p.category === 'behavioral',
  );
  if (hasBreaking) return 'major';

  const hasFeature = proposals.some((p) =>
    ['behavioral', 'security'].includes(p.category),
  );
  if (hasFeature) return 'minor';

  return 'patch';
}

function generateChangelog(
  version: string,
  previousVersion: string,
  proposals: ImprovementProposal[],
): string {
  const date = new Date().toISOString().slice(0, 10);
  const categories = new Map<string, ImprovementProposal[]>();

  for (const p of proposals) {
    const list = categories.get(p.category) ?? [];
    list.push(p);
    categories.set(p.category, list);
  }

  let changelog = `# ${version} (${date})\n\n`;
  changelog += `Previous version: ${previousVersion}\n\n`;

  const categoryLabels: Record<string, string> = {
    security: 'Security',
    behavioral: 'Features & Improvements',
    refactor: 'Refactoring',
    dependency: 'Dependencies',
    docs: 'Documentation',
    prompt_only: 'Prompt Updates',
  };

  for (const [category, items] of categories) {
    changelog += `## ${categoryLabels[category] ?? category}\n\n`;
    for (const item of items) {
      changelog += `- ${item.title} (${item.risk_level} risk)\n`;
      changelog += `  - ${item.description.split('\n')[0]}\n`;
    }
    changelog += '\n';
  }

  changelog += `---\n*Generated by MCP Refinery*\n`;
  return changelog;
}

function semverInc(version: string, type: 'major' | 'minor' | 'patch'): string {
  const parts = (version || '0.0.0').split('.').map(Number);
  const [major = 0, minor = 0, patch = 0] = parts;
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
