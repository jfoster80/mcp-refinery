/**
 * Storage facade — re-exports all storage subsystems.
 */
export {
  initDatabase,
  upsertTargetServer, getTargetServer, listTargetServers,
  insertResearchFeed, getResearchFeeds,
  insertConsensusResult, getLatestConsensus,
  insertProposal, updateProposalStatus, getProposal, listProposals,
  insertADR, getADR, listActiveADRs, supersedeADR,
  insertPolicyRule, listPolicyRules,
  insertScorecardSnapshot, getLatestScorecard,
  insertDeliveryPlan, getDeliveryPlan,
  insertPullRequest, insertTestRun,
  insertRelease, getRelease, updateReleaseStatus, getLatestRelease,
  insertGovernanceApproval, hasApproval,
} from './database.js';

export { storeArtifact } from './artifacts.js';
export { recordAudit, queryAuditLog, getAuditStats } from './audit.js';
export { indexVector, findSimilarDecisions, getVectorStats } from './vector.js';
