/**
 * Baseline Knowledge — encodes architectural patterns that mcp-refinery
 * itself uses, as evaluation criteria for other MCP servers.
 *
 * The refinery eats its own cooking. Every pattern here is something
 * the refinery does well, so it knows what to look for and recommend.
 */

// ---------------------------------------------------------------------------
// Pattern Definitions
// ---------------------------------------------------------------------------

export interface BaselinePattern {
  pattern_id: string;
  name: string;
  category: 'architecture' | 'governance' | 'devex' | 'reliability' | 'security' | 'maintenance';
  description: string;
  why_it_matters: string;
  detection_hints: string[];
  recommendation_when_missing: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

const PATTERNS: BaselinePattern[] = [
  // -- Architecture --
  {
    pattern_id: 'facade_tools',
    name: 'Facade Tool Pattern',
    category: 'architecture',
    description: 'Expose a small set of high-level tools that orchestrate internal complexity. Users call 3-5 facade tools instead of 20+ granular ones.',
    why_it_matters: 'Agents and users get overwhelmed by large tool surfaces. Facades reduce cognitive load and error surface.',
    detection_hints: ['tool count > 15 without clear grouping', 'no orchestration layer', 'user must chain tools manually'],
    recommendation_when_missing: 'Group related tools behind facade tools that handle orchestration internally. Keep internal tools available but clearly marked as advanced.',
    severity: 'high',
  },
  {
    pattern_id: 'decoupled_planes',
    name: 'Decoupled Processing Planes',
    category: 'architecture',
    description: 'Separate concerns into distinct planes (e.g. research, decision, delivery) that communicate through well-defined interfaces.',
    why_it_matters: 'Tight coupling makes changes risky and testing hard. Decoupled planes can evolve independently.',
    detection_hints: ['business logic mixed with transport', 'tool handlers doing everything inline', 'no separation between analysis and action'],
    recommendation_when_missing: 'Extract processing into separate modules with clear input/output contracts. Each plane should be testable in isolation.',
    severity: 'high',
  },
  {
    pattern_id: 'bootstrap_prompts',
    name: 'Bootstrap Prompt Chaining',
    category: 'devex',
    description: 'Every tool response includes a structured next-step prompt that the calling agent can follow automatically.',
    why_it_matters: 'Without chaining, multi-step workflows require the user to manually figure out each next step. Bootstrap prompts enable autonomous agent operation.',
    detection_hints: ['tools return only data with no guidance', 'multi-step workflows undocumented', 'agent has to guess next action'],
    recommendation_when_missing: 'Add a structured next-step object to every tool response: { control: "agent"|"user", description, bootstrap_prompt }.',
    severity: 'medium',
  },
  {
    pattern_id: 'model_routing',
    name: 'Intelligent Model Routing',
    category: 'architecture',
    description: 'Classify tasks by complexity and route to appropriate model tiers (architect for critical, workhorse for standard, fast for simple).',
    why_it_matters: 'Using the most powerful model for every task is slow and expensive. Using the cheapest for everything produces poor results on complex problems.',
    detection_hints: ['single model assumption', 'no task classification', 'no model switching guidance'],
    recommendation_when_missing: 'Add task classification that considers complexity, risk, and domain. Route critical decisions to architect-tier models and routine tasks to faster ones.',
    severity: 'medium',
  },

  // -- Governance --
  {
    pattern_id: 'alignment_gates',
    name: 'User Alignment Gates',
    category: 'governance',
    description: 'Pause for explicit user confirmation before making changes that alter tool behavior, architecture, or external contracts.',
    why_it_matters: 'Autonomous changes without alignment lead to drift. The user is the decision maker for directional choices.',
    detection_hints: ['changes applied without approval', 'no governance checkpoints', 'auto-merge without review'],
    recommendation_when_missing: 'Add alignment gates before any tool behavior change. Present what will change, why, and what the alternatives are. Wait for explicit approval.',
    severity: 'critical',
  },
  {
    pattern_id: 'anti_oscillation',
    name: 'Anti-Oscillation Regime',
    category: 'governance',
    description: 'Prevent ping-pong changes by enforcing cooldown windows, confidence margins, and monotonic scorecard improvement.',
    why_it_matters: 'Without anti-oscillation, automated improvement loops can flip decisions back and forth endlessly.',
    detection_hints: ['no cooldown between related changes', 'no scorecard tracking', 'reverted changes re-proposed'],
    recommendation_when_missing: 'Track decisions in ADRs with cooldown periods. Require new proposals to demonstrate higher confidence than the decision they would supersede.',
    severity: 'high',
  },
  {
    pattern_id: 'audit_trail',
    name: 'Immutable Audit Trail',
    category: 'governance',
    description: 'Every action is logged to an append-only audit log with actor, target, timestamp, and details.',
    why_it_matters: 'Without audit trails, there is no way to understand what happened, when, or why. Essential for debugging and compliance.',
    detection_hints: ['no logging of tool invocations', 'mutable history', 'no correlation IDs'],
    recommendation_when_missing: 'Add append-only audit logging for every state-changing operation. Include actor, action, target, and structured details.',
    severity: 'high',
  },

  // -- Reliability --
  {
    pattern_id: 'graceful_errors',
    name: 'Structured Error Responses',
    category: 'reliability',
    description: 'All errors return structured JSON with status, error type, and actionable recovery guidance.',
    why_it_matters: 'Unstructured errors leave agents stuck. Structured errors with next-step guidance allow recovery.',
    detection_hints: ['raw exception messages', 'no error classification', 'errors without recovery guidance'],
    recommendation_when_missing: 'Wrap all tool errors in structured responses with error type, human-readable message, and a recovery bootstrap prompt.',
    severity: 'medium',
  },
  {
    pattern_id: 'input_validation',
    name: 'Schema-Based Input Validation',
    category: 'security',
    description: 'All tool inputs are validated against schemas (e.g., Zod) before processing.',
    why_it_matters: 'Unvalidated inputs lead to injection, crashes, and undefined behavior. Schema validation is the first line of defense.',
    detection_hints: ['no input schemas', 'raw parameter access', 'type casting without validation'],
    recommendation_when_missing: 'Define Zod schemas for every tool input. Validate before processing. Return clear validation errors.',
    severity: 'critical',
  },

  // -- Maintenance --
  {
    pattern_id: 'cleanup_hygiene',
    name: 'Post-Change Cleanup Pass',
    category: 'maintenance',
    description: 'After implementing changes, run a dedicated cleanup pass to remove stale imports, dead code, orphaned types, and misaligned references.',
    why_it_matters: 'Every change leaves artifacts. Stale imports, dead types, and orphaned code accumulate silently and create confusion, type errors, and increased bundle size.',
    detection_hints: ['unused imports', 'dead exports', 'types defined but never used', 'comments referencing removed code', 'stale dependency references'],
    recommendation_when_missing: 'Add a cleanup pass after every set of changes. Check: unused imports, dead exports, stale type references, orphaned files, misaligned comments.',
    severity: 'high',
  },
  {
    pattern_id: 'zero_dependency_bias',
    name: 'Minimal Dependency Footprint',
    category: 'maintenance',
    description: 'Prefer built-in capabilities over external dependencies. Every dependency is a liability.',
    why_it_matters: 'External dependencies introduce supply chain risk, compilation issues (native modules), and portability problems.',
    detection_hints: ['heavy dependency tree', 'native modules', 'dependencies used for trivial functions'],
    recommendation_when_missing: 'Audit dependencies. Replace trivial ones with inline implementations. Prefer Node.js built-ins. Keep the dependency tree shallow.',
    severity: 'medium',
  },
  {
    pattern_id: 'propagate_improvements',
    name: 'Cross-Server Improvement Propagation',
    category: 'maintenance',
    description: 'When a universal improvement is validated on one server, propagate it as a recommendation to all managed servers.',
    why_it_matters: 'Fixing a security pattern in one server while leaving the same vulnerability in others is incomplete improvement.',
    detection_hints: ['improvements applied to single server', 'no cross-server learning', 'repeated findings across servers'],
    recommendation_when_missing: 'Tag improvements as universal or server-specific. When a universal improvement is validated, generate proposals for all other managed servers.',
    severity: 'medium',
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getAllPatterns(): BaselinePattern[] {
  return [...PATTERNS];
}

export function getPatternsByCategory(category: BaselinePattern['category']): BaselinePattern[] {
  return PATTERNS.filter((p) => p.category === category);
}

export function getCriticalPatterns(): BaselinePattern[] {
  return PATTERNS.filter((p) => p.severity === 'critical' || p.severity === 'high');
}

/**
 * Build a baseline evaluation prompt section that can be injected into
 * research prompts. This teaches the agent WHAT good looks like.
 */
export function buildBaselinePromptSection(categories?: BaselinePattern['category'][]): string {
  const patterns = categories
    ? PATTERNS.filter((p) => categories.includes(p.category))
    : getCriticalPatterns();

  const lines = ['## Baseline Quality Patterns (evaluate the server against these)',
    '',
    'These are proven patterns from high-quality MCP server architectures. Check whether the target server implements each one, and flag gaps as findings.',
    ''];

  for (const p of patterns) {
    lines.push(`### ${p.name} [${p.severity}]`);
    lines.push(p.description);
    lines.push(`**Why**: ${p.why_it_matters}`);
    lines.push(`**Look for**: ${p.detection_hints.join('; ')}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build a cleanup checklist that can be injected into post-change
 * verification prompts.
 */
export function buildCleanupChecklist(): string {
  return `## Post-Change Cleanup Checklist

Run this verification after implementing changes. Report any issues found.

1. **Unused imports** — Check every modified file for imports that are no longer referenced.
2. **Dead exports** — Check if removed/renamed functions are still exported from facade modules.
3. **Orphaned types** — Check if any types in the types file are no longer used anywhere.
4. **Stale comments** — Check for comments referencing removed code, old architecture, or deleted dependencies.
5. **Misaligned references** — Check that function signatures match between callers and implementations.
6. **Removed dependency artifacts** — If a dependency was removed, verify no references remain (imports, types, comments).
7. **Test coverage** — Verify that new code has corresponding test expectations.
8. **Type consistency** — Verify that type unions (enums, action types) only contain values that are actually used.
9. **Bundle impact** — Note any significant increase in bundle size.
10. **Cross-module alignment** — Verify that changes in one module are reflected in all modules that depend on it.

Return findings as structured JSON — same format as research findings.`;
}

/**
 * Given a set of findings, identify which baseline patterns are violated
 * and enrich findings with baseline references.
 */
export function matchFindingsToBaselines(
  findings: Array<{ claim: string; recommendation: string }>,
): Array<{ finding_index: number; pattern_ids: string[]; pattern_names: string[] }> {
  const matches: Array<{ finding_index: number; pattern_ids: string[]; pattern_names: string[] }> = [];

  for (let i = 0; i < findings.length; i++) {
    const text = `${findings[i].claim} ${findings[i].recommendation}`.toLowerCase();
    const matched: BaselinePattern[] = [];

    for (const p of PATTERNS) {
      const keywords = p.detection_hints.join(' ').toLowerCase().split(/\s+/);
      const hitCount = keywords.filter((k) => k.length > 3 && text.includes(k)).length;
      if (hitCount >= 2) matched.push(p);
    }

    if (matched.length > 0) {
      matches.push({
        finding_index: i,
        pattern_ids: matched.map((m) => m.pattern_id),
        pattern_names: matched.map((m) => m.name),
      });
    }
  }

  return matches;
}
