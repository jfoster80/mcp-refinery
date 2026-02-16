/**
 * ResearchOps types — Research Case lifecycle for governed self-improvement.
 *
 * Provides the type system for the full research lifecycle:
 *   intake → synthesize → review → decide → freeze → implement → evaluate → release
 *
 * Zero external dependencies. All types use plain TypeScript.
 */

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type PHIClassification = 'none' | 'internal_only' | 'restricted';

export type CaseStatus =
  | 'intake'
  | 'synthesizing'
  | 'reviewing'
  | 'deciding'
  | 'frozen'
  | 'implementing'
  | 'evaluating'
  | 'releasing'
  | 'completed'
  | 'rejected'
  | 'deferred';

export type ReviewPerspective =
  | 'architecture'
  | 'security_compliance'
  | 'ops_reliability'
  | 'cost_performance'
  | 'adversarial_skeptic';

export type CaseOverlayStep =
  | 'intake'
  | 'synthesize'
  | 'review'
  | 'decide'
  | 'freeze'
  | 'implement'
  | 'evaluate'
  | 'release';

export const CASE_OVERLAY_PIPELINE: CaseOverlayStep[] = [
  'intake', 'synthesize', 'review', 'decide', 'freeze',
  'implement', 'evaluate', 'release',
];

export const REVIEW_PERSPECTIVES: ReviewPerspective[] = [
  'architecture', 'security_compliance', 'ops_reliability',
  'cost_performance', 'adversarial_skeptic',
];

// ---------------------------------------------------------------------------
// Research Case — the durable, auditable unit of research
// ---------------------------------------------------------------------------

export interface ResearchCase {
  case_id: string;
  initiative_name: string;
  owner: string;
  problem_statement: string;
  goals: string[];
  non_goals: string[];
  risk_lane: 'low' | 'medium' | 'high';
  phi_classification: PHIClassification;
  target_consumer: 'mcp_refinery' | 'software_agent' | 'both';

  // State machine
  status: CaseStatus;
  current_overlay: CaseOverlayStep;
  overlay_index: number;

  // Artifacts
  intake: IntakeArtifact | null;
  sources: Record<string, string>;
  synthesis: string | null;
  evidence_matrix: EvidenceEntry[] | null;
  reviews: Partial<Record<ReviewPerspective, ReviewArtifact>>;
  decision: DecisionArtifact | null;
  proposal: ChangeProposal | null;
  brief: ImplementationBrief | null;
  evaluation: EvaluationReport | null;
  release_notes: string | null;

  // Safety constraints
  change_budget: ChangeBudget;

  // Cross-references to refinery entities
  consensus_id: string | null;
  delivery_plan_id: string | null;
  pr_ids: string[];
  release_id: string | null;
  deliberation_session_id: string | null;
  scorecard_ids: string[];

  // Metadata
  created_at: string;
  updated_at: string;

  // Index signature for JsonStore compatibility
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Artifact Types
// ---------------------------------------------------------------------------

export interface IntakeArtifact {
  target_system: string;
  constraints: string[];
  prior_art: string[];
  success_criteria: string[];
}

export interface EvidenceEntry {
  claim: string;
  evidence_for: string[];
  evidence_against: string[];
  confidence: number;
  source_refs: string[];
}

export interface ReviewArtifact {
  perspective: ReviewPerspective;
  verdict: 'approve' | 'approve_with_conditions' | 'reject' | 'defer';
  required_changes: string[];
  recommendations: string[];
  risks: string[];
  confidence: number;
  reviewed_at: string;
}

export interface DecisionArtifact {
  outcome: 'accepted' | 'rejected' | 'deferred';
  rationale: string;
  not_adopted: string[];
  conditions: string[];
  decided_at: string;
}

export interface ChangeProposal {
  title: string;
  scope: string[];
  out_of_scope: string[];
  changes: ProposedChange[];
  frozen: boolean;
  frozen_at: string | null;
}

export interface ProposedChange {
  component: string;
  description: string;
  estimated_loc: number;
  risk_level: 'low' | 'medium' | 'high';
}

export interface ImplementationBrief {
  acceptance_criteria: string[];
  non_functional_requirements: string[];
  test_requirements: string[];
  rollout_plan: string;
  rollback_plan: string;
  telemetry_requirements: string[];
  change_budget: { max_prs: number; max_iterations: number };
}

export interface EvaluationReport {
  test_results: TestResult[];
  policy_checks: PolicyCheck[];
  stability_checks: StabilityCheck[];
  risks: EvalRisk[];
  overall_pass: boolean;
  evaluated_at: string;
}

export interface TestResult {
  suite: string;
  passed: boolean;
  total: number;
  passed_count: number;
  failed_count: number;
}

export interface PolicyCheck {
  check: string;
  passed: boolean;
  notes: string;
}

export interface StabilityCheck {
  check: string;
  passed: boolean;
  notes: string;
}

export interface EvalRisk {
  risk: string;
  severity: string;
  mitigation: string;
}

export interface ChangeBudget {
  max_prs: number;
  max_iterations: number;
  prs_used: number;
  iterations_used: number;
}

// ---------------------------------------------------------------------------
// Validation Types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  case_id: string;
  passed: boolean;
  checks: ValidationCheck[];
  validated_at: string;
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
  severity: 'error' | 'warning' | 'info';
}
