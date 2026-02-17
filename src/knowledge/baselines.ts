/**
 * Baseline Knowledge — encodes architectural patterns that mcp-refinery
 * itself uses, as evaluation criteria for other MCP servers.
 *
 * The refinery eats its own cooking. Every pattern here is something
 * the refinery does well, so it knows what to look for and recommend.
 *
 * Healthcare Compliance context:
 * The refinery creates and improves agentic development tools (e.g. Cursor
 * Context Layer). Neither the refinery nor those tools handle PHI directly.
 * However, the SOFTWARE those tools help build WILL handle PHI. The
 * compliance patterns evaluate whether managed MCP servers produce code,
 * architecture, and scaffolding that is safe for a healthcare software
 * vendor to ship into PHI-touching production environments.
 */

// ---------------------------------------------------------------------------
// Pattern Definitions
// ---------------------------------------------------------------------------

export type BaselineCategory =
  | 'architecture' | 'governance' | 'devex' | 'reliability'
  | 'security' | 'maintenance' | 'compliance';

export interface BaselinePattern {
  pattern_id: string;
  name: string;
  category: BaselineCategory;
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
    pattern_id: 'orphan_detection',
    name: 'Orphaned File and Artifact Detection',
    category: 'maintenance',
    description: 'After any refactor, restructuring, or module addition, verify that no files, directories, compiled outputs, or config references are orphaned. Orphans include: source files not imported by any module, compiled .js/.d.ts files with no corresponding source, empty or stub modules that serve no purpose, facade re-exports for removed modules, test files for removed code, and config entries for removed features.',
    why_it_matters: 'Orphaned files silently inflate bundle size, confuse contributors, and create phantom import paths that compile but serve no purpose. Orphaned build artifacts mask real compilation state. Orphaned configs can re-enable deleted features or cause runtime errors.',
    detection_hints: ['source files with no inbound imports', 'compiled output files with no corresponding source', 'empty index.ts that re-exports nothing or re-exports non-existent modules', 'test files testing removed functions', 'config entries referencing removed modules or features', 'facade files exporting symbols that no consumer imports'],
    recommendation_when_missing: 'After every structural change, trace the import graph from the entry point. Any source file unreachable from the entry is a candidate for removal. Check dist/ for compiled files with no source counterpart. Verify all facade re-exports resolve to live modules.',
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

  // -- Healthcare Compliance --------------------------------------------------
  // These patterns evaluate whether an agentic dev tool produces code,
  // architecture, and scaffolding that is safe for a healthcare software
  // vendor to ship into PHI-touching production environments.
  //
  // The tools themselves do NOT handle PHI. But the software they help
  // engineers build WILL. These patterns ensure compliance is baked in
  // at the development tooling layer, not bolted on after the fact.
  // ---------------------------------------------------------------------------

