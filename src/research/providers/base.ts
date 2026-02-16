/**
 * Research prompt generation — zero external dependencies.
 *
 * Instead of calling external LLM APIs, the server generates structured
 * prompts that the Cursor agent (Claude) processes directly.
 * The agent IS the research engine — no separate API keys needed.
 */

import { createHash } from 'node:crypto';
import type { ResearchPerspective, Finding } from '../../types/index.js';
import { buildBaselinePromptSection } from '../../knowledge/index.js';

export interface ResearchQuery {
  target_server_id: string;
  server_name: string;
  server_description: string;
  current_tools: string[];
  current_resources: string[];
  transport: string;
  auth_mode: string;
  focus_areas: string[];
  additional_context: string;
}

export const FINDINGS_JSON_SHAPE = `{
  "findings": [
    {
      "claim": "Specific falsifiable claim about the server",
      "recommendation": "Actionable fix or improvement",
      "expected_impact": { "reliability": 0.0, "security": 0.0, "devex": 0.0, "performance": 0.0 },
      "risk": { "level": "low|medium|high|critical", "notes": "why" },
      "evidence": [{ "type": "url|quote|spec_reference", "value": "...", "quality": "A|B|C" }]
    }
  ]
}`;

export function buildResearchPrompt(query: ResearchQuery, perspective: ResearchPerspective): string {
  const perspectiveInstructions: Record<ResearchPerspective, string> = {
    security: 'Focus on: authentication, authorization, input validation, secret management, OWASP LLM Top 10, dependency vulnerabilities, DNS rebinding for HTTP transport.',
    reliability: 'Focus on: error handling, graceful degradation, retry logic, timeout management, transport resilience, connection lifecycle.',
    compliance: 'Focus on: MCP protocol compliance (2025-11-25), JSON-RPC 2.0 correctness, tool schema quality, resource URI patterns, structured output usage.',
    devex: 'Focus on: API ergonomics, documentation quality, onboarding friction, error messages, debugging support, type safety.',
    performance: 'Focus on: latency optimization, memory usage, connection pooling, batch operations, caching opportunities.',
    general: 'Provide a balanced review across security, reliability, compliance, developer experience, and performance.',
  };

  const perspectiveToCategory: Record<ResearchPerspective, string[]> = {
    security: ['security', 'governance'],
    reliability: ['reliability', 'architecture'],
    compliance: ['governance', 'architecture'],
    devex: ['devex', 'maintenance'],
    performance: ['reliability', 'architecture'],
    general: ['architecture', 'governance', 'devex', 'reliability', 'security', 'maintenance'],
  };
  const categories = perspectiveToCategory[perspective] ?? ['architecture'];
  const baselineSection = buildBaselinePromptSection(categories as Array<'architecture' | 'governance' | 'devex' | 'reliability' | 'security' | 'maintenance'>);

  return `Analyze this MCP server from a **${perspective}** perspective and return findings as JSON.

## Target Server
- **Name**: ${query.server_name} (ID: ${query.target_server_id})
- **Transport**: ${query.transport} | **Auth**: ${query.auth_mode}
- **Tools**: ${query.current_tools.length > 0 ? query.current_tools.join(', ') : 'None listed'}
- **Resources**: ${query.current_resources.length > 0 ? query.current_resources.join(', ') : 'None listed'}

## Additional Context
${query.additional_context || 'None.'}

## ${perspectiveInstructions[perspective]}

${baselineSection}

Impact scores: -1.0 (harmful) to +1.0 (beneficial). Evidence quality: A=primary source, B=secondary, C=general knowledge.

Return ONLY valid JSON matching this shape:
${FINDINGS_JSON_SHAPE}`;
}

export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

export function validateFindings(findings: unknown): findings is Finding[] {
  if (!Array.isArray(findings)) return false;
  for (const f of findings) {
    if (typeof f !== 'object' || f === null) return false;
    const r = f as Record<string, unknown>;
    if (typeof r.claim !== 'string' || typeof r.recommendation !== 'string') return false;
    if (typeof r.expected_impact !== 'object' || typeof r.risk !== 'object') return false;
    if (!Array.isArray(r.evidence)) return false;
  }
  return true;
}
