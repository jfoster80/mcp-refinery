/**
 * Decision Plane facade.
 */

export { evaluatePolicy, seedDefaultPolicies } from './policy.js';
export type { PolicyEvaluation, PolicyViolation } from './policy.js';

export { checkOscillation, shouldFlip, isNoOpChange, detectReversion, computeStabilityScore } from './anti-oscillation.js';

export { createADR, replaceADR, getActiveADRs, findRelatedADRs, formatADRMarkdown } from './adr.js';
export type { CreateADRInput } from './adr.js';

export { triageFindings } from './triage.js';

export { captureScorecard, compareScorecards, getBaseline, formatScorecardReport } from './scorecard.js';
export type {
  ScorecardInput,
  ScorecardComparison,
  ProtocolComplianceMetrics,
  TestingMetrics,
  SecurityMetrics,
  ReliabilityMetrics,
  GovernanceMetrics,
} from './scorecard.js';
