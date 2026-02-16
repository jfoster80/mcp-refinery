/**
 * Scorecard evaluation engine.
 *
 * Defines weighted scorecards per MCP server measuring:
 * - MCP protocol compliance
 * - Test pass rate and coverage
 * - Security posture
 * - Reliability metrics
 * - Governance compliance
 *
 * Scorecards are the objective function that must improve monotonically
 * for the anti-oscillation engine to allow changes.
 */

import { randomUUID } from 'node:crypto';
import { insertScorecardSnapshot, getLatestScorecard, recordAudit } from '../storage/index.js';
import type {
  ScorecardSnapshot,
  ScorecardDimension,
  ScorecardMetric,
  TargetServerConfig,
} from '../types/index.js';

export interface ScorecardInput {
  target_server_id: string;
  protocol_compliance: ProtocolComplianceMetrics;
  testing: TestingMetrics;
  security: SecurityMetrics;
  reliability: ReliabilityMetrics;
  governance: GovernanceMetrics;
}

export interface ProtocolComplianceMetrics {
  valid_tool_schemas: number;
  total_tools: number;
  valid_resource_uris: number;
  total_resources: number;
  transport_hardened: boolean;
  auth_implemented: boolean;
  structured_output_usage: number;
  error_handling_coverage: number;
}

export interface TestingMetrics {
  test_pass_rate: number;
  test_coverage: number;
  protocol_test_coverage: number;
  integration_test_count: number;
}

export interface SecurityMetrics {
  secrets_scan_clean: boolean;
  dependency_vulnerabilities: number;
  input_validation_coverage: number;
  auth_bypass_tests: number;
  owasp_llm_compliance: number;
}

export interface ReliabilityMetrics {
  error_rate: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  uptime_percent: number;
}

export interface GovernanceMetrics {
  policy_violations: number;
  failed_approvals: number;
  audit_completeness: number;
  adr_coverage: number;
}

/**
 * Capture a new scorecard snapshot for a target server.
 */
export function captureScorecard(input: ScorecardInput): ScorecardSnapshot {
  const dimensions = buildDimensions(input);
  const overallScore = computeOverallScore(dimensions);

  const snapshot: ScorecardSnapshot = {
    scorecard_id: randomUUID(),
    target_server_id: input.target_server_id,
    captured_at: new Date().toISOString(),
    dimensions,
    overall_score: overallScore,
  };

  insertScorecardSnapshot(snapshot);

  recordAudit(
    'scorecard.capture',
    'scorecard_engine',
    'scorecard',
    snapshot.scorecard_id,
    {
      overall_score: overallScore,
      dimension_scores: Object.fromEntries(dimensions.map((d) => [d.name, d.score])),
    },
  );

  return snapshot;
}

/**
 * Compare two scorecard snapshots and determine if improvement is monotonic.
 */
export function compareScorecards(
  baseline: ScorecardSnapshot,
  current: ScorecardSnapshot,
): ScorecardComparison {
  const dimensionDeltas: DimensionDelta[] = [];
  let primaryMetricsImproved = true;
  let anyPrimaryDegraded = false;

  for (const baseDim of baseline.dimensions) {
    const currDim = current.dimensions.find((d) => d.name === baseDim.name);
    if (!currDim) continue;

    const delta = currDim.score - baseDim.score;
    dimensionDeltas.push({
      name: baseDim.name,
      baseline_score: baseDim.score,
      current_score: currDim.score,
      delta,
      is_primary: baseDim.is_primary,
      improved: delta >= 0,
    });

    if (baseDim.is_primary && delta < 0) {
      primaryMetricsImproved = false;
      anyPrimaryDegraded = true;
    }
  }

  return {
    baseline_id: baseline.scorecard_id,
    current_id: current.scorecard_id,
    overall_delta: current.overall_score - baseline.overall_score,
    dimension_deltas: dimensionDeltas,
    primary_metrics_improved: primaryMetricsImproved,
    any_primary_degraded: anyPrimaryDegraded,
    monotonic_improvement: primaryMetricsImproved && current.overall_score >= baseline.overall_score,
  };
}

export interface ScorecardComparison {
  baseline_id: string;
  current_id: string;
  overall_delta: number;
  dimension_deltas: DimensionDelta[];
  primary_metrics_improved: boolean;
  any_primary_degraded: boolean;
  monotonic_improvement: boolean;
}

export interface DimensionDelta {
  name: string;
  baseline_score: number;
  current_score: number;
  delta: number;
  is_primary: boolean;
  improved: boolean;
}

/**
 * Get the current baseline scorecard for a server.
 */
export function getBaseline(serverId: string): ScorecardSnapshot | null {
  return getLatestScorecard(serverId);
}

/**
 * Format a scorecard as a readable report.
 */
