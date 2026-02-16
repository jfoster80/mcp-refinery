/**
 * Zero-dependency LLM providers — uses Node 20+ native fetch.
 *
 * Each provider is a thin HTTP wrapper. No SDKs, no extra packages.
 * Supports: Anthropic, OpenAI, Google Gemini, xAI Grok.
 */

import { getApiKey } from './models.js';
import type { ProviderName } from '../types/index.js';

export interface LLMResponse {
  text: string;
  tokens: { input: number; output: number };
  latency_ms: number;
  model_id: string;
  provider: ProviderName;
}

export interface LLMCallOptions {
  provider: ProviderName;
  model_id: string;
  prompt: string;
  system_prompt?: string;
  max_tokens?: number;
  temperature?: number;
  timeout_ms?: number;
}

/**
 * Call any supported LLM provider. Throws if no API key available.
 */
export async function callModel(opts: LLMCallOptions): Promise<LLMResponse> {
  const key = getApiKey(opts.provider);
  if (!key) throw new Error(`No API key for ${opts.provider}. Set ${envKeyName(opts.provider)} environment variable.`);

  const start = Date.now();
  const maxTokens = opts.max_tokens ?? 8192;
  const temperature = opts.temperature ?? 0.3;
  const timeoutMs = opts.timeout_ms ?? 120_000;

  switch (opts.provider) {
    case 'anthropic': return callAnthropic(key, opts, maxTokens, temperature, timeoutMs, start);
    case 'openai': return callOpenAI(key, opts, maxTokens, temperature, timeoutMs, start);
    case 'google': return callGoogle(key, opts, maxTokens, temperature, timeoutMs, start);
    case 'xai': return callXAI(key, opts, maxTokens, temperature, timeoutMs, start);
  }
}

/**
 * Check if a provider has direct API access.
 */
export function canCallDirectly(provider: ProviderName): boolean {
  return !!getApiKey(provider);
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

async function callAnthropic(
  key: string, opts: LLMCallOptions, maxTokens: number,
  temperature: number, timeoutMs: number, start: number,
): Promise<LLMResponse> {
  const body: Record<string, unknown> = {
    model: opts.model_id,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: opts.prompt }],
    temperature,
  };
  if (opts.system_prompt) body.system = opts.system_prompt;

  const resp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }, timeoutMs);

  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { content: Array<{ text: string }>; usage: { input_tokens: number; output_tokens: number } };

  return {
    text: data.content.map((c) => c.text).join(''),
    tokens: { input: data.usage.input_tokens, output: data.usage.output_tokens },
    latency_ms: Date.now() - start,
    model_id: opts.model_id,
    provider: 'anthropic',
  };
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions API
// ---------------------------------------------------------------------------

async function callOpenAI(
  key: string, opts: LLMCallOptions, maxTokens: number,
  temperature: number, timeoutMs: number, start: number,
): Promise<LLMResponse> {
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system_prompt) messages.push({ role: 'system', content: opts.system_prompt });
  messages.push({ role: 'user', content: opts.prompt });

  const resp = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: opts.model_id, messages, max_tokens: maxTokens, temperature }),
  }, timeoutMs);

  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number; completion_tokens: number } };

  return {
    text: data.choices[0]?.message?.content ?? '',
    tokens: { input: data.usage.prompt_tokens, output: data.usage.completion_tokens },
    latency_ms: Date.now() - start,
    model_id: opts.model_id,
    provider: 'openai',
  };
}

// ---------------------------------------------------------------------------
// Google Gemini API
// ---------------------------------------------------------------------------

async function callGoogle(
  key: string, opts: LLMCallOptions, maxTokens: number,
  temperature: number, timeoutMs: number, start: number,
): Promise<LLMResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model_id}:generateContent?key=${key}`;
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  if (opts.system_prompt) contents.push({ role: 'user', parts: [{ text: `System: ${opts.system_prompt}` }] });
  contents.push({ role: 'user', parts: [{ text: opts.prompt }] });

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    }),
  }, timeoutMs);

  if (!resp.ok) throw new Error(`Google ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
  };

  return {
    text: data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '',
    tokens: { input: data.usageMetadata?.promptTokenCount ?? 0, output: data.usageMetadata?.candidatesTokenCount ?? 0 },
    latency_ms: Date.now() - start,
    model_id: opts.model_id,
    provider: 'google',
  };
}

// ---------------------------------------------------------------------------
// xAI Grok API (OpenAI-compatible)
// ---------------------------------------------------------------------------

async function callXAI(
  key: string, opts: LLMCallOptions, maxTokens: number,
  temperature: number, timeoutMs: number, start: number,
): Promise<LLMResponse> {
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system_prompt) messages.push({ role: 'system', content: opts.system_prompt });
  messages.push({ role: 'user', content: opts.prompt });

  const resp = await fetchWithTimeout('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: opts.model_id, messages, max_tokens: maxTokens, temperature }),
  }, timeoutMs);

  if (!resp.ok) throw new Error(`xAI ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number; completion_tokens: number } };

  return {
    text: data.choices[0]?.message?.content ?? '',
    tokens: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
    latency_ms: Date.now() - start,
    model_id: opts.model_id,
    provider: 'xai',
  };
}

// ---------------------------------------------------------------------------
// Fetch helper with timeout
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function envKeyName(provider: ProviderName): string {
  return { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_AI_API_KEY', xai: 'XAI_API_KEY' }[provider];
}
