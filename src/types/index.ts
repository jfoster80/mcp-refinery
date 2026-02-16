/**
 * Core type definitions for MCP Refinery.
 *
 * Zero external dependencies — all types use plain TypeScript.
 * Organized into: Research, Decision, Delivery, Audit, Config.
 */

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type ResearchPerspective = 'security' | 'reliability' | 'compliance' | 'devex' | 'performance' | 'general';

export type EvidenceType = 'url' | 'quote' | 'spec_reference';

export type EvidenceQuality = 'A' | 'B' | 'C';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type AutonomyLevel = 'advisory' | 'pr_only' | 'auto_merge' | 'auto_release';

export type ChangeCategory = 'behavioral' | 'refactor' | 'docs' | 'prompt_only' | 'security' | 'dependency';

export type ProposalStatus =
  | 'draft' | 'triaged' | 'approved' | 'in_progress'
  | 'pr_open' | 'testing' | 'merged' | 'released'
  | 'rejected' | 'rolled_back';

export type ADRStatus = 'proposed' | 'accepted' | 'superseded' | 'deprecated';

export type ReleaseStatus = 'planning' | 'candidate' | 'staging' | 'canary' | 'released' | 'rolled_back';

export type AuditAction =
  | 'research.start' | 'research.store'
  | 'proposal.triage' | 'proposal.approve'
  | 'adr.record' | 'adr.supersede'
  | 'scorecard.capture'
  | 'oscillation.blocked'
  | 'delivery.plan' | 'delivery.pr_created' | 'delivery.tests_run'
  | 'delivery.released' | 'delivery.rolled_back'
  | 'governance.approval' | 'governance.escalation' | 'policy.violation'
  | 'pipeline.start' | 'pipeline.cleanup'
  | 'deliberation.start' | 'deliberation.resolve';

// ---------------------------------------------------------------------------
// Bootstrap Prompt System
// ---------------------------------------------------------------------------

export interface ToolOutput {
  status: 'success' | 'error' | 'needs_input' | 'needs_approval';
  data: Record<string, unknown>;
  message: string;
  next: {
    control: 'agent' | 'user';
    description: string;
    bootstrap_prompt: string;
  } | null;
}

// ---------------------------------------------------------------------------
// Research Plane Types
// ---------------------------------------------------------------------------

export interface Evidence {
  type: EvidenceType;
  value: string;
  quality: EvidenceQuality;
}

export interface Finding {
  claim: string;
  recommendation: string;
  expected_impact: {
    reliability: number;
    security: number;
    devex: number;
    performance: number;
  };
  risk: { level: RiskLevel; notes: string };
  evidence: Evidence[];
}

export interface ResearchFeedEntry {
  feed_id: string;
  perspective: ResearchPerspective;
  requested_at: string;
  completed_at: string;
  prompt_hash: string;
  findings: Finding[];
  target_server_id: string;
  confidence: number;
}

export interface ConsensusResult {
  consensus_id: string;
  target_server_id: string;
  computed_at: string;
  findings: ConsensusFinding[];
  overall_agreement: number;
  perspectives_used: ResearchPerspective[];
}

export interface ConsensusFinding {
  claim: string;
  recommendation: string;
  supporting_perspectives: ResearchPerspective[];
  agreement_score: number;
  combined_confidence: number;
  merged_evidence: Evidence[];
  merged_impact: { reliability: number; security: number; devex: number; performance: number };
  risk_level: RiskLevel;
}

// ---------------------------------------------------------------------------
// Decision Plane Types
// ---------------------------------------------------------------------------

export interface ImprovementProposal {
  proposal_id: string;
  target_server_id: string;
  title: string;
  description: string;
  category: ChangeCategory;
  status: ProposalStatus;
  priority: number;
  risk_level: RiskLevel;
  consensus_finding_ref: string;
  acceptance_criteria: string[];
  estimated_loc_change: number;
  created_at: string;
  updated_at: string;
  adr_refs: string[];
  scorecard_baseline: ScorecardSnapshot | null;
  scorecard_target: ScorecardSnapshot | null;
}

export interface ArchitectureDecisionRecord {
  adr_id: string;
  title: string;
  status: ADRStatus;
  context: string;
  decision: string;
  rationale: string;
  consequences: string[];
  alternatives_considered: string[];
  confidence: number;
  cooldown_until: string;
  min_confidence_margin: number;
  min_consecutive_cycles: number;
  created_at: string;
  updated_at: string;
  superseded_by: string | null;
  related_proposals: string[];
}

export interface PolicyRule {
  rule_id: string;
  name: string;
  description: string;
  category: 'scope' | 'budget' | 'risk_tier' | 'anti_oscillation' | 'autonomy';
  condition: string;
  action: 'allow' | 'deny' | 'escalate' | 'require_approval';
  parameters: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
}

export interface ScorecardSnapshot {
  scorecard_id: string;
  target_server_id: string;
  captured_at: string;
  dimensions: ScorecardDimension[];
  overall_score: number;
}

export interface ScorecardDimension {
  name: string;
  weight: number;
  score: number;
  is_primary: boolean;
  sub_metrics: ScorecardMetric[];
}

export interface ScorecardMetric {
  name: string;
  value: number;
  threshold: number;
  passed: boolean;
}

export interface OscillationCheck {
  proposal_id: string;
  adr_id: string | null;
  would_flip: boolean;
  blocked: boolean;
  reason: string;
  cooldown_remaining_ms: number;
  confidence_gap: number;
  consecutive_confirmations: number;
}

export interface TriageResult {
  proposals: TriagedProposal[];
  total_estimated_loc: number;
  budget_remaining: number;
  escalations: string[];
}

