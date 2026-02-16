/**
 * Research Case lifecycle manager.
 *
 * Manages Research Cases through the overlay pipeline:
 *   intake → synthesize → review → decide → freeze → implement → evaluate → release
 *
 * Each step produces artifacts that accumulate into the case.
 * The "freeze" step is an alignment gate — requires user approval.
 *
 * Integration: Every step delegates to the refinery's existing subsystems
 * (research plane, agent registry, deliberation, governance, delivery, scorecard)
 * via bootstrap prompts that guide the Cursor agent to invoke the right tools.
 */

import { JsonStore } from '../storage/json-store.js';
import { getConfig } from '../config.js';
import { recordAudit, insertConsensusResult, getResearchFeeds } from '../storage/index.js';
import { startResearch, storeFindings, computeConsensus } from '../research/index.js';
import { FINDINGS_JSON_SHAPE } from '../research/providers/base.js';
import type { ResearchQuery } from '../research/providers/base.js';
import type { ResearchPerspective, Finding } from '../types/index.js';
import { buildBaselinePromptSection, buildImplementationGuide, buildCleanupGuide } from '../knowledge/index.js';
import { getAgent } from '../agents/registry.js';
import { classifyTask } from '../routing/index.js';
import { checkGovernanceGate } from '../delivery/index.js';
import type {
  ResearchCase, CaseOverlayStep, CaseStatus, PHIClassification,
  ReviewArtifact, ReviewPerspective, DecisionArtifact,
  ChangeProposal, ImplementationBrief, EvaluationReport,
} from './types.js';
import { REVIEW_PERSPECTIVES } from './types.js';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let _store: JsonStore<ResearchCase> | null = null;
function store(): JsonStore<ResearchCase> {
  if (!_store) _store = new JsonStore<ResearchCase>(getConfig().storage.base_path, 'research-cases', 'case_id');
  return _store!;
}

// ---------------------------------------------------------------------------
// Case ID Generation
// ---------------------------------------------------------------------------

function generateCaseId(name: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `RC-${date}-${slug}`;
}

// ---------------------------------------------------------------------------
// Constants: Perspective → Agent mapping
// ---------------------------------------------------------------------------

const PERSPECTIVE_AGENT_MAP: Record<ReviewPerspective, { agent_id: string; sub_agents: string[] }> = {
  architecture: { agent_id: 'architect', sub_agents: ['cloud-architect-reviewer', 'simplification-reviewer'] },
  security_compliance: { agent_id: 'security_auditor', sub_agents: ['security-compliance-reviewer'] },
  ops_reliability: { agent_id: 'researcher', sub_agents: ['reliability-observability-reviewer', 'observability-sre-architect'] },
  cost_performance: { agent_id: 'test_evaluator', sub_agents: ['cost-efficiency-reviewer', 'performance-scalability-reviewer'] },
  adversarial_skeptic: { agent_id: 'architect', sub_agents: ['challenger', 'red-team-reviewer'] },
};

const REVIEW_TO_RESEARCH_PERSPECTIVE: Record<ReviewPerspective, ResearchPerspective> = {
  architecture: 'reliability',
  security_compliance: 'security',
  ops_reliability: 'reliability',
  cost_performance: 'performance',
  adversarial_skeptic: 'general',
};

// ---------------------------------------------------------------------------
// Create a new Research Case
// ---------------------------------------------------------------------------

export function createCase(input: {
  initiative_name: string;
  owner: string;
  problem_statement: string;
  goals: string[];
  non_goals?: string[];
  risk_lane: 'low' | 'medium' | 'high';
  phi_classification?: PHIClassification;
  target_consumer?: 'mcp_refinery' | 'software_agent' | 'both';
}): ResearchCase {
  const now = new Date().toISOString();
  const caseId = generateCaseId(input.initiative_name);

  const maxBudget = input.risk_lane === 'high' ? 3 : input.risk_lane === 'medium' ? 5 : 8;

  const rc: ResearchCase = {
    case_id: caseId,
    initiative_name: input.initiative_name,
    owner: input.owner,
    problem_statement: input.problem_statement,
    goals: input.goals,
    non_goals: input.non_goals ?? [],
    risk_lane: input.risk_lane,
    phi_classification: input.phi_classification ?? 'none',
    target_consumer: input.target_consumer ?? 'both',

    status: 'intake',
    current_overlay: 'intake',
    overlay_index: 0,

    intake: {
      target_system: 'mcp-refinery',
      constraints: [],
      prior_art: [],
      success_criteria: input.goals,
    },
    sources: {},
    synthesis: null,
    evidence_matrix: null,
    reviews: {},
    decision: null,
    proposal: null,
    brief: null,
    evaluation: null,
    release_notes: null,

    change_budget: { max_prs: maxBudget, max_iterations: maxBudget * 2, prs_used: 0, iterations_used: 0 },

    consensus_id: null,
    delivery_plan_id: null,
    pr_ids: [],
    release_id: null,
    deliberation_session_id: null,
    scorecard_ids: [],

    created_at: now,
    updated_at: now,
  };

  store().insert(rc);

  recordAudit('research_ops.case_created', rc.owner, 'research_case', caseId, {
    initiative_name: input.initiative_name,
    risk_lane: input.risk_lane,
    phi_classification: rc.phi_classification,
  });

  return rc;
}

// ---------------------------------------------------------------------------
// Advance a case through the pipeline
// ---------------------------------------------------------------------------

