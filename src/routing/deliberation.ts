/**
 * Multi-Model Deliberation Engine — "iron sharpens iron"
 *
 * Runs the same problem through multiple architect-tier models.
 * Computes agreement, identifies conflicts, and either:
 *   - Proceeds on consensus
 *   - Escalates fundamental conflicts to the user as decision-maker
 *
 * Works in 3 modes:
 *   1. Full API — both models have API keys, calls them in parallel
 *   2. Mixed — one API, one prompt (agent/user processes the other)
 *   3. Full prompt — generates prompts for each model, user runs them
 */

import { randomUUID } from 'node:crypto';
import { callModel, canCallDirectly, type LLMResponse } from './providers.js';
import { getModel, getArchitectPair } from './models.js';
import { routeTask, type RoutingDecision } from './router.js';
import { recordAudit, indexVector } from '../storage/index.js';
import { JsonStore } from '../storage/json-store.js';
import { getConfig } from '../config.js';
import type {
  DeliberationSession, DeliberationResponse, AgreementAnalysis,
  ConflictPoint, ProviderName,
} from '../types/index.js';

type Rec = Record<string, unknown>;

let _store: JsonStore<DeliberationSession & Rec> | null = null;
function store(): JsonStore<DeliberationSession & Rec> {
  if (!_store) _store = new JsonStore(getConfig().storage.base_path, 'deliberations', 'session_id');
  return _store;
}

export interface StartDeliberationInput {
  problem_statement: string;
  context: string;
  model_ids?: string[];
  system_prompt?: string;
  force_prompt_mode?: boolean;
}

export interface DeliberationResult {
  session: DeliberationSession;
  routing: RoutingDecision;
  api_responses: LLMResponse[];
  pending_prompts: Array<{ model_id: string; display_name: string; provider: ProviderName; prompt: string }>;
}

/**
 * Start a multi-model deliberation session.
 *
 * Calls models with API keys in parallel. Returns prompts for models without keys.
 */
export async function startDeliberation(input: StartDeliberationInput): Promise<DeliberationResult> {
  const routing = routeTask({
    description: input.problem_statement,
    user_requested_multi: true,
    is_architectural: true,
  });

  const modelIds = input.model_ids ?? routing.classification.recommended_models;
  if (modelIds.length < 2) {
    const pair = getArchitectPair();
    if (pair) {
      modelIds.length = 0;
      modelIds.push(pair[0].model_id, pair[1].model_id);
    }
  }

  const now = new Date().toISOString();
  const session: DeliberationSession = {
    session_id: randomUUID(),
    task_id: routing.classification.task_id,
    problem_statement: input.problem_statement,
    context: input.context,
    models_assigned: modelIds,
    responses: [],
    agreement_analysis: null,
    resolution: 'pending',
    final_recommendation: null,
    created_at: now,
    updated_at: now,
  };

  const systemPrompt = input.system_prompt ?? buildDeliberationSystemPrompt();
  const fullPrompt = buildDeliberationPrompt(input.problem_statement, input.context);

  const apiResponses: LLMResponse[] = [];
  const pendingPrompts: DeliberationResult['pending_prompts'] = [];

  const calls = modelIds.map(async (id) => {
    const profile = getModel(id);
    if (!profile) return;

    if (!input.force_prompt_mode && canCallDirectly(profile.provider)) {
      try {
        const resp = await callModel({
          provider: profile.provider,
          model_id: profile.api_model_id,
          prompt: fullPrompt,
          system_prompt: systemPrompt,
          max_tokens: 8192,
          temperature: 0.3,
        });
        apiResponses.push(resp);

        const parsed = parseStructuredResponse(resp.text);
        session.responses.push({
          model_id: id,
          provider: profile.provider,
          response_text: resp.text,
          structured_output: parsed,
          confidence: (parsed?.confidence as number) ?? 0.7,
          key_points: (parsed?.key_points as string[]) ?? [],
          risks_identified: (parsed?.risks as string[]) ?? [],
          timestamp: new Date().toISOString(),
          latency_ms: resp.latency_ms,
          tokens_used: resp.tokens,
        });
      } catch (e) {
        pendingPrompts.push({
          model_id: id,
          display_name: profile.display_name,
          provider: profile.provider,
          prompt: `[${profile.display_name} — API call failed: ${e}]\n\n${fullPrompt}`,
        });
      }
    } else {
      pendingPrompts.push({
        model_id: id,
        display_name: profile.display_name,
        provider: profile.provider,
        prompt: fullPrompt,
      });
    }
  });

  await Promise.allSettled(calls);

  if (session.responses.length === modelIds.length) {
    session.agreement_analysis = analyzeAgreement(session.responses);
    session.resolution = session.agreement_analysis.conflicting_points.some((c) => c.requires_user_decision)
      ? 'pending' : 'consensus';
  }

  store().insert(session as DeliberationSession & Rec);

  recordAudit('deliberation.start', 'deliberation_engine', 'deliberation', session.session_id, {
    models: modelIds,
    api_count: apiResponses.length,
    prompt_count: pendingPrompts.length,
  });

  return { session, routing, api_responses: apiResponses, pending_prompts: pendingPrompts };
}