export interface TriagedProposal {
  proposal_id: string;
  priority_score: number;
  risk_adjusted_impact: number;
  blocked_by_oscillation: boolean;
  requires_human_approval: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Delivery Plane Types
// ---------------------------------------------------------------------------

export interface DeliveryPlan {
  plan_id: string;
  target_server_id: string;
  proposals: string[];
  acceptance_criteria: Record<string, string[]>;
  test_strategy: string;
  rollback_plan: string;
  estimated_duration_hours: number;
  created_at: string;
  status: 'draft' | 'approved' | 'in_progress' | 'completed' | 'aborted';
}

export interface PullRequestRecord {
  pr_id: string;
  plan_id: string;
  proposal_ids: string[];
  repo_url: string;
  branch_name: string;
  pr_number: number | null;
  pr_url: string | null;
  title: string;
  description: string;
  diff_stats: { files_changed: number; additions: number; deletions: number };
  status: 'draft' | 'open' | 'reviewing' | 'approved' | 'merged' | 'closed';
  created_at: string;
  updated_at: string;
}

export interface TestRunRecord {
  run_id: string;
  pr_id: string;
  plan_id: string;
  test_suite: string;
  passed: boolean;
  total_tests: number;
  passed_tests: number;
  failed_tests: number;
  skipped_tests: number;
  coverage_percent: number | null;
  duration_ms: number;
  scorecard_after: ScorecardSnapshot | null;
  created_at: string;
}

export interface ReleaseRecord {
  release_id: string;
  target_server_id: string;
  version: string;
  previous_version: string | null;
  plan_id: string;
  pr_ids: string[];
  proposal_ids: string[];
  changelog: string;
  status: ReleaseStatus;
  scorecard_at_release: ScorecardSnapshot | null;
  created_at: string;
  published_at: string | null;
  rolled_back_at: string | null;
  rollback_reason: string | null;
}

export interface GovernanceApproval {
  approval_id: string;
  target_type: 'proposal' | 'plan' | 'release' | 'adr_override';
  target_id: string;
  approved_by: string;
  risk_acknowledged: boolean;
  rollback_plan_acknowledged: boolean;
  notes: string;
  created_at: string;
}

export interface AuditEntry {
  entry_id: string;
  action: AuditAction;
  actor: string;
  target_type: string;
  target_id: string;
  details: Record<string, unknown>;
  timestamp: string;
  correlation_id: string;
}

// ---------------------------------------------------------------------------
// Server & Config Types
// ---------------------------------------------------------------------------

export interface TargetServerConfig {
  server_id: string;
  name: string;
  repo_url: string;
  branch: string;
  transport: 'stdio' | 'http';
  auth_mode: 'none' | 'oauth' | 'env_credentials';
  autonomy_level: AutonomyLevel;
  change_budget_per_window: number;
  window_hours: number;
  allowed_categories: ChangeCategory[];
  scorecard_weights: Record<string, number>;
  created_at: string;
  updated_at: string;
}

export interface RefineryConfig {
  defaults: {
    autonomy_level: AutonomyLevel;
    change_budget_per_window: number;
    window_hours: number;
    cooldown_hours: number;
    min_confidence_margin: number;
    min_consecutive_cycles: number;
    max_loc_per_pr: number;
  };
  storage: {
    base_path: string;
    source_path: string;
  };
  routing: {
    multi_model_threshold: 'high' | 'critical';
    default_architect: string;
    default_workhorse: string;
    default_fast: string;
  };
}

// ---------------------------------------------------------------------------
// Model Routing & Deliberation Types
// ---------------------------------------------------------------------------

export type ModelTier = 'architect' | 'workhorse' | 'fast';

export type ProviderName = 'anthropic' | 'openai' | 'google' | 'xai';

export type ModelCapability =
  | 'deep_reasoning' | 'code_generation' | 'code_review'
  | 'architecture' | 'security_audit' | 'documentation'
  | 'fast_iteration' | 'structured_output' | 'vision';

export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'complex' | 'critical';

export interface ModelProfile {
  model_id: string;
  provider: ProviderName;
  tier: ModelTier;
  display_name: string;
  api_model_id: string;
  capabilities: ModelCapability[];
  cost_input_per_mtok: number;
  cost_output_per_mtok: number;
  max_context: number;
  speed: number;
  quality: number;
  supports_structured: boolean;
  available: boolean;
}

export interface TaskClassification {
  task_id: string;
  description: string;
  complexity: TaskComplexity;
  domain: string;
  risk_level: RiskLevel;
  requires_multi_model: boolean;
  recommended_tier: ModelTier;
  recommended_models: string[];
  reasoning: string;
}

export interface DeliberationSession {
  session_id: string;
  task_id: string;
  problem_statement: string;
  context: string;
  models_assigned: string[];
  responses: DeliberationResponse[];
  agreement_analysis: AgreementAnalysis | null;
  resolution: 'pending' | 'consensus' | 'majority' | 'user_decision';
  final_recommendation: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliberationResponse {
  model_id: string;
  provider: ProviderName;
  response_text: string;
  structured_output: Record<string, unknown> | null;
  confidence: number;
  key_points: string[];
  risks_identified: string[];
  timestamp: string;
  latency_ms: number;
  tokens_used: { input: number; output: number };
}

export interface AgreementAnalysis {
  overall_agreement: number;
  agreed_points: string[];
  conflicting_points: ConflictPoint[];
  unique_insights: Array<{ model_id: string; insight: string }>;
  synthesis: string;
}

export interface ConflictPoint {
  topic: string;
  positions: Array<{ model_id: string; position: string; reasoning: string }>;
  severity: 'minor' | 'significant' | 'fundamental';
  requires_user_decision: boolean;
}