export function formatScorecardReport(snapshot: ScorecardSnapshot): string {
  let report = `# Scorecard Report\n\n`;
  report += `**Server**: ${snapshot.target_server_id}\n`;
  report += `**Captured**: ${snapshot.captured_at}\n`;
  report += `**Overall Score**: ${(snapshot.overall_score * 100).toFixed(1)}%\n\n`;

  for (const dim of snapshot.dimensions) {
    const primary = dim.is_primary ? ' (PRIMARY)' : '';
    report += `## ${dim.name}${primary} — ${(dim.score * 100).toFixed(1)}% (weight: ${dim.weight})\n`;
    for (const metric of dim.sub_metrics) {
      const status = metric.passed ? 'PASS' : 'FAIL';
      report += `  - ${metric.name}: ${metric.value.toFixed(2)} (threshold: ${metric.threshold}) [${status}]\n`;
    }
    report += '\n';
  }

  return report;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildDimensions(input: ScorecardInput): ScorecardDimension[] {
  const { protocol_compliance: pc, testing: t, security: s, reliability: r, governance: g } = input;

  return [
    {
      name: 'Protocol Compliance',
      weight: 0.25,
      score: computeProtocolScore(pc),
      is_primary: true,
      sub_metrics: [
        metric('Tool Schema Validity', pc.total_tools > 0 ? pc.valid_tool_schemas / pc.total_tools : 1, 0.9),
        metric('Resource URI Validity', pc.total_resources > 0 ? pc.valid_resource_uris / pc.total_resources : 1, 0.9),
        metric('Transport Hardening', pc.transport_hardened ? 1 : 0, 0.8),
        metric('Auth Implementation', pc.auth_implemented ? 1 : 0, 0.7),
        metric('Structured Output Usage', pc.structured_output_usage, 0.5),
        metric('Error Handling', pc.error_handling_coverage, 0.8),
      ],
    },
    {
      name: 'Testing',
      weight: 0.2,
      score: computeTestingScore(t),
      is_primary: true,
      sub_metrics: [
        metric('Test Pass Rate', t.test_pass_rate, 0.95),
        metric('Test Coverage', t.test_coverage, 0.7),
        metric('Protocol Test Coverage', t.protocol_test_coverage, 0.5),
        metric('Integration Tests', Math.min(t.integration_test_count / 10, 1), 0.3),
      ],
    },
    {
      name: 'Security',
      weight: 0.25,
      score: computeSecurityScore(s),
      is_primary: true,
      sub_metrics: [
        metric('Secrets Scan', s.secrets_scan_clean ? 1 : 0, 1.0),
        metric('Dependency Vulnerabilities', Math.max(0, 1 - s.dependency_vulnerabilities / 10), 0.8),
        metric('Input Validation', s.input_validation_coverage, 0.7),
        metric('OWASP LLM Compliance', s.owasp_llm_compliance, 0.6),
      ],
    },
    {
      name: 'Reliability',
      weight: 0.15,
      score: computeReliabilityScore(r),
      is_primary: false,
      sub_metrics: [
        metric('Error Rate', Math.max(0, 1 - r.error_rate), 0.95),
        metric('P95 Latency', r.p95_latency_ms < 500 ? 1 : 500 / r.p95_latency_ms, 0.8),
        metric('Uptime', r.uptime_percent / 100, 0.99),
      ],
    },
    {
      name: 'Governance',
      weight: 0.15,
      score: computeGovernanceScore(g),
      is_primary: false,
      sub_metrics: [
        metric('Policy Violations', Math.max(0, 1 - g.policy_violations / 5), 0.9),
        metric('Failed Approvals', Math.max(0, 1 - g.failed_approvals / 3), 0.9),
        metric('Audit Completeness', g.audit_completeness, 0.8),
        metric('ADR Coverage', g.adr_coverage, 0.5),
      ],
    },
  ];
}

function metric(name: string, value: number, threshold: number): ScorecardMetric {
  return { name, value: Math.max(0, Math.min(1, value)), threshold, passed: value >= threshold };
}

function computeProtocolScore(pc: ProtocolComplianceMetrics): number {
  const toolScore = pc.total_tools > 0 ? pc.valid_tool_schemas / pc.total_tools : 1;
  const resourceScore = pc.total_resources > 0 ? pc.valid_resource_uris / pc.total_resources : 1;
  return (toolScore * 0.3 + resourceScore * 0.2 + (pc.transport_hardened ? 0.2 : 0)
    + (pc.auth_implemented ? 0.1 : 0) + pc.structured_output_usage * 0.1 + pc.error_handling_coverage * 0.1);
}

function computeTestingScore(t: TestingMetrics): number {
  return t.test_pass_rate * 0.4 + t.test_coverage * 0.3 + t.protocol_test_coverage * 0.2
    + Math.min(t.integration_test_count / 10, 1) * 0.1;
}

function computeSecurityScore(s: SecurityMetrics): number {
  return (s.secrets_scan_clean ? 0.3 : 0) + Math.max(0, 1 - s.dependency_vulnerabilities / 10) * 0.25
    + s.input_validation_coverage * 0.25 + s.owasp_llm_compliance * 0.2;
}

function computeReliabilityScore(r: ReliabilityMetrics): number {
  const latencyScore = r.p95_latency_ms < 500 ? 1 : Math.min(1, 500 / r.p95_latency_ms);
  return Math.max(0, 1 - r.error_rate) * 0.4 + latencyScore * 0.3 + (r.uptime_percent / 100) * 0.3;
}

function computeGovernanceScore(g: GovernanceMetrics): number {
  return Math.max(0, 1 - g.policy_violations / 5) * 0.3
    + Math.max(0, 1 - g.failed_approvals / 3) * 0.2
    + g.audit_completeness * 0.3
    + g.adr_coverage * 0.2;
}

function computeOverallScore(dimensions: ScorecardDimension[]): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const dim of dimensions) {
    weightedSum += dim.score * dim.weight;
    totalWeight += dim.weight;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}
