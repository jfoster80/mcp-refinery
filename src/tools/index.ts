/**
 * MCP Tool registrations.
 *
 * TOOL HIERARCHY:
 *   1. FACADE TOOLS (refine, consult, ingest, pipeline_next, pipeline_status)
 *      → Primary interface. The agent calls these. They orchestrate everything.
 *   2. INTERNAL TOOLS (research_*, decision_*, delivery_*, model_*, deliberation_*)
 *      → Available for fine-grained control but agents shouldn't need them directly.
 *
 * Every tool returns a bootstrap prompt for the next step.
 * Control flows: agent (auto-continue) or user (human decision needed).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolOutput, ResearchPerspective } from '../types/index.js';
import { startResearch, storeFindings, computeConsensus, sanitizeFindings, FINDINGS_JSON_SHAPE } from '../research/index.js';
import {
  triageFindings, captureScorecard, compareScorecards, getBaseline,
  createADR, getActiveADRs, formatADRMarkdown,
  checkOscillation, computeStabilityScore, formatScorecardReport,
} from '../decision/index.js';
import { buildDeliveryPlan, createPRRecord, createRelease, recordApproval, checkGovernanceGate } from '../delivery/index.js';
import {
  upsertTargetServer, listTargetServers,
  getResearchFeeds, getLatestConsensus, getProposal, listProposals,
  insertConsensusResult, queryAuditLog, getAuditStats, getVectorStats, findSimilarDecisions,
  getFeedback, getAllFeedback,
} from '../storage/index.js';
import type { TargetServerConfig } from '../types/index.js';
import {
  getModelRegistry, getModelSummary, classifyTask, routeTask,
  modelSwitchInstruction, startDeliberation, submitDeliberationResponse,
  resolveDeliberation, getDeliberation,
} from '../routing/index.js';
import {
  startPipeline, advancePipeline, getPipeline, getActivePipeline,
  getOverlayRequirements, cancelPipeline, purgeStuckPipelines,
} from '../commands/index.js';
import { getAllAgents } from '../agents/index.js';
import { getAllPatterns, getCriticalPatterns, buildCleanupChecklist } from '../knowledge/index.js';
import {
  createCase, advanceCase, getCase, listCases, consultCase,
  validateCase, CASE_OVERLAY_PIPELINE, REVIEW_PERSPECTIVES,
} from '../research-ops/index.js';
import type { ReviewPerspective, ReviewArtifact } from '../research-ops/index.js';

function output(o: ToolOutput) {
  // Include next_action as structured data (machine-readable)
  // instead of mixing bootstrap prompts into the text body
  const dataWithAction = { ...o.data } as Record<string, unknown>;
  if (o.next) {
    dataWithAction.next_action = {
      control: o.next.control,
      description: o.next.description,
      bootstrap_prompt: o.next.bootstrap_prompt,
    };
  }

  const parts: string[] = [];
  parts.push(JSON.stringify(dataWithAction, null, 2));
  parts.push('');
  parts.push(`**Status**: ${o.status} — ${o.message}`);
  if (o.next) {
    parts.push(`**Control returns to**: ${o.next.control}`);
    parts.push(`**Next step**: ${o.next.description}`);
  }
  return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
}

export function registerTools(server: McpServer): void {

  // =========================================================================
  // FACADE — PRIMARY INTERFACE (use these, they orchestrate everything)
  // =========================================================================

  server.tool(
    'refine',
    'Start a full improvement pipeline for an MCP server — or the refinery itself. Automatically engages the right agents, selects models, and sequences overlays. Use target_server_id="self" (or "mr", "m-r", "mcp-refinery") to improve the refinery itself from any workspace. If the server is already registered, only target_server_id and intent are required. You can also pass a research article to fuel the analysis.',
    {
      target_server_id: z.string().describe('Unique server ID. Use "self" (or "mr", "m-r") to improve the refinery itself.'),
      intent: z.string().describe('What to do: "full refinement", "security audit", "improve performance", etc.'),
      server_name: z.string().optional().describe('Human-readable server name (only needed for first registration)'),
      repo_url: z.string().optional().describe('Git repo URL (only needed for first registration)'),
      context: z.string().optional().describe('Additional context about the server or what you want to achieve'),
      research_content: z.string().optional().describe('Raw research article or deep analysis to use as input (the system will extract findings from this instead of generating its own research prompts)'),
      transport: z.enum(['stdio', 'http']).optional(),
      current_tools: z.array(z.string()).optional().describe('List of tools the server currently exposes'),
      current_resources: z.array(z.string()).optional().describe('List of resources the server currently exposes'),
    },
    async (args) => {
      const result = startPipeline({
        target_server_id: args.target_server_id,
        server_name: args.server_name,
        repo_url: args.repo_url,
        intent: args.intent,
        context: args.context,
        research_content: args.research_content,
        transport: args.transport,
        current_tools: args.current_tools,
        current_resources: args.current_resources,
      });
      return output({
        status: result.status === 'completed' ? 'success' : result.status === 'waiting_user' ? 'needs_approval' : 'success',
        data: {
          pipeline_id: result.pipeline_id,
          command: result.data.command,
          overlays: result.data.overlays,
          progress: result.data.progress,
          agents_active: result.agents_active,
          model: result.model_instruction,
        },
        message: result.message,
        next: result.next,
      });
    },
  );

  server.tool(
    'consult',
    'Ask the specialist agents to deliberate on a topic. Provide a question, a research article, or both. Engages the right experts (Architecture, Security, etc.) and uses multi-model deliberation for critical decisions. Use target_server_id="self" to consult about improving the refinery itself.',
    {
      question: z.string().describe('The question or problem to consult on'),
      context: z.string().optional().describe('Background context'),
      research_content: z.string().optional().describe('Raw research article or deep analysis to use as input. When provided, the agents extract structured findings from this content before deliberating.'),
      target_server_id: z.string().optional().describe('Server this relates to. Use "self" (or "mr", "m-r") for self-improvement.'),
      force_multi_model: z.boolean().optional().describe('Force multi-model deliberation (two architects)'),
    },
    async (args) => {
      const intent = args.force_multi_model
        ? `consult deliberate architect: ${args.question}`
        : `consult: ${args.question}`;
      const result = startPipeline({
        target_server_id: args.target_server_id ?? 'general',
        server_name: args.target_server_id ?? 'general consultation',
        repo_url: '',
        intent,
        context: args.context,
        research_content: args.research_content,
      });
      return output({
        status: 'success',
        data: {
          pipeline_id: result.pipeline_id,
          agents_active: result.agents_active,
          model: result.model_instruction,
          has_research_content: Boolean(args.research_content),
        },
        message: result.message,
        next: result.next,
      });
    },
  );

  server.tool(
    'ingest',
    'Feed a raw research article, deep analysis, or any external content directly into the refinery. The system extracts structured findings, runs consensus, and produces actionable proposals. Use target_server_id="self" to ingest research for improving the refinery itself.',
    {
      target_server_id: z.string().describe('Which server this research applies to. Use "self" (or "mr", "m-r") for self-improvement.'),
      content: z.string().describe('The raw research article, analysis, or deep dive content'),
      intent: z.string().optional().describe('What to do with the findings — defaults to "improve based on research"'),
    },
    async (args) => {
      const result = startPipeline({
        target_server_id: args.target_server_id,
        intent: args.intent ?? 'improve based on ingested research',
        research_content: args.content,
      });

      // Determine the required perspectives so the caller knows upfront
      const pipeline = getPipeline(result.pipeline_id);
      const requiredPersp = pipeline
        ? (pipeline.data.ingest_perspectives as unknown as string[]) ?? ['security', 'reliability', 'devex', 'performance']
        : ['security', 'reliability', 'devex', 'performance'];

      return output({
        status: 'success',
        data: {
          pipeline_id: result.pipeline_id,
          command: result.data.command,
          overlays: result.data.overlays,
          progress: result.data.progress,
          agents_active: result.agents_active,
          required_perspectives: requiredPersp,
          total_perspectives: requiredPersp.length,
          workflow: `Submit findings for each perspective (${requiredPersp.join(', ')}) via pipeline_next, or use research_store individually then pipeline_next will auto-detect completion.`,
        },
        message: result.message,
        next: result.next,
      });
    },
  );

  server.tool(
    'pipeline_next',
    'Advance the active pipeline to the next step. The orchestrator figures out which overlay, agent, and model to engage next. Just call this to keep moving. Use force_advance=true to skip a stuck overlay.',
    {
      pipeline_id: z.string().describe('Pipeline to advance'),
      findings: z.array(z.object({
        claim: z.string(),
        recommendation: z.string(),
        expected_impact: z.object({ reliability: z.number(), security: z.number(), devex: z.number(), performance: z.number() }),
        risk: z.object({ level: z.enum(['low', 'medium', 'high', 'critical']), notes: z.string() }),
        evidence: z.array(z.object({ type: z.enum(['url', 'quote', 'spec_reference']), value: z.string(), quality: z.enum(['A', 'B', 'C']) })),
      })).optional().describe('Research findings from the agent (when the previous step asked for analysis)'),
      force_advance: z.boolean().optional().describe('Force-advance past the current overlay even if it has not completed normally. Use when the pipeline is stuck.'),
      complete_overlay: z.boolean().optional().describe('Mark the current overlay as complete and advance to the next. Use when overlay work was done via individual tools.'),
    },
    async (args) => {
      const input: Record<string, unknown> = {};
      if (args.findings) input.findings = args.findings;

      const options = {
        force_advance: args.force_advance,
        complete_overlay: args.complete_overlay,
      };

      const result = advancePipeline(
        args.pipeline_id,
        Object.keys(input).length > 0 ? input : undefined,
        (options.force_advance || options.complete_overlay) ? options : undefined,
      );
      if (!result) return output({ status: 'error', data: {}, message: 'Pipeline not found.', next: { control: 'user', description: 'The pipeline ID was not found. Check the ID or start a new pipeline.', bootstrap_prompt: `Pipeline "${args.pipeline_id}" does not exist. Use pipeline_status to find active pipelines, or use refine to start a new one.` } });

      return output({
        status: result.status === 'completed' ? 'success' : result.status === 'waiting_user' ? 'needs_approval' : result.status === 'error' ? 'error' : 'success',
        data: {
          pipeline_id: result.pipeline_id,
          overlay: result.overlay,
          step: result.step,
          progress: result.data.progress,
          agents_active: result.agents_active,
        },
        message: result.message,
        next: result.next,
      });
    },
  );

  server.tool(
    'pipeline_status',
    'Check where the active pipeline is — which overlay, which agents are engaged, what the next step is.',
    { pipeline_id: z.string().optional().describe('Specific pipeline (default: most recent active)') },
    async (args) => {
      const pipeline = args.pipeline_id ? getPipeline(args.pipeline_id) : getActivePipeline();
      if (!pipeline) return output({ status: 'success', data: { active: false }, message: 'No active pipeline. Use "refine" to start one.', next: { control: 'user', description: 'Start a new pipeline.', bootstrap_prompt: 'Use the refine tool to start improving an MCP server.' } });

      const current = pipeline.overlays[pipeline.overlay_index] ?? 'done';
      const completed = pipeline.overlays.slice(0, pipeline.overlay_index);
      const remaining = pipeline.overlays.slice(pipeline.overlay_index + 1);
      const agents = getAllAgents();
      const engaged = pipeline.agents_engaged.map((id) => agents.find((a) => a.agent_id === id)?.name ?? id);
      const requirements = getOverlayRequirements(pipeline);

      return output({
        status: 'success',
        data: {
          pipeline_id: pipeline.pipeline_id,
          command: pipeline.command,
          status: pipeline.status,
          current_overlay: current,
          completed_overlays: completed,
          remaining_overlays: remaining,
          progress: `${pipeline.overlay_index + 1}/${pipeline.overlays.length}`,
          agents_engaged: engaged,
          intent: pipeline.intent,
          waiting_for: requirements,
          error: pipeline.error_message ?? null,
        },
        message: `Pipeline [${pipeline.command}]: ${completed.map((o) => `${o} ✓`).join(' → ')}${completed.length > 0 ? ' → ' : ''}**${current}** → ${remaining.join(' → ')}`,
        next: pipeline.status === 'waiting_user'
          ? { control: 'user', description: (requirements as Record<string, unknown>).instructions as string ?? 'User input needed.', bootstrap_prompt: `Pipeline paused at "${current}". Review the data above and use pipeline_next with pipeline_id="${pipeline.pipeline_id}" to continue.` }
          : pipeline.status === 'completed'
            ? { control: 'user', description: 'Pipeline complete.', bootstrap_prompt: 'Pipeline finished. Use refine to start a new cycle.' }
            : pipeline.status === 'error'
              ? { control: 'user', description: `Error: ${pipeline.error_message}. Use force_advance=true to skip.`, bootstrap_prompt: `Pipeline error at "${current}": ${pipeline.error_message}\n\nUse pipeline_next with pipeline_id="${pipeline.pipeline_id}" force_advance=true to skip this overlay.` }
              : { control: 'agent', description: (requirements as Record<string, unknown>).instructions as string ?? 'Continue the pipeline.', bootstrap_prompt: `Use pipeline_next with pipeline_id="${pipeline.pipeline_id}" to continue.` },
      });
    },
  );

  // =========================================================================
  // PIPELINE LIFECYCLE — cancel & purge
  // =========================================================================

  server.tool(
    'pipeline_cancel',
    'Cancel a single pipeline. Use when a pipeline is stuck or no longer needed.',
    {
      pipeline_id: z.string().describe('The pipeline to cancel'),
      reason: z.string().optional().describe('Why the pipeline is being cancelled'),
    },
    async (args) => {
      const result = cancelPipeline(args.pipeline_id, args.reason);
      if (!result) return output({ status: 'error', data: {}, message: `Pipeline "${args.pipeline_id}" not found.`, next: { control: 'user', description: 'Pipeline not found.', bootstrap_prompt: 'Use pipeline_status to find active pipelines.' } });

      return output({
        status: 'success',
        data: {
          pipeline_id: result.pipeline_id,
          target: result.target_server_id,
          was_at_overlay: result.overlays[result.overlay_index] ?? 'done',
          status: result.status,
        },
        message: `Pipeline cancelled: was at "${result.overlays[result.overlay_index] ?? 'done'}" for ${result.target_server_id}.`,
        next: { control: 'user', description: 'Pipeline cancelled. Start a new one when ready.', bootstrap_prompt: 'Use refine or ingest to start a new pipeline.' },
      });
    },
  );

  server.tool(
    'pipeline_purge',
    'Purge all stuck or orphaned pipelines from prior sessions. Moves every non-completed pipeline to cancelled status in one call.',
    {
      reason: z.string().optional().describe('Why pipelines are being purged (default: "orphaned pipeline from prior session")'),
    },
    async (args) => {
      const result = purgeStuckPipelines(args.reason);

      if (result.purged === 0) {
        return output({
          status: 'success',
          data: { purged: 0 },
          message: 'No stuck pipelines found. Everything is clean.',
          next: { control: 'user', description: 'No cleanup needed.', bootstrap_prompt: 'Use refine or ingest to start a new pipeline.' },
        });
      }

      return output({
        status: 'success',
        data: {
          purged: result.purged,
          pipelines: result.pipelines,
        },
        message: `${result.purged} orphaned pipeline(s) purged.`,
        next: { control: 'user', description: `${result.purged} pipeline(s) cleaned up. Ready for a fresh cycle.`, bootstrap_prompt: 'All orphaned pipelines purged. Use refine or ingest to start a new pipeline.' },
      });
    },
  );

  // =========================================================================
  // SERVER MANAGEMENT
  // =========================================================================

  server.tool(
    'server_register',
    'Register a target MCP server for improvement tracking. This is always the first step.',
    {
      server_id: z.string().describe('Unique ID for the server'),
      name: z.string().describe('Human-readable name'),
      repo_url: z.string().describe('Git repository URL'),
      branch: z.string().optional(),
      transport: z.enum(['stdio', 'http']).optional(),
      auth_mode: z.enum(['none', 'oauth', 'env_credentials']).optional(),
      autonomy_level: z.enum(['advisory', 'pr_only', 'auto_merge', 'auto_release']).optional(),
    },
    async (args) => {
      const now = new Date().toISOString();
      const cfg: TargetServerConfig = {
        server_id: args.server_id, name: args.name, repo_url: args.repo_url,
        branch: args.branch ?? 'main', transport: args.transport ?? 'stdio',
        auth_mode: args.auth_mode ?? 'none', autonomy_level: args.autonomy_level ?? 'pr_only',
        change_budget_per_window: 5, window_hours: 24, allowed_categories: [],
        scorecard_weights: { security: 0.3, reliability: 0.25, devex: 0.2, performance: 0.15, governance: 0.1 },
        created_at: now, updated_at: now,
      };
      upsertTargetServer(cfg);
      return output({
        status: 'success', data: { server: cfg },
        message: `Server "${args.name}" registered.`,
        next: {
          control: 'agent', description: 'Start deep research on this server.',
          bootstrap_prompt: `Use the research_start tool with target_server_id="${args.server_id}" server_name="${args.name}" and perspectives=["security","reliability","compliance","devex","performance"] to generate research prompts.`,
        },
      });
    },
  );

  server.tool('server_list', 'List all registered target MCP servers.', {}, async () => {
    const servers = listTargetServers();
    return output({
      status: 'success', data: { count: servers.length, servers },
      message: `${servers.length} server(s) registered.`,
      next: servers.length === 0
        ? { control: 'user', description: 'Register a server first.', bootstrap_prompt: 'Use the server_register tool to register a target MCP server for improvement.' }
        : { control: 'agent', description: 'Pick a server and start research.', bootstrap_prompt: `Use the research_start tool on server_id="${servers[0].server_id}" to begin deep research.` },
    });
  });

  // =========================================================================
  // RESEARCH PLANE
  // =========================================================================

  server.tool(
    'research_start',
    'Generate structured research prompts for the agent to analyze. The agent (you) will process each prompt and store findings.',
    {
      target_server_id: z.string(),
      server_name: z.string(),
      server_description: z.string().optional(),
      current_tools: z.array(z.string()).optional(),
      current_resources: z.array(z.string()).optional(),
      transport: z.enum(['stdio', 'http']).optional(),
      auth_mode: z.string().optional(),
      additional_context: z.string().optional(),
      perspectives: z.array(z.enum(['security', 'reliability', 'compliance', 'devex', 'performance', 'general'])).optional(),
    },
    async (args) => {
      const perspectives = (args.perspectives ?? ['general']) as ResearchPerspective[];
      const result = startResearch({
        target_server_id: args.target_server_id,
        server_name: args.server_name,
        server_description: args.server_description ?? '',
        current_tools: args.current_tools ?? [],
        current_resources: args.current_resources ?? [],
        transport: args.transport ?? 'stdio',
        auth_mode: args.auth_mode ?? 'none',
        focus_areas: perspectives,
        additional_context: args.additional_context ?? '',
      }, perspectives);

      const firstPrompt = result.prompts[0];
      return output({
        status: 'success',
        data: {
          prompts_generated: result.prompts.length,
          perspectives,
          prompts: result.prompts.map((p) => ({ perspective: p.perspective, prompt_hash: p.prompt_hash, prompt: p.prompt })),
        },
        message: `Generated ${result.prompts.length} research prompt(s). Process each one and store findings.`,
        next: {
          control: 'agent',
          description: `Analyze the "${firstPrompt.perspective}" prompt above, then store findings.`,
          bootstrap_prompt: `Analyze the "${firstPrompt.perspective}" research prompt above. Then use the research_store tool with:
- target_server_id="${args.target_server_id}"
- perspective="${firstPrompt.perspective}"
- prompt_hash="${firstPrompt.prompt_hash}"
- findings=[...your structured findings array...]

Return findings as JSON matching: ${FINDINGS_JSON_SHAPE}`,
        },
      });
    },
  );

  server.tool(
    'research_store',
    'Store research findings produced by the agent after analyzing a research prompt.',
    {
      target_server_id: z.string(),
      perspective: z.enum(['security', 'reliability', 'compliance', 'devex', 'performance', 'general']),
      prompt_hash: z.string(),
      findings: z.array(z.object({
        claim: z.string(),
        recommendation: z.string(),
        expected_impact: z.object({ reliability: z.number(), security: z.number(), devex: z.number(), performance: z.number() }),
        risk: z.object({ level: z.enum(['low', 'medium', 'high', 'critical']), notes: z.string() }),
        evidence: z.array(z.object({ type: z.enum(['url', 'quote', 'spec_reference']), value: z.string(), quality: z.enum(['A', 'B', 'C']) })),
      })),
    },
    async (args) => {
      const sanitized = sanitizeFindings(args.findings as unknown[]);
      const entry = storeFindings(args.target_server_id, args.perspective as ResearchPerspective, args.prompt_hash, sanitized);

      const feeds = getResearchFeeds(args.target_server_id);
      const allPerspectives = ['security', 'reliability', 'compliance', 'devex', 'performance'];
      const completedPerspectives = feeds.map((f) => f.perspective);
      const remainingPerspectives = allPerspectives.filter((p) => !feeds.some((f) => f.perspective === p));

      if (remainingPerspectives.length > 0) {
        return output({
          status: 'success',
          data: {
            feed_id: entry.feed_id, findings_stored: sanitized.length, confidence: entry.confidence,
            feeds_total: feeds.length,
            perspectives_required: allPerspectives,
            perspectives_completed: completedPerspectives,
            perspectives_remaining: remainingPerspectives,
            progress: `${completedPerspectives.length}/${allPerspectives.length}`,
          },
          message: `Stored ${sanitized.length} findings for "${args.perspective}". ${remainingPerspectives.length} perspective(s) remaining: ${remainingPerspectives.join(', ')}.`,
          next: {
            control: 'agent',
            description: `Continue with "${remainingPerspectives[0]}" perspective. Required: ${allPerspectives.join(', ')}. Done: ${completedPerspectives.join(', ')}.`,
            bootstrap_prompt: `Use the research_start tool with target_server_id="${args.target_server_id}" and perspectives=["${remainingPerspectives[0]}"] to get the next research prompt. Then analyze it and store findings.`,
          },
        });
      }

      return output({
        status: 'success',
        data: {
          feed_id: entry.feed_id, findings_stored: sanitized.length, confidence: entry.confidence,
          feeds_total: feeds.length,
          perspectives_required: allPerspectives,
          perspectives_completed: completedPerspectives,
          perspectives_remaining: [],
          progress: `${allPerspectives.length}/${allPerspectives.length}`,
        },
        message: `All perspectives complete (${allPerspectives.join(', ')}). Ready to compute consensus.`,
        next: {
          control: 'agent',
          description: 'Compute cross-perspective consensus.',
          bootstrap_prompt: `Use the research_consensus tool with target_server_id="${args.target_server_id}" to compute agreement across all research perspectives.`,
        },
      });
    },
  );

  server.tool(
    'research_consensus',
    'Compute cross-perspective consensus from stored research findings.',
    { target_server_id: z.string() },
    async (args) => {
      const feeds = getResearchFeeds(args.target_server_id);
      if (feeds.length === 0) {
        return output({ status: 'error', data: {}, message: 'No research feeds found. Run research_start first.', next: { control: 'agent', description: 'Start research first.', bootstrap_prompt: `Use the research_start tool for server "${args.target_server_id}".` } });
      }
      const consensus = computeConsensus(feeds, args.target_server_id);
      insertConsensusResult(consensus);
      return output({
        status: 'success',
        data: {
          consensus_id: consensus.consensus_id,
          findings_count: consensus.findings.length,
          overall_agreement: consensus.overall_agreement,
          perspectives_used: consensus.perspectives_used,
          top_findings: consensus.findings.slice(0, 5).map((f) => ({ claim: f.claim, agreement: f.agreement_score, risk: f.risk_level })),
        },
        message: `Consensus computed: ${consensus.findings.length} findings, ${(consensus.overall_agreement * 100).toFixed(0)}% agreement.`,
        next: {
          control: 'agent',
          description: 'Triage findings into prioritized improvement proposals.',
          bootstrap_prompt: `Use the improvements_triage tool with target_server_id="${args.target_server_id}" to create prioritized proposals from the consensus.`,
        },
      });
    },
  );

  server.tool(
    'research_query',
    'Query stored research findings and consensus results for a server.',
    { target_server_id: z.string(), limit: z.number().optional() },
    async (args) => {
      const feeds = getResearchFeeds(args.target_server_id, args.limit ?? 10);
      const consensus = getLatestConsensus(args.target_server_id);
      return output({
        status: 'success',
        data: { feeds_count: feeds.length, feeds: feeds.map((f) => ({ feed_id: f.feed_id, perspective: f.perspective, findings: f.findings.length, confidence: f.confidence })), latest_consensus: consensus },
        message: `${feeds.length} research feed(s) found.`,
        next: consensus
          ? { control: 'agent', description: 'Research data retrieved. You can triage findings or start a new research cycle.', bootstrap_prompt: `Research data for "${args.target_server_id}" is available. To triage into proposals, use improvements_triage with target_server_id="${args.target_server_id}". To view consensus details, check the latest_consensus field above.` }
          : feeds.length > 0
            ? { control: 'agent', description: 'Feeds exist but no consensus yet. Compute consensus to proceed.', bootstrap_prompt: `${feeds.length} research feed(s) found but no consensus computed yet. Use research_consensus with target_server_id="${args.target_server_id}" to compute cross-perspective agreement.` }
            : { control: 'agent', description: 'No research data yet. Start research to begin.', bootstrap_prompt: `No research data found for "${args.target_server_id}". Use research_start with target_server_id="${args.target_server_id}" to begin analysis.` },
      });
    },
  );

  // =========================================================================
  // DECISION PLANE
  // =========================================================================

  server.tool(
    'improvements_triage',
    'Triage consensus findings into ranked, governance-aware improvement proposals.',
    { target_server_id: z.string() },
    async (args) => {
      const consensus = getLatestConsensus(args.target_server_id);
      if (!consensus) return output({ status: 'error', data: {}, message: 'No consensus found. Run research first.', next: { control: 'agent', description: 'Run research first.', bootstrap_prompt: `Use research_start for "${args.target_server_id}".` } });

      const result = triageFindings(consensus);
      const actionable = result.proposals.filter((p) => !p.blocked_by_oscillation);
      const topId = actionable[0]?.proposal_id ?? 'none';

      return output({
        status: 'success',
        data: { proposals: result.proposals, total_loc: result.total_estimated_loc, budget_remaining: result.budget_remaining, escalations: result.escalations },
        message: `${actionable.length} actionable proposal(s), ${result.escalations.length} escalation(s).`,
        next: actionable.length > 0
          ? { control: 'user', description: 'Review proposals and approve for delivery.', bootstrap_prompt: `Review the proposals above. To proceed with the top proposal, use:\ngovernance_approve with target_type="proposal" target_id="${topId}" approved_by="user" risk_acknowledged=true rollback_plan_acknowledged=true\n\nThen use delivery_plan with target_server_id="${args.target_server_id}" proposal_ids=["${topId}"]` }
          : { control: 'user', description: 'All proposals blocked. Review escalations.', bootstrap_prompt: 'All proposals are blocked by policy or anti-oscillation. Review the escalations above and decide next steps.' },
      });
    },
  );

  server.tool(
    'decision_record_adr',
    'Record an Architecture Decision Record — becomes a binding tie-breaker protected by anti-oscillation cooldowns.',
    {
      title: z.string(), context: z.string(), decision: z.string(), rationale: z.string(),
      consequences: z.array(z.string()), alternatives_considered: z.array(z.string()),
      confidence: z.number().min(0).max(1),
      related_proposals: z.array(z.string()).optional(),
      cooldown_hours: z.number().optional(),
    },
    async (args) => {
      const adr = createADR({ ...args, related_proposals: args.related_proposals ?? [] });
      const relatedIds = args.related_proposals ?? [];
      return output({
        status: 'success', data: { adr_id: adr.adr_id },
        message: `ADR "${adr.title}" recorded with ${(adr.confidence * 100).toFixed(0)}% confidence.`,
        next: relatedIds.length > 0
          ? { control: 'agent', description: 'ADR recorded. Create a delivery plan for the related proposals.', bootstrap_prompt: `ADR ${adr.adr_id} is now binding. Create a delivery plan using delivery_plan with proposal_ids=${JSON.stringify(relatedIds)}.` }
          : { control: 'user', description: 'ADR recorded. What would you like to do next?', bootstrap_prompt: `ADR "${adr.title}" (${adr.adr_id}) is now binding with a ${(adr.confidence * 100).toFixed(0)}% confidence level. This decision is protected by anti-oscillation cooldown.\n\nWhat would you like to do next?\n- Use improvements_triage to generate proposals based on this decision\n- Use refine to start a full improvement pipeline\n- Use delivery_plan to create a delivery plan for existing proposals` },
      });
    },
  );

  server.tool(
    'decision_check_oscillation',
    'Check if a proposal would violate anti-oscillation rules.',
    { proposal_id: z.string(), new_confidence: z.number().min(0).max(1) },
    async (args) => {
      const proposal = getProposal(args.proposal_id);
      if (!proposal) return output({ status: 'error', data: {}, message: 'Proposal not found.', next: { control: 'user', description: 'Proposal ID not found. Check the ID and try again.', bootstrap_prompt: `Proposal "${args.proposal_id}" was not found. Use improvements_triage to view current proposals, or use research_query to check the research state.` } });
      const check = checkOscillation(proposal, args.new_confidence);
      const stability = computeStabilityScore(proposal.target_server_id);
      return output({
        status: check.blocked ? 'error' : 'success',
        data: { oscillation_check: check, stability },
        message: check.blocked ? `Blocked: ${check.reason}` : 'No oscillation conflict.',
        next: check.blocked
          ? { control: 'user', description: 'This proposal is blocked by anti-oscillation rules. Review the reason and decide how to proceed.', bootstrap_prompt: `Proposal "${args.proposal_id}" is blocked: ${check.reason}\n\nOptions:\n- Wait for the cooldown period to expire (${Math.ceil(check.cooldown_remaining_ms / 3600000)}h remaining)\n- Record a new ADR with higher confidence using decision_record_adr to supersede the existing decision\n- Choose a different proposal that is not in conflict` }
          : { control: 'agent', description: 'No oscillation conflict. This proposal can proceed.', bootstrap_prompt: `Proposal "${args.proposal_id}" passed oscillation checks. Proceed with governance_approve to approve it, then delivery_plan to create the implementation plan.` },
      });
    },
  );

  server.tool(
    'decision_capture_scorecard',
    'Capture a scorecard snapshot for a server with current metrics.',
    {
      target_server_id: z.string(),
      protocol_compliance: z.object({ valid_tool_schemas: z.number(), total_tools: z.number(), valid_resource_uris: z.number(), total_resources: z.number(), transport_hardened: z.boolean(), auth_implemented: z.boolean(), structured_output_usage: z.number(), error_handling_coverage: z.number() }),
      testing: z.object({ test_pass_rate: z.number(), test_coverage: z.number(), protocol_test_coverage: z.number(), integration_test_count: z.number() }),
      security: z.object({ secrets_scan_clean: z.boolean(), dependency_vulnerabilities: z.number(), input_validation_coverage: z.number(), auth_bypass_tests: z.number(), owasp_llm_compliance: z.number() }),
      reliability: z.object({ error_rate: z.number(), p95_latency_ms: z.number(), p99_latency_ms: z.number(), uptime_percent: z.number() }),
      governance: z.object({ policy_violations: z.number(), failed_approvals: z.number(), audit_completeness: z.number(), adr_coverage: z.number() }),
    },
    async (args) => {
      const snapshot = captureScorecard(args);
      const baseline = getBaseline(args.target_server_id);
      let comparison = null;
      if (baseline && baseline.scorecard_id !== snapshot.scorecard_id) comparison = compareScorecards(baseline, snapshot);
      const improved = comparison && comparison.overall_delta > 0;
      return output({
        status: 'success', data: { scorecard_id: snapshot.scorecard_id, overall_score: snapshot.overall_score, comparison },
        message: `Scorecard captured: ${(snapshot.overall_score * 100).toFixed(1)}% overall.${comparison ? ` Delta: ${comparison.overall_delta > 0 ? '+' : ''}${(comparison.overall_delta * 100).toFixed(1)}%` : ' (first capture — no baseline to compare)'}`,
        next: comparison
          ? { control: improved ? 'agent' : 'user', description: improved ? 'Scorecard shows improvement. Pipeline can continue.' : 'Scorecard regression detected. Review before proceeding.', bootstrap_prompt: improved ? `Scorecard ${snapshot.scorecard_id} shows improvement (${(comparison.overall_delta * 100).toFixed(1)}% delta). The pipeline can continue — use pipeline_next or delivery_release as appropriate.` : `Scorecard ${snapshot.scorecard_id} shows regression (${(comparison.overall_delta * 100).toFixed(1)}% delta). Review the dimension breakdowns above.\n\nDo you want to proceed despite the regression, or should we investigate the cause?` }
          : { control: 'agent', description: 'Baseline scorecard captured. Continue with the pipeline.', bootstrap_prompt: `Baseline scorecard ${snapshot.scorecard_id} captured (${(snapshot.overall_score * 100).toFixed(1)}% overall). This is the first capture for "${args.target_server_id}" — it will be used as the comparison baseline for future scorecards. Continue with the pipeline.` },
      });
    },
  );

  // =========================================================================
  // DELIVERY PLANE
  // =========================================================================

  server.tool(
    'delivery_plan',
    'Create a delivery plan with test strategy and rollback plan for approved proposals.',
    { target_server_id: z.string(), proposal_ids: z.array(z.string()), custom_test_strategy: z.string().optional(), custom_rollback_plan: z.string().optional() },
    async (args) => {
      try {
        const plan = buildDeliveryPlan(args);
        return output({
          status: 'success',
          data: { plan_id: plan.plan_id, proposals: plan.proposals, estimated_hours: plan.estimated_duration_hours },
          message: `Delivery plan created (${plan.estimated_duration_hours}h est).`,
          next: { control: 'agent', description: 'Create a PR record for this plan.', bootstrap_prompt: `Use delivery_create_pr with plan_id="${plan.plan_id}" proposal_ids=${JSON.stringify(args.proposal_ids)} repo_url="<repo_url>" changes_summary="<describe changes>"` },
        });
      } catch (e: unknown) { return output({ status: 'error', data: { error: String(e) }, message: `Delivery plan failed: ${e instanceof Error ? e.message : String(e)}`, next: { control: 'user', description: 'Delivery plan creation failed. Review the error and try again.', bootstrap_prompt: `Delivery plan creation failed: ${e instanceof Error ? e.message : String(e)}\n\nCommon causes:\n- Invalid proposal IDs (use improvements_triage to see current proposals)\n- No approved proposals found\n\nFix the issue and retry delivery_plan with corrected parameters.` } }); }
    },
  );

  server.tool(
    'delivery_create_pr',
    'Create a PR record. Agents never push to main — all changes go through PRs.',
    { plan_id: z.string(), proposal_ids: z.array(z.string()), repo_url: z.string(), changes_summary: z.string(), files_changed: z.number().optional(), additions: z.number().optional(), deletions: z.number().optional() },
    async (args) => {
      const pr = createPRRecord({ plan_id: args.plan_id, proposal_ids: args.proposal_ids, repo_url: args.repo_url, changes_summary: args.changes_summary, diff_stats: { files_changed: args.files_changed ?? 0, additions: args.additions ?? 0, deletions: args.deletions ?? 0 } });
      return output({
        status: 'success', data: { pr_id: pr.pr_id, branch: pr.branch_name, title: pr.title },
        message: `PR record created on branch ${pr.branch_name}.`,
        next: { control: 'user', description: 'Review and merge the PR, then create a release.', bootstrap_prompt: `PR "${pr.title}" is ready for review.\nAfter merge, use delivery_release with target_server_id plan_id="${args.plan_id}" pr_ids=["${pr.pr_id}"]` },
      });
    },
  );

  server.tool(
    'delivery_release',
    'Create a semantic-versioned release from a delivery plan.',
    { target_server_id: z.string(), plan_id: z.string(), pr_ids: z.array(z.string()), version_bump: z.enum(['major', 'minor', 'patch']).optional() },
    async (args) => {
      try {
        const release = createRelease(args);
        return output({
          status: 'success', data: { release_id: release.release_id, version: release.version, changelog: release.changelog },
          message: `Release v${release.version} created.`,
          next: { control: 'user', description: 'Publish the release.', bootstrap_prompt: `Release v${release.version} is ready. Publish to your registry and deploy.\n\nThe MCP Refinery pipeline is complete. To start a new improvement cycle, use research_start again.` },
        });
      } catch (e: unknown) { return output({ status: 'error', data: { error: String(e) }, message: `Release failed: ${e instanceof Error ? e.message : String(e)}`, next: { control: 'user', description: 'Release creation failed. Review the error and decide how to proceed.', bootstrap_prompt: `Release creation failed: ${e instanceof Error ? e.message : String(e)}\n\nVerify the plan_id and pr_ids are correct, then retry delivery_release. Or use pipeline_status to check the current pipeline state.` } }); }
    },
  );

  // =========================================================================
  // GOVERNANCE
  // =========================================================================

  server.tool(
    'governance_approve',
    'Record governance approval for a proposal, plan, or release.',
    { target_type: z.enum(['proposal', 'plan', 'release', 'adr_override']), target_id: z.string(), approved_by: z.string(), risk_acknowledged: z.boolean(), rollback_plan_acknowledged: z.boolean(), notes: z.string().optional() },
    async (args) => {
      const approval = recordApproval(args.target_type, args.target_id, args.approved_by, args.risk_acknowledged, args.rollback_plan_acknowledged, args.notes ?? '');
      return output({
        status: 'success', data: { approval_id: approval.approval_id },
        message: `Approved by ${args.approved_by}.`,
        next: { control: 'agent', description: 'Proceed with delivery.', bootstrap_prompt: `Approval granted. Use delivery_plan to create the implementation plan.` },
      });
    },
  );

  server.tool(
    'governance_check',
    'Check if a governance action is allowed.',
    { target_type: z.enum(['proposal', 'plan', 'release', 'adr_override']), target_id: z.string(), server_id: z.string(), risk_level: z.enum(['low', 'medium', 'high', 'critical']) },
    async (args) => {
      const result = checkGovernanceGate(args.target_type, args.target_id, args.server_id, args.risk_level);
      return output({
        status: result.allowed ? 'success' : 'needs_approval',
        data: result,
        message: result.reason,
        next: result.allowed
          ? { control: 'agent', description: 'Governance gate passed. Proceed with the next pipeline step.', bootstrap_prompt: `Governance check passed for ${args.target_type} "${args.target_id}". No additional approval needed. Continue with the next step — use delivery_plan or pipeline_next as appropriate.` }
          : { control: 'user', description: 'Approval required before proceeding.', bootstrap_prompt: `Governance gate requires approval for this ${args.risk_level}-risk ${args.target_type}.\n\nTo approve: use governance_approve with target_type="${args.target_type}" target_id="${args.target_id}" approved_by="<your_name>" risk_acknowledged=true rollback_plan_acknowledged=true` },
      });
    },
  );

  // =========================================================================
  // AUDIT & SEARCH
  // =========================================================================

  server.tool('audit_query', 'Query the append-only audit log.', { action: z.string().optional(), target_type: z.string().optional(), target_id: z.string().optional(), since: z.string().optional(), limit: z.number().optional() }, async (args) => {
    const entries = queryAuditLog(args as Parameters<typeof queryAuditLog>[0]);
    return output({ status: 'success', data: { count: entries.length, entries }, message: `${entries.length} audit entries.`, next: { control: 'user', description: 'Audit log retrieved. Review the entries above.', bootstrap_prompt: `${entries.length} audit entries returned. You can refine the query with filters (action, target_type, target_id, since) or use search_similar to find related historical decisions.` } });
  });

  server.tool('audit_stats', 'Get audit log statistics.', {}, async () => {
    return output({ status: 'success', data: { audit: getAuditStats(), vectors: getVectorStats() }, message: 'Stats retrieved.', next: { control: 'user', description: 'Audit statistics retrieved. Review the data above.', bootstrap_prompt: 'Audit and vector store statistics are above. Use audit_query with specific filters to drill into entries, or search_similar to find patterns in historical decisions.' } });
  });

  server.tool('search_similar', 'Vector similarity search on historical decisions/fixes.', { query: z.string(), top_k: z.number().optional() }, async (args) => {
    const results = findSimilarDecisions(args.query, args.top_k ?? 5);
    return output({ status: 'success', data: { results: results.map((r) => ({ id: r.entry.vector_id, similarity: r.similarity, text: r.entry.content_text.slice(0, 200), metadata: r.entry.metadata })) }, message: `${results.length} similar items found.`, next: { control: 'user', description: 'Similar historical decisions retrieved. Review for relevant patterns.', bootstrap_prompt: `${results.length} similar historical item(s) found for "${args.query}". Review the results above to inform your current decision. Use decision_check_oscillation to verify a proposal won't conflict with past decisions, or decision_record_adr to record a new binding decision.` } });
  });

  // =========================================================================
  // MODEL ROUTING & SELECTION
  // =========================================================================

  server.tool('model_list', 'List all registered models with live availability based on detected API keys. Availability is checked every call — adding a key takes effect immediately.', {}, async () => {
    const summary = getModelSummary();
    const models = getModelRegistry().map((m) => ({
      id: m.model_id, provider: m.provider, tier: m.tier,
      name: m.display_name, quality: m.quality, speed: m.speed,
      available: m.available, capabilities: m.capabilities,
    }));
    const keyStatus = Object.entries(summary.by_provider).map(([p, v]) =>
      `${p}: ${v.has_key ? 'KEY DETECTED' : 'no key'} (${v.available}/${v.total} models)`).join(', ');
    return output({
      status: 'success',
      data: { ...summary, models },
      message: `${summary.total} models, ${summary.available} available. Active providers: ${summary.active_providers.join(', ') || 'none (prompt mode only)'}. [${keyStatus}]`,
      next: { control: 'agent', description: 'Models loaded. Classify a task to get routing recommendations.',
        bootstrap_prompt: 'Use model_classify to classify your task and get the right model recommendation.' },
    });
  });

  server.tool(
    'model_classify',
    'Classify a task to determine complexity, recommended model tier, and whether multi-model deliberation is needed.',
    {
      description: z.string().describe('What the task involves'),
      risk_level: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      estimated_loc: z.number().optional(),
      touches_security: z.boolean().optional(),
      touches_auth: z.boolean().optional(),
      is_architectural: z.boolean().optional(),
      has_conflicting_adrs: z.boolean().optional(),
      request_multi_model: z.boolean().optional().describe('Force multi-model deliberation'),
    },
    async (args) => {
      const classification = classifyTask({
        description: args.description,
        risk_level: args.risk_level as 'low' | 'medium' | 'high' | 'critical' | undefined,
        estimated_loc: args.estimated_loc,
        touches_security: args.touches_security,
        touches_auth: args.touches_auth,
        is_architectural: args.is_architectural,
        has_conflicting_adrs: args.has_conflicting_adrs,
        user_requested_multi: args.request_multi_model,
      });

      const routing = routeTask({
        description: args.description,
        risk_level: args.risk_level as 'low' | 'medium' | 'high' | 'critical' | undefined,
        estimated_loc: args.estimated_loc,
        touches_security: args.touches_security,
        touches_auth: args.touches_auth,
        is_architectural: args.is_architectural,
        has_conflicting_adrs: args.has_conflicting_adrs,
        user_requested_multi: args.request_multi_model,
      });

      const modelInstructions = routing.assignments.map((a) =>
        modelSwitchInstruction(a.model, a.mode === 'prompt')
      ).join('\n');

      if (classification.requires_multi_model) {
        return output({
          status: 'success',
          data: { classification, routing: { assignments: routing.assignments.map((a) => ({ model: a.model.display_name, provider: a.model.provider, role: a.role, mode: a.mode, reason: a.reason })), mode: routing.execution_mode, estimated_cost: routing.estimated_cost_usd, estimated_latency: routing.estimated_latency_s } },
          message: `${classification.complexity} task → MULTI-MODEL deliberation recommended. ${classification.reasoning}`,
          next: {
            control: 'agent',
            description: 'Start multi-model deliberation for this critical task.',
            bootstrap_prompt: `This task requires multi-model review (iron sharpens iron).\n${modelInstructions}\n\nUse deliberation_start with:\n- problem_statement="<describe the exact problem>"\n- context="<relevant context and constraints>"`,
          },
        });
      }

      const primary = routing.assignments[0];
      return output({
        status: 'success',
        data: { classification, routing: { model: primary.model.display_name, provider: primary.model.provider, tier: primary.model.tier, mode: primary.mode } },
        message: `${classification.complexity} task → ${primary.model.display_name} (${primary.model.tier} tier). ${classification.reasoning}`,
        next: {
          control: primary.mode === 'api' ? 'agent' : 'user',
          description: `Proceed with ${primary.model.display_name}.`,
          bootstrap_prompt: primary.mode === 'prompt'
            ? `${modelSwitchInstruction(primary.model, true)}\nSwitch your Cursor model to ${primary.model.display_name} for this task, then continue.`
            : `Task classified as ${classification.complexity}. Routed to ${primary.model.display_name} (${primary.model.tier} tier) via API. The Cursor agent should proceed with the task — use refine, consult, or the appropriate tool for your intent.`,
        },
      });
    },
  );

  // =========================================================================
  // MULTI-MODEL DELIBERATION ("Iron Sharpens Iron")
  // =========================================================================

  server.tool(
    'deliberation_start',
    'Start a multi-model deliberation session. Two architect-tier models analyze the same problem. Consensus proceeds; conflicts escalate to user.',
    {
      problem_statement: z.string().describe('The exact problem to deliberate'),
      context: z.string().describe('Relevant context, constraints, and background'),
      model_ids: z.array(z.string()).optional().describe('Specific model IDs to use (defaults to best architect pair)'),
      force_prompt_mode: z.boolean().optional().describe('Force prompt mode even if API keys available'),
    },
    async (args) => {
      try {
        const result = await startDeliberation({
          problem_statement: args.problem_statement,
          context: args.context,
          model_ids: args.model_ids,
          force_prompt_mode: args.force_prompt_mode,
        });

        const { session, api_responses, pending_prompts } = result;

        if (session.responses.length === session.models_assigned.length) {
          const analysis = session.agreement_analysis!;
          const hasConflicts = analysis.conflicting_points.some((c) => c.requires_user_decision);

          if (hasConflicts) {
            return output({
              status: 'needs_approval',
              data: {
                session_id: session.session_id,
                agreement: analysis.overall_agreement,
                agreed_points: analysis.agreed_points,
                conflicts: analysis.conflicting_points,
                unique_insights: analysis.unique_insights,
                synthesis: analysis.synthesis,
                responses: session.responses.map((r) => ({ model: r.model_id, confidence: r.confidence, key_points: r.key_points, risks: r.risks_identified })),
              },
              message: `Models DISAGREE on ${analysis.conflicting_points.filter((c) => c.requires_user_decision).length} fundamental point(s). User decision required.`,
              next: {
                control: 'user',
                description: 'The architects disagree. You are the decision-maker.',
                bootstrap_prompt: `The models have conflicting positions:\n\n${analysis.conflicting_points.filter((c) => c.requires_user_decision).map((c) => `**${c.topic}**:\n${c.positions.map((p) => `  - [${p.model_id}]: ${p.position}`).join('\n')}`).join('\n\n')}\n\nReview both positions above, then use:\ndeliberation_resolve with session_id="${session.session_id}" resolution="<your decision and reasoning>"`,
              },
            });
          }

          return output({
            status: 'success',
            data: {
              session_id: session.session_id,
              resolution: 'consensus',
              agreement: analysis.overall_agreement,
              agreed_points: analysis.agreed_points,
              synthesis: analysis.synthesis,
            },
            message: `CONSENSUS reached (${(analysis.overall_agreement * 100).toFixed(0)}% agreement). Both models align.`,
            next: {
              control: 'agent',
              description: 'Consensus achieved. Record the decision and proceed.',
              bootstrap_prompt: `Multi-model consensus reached on session ${session.session_id} (${(analysis.overall_agreement * 100).toFixed(0)}% agreement).\nAgreed approach: ${analysis.agreed_points.slice(0, 3).join('; ')}\n\nRecord this consensus as an ADR using decision_record_adr with the agreed points, then use improvements_triage to generate proposals, or use pipeline_next if inside an active pipeline.`,
            },
          });
        }

        if (pending_prompts.length > 0) {
          const first = pending_prompts[0];
          return output({
            status: 'needs_input',
            data: {
              session_id: session.session_id,
              api_responses_received: api_responses.length,
              pending_models: pending_prompts.map((p) => ({ model: p.model_id, name: p.display_name, provider: p.provider })),
              prompts: pending_prompts.map((p) => ({ model: p.model_id, name: p.display_name, prompt: p.prompt })),
            },
            message: `${api_responses.length} API response(s), ${pending_prompts.length} pending. Process prompts and submit.`,
            next: {
              control: 'user',
              description: `Switch to ${first.display_name} and process the prompt.`,
              bootstrap_prompt: `[Model: ${first.display_name}] Switch to ${first.display_name} in Cursor, then analyze:\n\n${first.prompt.slice(0, 500)}...\n\nAfter getting the response, use:\ndeliberation_submit with session_id="${session.session_id}" model_id="${first.model_id}" response="<paste model response>" key_points=["point1","point2"] risks=["risk1"] confidence=0.8`,
            },
          });
        }

        return output({
          status: 'success',
          data: { session_id: session.session_id },
          message: 'Deliberation started, awaiting responses.',
          next: { control: 'agent', description: 'Deliberation started. Check status or wait for API responses.', bootstrap_prompt: `Deliberation session ${session.session_id} started. Use deliberation_status with session_id="${session.session_id}" to check progress, or wait for model responses to arrive.` },
        });
      } catch (e: unknown) {
        return output({ status: 'error', data: { error: String(e) }, message: `Deliberation failed: ${e instanceof Error ? e.message : String(e)}`, next: { control: 'user', description: 'Deliberation failed. Review the error and try again.', bootstrap_prompt: `Deliberation failed: ${e instanceof Error ? e.message : String(e)}\n\nCommon causes:\n- No models available (check model_list for available models)\n- Invalid model IDs specified\n\nFix the issue and retry deliberation_start, or proceed without deliberation using improvements_triage directly.` } });
      }
    },
  );

  server.tool(
    'deliberation_submit',
    'Submit a model response to a deliberation session (for prompt-mode models).',
    {
      session_id: z.string(),
      model_id: z.string(),
      response: z.string().describe('The model response text'),
      confidence: z.number().min(0).max(1).optional(),
      key_points: z.array(z.string()).optional(),
      risks: z.array(z.string()).optional(),
    },
    async (args) => {
      const session = submitDeliberationResponse(
        args.session_id, args.model_id, args.response,
        args.confidence, args.key_points, args.risks,
      );
      if (!session) return output({ status: 'error', data: {}, message: 'Session not found.', next: { control: 'user', description: 'Deliberation session not found. Check the session ID.', bootstrap_prompt: `Session "${args.session_id}" was not found. Use deliberation_start to create a new session, or check your session ID.` } });

      const remaining = session.models_assigned.filter(
        (m) => !session.responses.some((r) => r.model_id === m),
      );

      if (remaining.length > 0) {
        return output({
          status: 'needs_input',
          data: { responses_so_far: session.responses.length, remaining_models: remaining },
          message: `Response recorded. ${remaining.length} model(s) still pending.`,
          next: {
            control: 'user',
            description: `Submit response for ${remaining[0]}.`,
            bootstrap_prompt: `Switch to the model for "${remaining[0]}" and process the same deliberation prompt.\nThen use deliberation_submit with session_id="${args.session_id}" model_id="${remaining[0]}"`,
          },
        });
      }

      const analysis = session.agreement_analysis!;
      const hasConflicts = analysis.conflicting_points.some((c) => c.requires_user_decision);

      if (hasConflicts) {
        return output({
          status: 'needs_approval',
          data: {
            session_id: session.session_id,
            agreement: analysis.overall_agreement,
            agreed_points: analysis.agreed_points,
            conflicts: analysis.conflicting_points,
            synthesis: analysis.synthesis,
          },
          message: `All responses in. Models DISAGREE — user decision required.`,
          next: {
            control: 'user',
            description: 'You are the tie-breaker. Review the conflicts.',
            bootstrap_prompt: `${analysis.conflicting_points.filter((c) => c.requires_user_decision).map((c) => `**${c.topic}**: ${c.positions.map((p) => `[${p.model_id}] ${p.position}`).join(' vs ')}`).join('\n')}\n\nUse deliberation_resolve with session_id="${session.session_id}" resolution="<your decision>"`,
          },
        });
      }

      return output({
        status: 'success',
        data: { session_id: session.session_id, agreement: analysis.overall_agreement, synthesis: analysis.synthesis },
        message: `CONSENSUS: ${(analysis.overall_agreement * 100).toFixed(0)}% agreement.`,
        next: {
          control: 'agent',
          description: 'Consensus achieved. Record the decision and continue.',
          bootstrap_prompt: `Multi-model consensus on session ${session.session_id} (${(analysis.overall_agreement * 100).toFixed(0)}% agreement).\n\nSynthesis: ${analysis.synthesis}\n\nRecord this as an ADR using decision_record_adr, then use improvements_triage to generate proposals, or use pipeline_next if inside an active pipeline.`,
        },
      });
    },
  );

  server.tool(
    'deliberation_resolve',
    'Record the user decision on a deliberation conflict. You are the final decision-maker when the architects disagree.',
    {
      session_id: z.string(),
      resolution: z.string().describe('Your decision and reasoning'),
      chosen_model: z.string().optional().describe('Which model position you favor, if applicable'),
    },
    async (args) => {
      const session = resolveDeliberation(args.session_id, args.resolution, args.chosen_model);
      if (!session) return output({ status: 'error', data: {}, message: 'Session not found.', next: { control: 'user', description: 'Deliberation session not found. Check the session ID.', bootstrap_prompt: `Session "${args.session_id}" was not found. Use deliberation_start to create a new session, or verify the session ID.` } });

      return output({
        status: 'success',
        data: { session_id: session.session_id, resolution: session.resolution, decision: session.final_recommendation },
        message: 'Decision recorded. Proceeding with your chosen approach.',
        next: {
          control: 'agent',
          description: 'User has decided. Record as ADR and continue.',
          bootstrap_prompt: `User resolved deliberation ${session.session_id}.\nDecision: ${args.resolution}\n\nRecord this as an ADR using decision_record_adr, then proceed with the delivery pipeline.`,
        },
      });
    },
  );

  server.tool(
    'deliberation_status',
    'Check the status of a deliberation session.',
    { session_id: z.string() },
    async (args) => {
      const session = getDeliberation(args.session_id);
      if (!session) return output({ status: 'error', data: {}, message: 'Session not found.', next: { control: 'user', description: 'Session not found. Check the session ID.', bootstrap_prompt: `Session "${args.session_id}" was not found. Use deliberation_start to create a new session.` } });
      const remaining = session.models_assigned.filter((m) => !session.responses.some((r) => r.model_id === m));
      const hasConflicts = session.agreement_analysis?.conflicting_points.some((c) => c.requires_user_decision) ?? false;
      return output({
        status: 'success',
        data: {
          session_id: session.session_id,
          models: session.models_assigned,
          responses: session.responses.length,
          resolution: session.resolution,
          agreement: session.agreement_analysis?.overall_agreement ?? null,
          conflicts: session.agreement_analysis?.conflicting_points.length ?? 0,
        },
        message: `Session ${session.resolution}: ${session.responses.length}/${session.models_assigned.length} responses.`,
        next: session.resolution === 'pending' && remaining.length > 0
          ? { control: 'user', description: `${remaining.length} model response(s) still pending.`, bootstrap_prompt: `Session ${session.session_id} is waiting for responses from: ${remaining.join(', ')}.\n\nSubmit responses using deliberation_submit with session_id="${session.session_id}" model_id="<model>" response="<response>".` }
          : session.resolution === 'pending' && hasConflicts
            ? { control: 'user', description: 'Models disagree. Your decision is needed.', bootstrap_prompt: `Session ${session.session_id} has conflicting positions that require your decision. Use deliberation_resolve with session_id="${session.session_id}" resolution="<your decision>".` }
            : { control: 'user', description: 'Deliberation status retrieved.', bootstrap_prompt: `Session ${session.session_id} status: ${session.resolution}. ${session.agreement_analysis ? `Agreement: ${(session.agreement_analysis.overall_agreement * 100).toFixed(0)}%.` : ''}\n\nUse pipeline_next to continue an active pipeline, or use the deliberation results to inform your next action.` },
      });
    },
  );

  // =========================================================================
  // KNOWLEDGE — Baseline patterns and cleanup checklists
  // =========================================================================

  server.tool(
    'baselines',
    'View the quality patterns the refinery evaluates servers against. These are derived from the refinery\'s own architecture — the standard it holds other servers to.',
    {
      category: z.enum(['all', 'critical', 'architecture', 'governance', 'devex', 'reliability', 'security', 'maintenance', 'compliance']).optional().describe('Filter by category (default: critical). Use "compliance" to see healthcare compliance patterns for evaluating agentic dev tools that build PHI-touching software.'),
    },
    async (args) => {
      const cat = args.category ?? 'critical';
      const patterns = cat === 'all' ? getAllPatterns() : cat === 'critical' ? getCriticalPatterns() : getAllPatterns().filter((p) => p.category === cat);
      return output({
        status: 'success',
        data: {
          count: patterns.length,
          patterns: patterns.map((p) => ({
            id: p.pattern_id,
            name: p.name,
            category: p.category,
            severity: p.severity,
            description: p.description,
            detection_hints: p.detection_hints,
          })),
        },
        message: `${patterns.length} baseline pattern(s) for category "${cat}".`,
        next: { control: 'user', description: 'Baseline patterns retrieved. Use these to evaluate servers or guide implementation.', bootstrap_prompt: `${patterns.length} baseline quality patterns displayed. These are the standards the refinery evaluates servers against.\n\nTo evaluate a server against these patterns: use refine with the target_server_id.\nTo see all categories: use baselines with category="all".\nTo see the implementation guide for building tools to these standards: use cleanup_checklist.` },
      });
    },
  );

  server.tool(
    'cleanup_checklist',
    'Get the post-change cleanup checklist. Use this after making changes to verify nothing was left misaligned.',
    {},
    async () => {
      const checklist = buildCleanupChecklist();
      return output({
        status: 'success',
        data: { checklist },
        message: 'Cleanup checklist ready. Run this against all recently changed files.',
        next: {
          control: 'agent',
          description: 'Run the checklist against recently modified files.',
          bootstrap_prompt: checklist,
        },
      });
    },
  );

  // =========================================================================
  // CONTINUOUS IMPROVEMENT — Feedback loop
  // =========================================================================

  server.tool(
    'feedback_query',
    'Query the continuous improvement feedback log. Returns strengths, weaknesses, and lessons learned from past pipeline runs. Use this to understand what worked and what needs improvement. Feed results into research prompts for informed analysis.',
    {
      target_server_id: z.string().optional().describe('Filter feedback by server. Omit to see feedback across all servers.'),
      limit: z.number().optional().describe('Maximum entries to return (default: 20)'),
    },
    async (args) => {
      const entries = args.target_server_id
        ? getFeedback(args.target_server_id, args.limit ?? 20)
        : getAllFeedback(args.limit ?? 20);

      if (entries.length === 0) {
        return output({
          status: 'success',
          data: { count: 0, entries: [] },
          message: 'No feedback recorded yet. Feedback is captured automatically when pipelines complete.',
          next: {
            control: 'user',
            description: 'Run a pipeline to generate feedback.',
            bootstrap_prompt: 'No feedback entries found. Feedback is recorded automatically when pipelines complete. Use refine to start an improvement cycle — when it completes, strengths, weaknesses, and lessons learned will be captured and available here.',
          },
        });
      }

      // Aggregate themes across entries
      const strengthCounts = new Map<string, number>();
      const weaknessCounts = new Map<string, number>();
      for (const e of entries) {
        for (const s of e.strengths) strengthCounts.set(s, (strengthCounts.get(s) ?? 0) + 1);
        for (const w of e.weaknesses) weaknessCounts.set(w, (weaknessCounts.get(w) ?? 0) + 1);
      }

      const topStrengths = [...strengthCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      const topWeaknesses = [...weaknessCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

      return output({
        status: 'success',
        data: {
          count: entries.length,
          summary: {
            top_strengths: topStrengths.map(([s, c]) => ({ strength: s, occurrences: c })),
            top_weaknesses: topWeaknesses.map(([w, c]) => ({ weakness: w, occurrences: c })),
          },
          entries: entries.slice(0, 10).map((e) => ({
            feedback_id: e.feedback_id,
            pipeline_id: e.pipeline_id,
            target: e.target_server_id,
            command: e.command,
            strengths: e.strengths,
            weaknesses: e.weaknesses,
            lessons_learned: e.lessons_learned,
            proposals_acted_on: e.proposals_acted_on,
            created_at: e.created_at,
          })),
        },
        message: `${entries.length} feedback entry/entries. Top strength: "${topStrengths[0]?.[0] ?? 'none'}". Top weakness: "${topWeaknesses[0]?.[0] ?? 'none'}".`,
        next: {
          control: 'user',
          description: 'Review feedback themes. Use these insights to guide your next improvement cycle.',
          bootstrap_prompt: `${entries.length} feedback entries analyzed.\n\n**Recurring strengths** (reinforce these):\n${topStrengths.map(([s, c]) => `- ${s} (${c}x)`).join('\n') || '- none yet'}\n\n**Recurring weaknesses** (address these):\n${topWeaknesses.map(([w, c]) => `- ${w} (${c}x)`).join('\n') || '- none yet'}\n\nTo use this feedback in a new pipeline:\nUse refine with target_server_id — the research overlay automatically consults past feedback.\n\nTo drill into a specific entry: review the entries data above.`,
        },
      });
    },
  );

  // =========================================================================
  // RESEARCH OPS — Governed research lifecycle for self-improvement
  // =========================================================================

  server.tool(
    'research_new',
    'Create a new Research Case with full scaffolding and pipeline initialization. This is the entry point for all research.',
    {
      initiative_name: z.string().describe('Name of the research initiative'),
      owner: z.string().describe('Owner of this research case'),
      problem_statement: z.string().describe('Problem we are solving'),
      goals: z.array(z.string()).describe('Measurable goals'),
      non_goals: z.array(z.string()).optional().describe('Explicit non-goals'),
      risk_lane: z.enum(['low', 'medium', 'high']).describe('Risk lane: low, medium, or high'),
      phi_classification: z.enum(['none', 'internal_only', 'restricted']).optional().default('none').describe('PHI classification — defaults to \'none\''),
      target_consumer: z.enum(['mcp_refinery', 'software_agent', 'both']).optional().default('both').describe('Target consumer of the change proposal'),
    },
    async (args) => {
      const rc = createCase({
        initiative_name: args.initiative_name,
        owner: args.owner,
        problem_statement: args.problem_statement,
        goals: args.goals,
        non_goals: args.non_goals,
        risk_lane: args.risk_lane,
        phi_classification: args.phi_classification,
        target_consumer: args.target_consumer,
      });

      return output({
        status: 'success',
        data: {
          case_id: rc.case_id,
          status: rc.status,
          current_overlay: rc.current_overlay,
          pipeline: CASE_OVERLAY_PIPELINE,
          risk_lane: rc.risk_lane,
          phi_classification: rc.phi_classification,
          change_budget: rc.change_budget,
        },
        message: `Research Case "${rc.initiative_name}" created (${rc.case_id}).`,
        next: {
          control: 'agent',
          description: 'Ingest source material to advance the case.',
          bootstrap_prompt: `Case ${rc.case_id} created. Pipeline: ${CASE_OVERLAY_PIPELINE.join(' → ')}\n\nNext: Ingest raw research sources. Call research_advance with:\n- case_id="${rc.case_id}"\n- source_content={"chatgpt": "<content>", "gemini": "<content>", "external_links": "<content>"}\n\nSources are stored as-is (never executed, never trusted). The synthesis step will extract structured findings.`,
        },
      });
    },
  );

  server.tool(
    'research_advance',
    'Advance a Research Case through the overlay pipeline. Automatically executes the current overlay and moves to the next. At alignment gates (freeze, release), returns control to the user for approval.',
    {
      case_id: z.string().describe('Research Case ID (RC-YYYYMMDD-slug format)'),
      source_content: z.record(z.string()).optional().describe('Source content to ingest, keyed by name (chatgpt, gemini, grok, external_links, internal_notes)'),
      user_approval: z.boolean().optional().describe('Explicit user approval for alignment gates (freeze, release)'),
    },
    async (args) => {
      const result = advanceCase(args.case_id, {
        source_content: args.source_content,
        user_approval: args.user_approval,
      });

      if (!result) {
        return output({
          status: 'error',
          data: {},
          message: `Case "${args.case_id}" not found.`,
          next: {
            control: 'user',
            description: 'Case not found. Check the ID or create a new one.',
            bootstrap_prompt: `Case "${args.case_id}" does not exist. Use research_new to create a new case, or research_status to list existing cases.`,
          },
        });
      }

      return output({
        status: result.needs_user_approval ? 'needs_approval' : 'success',
        data: {
          case_id: result.case_id,
          previous_overlay: result.previous_overlay,
          current_overlay: result.current_overlay,
          status: result.status,
          action: result.action_taken,
        },
        message: result.action_taken,
        next: {
          control: result.needs_user_approval ? 'user' : 'agent',
          description: result.needs_user_approval
            ? 'Alignment gate reached. User approval required.'
            : `Case advanced to "${result.current_overlay}".`,
          bootstrap_prompt: result.bootstrap_prompt,
        },
      });
    },
  );

  server.tool(
    'research_status',
    'Check the status of a Research Case or list all cases. Shows pipeline progress, current overlay, gates, and next steps.',
    {
      case_id: z.string().optional().describe('Case ID to check — omit to list all cases'),
    },
    async (args) => {
      if (args.case_id) {
        const rc = getCase(args.case_id);
        if (!rc) {
          return output({
            status: 'error',
            data: {},
            message: `Case "${args.case_id}" not found.`,
            next: {
              control: 'user',
              description: 'Case not found.',
              bootstrap_prompt: `Case "${args.case_id}" does not exist. Use research_new to create a new case, or research_status (no args) to list all cases.`,
            },
          });
        }

        const completed = CASE_OVERLAY_PIPELINE.slice(0, rc.overlay_index);
        const remaining = CASE_OVERLAY_PIPELINE.slice(rc.overlay_index + 1);
        const reviewCount = Object.keys(rc.reviews).length;

        return output({
          status: 'success',
          data: {
            case_id: rc.case_id,
            initiative: rc.initiative_name,
            status: rc.status,
            current_overlay: rc.current_overlay,
            progress: `${rc.overlay_index + 1}/${CASE_OVERLAY_PIPELINE.length}`,
            completed_overlays: completed,
            remaining_overlays: remaining,
            risk_lane: rc.risk_lane,
            phi_classification: rc.phi_classification,
            sources: Object.keys(rc.sources).length,
            reviews: `${reviewCount}/${REVIEW_PERSPECTIVES.length}`,
            decision: rc.decision?.outcome ?? 'pending',
            proposal_frozen: rc.proposal?.frozen ?? false,
            evaluation: rc.evaluation?.overall_pass ?? null,
            change_budget: rc.change_budget,
          },
          message: `[${rc.case_id}] ${rc.initiative_name}: ${completed.map((o) => `${o} ✓`).join(' → ')}${completed.length > 0 ? ' → ' : ''}**${rc.current_overlay}** → ${remaining.join(' → ')}`,
          next: rc.status === 'frozen'
            ? { control: 'user', description: 'Alignment gate. Approve to continue.', bootstrap_prompt: `Case ${rc.case_id} is at the freeze alignment gate. Review the proposal and call research_advance with case_id="${rc.case_id}" user_approval=true to approve.` }
            : rc.status === 'completed' || rc.status === 'rejected'
              ? { control: 'user', description: `Case is ${rc.status}.`, bootstrap_prompt: `Case ${rc.case_id} is ${rc.status}. Use research_consult to query artifacts, or research_new to start a new case.` }
              : { control: 'agent', description: `Continue with "${rc.current_overlay}" overlay.`, bootstrap_prompt: `Case ${rc.case_id} is at "${rc.current_overlay}". Use research_advance with case_id="${rc.case_id}" to continue.` },
        });
      }

      // List all cases
      const cases = listCases();
      const active = cases.filter((c) => !['completed', 'rejected', 'deferred'].includes(c.status));
      const closed = cases.filter((c) => ['completed', 'rejected', 'deferred'].includes(c.status));

      return output({
        status: 'success',
        data: {
          total: cases.length,
          active: active.map((c) => ({
            case_id: c.case_id,
            initiative: c.initiative_name,
            status: c.status,
            overlay: c.current_overlay,
            risk: c.risk_lane,
          })),
          closed: closed.map((c) => ({
            case_id: c.case_id,
            initiative: c.initiative_name,
            status: c.status,
          })),
        },
        message: `${cases.length} case(s): ${active.length} active, ${closed.length} closed.`,
        next: active.length > 0
          ? { control: 'agent', description: 'Active cases found. Continue the most recent one.', bootstrap_prompt: `${active.length} active case(s). Most recent: ${active[0].case_id} ("${active[0].initiative_name}") at "${active[0].current_overlay}". Use research_advance with case_id="${active[0].case_id}" to continue.` }
          : { control: 'user', description: 'No active cases. Create a new one.', bootstrap_prompt: 'No active research cases. Use research_new to start a new research initiative.' },
      });
    },
  );

  server.tool(
    'research_consult',
    'Query a Research Case for decisions, evidence, or artifact content. Use this to understand what was decided and why.',
    {
      case_id: z.string().describe('Research Case ID to query'),
      question: z.string().describe('Question about this case'),
      artifact: z.enum(['intake', 'synthesis', 'evidence_matrix', 'reviews', 'decision', 'proposal', 'brief', 'evaluation', 'release_notes']).optional().describe('Specific artifact to focus on'),
    },
    async (args) => {
      const result = consultCase(args.case_id, args.question, args.artifact);

      return output({
        status: result.case_status === 'rejected' && result.relevant_artifacts.length === 0 ? 'error' : 'success',
        data: {
          case_id: args.case_id,
          question: args.question,
          artifacts_consulted: result.relevant_artifacts,
          case_status: result.case_status,
        },
        message: result.answer,
        next: {
          control: 'user',
          description: 'Case consultation complete. Review the answer above.',
          bootstrap_prompt: `Consultation for case ${args.case_id} complete. Artifacts consulted: ${result.relevant_artifacts.join(', ') || 'none available'}.\n\nTo drill deeper: use research_consult with a specific artifact parameter.\nTo advance the case: use research_advance with case_id="${args.case_id}".\nTo validate: use research_validate with case_id="${args.case_id}".`,
        },
      });
    },
  );

  server.tool(
    'research_validate',
    'Run deterministic validation checks on a Research Case. Checks structure, PHI policy, review completeness, scope freeze, acceptance criteria, and more.',
    {
      case_id: z.string().describe('Research Case ID to validate'),
    },
    async (args) => {
      const rc = getCase(args.case_id);
      if (!rc) {
        return output({
          status: 'error',
          data: {},
          message: `Case "${args.case_id}" not found.`,
          next: {
            control: 'user',
            description: 'Case not found.',
            bootstrap_prompt: `Case "${args.case_id}" does not exist. Use research_new to create a new case, or research_status to list existing cases.`,
          },
        });
      }

      const result = validateCase(rc);
      const errors = result.checks.filter((c) => !c.passed && c.severity === 'error');
      const warnings = result.checks.filter((c) => !c.passed && c.severity === 'warning');

      return output({
        status: result.passed ? 'success' : 'error',
        data: {
          case_id: result.case_id,
          passed: result.passed,
          checks: result.checks,
          error_count: errors.length,
          warning_count: warnings.length,
          validated_at: result.validated_at,
        },
        message: result.passed
          ? `Validation passed: ${result.checks.length} checks, 0 errors, ${warnings.length} warning(s).`
          : `Validation FAILED: ${errors.length} error(s), ${warnings.length} warning(s).\n${errors.map((e) => `  - ${e.name}: ${e.message}`).join('\n')}`,
        next: result.passed
          ? { control: 'agent', description: 'All validation checks passed. Case can proceed.', bootstrap_prompt: `Case ${args.case_id} passed all ${result.checks.length} validation checks. Use research_advance to continue.` }
          : { control: 'user', description: 'Validation failed. Fix the issues before proceeding.', bootstrap_prompt: `Case ${args.case_id} failed validation with ${errors.length} error(s):\n${errors.map((e) => `- ${e.name}: ${e.message}`).join('\n')}\n\nFix these issues, then re-run research_validate.` },
      });
    },
  );
}
