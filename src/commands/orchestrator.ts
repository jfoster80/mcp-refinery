/**
 * Pipeline Orchestrator — the brain behind "just say refine."
 *
 * Classifies intent → picks command → sequences overlays → engages agents →
 * routes to the right models → returns bootstrap prompts at each step.
 *
 * The user never sees the internal plumbing. They see:
 *   "Research Agent analyzing security... Architecture Agent reviewing...
 *    Models agree. 3 proposals. Top proposal needs approval."
 */

import { randomUUID } from 'node:crypto';
import { JsonStore } from '../storage/json-store.js';
import { getConfig } from '../config.js';
import { pickAgentsForIntent, getAgent } from '../agents/registry.js';
import { classifyTask, routeTask } from '../routing/index.js';
import {
  startResearch, storeFindings, computeConsensus, sanitizeFindings,
  FINDINGS_JSON_SHAPE,
} from '../research/index.js';
import {
  upsertTargetServer, getTargetServer, listTargetServers, getResearchFeeds,
  getLatestConsensus, insertConsensusResult, listProposals,
  recordAudit, insertFeedback, getFeedback,
} from '../storage/index.js';
import type { FeedbackEntry } from '../types/index.js';
import { triageFindings } from '../decision/index.js';
import { buildCleanupChecklist, buildDocumentationGuide, buildImplementationGuide, matchFindingsToBaselines, buildFeedbackPromptSection } from '../knowledge/index.js';
import { createCase as createResearchCase } from '../research-ops/index.js';
import type { ResearchPerspective } from '../types/index.js';
import type { TaskClassification } from '../types/index.js';
import type { RoutingDecision } from '../routing/router.js';

// ---------------------------------------------------------------------------
// Pipeline State
// ---------------------------------------------------------------------------

