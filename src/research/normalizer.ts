/**
 * Findings normalizer — sanitizes and validates incoming findings.
 */

import type { Finding, RiskLevel } from '../types/index.js';

export function sanitizeFindings(raw: unknown[]): Finding[] {
  return raw.map((r) => {
    const f = r as Record<string, unknown>;
    const impact = (f.expected_impact ?? {}) as Record<string, number>;
    const risk = (f.risk ?? {}) as Record<string, unknown>;
    return {
      claim: String(f.claim ?? '').trim(),
      recommendation: String(f.recommendation ?? '').trim(),
      expected_impact: {
        reliability: clamp(impact.reliability ?? 0, -1, 1),
        security: clamp(impact.security ?? 0, -1, 1),
        devex: clamp(impact.devex ?? 0, -1, 1),
        performance: clamp(impact.performance ?? 0, -1, 1),
      },
      risk: {
        level: validateRisk(String(risk.level ?? 'low')),
        notes: String(risk.notes ?? '').trim(),
      },
      evidence: Array.isArray(f.evidence)
        ? (f.evidence as Array<Record<string, unknown>>).map((e) => ({
            type: (['url', 'quote', 'spec_reference'].includes(String(e.type)) ? String(e.type) : 'quote') as 'url' | 'quote' | 'spec_reference',
            value: String(e.value ?? '').trim(),
            quality: (['A', 'B', 'C'].includes(String(e.quality)) ? String(e.quality) : 'C') as 'A' | 'B' | 'C',
          }))
        : [],
    };
  });
}

function clamp(v: number, min: number, max: number): number { return Math.max(min, Math.min(max, v)); }
function validateRisk(s: string): RiskLevel { return (['low', 'medium', 'high', 'critical'].includes(s) ? s : 'low') as RiskLevel; }
