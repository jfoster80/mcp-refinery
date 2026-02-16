/**
 * MCP Resource registrations — read-only data endpoints.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listTargetServers, listProposals, listPolicyRules, getLatestScorecard, getLatestConsensus, getLatestRelease, getAuditStats } from '../storage/index.js';
import { getActiveADRs, formatADRMarkdown, formatScorecardReport } from '../decision/index.js';

export function registerResources(server: McpServer): void {

  server.resource('backlog', 'refinery://backlog', { description: 'Improvement backlog across all servers', mimeType: 'application/json' }, async (uri) => {
    const servers = listTargetServers();
    const backlog: Record<string, unknown> = {};
    for (const s of servers) {
      const proposals = listProposals(s.server_id);
      backlog[s.server_id] = { server_name: s.name, total: proposals.length, by_status: groupBy(proposals, 'status'), top: proposals.slice(0, 5).map((p) => ({ id: p.proposal_id, title: p.title, priority: p.priority, risk: p.risk_level, status: p.status })) };
    }
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(backlog, null, 2) }] };
  });

  server.resource('policies', 'refinery://policies', { description: 'Active governance policies', mimeType: 'application/json' }, async (uri) => {
    const rules = listPolicyRules();
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ total: rules.length, enabled: rules.filter((r) => r.enabled).length, rules }, null, 2) }] };
  });

  server.resource('adrs', 'refinery://adrs', { description: 'Active Architecture Decision Records', mimeType: 'text/markdown' }, async (uri) => {
    const adrs = getActiveADRs();
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: adrs.length > 0 ? adrs.map(formatADRMarkdown).join('\n\n---\n\n') : '# No Active ADRs\n\nNo decisions recorded yet.' }] };
  });

  server.resource('status', 'refinery://status', { description: 'System-wide status dashboard', mimeType: 'application/json' }, async (uri) => {
    const servers = listTargetServers();
    const statuses = servers.map((s) => ({
      server_id: s.server_id, name: s.name, autonomy: s.autonomy_level,
      scorecard: getLatestScorecard(s.server_id)?.overall_score ?? null,
      consensus: getLatestConsensus(s.server_id)?.overall_agreement ?? null,
      latest_release: getLatestRelease(s.server_id)?.version ?? null,
      proposals: listProposals(s.server_id).length,
    }));
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ servers: statuses, audit: getAuditStats() }, null, 2) }] };
  });

  server.resource('scorecards', 'refinery://scorecards', { description: 'Latest scorecards for all servers', mimeType: 'text/markdown' }, async (uri) => {
    const servers = listTargetServers();
    const reports = servers.map((s) => { const sc = getLatestScorecard(s.server_id); return sc ? formatScorecardReport(sc) : `# ${s.name}\nNo scorecard yet.`; });
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: reports.join('\n\n---\n\n') }] };
  });
}

function groupBy<T>(items: T[], key: keyof T): Record<string, number> {
  const g: Record<string, number> = {};
  for (const i of items) g[String(i[key])] = (g[String(i[key])] ?? 0) + 1;
  return g;
}