  {
    pattern_id: 'hc_encryption_at_rest',
    name: 'Encrypted Storage by Default',
    category: 'compliance',
    description: 'Code generated or scaffolded by this tool must default to encrypted storage patterns. Database schemas, file storage, caching layers, and any persistence must use AES-256 (or equivalent FIPS-approved symmetric cipher) with proper key management. Plaintext storage of data that could contain PHI must never appear in generated code without an explicit opt-out documented in the architecture.',
    why_it_matters: 'HIPAA 45 CFR § 164.312(a)(2)(iv) requires encryption of ePHI at rest. If the agentic dev tool scaffolds a service with plaintext storage, the healthcare vendor ships a HIPAA violation. Encryption must be the default, not an afterthought.',
    detection_hints: ['generated code writes plaintext JSON or CSV without encryption', 'database schemas without column-level or disk-level encryption', 'file storage without AES-256', 'caching layers storing data in plaintext', 'no key management pattern in generated architecture', 'generated config lacks encryption toggles'],
    recommendation_when_missing: 'All storage scaffolding must default to encrypted backends. Include AES-256-GCM encryption utilities in generated code. Provide key management patterns (envelope encryption, KMS integration hooks). Document that FIPS 140-2 validated modules are required in production.',
    severity: 'critical',
  },
  {
    pattern_id: 'hc_phi_boundary',
    name: 'PHI Boundary Demarcation',
    category: 'compliance',
    description: 'Architecture guidance and code scaffolding produced by this tool must include explicit PHI boundary markers. Data flow designs must identify where PHI enters the system, how it transits between components, where it is stored, and where it exits. Components that handle PHI must be architecturally separated from those that do not, with clear interface contracts at each boundary crossing.',
    why_it_matters: 'HIPAA requires the minimum necessary standard — PHI should only be accessible to components that need it. Without explicit boundaries, PHI leaks across services silently. A healthcare vendor needs to know exactly which components are "in scope" for HIPAA audits. Agentic dev tools that generate architecture without PHI boundaries force the vendor to retrofit them later, which is error-prone and expensive.',
    detection_hints: ['no data classification in generated schemas', 'no distinction between PHI and non-PHI data flows', 'generated services with direct access to all data stores', 'no access control annotations on generated API endpoints', 'architecture diagrams without PHI boundary lines', 'no data inventory or classification guidance'],
    recommendation_when_missing: 'Add PHI boundary annotations to generated architecture. Tag data fields as PHI/PII/non-sensitive in generated schemas. Generate separate service boundaries for PHI-touching and non-PHI components. Include data flow diagrams with PHI boundary markings in architecture outputs.',
    severity: 'critical',
  },
  {
    pattern_id: 'hc_fips_crypto',
    name: 'FIPS 140-2 Crypto Readiness',
    category: 'compliance',
    description: 'All cryptographic operations in generated code must use FIPS 140-2 approved algorithms: AES-128/256, SHA-256/384/512, RSA-2048+, ECDSA P-256/P-384, HMAC-SHA256+. Generated code must never use MD5, SHA-1, DES, 3DES, RC4, or custom/homebrew crypto for any security-relevant purpose. Crypto utility modules must document FIPS mode requirements and provide configuration hooks for enabling FIPS-validated OpenSSL providers.',
    why_it_matters: 'FIPS 140-2 (and its successor FIPS 140-3) is required by CMS MARS-E 2.2, NIST SP 800-171, and many state healthcare systems. Federal health data systems (Medicare, Medicaid, VA, DoD health) mandate FIPS-validated cryptography. If the dev tool generates code that uses non-FIPS algorithms, the healthcare vendor cannot deploy to these environments.',
    detection_hints: ['MD5 or SHA-1 used for any hashing', 'DES or 3DES in generated encryption code', 'custom crypto implementations', 'no FIPS mode configuration in generated crypto utilities', 'RSA keys under 2048 bits', 'no documentation of FIPS requirements in generated READMEs', 'crypto libraries without FIPS-validated builds'],
    recommendation_when_missing: 'Audit all crypto in generated code. Replace MD5/SHA-1 with SHA-256+. Replace DES/3DES with AES-256. Add FIPS mode configuration (Node.js: crypto.setFips(1), OpenSSL FIPS provider). Document that production deployments in healthcare require FIPS-compiled runtimes. Include a crypto compliance checklist in generated documentation.',
    severity: 'critical',
  },
  {
    pattern_id: 'hc_access_control',
    name: 'Authentication and RBAC by Default',
    category: 'compliance',
    description: 'Generated API endpoints, services, and administrative interfaces must include authentication and role-based access control scaffolding by default. No endpoint should be unauthenticated unless explicitly documented as a public health endpoint. Generated auth must support unique user identification, session management, and automatic logoff.',
    why_it_matters: 'HIPAA 45 CFR § 164.312(a)(1) requires access controls. § 164.312(a)(2)(i) requires unique user identification. § 164.312(a)(2)(iii) requires automatic logoff. If the dev tool scaffolds services without auth, every endpoint is a HIPAA violation waiting to be deployed. Healthcare vendors cannot ship unauthenticated services into production.',
    detection_hints: ['generated API routes with no auth middleware', 'no RBAC model in generated code', 'admin endpoints without elevated auth', 'no session timeout in generated auth flows', 'generated APIs without rate limiting', 'no unique user ID in generated audit patterns', 'anonymous access to state-changing endpoints'],
    recommendation_when_missing: 'All generated API scaffolding must include: auth middleware on every route (with explicit opt-out for public endpoints), RBAC with at least viewer/editor/admin roles, session management with configurable inactivity timeout (default 15 minutes per HIPAA guidance), and rate limiting. Include auth configuration in generated .env templates.',
    severity: 'critical',
  },
  {
    pattern_id: 'hc_audit_trail',
    name: 'HIPAA-Grade Audit Logging',
    category: 'compliance',
    description: 'Generated services must include audit logging for all state-changing operations that captures: who (authenticated user ID), what (action performed), when (timestamp), on what (resource/record affected), and outcome (success/failure). Audit logs must be append-only, tamper-evident, and include guidance for 6-year retention per HIPAA requirements.',
    why_it_matters: 'HIPAA 45 CFR § 164.312(b) requires audit controls. § 164.530(j) requires 6-year retention. Healthcare software without comprehensive audit trails cannot pass a HIPAA audit. If the dev tool generates services without audit logging, the vendor must retrofit it — which means inconsistent audit coverage, missed events, and audit gaps.',
    detection_hints: ['generated services with no audit logging', 'state-changing operations without audit entries', 'audit logs missing actor or timestamp', 'mutable audit logs', 'no retention policy in generated log configuration', 'no correlation IDs across service calls', 'audit logs without tamper evidence'],
    recommendation_when_missing: 'Generate audit logging middleware for every service. Log all CRUD operations, auth events, and admin actions. Include actor, action, target, timestamp, outcome, and correlation ID. Configure append-only log storage. Add retention policy documentation (minimum 6 years). Include tamper-evidence (hash chaining or HMAC signing) in the audit module.',
    severity: 'critical',
  },
  {
    pattern_id: 'hc_transmission_security',
    name: 'TLS 1.2+ Transmission Security',
    category: 'compliance',
    description: 'All network communication in generated code must enforce TLS 1.2 or higher. Generated service configurations must disable TLS 1.0/1.1 and SSLv3. Certificate validation must be enforced — no generated code should include options to skip TLS verification in production. Inter-service communication must use mTLS or equivalent where feasible.',
    why_it_matters: 'HIPAA 45 CFR § 164.312(e)(1) requires transmission security. PCI DSS (often co-required in healthcare billing) mandates TLS 1.2+. If the dev tool generates HTTP configurations that allow plaintext or weak TLS, the downstream service is vulnerable in transit.',
    detection_hints: ['generated HTTP clients without TLS enforcement', 'NODE_TLS_REJECT_UNAUTHORIZED=0 in generated config', 'TLS 1.0 or 1.1 not explicitly disabled', 'no certificate pinning guidance', 'plaintext HTTP URLs in generated integration code', 'database connections without SSL/TLS', 'message queue connections without encryption in transit'],
    recommendation_when_missing: 'All generated network code must use HTTPS. Generated server configs must explicitly disable TLS 1.0/1.1. Include TLS configuration in generated .env templates. Never generate code that skips certificate validation. Add mTLS examples for inter-service communication. Document minimum TLS version requirements in generated READMEs.',
    severity: 'critical',
  },
  {
    pattern_id: 'hc_minimum_necessary',
    name: 'Minimum Necessary Data Pattern',
    category: 'compliance',
    description: 'Generated queries, API responses, and data access patterns must follow the minimum necessary principle. No SELECT * patterns in generated database queries. API response schemas must return only the fields needed for each operation. Generated data access layers must support field-level access control. Report and export functions must include field filtering.',
    why_it_matters: 'HIPAA 45 CFR § 164.502(b) establishes the minimum necessary standard — covered entities must limit PHI use, disclosure, and requests to the minimum necessary. If the dev tool generates broad data access patterns, the downstream software over-exposes PHI in every query and response.',
    detection_hints: ['SELECT * in generated queries', 'API responses returning entire database records', 'no field-level projection in generated data layers', 'generated export functions with no field filtering', 'no data minimization guidance in generated architecture', 'GraphQL schemas without field-level auth'],
    recommendation_when_missing: 'Generate data access layers with explicit field selection. Use DTOs/view models in generated APIs — never return raw database entities. Add field-level access control hooks. Include data minimization guidance in generated architecture docs. Generate query builders that require explicit field lists.',
    severity: 'high',
  },
  {
    pattern_id: 'hc_error_sanitization',
    name: 'Compliant Error Handling',
    category: 'compliance',
    description: 'Generated error responses must never leak PHI, PII, internal system details, stack traces, or database query text to clients. Error handlers must sanitize responses before returning them. Internal error details must be logged to the audit trail (not the client response). Generated validation errors must reference field names without echoing back sensitive field values.',
    why_it_matters: 'PHI in error responses is a data breach. Stack traces reveal system internals useful for attacks. Database errors may include query fragments containing PHI. If the dev tool generates pass-through error handling, every exception in production risks exposing PHI or enabling exploitation.',
    detection_hints: ['generated error handlers that pass raw exceptions to clients', 'stack traces in generated API error responses', 'database errors forwarded to HTTP responses', 'validation errors echoing back input values', 'no error sanitization middleware in generated code', 'generated catch blocks that return err.message directly'],
    recommendation_when_missing: 'Generate error handling middleware that: returns generic client-safe error codes (not raw messages), logs full details to the audit trail, never echoes input values in validation errors, strips stack traces from production responses, and uses correlation IDs to link client errors to internal logs.',
    severity: 'high',
  },
  {
    pattern_id: 'hc_data_integrity',
    name: 'Data Integrity Controls',
    category: 'compliance',
    description: 'Generated storage operations must include integrity verification. Database operations should use transactions. File operations should use atomic writes (write-to-temp, fsync, rename). Generated schemas must include constraints, foreign keys, and check constraints. Import/export operations must include checksums.',
    why_it_matters: 'HIPAA 45 CFR § 164.312(c)(1) requires integrity controls to protect ePHI from improper alteration or destruction. Corrupted health data can have patient safety implications. If the dev tool generates storage patterns without integrity guarantees, the downstream software risks silent data corruption.',
    detection_hints: ['generated write operations without transactions', 'no atomic write patterns in file storage', 'database schemas without constraints', 'import/export without checksums', 'no backup/restore patterns in generated architecture', 'optimistic writes without conflict detection'],
    recommendation_when_missing: 'Generate data access layers with transactional boundaries. Include atomic write patterns for file operations. Add database constraints (NOT NULL, CHECK, FK) in generated schemas. Include checksum validation for data import/export. Generate backup/restore scaffolding with integrity verification.',
    severity: 'high',
  },
  {
    pattern_id: 'hc_baa_aware_integration',
    name: 'BAA-Aware Third-Party Integration',
    category: 'compliance',
    description: 'When generating code that integrates with third-party services (cloud providers, APIs, SaaS tools, AI/ML services), the tool must flag that BAA status needs to be verified for any service that could process, store, or transmit PHI. Generated integration code must include comments or documentation markers identifying BAA-required touchpoints. Cloud service scaffolding must default to HIPAA-eligible service tiers.',
    why_it_matters: 'HIPAA 45 CFR § 164.502(e) requires Business Associate Agreements with any entity that handles PHI on behalf of a covered entity. If the dev tool generates integrations with third-party services without BAA flags, the healthcare vendor may unknowingly send PHI to a non-BAA service — a direct HIPAA violation with breach notification obligations.',
    detection_hints: ['third-party API integrations with no BAA documentation', 'cloud service scaffolding using non-HIPAA-eligible tiers', 'AI/ML API calls without BAA status comments', 'generated vendor integration code without compliance annotations', 'no BAA checklist in generated integration documentation'],
    recommendation_when_missing: 'Add BAA compliance annotations to all generated third-party integration code. Include a BAA verification checklist in generated documentation. Default cloud service scaffolding to HIPAA-eligible tiers (AWS: BAA-covered services, Azure: HIPAA-compliant services, GCP: BAA-covered services). Flag AI/ML API integrations for BAA review.',
    severity: 'high',
  },
  {
    pattern_id: 'hc_supply_chain',
    name: 'Supply Chain Security for Generated Code',
    category: 'compliance',
    description: 'Generated dependency manifests (package.json, requirements.txt, pom.xml, etc.) must pin exact versions — no caret or tilde ranges. Generated build pipelines must include dependency vulnerability scanning (npm audit, pip-audit, etc.). Generated projects must include SBOM generation configuration (SPDX or CycloneDX). Dependency allowlists must be provided for healthcare contexts.',
    why_it_matters: 'Executive Order 14028 requires SBOM for software sold to federal agencies. FDA SaMD guidance recommends SBOM for medical software. Healthcare vendors must demonstrate supply chain integrity to auditors. If the dev tool generates projects with unpinned dependencies and no vulnerability scanning, the vendor inherits unknown supply chain risk.',
    detection_hints: ['caret or tilde version ranges in generated manifests', 'no vulnerability scanning in generated CI pipelines', 'no SBOM generation configuration', 'generated projects pulling from unpinned registries', 'no dependency review step in generated PR workflows', 'no license compliance checking'],
    recommendation_when_missing: 'Pin exact versions in all generated dependency manifests. Include npm audit / pip-audit / equivalent in generated CI pipelines. Add SBOM generation (CycloneDX or SPDX) to generated build configuration. Include a dependency governance section in generated docs that covers: version pinning policy, vulnerability scanning frequency, and license compliance.',
    severity: 'high',
  },
  {
    pattern_id: 'hc_breach_hooks',
    name: 'Incident Response and Breach Detection Hooks',
    category: 'compliance',
    description: 'Generated architectures must include hooks for incident response and breach detection: anomaly detection on access patterns, alerting on bulk data exports, failed auth attempt tracking, and data access logging sufficient to scope a breach. Generated runbook scaffolding must include a breach response template.',
    why_it_matters: 'The HIPAA Breach Notification Rule (45 CFR §§ 164.400-414) requires breach notification within 60 days. Scoping a breach requires knowing exactly what data was accessed, by whom, and when. If the dev tool generates services without breach detection capabilities, the healthcare vendor cannot meet breach notification timelines and may be unable to determine breach scope at all.',
    detection_hints: ['no anomaly detection hooks in generated access layers', 'no alerting on bulk data operations', 'no failed auth tracking', 'no data access logging sufficient for breach scoping', 'no incident response template in generated documentation', 'no breach severity classification guidance'],
    recommendation_when_missing: 'Generate access monitoring hooks: alert on bulk exports, track failed auth attempts, log all data access with sufficient detail for breach scoping. Include a breach response runbook template in generated docs. Add breach severity classification guidance. Include hooks for security incident event emission (SIEM integration).',
    severity: 'high',
  },
  {
    pattern_id: 'hc_hipaa_safeguard_coverage',
    name: 'HIPAA Technical Safeguard Coverage',
    category: 'compliance',
    description: 'A meta-pattern that evaluates whether the generated server or tool addresses all four HIPAA Technical Safeguard categories: (1) Access Control — unique user IDs, emergency access, automatic logoff, encryption/decryption; (2) Audit Controls — record and examine activity; (3) Integrity Controls — protect data from improper alteration/destruction, authentication of transmitted data; (4) Transmission Security — integrity controls and encryption for data in transit. Each category must have at least one concrete implementation pattern in the generated architecture.',
    why_it_matters: 'HIPAA Technical Safeguards (45 CFR § 164.312) are the regulatory floor for any system handling ePHI. A healthcare vendor must demonstrate coverage of all four categories. If even one category is missing from the generated architecture, the vendor has a regulatory gap that will be found in audit. This meta-pattern ensures nothing is missed.',
    detection_hints: ['no access control pattern in generated architecture', 'no audit logging in generated services', 'no data integrity controls', 'no transmission encryption enforcement', 'generated architecture missing one or more HIPAA Technical Safeguard categories', 'no HIPAA compliance section in generated documentation'],
    recommendation_when_missing: 'Add a HIPAA Technical Safeguard compliance section to the generated architecture document. Map each safeguard to concrete implementation: Access Control → auth middleware + RBAC + session management; Audit Controls → audit logging + tamper evidence; Integrity → transactions + checksums + atomic writes; Transmission → TLS 1.2+ + mTLS. Include a compliance verification checklist.',
    severity: 'critical',
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getAllPatterns(): BaselinePattern[] {
  return [...PATTERNS];
}

export function getPatternsByCategory(category: BaselineCategory): BaselinePattern[] {
  return PATTERNS.filter((p) => p.category === category);
}

export function getCriticalPatterns(): BaselinePattern[] {
  return PATTERNS.filter((p) => p.severity === 'critical' || p.severity === 'high');
}

/**
 * Get all healthcare compliance patterns. These evaluate whether an agentic
 * dev tool produces code/architecture safe for healthcare software vendors.
 */
export function getCompliancePatterns(): BaselinePattern[] {
  return PATTERNS.filter((p) => p.category === 'compliance');
}

/**
 * Get compliance patterns by severity. Useful for phased rollout —
 * enforce critical patterns first, then add high/medium.
 */
export function getCompliancePatternsBySeverity(severity: BaselinePattern['severity']): BaselinePattern[] {
  return PATTERNS.filter((p) => p.category === 'compliance' && p.severity === severity);
}

/**
 * Build a baseline evaluation prompt section that can be injected into
 * research prompts. This teaches the agent WHAT good looks like.
 */
export function buildBaselinePromptSection(categories?: BaselineCategory[]): string {
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
 * Build a healthcare compliance evaluation prompt section. Injected into
 * research prompts when the target server has a healthcare compliance profile.
 *
 * Key framing: the target server is an agentic dev tool. It does NOT handle
 * PHI. But the software it helps build WILL. These patterns evaluate whether
 * the tool produces compliant output.
 */
export function buildCompliancePromptSection(): string {
  const compliancePatterns = getCompliancePatterns();

  const lines = [
    '## Healthcare Compliance Patterns (evaluate the server against these)',
    '',
    'IMPORTANT CONTEXT: The target server is an agentic development tool. It does NOT handle PHI directly.',
    'However, the software that this tool helps build WILL handle PHI in a healthcare production environment.',
    'Evaluate whether the tool produces code, architecture, and scaffolding that meets healthcare regulatory requirements.',
    '',
    'Regulatory framework: HIPAA Technical Safeguards (45 CFR § 164.312), FIPS 140-2/140-3,',
    'HIPAA Breach Notification Rule (45 CFR §§ 164.400-414), NIST SP 800-171, CMS MARS-E 2.2,',
    'Executive Order 14028 (SBOM), FDA SaMD guidance where applicable.',
    '',
  ];

  for (const p of compliancePatterns) {
    lines.push(`### ${p.name} [${p.severity}]`);
    lines.push(p.description);
    lines.push(`**Regulatory basis**: ${p.why_it_matters}`);
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

### Orphaned Files and Artifacts

23. **Unreachable source files** — Trace imports from the entry point (src/index.ts or equivalent). Any .ts source file not reachable through the import graph is orphaned. Flag it for removal or re-integration.
24. **Stale compiled output** — Check dist/ or build output for .js/.d.ts files whose source .ts files have been deleted or renamed. Delete them.
25. **Empty or stub modules** — Check for index.ts files that export nothing, or modules that contain only commented-out code or placeholder stubs. Either fill them or remove them.
26. **Orphaned facade re-exports** — Check each facade index.ts. Every re-exported symbol must resolve to a live module. Flag any re-exports pointing to deleted or renamed files.
27. **Dead test files** — Check for test files that import or reference functions, classes, or modules that no longer exist. Update or remove them.
28. **Config ghost entries** — Check config files, .env templates, and environment variable documentation for references to removed features, modules, or tools. Remove them.
29. **Misaligned directory structure** — Check that the directory structure matches the module architecture. Flag directories that are empty, contain only dead code, or whose purpose no longer matches their name.

### Documentation Currency (for every change)

30. **README tool inventory sync** — List all tools registered in code (grep for server.tool\(). List all tools described in README. The two lists must match exactly. Flag any tool in code but not in README, or in README but not in code. Include tool count comparison.
31. **Setup instructions validity** — Read the setup/install section. Does it reference current dependencies, correct commands, and valid config? Flag outdated steps.
32. **Configuration reference completeness** — List all process.env reads and config accesses in code. Every one must appear in the documentation. Flag any undocumented config.
33. **Architecture doc accuracy** — Does the architecture documentation describe the current module structure, overlay order, and data flow? Compare COMMAND_OVERLAYS in orchestrator.ts with overlay sequences in ARCHITECTURE.md. Flag references to removed or renamed modules.
34. **CHANGELOG entry** — Does a CHANGELOG (or equivalent) have an entry for the changes made? Flag if missing.
35. **No phantom doc references** — Search documentation for tool names, config keys, file paths, or module names that no longer exist in code. Every one is a stale reference.
36. **Example code validity** — Do code examples in documentation use current API signatures, parameter names, and tool names? Flag any that reference old or removed interfaces.
37. **Diagram accuracy** — Do Mermaid or ASCII diagrams in docs reflect actual code flow? Compare pipeline diagrams with COMMAND_OVERLAYS, agent diagrams with registry.ts, storage diagrams with database.ts stores. Flag any diagram showing removed stages, missing new stages, or incorrect relationships.
38. **Documentation guide self-consistency** — Does buildDocumentationGuide() in baselines.ts reference the current set of required documentation artifacts? Flag if the guide references artifacts the system no longer produces or misses new ones.
39. **Feedback loop integration** — After pipeline completion, was a feedback entry recorded? Check that strengths, weaknesses, and lessons are captured. Flag pipelines that completed without feedback.

### Healthcare Compliance (when compliance profile is active)

40. **Encryption defaults** — Does generated storage code default to AES-256 encryption? Flag any plaintext persistence patterns.
41. **PHI boundary markers** — Does generated architecture include explicit PHI boundary demarcation? Flag data flows without classification.
42. **FIPS crypto compliance** — Does generated code use only FIPS 140-2 approved algorithms? Flag MD5, SHA-1, DES, 3DES, RC4, custom crypto.
43. **Auth scaffolding** — Do generated APIs include auth middleware and RBAC by default? Flag unauthenticated endpoints.
44. **Audit logging** — Do generated services include audit logging for state-changing operations? Flag services without audit middleware.
45. **TLS enforcement** — Does generated network code enforce TLS 1.2+? Flag plaintext HTTP, disabled cert validation, TLS 1.0/1.1.
46. **Minimum necessary** — Do generated queries use explicit field selection? Flag SELECT * and full-record API responses.
47. **Error sanitization** — Do generated error handlers strip PHI and stack traces from client responses? Flag pass-through error handling.
48. **BAA annotations** — Do generated third-party integrations include BAA verification flags? Flag unmarked external service integrations.
49. **Supply chain** — Do generated manifests pin exact versions? Is vulnerability scanning in generated CI? Flag caret/tilde ranges.
50. **HIPAA coverage** — Does generated architecture address all four Technical Safeguard categories (Access, Audit, Integrity, Transmission)?

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
  return `## Gold Standard Documentation Requirements

Documentation is a first-class deliverable — not an afterthought. Every change that adds, removes, or modifies tools, resources, configuration, or architecture MUST update documentation before the pipeline proceeds to release. Documentation must be optimized for **human readability** with visual aids where they add clarity.

### Design Principles for Documentation

1. **Lead with WHY, not WHAT** — Explain the purpose and mental model before listing parameters
2. **Use diagrams for flow** — Mermaid diagrams for pipelines, state machines, and data flows
3. **Show, don't tell** — Concrete examples over abstract descriptions
4. **Progressive disclosure** — Quick-start first, deep-dive later
5. **Machine-readable AND human-readable** — Structured tables for tools, prose for concepts

### Required Documentation Artifacts

#### 1. README.md — The Entry Point

The README is the first thing users and agents read. Structure it for progressive disclosure:

**System Description** — 2-3 sentences explaining WHAT the system does and WHY it exists. Written for a human who has never heard of MCP. Include a Mermaid diagram showing the high-level flow:

\`\`\`mermaid
graph LR
  A[User Intent] --> B[Research]
  B --> C[Decision]
  C --> D{Align?}
  D -->|Approved| E[Execute]
  D -->|Rejected| F[Redirect]
  E --> G[Cleanup]
  G --> H[Release]
\`\`\`

**Tool Catalog** — Every registered tool in a structured table with:
| Column | Description |
|--------|-------------|
| Tool name | Exact match to code registration |
| Category | Facade / Research / Decision / Delivery / Governance / Routing / Knowledge |
| Description | What it does, when to use it (1-2 sentences) |
| Key params | Required parameters with types |
| Returns | What to expect in the response |

Group tools by category. Facade tools go first with a clear "START HERE" marker.

**Quick-Start** — A working example from zero to first result:
- Prerequisites, install, run commands
- A single copy-paste example that produces output
- What the output means

**Configuration Reference** — Every env var and config option:
- Name, type, default, description
- Grouped by concern (storage, routing, keys)

#### 2. Architecture Documentation (ARCHITECTURE.md)

For any system with more than a few files, maintain a living architecture document:

**System Diagram** — Use a Mermaid diagram showing the major components and their relationships:

\`\`\`mermaid
graph TD
  subgraph "Tool Layer"
    F[Facade Tools]
    I[Internal Tools]
  end
  subgraph "Processing Planes"
    R[Research] --> D[Decision] --> DL[Delivery]
  end
  subgraph "Infrastructure"
    S[Storage] --> A[Audit]
    V[Vector Index]
  end
  F --> R
  I --> D
  DL --> S
\`\`\`

**Pipeline Flow Diagram** — For systems with pipelines or state machines, include a Mermaid flowchart showing the overlay sequence, decision points, and user gates:

\`\`\`mermaid
flowchart TD
  START([User: refine]) --> RESEARCH[Research\\n5 perspectives]
  RESEARCH --> CLASSIFY[Classify\\ncomplexity + tier]
  CLASSIFY --> TRIAGE[Triage\\nranked proposals]
  TRIAGE --> ALIGN{{"⚡ ALIGN\\nUser approves?"}}
  ALIGN -->|Yes| PLAN[Plan\\ndelivery strategy]
  ALIGN -->|No| REDIRECT[Redirect]
  PLAN --> EXECUTE[Execute\\nPR creation]
  EXECUTE --> CLEANUP[Cleanup\\nverification]
  CLEANUP --> DOCUMENT[Document\\ndocs update]
  DOCUMENT --> RELEASE[Release\\nSemVer]
  RELEASE --> PROPAGATE[Propagate\\ncross-server]
\`\`\`

**Module Map** — Directory tree with brief descriptions of each module's purpose.

**Key Decisions** — Why major architectural choices were made (link to ADRs where available).

Update architecture docs whenever:
- New modules or directories are added
- Pipeline overlay order changes
- New storage collections are added
- Agent roster or model routing changes
- New tool categories are introduced

#### 3. CHANGELOG

Maintain a CHANGELOG.md (or section in README) with:
- Version or date
- What changed: added / changed / removed / fixed
- Migration notes for breaking changes
- Link to the pipeline or proposal that drove the change

#### 4. Inline Documentation

Exported functions and types MUST have JSDoc/TSDoc:
- What the function does (one sentence)
- @param descriptions for non-obvious parameters
- @returns description of return shape
- Example usage for functions with complex signatures

### Diagram Requirements

When documentation describes a flow, state machine, or architecture:

1. **Prefer Mermaid** — Renderable in GitHub, Cursor, VS Code, and most doc systems
2. **Use flowchart for pipelines** — Shows decision points, gates, and branches
3. **Use graph for architecture** — Shows component relationships
4. **Use sequenceDiagram for interactions** — Shows tool call chains and agent handoffs
5. **Keep diagrams in sync with code** — When overlay order changes in COMMAND_OVERLAYS, update the pipeline diagram. When agents change in registry.ts, update the agent diagram.
6. **One diagram per concept** — Don't overload a single diagram. Multiple focused diagrams are better than one complex one.

### Verification Checklist

Before marking documentation complete:

1. **Tool-to-doc sync** — grep for server.tool( in code. Count tools in README catalog. Numbers must match exactly.
2. **Diagram accuracy** — Compare pipeline diagrams with COMMAND_OVERLAYS in orchestrator.ts. All stages must appear in correct order.
3. **Setup smoke test** — Read setup instructions as a new user. Would they work on a fresh machine?
4. **Config completeness** — List all process.env reads in code. Every one must appear in docs.
5. **Architecture accuracy** — Does ARCHITECTURE.md describe the current module structure? Flag stale references.
6. **CHANGELOG entry** — Does the CHANGELOG have an entry for this pipeline's changes?
7. **No phantom references** — Search docs for tool names, config keys, or modules that no longer exist in code.
8. **Example validity** — Do code examples use current API signatures and parameter names?
9. **Mermaid renderability** — Verify all Mermaid code blocks render correctly (valid syntax, no broken references).

### What NOT to Document

- Internal implementation details that change frequently (document the interface, not internals)
- Auto-generated content from build steps (document where to find it)
- Secrets or credentials (document that they're needed and where to set them, never values)

Return findings as structured JSON — same format as research findings.`;
}

/**
 * Build a comprehensive cleanup guide for post-implementation and evaluation
 * phases. Covers code hygiene, orphaned file detection, cross-module alignment,
 * and documentation currency. Designed to be injected into any step that produces
 * or modifies code.
 */
export function buildCleanupGuide(): string {
  return `## Post-Implementation Cleanup Guide

Run this cleanup pass after implementing changes and BEFORE evaluation or release.
Every change leaves artifacts. This guide catches them systematically.

### Phase 1: Code-Level Cleanup

**Unused Imports**
For every modified file, check each import statement:
- Is every imported symbol actually used in the file body?
- Are there namespace imports (\`import * as X\`) where only 1-2 symbols are used?
- Are there type-only imports that should use \`import type\`?

**Dead Exports**
For every facade module (index.ts re-export files):
- Does every \`export { X } from './module.js'\` resolve to a real module?
- Is every exported symbol imported by at least one consumer?
- Are there re-exports of renamed or removed functions?

**Orphaned Types**
In type definition files:
- Is every exported type/interface used by at least one module?
- Are there union type members (e.g., AuditAction values) that no code path produces?
- Are there interfaces that were replaced by newer versions but never removed?

**Stale Comments**
In modified files:
- Do comments reference functions, modules, or behaviors that no longer exist?
- Are there TODO/FIXME comments for issues that have been resolved?
- Are there JSDoc @param tags for parameters that were renamed or removed?

### Phase 2: File-System Cleanup

**Orphaned Source Files**
Trace the import graph from the entry point (src/index.ts):
- Every .ts file in src/ should be reachable through imports
- Files not in the import graph are orphaned — remove or re-integrate
- Watch for files that are only imported by other orphaned files (orphan chains)

**Stale Build Artifacts**
In dist/ or build output:
- Delete .js/.d.ts files whose source .ts file has been removed
- Delete .js.map files for removed sources
- Verify the bundle doesn't include dead code from removed modules

**Empty Modules**
Check for modules that contain:
- Only commented-out code
- Only re-exports that all point to the same downstream module
- Only a single type definition that could live in the parent module
- No actual logic or meaningful re-exports

**Misaligned Directory Structure**
- Do directory names still match their contents?
- Are there directories with only 1 file that should be collapsed?
- Are there directories that mix concerns (e.g., types + handlers + utils)?

### Phase 3: Cross-Module Alignment

**Interface Contracts**
For every function that is called across module boundaries:
- Does the caller's argument list match the function signature?
- Are there type assertions (\`as\`) that mask misaligned types?
- Do generic type parameters match between definition and usage?

**Re-export Chains**
For facade modules that re-export from sub-modules:
- Does the facade export everything that consumers need?
- Are there symbols imported directly from sub-modules that should go through the facade?
- Are type exports separated from value exports where needed?

**Configuration Alignment**
- Do config defaults in code match documentation?
- Are new config fields properly defaulted for backward compatibility?
- Are removed config fields cleaned up from all readers?

### Phase 4: Documentation Sync

**Tool Inventory**
- List all tools registered in code (grep for \`server.tool(\`)
- List all tools described in README
- The two lists must match exactly
- Check that tool descriptions in README match the code

**Architecture Docs**
- Does the architecture description match current module structure?
- Are there references to removed or renamed modules?
- Is the pipeline/overlay order documented correctly?

**Inline Documentation**
- Do exported functions have JSDoc/TSDoc comments?
- Do JSDoc parameter names match actual parameter names?
- Are return type descriptions accurate?

### Output

Report all findings. For each finding:
- What: The specific issue found
- Where: File path and line number (if applicable)
- Why: Why this is a problem
- Fix: The specific action to take

Prioritize: security issues > broken imports > dead code > stale docs > cosmetic issues.`;
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

// ---------------------------------------------------------------------------
// Continuous Improvement — Feedback Prompt Integration
// ---------------------------------------------------------------------------

import type { FeedbackEntry } from '../types/index.js';

/**
 * Build a feedback prompt section that injects lessons learned from past
 * pipeline runs into research prompts. This creates the learning loop:
 *
 *   improve → feedback → research (informed by feedback) → improve (better)
 *
 * The section is injected into research prompts so the agent starts each
 * cycle with institutional memory, not a blank slate.
 */
export function buildFeedbackPromptSection(feedback: FeedbackEntry[]): string {
  if (feedback.length === 0) {
    return '';
  }

  const sections: string[] = [];
  sections.push('## Institutional Memory — Lessons from Past Pipelines');
  sections.push('');
  sections.push('The following strengths and weaknesses were captured from previous improvement cycles.');
  sections.push('Use these to focus your analysis: reinforce what works, address what failed.');
  sections.push('');

  // Aggregate strengths and weaknesses across recent feedback
  const strengthMap = new Map<string, number>();
  const weaknessMap = new Map<string, number>();
  const lessonMap = new Map<string, number>();

  for (const entry of feedback.slice(0, 10)) {
    for (const s of entry.strengths) {
      strengthMap.set(s, (strengthMap.get(s) ?? 0) + 1);
    }
    for (const w of entry.weaknesses) {
      weaknessMap.set(w, (weaknessMap.get(w) ?? 0) + 1);
    }
    for (const l of entry.lessons_learned) {
      lessonMap.set(l, (lessonMap.get(l) ?? 0) + 1);
    }
  }

  if (strengthMap.size > 0) {
    sections.push('### Known Strengths (reinforce these)');
    const sorted = [...strengthMap.entries()].sort((a, b) => b[1] - a[1]);
    for (const [strength, count] of sorted.slice(0, 8)) {
      sections.push(`- ${strength}${count > 1 ? ` (observed ${count}x)` : ''}`);
    }
    sections.push('');
  }

  if (weaknessMap.size > 0) {
    sections.push('### Known Weaknesses (prioritize addressing these)');
    const sorted = [...weaknessMap.entries()].sort((a, b) => b[1] - a[1]);
    for (const [weakness, count] of sorted.slice(0, 8)) {
      sections.push(`- ${weakness}${count > 1 ? ` (observed ${count}x)` : ''}`);
    }
    sections.push('');
  }

  if (lessonMap.size > 0) {
    sections.push('### Lessons Learned');
    const sorted = [...lessonMap.entries()].sort((a, b) => b[1] - a[1]);
    for (const [lesson, count] of sorted.slice(0, 5)) {
      sections.push(`- ${lesson}${count > 1 ? ` (confirmed ${count}x)` : ''}`);
    }
    sections.push('');
  }

  sections.push(`*Based on ${feedback.length} previous pipeline run(s).*`);
  return sections.join('\n');
}