const OVERLAY_STEPS: CaseOverlayStep[] = [
  'intake', 'synthesize', 'review', 'decide', 'freeze',
  'implement', 'evaluate', 'release',
];

const OVERLAY_TO_STATUS: Record<CaseOverlayStep, CaseStatus> = {
  intake: 'intake',
  synthesize: 'synthesizing',
  review: 'reviewing',
  decide: 'deciding',
  freeze: 'frozen',
  implement: 'implementing',
  evaluate: 'evaluating',
  release: 'releasing',
};

export interface AdvanceResult {
  case_id: string;
  previous_overlay: CaseOverlayStep;
  current_overlay: CaseOverlayStep;
  status: CaseStatus;
  action_taken: string;
  needs_user_approval: boolean;
  bootstrap_prompt: string;
}

export function advanceCase(
  caseId: string,
  input?: {
    source_content?: Record<string, string>;
    user_approval?: boolean;
    synthesis?: string;
    evidence_matrix?: ResearchCase['evidence_matrix'];
    reviews?: Partial<Record<ReviewPerspective, ReviewArtifact>>;
    decision?: DecisionArtifact;
    proposal?: ChangeProposal;
    brief?: ImplementationBrief;
    evaluation?: EvaluationReport;
    release_notes?: string;
  },
): AdvanceResult | null {
  const rc = store().get(caseId);
  if (!rc) return null;

  if (rc.status === 'completed' || rc.status === 'rejected') {
    return {
      case_id: caseId,
      previous_overlay: rc.current_overlay,
      current_overlay: rc.current_overlay,
      status: rc.status,
      action_taken: `Case is already ${rc.status}. No further advancement possible.`,
      needs_user_approval: false,
      bootstrap_prompt: `Case ${caseId} is ${rc.status}. Create a new case with research_new to start a fresh research cycle.`,
    };
  }

  // Check budget
  rc.change_budget.iterations_used++;
  if (rc.change_budget.iterations_used > rc.change_budget.max_iterations) {
    rc.status = 'rejected';
    rc.updated_at = new Date().toISOString();
    store().update(caseId, rc);
    return {
      case_id: caseId,
      previous_overlay: rc.current_overlay,
      current_overlay: rc.current_overlay,
      status: 'rejected',
      action_taken: 'Change budget exhausted. Case rejected to prevent runaway iteration.',
      needs_user_approval: false,
      bootstrap_prompt: `Case ${caseId} exceeded its iteration budget (${rc.change_budget.max_iterations} max). Case has been rejected. Create a new case if the research should continue.`,
    };
  }

  const previousOverlay = rc.current_overlay;
  let actionTaken = '';
  let needsApproval = false;
  let prompt = '';

  switch (rc.current_overlay) {
    case 'intake': {
      if (input?.source_content) {
        for (const [name, content] of Object.entries(input.source_content)) {
          rc.sources[name] = content;
        }
        actionTaken = `Ingested ${Object.keys(input.source_content).length} source(s). Moving to synthesis.`;
      } else {
        actionTaken = 'Intake complete (no sources provided yet). Moving to synthesis.';
      }
      moveToNextOverlay(rc);
      prompt = buildSynthesizePrompt(rc);
      break;
    }

    case 'synthesize': {
      if (input?.source_content) {
        for (const [name, content] of Object.entries(input.source_content)) {
          rc.sources[name] = content;
        }
      }
      if (input?.synthesis) rc.synthesis = input.synthesis;
      if (input?.evidence_matrix) rc.evidence_matrix = input.evidence_matrix;

      if (!rc.synthesis) {
        actionTaken = 'Synthesis needed. Follow the structured research process below.';
        prompt = buildSynthesizePrompt(rc);
      } else {
        // Wire into the refinery's research feed store for cross-referencing
        feedEvidenceIntoResearchPlane(rc);

        actionTaken = 'Synthesis complete. Moving to unchained review.';
        moveToNextOverlay(rc);
        prompt = buildReviewPrompt(rc);
      }
      break;
    }

    case 'review': {
      if (input?.reviews) {
        for (const [perspective, review] of Object.entries(input.reviews)) {
          if (review) rc.reviews[perspective as ReviewPerspective] = review;
        }
      }

      const reviewedPerspectives = Object.keys(rc.reviews) as ReviewPerspective[];
      const missing = REVIEW_PERSPECTIVES.filter((p) => !reviewedPerspectives.includes(p));

      if (missing.length > 0) {
        actionTaken = `${reviewedPerspectives.length}/${REVIEW_PERSPECTIVES.length} reviews complete. Missing: ${missing.join(', ')}.`;
        prompt = buildReviewPrompt(rc);
      } else {
        actionTaken = 'All reviews complete. Moving to Council Chair decision.';
        moveToNextOverlay(rc);
        prompt = buildDecidePrompt(rc);
      }
      break;
    }

    case 'decide': {
      if (input?.decision) {
        rc.decision = input.decision;
        if (input.proposal) rc.proposal = input.proposal;
        if (input.brief) rc.brief = input.brief;
      }

      if (!rc.decision) {
        actionTaken = 'Council Chair needs to consolidate reviews into a decision.';
        prompt = buildDecidePrompt(rc);
      } else if (rc.decision.outcome === 'rejected') {
        rc.status = 'rejected';
        actionTaken = `Case rejected: ${rc.decision.rationale}`;
        prompt = `Case ${rc.case_id} was rejected. Rationale: ${rc.decision.rationale}. Create a new case with research_new to explore alternative approaches.`;
      } else if (rc.decision.outcome === 'deferred') {
        rc.status = 'deferred';
        actionTaken = `Case deferred: ${rc.decision.rationale}`;
        prompt = `Case ${rc.case_id} was deferred. Rationale: ${rc.decision.rationale}. It can be revisited later.`;
      } else {
        actionTaken = 'Decision accepted. Moving to proposal freeze (alignment gate).';
        moveToNextOverlay(rc);
        needsApproval = true;
        prompt = buildFreezePrompt(rc);
      }
      break;
    }

    case 'freeze': {
      if (!input?.user_approval) {
        needsApproval = true;
        actionTaken = 'Alignment gate: proposal frozen. Awaiting user approval to proceed with implementation.';
        prompt = buildFreezePrompt(rc);
      } else {
        // Freeze the proposal
        if (rc.proposal && !rc.proposal.frozen) {
          rc.proposal.frozen = true;
          rc.proposal.frozen_at = new Date().toISOString();
        }

        // Wire to governance system
        const gate = checkGovernanceGate('proposal', caseId, 'self', rc.risk_lane);
        actionTaken = gate.allowed
          ? 'User approved. Proposal frozen. Governance gate passed. Moving to implementation.'
          : 'User approved. Proposal frozen. Moving to implementation (governance: advisory).';

        moveToNextOverlay(rc);
        prompt = buildImplementPrompt(rc);

        recordAudit('research_ops.proposal_frozen', rc.owner, 'research_case', caseId, {
          proposal_title: rc.proposal?.title ?? 'unknown',
          governance_allowed: gate.allowed,
          governance_reason: gate.reason,
        });
      }
      break;
    }

    case 'implement': {
      actionTaken = 'Implementation phase. Execute from the frozen proposal contract.';
      moveToNextOverlay(rc);
      prompt = buildEvaluatePrompt(rc);
      break;
    }

    case 'evaluate': {
      if (input?.evaluation) {
        rc.evaluation = input.evaluation;
      }

      if (!rc.evaluation) {
        actionTaken = 'Evaluation needed. Run tests, scorecards, and policy checks.';
        prompt = buildEvaluatePrompt(rc);
      } else if (!rc.evaluation.overall_pass) {
        actionTaken = 'Evaluation FAILED. Review failures and decide next steps.';
        needsApproval = true;
        prompt = `Evaluation failed for case ${rc.case_id}. Failures:\n${rc.evaluation.policy_checks.filter((c) => !c.passed).map((c) => `- ${c.check}: ${c.notes}`).join('\n')}\n\nApprove to continue to release anyway, or reject to stop.`;
      } else {
        actionTaken = 'Evaluation passed. Moving to release.';
        moveToNextOverlay(rc);
        prompt = buildReleasePrompt(rc);
      }
      break;
    }

    case 'release': {
      if (input?.release_notes) {
        rc.release_notes = input.release_notes;
      }
      rc.status = 'completed';
      actionTaken = 'Case completed. Research institutionalized.';
      prompt = buildReleaseCompletionPrompt(rc);

      recordAudit('research_ops.case_completed', rc.owner, 'research_case', caseId, {
        initiative_name: rc.initiative_name,
        decision_outcome: rc.decision?.outcome ?? 'unknown',
        consensus_id: rc.consensus_id,
        delivery_plan_id: rc.delivery_plan_id,
        release_id: rc.release_id,
      });
      break;
    }
  }

  rc.updated_at = new Date().toISOString();
  store().update(caseId, rc);

  recordAudit('research_ops.case_advanced', 'system', 'research_case', caseId, {
    from_overlay: previousOverlay,
    to_overlay: rc.current_overlay,
    status: rc.status,
  });

  return {
    case_id: caseId,
    previous_overlay: previousOverlay,
    current_overlay: rc.current_overlay,
    status: rc.status,
    action_taken: actionTaken,
    needs_user_approval: needsApproval,
    bootstrap_prompt: prompt,
  };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export function getCase(caseId: string): ResearchCase | null {
  return store().get(caseId);
}

export function listCases(filter?: (rc: ResearchCase) => boolean): ResearchCase[] {
  return store().list(filter);
}

export function consultCase(caseId: string, question: string, artifact?: string): {
  answer: string;
  relevant_artifacts: string[];
  case_status: CaseStatus;
} {
  const rc = store().get(caseId);
  if (!rc) return { answer: `Case ${caseId} not found.`, relevant_artifacts: [], case_status: 'rejected' };

  const artifacts: string[] = [];
  const parts: string[] = [];

  parts.push(`## Case: ${rc.initiative_name} (${rc.case_id})`);
  parts.push(`Status: ${rc.status} | Overlay: ${rc.current_overlay} | Risk: ${rc.risk_lane}`);
  if (rc.consensus_id) parts.push(`Consensus: ${rc.consensus_id}`);
  if (rc.delivery_plan_id) parts.push(`Delivery plan: ${rc.delivery_plan_id}`);
  if (rc.release_id) parts.push(`Release: ${rc.release_id}`);
  parts.push('');

  if (!artifact || artifact === 'intake') {
    if (rc.intake) {
      parts.push(`### Intake`);
      parts.push(`Target: ${rc.intake.target_system}`);
      parts.push(`Constraints: ${rc.intake.constraints.join(', ') || 'none'}`);
      parts.push(`Goals: ${rc.goals.join('; ')}`);
      artifacts.push('intake');
    }
  }

  if (!artifact || artifact === 'synthesis') {
    if (rc.synthesis) {
      parts.push(`### Synthesis`);
      parts.push(rc.synthesis.slice(0, 2000));
      artifacts.push('synthesis');
    }
  }

  if (!artifact || artifact === 'evidence_matrix') {
    if (rc.evidence_matrix && rc.evidence_matrix.length > 0) {
      parts.push(`### Evidence Matrix (${rc.evidence_matrix.length} claims)`);
      for (const e of rc.evidence_matrix.slice(0, 10)) {
        parts.push(`- **${e.claim}** (confidence: ${e.confidence}) — For: ${e.evidence_for.length}, Against: ${e.evidence_against.length}`);
      }
      artifacts.push('evidence_matrix');
    }
  }

  if (!artifact || artifact === 'reviews') {
    const reviewEntries = Object.entries(rc.reviews);
    if (reviewEntries.length > 0) {
      parts.push(`### Reviews (${reviewEntries.length}/${REVIEW_PERSPECTIVES.length})`);
      for (const [perspective, review] of reviewEntries) {
        if (review) {
          parts.push(`- **${perspective}**: ${review.verdict} (confidence: ${review.confidence})`);
          if (review.required_changes.length > 0) parts.push(`  Required: ${review.required_changes.join('; ')}`);
        }
      }
      artifacts.push('reviews');
    }
  }

  if (!artifact || artifact === 'decision') {
    if (rc.decision) {
      parts.push(`### Decision`);
      parts.push(`Outcome: ${rc.decision.outcome}`);
      parts.push(`Rationale: ${rc.decision.rationale}`);
      if (rc.decision.not_adopted.length > 0) parts.push(`Not adopted: ${rc.decision.not_adopted.join('; ')}`);
      artifacts.push('decision');
    }
  }

  if (!artifact || artifact === 'proposal') {
    if (rc.proposal) {
      parts.push(`### Change Proposal${rc.proposal.frozen ? ' (FROZEN)' : ''}`);
      parts.push(`Title: ${rc.proposal.title}`);
      parts.push(`Scope: ${rc.proposal.scope.join('; ')}`);
      parts.push(`Changes: ${rc.proposal.changes.length}`);
      for (const c of rc.proposal.changes) {
        parts.push(`- ${c.component}: ${c.description} (~${c.estimated_loc} LOC, ${c.risk_level} risk)`);
      }
      artifacts.push('proposal');
    }
  }

  if (!artifact || artifact === 'brief') {
    if (rc.brief) {
      parts.push(`### Implementation Brief`);
      parts.push(`ACs: ${rc.brief.acceptance_criteria.length}`);
      parts.push(`Tests: ${rc.brief.test_requirements.length}`);
      parts.push(`Rollback: ${rc.brief.rollback_plan}`);
      artifacts.push('brief');
    }
  }

  if (!artifact || artifact === 'evaluation') {
    if (rc.evaluation) {
      parts.push(`### Evaluation`);
      parts.push(`Overall: ${rc.evaluation.overall_pass ? 'PASS' : 'FAIL'}`);
      parts.push(`Tests: ${rc.evaluation.test_results.length} suites`);
      parts.push(`Policy: ${rc.evaluation.policy_checks.filter((c) => c.passed).length}/${rc.evaluation.policy_checks.length} passed`);
      artifacts.push('evaluation');
    }
  }

  if (!artifact || artifact === 'release_notes') {
    if (rc.release_notes) {
      parts.push(`### Release Notes`);
      parts.push(rc.release_notes.slice(0, 1000));
      artifacts.push('release_notes');
    }
  }

  parts.push('');
  parts.push(`**Question**: ${question}`);
  parts.push('');
  parts.push('Use the artifact data above to answer the question. If the answer requires artifacts not yet produced, indicate which overlay step would generate them.');

  return {
    answer: parts.join('\n'),
    relevant_artifacts: artifacts,
    case_status: rc.status,
  };
}

// ---------------------------------------------------------------------------
// Internal: Feed evidence into the refinery's research plane
// ---------------------------------------------------------------------------

function feedEvidenceIntoResearchPlane(rc: ResearchCase): void {
  if (!rc.evidence_matrix || rc.evidence_matrix.length === 0) return;

  const findings: Finding[] = rc.evidence_matrix.map((entry) => ({
    claim: entry.claim,
    recommendation: entry.evidence_for[0] ?? 'See evidence matrix for details',
    expected_impact: {
      reliability: entry.confidence * 0.5,
      security: 0,
      devex: entry.confidence * 0.3,
      performance: 0,
    },
    risk: {
      level: (entry.confidence < 0.4 ? 'high' : entry.confidence < 0.7 ? 'medium' : 'low') as 'low' | 'medium' | 'high',
      notes: `Confidence: ${entry.confidence}. For: ${entry.evidence_for.length}, Against: ${entry.evidence_against.length}`,
    },
    evidence: entry.source_refs.map((ref) => ({
      type: 'quote' as const,
      value: ref,
      quality: 'B' as const,
    })),
  }));

  try {
    const feedEntry = storeFindings(rc.case_id, 'general', `case:${rc.case_id}`, findings);

    // Compute consensus from all feeds for this case
    const feeds = getResearchFeeds(rc.case_id);
    if (feeds.length > 0) {
      const consensus = computeConsensus(feeds, rc.case_id);
      insertConsensusResult(consensus);
      rc.consensus_id = consensus.consensus_id;
    }
  } catch {
    // Non-fatal: case continues even if cross-referencing fails
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function moveToNextOverlay(rc: ResearchCase): void {
  rc.overlay_index++;
  if (rc.overlay_index >= OVERLAY_STEPS.length) {
    rc.status = 'completed';
    rc.current_overlay = 'release';
  } else {
    rc.current_overlay = OVERLAY_STEPS[rc.overlay_index];
    rc.status = OVERLAY_TO_STATUS[rc.current_overlay];
  }
}

function buildSourceContext(rc: ResearchCase): string {
  const sourceNames = Object.keys(rc.sources);
  if (sourceNames.length === 0) return '';
  return sourceNames.map((name) => {
    const content = rc.sources[name];
    return `Source "${name}" (${content.length} chars): ${content.slice(0, 500)}...`;
  }).join('\n');
}

function buildResearchQuery(rc: ResearchCase): ResearchQuery {
  return {
    target_server_id: rc.case_id,
    server_name: rc.initiative_name,
    server_description: rc.problem_statement,
    current_tools: [],
    current_resources: [],
    transport: 'stdio',
    auth_mode: 'none',
    focus_areas: rc.goals,
    additional_context: [
      `Research Case: ${rc.case_id}`,
      `Risk lane: ${rc.risk_lane}`,
      `Goals: ${rc.goals.join('; ')}`,
      rc.non_goals.length > 0 ? `Non-goals: ${rc.non_goals.join('; ')}` : '',
      buildSourceContext(rc),
    ].filter(Boolean).join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Bootstrap Prompt Builders — wired to refinery subsystems
// ---------------------------------------------------------------------------

function buildSynthesizePrompt(rc: ResearchCase): string {
  // Generate structured research prompts via the refinery's research engine
  const perspectives: ResearchPerspective[] = ['security', 'reliability', 'devex', 'performance', 'general'];
  const query = buildResearchQuery(rc);
  const researchResult = startResearch(query, perspectives);

  const sourceNames = Object.keys(rc.sources);
  const sourceList = sourceNames.length > 0
    ? sourceNames.map((name) => `- **${name}**: ${rc.sources[name].slice(0, 300)}...`).join('\n')
    : '_No sources ingested yet. You can add sources via research_advance with source_content._';

  const baselineSection = buildBaselinePromptSection([
    'architecture', 'governance', 'devex', 'reliability', 'security', 'maintenance',
  ]);

  // Classify the task for model routing context
  const classification = classifyTask({
    description: rc.problem_statement,
    is_architectural: rc.goals.some((g) => /architect|design|structure|pattern/i.test(g)),
    touches_security: rc.goals.some((g) => /security|auth|encrypt|secret/i.test(g)),
    risk_level: rc.risk_lane as 'low' | 'medium' | 'high',
  });

  return `## Research Synthesis for Case ${rc.case_id}
**"${rc.initiative_name}"**

### Problem Statement
${rc.problem_statement}

### Goals
${rc.goals.map((g, i) => `${i + 1}. ${g}`).join('\n')}
${rc.non_goals.length > 0 ? `\n### Non-Goals\n${rc.non_goals.map((g) => `- ${g}`).join('\n')}` : ''}

### Risk Lane: ${rc.risk_lane} | PHI: ${rc.phi_classification}
### Task Classification: complexity=${classification.complexity}, tier=${classification.recommended_tier}${classification.requires_multi_model ? ' (multi-model recommended)' : ''}

### Ingested Sources
${sourceList}

---

## Step 1: Deep Research via Sub-Agents

Before synthesizing, gather additional evidence by invoking these **cursor-context-layer** sub-agents in parallel:

1. **Web Research** — External best practices, prior art, industry standards:
   \`run_agent(agent_name="web-search-researcher", prompt="Research best practices and prior art for: ${rc.problem_statement.slice(0, 200)}. Focus on: ${rc.goals.slice(0, 3).join('; ')}")\`

2. **Codebase Analysis** — Current implementation state and gaps:
   \`run_agent(agent_name="codebase-analyzer", prompt="Analyze how the codebase currently handles: ${rc.problem_statement.slice(0, 200)}. Identify gaps, strengths, and patterns.")\`

3. **Prior Research** — Check .thoughts/ for related prior work:
   \`run_agent(agent_name="thoughts-analyzer", prompt="Find any prior research, decisions, or notes related to: ${rc.initiative_name}")\`

## Step 2: Process Structured Research Prompts

The refinery has generated ${researchResult.prompts.length} perspective-specific research prompts with baseline quality patterns. Process each one:

${researchResult.prompts.map((p, i) => `### Prompt ${i + 1}: ${p.perspective} perspective (hash: ${p.prompt_hash})
${p.prompt.slice(0, 600)}...
`).join('\n')}

## Step 3: Synthesize All Evidence

Combine the sub-agent research + structured prompt analysis + ingested sources into:

1. **Synthesis**: A rigorous analysis (not a summary) that identifies:
   - What the evidence strongly supports
   - What the evidence contradicts
   - Where critical gaps remain
   - Novel insights that emerge from cross-referencing sources

2. **Evidence Matrix**: Structured claims with supporting/opposing evidence.

${baselineSection}

## Output

Call **research_advance** with:
- case_id="${rc.case_id}"
- synthesis: "<your rigorous synthesis>"
- evidence_matrix: [{ claim: "...", evidence_for: ["..."], evidence_against: ["..."], confidence: 0.0-1.0, source_refs: ["..."] }]

The evidence matrix feeds into the refinery's consensus algorithm for cross-perspective agreement scoring.`;
}

function buildReviewPrompt(rc: ResearchCase): string {
  const reviewed = Object.keys(rc.reviews) as ReviewPerspective[];
  const missing = REVIEW_PERSPECTIVES.filter((p) => !reviewed.includes(p));

  const reviewInstructions = missing.map((perspective) => {
    const mapping = PERSPECTIVE_AGENT_MAP[perspective];
    const agent = getAgent(mapping.agent_id);
    const researchPerspective = REVIEW_TO_RESEARCH_PERSPECTIVE[perspective];

    const baselineCategories = {
      architecture: ['architecture', 'governance'] as const,
      security_compliance: ['security', 'governance'] as const,
      ops_reliability: ['reliability', 'architecture'] as const,
      cost_performance: ['devex', 'reliability'] as const,
      adversarial_skeptic: ['architecture', 'security', 'reliability'] as const,
    }[perspective];

    const baselineSection = buildBaselinePromptSection([...baselineCategories]);

    return `### ${perspective} Review
**Agent**: ${agent?.name ?? 'Unknown'} (${agent?.agent_id ?? 'none'}) | **Tier**: ${agent?.preferred_tier ?? 'workhorse'}
${agent ? `**System Prompt**: ${agent.system_prompt}` : ''}

**Evaluate against these baselines**:
${baselineSection}

**For deeper analysis**, invoke cursor-context-layer sub-agents:
${mapping.sub_agents.map((sa) => `- \`run_agent(agent_name="${sa}", prompt="Review from ${perspective} perspective: ${rc.problem_statement.slice(0, 150)}")\``).join('\n')}

**Output required** for this perspective:
\`\`\`json
{
  "perspective": "${perspective}",
  "verdict": "approve | approve_with_conditions | reject | defer",
  "required_changes": ["specific actionable changes"],
  "recommendations": ["non-blocking suggestions"],
  "risks": ["identified risks with severity"],
  "confidence": 0.0-1.0,
  "reviewed_at": "<ISO timestamp>"
}
\`\`\``;
  });

  const synthesisContext = rc.synthesis ? `\n### Synthesis (context for reviewers)\n${rc.synthesis.slice(0, 2000)}` : '';
  const evidenceContext = rc.evidence_matrix && rc.evidence_matrix.length > 0
    ? `\n### Evidence Matrix (${rc.evidence_matrix.length} claims)\n${rc.evidence_matrix.slice(0, 5).map((e) => `- **${e.claim}** (confidence: ${e.confidence})`).join('\n')}`
    : '';

  return `## Unchained Review Board for Case ${rc.case_id}
**"${rc.initiative_name}"**

Reviews completed: ${reviewed.length}/${REVIEW_PERSPECTIVES.length} (${reviewed.join(', ') || 'none'})
Reviews needed: **${missing.join(', ')}**

### Rules
- Each reviewer writes an **INDEPENDENT** verdict — do NOT coordinate between perspectives
- Reviewers do NOT mutate proposal text — only assess and recommend
- Each review must include required_changes (blocking) and recommendations (non-blocking)
- Confidence < 0.5 triggers automatic escalation to human review
${synthesisContext}
${evidenceContext}

---

${reviewInstructions.join('\n\n---\n\n')}

---

## Submit Reviews

Call **research_advance** with case_id="${rc.case_id}" and reviews containing ALL missing perspectives:
\`\`\`
reviews: {
${missing.map((p) => `  "${p}": { perspective, verdict, required_changes, recommendations, risks, confidence, reviewed_at }`).join(',\n')}
}
\`\`\``;
}

function buildDecidePrompt(rc: ResearchCase): string {
  const reviewSummary = Object.entries(rc.reviews)
    .map(([p, r]) => {
      if (!r) return '';
      const required = r.required_changes.length > 0
        ? `\n    Required changes: ${r.required_changes.join('; ')}`
        : '';
      const risks = r.risks.length > 0
        ? `\n    Risks: ${r.risks.join('; ')}`
        : '';
      return `  - **${p}**: ${r.verdict} (confidence: ${r.confidence})${required}${risks}`;
    })
    .filter(Boolean)
    .join('\n');

  const useDeliberation = rc.risk_lane === 'high';

  const deliberationSection = useDeliberation
    ? `
### Multi-Model Deliberation (REQUIRED for high-risk cases)

This case is **high risk**. Use the refinery's deliberation system for the Council Chair decision:

1. Call **deliberation_start** with:
   - problem_statement: "Council Chair decision for case ${rc.case_id}: ${rc.initiative_name}"
   - context: "<include all review verdicts and evidence matrix below>"

2. Two architect-tier models will independently analyze the reviews
3. If they agree → proceed with the consensus decision
4. If they disagree → the conflict escalates to the user for resolution

After deliberation resolves, store the session_id in your decision.
`
    : `
### Single-Model Decision (${rc.risk_lane} risk)

Consolidate all reviews into a coherent decision. Weight required_changes heavily — they represent blocking issues that must be addressed.
`;

  return `## Council Chair Decision for Case ${rc.case_id}
**"${rc.initiative_name}"** | Risk: ${rc.risk_lane}

### Review Verdicts
${reviewSummary}

${deliberationSection}

### Decision Requirements

Produce THREE artifacts:

**1. Decision** — The ruling:
- outcome: accepted | rejected | deferred
- rationale: Clear justification citing specific review findings
- not_adopted: Ideas explicitly rejected (REQUIRED — prevents re-litigation)
- conditions: Conditions that must be met for acceptance
- decided_at: ISO timestamp

**2. Change Proposal** — The frozen scope contract:
- title: Descriptive title
- scope: What IS included (explicit boundary)
- out_of_scope: What is NOT included (prevents scope creep)
- changes: [{ component, description, estimated_loc, risk_level }]
- frozen: false (freezing happens at the next gate)

**3. Implementation Brief** — The execution guide:
- acceptance_criteria: Measurable, testable criteria
- non_functional_requirements: Performance, security, reliability NFRs
- test_requirements: Specific tests to write
- rollout_plan: How to deploy safely
- rollback_plan: How to revert if something goes wrong
- telemetry_requirements: What to measure
- change_budget: { max_prs, max_iterations }

### Submit

Call **research_advance** with case_id="${rc.case_id}" and include decision, proposal, and brief.`;
}

function buildFreezePrompt(rc: ResearchCase): string {
  const proposalSummary = rc.proposal
    ? `**Title**: ${rc.proposal.title}
**Scope**: ${rc.proposal.scope.join('; ')}
**Out of Scope**: ${rc.proposal.out_of_scope.join('; ')}
**Changes**:
${rc.proposal.changes.map((c) => `- ${c.component}: ${c.description} (~${c.estimated_loc} LOC, ${c.risk_level} risk)`).join('\n')}`
    : '_No proposal generated yet._';

  const briefSummary = rc.brief
    ? `**Acceptance Criteria**:
${rc.brief.acceptance_criteria.map((ac) => `- ${ac}`).join('\n')}
**Rollback Plan**: ${rc.brief.rollback_plan}`
    : '';

  return `## Alignment Gate — Proposal Freeze

**Case**: ${rc.case_id} ("${rc.initiative_name}")
**Decision**: ${rc.decision?.outcome ?? 'pending'}
**Risk Lane**: ${rc.risk_lane}

### Proposed Changes
${proposalSummary}

${briefSummary ? `### Implementation Brief\n${briefSummary}\n` : ''}
### Governance

This proposal requires governance approval before implementation proceeds. The refinery's governance system evaluates:
- Autonomy level for the target server
- Risk level vs. approval requirements
- Change budget constraints

After user approval, call **governance_approve** with:
- target_type: "proposal"
- target_id: "${rc.case_id}"
- approved_by: "<your identity>"
- risk_acknowledged: true
- rollback_plan_acknowledged: true

### What Happens Next

If approved:
1. The proposal becomes **FROZEN** (immutable)
2. Implementation proceeds strictly from this contract
3. Any scope change requires a **new case**
4. The governance approval is recorded in the audit trail

**Do you approve this proposal?** Call **research_advance** with case_id="${rc.case_id}" and user_approval=true to proceed.`;
}

function buildImplementPrompt(rc: ResearchCase): string {
  const implGuide = buildImplementationGuide();

  const proposalScope = rc.proposal
    ? rc.proposal.changes.map((c) => `- **${c.component}**: ${c.description} (~${c.estimated_loc} LOC, ${c.risk_level} risk)`).join('\n')
    : '_No frozen proposal available._';

  const briefSection = rc.brief
    ? `### Acceptance Criteria
${rc.brief.acceptance_criteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')}

### Non-Functional Requirements
${rc.brief.non_functional_requirements.map((nfr) => `- ${nfr}`).join('\n')}

### Test Requirements
${rc.brief.test_requirements.map((t) => `- ${t}`).join('\n')}

### Rollout Plan
${rc.brief.rollout_plan}

### Rollback Plan
${rc.brief.rollback_plan}

### Telemetry Requirements
${rc.brief.telemetry_requirements.map((t) => `- ${t}`).join('\n')}`
    : '_No implementation brief available._';

  return `## Implementation Phase for Case ${rc.case_id}
**"${rc.initiative_name}"** | Frozen Proposal: ${rc.proposal?.title ?? 'unknown'}

### Frozen Scope (DO NOT EXCEED)
${proposalScope}

${briefSection}

### Delivery Pipeline Integration

Use the refinery's delivery pipeline for structured implementation:

1. **Create a delivery plan**:
   Call **delivery_plan** with:
   - target_server_id: "self"
   - proposal_ids: ["${rc.case_id}"]

2. **Create PR(s)** for each change:
   Call **delivery_create_pr** with:
   - plan_id: <from delivery_plan>
   - proposal_ids: ["${rc.case_id}"]
   - repo_url: "<repository URL>"
   - changes_summary: "<description of changes>"

3. Track PR IDs for the evaluation phase.

### Change Budget
- Max PRs: ${rc.change_budget.max_prs} (used: ${rc.change_budget.prs_used})
- Max iterations: ${rc.change_budget.max_iterations} (used: ${rc.change_budget.iterations_used})

### Implementation Standards
${implGuide.slice(0, 1500)}

### IMPORTANT
- Apply changes ONLY within the frozen scope
- Defer everything else to the next iteration backlog
- Every change must be testable against the acceptance criteria
- Record the delivery_plan_id and pr_ids for cross-referencing

### Post-Implementation Cleanup (REQUIRED before advancing)

After implementing all changes, run a cleanup pass BEFORE calling research_advance.
${buildCleanupGuide().slice(0, 2000)}

Call **research_advance** with case_id="${rc.case_id}" after implementation AND cleanup are complete.`;
}

function buildEvaluatePrompt(rc: ResearchCase): string {
  const acList = rc.brief
    ? rc.brief.acceptance_criteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')
    : '_No acceptance criteria defined._';

  const testReqs = rc.brief
    ? rc.brief.test_requirements.map((t) => `- ${t}`).join('\n')
    : '_No test requirements defined._';

  return `## Evaluation Phase for Case ${rc.case_id}
**"${rc.initiative_name}"**

### Acceptance Criteria to Verify
${acList}

### Required Tests
${testReqs}

### Scorecard Integration

Use the refinery's scorecard system for multi-dimensional quality measurement:

Call **decision_capture_scorecard** with:
- target_server_id: "self"
- protocol_compliance: { valid_tool_schemas, total_tools, valid_resource_uris, total_resources, transport_hardened, auth_implemented, structured_output_usage, error_handling_coverage }
- testing: { test_pass_rate, test_coverage, protocol_test_coverage, integration_test_count }
- security: { secrets_scan_clean, dependency_vulnerabilities, input_validation_coverage, auth_bypass_tests, owasp_llm_compliance }
- reliability: { error_rate, p95_latency_ms, p99_latency_ms, uptime_percent }
- governance: { policy_violations, failed_approvals, audit_completeness, adr_coverage }

If a baseline scorecard exists, compare the new scorecard against it to verify **monotonic improvement** on primary metrics.

### Cleanup Verification (REQUIRED as part of evaluation)

Before producing the evaluation report, run a cleanup verification to catch any
orphaned or misaligned artifacts left by implementation:

- **Orphaned files**: Trace imports from entry point — any unreachable .ts files?
- **Dead exports**: Check facade index.ts files — any re-exports to removed modules?
- **Stale build output**: Any .js/.d.ts in dist/ without a corresponding source file?
- **Unused imports**: Any imports in modified files that are no longer referenced?
- **Cross-module misalignment**: Do function signatures match between callers and implementations?
- **Documentation sync**: Do README tool listings match registered tools in code?

Fix any issues found BEFORE producing the evaluation report.

### Evaluation Report

Produce a comprehensive evaluation:

1. **Test Results**: Run tests and record pass/fail per suite
2. **Policy Checks**: Verify permissions, tool restrictions, secrets, PHI compliance
3. **Stability Checks**: Timeout handling, error handling, backward compatibility
4. **Cleanup Results**: Orphaned files found, dead exports fixed, stale artifacts removed
5. **Risks**: Known risks with severity and mitigation

Call **research_advance** with case_id="${rc.case_id}" and:
\`\`\`json
{
  "evaluation": {
    "test_results": [{ "suite": "...", "passed": true, "total": 10, "passed_count": 10, "failed_count": 0 }],
    "policy_checks": [{ "check": "...", "passed": true, "notes": "..." }],
    "stability_checks": [{ "check": "...", "passed": true, "notes": "..." }],
    "risks": [{ "risk": "...", "severity": "...", "mitigation": "..." }],
    "overall_pass": true,
    "evaluated_at": "<ISO timestamp>"
  }
}
\`\`\``;
}

function buildReleasePrompt(rc: ResearchCase): string {
  const changesSummary = rc.proposal
    ? rc.proposal.changes.map((c) => `- ${c.component}: ${c.description}`).join('\n')
    : '_No changes to release._';

  const evalSummary = rc.evaluation
    ? `Tests: ${rc.evaluation.test_results.length} suites, ${rc.evaluation.policy_checks.filter((c) => c.passed).length}/${rc.evaluation.policy_checks.length} policies passed`
    : '_No evaluation data._';

  return `## Release Phase for Case ${rc.case_id}
**"${rc.initiative_name}"**

### Changes Implemented
${changesSummary}

### Evaluation Status
${evalSummary}

### Release via Delivery Pipeline

Use the refinery's release system for semantic versioning:

1. **Create release**:
   Call **delivery_release** with:
   - target_server_id: "self"
   - plan_id: "${rc.delivery_plan_id ?? '<delivery plan ID>'}"
   - pr_ids: ${JSON.stringify(rc.pr_ids.length > 0 ? rc.pr_ids : ['<PR IDs from implementation>'])}
   - version_bump: "${rc.risk_lane === 'high' ? 'major' : rc.proposal && rc.proposal.changes.length > 3 ? 'minor' : 'patch'}"

2. **Check cross-server propagation**:
   If the improvements from this case apply universally to other managed servers,
   call **search_similar** with a description of the improvement to find related past decisions.
   Flag any findings for cross-server propagation.

### Generate Release Notes

Include:
- What changed and why (reference the case decision rationale)
- Migration notes if applicable
- Breaking changes (if version_bump is "major")
- Links to PRs and delivery plan

Call **research_advance** with case_id="${rc.case_id}" and release_notes="<content>".`;
}

function buildReleaseCompletionPrompt(rc: ResearchCase): string {
  return `Case ${rc.case_id} ("${rc.initiative_name}") is **complete**.

### Summary
- **Decision**: ${rc.decision?.outcome ?? 'unknown'}
- **Changes**: ${rc.proposal?.changes.length ?? 0} components modified
- **Evaluation**: ${rc.evaluation?.overall_pass ? 'PASSED' : 'FAILED or not evaluated'}
- **Consensus ID**: ${rc.consensus_id ?? 'none'}
- **Delivery Plan**: ${rc.delivery_plan_id ?? 'none'}
- **Release**: ${rc.release_id ?? 'none'}

### What's Institutionalized
The research findings, decision rationale, and "Not Adopted" list are permanently recorded.
Future cases can query this case via **research_consult** to avoid re-litigating settled decisions.

### Next Steps
- Use **research_status** to review the full case
- Use **research_consult** with case_id="${rc.case_id}" to query specific artifacts
- Create a new case with **research_new** for the next research cycle`;
}