/**
 * Submit a response for a model in prompt mode.
 */
export function submitDeliberationResponse(
  sessionId: string, modelId: string, responseText: string,
  confidence?: number, keyPoints?: string[], risks?: string[],
): DeliberationSession | null {
  const session = store().get(sessionId) as DeliberationSession | null;
  if (!session) return null;

  const profile = getModel(modelId);
  const parsed = parseStructuredResponse(responseText);

  session.responses.push({
    model_id: modelId,
    provider: profile?.provider ?? 'anthropic',
    response_text: responseText,
    structured_output: parsed,
    confidence: confidence ?? (parsed?.confidence as number) ?? 0.7,
    key_points: keyPoints ?? (parsed?.key_points as string[]) ?? [],
    risks_identified: risks ?? (parsed?.risks as string[]) ?? [],
    timestamp: new Date().toISOString(),
    latency_ms: 0,
    tokens_used: { input: 0, output: 0 },
  });

  if (session.responses.length >= session.models_assigned.length) {
    session.agreement_analysis = analyzeAgreement(session.responses);
    const hasUserConflicts = session.agreement_analysis.conflicting_points.some((c) => c.requires_user_decision);
    session.resolution = hasUserConflicts ? 'pending' : 'consensus';
  }

  session.updated_at = new Date().toISOString();
  store().update(sessionId, session as DeliberationSession & Rec);

  indexVector(
    `deliberation:${sessionId}:${modelId}`,
    'deliberations',
    responseText.slice(0, 2000),
    undefined,
    { session_id: sessionId, model_id: modelId },
  );

  return session;
}

/**
 * Record the user's decision on conflicting points.
 */
export function resolveDeliberation(
  sessionId: string, resolution: string, chosenPosition?: string,
): DeliberationSession | null {
  const session = store().get(sessionId) as DeliberationSession | null;
  if (!session) return null;

  session.resolution = 'user_decision';
  session.final_recommendation = resolution;
  session.updated_at = new Date().toISOString();
  store().update(sessionId, session as DeliberationSession & Rec);

  recordAudit('deliberation.resolve', 'user', 'deliberation', sessionId, {
    resolution, chosen_position: chosenPosition,
  });

  return session;
}

export function getDeliberation(sessionId: string): DeliberationSession | null {
  return store().get(sessionId) as DeliberationSession | null;
}

// ---------------------------------------------------------------------------
// Agreement Analysis
// ---------------------------------------------------------------------------