export interface PipelineState {
  pipeline_id: string;
  target_server_id: string;
  intent: string;
  command: CommandName;
  overlays: OverlayName[];
  overlay_index: number;
  step_within_overlay: number;
  agents_engaged: string[];
  classification: TaskClassification | null;
  routing: RoutingDecision | null;
  data: Record<string, unknown>;
  status: 'running' | 'waiting_agent' | 'waiting_user' | 'completed' | 'error';
  error_message: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export type CommandName = 'refine' | 'assess' | 'review' | 'improve' | 'audit' | 'consult';
export type OverlayName =
  | 'research' | 'classify' | 'deliberate' | 'triage'
  | 'align' | 'plan' | 'execute' | 'cleanup' | 'document'
  | 'release' | 'propagate' | 'consult';

const COMMAND_OVERLAYS: Record<CommandName, OverlayName[]> = {
  refine:  ['research', 'classify', 'triage', 'align', 'plan', 'execute', 'cleanup', 'document', 'release', 'propagate'],
  assess:  ['research', 'classify'],
  review:  ['classify', 'deliberate', 'align'],
  improve: ['research', 'triage', 'align', 'plan', 'execute', 'cleanup', 'document'],
  audit:   ['research', 'classify'],
  consult: ['classify', 'deliberate', 'align'],
};

export interface StepResult {
  pipeline_id: string;
  overlay: string;
  step: string;
  agents_active: string[];
  model_instruction: string;
  status: PipelineState['status'];
  data: Record<string, unknown>;
  message: string;
  next: {
    control: 'agent' | 'user';
    description: string;
    bootstrap_prompt: string;
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let _store: JsonStore<PipelineState> | null = null;
function store(): JsonStore<PipelineState> {
  if (!_store) _store = new JsonStore(getConfig().storage.base_path, 'pipelines', 'pipeline_id');
  return _store;
}

// ---------------------------------------------------------------------------
// Intent Classification
// ---------------------------------------------------------------------------

function classifyIntent(intent: string): CommandName {
  const lower = intent.toLowerCase();
  if (lower.includes('refine') || lower.includes('full') || lower.includes('complete')) return 'refine';
  if (lower.includes('assess') || lower.includes('evaluate') || lower.includes('score')) return 'assess';
  if (lower.includes('review') || lower.includes('deliberat') || lower.includes('architect')) return 'review';
  if (lower.includes('improve') || lower.includes('fix') || lower.includes('enhance')) return 'improve';
  if (lower.includes('audit') || lower.includes('security') || lower.includes('compliance')) return 'audit';
  if (lower.includes('consult') || lower.includes('ask') || lower.includes('question')) return 'consult';
  return 'refine';
}

const OVERLAY_DESCRIPTIONS: Record<OverlayName, string> = {
  research: 'Deep multi-perspective research',
  classify: 'Task classification & model routing',
  deliberate: 'Multi-model deliberation (iron sharpens iron)',
  triage: 'Proposal triage & prioritization',
  align: 'User alignment gate — confirm direction before changes',
  plan: 'Delivery planning',
  execute: 'PR creation & testing',
  cleanup: 'Post-change cleanup & artifact verification',
  document: 'Documentation update — README, architecture, config reference',
  release: 'Semantic versioning & release',
  propagate: 'Cross-server improvement propagation',
  consult: 'Expert consultation',
};

// ---------------------------------------------------------------------------
// Pipeline Lifecycle
// ---------------------------------------------------------------------------

/** Aliases that all resolve to the built-in "self" target. */
const SELF_ALIASES = new Set(['self', 'mr', 'm-r', 'mcp-refinery']);

/**
 * If the target is the refinery itself, canonicalize to "self" and auto-enrich
 * pipeline input with the refinery's own metadata so no manual context is needed.
 */
function normalizeSelfTarget(input: {
  target_server_id: string;
  server_name?: string;
  repo_url?: string;
  context?: string;
  current_tools?: string[];
  current_resources?: string[];
}): void {
  if (!SELF_ALIASES.has(input.target_server_id.toLowerCase())) return;

  input.target_server_id = 'self';
  input.server_name = 'MCP Refinery';

  const config = getConfig();
  const sourcePath = config.storage.source_path;
  if (sourcePath) {
    input.repo_url = input.repo_url || `file://${sourcePath}`;
  } else {
    input.repo_url = input.repo_url || 'https://github.com/jfoster80/mcp-refinery';
  }

  // Auto-inject the refinery's own tool names as context
  if (!input.current_tools || input.current_tools.length === 0) {
    input.current_tools = [
      // Facade tools (primary interface)
      'refine', 'consult', 'ingest', 'pipeline_next', 'pipeline_status',
      'pipeline_cancel', 'pipeline_purge',
      // Server management
      'server_register', 'server_list',
      // Research plane
      'research_start', 'research_store', 'research_consensus', 'research_query',
      // Decision plane
      'improvements_triage', 'decision_record_adr', 'decision_check_oscillation', 'decision_capture_scorecard',
      // Delivery plane
      'delivery_plan', 'delivery_create_pr', 'delivery_release',
      // Governance
      'governance_approve', 'governance_check',
      // Audit & search
      'audit_query', 'audit_stats', 'search_similar',
      // Model routing
      'model_list', 'model_classify',
      // Multi-model deliberation
      'deliberation_start', 'deliberation_submit', 'deliberation_resolve', 'deliberation_status',
      // Knowledge & cleanup
      'baselines', 'cleanup_checklist',
      // ResearchOps (governed research lifecycle)
      'research_new', 'research_advance', 'research_status', 'research_consult', 'research_validate',
      // Continuous improvement (feedback loop)
      'feedback_query',
    ];
  }

  // Add self-improvement note to context
  const selfNote = 'SELF-IMPROVEMENT MODE: The target is the MCP Refinery\'s own codebase.' +
    (sourcePath ? ` Source path: ${sourcePath}.` : '') +
    ' Apply the same alignment gates and cleanup passes. The refinery improves itself by the same standards it applies to others.';
  input.context = input.context ? `${selfNote}\n\n${input.context}` : selfNote;
}

export function startPipeline(input: {
  target_server_id: string;
  server_name?: string;
  repo_url?: string;
  intent: string;
  context?: string;
  research_content?: string;
  transport?: string;
  current_tools?: string[];
  current_resources?: string[];
}): StepResult {
  normalizeSelfTarget(input);

  const command = classifyIntent(input.intent);
  let overlays = [...COMMAND_OVERLAYS[command]];
  const agents = pickAgentsForIntent(input.intent);

  // When raw research content is provided, inject 'research' overlay at front if absent
  if (input.research_content && !overlays.includes('research')) {
    overlays = ['research', ...overlays];
  }

  const now = new Date().toISOString();

  // Try to find existing server registration; only create/update if we have metadata
  const existing = getTargetServer(input.target_server_id);
  if (existing) {
    if (input.server_name || input.repo_url) {
      upsertTargetServer({
        ...existing,
        name: input.server_name ?? existing.name,
        repo_url: input.repo_url ?? existing.repo_url,
        updated_at: now,
      });
    }
  } else {
    upsertTargetServer({
      server_id: input.target_server_id,
      name: input.server_name ?? input.target_server_id,
      repo_url: input.repo_url ?? '',
      branch: 'main',
      transport: (input.transport as 'stdio' | 'http') ?? 'stdio',
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

  const classification = classifyTask({
    description: input.intent,
    is_architectural: command === 'review',
    touches_security: command === 'audit',
    user_requested_multi: command === 'review' || command === 'consult',
  });

  const routing = routeTask({
    description: input.intent,
    is_architectural: command === 'review',
    touches_security: command === 'audit',
    user_requested_multi: command === 'review' || command === 'consult',
  });

  const pipeline: PipelineState = {
    pipeline_id: randomUUID(),
    target_server_id: input.target_server_id,
    intent: input.intent,
    command,
    overlays,
    overlay_index: 0,
    step_within_overlay: 0,
    agents_engaged: agents.map((a) => a.agent_id),
    classification,
    routing,
    data: {
      server_name: input.server_name ?? input.target_server_id,
      repo_url: input.repo_url ?? '',
      context: input.context ?? '',
      research_content: input.research_content ?? '',
      current_tools: input.current_tools ?? [],
      current_resources: input.current_resources ?? [],
    },
    status: 'running',
    error_message: null,
    created_at: now,
    updated_at: now,
  };

  store().insert(pipeline);

  recordAudit('pipeline.start', 'orchestrator', 'pipeline', pipeline.pipeline_id, {
    command, overlays, agents: pipeline.agents_engaged,
  });

  return executeCurrentStep(pipeline, input);
}

export function advancePipeline(
  pipelineId: string,
  agentInput?: Record<string, unknown>,
  options?: { force_advance?: boolean; complete_overlay?: boolean },
): StepResult | null {
  const pipeline = store().get(pipelineId);
  if (!pipeline) return null;

  if (agentInput) {
    pipeline.data = { ...pipeline.data, ...agentInput };
  }

  // Force advance: skip current overlay entirely
  if (options?.force_advance || options?.complete_overlay) {
    pipeline.updated_at = new Date().toISOString();
    recordAudit('pipeline.advance', 'orchestrator', 'pipeline', pipeline.pipeline_id, {
      action: options.force_advance ? 'force_advance' : 'complete_overlay',
      skipped_overlay: pipeline.overlays[pipeline.overlay_index],
    });
    return advanceToNextOverlay(pipeline as PipelineState);
  }

  // Sync: detect work completed via individual tools before executing
  const synced = syncWithIndividualTools(pipeline as PipelineState);
  if (synced) return synced;

  pipeline.step_within_overlay++;
  pipeline.updated_at = new Date().toISOString();

  // Persist state before executing to prevent data loss on error
  store().update(pipeline.pipeline_id, pipeline);

  try {
    return executeCurrentStep(pipeline as PipelineState, undefined);
  } catch (e) {
    pipeline.status = 'error';
    pipeline.error_message = `Overlay "${pipeline.overlays[pipeline.overlay_index]}" failed: ${e instanceof Error ? e.message : String(e)}`;
    store().update(pipeline.pipeline_id, pipeline);
    return stepResult(pipeline as PipelineState, overlay_label(pipeline.overlays[pipeline.overlay_index] as OverlayName),
      pipeline.error_message, 'error', {
        control: 'user',
        description: `Error in overlay. Use force_advance=true to skip, or fix the issue and retry.`,
        bootstrap_prompt: `Pipeline error: ${pipeline.error_message}\n\nOptions:\n- Fix the issue and call pipeline_next again\n- Use pipeline_next with force_advance=true to skip this overlay\n- Use the individual tools directly (research_store, research_consensus, etc.)`,
      });
  }
}

/**
 * Check if the current overlay was already completed via individual tool calls
 * (e.g., research_store + research_consensus done outside the pipeline).
 * If so, auto-advance the pipeline to stay in sync.
 */
function syncWithIndividualTools(pipeline: PipelineState): StepResult | null {
  const overlay = pipeline.overlays[pipeline.overlay_index];
  const serverId = pipeline.target_server_id;

  if (overlay === 'research') {
    const consensus = getLatestConsensus(serverId);
    if (consensus && consensus.findings.length > 0) {
      pipeline.data.consensus_id = consensus.consensus_id;
      pipeline.data.findings_count = consensus.findings.length;
      pipeline.data.agreement = consensus.overall_agreement;
      pipeline.data.synced_from_individual_tools = true;
      recordAudit('pipeline.sync', 'orchestrator', 'pipeline', pipeline.pipeline_id, {
        overlay: 'research', reason: 'consensus already computed via individual tools',
      });
      bridgeToResearchOps(pipeline);
      return advanceToNextOverlay(pipeline);
    }

    // Also check if sufficient research feeds exist but consensus hasn't been computed yet
    const feeds = getResearchFeeds(serverId);
    if (feeds.length >= 3) {
      const consensus2 = computeConsensus(feeds, serverId);
      insertConsensusResult(consensus2);
      pipeline.data.consensus_id = consensus2.consensus_id;
      pipeline.data.findings_count = consensus2.findings.length;
      pipeline.data.agreement = consensus2.overall_agreement;
      pipeline.data.synced_from_individual_tools = true;
      recordAudit('pipeline.sync', 'orchestrator', 'pipeline', pipeline.pipeline_id, {
        overlay: 'research', reason: `auto-computed consensus from ${feeds.length} individual feeds`,
      });
      bridgeToResearchOps(pipeline);
      return advanceToNextOverlay(pipeline);
    }
  }

  if (overlay === 'triage') {
    const proposals = listProposals(serverId, 'triaged');
    if (proposals.length > 0) {
      pipeline.data.actionable_count = proposals.length;
      pipeline.data.synced_from_individual_tools = true;
      recordAudit('pipeline.sync', 'orchestrator', 'pipeline', pipeline.pipeline_id, {
        overlay: 'triage', reason: `${proposals.length} proposals already triaged via individual tools`,
      });
      return advanceToNextOverlay(pipeline);
    }
  }

  return null;
}

export function getPipeline(id: string): PipelineState | null {
  return store().get(id) as PipelineState | null;
}

export function getActivePipeline(serverId?: string): PipelineState | null {
  const all = store().list((p) => p.status !== 'completed' && p.status !== 'error');
  if (serverId) {
    const normalized = SELF_ALIASES.has(serverId.toLowerCase()) ? 'self' : serverId;
    return (all.find((p) => p.target_server_id === normalized) as PipelineState) ?? null;
  }
  return (all.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] as PipelineState) ?? null;
}

/**
 * Cancel a single pipeline. Moves it to 'error' status with a cancellation reason.
 */
export function cancelPipeline(pipelineId: string, reason?: string): PipelineState | null {
  const pipeline = store().get(pipelineId);
  if (!pipeline) return null;

  if (pipeline.status === 'completed' || pipeline.status === 'error') {
    return pipeline as PipelineState;
  }

  pipeline.status = 'error';
  pipeline.error_message = reason ?? 'Cancelled by user';
  pipeline.updated_at = new Date().toISOString();
  store().update(pipeline.pipeline_id, pipeline);

  recordAudit('pipeline.cancel', 'orchestrator', 'pipeline', pipeline.pipeline_id, {
    reason: pipeline.error_message,
    cancelled_at_overlay: pipeline.overlays[pipeline.overlay_index],
    overlay_index: pipeline.overlay_index,
  });

  return pipeline as PipelineState;
}

/**
 * Purge all stuck or orphaned pipelines. Moves any pipeline that is not
 * 'completed' or 'error' to 'error' status with a purge reason.
 * Returns the count of pipelines purged.
 */
export function purgeStuckPipelines(reason?: string): { purged: number; pipelines: Array<{ pipeline_id: string; was_at: string; target: string }> } {
  const stuck = store().list((p) => p.status !== 'completed' && p.status !== 'error');
  const purged: Array<{ pipeline_id: string; was_at: string; target: string }> = [];

  for (const pipeline of stuck) {
    pipeline.status = 'error';
    pipeline.error_message = reason ?? 'Purged — orphaned pipeline from prior session';
    pipeline.updated_at = new Date().toISOString();
    store().update(pipeline.pipeline_id, pipeline);

    recordAudit('pipeline.cancel', 'orchestrator', 'pipeline', pipeline.pipeline_id, {
      reason: pipeline.error_message,
      action: 'purge',
      cancelled_at_overlay: pipeline.overlays[pipeline.overlay_index],
    });

    purged.push({
      pipeline_id: pipeline.pipeline_id,
      was_at: pipeline.overlays[pipeline.overlay_index] ?? 'unknown',
      target: pipeline.target_server_id,
    });
  }

  return { purged: purged.length, pipelines: purged };
}

// ---------------------------------------------------------------------------
// Step Execution
// ---------------------------------------------------------------------------

function executeCurrentStep(pipeline: PipelineState, initialInput?: Record<string, unknown>): StepResult {
  const overlay = pipeline.overlays[pipeline.overlay_index];
  if (!overlay) {
    pipeline.status = 'completed';
    store().update(pipeline.pipeline_id, pipeline);
    return completedResult(pipeline);
  }

  switch (overlay) {
    case 'research': return executeResearchOverlay(pipeline, initialInput);
    case 'classify': return executeClassifyOverlay(pipeline);
    case 'deliberate': return executeDeliberateOverlay(pipeline);
    case 'triage': return executeTriageOverlay(pipeline);
    case 'align': return executeAlignOverlay(pipeline);
    case 'plan': return executePlanOverlay(pipeline);
    case 'execute': return executeExecuteOverlay(pipeline);
    case 'cleanup': return executeCleanupOverlay(pipeline);
    case 'document': return executeDocumentOverlay(pipeline);
    case 'release': return executeReleaseOverlay(pipeline);
    case 'propagate': return executePropagateOverlay(pipeline);
    case 'consult': return executeDeliberateOverlay(pipeline);
    default: return advanceToNextOverlay(pipeline);
  }
}

function advanceToNextOverlay(pipeline: PipelineState): StepResult {
  pipeline.overlay_index++;
  pipeline.step_within_overlay = 0;
  pipeline.updated_at = new Date().toISOString();
  store().update(pipeline.pipeline_id, pipeline);
  return executeCurrentStep(pipeline, undefined);
}

// ---------------------------------------------------------------------------
// Overlay Implementations
// ---------------------------------------------------------------------------

function executeResearchOverlay(pipeline: PipelineState, input?: Record<string, unknown>): StepResult {
  const step = pipeline.step_within_overlay;
  const serverId = pipeline.target_server_id;
  const agentNames = engagedNames(pipeline, ['researcher', 'security_auditor']);
  const hasExternalContent = Boolean(pipeline.data.research_content);

  // Findings arrive via `input` (direct startPipeline call) or `pipeline.data`
  // (advancePipeline merges agentInput into pipeline.data, then passes undefined
  // as initialInput). Check both locations so findings are never silently dropped.
  const agentFindings = (input?.findings ?? pipeline.data.findings) as unknown[] | undefined;

  // ---- External content path: article was provided, agent extracts findings ----
  if (hasExternalContent && step === 0) {
    const content = pipeline.data.research_content as string;
    const perspectives: ResearchPerspective[] = pipeline.command === 'audit'
      ? ['security', 'compliance']
      : ['security', 'reliability', 'devex', 'performance'];

    pipeline.data.perspectives_total = perspectives.length;
    pipeline.data.perspectives_done = 0;
    pipeline.data.ingest_perspectives = perspectives as unknown as Record<string, unknown>;
    pipeline.status = 'waiting_agent';
    store().update(pipeline.pipeline_id, pipeline);

    const modelNote = routing_note(pipeline);
    const preview = content.length > 2000 ? content.slice(0, 2000) + '\n...(truncated for bootstrap prompt)...' : content;

    return stepResult(pipeline, overlay_label('research'),
      `${agentNames} analyzing external research article across ${perspectives.length} perspectives.`, 'waiting_agent', {
      control: 'agent',
      description: `Read the research article below. Extract structured findings for the "${perspectives[0]}" perspective. Then call pipeline_next with your findings.`,
      bootstrap_prompt: `${modelNote}${agentNames}: Analyze this research article for the "${perspectives[0]}" perspective.\n\nExtract findings as structured JSON. Each finding needs:\n- claim: what the article says\n- recommendation: what to do about it\n- expected_impact: { reliability, security, devex, performance } each -1 to 1\n- risk: { level: "low"|"medium"|"high"|"critical", notes }\n- evidence: [{ type: "quote"|"url"|"spec_reference", value, quality: "A"|"B"|"C" }]\n\n--- RESEARCH ARTICLE ---\n${preview}\n--- END ---\n\nCall pipeline_next with:\n- pipeline_id="${pipeline.pipeline_id}"\n- findings=[...your extracted findings as JSON matching: ${FINDINGS_JSON_SHAPE} ]`,
    });
  }

  if (hasExternalContent && step > 0 && agentFindings) {
    const perspectives = (pipeline.data.ingest_perspectives ?? []) as unknown as ResearchPerspective[];
    const idx = (pipeline.data.perspectives_done as number) ?? 0;
    const current = perspectives[idx];

    if (current) {
      const sanitized = sanitizeFindings(agentFindings);
      const hash = `external-${current}-${pipeline.pipeline_id}`;
      storeFindings(serverId, current, hash, sanitized);
      pipeline.data.perspectives_done = idx + 1;
    }

    // Clear processed findings so stale data doesn't re-trigger on next advance
    delete pipeline.data.findings;

    const done = (pipeline.data.perspectives_done as number) ?? 0;
    const total = (pipeline.data.perspectives_total as number) ?? 1;

    if (done < total) {
      const nextPersp = perspectives[done];
      pipeline.status = 'waiting_agent';
      store().update(pipeline.pipeline_id, pipeline);

      return stepResult(pipeline, overlay_label('research'),
        `${agentNames}: ${done}/${total} perspectives extracted. Next: "${nextPersp}"`, 'waiting_agent', {
        control: 'agent',
        description: `Now extract findings for the "${nextPersp}" perspective from the same article.`,
        bootstrap_prompt: `${agentNames}: Continue analyzing the research article — now for the "${nextPersp}" perspective (${done + 1} of ${total}).\n\nRefer to the article you already read. Extract findings relevant to ${nextPersp}.\n\nCall pipeline_next with:\n- pipeline_id="${pipeline.pipeline_id}"\n- findings=[...structured findings for ${nextPersp}...]`,
      });
    }

    // All perspectives extracted — compute consensus
    const feeds = getResearchFeeds(serverId);
    const consensus = computeConsensus(feeds, serverId);
    insertConsensusResult(consensus);
    pipeline.data.consensus_id = consensus.consensus_id;
    pipeline.data.findings_count = consensus.findings.length;
    pipeline.data.agreement = consensus.overall_agreement;

    // Bridge: persist findings in a durable ResearchOps case
    bridgeToResearchOps(pipeline);

    return advanceToNextOverlay(pipeline);
  }

  // ---- Standard path: generate research prompts for agent to analyze ----
  if (!hasExternalContent && step === 0) {
    const perspectives: ResearchPerspective[] = pipeline.command === 'audit'
      ? ['security', 'compliance']
      : ['security', 'reliability', 'compliance', 'devex', 'performance'];

    // Inject feedback from past pipelines into the research context
    const pastFeedback = getFeedback(serverId, 10);
    const feedbackSection = buildFeedbackPromptSection(pastFeedback);
    const enrichedContext = feedbackSection
      ? `${(pipeline.data.context as string) ?? ''}\n\n${feedbackSection}`
      : (pipeline.data.context as string) ?? '';

    const result = startResearch({
      target_server_id: serverId,
      server_name: (pipeline.data.server_name as string) ?? serverId,
      server_description: '',
      current_tools: (pipeline.data.current_tools as string[]) ?? [],
      current_resources: (pipeline.data.current_resources as string[]) ?? [],
      transport: 'stdio',
      auth_mode: 'none',
      focus_areas: perspectives,
      additional_context: enrichedContext,
    }, perspectives);

    pipeline.data.research_prompts = result.prompts as unknown as Record<string, unknown>;
    pipeline.data.perspectives_total = perspectives.length;
    pipeline.data.perspectives_done = 0;
    pipeline.status = 'waiting_agent';
    store().update(pipeline.pipeline_id, pipeline);

    const first = result.prompts[0];
    const modelNote = routing_note(pipeline);

    return stepResult(pipeline, overlay_label('research'), `${agentNames} analyzing "${first.perspective}" perspective`, 'waiting_agent', {
      control: 'agent',
      description: `Analyze the "${first.perspective}" research prompt, then call pipeline_next with your findings.`,
      bootstrap_prompt: `${modelNote}${agentNames} need you to analyze this server.\n\n${first.prompt}\n\nAfter your analysis, use pipeline_next with:\n- pipeline_id="${pipeline.pipeline_id}"\n- findings=[...your findings as JSON matching: ${FINDINGS_JSON_SHAPE} ]`,
    });
  }

  if (!hasExternalContent && step > 0 && agentFindings) {
    const prompts = pipeline.data.research_prompts as Array<{ perspective: string; prompt_hash: string }>;
    const idx = (pipeline.data.perspectives_done as number) ?? 0;
    const current = prompts[idx];

    if (current) {
      const sanitized = sanitizeFindings(agentFindings);
      storeFindings(serverId, current.perspective as ResearchPerspective, current.prompt_hash, sanitized);
      pipeline.data.perspectives_done = idx + 1;
    }

    // Clear processed findings so stale data doesn't re-trigger on next advance
    delete pipeline.data.findings;

    const done = (pipeline.data.perspectives_done as number) ?? 0;
    const total = (pipeline.data.perspectives_total as number) ?? 1;

    if (done < total) {
      const next = prompts[done];
      pipeline.status = 'waiting_agent';
      store().update(pipeline.pipeline_id, pipeline);

      return stepResult(pipeline, overlay_label('research'), `${agentNames}: ${done}/${total} perspectives complete. Next: "${next.perspective}"`, 'waiting_agent', {
        control: 'agent',
        description: `Analyze the "${next.perspective}" perspective.`,
        bootstrap_prompt: `${agentNames} continuing research — perspective ${done + 1} of ${total}.\n\nUse research_start with target_server_id="${serverId}" perspectives=["${next.perspective}"] to get the prompt, analyze it, then call pipeline_next with findings.`,
      });
    }

    const feeds = getResearchFeeds(serverId);
    const consensus = computeConsensus(feeds, serverId);
    insertConsensusResult(consensus);
    pipeline.data.consensus_id = consensus.consensus_id;
    pipeline.data.findings_count = consensus.findings.length;
    pipeline.data.agreement = consensus.overall_agreement;

    // Bridge: persist findings in a durable ResearchOps case
    bridgeToResearchOps(pipeline);

    return advanceToNextOverlay(pipeline);
  }

  // Diagnostic fallback — explain WHY the pipeline is stuck
  const diagParts: string[] = [];
  if (!hasExternalContent) diagParts.push('no research_content in pipeline data');
  if (step === 0) diagParts.push('still at initial step (step_within_overlay=0)');
  if (!agentFindings) diagParts.push('no findings submitted — pass findings array via pipeline_next');
  if (step > 0 && !agentFindings) diagParts.push('findings may have been lost during pipeline state round-trip');
  const diagnosis = diagParts.length > 0 ? ` Diagnosis: ${diagParts.join('; ')}.` : '';

  const reqPersp = hasExternalContent
    ? ((pipeline.data.ingest_perspectives ?? []) as unknown as string[])
    : ['security', 'reliability', 'compliance', 'devex', 'performance'];
  const done = (pipeline.data.perspectives_done as number) ?? 0;

  pipeline.status = 'waiting_agent';
  store().update(pipeline.pipeline_id, pipeline);
  return stepResult(pipeline, overlay_label('research'),
    `Waiting for research findings.${diagnosis}`, 'waiting_agent', {
    control: 'agent',
    description: diagParts.length > 0
      ? `Stuck: ${diagParts.join('; ')}. Use force_advance=true to skip, or submit findings.`
      : 'Submit findings via pipeline_next.',
    bootstrap_prompt: `Pipeline stalled at research overlay.${diagnosis}\n\nOptions:\n1. Submit findings: pipeline_next with pipeline_id="${pipeline.pipeline_id}" findings=[...]\n2. Force advance: pipeline_next with pipeline_id="${pipeline.pipeline_id}" force_advance=true\n3. Use individual tools: research_store, then research_consensus\n\nRequired perspectives: ${reqPersp.join(', ')} (${done}/${reqPersp.length} done)`,
  });
}

/**
 * Bridge: auto-create a ResearchOps case when the research overlay
 * concludes with substantial findings. This links the refinery pipeline
 * to durable research memory, so findings persist across sessions.
 *
 * Triggers when: external research content was provided, OR consensus has
 * 3+ findings, OR intent explicitly requests research depth.
 */
function bridgeToResearchOps(pipeline: PipelineState): void {
  const hasContent = Boolean(pipeline.data.research_content);
  const findingsCount = (pipeline.data.findings_count as number) ?? 0;
  const intentNeedsResearch = /research|deep.?dive|analyz/i.test(pipeline.intent);

  if (!hasContent && findingsCount < 3 && !intentNeedsResearch) return;

  try {
    const rc = createResearchCase({
      initiative_name: `Pipeline ${pipeline.command}: ${pipeline.intent.slice(0, 60)}`,
      owner: 'orchestrator',
      problem_statement: pipeline.intent,
      goals: [`Improve ${pipeline.target_server_id}`, ...(pipeline.data.context ? [String(pipeline.data.context).slice(0, 200)] : [])],
      risk_lane: pipeline.classification?.risk_level === 'critical' ? 'high'
        : (pipeline.classification?.risk_level as 'low' | 'medium' | 'high') ?? 'medium',
      target_consumer: 'mcp_refinery',
    });
    pipeline.data.research_ops_case_id = rc.case_id;
  } catch {
    // Non-fatal: pipeline continues even if case creation fails
  }
}

function executeClassifyOverlay(pipeline: PipelineState): StepResult {
  const classification = pipeline.classification!;
  const isMulti = classification.requires_multi_model;

  pipeline.data.classification = classification as unknown as Record<string, unknown>;

  if (isMulti && pipeline.overlays.includes('deliberate')) {
    return advanceToNextOverlay(pipeline);
  }

  if (isMulti && !pipeline.overlays.includes('deliberate')) {
    pipeline.overlays.splice(pipeline.overlay_index + 1, 0, 'deliberate');
    return advanceToNextOverlay(pipeline);
  }

  return advanceToNextOverlay(pipeline);
}

function executeDeliberateOverlay(pipeline: PipelineState): StepResult {
  const agents = engagedNames(pipeline, ['architect', 'security_auditor']);

  pipeline.status = 'waiting_agent';
  store().update(pipeline.pipeline_id, pipeline);

  return stepResult(pipeline, overlay_label('deliberate'),
    `${agents} initiating multi-model deliberation.`, 'waiting_agent', {
    control: 'agent',
    description: 'Start multi-model deliberation on the research findings.',
    bootstrap_prompt: `${agents} recommend multi-model review for this ${pipeline.classification?.complexity ?? 'complex'} task.\n\nUse deliberation_start with:\n- problem_statement="Review improvement proposals for ${pipeline.target_server_id}: ${pipeline.intent}"\n- context="${(pipeline.data.context as string) ?? ''} | Consensus agreement: ${pipeline.data.agreement ?? 'pending'}"\n\nAfter deliberation completes, use pipeline_next with pipeline_id="${pipeline.pipeline_id}"`,
  });
}

function executeTriageOverlay(pipeline: PipelineState): StepResult {
  const consensus = getLatestConsensus(pipeline.target_server_id);
  if (!consensus) return advanceToNextOverlay(pipeline);

  const result = triageFindings(consensus);
  const actionable = result.proposals.filter((p) => !p.blocked_by_oscillation);

  pipeline.data.proposals = result.proposals as unknown as Record<string, unknown>;
  pipeline.data.actionable_count = actionable.length;
  pipeline.data.escalations = result.escalations;

  if (actionable.length === 0) {
    pipeline.status = 'completed';
    store().update(pipeline.pipeline_id, pipeline);
    return stepResult(pipeline, overlay_label('triage'), 'No actionable proposals. Pipeline complete.', 'completed', {
      control: 'user',
      description: 'All proposals blocked. Review escalations above.',
      bootstrap_prompt: `No actionable proposals from the research. Escalations:\n${result.escalations.join('\n')}\n\nReview and decide next steps.`,
    });
  }

  const topId = actionable[0].proposal_id;
  pipeline.status = 'waiting_user';
  store().update(pipeline.pipeline_id, pipeline);

  return stepResult(pipeline, overlay_label('triage'),
    `${actionable.length} actionable proposal(s). Top priority needs approval.`, 'waiting_user', {
    control: 'user',
    description: 'Review proposals and approve to continue.',
    bootstrap_prompt: `Governance Gate requires your approval.\n\n${actionable.slice(0, 3).map((p, i) => `${i + 1}. [${p.priority_score.toFixed(2)}] ${p.proposal_id} — ${p.reason}`).join('\n')}\n\nTo approve and continue:\nUse governance_approve with target_type="proposal" target_id="${topId}" approved_by="user" risk_acknowledged=true rollback_plan_acknowledged=true\n\nThen: pipeline_next with pipeline_id="${pipeline.pipeline_id}"`,
  });
}

function executePlanOverlay(pipeline: PipelineState): StepResult {
  const agents = engagedNames(pipeline, ['code_smith']);
  pipeline.status = 'waiting_agent';
  store().update(pipeline.pipeline_id, pipeline);

  const proposals = listProposals(pipeline.target_server_id, 'triaged');
  const ids = proposals.slice(0, 3).map((p) => p.proposal_id);

  return stepResult(pipeline, overlay_label('plan'), `${agents} creating delivery plan with MCP implementation requirements.`, 'waiting_agent', {
    control: 'agent',
    description: 'Create a delivery plan that includes MCP tool implementation standards as acceptance criteria.',
    bootstrap_prompt: `${agents} building delivery plan for ${pipeline.target_server_id}.\n\nUse delivery_plan with target_server_id="${pipeline.target_server_id}" proposal_ids=${JSON.stringify(ids)}\n\n**IMPORTANT**: The delivery plan MUST include these MCP implementation requirements as acceptance criteria for any proposal that creates or modifies tools:\n- All tool parameters have Zod schemas with .describe() annotations\n- All tool descriptions explain: what it does, when to use it, what it returns\n- All tool responses use structured output with next-step guidance (output() helper pattern)\n- All tool handlers have try/catch with structured error recovery\n- All responses use MCP content array format: { content: [{ type: "text", text: "..." }] }\n- Input validation via Zod runs before any business logic\n- No new runtime dependencies without approval\n\nThen: pipeline_next with pipeline_id="${pipeline.pipeline_id}"`,
  });
}

function executeExecuteOverlay(pipeline: PipelineState): StepResult {
  const agents = engagedNames(pipeline, ['code_smith', 'test_evaluator']);
  const implGuide = buildImplementationGuide();
  pipeline.status = 'waiting_agent';
  store().update(pipeline.pipeline_id, pipeline);

  return stepResult(pipeline, overlay_label('execute'), `${agents} preparing implementation with MCP quality standards.`, 'waiting_agent', {
    control: 'agent',
    description: 'Implement the planned changes following MCP tool implementation standards, then create the PR.',
    bootstrap_prompt: `${agents} executing delivery plan for ${pipeline.target_server_id}.\n\n${implGuide}\n\n**CRITICAL**: All new or modified tools MUST follow the implementation standards above. Any tool that does not meet these standards will be flagged in the cleanup phase.\n\nAfter implementing changes:\n1. Verify every tool has Zod schemas with .describe() on every parameter\n2. Verify every tool has a clear description (what, when, returns)\n3. Verify every tool response uses the output() helper with next-step guidance\n4. Verify every tool handler has try/catch with structured error responses\n5. Use delivery_create_pr with the plan details\n\nThen: pipeline_next with pipeline_id="${pipeline.pipeline_id}"`,
  });
}

// ---------------------------------------------------------------------------
// Documentation Overlay — update README, architecture, and config docs
// ---------------------------------------------------------------------------

function executeDocumentOverlay(pipeline: PipelineState): StepResult {
  const step = pipeline.step_within_overlay;
  const agents = engagedNames(pipeline, ['code_smith', 'researcher']);

  if (step === 0) {
    const docGuide = buildDocumentationGuide();

    pipeline.status = 'waiting_agent';
    store().update(pipeline.pipeline_id, pipeline);

    return stepResult(pipeline, overlay_label('document'),
      `${agents} updating documentation to match code changes.`, 'waiting_agent', {
      control: 'agent',
      description: 'Update all documentation to reflect changes made in this pipeline. README, architecture docs, configuration reference, and CHANGELOG must be current.',
      bootstrap_prompt: `${agents}: Documentation pass for ${pipeline.target_server_id}.\n\n${docGuide}\n\n**CRITICAL**: Documentation ships with code. No release proceeds with stale docs.\n\nAfter updating all documentation:\n1. Verify README tool inventory matches registered tools exactly\n2. Verify setup instructions work for a fresh install\n3. Verify architecture docs reflect current structure\n4. Verify CHANGELOG has an entry for this change\n5. Verify configuration reference covers all env vars and options\n\nThen: pipeline_next with pipeline_id="${pipeline.pipeline_id}"`,
    });
  }

  // Step 1+ — agent submitted documentation updates
  if (step > 0) {
    pipeline.data.documentation_completed = true;
    pipeline.data.documentation_step = step;

    recordAudit('pipeline.documentation', 'orchestrator', 'pipeline', pipeline.pipeline_id, {
      overlay: 'document', passed: true,
    });

    return advanceToNextOverlay(pipeline);
  }

  return advanceToNextOverlay(pipeline);
}

function executeReleaseOverlay(pipeline: PipelineState): StepResult {
  const agents = engagedNames(pipeline, ['release_manager', 'governance_gate']);
  pipeline.status = 'waiting_user';
  store().update(pipeline.pipeline_id, pipeline);

  return stepResult(pipeline, overlay_label('release'), `${agents}: Release ready for approval.`, 'waiting_user', {
    control: 'user',
    description: 'Approve and publish the release.',
    bootstrap_prompt: `${agents}: All changes implemented and tested.\n\nUse delivery_release with target_server_id="${pipeline.target_server_id}" to create the release.\n\nAfter publishing: pipeline_next with pipeline_id="${pipeline.pipeline_id}"`,
  });
}

// ---------------------------------------------------------------------------
// Alignment Overlay — always asks user before tool changes proceed
// ---------------------------------------------------------------------------

function executeAlignOverlay(pipeline: PipelineState): StepResult {
  const step = pipeline.step_within_overlay;
  const proposals = pipeline.data.proposals as unknown as Array<Record<string, unknown>> ?? [];
  const actionable = proposals.filter((p) => !(p.blocked_by_oscillation as boolean));
  const consensus = getLatestConsensus(pipeline.target_server_id);
  const baselineMatches = consensus
    ? matchFindingsToBaselines(consensus.findings.map((f) => ({ claim: f.claim, recommendation: f.recommendation })))
    : [];

  if (step === 0) {
    const summary: string[] = [];
    summary.push(`## Alignment Check — ${pipeline.target_server_id}`);
    summary.push('');
    summary.push(`**Intent**: ${pipeline.intent}`);
    summary.push(`**Command**: ${pipeline.command} | **Overlays remaining**: ${pipeline.overlays.slice(pipeline.overlay_index + 1).join(' → ')}`);
    summary.push('');

    if (actionable.length > 0) {
      summary.push(`### Proposed Changes (${actionable.length})`);
      for (const p of actionable.slice(0, 5)) {
        summary.push(`- **${p.proposal_id}**: ${p.reason ?? 'No description'} [priority: ${typeof p.priority_score === 'number' ? (p.priority_score as number).toFixed(2) : '?'}]`);
      }
      summary.push('');
    }

    if (baselineMatches.length > 0) {
      summary.push(`### Baseline Pattern Matches`);
      summary.push(`${baselineMatches.length} finding(s) match known quality patterns from the refinery baseline.`);
      for (const m of baselineMatches.slice(0, 5)) {
        summary.push(`- Finding #${m.finding_index + 1} → ${m.pattern_names.join(', ')}`);
      }
      summary.push('');
    }

    summary.push('### What happens next');
    summary.push('If you approve, the pipeline proceeds to: ' + pipeline.overlays.slice(pipeline.overlay_index + 1).join(' → '));
    summary.push('');
    summary.push('**Do you want to proceed with these changes?** Reply with approval to continue, or provide feedback to redirect.');

    pipeline.status = 'waiting_user';
    pipeline.data.alignment_summary = summary.join('\n');
    store().update(pipeline.pipeline_id, pipeline);

    recordAudit('governance.approval', 'orchestrator', 'pipeline', pipeline.pipeline_id, {
      overlay: 'align', step: 'request', proposals_count: actionable.length,
    });

    return stepResult(pipeline, overlay_label('align'),
      'Alignment gate — waiting for user confirmation before proceeding.', 'waiting_user', {
      control: 'user',
      description: 'Review the proposed direction and approve to continue.',
      bootstrap_prompt: `${summary.join('\n')}\n\nTo approve and continue:\nUse governance_approve with target_type="proposal" target_id="${pipeline.pipeline_id}" approved_by="user" risk_acknowledged=true rollback_plan_acknowledged=true\n\nThen: pipeline_next with pipeline_id="${pipeline.pipeline_id}"`,
    });
  }

  // Step 1+ — user has approved, proceed
  return advanceToNextOverlay(pipeline);
}

// ---------------------------------------------------------------------------
// Cleanup Overlay — post-change verification pass
// ---------------------------------------------------------------------------

function executeCleanupOverlay(pipeline: PipelineState): StepResult {
  const step = pipeline.step_within_overlay;
  const agents = engagedNames(pipeline, ['researcher', 'test_evaluator']);

  if (step === 0) {
    const checklist = buildCleanupChecklist();

    pipeline.status = 'waiting_agent';
    store().update(pipeline.pipeline_id, pipeline);

    return stepResult(pipeline, overlay_label('cleanup'),
      `${agents} running post-change cleanup verification.`, 'waiting_agent', {
      control: 'agent',
      description: 'Run the cleanup checklist against all changes made in this pipeline. Report any issues as findings.',
      bootstrap_prompt: `${agents}: Post-change cleanup pass for ${pipeline.target_server_id}.\n\n${checklist}\n\nReview all changes made during this pipeline and check for:\n- Stale imports from removed/renamed functions\n- Dead exports no longer used by any consumer\n- Types defined but never referenced\n- Comments referencing deleted code\n- Misaligned function signatures between modules\n\nReport issues using pipeline_next with pipeline_id="${pipeline.pipeline_id}" and findings=[...cleanup findings...]`,
    });
  }

  // Step 1+ — agent submitted cleanup findings
  if (step > 0) {
    pipeline.data.cleanup_completed = true;
    pipeline.data.cleanup_step = step;

    recordAudit('pipeline.cleanup', 'orchestrator', 'pipeline', pipeline.pipeline_id, {
      overlay: 'cleanup', passed: true,
    });

    return advanceToNextOverlay(pipeline);
  }

  return advanceToNextOverlay(pipeline);
}

// ---------------------------------------------------------------------------
// Propagation Overlay — check if improvements apply to other servers
// ---------------------------------------------------------------------------

function executePropagateOverlay(pipeline: PipelineState): StepResult {
  const servers = listTargetServers();
  const otherServers = servers.filter((s) => s.server_id !== pipeline.target_server_id && s.server_id !== 'self');

  if (otherServers.length === 0) {
    pipeline.data.propagation = 'skipped — no other servers registered';
    return advanceToNextOverlay(pipeline);
  }

  const consensus = getLatestConsensus(pipeline.target_server_id);
  if (!consensus || consensus.findings.length === 0) {
    pipeline.data.propagation = 'skipped — no findings to propagate';
    return advanceToNextOverlay(pipeline);
  }

  // Identify universal findings (high agreement, not server-specific)
  const universal = consensus.findings.filter((f) =>
    f.agreement_score >= 0.6 &&
    f.supporting_perspectives.length >= 2 &&
    f.risk_level !== 'low',
  );

  if (universal.length === 0) {
    pipeline.data.propagation = 'skipped — no universal findings to propagate';
    return advanceToNextOverlay(pipeline);
  }

  const baselineMatches = matchFindingsToBaselines(
    universal.map((f) => ({ claim: f.claim, recommendation: f.recommendation })),
  );

  const propagationSummary: string[] = [];
  propagationSummary.push(`## Cross-Server Improvement Propagation`);
  propagationSummary.push('');
  propagationSummary.push(`${universal.length} universal finding(s) from **${pipeline.target_server_id}** may apply to ${otherServers.length} other server(s):`);
  propagationSummary.push('');

  for (const f of universal.slice(0, 5)) {
    const matched = baselineMatches.find((m) => consensus.findings.indexOf(f) === m.finding_index);
    propagationSummary.push(`- **${f.claim}** [${f.risk_level}] — ${f.recommendation}`);
    if (matched) propagationSummary.push(`  Matches baseline: ${matched.pattern_names.join(', ')}`);
  }

  propagationSummary.push('');
  propagationSummary.push('**Other servers**: ' + otherServers.map((s) => s.name).join(', '));
  propagationSummary.push('');
  propagationSummary.push('Consider running these improvements against the other servers. Use `refine` for each one.');

  pipeline.data.propagation = {
    universal_findings: universal.length,
    other_servers: otherServers.map((s) => s.server_id),
    baseline_matches: baselineMatches.length,
  };
  pipeline.status = 'waiting_user';
  store().update(pipeline.pipeline_id, pipeline);

  return stepResult(pipeline, overlay_label('propagate'),
    `${universal.length} improvements may apply to ${otherServers.length} other server(s).`, 'waiting_user', {
    control: 'user',
    description: 'Review universal improvements for propagation to other servers.',
    bootstrap_prompt: `${propagationSummary.join('\n')}\n\nTo propagate to a specific server:\nUse refine with target_server_id="<server_id>" intent="apply universal improvements from ${pipeline.target_server_id}" context="${universal.slice(0, 3).map(f => f.claim).join('; ')}"\n\nOr: pipeline_next with pipeline_id="${pipeline.pipeline_id}" to skip propagation and complete.`,
  });
}

function completedResult(pipeline: PipelineState): StepResult {
  // Record feedback for the continuous improvement loop
  collectPipelineFeedback(pipeline);

  return stepResult(pipeline, 'Pipeline Complete', `All ${pipeline.overlays.length} overlays finished.`, 'completed', {
    control: 'user',
    description: 'Pipeline complete. Feedback recorded for continuous improvement. Start a new cycle when ready.',
    bootstrap_prompt: `Pipeline ${pipeline.pipeline_id} complete.\nCommand: ${pipeline.command} | Overlays: ${pipeline.overlays.join(' → ')}\n\nFeedback has been recorded for the continuous improvement loop. Future pipelines will consult this feedback during research.\n\nTo start a new cycle: use refine again.`,
  });
}

/**
 * Collect feedback from a completed pipeline and store it for the
 * continuous improvement loop. Analyzes pipeline data to extract
 * strengths, weaknesses, and lessons learned.
 */
function collectPipelineFeedback(pipeline: PipelineState): void {
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const lessons: string[] = [];

  // Analyze research phase
  const perspDone = (pipeline.data.perspectives_done as number) ?? 0;
  const perspTotal = (pipeline.data.perspectives_total as number) ?? 0;
  if (perspDone === perspTotal && perspTotal > 0) {
    strengths.push(`Research completed across all ${perspTotal} perspectives`);
  } else if (perspTotal > 0 && perspDone < perspTotal) {
    weaknesses.push(`Research incomplete: ${perspDone}/${perspTotal} perspectives analyzed`);
    lessons.push('Consider using force_advance sparingly — skipped perspectives leave gaps');
  }

  // Analyze consensus
  const agreement = pipeline.data.agreement as number | undefined;
  if (agreement !== undefined) {
    if (agreement >= 0.7) {
      strengths.push(`High cross-perspective agreement (${(agreement * 100).toFixed(0)}%)`);
    } else if (agreement < 0.4) {
      weaknesses.push(`Low cross-perspective agreement (${(agreement * 100).toFixed(0)}%) — findings may be noisy`);
      lessons.push('Low agreement suggests research prompts need more focus or context');
    }
  }

  // Analyze proposals
  const proposalCount = (pipeline.data.actionable_count as number) ?? 0;
  if (proposalCount > 0) {
    strengths.push(`${proposalCount} actionable proposal(s) generated from research`);
  } else {
    weaknesses.push('No actionable proposals — research may have been too generic');
  }

  // Analyze cleanup
  if (pipeline.data.cleanup_completed) {
    strengths.push('Cleanup verification pass completed');
  }

  // Analyze documentation
  if (pipeline.data.documentation_completed) {
    strengths.push('Documentation updated alongside code changes');
  }

  // Analyze if research ops case was created
  if (pipeline.data.research_ops_case_id) {
    strengths.push('Research findings persisted to durable ResearchOps case');
  }

  // Analyze sync from individual tools
  if (pipeline.data.synced_from_individual_tools) {
    lessons.push('Pipeline auto-synced with individual tool calls — the hybrid workflow works');
  }

  // Always record feedback, even if minimal
  if (strengths.length === 0) {
    strengths.push('Pipeline completed successfully');
  }

  const entry: FeedbackEntry = {
    feedback_id: `fb-${pipeline.pipeline_id.slice(0, 8)}`,
    pipeline_id: pipeline.pipeline_id,
    target_server_id: pipeline.target_server_id,
    command: pipeline.command,
    strengths,
    weaknesses,
    lessons_learned: lessons,
    overlays_completed: pipeline.overlays.slice(0, pipeline.overlay_index + 1),
    duration_estimate_hours: 0,
    proposals_acted_on: proposalCount,
    created_at: new Date().toISOString(),
  };

  try {
    insertFeedback(entry);
    recordAudit('pipeline.feedback', 'orchestrator', 'pipeline', pipeline.pipeline_id, {
      feedback_id: entry.feedback_id,
      strengths_count: strengths.length,
      weaknesses_count: weaknesses.length,
      lessons_count: lessons.length,
    });
  } catch {
    // Non-fatal: pipeline completion should not fail due to feedback storage
  }
}

// ---------------------------------------------------------------------------
// Pipeline Requirements — structured guidance for pipeline_status
// ---------------------------------------------------------------------------

export function getOverlayRequirements(pipeline: PipelineState): Record<string, unknown> {
  const overlay = pipeline.overlays[pipeline.overlay_index];
  if (!overlay) return { status: 'completed' };

  const base = {
    current_overlay: overlay,
    can_force_advance: true,
    force_advance_hint: `Use pipeline_next with pipeline_id="${pipeline.pipeline_id}" and force_advance=true to skip this overlay.`,
  };

  switch (overlay) {
    case 'research': {
      const total = (pipeline.data.perspectives_total as number) ?? 0;
      const done = (pipeline.data.perspectives_done as number) ?? 0;
      const perspectives = (pipeline.data.ingest_perspectives as unknown as string[])
        ?? (pipeline.data.research_prompts as Array<{ perspective: string }> ?? []).map((p) => p.perspective)
        ?? [];
      const hasContent = Boolean(pipeline.data.research_content);
      return {
        ...base,
        waiting_for: 'research_findings',
        has_external_content: hasContent,
        perspectives_required: perspectives.length > 0 ? perspectives : ['security', 'reliability', 'compliance', 'devex', 'performance'],
        perspectives_completed: done,
        perspectives_total: total || perspectives.length || 5,
        next_perspective: perspectives[done] ?? null,
        data_format: 'findings array with { claim, recommendation, expected_impact, risk, evidence }',
        instructions: done < (total || 5)
          ? `Submit findings for "${perspectives[done] ?? 'next'}" perspective via pipeline_next, or use force_advance=true to skip.`
          : 'All perspectives done. Call pipeline_next to compute consensus and advance.',
        alternative: 'Use research_store + research_consensus individually, then pipeline_next will auto-detect completion.',
      };
    }
    case 'align':
      return {
        ...base,
        waiting_for: 'user_approval',
        instructions: 'Review proposed changes above and approve via governance_approve, then call pipeline_next.',
        alignment_summary: pipeline.data.alignment_summary ?? null,
      };
    case 'triage':
      return {
        ...base,
        waiting_for: 'triage_completion',
        instructions: 'Triage runs automatically. If stuck, call pipeline_next or use improvements_triage individually.',
      };
    case 'plan':
    case 'execute':
    case 'cleanup':
    case 'document':
      return {
        ...base,
        waiting_for: 'agent_action',
        instructions: `Agent should complete the "${overlay}" step, then call pipeline_next.`,
      };
    case 'release':
      return {
        ...base,
        waiting_for: 'release_approval',
        instructions: 'Use delivery_release to create the release, then call pipeline_next.',
      };
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stepResult(
  pipeline: PipelineState, step: string, message: string,
  status: PipelineState['status'],
  next: StepResult['next'],
): StepResult {
  const overlay = pipeline.overlays[pipeline.overlay_index] ?? 'done';
  return {
    pipeline_id: pipeline.pipeline_id,
    overlay,
    step,
    agents_active: pipeline.agents_engaged.map((id) => getAgent(id)?.name ?? id),
    model_instruction: routing_note(pipeline),
    status,
    data: {
      command: pipeline.command,
      overlays: pipeline.overlays,
      overlay_index: pipeline.overlay_index,
      total_overlays: pipeline.overlays.length,
      progress: `${pipeline.overlay_index + 1}/${pipeline.overlays.length}`,
    },
    message,
    next,
  };
}

function overlay_label(name: OverlayName): string {
  return OVERLAY_DESCRIPTIONS[name] ?? name;
}

function engagedNames(pipeline: PipelineState, preferred: string[]): string {
  const ids = preferred.filter((id) => pipeline.agents_engaged.includes(id));
  if (ids.length === 0) return pipeline.agents_engaged.map((id) => getAgent(id)?.name ?? id).join(' + ');
  return ids.map((id) => getAgent(id)?.name ?? id).join(' + ');
}

function routing_note(pipeline: PipelineState): string {
  if (!pipeline.routing || !pipeline.routing.assignments.length) return '';
  const primary = pipeline.routing.assignments[0];
  return `[Model: ${primary.model.display_name} | ${primary.model.tier} tier]\n`;
}
