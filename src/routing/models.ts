/**
 * Model Registry — profiles for all supported LLMs.
 *
 * API keys are checked LIVE on every call (not cached), so adding a key
 * to .env or the process environment instantly makes that provider's
 * models available without restarting the server.
 *
 * Selection functions always prefer models with available keys.
 * When no keys exist at all, everything runs in "prompt" mode —
 * the Cursor agent processes prompts directly.
 */

import type { ModelProfile, ModelTier, ProviderName } from '../types/index.js';

const SEED_MODELS: Omit<ModelProfile, 'available'>[] = [
  // Anthropic ---------------------------------------------------------------
  {
    model_id: 'claude-opus',
    provider: 'anthropic',
    tier: 'architect',
    display_name: 'Claude Opus (Max)',
    api_model_id: 'claude-opus-4-20250514',
    capabilities: ['deep_reasoning', 'architecture', 'security_audit', 'code_review', 'structured_output'],
    cost_input_per_mtok: 15,
    cost_output_per_mtok: 75,
    max_context: 200_000,
    speed: 3,
    quality: 10,
    supports_structured: true,
  },
  {
    model_id: 'claude-sonnet',
    provider: 'anthropic',
    tier: 'workhorse',
    display_name: 'Claude Sonnet',
    api_model_id: 'claude-sonnet-4-20250514',
    capabilities: ['code_generation', 'code_review', 'documentation', 'structured_output'],
    cost_input_per_mtok: 3,
    cost_output_per_mtok: 15,
    max_context: 200_000,
    speed: 7,
    quality: 8,
    supports_structured: true,
  },
  {
    model_id: 'claude-haiku',
    provider: 'anthropic',
    tier: 'fast',
    display_name: 'Claude Haiku',
    api_model_id: 'claude-haiku-3-5-20241022',
    capabilities: ['fast_iteration', 'documentation', 'code_generation'],
    cost_input_per_mtok: 0.25,
    cost_output_per_mtok: 1.25,
    max_context: 200_000,
    speed: 10,
    quality: 6,
    supports_structured: true,
  },

  // OpenAI ------------------------------------------------------------------
  {
    model_id: 'gpt-4o',
    provider: 'openai',
    tier: 'architect',
    display_name: 'GPT-4o',
    api_model_id: 'gpt-4o',
    capabilities: ['deep_reasoning', 'architecture', 'code_review', 'vision', 'structured_output'],
    cost_input_per_mtok: 2.5,
    cost_output_per_mtok: 10,
    max_context: 128_000,
    speed: 6,
    quality: 9,
    supports_structured: true,
  },
  {
    model_id: 'o3',
    provider: 'openai',
    tier: 'architect',
    display_name: 'o3 (Deep Reasoning)',
    api_model_id: 'o3',
    capabilities: ['deep_reasoning', 'architecture', 'security_audit', 'code_review'],
    cost_input_per_mtok: 10,
    cost_output_per_mtok: 40,
    max_context: 200_000,
    speed: 2,
    quality: 10,
    supports_structured: true,
  },
  {
    model_id: 'gpt-4o-mini',
    provider: 'openai',
    tier: 'fast',
    display_name: 'GPT-4o Mini',
    api_model_id: 'gpt-4o-mini',
    capabilities: ['fast_iteration', 'code_generation', 'documentation'],
    cost_input_per_mtok: 0.15,
    cost_output_per_mtok: 0.6,
    max_context: 128_000,
    speed: 9,
    quality: 6,
    supports_structured: true,
  },

  // Google ------------------------------------------------------------------
  {
    model_id: 'gemini-pro',
    provider: 'google',
    tier: 'architect',
    display_name: 'Gemini 2.5 Pro',
    api_model_id: 'gemini-2.5-pro-preview-06-05',
    capabilities: ['deep_reasoning', 'architecture', 'code_review', 'vision'],
    cost_input_per_mtok: 1.25,
    cost_output_per_mtok: 10,
    max_context: 1_000_000,
    speed: 5,
    quality: 9,
    supports_structured: true,
  },
  {
    model_id: 'gemini-flash',
    provider: 'google',
    tier: 'workhorse',
    display_name: 'Gemini 2.0 Flash',
    api_model_id: 'gemini-2.0-flash',
    capabilities: ['fast_iteration', 'code_generation', 'structured_output'],
    cost_input_per_mtok: 0.1,
    cost_output_per_mtok: 0.4,
    max_context: 1_000_000,
    speed: 9,
    quality: 7,
    supports_structured: true,
  },

  // xAI ---------------------------------------------------------------------
  {
    model_id: 'grok-3',
    provider: 'xai',
    tier: 'workhorse',
    display_name: 'Grok 3',
    api_model_id: 'grok-3',
    capabilities: ['code_generation', 'code_review', 'documentation'],
    cost_input_per_mtok: 3,
    cost_output_per_mtok: 15,
    max_context: 131_072,
    speed: 6,
    quality: 7,
    supports_structured: true,
  },
];

