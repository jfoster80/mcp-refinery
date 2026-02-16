/**
 * MCP Prompt registrations — structured workflows.
 * Each prompt is a self-contained pipeline the agent follows step-by-step.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer): void {

  server.prompt('assess-server', 'Full assessment pipeline for an MCP server.', { server_id: z.string() }, async (args) => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `# MCP Server Assessment Pipeline

Run the complete assessment for server "${args.server_id}":

**Step 1** — Register the server (if not already):
\`\`\`prompt
Use server_register with server_id="${args.server_id}" name="<name>" repo_url="<url>"
\`\`\`

**Step 2** — Start multi-perspective research:
\`\`\`prompt
Use research_start with target_server_id="${args.server_id}" perspectives=["security","reliability","compliance","devex","performance"]
\`\`\`

**Step 3** — For each research prompt returned, analyze it and store findings:
\`\`\`prompt
Use research_store with the findings from your analysis
\`\`\`

**Step 4** — Compute consensus:
\`\`\`prompt
Use research_consensus with target_server_id="${args.server_id}"
\`\`\`

**Step 5** — Triage into proposals:
\`\`\`prompt
Use improvements_triage with target_server_id="${args.server_id}"
\`\`\`

**Step 6** — Report findings and await user direction.

Follow the bootstrap prompts from each tool — they chain automatically.` }}],
  }));

  server.prompt('prioritize-backlog', 'Re-prioritize the improvement backlog.', { server_id: z.string() }, async (args) => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `# Backlog Prioritization

1. Use \`research_query\` for "${args.server_id}" to review latest findings
2. Check \`refinery://backlog\` resource for current proposals
3. Check \`refinery://adrs\` for binding decisions
4. Use \`decision_check_oscillation\` for each high-priority proposal
5. Use \`governance_check\` to determine approval requirements
6. Provide ranked recommendations with bootstrap prompts for next actions.` }}],
  }));

  server.prompt('release-plan', 'Plan a release for accumulated improvements.', { server_id: z.string() }, async (args) => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `# Release Planning

1. Check \`refinery://backlog\` for merged proposals on "${args.server_id}"
2. Determine SemVer bump (major/minor/patch)
3. Use \`delivery_release\` to create the release
4. Use \`governance_approve\` if needed
5. Present the changelog and next steps.` }}],
  }));
}
