/**
 * Cross-perspective consensus scoring engine.
 *
 * Computes agreement across research rounds (security, reliability, etc.)
 * to determine which recommendations have strong multi-perspective support.
 */

import { randomUUID } from 'node:crypto';
import type {
  ResearchFeedEntry, ConsensusResult, ConsensusFinding,
  Finding, ResearchPerspective, RiskLevel, Evidence,
} from '../types/index.js';

export function computeConsensus(feeds: ResearchFeedEntry[], targetServerId: string, threshold = 0.3): ConsensusResult {
  if (feeds.length === 0) {
    return { consensus_id: randomUUID(), target_server_id: targetServerId, computed_at: new Date().toISOString(), findings: [], overall_agreement: 0, perspectives_used: [] };
  }

  const all: Array<{ perspective: ResearchPerspective; finding: Finding; confidence: number }> = [];
  for (const f of feeds) for (const finding of f.findings) all.push({ perspective: f.perspective, finding, confidence: f.confidence });

  const clusters = clusterFindings(all, threshold);
  const perspectives = [...new Set(feeds.map((f) => f.perspective))];
  const consensusFindings = clusters.map((c) => buildConsensusFinding(c, perspectives.length));
  const scores = consensusFindings.map((f) => f.agreement_score);
  const overall = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  return {
    consensus_id: randomUUID(), target_server_id: targetServerId,
    computed_at: new Date().toISOString(), findings: consensusFindings,
    overall_agreement: overall, perspectives_used: perspectives,
  };
}

interface CF { perspective: ResearchPerspective; finding: Finding; confidence: number }

function clusterFindings(all: CF[], threshold: number): CF[][] {
  const clusters: CF[][] = [];
  const used = new Set<number>();
  for (let i = 0; i < all.length; i++) {
    if (used.has(i)) continue;
    const cluster = [all[i]]; used.add(i);
    for (let j = i + 1; j < all.length; j++) {
      if (used.has(j)) continue;
      if (all[i].perspective === all[j].perspective) continue;
      const textA = all[i].finding.claim + ' ' + all[i].finding.recommendation;
      const textB = all[j].finding.claim + ' ' + all[j].finding.recommendation;
      const sim = combinedSimilarity(textA, textB);
      if (sim >= threshold) { cluster.push(all[j]); used.add(j); }
    }
    clusters.push(cluster);
  }
  return clusters;
}

/**
 * Multi-level similarity: combines keyword (unigram) overlap with bigram phrase
 * matching. This catches semantically related findings that use different phrasing
 * (e.g. "input redaction" vs "PHI blocking" both mention "external MCP calls").
 */
function combinedSimilarity(a: string, b: string): number {
  const keyword = keywordJaccard(a, b);
  const bigram = jaccardNgram(a, b, 2);
  return Math.max(keyword, bigram);
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'and', 'but', 'or', 'not', 'no', 'so', 'yet',
  'both', 'each', 'all', 'any', 'more', 'most', 'other', 'some', 'such',
  'only', 'own', 'same', 'than', 'too', 'very', 'that', 'this', 'these',
  'those', 'it', 'its', 'also', 'use', 'using', 'used', 'needs', 'need',
  'must', 'ensure', 'implement', 'add', 'create', 'update', 'server',
]);

function keywordJaccard(a: string, b: string): number {
  const extract = (t: string): Set<string> => {
    const words = t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    return new Set(words);
  };
  const sa = extract(a), sb = extract(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function buildConsensusFinding(cluster: CF[], totalPerspectives: number): ConsensusFinding {
  const perspectives = [...new Set(cluster.map((c) => c.perspective))];
  const best = cluster.reduce((b, c) => c.confidence > b.confidence ? c : b);
  const evidenceMap = new Map<string, Evidence>();
  for (const c of cluster) for (const e of c.finding.evidence) evidenceMap.set(`${e.type}:${e.value}`, e);

  return {
    claim: best.finding.claim, recommendation: best.finding.recommendation,
    supporting_perspectives: perspectives,
    agreement_score: perspectives.length / totalPerspectives,
    combined_confidence: cluster.reduce((s, c) => s + c.confidence, 0) / cluster.length,
    merged_evidence: [...evidenceMap.values()],
    merged_impact: {
      reliability: avg(cluster.map((c) => c.finding.expected_impact.reliability)),
      security: avg(cluster.map((c) => c.finding.expected_impact.security)),
      devex: avg(cluster.map((c) => c.finding.expected_impact.devex)),
      performance: avg(cluster.map((c) => c.finding.expected_impact.performance)),
    },
    risk_level: maxRisk(cluster.map((c) => c.finding.risk.level)),
  };
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

function avg(v: number[]): number { return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }
function maxRisk(levels: RiskLevel[]): RiskLevel {
  const o: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  return o[Math.max(...levels.map((l) => o.indexOf(l)))];
}
