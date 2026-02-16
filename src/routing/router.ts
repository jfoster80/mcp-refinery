/**
 * Model Router — selects the right model(s) for a task and determines
 * whether to call APIs directly or generate prompts for the agent.
 *
 * Execution modes:
 *  - "api"    → API key available, call the model directly via fetch
 *  - "prompt" → No API key, generate a prompt for the agent/user to process
 *  - "mixed"  → Some models have keys, some don't
 */

import { getModel, getApiKey, getBestForTier } from './models.js';
import { classifyTask, type ClassifyInput } from './classifier.js';
import type { TaskClassification, ModelProfile, ModelTier } from '../types/index.js';

export type ExecutionMode = 'api' | 'prompt' | 'mixed';

export interface RoutingDecision {
  classification: TaskClassification;
  assignments: ModelAssignment[];
  execution_mode: ExecutionMode;
  estimated_cost_usd: number;
  estimated_latency_s: number;
}

export interface ModelAssignment {
  model: ModelProfile;
  role: 'primary' | 'secondary' | 'validator';
  mode: 'api' | 'prompt';
  reason: string;
}

/**
 * Route a task: classify it, pick models, determine how to execute.
 */
export function routeTask(input: ClassifyInput & { prompt_tokens_estimate?: number }): RoutingDecision {
  const classification = classifyTask(input);
  const assignments = buildAssignments(classification);

  const apiCount = assignments.filter((a) => a.mode === 'api').length;
  const promptCount = assignments.filter((a) => a.mode === 'prompt').length;
  const execution_mode: ExecutionMode =
    apiCount === assignments.length ? 'api'
    : promptCount === assignments.length ? 'prompt'
    : 'mixed';

  const tokens = input.prompt_tokens_estimate ?? 2000;
  const estimated_cost_usd = assignments.reduce((sum, a) => {
    return sum + (a.model.cost_input_per_mtok * tokens / 1_000_000)
      + (a.model.cost_output_per_mtok * (tokens * 0.5) / 1_000_000);
  }, 0);

  const estimated_latency_s = Math.max(
    ...assignments.map((a) => a.mode === 'api' ? (11 - a.model.speed) * 3 : 0),
    0,
  );

  return { classification, assignments, execution_mode, estimated_cost_usd, estimated_latency_s };
}

function buildAssignments(classification: TaskClassification): ModelAssignment[] {
  const assignments: ModelAssignment[] = [];
  const modelIds = classification.recommended_models;

  for (let i = 0; i < modelIds.length; i++) {
    const profile = getModel(modelIds[i]);
    if (!profile) continue;
    const hasKey = !!getApiKey(profile.provider);

    assignments.push({
      model: profile,
      role: i === 0 ? 'primary' : 'secondary',
      mode: hasKey ? 'api' : 'prompt',
      reason: i === 0
        ? `Primary ${profile.tier}: ${profile.display_name} (${hasKey ? 'API direct' : 'prompt mode'})`
        : `Secondary ${profile.tier}: ${profile.display_name} for cross-validation (${hasKey ? 'API direct' : 'prompt mode'})`,
    });
  }

  if (assignments.length === 0) {
    const fallback = getBestForTier(classification.recommended_tier);
    assignments.push({
      model: fallback,
      role: 'primary',
      mode: getApiKey(fallback.provider) ? 'api' : 'prompt',
      reason: `Fallback: ${fallback.display_name}`,
    });
  }

  return assignments;
}

/**
 * Build the model-switch instruction for bootstrap prompts.
 */
export function modelSwitchInstruction(model: ModelProfile, isPromptMode: boolean): string {
  if (isPromptMode) {
    return `[Model: ${model.display_name}] Switch to ${model.display_name} in your IDE model selector. This task requires ${model.tier}-tier reasoning.`;
  }
  return `[Model: ${model.display_name}] Calling via API (key detected for ${model.provider}).`;
}

/**
 * Quick router for known tier needs.
 */
export function quickRoute(tier: ModelTier): ModelAssignment {
  const model = getBestForTier(tier);
  const hasKey = !!getApiKey(model.provider);
  return {
    model,
    role: 'primary',
    mode: hasKey ? 'api' : 'prompt',
    reason: `Quick route: ${model.display_name} (${model.tier})`,
  };
}
