/**
 * ResearchOps facade — first-class research lifecycle for governed self-improvement.
 *
 * Turns "ideas + external research dumps" into frozen, implementation-grade
 * change proposals that mcp-refinery can safely execute.
 *
 * Pipeline: intake → synthesize → review → decide → freeze → implement → evaluate → release
 */

export { createCase, advanceCase, getCase, listCases, consultCase } from './case-manager.js';
export type { AdvanceResult } from './case-manager.js';
export { validateCase } from './validation.js';
export type {
  ResearchCase, CaseStatus, CaseOverlayStep, PHIClassification,
  ReviewPerspective, ReviewArtifact, DecisionArtifact,
  ChangeProposal, ImplementationBrief, EvaluationReport,
  ValidationResult, ValidationCheck, ChangeBudget,
} from './types.js';
export { CASE_OVERLAY_PIPELINE, REVIEW_PERSPECTIVES } from './types.js';