const ENV_KEYS: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_AI_API_KEY',
  xai: 'XAI_API_KEY',
};

// ---------------------------------------------------------------------------
// Live key detection — checked every call, never cached
// ---------------------------------------------------------------------------

function hasKey(provider: ProviderName): boolean {
  const val = process.env[ENV_KEYS[provider]];
  return typeof val === 'string' && val.length > 0;
}

export function getApiKey(provider: ProviderName): string | null {
  const val = process.env[ENV_KEYS[provider]];
  return (typeof val === 'string' && val.length > 0) ? val : null;
}

/**
 * Get the full registry with live availability flags.
 * Not cached — availability is recomputed on every call so that
 * adding an API key to the environment takes effect immediately.
 */
export function getModelRegistry(): ModelProfile[] {
  return SEED_MODELS.map((m) => ({
    ...m,
    available: hasKey(m.provider),
  }));
}

export function getModel(id: string): ModelProfile | null {
  return getModelRegistry().find((m) => m.model_id === id) ?? null;
}

export function getModelsByTier(tier: ModelTier): ModelProfile[] {
  return getModelRegistry().filter((m) => m.tier === tier);
}

export function getAvailableModels(): ModelProfile[] {
  return getModelRegistry().filter((m) => m.available);
}

/**
 * Which providers currently have keys configured.
 */
export function getActiveProviders(): ProviderName[] {
  return (Object.keys(ENV_KEYS) as ProviderName[]).filter(hasKey);
}

// ---------------------------------------------------------------------------
// Selection — always prefers available models
// ---------------------------------------------------------------------------

/**
 * Pick the best model for a tier. Strongly prefers models with available keys.
 * Falls back to unavailable models only if no available ones exist for the tier.
 */
export function getBestForTier(tier: ModelTier): ModelProfile {
  const all = getModelsByTier(tier).sort((a, b) => b.quality - a.quality);
  const available = all.filter((m) => m.available);
  return available.length > 0 ? available[0] : all[0];
}

/**
 * Get a pair of architect-tier models from DIFFERENT providers,
 * preferring pairs where BOTH have API keys.
 * Falls back to a same-provider pair if only one provider has keys.
 * Returns null if fewer than 2 architect models exist at all.
 */
export function getArchitectPair(): [ModelProfile, ModelProfile] | null {
  const architects = getModelsByTier('architect').sort((a, b) => b.quality - a.quality);
  if (architects.length < 2) return null;

  const available = architects.filter((m) => m.available);

  // Best case: two available architects from different providers
  if (available.length >= 2) {
    const first = available[0];
    const cross = available.find((m) => m.provider !== first.provider);
    if (cross) return [first, cross];
    // Two available but same provider — still better than mixing with unavailable
    return [available[0], available[1]];
  }

  // One available — pair it with the best unavailable from a different provider
  if (available.length === 1) {
    const first = available[0];
    const second = architects.find((m) => m.provider !== first.provider) ?? architects.find((m) => m.model_id !== first.model_id);
    if (second) return [first, second];
  }

  // No keys at all — return top two by quality
  return [architects[0], architects[1]];
}

export function getModelSummary(): {
  total: number;
  available: number;
  active_providers: ProviderName[];
  by_tier: Record<ModelTier, { total: number; available: number; best: string }>;
  by_provider: Record<string, { total: number; available: number; has_key: boolean }>;
} {
  const all = getModelRegistry();
  const activeProviders = getActiveProviders();

  const tiers: Record<ModelTier, { total: number; available: number; best: string }> = {
    architect: { total: 0, available: 0, best: '' },
    workhorse: { total: 0, available: 0, best: '' },
    fast: { total: 0, available: 0, best: '' },
  };
  const providers: Record<string, { total: number; available: number; has_key: boolean }> = {};

  for (const m of all) {
    tiers[m.tier].total++;
    if (m.available) tiers[m.tier].available++;

    if (!providers[m.provider]) providers[m.provider] = { total: 0, available: 0, has_key: hasKey(m.provider as ProviderName) };
    providers[m.provider].total++;
    if (m.available) providers[m.provider].available++;
  }

  // Fill in best model for each tier
  for (const tier of ['architect', 'workhorse', 'fast'] as ModelTier[]) {
    const best = getBestForTier(tier);
    tiers[tier].best = `${best.display_name}${best.available ? '' : ' (no key)'}`;
  }

  return {
    total: all.length,
    available: all.filter((m) => m.available).length,
    active_providers: activeProviders,
    by_tier: tiers,
    by_provider: providers,
  };
}
