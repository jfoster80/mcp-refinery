/**
 * Data access layer — backed by JSON file stores. Zero external deps.
 *
 * Provides the same function signatures the Decision and Delivery planes
 * expect, but stores everything as JSON files in data/.
 */

import { getConfig } from '../config.js';
import { JsonStore } from './json-store.js';
import type {
  TargetServerConfig, ResearchFeedEntry, ImprovementProposal,
  ArchitectureDecisionRecord, PolicyRule, ScorecardSnapshot,
  DeliveryPlan, PullRequestRecord, TestRunRecord,
  ReleaseRecord, GovernanceApproval, ConsensusResult,
} from '../types/index.js';

type Rec = Record<string, unknown>;

let stores: {
  servers: JsonStore<TargetServerConfig & Rec>;
  feeds: JsonStore<ResearchFeedEntry & Rec>;
  consensus: JsonStore<ConsensusResult & Rec>;
  proposals: JsonStore<ImprovementProposal & Rec>;
  adrs: JsonStore<ArchitectureDecisionRecord & Rec>;
  policies: JsonStore<PolicyRule & Rec>;
  scorecards: JsonStore<ScorecardSnapshot & Rec>;
  plans: JsonStore<DeliveryPlan & Rec>;
  prs: JsonStore<PullRequestRecord & Rec>;
  tests: JsonStore<TestRunRecord & Rec>;
  releases: JsonStore<ReleaseRecord & Rec>;
  approvals: JsonStore<GovernanceApproval & Rec>;
} | null = null;

export function initDatabase(): void {
  if (stores) return;
  const base = getConfig().storage.base_path;
  stores = {
    servers: new JsonStore(base, 'servers', 'server_id'),
    feeds: new JsonStore(base, 'research', 'feed_id'),
    consensus: new JsonStore(base, 'consensus', 'consensus_id'),
    proposals: new JsonStore(base, 'proposals', 'proposal_id'),
    adrs: new JsonStore(base, 'decisions', 'adr_id'),
    policies: new JsonStore(base, 'policies', 'rule_id'),
    scorecards: new JsonStore(base, 'scorecards', 'scorecard_id'),
    plans: new JsonStore(base, 'plans', 'plan_id'),
    prs: new JsonStore(base, 'pull-requests', 'pr_id'),
    tests: new JsonStore(base, 'test-runs', 'run_id'),
    releases: new JsonStore(base, 'releases', 'release_id'),
    approvals: new JsonStore(base, 'approvals', 'approval_id'),
  };
}

function db() {
  if (!stores) { initDatabase(); }
  return stores!;
}

// -- Target Servers ---------------------------------------------------------

export function upsertTargetServer(s: TargetServerConfig): void { db().servers.upsert(s as TargetServerConfig & Rec); }

export function getTargetServer(id: string): TargetServerConfig | null { return db().servers.get(id) as TargetServerConfig | null; }

export function listTargetServers(): TargetServerConfig[] { return db().servers.list() as TargetServerConfig[]; }

// -- Research Feeds ---------------------------------------------------------

export function insertResearchFeed(e: ResearchFeedEntry): void { db().feeds.insert(e as ResearchFeedEntry & Rec); }


export function getResearchFeeds(serverId: string, limit = 50): ResearchFeedEntry[] {
  return db().feeds.list((f) => f.target_server_id === serverId)
    .sort((a, b) => b.completed_at.localeCompare(a.completed_at))
    .slice(0, limit) as ResearchFeedEntry[];
}

// -- Consensus --------------------------------------------------------------

export function insertConsensusResult(r: ConsensusResult): void { db().consensus.insert(r as ConsensusResult & Rec); }

export function getLatestConsensus(serverId: string): ConsensusResult | null {
  const all = db().consensus.list((c) => c.target_server_id === serverId)
    .sort((a, b) => b.computed_at.localeCompare(a.computed_at));
  return (all[0] as ConsensusResult) ?? null;
}

// -- Proposals --------------------------------------------------------------

export function insertProposal(p: ImprovementProposal): void { db().proposals.insert(p as ImprovementProposal & Rec); }

