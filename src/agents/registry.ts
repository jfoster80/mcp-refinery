/**
 * Agent Registry — named specialist agents that compose into pipelines.
 *
 * Each agent has:
 *  - A clear role and system prompt (used for model calls or framing)
 *  - Capabilities — which internal functions it orchestrates
 *  - A preferred model tier — the classifier uses this for routing
 *  - Engagement heuristics — when the orchestrator brings it in
 */

import type { ModelTier } from '../types/index.js';

export interface AgentProfile {
  agent_id: string;
  name: string;
  role: string;
  system_prompt: string;
  capabilities: string[];
  preferred_tier: ModelTier;
  engagement: string;
}

const AGENTS: AgentProfile[] = [
  {
    agent_id: 'researcher',
    name: 'Research Agent',
    role: 'Deep multi-perspective analysis of MCP servers against protocol spec, security baselines, and best practices.',
    system_prompt: `You are a meticulous MCP server researcher. You analyze servers across 5 perspectives: security, reliability, compliance, developer experience, and performance. Every finding must have evidence. Quantify impact on a -1 to +1 scale. Flag real risks — don't soften language.`,
    capabilities: ['research_start', 'research_store', 'research_consensus'],
    preferred_tier: 'workhorse',
    engagement: 'Always first — builds the evidence base that all other agents depend on.',
  },
  {
    agent_id: 'architect',
    name: 'Architecture Agent',
    role: 'Architecture decisions, ADRs, and system design review. The strategic thinker.',
    system_prompt: `You are a senior software architect specializing in MCP protocol systems. You make binding architectural decisions documented as ADRs. Consider: transport safety, authentication patterns, tool schema design, error handling strategies, and protocol evolution. Every decision needs clear rationale and alternatives considered.`,
    capabilities: ['decision_record_adr', 'decision_check_oscillation', 'deliberation_start'],
    preferred_tier: 'architect',
    engagement: 'For architectural changes, conflicting ADRs, complex tradeoffs, multi-model deliberation.',
  },
  {
    agent_id: 'security_auditor',
    name: 'Security Auditor',
    role: 'Security-focused analysis: auth, input validation, secrets, OWASP LLM Top 10, supply chain.',
    system_prompt: `You are a security auditor specializing in LLM-integrated systems. You evaluate MCP servers against OWASP LLM Top 10, check for auth bypass, input injection, secret leakage, DNS rebinding (HTTP transport), and dependency vulnerabilities. Risk ratings must be specific and evidence-backed.`,
    capabilities: ['research_start', 'decision_capture_scorecard'],
    preferred_tier: 'architect',
    engagement: 'For any security-sensitive change, auth modifications, or when security score is below threshold.',
  },
  {
    agent_id: 'code_smith',
    name: 'Code Smith',
    role: 'Code generation, PR creation, and implementation. The builder.',
    system_prompt: `You are an expert MCP server developer. You produce clean, typed, well-tested code. All changes go through PRs — never commit directly to main. Follow the project's existing patterns. Include acceptance criteria in every PR.`,
    capabilities: ['delivery_plan', 'delivery_create_pr'],
    preferred_tier: 'workhorse',
    engagement: 'After proposals are approved — turns plans into code.',
  },
  {
    agent_id: 'test_evaluator',
    name: 'Test Evaluator',
    role: 'Test strategy, scorecard evaluation, and quality gates.',
    system_prompt: `You evaluate MCP server quality through scorecards. You verify monotonic improvement on primary metrics, flag regressions, and ensure test coverage meets thresholds. Be strict — scorecard integrity is what prevents oscillation.`,
    capabilities: ['decision_capture_scorecard'],
    preferred_tier: 'workhorse',
    engagement: 'Before and after every change — captures baseline and validates improvement.',
  },
  {
    agent_id: 'governance_gate',
    name: 'Governance Gate',
    role: 'Policy enforcement, approval management, and audit trail.',
    system_prompt: `You enforce governance policies. Check autonomy levels, change budgets, risk tiers. Escalate when needed. Every decision must be auditable. Never bypass a governance gate — if in doubt, escalate to the user.`,
    capabilities: ['governance_approve', 'governance_check'],
    preferred_tier: 'fast',
    engagement: 'At every control handoff — ensures policies are respected.',
  },
  {
    agent_id: 'release_manager',
    name: 'Release Manager',
    role: 'Semantic versioning, changelog generation, and release lifecycle.',
    system_prompt: `You manage releases for MCP servers. Determine correct SemVer bumps (breaking=major, feature=minor, fix=patch). Generate changelogs from proposals. Coordinate release stages: candidate → staging → canary → released.`,
    capabilities: ['delivery_release'],
    preferred_tier: 'fast',
    engagement: 'After PRs are merged — packages and releases improvements.',
  },
];

export function getAgent(id: string): AgentProfile | null {
  return AGENTS.find((a) => a.agent_id === id) ?? null;
}

export function getAllAgents(): AgentProfile[] { return [...AGENTS]; }

export function pickAgentsForIntent(intent: string): AgentProfile[] {
  const lower = intent.toLowerCase();
  const engaged: AgentProfile[] = [];

  if (lower.includes('security') || lower.includes('auth') || lower.includes('vulnerability'))
    engaged.push(AGENTS.find((a) => a.agent_id === 'security_auditor')!);

  if (lower.includes('architecture') || lower.includes('design') || lower.includes('adr'))
    engaged.push(AGENTS.find((a) => a.agent_id === 'architect')!);

  if (lower.includes('refine') || lower.includes('improve') || lower.includes('assess') || lower.includes('research'))
    engaged.push(AGENTS.find((a) => a.agent_id === 'researcher')!);

  if (lower.includes('code') || lower.includes('implement') || lower.includes('fix') || lower.includes('pr'))
    engaged.push(AGENTS.find((a) => a.agent_id === 'code_smith')!);

  if (lower.includes('test') || lower.includes('quality') || lower.includes('scorecard'))
    engaged.push(AGENTS.find((a) => a.agent_id === 'test_evaluator')!);

  if (lower.includes('release') || lower.includes('publish') || lower.includes('deploy'))
    engaged.push(AGENTS.find((a) => a.agent_id === 'release_manager')!);

  if (engaged.length === 0) engaged.push(AGENTS.find((a) => a.agent_id === 'researcher')!);

  return engaged;
}
