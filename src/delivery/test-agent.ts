/**
 * Test/Eval Agent — runs test suites and evaluates scorecards pre/post change.
 *
 * Records test run results with full metadata for governance and rollback decisions.
 */

import { randomUUID } from 'node:crypto';
import type { TestRunRecord, ScorecardSnapshot } from '../types/index.js';
import { insertTestRun, recordAudit, storeArtifact } from '../storage/index.js';
import { captureScorecard, compareScorecards, getBaseline, type ScorecardInput } from '../decision/scorecard.js';

export interface TestSuiteResult {
  suite_name: string;
  passed: boolean;
  total: number;
  passed_count: number;
  failed_count: number;
  skipped_count: number;
  coverage_percent: number | null;
  duration_ms: number;
  output: string;
  failures: TestFailure[];
}

export interface TestFailure {
  test_name: string;
  error_message: string;
  stack_trace: string;
}

export interface EvalResult {
  test_run: TestRunRecord;
  scorecard_comparison: ReturnType<typeof compareScorecards> | null;
  meets_acceptance_criteria: boolean;
  blocking_failures: string[];
  warnings: string[];
}

/**
 * Record a test suite execution result.
 */
export function recordTestRun(
  prId: string,
  planId: string,
  suiteResult: TestSuiteResult,
  scorecardAfter?: ScorecardSnapshot,
): TestRunRecord {
  const run: TestRunRecord = {
    run_id: randomUUID(),
    pr_id: prId,
    plan_id: planId,
    test_suite: suiteResult.suite_name,
    passed: suiteResult.passed,
    total_tests: suiteResult.total,
    passed_tests: suiteResult.passed_count,
    failed_tests: suiteResult.failed_count,
    skipped_tests: suiteResult.skipped_count,
    coverage_percent: suiteResult.coverage_percent,
    duration_ms: suiteResult.duration_ms,
    scorecard_after: scorecardAfter ?? null,
    created_at: new Date().toISOString(),
  };

  insertTestRun(run);

  storeArtifact(
    `test-runs/${run.run_id}/output`,
    suiteResult.output,
    'text/plain',
    'ci_log',
    {
      pr_id: prId,
      suite: suiteResult.suite_name,
      passed: String(suiteResult.passed),
    },
  );

  if (suiteResult.failures.length > 0) {
    storeArtifact(
      `test-runs/${run.run_id}/failures`,
      JSON.stringify(suiteResult.failures, null, 2),
      'application/json',
      'ci_log',
      { pr_id: prId, failure_count: String(suiteResult.failures.length) },
    );
  }

  recordAudit(
    'delivery.tests_run',
    'test_agent',
    'test_run',
    run.run_id,
    {
      suite: suiteResult.suite_name,
      passed: suiteResult.passed,
      total: suiteResult.total,
      failed: suiteResult.failed_count,
      coverage: suiteResult.coverage_percent,
      duration_ms: suiteResult.duration_ms,
    },
  );

  return run;
}

/**
 * Evaluate whether test results and scorecard changes meet acceptance criteria.
 */
