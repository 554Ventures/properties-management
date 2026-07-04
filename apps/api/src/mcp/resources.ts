// MCP resources (ARCHITECTURE §7): read-only views over the service layer.
// JSON resources use application/json; the portfolio summary is text/plain.
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PeriodSchema } from '@hearth/shared';
import * as dashboardService from '../services/dashboard.service';
import * as insightService from '../services/insight.service';
import * as propertyService from '../services/property.service';
import * as rentService from '../services/rent.service';
import * as reportService from '../services/report.service';

const JSON_MIME = 'application/json';

function jsonContents(uri: URL, data: unknown) {
  return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(data, null, 2) }] };
}

export interface McpResourceOptions {
  accountId: string;
}

export function registerMcpResources(server: McpServer, { accountId }: McpResourceOptions): void {
  server.registerResource(
    'portfolio-summary',
    'hearth://portfolio/summary',
    {
      description:
        'One-paragraph portfolio summary followed by the dashboard KPIs (money in integer cents).',
      mimeType: 'text/plain',
    },
    async (uri) => {
      const { summary, kpis } = await dashboardService.getPortfolioSummary(accountId);
      const text = `${summary}\n\nKPIs (all money in integer cents):\n${JSON.stringify(kpis, null, 2)}`;
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] };
    },
  );

  server.registerResource(
    'properties',
    'hearth://properties',
    { description: 'All properties with derived stats (unit count, occupancy, monthly rent).', mimeType: JSON_MIME },
    async (uri) => jsonContents(uri, await propertyService.list(accountId)),
  );

  server.registerResource(
    'property',
    new ResourceTemplate('hearth://properties/{id}', { list: undefined }),
    { description: 'One property in full detail: units, leases, tenants, P&L and active insights.', mimeType: JSON_MIME },
    async (uri, variables) =>
      jsonContents(uri, await propertyService.getDetail(accountId, String(variables.id))),
  );

  server.registerResource(
    'rent-tracker',
    new ResourceTemplate('hearth://rent/{period}', { list: undefined }),
    { description: 'Rent tracker for a period ("YYYY-MM"): collected/outstanding and per-tenant rows.', mimeType: JSON_MIME },
    async (uri, variables) => {
      const period = PeriodSchema.parse(String(variables.period));
      return jsonContents(uri, await rentService.getMonthStatus(accountId, period));
    },
  );

  server.registerResource(
    'reports',
    'hearth://reports',
    { description: 'Archive of generated reports (metadata only, no data snapshots).', mimeType: JSON_MIME },
    async (uri) => jsonContents(uri, await reportService.listGenerated(accountId)),
  );

  server.registerResource(
    'report',
    new ResourceTemplate('hearth://reports/{id}', { list: undefined }),
    { description: 'One generated report including its snapshotted data.', mimeType: JSON_MIME },
    async (uri, variables) =>
      jsonContents(uri, await reportService.getById(accountId, String(variables.id))),
  );

  server.registerResource(
    'insights-active',
    'hearth://insights/active',
    { description: 'All currently active insights across the portfolio.', mimeType: JSON_MIME },
    async (uri) => jsonContents(uri, await insightService.listActive(accountId)),
  );
}
