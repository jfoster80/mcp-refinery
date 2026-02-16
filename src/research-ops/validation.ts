/**
 * Deterministic validation for Research Cases.
 *
 * Checks structure, PHI policy, review completeness, scope freeze,
 * acceptance criteria, and more. Runs without LLM — pure logic.
 */

import type {
  ResearchCase, ValidationResult, ValidationCheck,
  ReviewPerspective,
} from './types.js';
import { REVIEW_PERSPECTIVES } from './types.js';

export function validateCase(rc: ResearchCase): ValidationResult {
  const checks: ValidationCheck[] = [];

  // Structure checks
  checks.push(checkCaseId(rc));
  checks.push(checkIntake(rc));
  checks.push(checkPHIPolicy(rc));
  checks.push(checkRiskLane(rc));
  checks.push(checkGoals(rc));

  // Overlay-dependent checks
  if (rc.overlay_index >= 1) checks.push(checkSources(rc));
  if (rc.overlay_index >= 2) checks.push(checkSynthesis(rc));
  if (rc.overlay_index >= 3) checks.push(checkReviews(rc));
  if (rc.overlay_index >= 4) checks.push(checkDecision(rc));
  if (rc.overlay_index >= 5) checks.push(checkProposalFreeze(rc));
  if (rc.overlay_index >= 6) checks.push(checkBrief(rc));
  if (rc.overlay_index >= 7) checks.push(checkEvaluation(rc));

  // Budget checks (always)
  checks.push(checkChangeBudget(rc));

  const passed = checks.every((c) => c.severity !== 'error' || c.passed);

  return {
    case_id: rc.case_id,
    passed,
    checks,
    validated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Individual Checks
// ---------------------------------------------------------------------------

function checkCaseId(rc: ResearchCase): ValidationCheck {
  const valid = /^RC-\d{8}-.+$/.test(rc.case_id);
  return {
    name: 'case_id_format',
    passed: valid,
    message: valid ? 'Case ID follows RC-YYYYMMDD-slug format.' : `Invalid case ID format: ${rc.case_id}`,
    severity: 'error',
  };
}

function checkIntake(rc: ResearchCase): ValidationCheck {
  const hasIntake = rc.intake !== null && rc.intake.target_system.length > 0;
  return {
    name: 'intake_complete',
    passed: hasIntake,
    message: hasIntake ? 'Intake artifact present.' : 'Missing intake artifact or target system.',
    severity: 'error',
  };
}

function checkPHIPolicy(rc: ResearchCase): ValidationCheck {
  if (rc.phi_classification === 'none') {
    return { name: 'phi_policy', passed: true, message: 'PHI classification: none. External LLM ingestion allowed.', severity: 'info' };
  }
  const hasExternalSources = Object.keys(rc.sources).some((k) =>
    ['chatgpt', 'gemini', 'grok', 'external'].some((ext) => k.toLowerCase().includes(ext)),
  );
  if (hasExternalSources) {
    return {
      name: 'phi_policy',
      passed: false,
      message: `PHI classification is "${rc.phi_classification}" but external LLM sources detected. External sources must not be used when PHI is involved.`,
      severity: 'error',
    };
  }
  return { name: 'phi_policy', passed: true, message: `PHI classification: ${rc.phi_classification}. No external LLM sources detected.`, severity: 'info' };
}

function checkRiskLane(rc: ResearchCase): ValidationCheck {
  const valid = ['low', 'medium', 'high'].includes(rc.risk_lane);
  return {
    name: 'risk_lane',
    passed: valid,
    message: valid ? `Risk lane: ${rc.risk_lane}` : 'Invalid risk lane.',
    severity: 'error',
  };
}

function checkGoals(rc: ResearchCase): ValidationCheck {
  const hasGoals = rc.goals.length > 0;
  return {
    name: 'goals_defined',
    passed: hasGoals,
    message: hasGoals ? `${rc.goals.length} goal(s) defined.` : 'No goals defined.',
    severity: 'error',
  };
}

function checkSources(rc: ResearchCase): ValidationCheck {
  const hasSources = Object.keys(rc.sources).length > 0;
  return {
    name: 'sources_present',
    passed: hasSources,
    message: hasSources ? `${Object.keys(rc.sources).length} source(s) ingested.` : 'No sources ingested yet.',
    severity: 'warning',
  };
}

function checkSynthesis(rc: ResearchCase): ValidationCheck {
  const hasSynthesis = rc.synthesis !== null && rc.synthesis.length > 0;
  return {
    name: 'synthesis_complete',
    passed: hasSynthesis,
    message: hasSynthesis ? 'Synthesis artifact present.' : 'Synthesis not yet generated.',
    severity: rc.overlay_index >= 2 ? 'error' : 'warning',
  };
}

function checkReviews(rc: ResearchCase): ValidationCheck {
  const reviewed = Object.keys(rc.reviews) as ReviewPerspective[];
  const missing = REVIEW_PERSPECTIVES.filter((p) => !reviewed.includes(p));
  const allDone = missing.length === 0;
  return {
    name: 'reviews_complete',
    passed: allDone,
    message: allDone
      ? `All ${REVIEW_PERSPECTIVES.length} reviews complete.`
      : `${reviewed.length}/${REVIEW_PERSPECTIVES.length} reviews. Missing: ${missing.join(', ')}.`,
    severity: rc.overlay_index >= 3 ? 'error' : 'warning',
  };
}

function checkDecision(rc: ResearchCase): ValidationCheck {
  const hasDecision = rc.decision !== null;
  return {
    name: 'decision_recorded',
    passed: hasDecision,
    message: hasDecision ? `Decision: ${rc.decision!.outcome}` : 'No decision recorded.',
    severity: rc.overlay_index >= 4 ? 'error' : 'warning',
  };
}

function checkProposalFreeze(rc: ResearchCase): ValidationCheck {
  if (!rc.proposal) {
    return { name: 'proposal_frozen', passed: false, message: 'No proposal to freeze.', severity: 'error' };
  }
  return {
    name: 'proposal_frozen',
    passed: rc.proposal.frozen,
    message: rc.proposal.frozen ? `Proposal frozen at ${rc.proposal.frozen_at}.` : 'Proposal not yet frozen. Awaiting alignment gate approval.',
    severity: rc.overlay_index >= 5 ? 'error' : 'warning',
  };
}

function checkBrief(rc: ResearchCase): ValidationCheck {
  if (!rc.brief) {
    return { name: 'implementation_brief', passed: false, message: 'No implementation brief.', severity: 'error' };
  }
  const hasACs = rc.brief.acceptance_criteria.length > 0;
  const hasTests = rc.brief.test_requirements.length > 0;
  const hasRollback = rc.brief.rollback_plan.length > 0;
  const allGood = hasACs && hasTests && hasRollback;
  return {
    name: 'implementation_brief',
    passed: allGood,
    message: allGood
      ? `Brief complete: ${rc.brief.acceptance_criteria.length} ACs, ${rc.brief.test_requirements.length} tests, rollback plan present.`
      : `Brief incomplete: ACs=${hasACs}, tests=${hasTests}, rollback=${hasRollback}.`,
    severity: 'error',
  };
}

function checkEvaluation(rc: ResearchCase): ValidationCheck {
  if (!rc.evaluation) {
    return { name: 'evaluation_complete', passed: false, message: 'No evaluation report.', severity: 'error' };
  }
  return {
    name: 'evaluation_complete',
    passed: rc.evaluation.overall_pass,
    message: rc.evaluation.overall_pass
      ? 'Evaluation passed.'
      : `Evaluation FAILED: ${rc.evaluation.policy_checks.filter((c) => !c.passed).length} policy failure(s), ${rc.evaluation.stability_checks.filter((c) => !c.passed).length} stability failure(s).`,
    severity: 'error',
  };
}

function checkChangeBudget(rc: ResearchCase): ValidationCheck {
  const under = rc.change_budget.iterations_used <= rc.change_budget.max_iterations;
  return {
    name: 'change_budget',
    passed: under,
    message: under
      ? `Budget: ${rc.change_budget.iterations_used}/${rc.change_budget.max_iterations} iterations, ${rc.change_budget.prs_used}/${rc.change_budget.max_prs} PRs.`
      : `OVER BUDGET: ${rc.change_budget.iterations_used}/${rc.change_budget.max_iterations} iterations used.`,
    severity: under ? 'info' : 'error',
  };
}