export function updateProposalStatus(id: string, status: ImprovementProposal['status']): void {
  db().proposals.update(id, { status, updated_at: new Date().toISOString() } as Partial<ImprovementProposal & Rec>);
}

export function getProposal(id: string): ImprovementProposal | null { return db().proposals.get(id) as ImprovementProposal | null; }

export function listProposals(serverId: string, status?: string): ImprovementProposal[] {
  return db().proposals.list((p) => {
    if (p.target_server_id !== serverId) return false;
    if (status && p.status !== status) return false;
    return true;
  }).sort((a, b) => b.priority - a.priority) as ImprovementProposal[];
}

// -- ADRs -------------------------------------------------------------------

export function insertADR(a: ArchitectureDecisionRecord): void { db().adrs.insert(a as ArchitectureDecisionRecord & Rec); }

export function getADR(id: string): ArchitectureDecisionRecord | null { return db().adrs.get(id) as ArchitectureDecisionRecord | null; }

export function listActiveADRs(): ArchitectureDecisionRecord[] {
  return db().adrs.list((a) => a.status === 'accepted') as ArchitectureDecisionRecord[];
}

export function supersedeADR(id: string, newId: string): void {
  db().adrs.update(id, { status: 'superseded', superseded_by: newId, updated_at: new Date().toISOString() } as Partial<ArchitectureDecisionRecord & Rec>);
}

// -- Policies ---------------------------------------------------------------

export function insertPolicyRule(r: PolicyRule): void { db().policies.insert(r as PolicyRule & Rec); }

export function listPolicyRules(enabled?: boolean): PolicyRule[] {
  return db().policies.list((r) => enabled === undefined || r.enabled === enabled) as PolicyRule[];
}

// -- Scorecards -------------------------------------------------------------

export function insertScorecardSnapshot(s: ScorecardSnapshot): void { db().scorecards.insert(s as ScorecardSnapshot & Rec); }

export function getLatestScorecard(serverId: string): ScorecardSnapshot | null {
  const all = db().scorecards.list((s) => s.target_server_id === serverId)
    .sort((a, b) => b.captured_at.localeCompare(a.captured_at));
  return (all[0] as ScorecardSnapshot) ?? null;
}

// -- Delivery Plans ---------------------------------------------------------

export function insertDeliveryPlan(p: DeliveryPlan): void { db().plans.insert(p as DeliveryPlan & Rec); }

export function getDeliveryPlan(id: string): DeliveryPlan | null { return db().plans.get(id) as DeliveryPlan | null; }

// -- Pull Requests ----------------------------------------------------------

export function insertPullRequest(p: PullRequestRecord): void { db().prs.insert(p as PullRequestRecord & Rec); }

// -- Test Runs --------------------------------------------------------------

export function insertTestRun(r: TestRunRecord): void { db().tests.insert(r as TestRunRecord & Rec); }

// -- Releases ---------------------------------------------------------------

export function insertRelease(r: ReleaseRecord): void { db().releases.insert(r as ReleaseRecord & Rec); }

export function getRelease(id: string): ReleaseRecord | null { return db().releases.get(id) as ReleaseRecord | null; }

export function updateReleaseStatus(id: string, status: ReleaseRecord['status']): void {
  const updates: Partial<ReleaseRecord & Rec> = { status };
  if (status === 'released') updates.published_at = new Date().toISOString();
  if (status === 'rolled_back') updates.rolled_back_at = new Date().toISOString();
  db().releases.update(id, updates);
}

export function getLatestRelease(serverId: string): ReleaseRecord | null {
  const all = db().releases.list((r) => r.target_server_id === serverId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (all[0] as ReleaseRecord) ?? null;
}

// -- Governance Approvals ---------------------------------------------------

export function insertGovernanceApproval(a: GovernanceApproval): void { db().approvals.insert(a as GovernanceApproval & Rec); }

export function hasApproval(targetType: string, targetId: string): boolean {
  return db().approvals.count((a) => a.target_type === targetType && a.target_id === targetId) > 0;
}