export function analyzeAgreement(responses: DeliberationResponse[]): AgreementAnalysis {
  if (responses.length < 2) {
    return {
      overall_agreement: 1, agreed_points: responses[0]?.key_points ?? [],
      conflicting_points: [], unique_insights: [], synthesis: responses[0]?.response_text ?? '',
    };
  }

  const allPoints = responses.flatMap((r) => r.key_points.map((p) => ({ model: r.model_id, point: p })));
  const allRisks = responses.flatMap((r) => r.risks_identified.map((p) => ({ model: r.model_id, risk: p })));

  const agreedPoints: string[] = [];
  const conflicts: ConflictPoint[] = [];
  const uniqueInsights: Array<{ model_id: string; insight: string }> = [];

  const pointClusters = clusterByJaccard(allPoints.map((p) => p.point), 0.4);

  for (const cluster of pointClusters) {
    const sources = cluster.map((idx) => allPoints[idx].model);
    const uniqueSources = [...new Set(sources)];

    if (uniqueSources.length >= 2) {
      agreedPoints.push(allPoints[cluster[0]].point);
    } else if (uniqueSources.length === 1) {
      uniqueInsights.push({ model_id: uniqueSources[0], insight: allPoints[cluster[0]].point });
    }
  }

  const riskClusters = clusterByJaccard(allRisks.map((r) => r.risk), 0.3);
  for (const cluster of riskClusters) {
    const sources = cluster.map((idx) => allRisks[idx].model);
    const uniqueSources = [...new Set(sources)];

    if (uniqueSources.length === 1 && responses.length > 1) {
      const otherModel = responses.find((r) => r.model_id !== uniqueSources[0]);
      if (otherModel) {
        conflicts.push({
          topic: allRisks[cluster[0]].risk,
          positions: [
            { model_id: uniqueSources[0], position: 'Identified as risk', reasoning: allRisks[cluster[0]].risk },
            { model_id: otherModel.model_id, position: 'Not flagged as risk', reasoning: 'This risk was not identified' },
          ],
          severity: 'minor',
          requires_user_decision: false,
        });
      }
    }
  }

  if (responses.length >= 2) {
    const confA = responses[0].confidence;
    const confB = responses[1].confidence;
    if (Math.abs(confA - confB) > 0.3) {
      conflicts.push({
        topic: 'Confidence divergence',
        positions: responses.map((r) => ({
          model_id: r.model_id,
          position: `Confidence: ${(r.confidence * 100).toFixed(0)}%`,
          reasoning: `${r.key_points.length} key points, ${r.risks_identified.length} risks`,
        })),
        severity: 'significant',
        requires_user_decision: true,
      });
    }

    const textSimA = responses[0].response_text.toLowerCase();
    const textSimB = responses[1].response_text.toLowerCase();
    const jSim = jaccardNgram(textSimA, textSimB, 4);
    if (jSim < 0.15) {
      conflicts.push({
        topic: 'Fundamental approach disagreement',
        positions: responses.map((r) => ({
          model_id: r.model_id,
          position: r.key_points.slice(0, 3).join('; ') || 'See full response',
          reasoning: r.response_text.slice(0, 500),
        })),
        severity: 'fundamental',
        requires_user_decision: true,
      });
    }
  }

  const totalPossible = allPoints.length;
  const overall_agreement = totalPossible > 0
    ? (agreedPoints.length * 2) / totalPossible
    : 0;

  const synthesis = buildSynthesis(agreedPoints, conflicts, uniqueInsights, responses);

  return { overall_agreement: Math.min(1, overall_agreement), agreed_points: agreedPoints, conflicting_points: conflicts, unique_insights: uniqueInsights, synthesis };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildDeliberationSystemPrompt(): string {
  return `You are a senior software architect conducting a critical review.
Provide your analysis as structured JSON with these fields:
{
  "confidence": 0.0-1.0,
  "key_points": ["point 1", "point 2", ...],
  "risks": ["risk 1", "risk 2", ...],
  "recommendation": "your recommendation",
  "reasoning": "detailed reasoning"
}
Be thorough, specific, and opinionated. Flag real risks.`;
}

function buildDeliberationPrompt(problem: string, context: string): string {
  return `## Critical Review Request

### Problem Statement
${problem}

### Context
${context}

Analyze this thoroughly. Consider: architecture implications, security risks, performance impact, maintenance burden, and alternative approaches.

Return your analysis as structured JSON matching the system prompt format.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseStructuredResponse(text: string): Record<string, unknown> | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try { return JSON.parse(jsonMatch[0]); }
  catch { return null; }
}

function clusterByJaccard(texts: string[], threshold: number): number[][] {
  const clusters: number[][] = [];
  const used = new Set<number>();
  for (let i = 0; i < texts.length; i++) {
    if (used.has(i)) continue;
    const cluster = [i]; used.add(i);
    for (let j = i + 1; j < texts.length; j++) {
      if (used.has(j)) continue;
      if (jaccardNgram(texts[i], texts[j]) >= threshold) { cluster.push(j); used.add(j); }
    }
    clusters.push(cluster);
  }
  return clusters;
}

function jaccardNgram(a: string, b: string, n = 3): number {
  const ga = ngrams(a.toLowerCase(), n), gb = ngrams(b.toLowerCase(), n);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0; for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

function ngrams(t: string, n: number): Set<string> {
  const words = t.split(/\s+/).filter(Boolean);
  const s = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) s.add(words.slice(i, i + n).join(' '));
  if (words.length < n && words.length > 0) s.add(words.join(' '));
  return s;
}

function buildSynthesis(
  agreed: string[], conflicts: ConflictPoint[],
  unique: Array<{ model_id: string; insight: string }>,
  responses: DeliberationResponse[],
): string {
  const parts: string[] = [];
  if (agreed.length > 0) parts.push(`**Agreed (${agreed.length})**: ${agreed.join('; ')}`);
  if (conflicts.length > 0) {
    const fundamental = conflicts.filter((c) => c.severity === 'fundamental').length;
    parts.push(`**Conflicts (${conflicts.length}, ${fundamental} fundamental)**: ${conflicts.map((c) => c.topic).join('; ')}`);
  }
  if (unique.length > 0) parts.push(`**Unique insights (${unique.length})**: ${unique.map((u) => `[${u.model_id}] ${u.insight}`).join('; ')}`);
  parts.push(`**Models**: ${responses.map((r) => `${r.model_id} (${(r.confidence * 100).toFixed(0)}% confidence)`).join(', ')}`);
  return parts.join('\n');
}
