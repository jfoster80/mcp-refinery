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
    name: 'Three-Outcome Response Termination',
    category: 'devex',
    description: 'Every tool response must end with exactly one of three outcomes: (1) a bootstrap prompt that chains to the next tool call (control: "agent"), (2) a question or decision prompt for the user (control: "user"), or (3) an explicit release statement back to the calling agent with context on what was accomplished. No response may end in a dead end with no guidance.',
    why_it_matters: 'Dead-end responses strand agents and users. Vague handoffs like "proceed with the pipeline" leave agents guessing which tool to call. Every output must provide a clear, actionable path forward — either automated continuation, a specific question for the user, or an explicit handoff with context.',
    detection_hints: ['next: null on any output path', 'bootstrap_prompt without specific tool name', 'control: "agent" without naming which tool to call next', 'control: "user" without a question or clear options', 'error responses with no recovery path', 'success responses that silently drop control'],
    recommendation_when_missing: 'Audit every return path in every tool. For agent paths: name the specific tool and parameters. For user paths: end with a question or present numbered options. For errors: include what went wrong, likely causes, and specific recovery steps. Never return next: null.',
    severity: 'critical',
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

  // -- MCP Tool Implementation Standards --
  {
    pattern_id: 'tool_schema_quality',
    name: 'Zod Schema with Descriptive Annotations',
    category: 'reliability',
    description: 'Every tool input parameter must be validated with a Zod schema. Every parameter must have a .describe() annotation explaining what it does, acceptable values, and any defaults.',
    why_it_matters: 'Agents rely on parameter descriptions to fill tool calls correctly. Missing or vague descriptions cause misuse, invalid inputs, and wasted tokens on retries.',
    detection_hints: ['z.string() without .describe()', 'z.object({}) with bare fields', 'optional parameters with no description', 'no Zod schemas at all', 'raw parameter access without validation'],
    recommendation_when_missing: 'Add Zod schemas for every tool parameter. Use .describe() on every field with clear, actionable descriptions. Include examples for complex parameters. Mark optional parameters with .optional() and document their defaults.',
    severity: 'critical',
  },
  {
    pattern_id: 'tool_description_quality',
    name: 'Clear, Actionable Tool Descriptions',
    category: 'devex',
    description: 'Every tool must have a description that explains what it does, when to use it, and what it returns. Descriptions should be written for agent consumption — concise but complete.',
    why_it_matters: 'Tool descriptions are the primary way agents decide which tool to call. Vague descriptions lead to wrong tool selection, wasted calls, and degraded user experience.',
    detection_hints: ['tool description under 20 characters', 'description says only what the tool is, not when to use it', 'no description of return value or side effects', 'missing usage context'],
    recommendation_when_missing: 'Write tool descriptions that answer: What does it do? When should you use it? What does it return? What are the side effects? Keep it under 200 characters but be specific.',
    severity: 'high',
  },
  {
    pattern_id: 'structured_tool_response',
    name: 'Structured Response with Next-Step Guidance',
    category: 'devex',
    description: 'Every tool response must return structured JSON with: status (success/error/needs_input/needs_approval), data payload, human-readable message, and a next-step object with control (agent/user), description, and bootstrap_prompt.',
    why_it_matters: 'Unstructured responses break agent chains. Without next-step guidance, the calling agent cannot autonomously continue multi-step workflows.',
    detection_hints: ['raw string responses', 'no status field in response', 'missing next-step guidance', 'responses without bootstrap prompts', 'inconsistent response shapes across tools'],
    recommendation_when_missing: 'Use a shared output() helper that enforces the response shape: { status, data, message, next: { control, description, bootstrap_prompt } }. Every tool must use this helper.',
    severity: 'high',
  },
  {
    pattern_id: 'no_dead_ends',
    name: 'No Dead-End Responses',
    category: 'reliability',
    description: 'Every output path in every tool — success, error, empty result, edge case — must include a next block. No code path may return next: null. Error paths must include recovery steps. Empty-result paths must suggest what to try instead. Query tools must suggest follow-up actions.',
    why_it_matters: 'A single dead-end response breaks the entire agent loop. The agent receives data but has no instruction on what to do with it, forcing the user to manually intervene. This is the most common cause of "the agent got stuck" reports.',
    detection_hints: ['next: null in any return statement', 'catch blocks returning bare error with no next', 'conditional branches where only one branch has a next block', 'query/read tools that return data but no follow-up', 'edge cases like empty arrays returning no guidance'],
    recommendation_when_missing: 'Grep for "next: null" and "next: undefined" in all tool handlers. Every instance is a bug. Replace with: agent bootstrap (name specific tool), user question (present options), or explicit context handoff (summarize what happened and what the agent can do next).',
    severity: 'critical',
  },
  {
    pattern_id: 'tool_error_handling',
    name: 'Structured Error Responses with Recovery',
    category: 'reliability',
    description: 'All tool errors must be caught, classified, and returned as structured responses with actionable recovery guidance. Never expose raw stack traces or unstructured error strings.',
    why_it_matters: 'Raw errors leave agents stuck with no path forward. Structured errors with recovery prompts allow agents to self-correct or escalate to the user.',
    detection_hints: ['unhandled promise rejections', 'raw throw without catch', 'error responses missing recovery guidance', 'stack traces in tool responses', 'generic error messages without classification'],
    recommendation_when_missing: 'Wrap all tool handlers in try/catch. Return errors through the output() helper with status="error", a clear message, and a next-step bootstrap_prompt suggesting recovery actions.',
    severity: 'high',
  },
  {
    pattern_id: 'mcp_protocol_compliance',
    name: 'MCP Protocol Compliance (2025-11-25)',
    category: 'security',
    description: 'All tools, resources, and prompts must comply with the MCP specification (2025-11-25). Tool responses must use the correct content type array format. Resource URIs must follow the protocol scheme. JSON-RPC 2.0 error codes must be correct.',
    why_it_matters: 'Non-compliant servers break interoperability. Clients that follow the spec will fail to parse non-compliant responses, leading to silent data loss or crashes.',
    detection_hints: ['tool responses not using content array format', 'resource URIs without scheme prefix', 'wrong JSON-RPC error codes', 'missing capabilities in server registration', 'non-standard content types'],
    recommendation_when_missing: 'Audit every tool response against the MCP spec. Use { content: [{ type: "text", text: "..." }] } format. Register all capabilities. Use standard JSON-RPC 2.0 error codes.',
    severity: 'critical',
  },
  {
    pattern_id: 'transport_security',
    name: 'Transport-Appropriate Security',
    category: 'security',
    description: 'STDIO transport must validate that inputs are well-formed JSON-RPC. HTTP/SSE transport must implement CORS headers, origin validation, auth token handling, and DNS rebinding protection.',
    why_it_matters: 'HTTP-exposed MCP servers without CORS and auth are vulnerable to DNS rebinding, CSRF, and unauthorized access from any origin.',
    detection_hints: ['HTTP transport without CORS configuration', 'no origin validation', 'missing auth middleware', 'no rate limiting on HTTP endpoints', 'STDIO transport accepting non-JSON input without validation'],
    recommendation_when_missing: 'For HTTP: add CORS with explicit allowed origins, require auth tokens, validate Origin header, add rate limiting. For STDIO: validate JSON-RPC framing before processing.',
    severity: 'high',
  },
  {
    pattern_id: 'documentation_currency',
    name: 'Documentation Ships with Code',
    category: 'maintenance',
    description: 'Every change that adds, removes, or modifies tools, resources, configuration, or architecture must update the corresponding documentation before release. This includes: README.md (tool inventory, setup, usage), architecture docs, configuration reference, and inline JSDoc/TSDoc. Documentation is not a follow-up task — it is part of the definition of done.',
    why_it_matters: 'Stale documentation is worse than no documentation — it actively misleads. When tools change but docs do not, agents construct wrong calls, users follow outdated setup steps, and onboarding becomes a guessing game. Every undocumented tool is a tool nobody will use correctly.',
    detection_hints: ['README references tools that no longer exist', 'new tools not listed in README', 'setup instructions reference removed config', 'architecture docs describe old structure', 'no tool inventory in README', 'missing usage examples', 'changelog not updated'],
    recommendation_when_missing: 'Add a documentation pass after every code change. Update: README tool inventory, setup/config sections, architecture diagrams, usage examples, and CHANGELOG. Verify every tool listed in code appears in README and vice versa.',
    severity: 'high',
  },
  {
    pattern_id: 'resource_uri_quality',
    name: 'Well-Formed Resource URIs',
    category: 'devex',
    description: 'All MCP resources must use well-formed URIs with a consistent scheme prefix (e.g., "refinery://"). Resource descriptions must explain what data is available and how it is updated.',
    why_it_matters: 'Inconsistent or opaque resource URIs make discovery hard. Agents cannot programmatically navigate resources without predictable URI patterns.',
    detection_hints: ['resource URIs without scheme prefix', 'inconsistent URI patterns', 'resources without descriptions', 'no resource list or discovery mechanism'],
    recommendation_when_missing: 'Define a URI scheme for your server (e.g., "myserver://"). Use consistent path segments. Add descriptions to every resource. Provide a resource list endpoint.',
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
 * verification prompts. Includes both general hygiene AND MCP compliance checks.
 */
export function buildCleanupChecklist(): string {
  return `## Post-Change Cleanup Checklist

Run this verification after implementing changes. Report any issues found.

### Code Hygiene

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

### MCP Tool Compliance (for any new or modified tools)

11. **Zod schema completeness** — Every tool parameter has a Zod schema. Every parameter has a .describe() annotation. No bare z.string() or z.number() without descriptions.
12. **Tool description quality** — Every tool has a description that explains: what it does, when to use it, and what it returns. Minimum 20 characters.
13. **Structured response format** — Every tool response uses the output() helper (or equivalent) returning { status, data, message, next }. The next block includes control, description, and bootstrap_prompt.
14. **Error handling** — Every tool handler has try/catch wrapping. Errors return structured responses with recovery guidance, not raw throws or stack traces.
15. **MCP protocol compliance** — Tool responses use content array format: { content: [{ type: "text", text: "..." }] }. Resource URIs have scheme prefixes. JSON-RPC 2.0 error codes are correct.
16. **Input validation before processing** — Zod .parse() or equivalent runs before any business logic. Invalid inputs return clear validation error messages.
17. **Transport security** — HTTP endpoints have CORS and auth. STDIO validates JSON-RPC framing. No raw eval or unvalidated external input processing.

### Response Termination Compliance (for every tool output path)

18. **No dead ends** — Grep for "next: null" in all tool handlers. Every instance is a bug. Every code path (success, error, empty, edge case) must have a next block.
19. **Three-outcome check** — Every next block must be one of: (a) bootstrap to agent with specific tool name and parameters, (b) question/options for the user, or (c) explicit context release summarizing what happened and what to do next.
20. **Agent bootstraps name specific tools** — Any next block with control="agent" must name the specific tool to call and include key parameters. "Proceed with the pipeline" is not acceptable.
21. **User prompts end with questions or options** — Any next block with control="user" must end with a clear question, numbered options, or explicit instructions. "Review the data above" alone is not acceptable.
22. **Error paths include recovery** — Every error response must include: what went wrong, likely causes, and specific tool calls or actions to recover.

### Documentation Currency (for every change)

23. **README tool inventory sync** — List all tools registered in code. List all tools described in README. The two lists must match exactly. Flag any tool in code but not in README, or in README but not in code.
24. **Setup instructions validity** — Read the setup/install section. Does it reference current dependencies, correct commands, and valid config? Flag outdated steps.
25. **Configuration reference completeness** — List all process.env reads and config accesses in code. Every one must appear in the documentation. Flag any undocumented config.
26. **Architecture doc accuracy** — Does the architecture documentation describe the current module structure, overlay order, and data flow? Flag references to removed or renamed modules.
27. **CHANGELOG entry** — Does a CHANGELOG (or equivalent) have an entry for the changes made? Flag if missing.
28. **No phantom doc references** — Search documentation for tool names, config keys, file paths, or module names that no longer exist in code. Every one is a stale reference.
29. **Example code validity** — Do code examples in documentation use current API signatures, parameter names, and tool names? Flag any that reference old or removed interfaces.

Return findings as structured JSON — same format as research findings.`;
}

/**
 * Build an MCP tool implementation guide that can be injected into
 * execute and plan overlay prompts. This teaches the agent HOW to build
 * tools that meet our standards — not just WHAT standards exist.
 */
export function buildImplementationGuide(): string {
  return `## MCP Tool Implementation Standards

When creating or modifying MCP server tools, EVERY tool MUST follow these implementation patterns. These are non-negotiable quality standards.

### 1. Zod Schema with Descriptive Annotations

Every tool parameter MUST have a Zod schema with .describe() on every field:

\`\`\`typescript
// GOOD — every parameter has a clear description
server.tool(
  'my_tool',
  'What it does, when to use it, and what it returns.',
  {
    target_id: z.string().describe('The unique identifier of the target resource'),
    action: z.enum(['start', 'stop', 'restart']).describe('The action to perform on the target'),
    options: z.object({
      timeout_ms: z.number().optional().describe('Timeout in milliseconds. Defaults to 30000'),
      dry_run: z.boolean().optional().describe('If true, simulate without making changes'),
    }).optional().describe('Additional options for the action'),
  },
  async (args) => { /* ... */ }
);

// BAD — bare schemas without descriptions
server.tool('my_tool', 'Does stuff.', {
  target_id: z.string(),           // No description
  action: z.string(),               // Not constrained to valid values
  options: z.object({}).optional(),  // What options?
}, async (args) => { /* ... */ });
\`\`\`

### 2. Tool Description Quality

Tool descriptions MUST answer: What does it do? When should you use it? What does it return?

\`\`\`typescript
// GOOD — clear, actionable, explains when to use
'Start a full improvement pipeline for an MCP server. Use this when you want automated research, triage, and delivery. Returns pipeline status and next-step prompts.'

// BAD — vague, no usage context
'Improves a server.'
\`\`\`

### 3. Structured Response with Next-Step Guidance

Every tool MUST return a structured response through an output() helper:

\`\`\`typescript
function output(o: { status: string; data: Record<string, unknown>; message: string; next: { control: 'agent' | 'user'; description: string; bootstrap_prompt: string } | null }) {
  const parts: string[] = [];
  parts.push(JSON.stringify(o.data, null, 2));
  parts.push('');
  parts.push(\`**Status**: \${o.status} — \${o.message}\`);
  if (o.next) {
    parts.push(\`**Control returns to**: \${o.next.control}\`);
    parts.push(\`**Next step**: \${o.next.description}\`);
    parts.push('');
    parts.push('\\\`\\\`\\\`prompt');
    parts.push(o.next.bootstrap_prompt);
    parts.push('\\\`\\\`\\\`');
  }
  return { content: [{ type: 'text' as const, text: parts.join('\\n') }] };
}
\`\`\`

The response shape:
- **status**: 'success' | 'error' | 'needs_input' | 'needs_approval'
- **data**: Structured JSON with the tool's output
- **message**: Human-readable summary
- **next**: { control: 'agent' (auto-continue) | 'user' (human decision needed), description, bootstrap_prompt }

### 4. Three-Outcome Response Termination

Every tool output MUST end with exactly one of three outcomes. No exceptions. No dead ends.

**Outcome 1 — Bootstrap to next tool (control: "agent")**
The agent should auto-continue. Name the SPECIFIC tool and include key parameters:
\`\`\`typescript
next: {
  control: 'agent',
  description: 'Compute consensus from the research feeds.',
  bootstrap_prompt: 'Use research_consensus with target_server_id="my-server" to compute cross-perspective agreement.',
}
\`\`\`

**Outcome 2 — Question or decision for the user (control: "user")**
The user must decide. End with a clear question or present numbered options:
\`\`\`typescript
next: {
  control: 'user',
  description: 'Approve the proposed changes before proceeding.',
  bootstrap_prompt: 'Review the 3 proposals above. Do you want to proceed with these changes?\\n\\nTo approve: use governance_approve with target_id="..."\\nTo reject: provide feedback and we will re-triage.',
}
\`\`\`

**Outcome 3 — Explicit release back to agent with context**
For query/status tools, summarize what was returned and suggest what the agent can do next:
\`\`\`typescript
next: {
  control: 'user',
  description: 'Audit log retrieved. Review the entries above.',
  bootstrap_prompt: '12 audit entries returned. You can refine with filters (action, target_type) or use search_similar to find related decisions.',
}
\`\`\`

**NEVER return next: null.** Every code path — success, error, empty result, edge case — must include a next block.

### 5. Error Handling Pattern

Every tool handler MUST catch errors and return structured recovery guidance:

\`\`\`typescript
async (args) => {
  try {
    // Zod already validates input shape. Add business logic validation here.
    const result = doWork(args);
    return output({ status: 'success', data: { result }, message: 'Done.', next: { /* ... */ } });
  } catch (e: unknown) {
    return output({
      status: 'error',
      data: { error: String(e) },
      message: \`Failed: \${e instanceof Error ? e.message : String(e)}\`,
      next: {
        control: 'user',
        description: 'Review the error and decide how to proceed.',
        bootstrap_prompt: 'The operation failed. Check the error above and retry with corrected parameters, or choose an alternative approach.',
      },
    });
  }
}
\`\`\`

### 6. MCP Protocol Compliance

- Tool responses MUST use content array format: \`{ content: [{ type: "text", text: "..." }] }\`
- Resource URIs MUST have a scheme prefix (e.g., \`myserver://resource/path\`)
- Error codes MUST follow JSON-RPC 2.0 standard
- Server capabilities MUST list all registered capability types
- Prefer \`z.enum()\` over \`z.string()\` for parameters with known valid values

### 7. Facade Pattern

If the server has more than 5-7 tools, group related operations behind facade tools:
- Facade tools orchestrate complex workflows internally
- Keep internal tools available but clearly marked as advanced
- Users should rarely need to call internal tools directly

### 8. Import Discipline

- Use only the minimum required imports from \`@modelcontextprotocol/sdk\` and \`zod\`
- Prefer Node.js built-ins over external dependencies
- Do not introduce new runtime dependencies without explicit approval

### 9. Documentation Ships with Code

Every change MUST include corresponding documentation updates. Documentation is part of the definition of done — not a follow-up task.

Required documentation artifacts:
- **README.md** — Tool inventory (name, description, parameters), setup instructions, usage examples
- **Architecture docs** — Updated to reflect current module structure, data flow, and key decisions
- **Configuration reference** — All environment variables, config files, and their defaults
- **CHANGELOG** — Entry for every user-facing or developer-facing change
- **Inline docs** — JSDoc/TSDoc on exported functions with parameter descriptions

Verification checklist:
1. Every registered tool appears in the README tool inventory
2. Every tool in the README still exists in code
3. Setup instructions work for a fresh clone
4. Architecture description matches current module layout
5. Config reference covers all env vars and options`;
}

/**
 * Build a comprehensive documentation guide that instructs agents on which
 * documents to create or update after code changes. This is injected into
 * the `document` overlay's bootstrap prompt.
 */
export function buildDocumentationGuide(): string {
  return `## Documentation Update Requirements

Documentation ships with code. Every change that adds, removes, or modifies tools, resources, configuration, or architecture MUST update the corresponding documentation before the pipeline can proceed to release.

### Required Documentation Artifacts

#### 1. README.md — The Entry Point

The README is the first thing users and agents read. It MUST contain:

**Tool Inventory Table** — Every registered tool with:
- Tool name (exact match to code registration)
- One-line description of what it does
- Required vs optional parameters
- Brief usage example or link to detailed docs

**Setup Instructions** — Must work for a fresh clone:
- Prerequisites (Node.js version, required API keys, etc.)
- Install steps (\`npm install\`, env config, etc.)
- How to run (stdio, HTTP, etc.)
- How to verify it works (a smoke-test command or example)

**Configuration Reference** — Every configurable option:
- Environment variables with descriptions and defaults
- Config file format and location
- Required vs optional settings

**Quick-Start Examples** — At least one working example showing:
- How to connect to the server
- How to call the most common tool
- What the response looks like

#### 2. Architecture Documentation

If the server has more than a few files, maintain an architecture overview:
- Module/directory structure with brief descriptions
- Data flow diagram (can be text-based, e.g., mermaid)
- Key design decisions and why they were made
- Integration points (external APIs, databases, other servers)

Update this whenever:
- New modules or directories are added
- Data flow changes
- New external integrations are added
- Pipeline or overlay structure changes

#### 3. CHANGELOG

Maintain a CHANGELOG.md (or equivalent section in README) with:
- Version or date
- What changed (added, changed, removed, fixed)
- Migration notes if breaking changes were introduced

#### 4. Inline Documentation

Exported functions and types MUST have JSDoc/TSDoc:
- What the function does
- Parameter descriptions
- Return type and meaning
- Example usage for complex functions

### Verification Checklist

Before marking documentation complete:

1. **Tool-to-doc sync** — List all tools registered in code. List all tools in README. The two lists must match exactly. Flag any mismatch.
2. **Setup smoke test** — Read the setup instructions as if you are a new user. Would they work on a fresh machine? Flag any missing steps.
3. **Config completeness** — List all \`process.env\` reads and config file accesses. Every one must appear in the configuration reference.
4. **Architecture accuracy** — Does the architecture doc describe the current module structure? Flag any references to removed or renamed modules.
5. **CHANGELOG entry** — Does the CHANGELOG have an entry for the changes made in this pipeline? Flag if missing.
6. **No phantom references** — Search docs for tool names, config keys, or module names that no longer exist in code. Every one is a bug.
7. **Example validity** — Do code examples in docs use current API signatures? Flag any that reference old parameter names or removed tools.

### What NOT to Document

- Internal implementation details that change frequently (document the interface, not the internals)
- Auto-generated content that a build step produces (document where to find it, not the content itself)
- Secrets, API keys, or credentials (document that they are needed and where to set them, never the values)

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
