/**
 * MCP Refinery Server — zero external deps beyond MCP SDK.
 * All state lives in data/ as JSON files. No workspace pollution.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools/index.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { loadConfig } from './config.js';
import { initDatabase } from './storage/database.js';

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

## Critical rules

- ALWAYS pause at the **align** overlay — show the user what will change and wait for approval
- ALWAYS run the **cleanup** overlay after changes — catch what the build step missed
- When control="user", STOP and present the decision to the user
- When control="agent", proceed with the bootstrap prompt immediately
- The system evaluates servers against its own baseline patterns (facade, decoupling, anti-oscillation, etc.)
- Universal improvements are flagged for propagation to all managed servers

## Do NOT use the internal tools directly unless you have a specific reason. The facade tools handle orchestration.`;

export function createServer(): McpServer {
  loadConfig();
  initDatabase();

  const server = new McpServer(
    {
      name: 'mcp-refinery',
      version: '0.1.0',
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
