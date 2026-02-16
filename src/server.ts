/**
 * MCP Refinery Server — zero external deps beyond MCP SDK.
 * All state lives in data/ as JSON files. No workspace pollution.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools/index.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { loadConfig, getConfig } from './config.js';
import { initDatabase, upsertTargetServer, getTargetServer } from './storage/database.js';

const SERVER_INSTRUCTIONS = `MCP Refinery (aliases: "m-r", "mr") is an agentic delivery system for improving MCP servers. It evaluates servers against proven architectural patterns from its own design, and ensures every change goes through user alignment before execution.

When the user says "consult with m-r", "ask mr", "use mcp-refinery", or any variation — they mean this server. Use the facade tools below.

## Feeding large research content

When the user provides a long research article, deep analysis, or any large body of text:
1. If they reference a file (e.g. @research.md), read it first, then pass the full content to the **ingest** tool's \`content\` parameter or the **refine** tool's \`research_content\` parameter.
2. If they paste text directly in the prompt, capture it and pass it the same way.
3. The system handles articles of any length — it splits analysis across multiple perspectives automatically.

## How to use

Start with one of the **facade tools** — they orchestrate everything automatically:

- **ingest** — Feed in a research article or deep analysis. The system extracts structured findings, evaluates them against baseline quality patterns, computes consensus, and produces proposals. Primary entry point when the user pastes external content.
- **refine** — Run a full improvement pipeline (research → classify → triage → align → plan → execute → cleanup → release → propagate). Can also accept research_content.
- **consult** — Ask specialist agents (Architecture, Security, etc.) to deliberate. Includes an alignment gate — no changes proceed without user confirmation.
- **pipeline_next** — Advance an active pipeline. The orchestrator handles agent and model selection.
- **pipeline_status** — Check where a pipeline stands.

## Pipeline overlays

Every pipeline passes through these stages in order:

1. **Research** — Multi-perspective analysis, evaluated against baseline quality patterns
2. **Classify** — Task complexity and model routing
3. **Deliberate** — Multi-model deliberation for critical decisions (auto-injected when needed)
4. **Triage** — Ranked proposals with governance awareness
5. **Align** — USER APPROVAL REQUIRED — presents proposed changes and waits for explicit confirmation before any tool behavior changes
6. **Plan** — Delivery planning
7. **Execute** — PR creation and implementation
8. **Cleanup** — Post-change verification pass (checks for stale imports, dead code, misaligned references, orphaned types)
9. **Release** — Semantic versioning
10. **Propagate** — Checks if improvements apply to other managed servers

## Self-improvement

The refinery can improve itself. When the user says "improve yourself", "refine yourself", "improve m-r", or any variation:
- Use \`target_server_id="self"\` (or "mr", "m-r", "mcp-refinery") — they all resolve to the refinery's own codebase
- The refinery auto-registers itself on startup with server_id="self"
- Self-improvement uses the exact same pipeline, alignment gates, and cleanup passes as improving any other server
- The refinery's own source path and tool list are auto-injected as context — no manual configuration needed
- From ANY workspace, you can say "have m-r improve itself" and it works

## Critical rules

- ALWAYS pause at the **align** overlay — show the user what will change and wait for approval
- ALWAYS run the **cleanup** overlay after changes — catch what the build step missed
- When control="user", STOP and present the decision to the user
- When control="agent", proceed with the bootstrap prompt immediately
- The system evaluates servers against its own baseline patterns (facade, decoupling, anti-oscillation, etc.)
- Universal improvements are flagged for propagation to all managed servers

## ResearchOps — Governed Research Lifecycle

The refinery includes a first-class ResearchOps subsystem that turns raw research into frozen, implementation-grade change proposals. Use these tools for structured, auditable self-improvement:

- **research_new** — Create a new Research Case (RC-YYYYMMDD-slug). Declares target system, risk lane, PHI classification, and goals.
- **research_advance** — Advance a case through the pipeline: intake → synthesize → review → decide → freeze → implement → evaluate → release
- **research_status** — Check case progress or list all cases
- **research_consult** — Query a case for decisions, evidence, or artifacts
- **research_validate** — Run deterministic validation (structure, PHI, reviews, freeze, budget)

### Research Case Pipeline

1. **Intake** — Scaffold case, declare constraints
2. **Synthesize** — Ingest raw sources (ChatGPT, Gemini, etc. — never executed, never trusted), produce synthesis + evidence matrix
3. **Review** — Unchained parallel reviews (architecture, security, ops, cost, adversarial) — reviewers write independent verdicts, never mutate proposal text
4. **Decide** — Council Chair consolidates into decision + frozen proposal + implementation brief
5. **Freeze** — ALIGNMENT GATE — user approves the frozen scope contract
6. **Implement** — Execute from contract, changes ONLY within scope
7. **Evaluate** — Tests, policy checks, stability checks
8. **Release** — Release notes, rubric updates, institutional learning

### Safety Constraints

- Change budget per case (max PRs, max iterations) — prevents runaway loops
- PHI classification blocks external LLM ingestion when not "none"
- Proposal freeze is immutable — scope changes require a new case
- Reviewers are read-only — cannot mutate each other's output or the proposal

## Do NOT use the internal tools directly unless you have a specific reason. The facade tools handle orchestration.`;

/** Self-register the refinery as target_server_id="self" so it can improve itself. */
function registerSelf(): void {
  if (getTargetServer('self')) return;
  const config = getConfig();
  const now = new Date().toISOString();
  upsertTargetServer({
    server_id: 'self',
    name: 'MCP Refinery',
    repo_url: config.storage.source_path ? `file://${config.storage.source_path}` : 'https://github.com/jfoster80/mcp-refinery',
    branch: 'main',
    transport: 'stdio',
    auth_mode: 'none',
    autonomy_level: 'pr_only',
    change_budget_per_window: 5,
    window_hours: 24,
    allowed_categories: [],
    scorecard_weights: { security: 0.3, reliability: 0.25, devex: 0.2, performance: 0.15, governance: 0.1 },
    created_at: now,
    updated_at: now,
  });
}

export function createServer(): McpServer {
  loadConfig();
  initDatabase();
  registerSelf();

  const server = new McpServer(
    {
      name: 'mcp-refinery',
      version: '0.2.0',
    },
    {
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  import('./decision/policy.js').then((m) => m.seedDefaultPolicies()).catch(() => { /* already seeded */ });

  return server;
}