export function evaluateTestResults(
  testRuns: TestRunRecord[],
  targetServerId: string,
  scorecardInput?: ScorecardInput,
): EvalResult {
  const blockingFailures: string[] = [];
  const warnings: string[] = [];

  const allPassed = testRuns.every((r) => r.passed);
  if (!allPassed) {
    const failedSuites = testRuns.filter((r) => !r.passed).map((r) => r.test_suite);
    blockingFailures.push(`Test suites failed: ${failedSuites.join(', ')}`);
  }

  const totalTests = testRuns.reduce((s, r) => s + r.total_tests, 0);
  const totalPassed = testRuns.reduce((s, r) => s + r.passed_tests, 0);
  const overallPassRate = totalTests > 0 ? totalPassed / totalTests : 0;
  if (overallPassRate < 0.95) {
    blockingFailures.push(`Overall pass rate ${(overallPassRate * 100).toFixed(1)}% below 95% threshold`);
  }

  let scorecardComparison: ReturnType<typeof compareScorecards> | null = null;

  if (scorecardInput) {
    const currentScorecard = captureScorecard(scorecardInput);
    const baseline = getBaseline(targetServerId);

    if (baseline) {
      scorecardComparison = compareScorecards(baseline, currentScorecard);

      if (!scorecardComparison.monotonic_improvement) {
        if (scorecardComparison.any_primary_degraded) {
          blockingFailures.push('Primary scorecard metrics degraded — monotonic improvement violated');
        } else {
          warnings.push('Overall scorecard score decreased but no primary metrics degraded');
        }
      }
    }
  }

  const coverages = testRuns
    .filter((r) => r.coverage_percent !== null)
    .map((r) => r.coverage_percent!);
  if (coverages.length > 0) {
    const avgCoverage = coverages.reduce((a, b) => a + b, 0) / coverages.length;
    if (avgCoverage < 70) {
      warnings.push(`Average test coverage ${avgCoverage.toFixed(1)}% below 70% target`);
    }
  }

  const latestRun = testRuns.length > 0 ? testRuns[testRuns.length - 1] : null;

  return {
    test_run: latestRun ?? {
      run_id: randomUUID(),
      pr_id: '',
      plan_id: '',
      test_suite: 'none',
      passed: false,
      total_tests: 0,
      passed_tests: 0,
      failed_tests: 0,
      skipped_tests: 0,
      coverage_percent: null,
      duration_ms: 0,
      scorecard_after: null,
      created_at: new Date().toISOString(),
    },
    scorecard_comparison: scorecardComparison,
    meets_acceptance_criteria: blockingFailures.length === 0,
    blocking_failures: blockingFailures,
    warnings,
  };
}

/**
 * Format eval results as a human-readable report.
 */
export function formatEvalReport(evalResult: EvalResult): string {
  const status = evalResult.meets_acceptance_criteria ? 'PASS' : 'FAIL';
  let report = `# Evaluation Report [${status}]\n\n`;

  report += `## Test Results\n`;
  report += `- **Suite**: ${evalResult.test_run.test_suite}\n`;
  report += `- **Total Tests**: ${evalResult.test_run.total_tests}\n`;
  report += `- **Passed**: ${evalResult.test_run.passed_tests}\n`;
  report += `- **Failed**: ${evalResult.test_run.failed_tests}\n`;
  report += `- **Skipped**: ${evalResult.test_run.skipped_tests}\n`;
  if (evalResult.test_run.coverage_percent !== null) {
    report += `- **Coverage**: ${evalResult.test_run.coverage_percent.toFixed(1)}%\n`;
  }
  report += `- **Duration**: ${evalResult.test_run.duration_ms}ms\n\n`;

  if (evalResult.scorecard_comparison) {
    const sc = evalResult.scorecard_comparison;
    report += `## Scorecard Comparison\n`;
    report += `- **Overall Delta**: ${sc.overall_delta >= 0 ? '+' : ''}${(sc.overall_delta * 100).toFixed(2)}%\n`;
    report += `- **Monotonic Improvement**: ${sc.monotonic_improvement ? 'Yes' : 'No'}\n\n`;
    for (const delta of sc.dimension_deltas) {
      const arrow = delta.delta >= 0 ? '+' : '';
      const primary = delta.is_primary ? ' (PRIMARY)' : '';
      report += `  - ${delta.name}${primary}: ${(delta.baseline_score * 100).toFixed(1)}% -> ${(delta.current_score * 100).toFixed(1)}% (${arrow}${(delta.delta * 100).toFixed(2)}%)\n`;
    }
    report += '\n';
  }

  if (evalResult.blocking_failures.length > 0) {
    report += `## Blocking Failures\n`;
    for (const f of evalResult.blocking_failures) {
      report += `- ${f}\n`;
    }
    report += '\n';
  }

  if (evalResult.warnings.length > 0) {
    report += `## Warnings\n`;
    for (const w of evalResult.warnings) {
      report += `- ${w}\n`;
    }
  }

  return report;
}
