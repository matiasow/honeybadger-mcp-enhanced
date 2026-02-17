#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import axios from 'axios';
import { z } from 'zod';

interface HoneybadgerConfig {
  apiKey: string;
  projectId?: string;
  baseUrl?: string;
  readOnly: boolean;
}

interface HoneybadgerFault {
  id: string;
  klass: string;
  message: string;
  environment: string;
  project_id: number;
  created_at: string;
  last_notice_at: string;
  notices_count: number;
  url: string;
  assignee?: {
    id: number;
    name: string;
    email: string;
  };
  tags: string[];
  resolved: boolean;
}

interface HoneybadgerNotice {
  id: string;
  fault_id: string;
  message: string;
  backtrace: Array<{
    number: string;
    file: string;
    method: string;
    source?: { [line: string]: string };
  }>;
  environment_name: string;
  occurred_at: string;
  url: string;
  context: {
    [key: string]: any;
  };
  params: {
    [key: string]: any;
  };
  session: {
    [key: string]: any;
  };
  cgi_data: {
    [key: string]: any;
  };
}

class HoneybadgerMCPServer {
  private server: McpServer;
  private config: HoneybadgerConfig;

  constructor() {
    this.config = {
      apiKey: process.env.HONEYBADGER_API_KEY || '',
      projectId: process.env.HONEYBADGER_PROJECT_ID,
      baseUrl: process.env.HONEYBADGER_BASE_URL || 'https://app.honeybadger.io',
      readOnly: process.env.HONEYBADGER_READ_ONLY !== 'false',
    };

    this.server = new McpServer(
      {
        name: 'honeybadger-mcp',
        version: '0.5.0',
      },
      {
        capabilities: {
          tools: {},
        },
        instructions: `Honeybadger MCP server for error tracking data access.

Key concepts:
- project_id: numeric ID — discover via list_honeybadger_projects
- fault: a unique error pattern (grouped occurrences of the same error)
- notice: a single error occurrence belonging to a fault

Write operations (create/update/delete project) are only available when
HONEYBADGER_READ_ONLY=false is set. The server runs in read-only mode by default.

Timestamps use RFC3339 format, e.g. "2026-02-16T10:00:00Z".
All IDs (project_id, fault_id) are integers, not strings.`,
      }
    );

    this.setupTools();
  }

  // ── Utility methods ──────────────────────────────────────────────────────────

  private resolveProjectId(providedId?: number): number {
    const pid = providedId || (this.config.projectId ? Number(this.config.projectId) : undefined);
    if (!pid) {
      throw new Error(
        'Project ID required. Provide via project_id parameter or HONEYBADGER_PROJECT_ID env var.'
      );
    }
    return pid;
  }

  private parseTimestamp(ts?: string): string | undefined {
    if (!ts) return undefined;
    const date = new Date(ts);
    if (isNaN(date.getTime())) {
      throw new Error(`Invalid timestamp: "${ts}". Use RFC3339 format, e.g. "2026-02-16T10:00:00Z"`);
    }
    return date.toISOString();
  }

  private toolError(message: string) {
    return {
      content: [{ type: 'text' as const, text: message }],
      isError: true as const,
    };
  }

  private formatJsonResponse(data: any) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }

  private formatListResponse(
    items: any[],
    metadata?: { total?: number; page?: number; per_page?: number }
  ) {
    let summary = `Found ${items.length} items`;
    if (metadata?.total) summary += ` (${metadata.total} total)`;
    if (metadata?.page) summary += `, page ${metadata.page}`;
    return {
      content: [{ type: 'text' as const, text: `${summary}\n\n${JSON.stringify(items, null, 2)}` }],
    };
  }

  private formatWriteResponse(data: any, operation: string) {
    return {
      content: [{ type: 'text' as const, text: `Successfully ${operation}\n\n${JSON.stringify(data, null, 2)}` }],
    };
  }

  // ── HTTP client ──────────────────────────────────────────────────────────────

  private async makeHoneybadgerRequest(
    endpoint: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      params?: any;
      data?: any;
    } = {}
  ) {
    if (!this.config.apiKey) {
      throw new Error('HONEYBADGER_API_KEY environment variable is required');
    }

    const { method = 'GET', params, data } = options;
    const url = `${this.config.baseUrl}/v2${endpoint}`;
    const credentials = Buffer.from(`${this.config.apiKey}:`).toString('base64');

    try {
      const config: any = {
        method,
        url,
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      };
      if (params) config.params = params;
      if (data) config.data = data;

      const response = await axios(config);
      return response.data;
    } catch (error: any) {
      if (error.response) {
        const status = error.response.status;
        const message = error.response.data?.error || error.response.statusText;

        if (status === 401) throw new Error('Authentication failed. Check HONEYBADGER_API_KEY.');
        if (status === 403) throw new Error(`Permission denied: ${message}`);
        if (status === 404) throw new Error(`Not found: ${endpoint}`);
        if (status === 422) throw new Error(`Validation error: ${message}`);
        if (status === 429) throw new Error('Rate limit exceeded. Please wait and retry.');

        throw new Error(`Honeybadger API error: ${status} - ${message}`);
      }
      throw new Error(`Network error: ${error.message}`);
    }
  }

  // ── Tool registration ────────────────────────────────────────────────────────

  private setupTools() {
    this.registerReadTools();
    if (!this.config.readOnly) {
      this.registerWriteTools();
    }
  }

  private registerReadTools() {
    // ── Projects ─────────────────────────────────────────────────────────────

    // @ts-expect-error - TypeScript has issues with deep type instantiation in MCP SDK
    this.server.registerTool(
      'list_honeybadger_projects',
      {
        description: 'List all Honeybadger projects you have access to',
        annotations: {
          title: 'List Projects',
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          account_id: z.string().optional().describe('Optional account ID to filter projects by specific account'),
          page: z.number().min(1).default(1).describe('Page number'),
          per_page: z.number().min(1).max(100).default(20).describe('Results per page (max 100)'),
        },
      },
      async ({ account_id, page = 1, per_page = 20 }) => {
        try {
          const params: any = { page, per_page: Math.min(per_page, 100) };
          const endpoint = account_id ? `/accounts/${account_id}/projects` : '/projects';
          const data = await this.makeHoneybadgerRequest(endpoint, { params });
          return this.formatListResponse(data.results || [], { total: data.total_count, page, per_page });
        } catch (e: any) {
          return this.toolError(e.message);
        }
      }
    );

    this.server.registerTool(
      'get_honeybadger_project',
      {
        description: 'Get detailed information about a specific Honeybadger project',
        annotations: {
          title: 'Get Project',
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          id: z.number().min(1).describe('The project ID to fetch'),
        },
      },
      async ({ id }) => {
        try {
          const data = await this.makeHoneybadgerRequest(`/projects/${id}`);
          return this.formatJsonResponse(data);
        } catch (e: any) {
          return this.toolError(e.message);
        }
      }
    );

    this.server.registerTool(
      'get_honeybadger_project_occurrence_counts',
      {
        description: 'Get occurrence counts for all projects or a specific project',
        annotations: {
          title: 'Get Project Occurrence Counts',
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          project_id: z.number().min(1).optional().describe('Optional project ID to get counts for specific project'),
          period: z.enum(['hour', 'day', 'week', 'month']).default('hour').describe('Time period for grouping data'),
          environment: z.string().optional().describe('Filter by environment'),
        },
      },
      async ({ project_id, period = 'hour', environment }) => {
        try {
          const params: any = { period };
          if (environment) params.environment = environment;
          const endpoint = project_id
            ? `/projects/${project_id}/occurrences`
            : `/projects/occurrences`;
          const data = await this.makeHoneybadgerRequest(endpoint, { params });
          return this.formatJsonResponse(data);
        } catch (e: any) {
          return this.toolError(e.message);
        }
      }
    );

    this.server.registerTool(
      'get_honeybadger_project_integrations',
      {
        description: 'Get a list of integrations (channels) for a Honeybadger project',
        annotations: {
          title: 'Get Project Integrations',
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          project_id: z.number().min(1).optional().describe('Project ID (uses HONEYBADGER_PROJECT_ID if not provided)'),
        },
      },
      async ({ project_id }) => {
        try {
          const pid = this.resolveProjectId(project_id);
          const data = await this.makeHoneybadgerRequest(`/projects/${pid}/integrations`);
          return this.formatJsonResponse(data);
        } catch (e: any) {
          return this.toolError(e.message);
        }
      }
    );

    this.server.registerTool(
      'get_honeybadger_project_report',
      {
        description: 'Get report data for a Honeybadger project',
        annotations: {
          title: 'Get Project Report',
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          project_id: z.number().min(1).optional().describe('Project ID (uses HONEYBADGER_PROJECT_ID if not provided)'),
          report: z.enum(['notices_by_class', 'notices_by_location', 'notices_by_user', 'notices_per_day'])
            .describe('The type of report to get'),
          start: z.string().optional().describe('Start date/time in RFC3339 format for the beginning of the reporting period'),
          stop: z.string().optional().describe('Stop date/time in RFC3339 format for the end of the reporting period'),
          environment: z.string().optional().describe('Environment name to filter results'),
        },
      },
      async ({ project_id, report, start, stop, environment }) => {
        try {
          const pid = this.resolveProjectId(project_id);
          const params: any = {};
          if (start) params.start = this.parseTimestamp(start);
          if (stop) params.stop = this.parseTimestamp(stop);
          if (environment) params.environment = environment;
          const data = await this.makeHoneybadgerRequest(`/projects/${pid}/reports/${report}`, { params });
          return this.formatJsonResponse(data);
        } catch (e: any) {
          return this.toolError(e.message);
        }
      }
    );

    // ── Faults ────────────────────────────────────────────────────────────────

    this.server.registerTool(
      'list_honeybadger_faults',
      {
        description: 'Get a list of faults for a project with optional filtering and ordering',
        annotations: {
          title: 'List Faults',
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          project_id: z.number().min(1).optional().describe('Project ID (uses HONEYBADGER_PROJECT_ID if not provided)'),
          q: z.string().optional().describe('Search string to filter faults'),
          created_after: z.string().optional().describe('Filter faults created after this timestamp (RFC3339)'),
          occurred_after: z.string().optional().describe('Filter faults that occurred after this timestamp (RFC3339)'),
          occurred_before: z.string().optional().describe('Filter faults that occurred before this timestamp (RFC3339)'),
          limit: z.number().min(1).max(25).default(20).describe('Maximum number of faults to return (max 25)'),
          order: z.enum(['recent', 'frequent']).default('recent').describe('Order results by recent or frequent'),
          page: z.number().min(1).default(1).describe('Page number for pagination'),
        },
      },
      async ({ project_id, q, created_after, occurred_after, occurred_before, limit = 20, order = 'recent', page = 1 }) => {
        try {
          const pid = this.resolveProjectId(project_id);
          const params: any = { limit: Math.min(limit, 25), order, page };
          if (q) params.q = q;
          if (created_after) params.created_after = this.parseTimestamp(created_after);
          if (occurred_after) params.occurred_after = this.parseTimestamp(occurred_after);
          if (occurred_before) params.occurred_before = this.parseTimestamp(occurred_before);
          const data = await this.makeHoneybadgerRequest(`/projects/${pid}/faults`, { params });
          return this.formatListResponse(data.results || [], { total: data.total_count, page, per_page: limit });
        } catch (e: any) {
          return this.toolError(e.message);
        }
      }
    );

    this.server.registerTool(
      'get_honeybadger_fault',
      {
        description: 'Fetch a specific fault/error from Honeybadger by ID',
        annotations: {
          title: 'Get Fault',
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          fault_id: z.number().min(1).describe('The ID of the fault to fetch'),
          project_id: z.number().min(1).optional().describe('Project ID (uses HONEYBADGER_PROJECT_ID if not provided)'),
        },
      },
      async ({ fault_id, project_id }) => {
        try {
          const pid = this.resolveProjectId(project_id);
          const data = await this.makeHoneybadgerRequest(`/projects/${pid}/faults/${fault_id}`);
          return this.formatJsonResponse(data);
        } catch (e: any) {
          return this.toolError(e.message);
        }
      }
    );

    this.server.registerTool(
      'get_honeybadger_fault_counts',
      {
        description: 'Get fault count statistics for a project with optional filtering',
        annotations: {
          title: 'Get Fault Counts',
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          project_id: z.number().min(1).optional().describe('Project ID (uses HONEYBADGER_PROJECT_ID if not provided)'),
          q: z.string().optional().describe('Search string to filter faults'),
          created_after: z.string().optional().describe('Filter faults created after this timestamp (RFC3339)'),
          occurred_after: z.string().optional().describe('Filter faults that occurred after this timestamp (RFC3339)'),
          occurred_before: z.string().optional().describe('Filter faults that occurred before this timestamp (RFC3339)'),
        },
      },
      async ({ project_id, q, created_after, occurred_after, occurred_before }) => {
        try {
          const pid = this.resolveProjectId(project_id);
          const params: any = {};
          if (q) params.q = q;
          if (created_after) params.created_after = this.parseTimestamp(created_after);
          if (occurred_after) params.occurred_after = this.parseTimestamp(occurred_after);
          if (occurred_before) params.occurred_before = this.parseTimestamp(occurred_before);
          const data = await this.makeHoneybadgerRequest(`/projects/${pid}/faults/summary`, { params });
          return this.formatJsonResponse(data);
        } catch (e: any) {
          return this.toolError(e.message);
        }
      }
    );

    this.server.registerTool(
      'list_honeybadger_fault_notices',
      {
        description: 'Fetch notices (occurrences) for a specific fault',
        annotations: {
          title: 'List Fault Notices',
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          fault_id: z.number().min(1).describe('The ID of the fault to fetch notices for'),
          project_id: z.number().min(1).optional().describe('Project ID (uses HONEYBADGER_PROJECT_ID if not provided)'),
          limit: z.number().min(1).max(25).default(10).describe('Number of notices to fetch (max 25)'),
        },
      },
      async ({ fault_id, project_id, limit = 10 }) => {
        try {
          const pid = this.resolveProjectId(project_id);
          const data = await this.makeHoneybadgerRequest(
            `/projects/${pid}/faults/${fault_id}/notices`,
            { params: { limit: Math.min(limit, 25) } }
          );
          return this.formatListResponse(data.results || [], { total: data.total_count });
        } catch (e: any) {
          return this.toolError(e.message);
        }
      }
    );

    this.server.registerTool(
      'list_honeybadger_fault_affected_users',
      {
        description: 'Get a list of users who were affected by a specific fault with occurrence counts',
        annotations: {
          title: 'List Fault Affected Users',
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          project_id: z.number().min(1).optional().describe('Project ID (uses HONEYBADGER_PROJECT_ID if not provided)'),
          fault_id: z.number().min(1).describe('The fault ID'),
          q: z.string().optional().describe('Search string to filter affected users'),
        },
      },
      async ({ project_id, fault_id, q }) => {
        try {
          const pid = this.resolveProjectId(project_id);
          const params: any = {};
          if (q) params.q = q;
          const data = await this.makeHoneybadgerRequest(
            `/projects/${pid}/faults/${fault_id}/affected_users`,
            { params }
          );
          const items = Array.isArray(data) ? data : (data.results || []);
          return this.formatListResponse(items);
        } catch (e: any) {
          return this.toolError(e.message);
        }
      }
    );

    // ── Analytics ─────────────────────────────────────────────────────────────

    this.server.registerTool(
      'query_honeybadger_insights',
      {
        description: "Execute a BadgerQL query against Insights data. BadgerQL is Honeybadger's query language for error analytics.",
        annotations: {
          title: 'Query Insights (BadgerQL)',
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          project_id: z.number().min(1).optional().describe('Project ID (uses HONEYBADGER_PROJECT_ID if not provided)'),
          query: z.string().min(1).describe('BadgerQL query string (e.g., "SELECT class, COUNT(*) FROM notices GROUP BY class")'),
          ts: z.string().optional().describe('Time range - shortcuts like "today", "week", or ISO 8601 duration (e.g., "PT3H"). Defaults to PT3H.'),
          timezone: z.string().optional().describe('IANA timezone identifier (e.g., "America/New_York") for timestamp interpretation'),
        },
      },
      async ({ project_id, query, ts, timezone }) => {
        try {
          const pid = this.resolveProjectId(project_id);
          const data: any = { query };
          if (ts) data.ts = ts;
          if (timezone) data.timezone = timezone;
          const result = await this.makeHoneybadgerRequest(`/projects/${pid}/insights/query`, {
            method: 'POST',
            data,
          });
          return this.formatJsonResponse(result);
        } catch (e: any) {
          return this.toolError(e.message);
        }
      }
    );

    // ── AI-powered analysis ───────────────────────────────────────────────────

    this.server.registerTool(
      'analyze_honeybadger_issue',
      {
        description: 'Comprehensive AI-powered analysis of a Honeybadger issue with fix suggestions, trend data, and affected user impact',
        annotations: {
          title: 'Analyze Issue',
          readOnlyHint: true,
          destructiveHint: false,
        },
        inputSchema: {
          fault_id: z.number().min(1).describe('The ID of the fault to analyze'),
          project_id: z.number().min(1).optional().describe('Project ID (uses HONEYBADGER_PROJECT_ID if not provided)'),
          include_context: z.boolean().default(true).describe('Include request context and parameters in analysis'),
        },
      },
      async ({ fault_id, project_id, include_context = true }) => {
        try {
          const pid = this.resolveProjectId(project_id);

          const [fault, noticesData] = await Promise.all([
            this.makeHoneybadgerRequest(`/projects/${pid}/faults/${fault_id}`),
            this.makeHoneybadgerRequest(`/projects/${pid}/faults/${fault_id}/notices`, {
              params: { limit: 5 },
            }),
          ]);

          const notices: HoneybadgerNotice[] = noticesData.results || [];

          // Fetch trend and impact data in parallel (best-effort)
          const [countsData, affectedUsersData] = await Promise.all([
            this.makeHoneybadgerRequest(`/projects/${pid}/faults/counts`, {
              params: {
                occurred_after: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
              },
            }).catch(() => null),
            this.makeHoneybadgerRequest(`/projects/${pid}/faults/${fault_id}/affected_users`, {
              params: { limit: 10 },
            }).catch(() => null),
          ]);

          const analysis = this.generateAnalysis(
            fault,
            notices,
            include_context,
            countsData,
            affectedUsersData
          );

          return {
            content: [{ type: 'text' as const, text: analysis }],
          };
        } catch (e: any) {
          return this.toolError(e.message);
        }
      }
    );
  }

  private registerWriteTools() {
    this.server.registerTool(
      'create_honeybadger_project',
      {
        description: 'Create a new Honeybadger project. Requires HONEYBADGER_READ_ONLY=false.',
        annotations: {
          title: 'Create Project',
          readOnlyHint: false,
          destructiveHint: true,
        },
        inputSchema: {
          account_id: z.string().min(1).describe('The account ID to associate the project with (required)'),
          name: z.string().min(1).max(255).describe('Project name (required)'),
          resolve_errors_on_deploy: z.boolean().optional()
            .describe('Whether all unresolved faults should be marked as resolved when a deploy is recorded'),
          disable_public_links: z.boolean().optional()
            .describe('Whether to allow fault details to be publicly shareable via a button on the fault detail page'),
          user_url: z.string().optional()
            .describe('A URL format like "http://example.com/admin/users/[user_id]" that will be displayed on the fault detail page'),
          source_url: z.string().optional()
            .describe('A URL format like "https://gitlab.com/username/reponame/blob/[sha]/[file]#L[line]" that is used to link lines in the backtrace to your git browser'),
          purge_days: z.number().min(1).optional()
            .describe('The number of days to retain data (up to the max number of days available to your subscription plan)'),
          user_search_field: z.string().optional()
            .describe('A field such as "context.user_email" that you provide in your error context'),
        },
      },
      async ({ account_id, name, resolve_errors_on_deploy, disable_public_links, user_url, source_url, purge_days, user_search_field }) => {
        try {
          const data: any = { name };
          if (resolve_errors_on_deploy !== undefined) data.resolve_errors_on_deploy = resolve_errors_on_deploy;
          if (disable_public_links !== undefined) data.disable_public_links = disable_public_links;
          if (user_url) data.user_url = user_url;
          if (source_url) data.source_url = source_url;
          if (purge_days) data.purge_days = purge_days;
          if (user_search_field) data.user_search_field = user_search_field;
          const result = await this.makeHoneybadgerRequest(`/projects`, {
            method: 'POST',
            params: account_id ? { account_id } : undefined,
            data,
          });
          return this.formatWriteResponse(result, 'created project');
        } catch (e: any) {
          return this.toolError(e.message);
        }
      }
    );

    this.server.registerTool(
      'update_honeybadger_project',
      {
        description: 'Update an existing Honeybadger project. Requires HONEYBADGER_READ_ONLY=false.',
        annotations: {
          title: 'Update Project',
          readOnlyHint: false,
          destructiveHint: true,
        },
        inputSchema: {
          id: z.number().min(1).describe('The project ID to update'),
          name: z.string().min(1).max(255).optional().describe('New project name'),
          resolve_errors_on_deploy: z.boolean().optional()
            .describe('Whether all unresolved faults should be marked as resolved when a deploy is recorded'),
          disable_public_links: z.boolean().optional()
            .describe('Whether to allow fault details to be publicly shareable via a button on the fault detail page'),
          user_url: z.string().optional()
            .describe('A URL format like "http://example.com/admin/users/[user_id]"'),
          source_url: z.string().optional()
            .describe('Git browser URL format'),
          purge_days: z.number().min(1).optional()
            .describe('The number of days to retain data'),
          user_search_field: z.string().optional()
            .describe('Field for user search (e.g., "context.user_email")'),
        },
      },
      async ({ id, name, resolve_errors_on_deploy, disable_public_links, user_url, source_url, purge_days, user_search_field }) => {
        try {
          const data: any = {};
          if (name) data.name = name;
          if (resolve_errors_on_deploy !== undefined) data.resolve_errors_on_deploy = resolve_errors_on_deploy;
          if (disable_public_links !== undefined) data.disable_public_links = disable_public_links;
          if (user_url !== undefined) data.user_url = user_url;
          if (source_url !== undefined) data.source_url = source_url;
          if (purge_days !== undefined) data.purge_days = purge_days;
          if (user_search_field !== undefined) data.user_search_field = user_search_field;
          const result = await this.makeHoneybadgerRequest(`/projects/${id}`, { method: 'PUT', data });
          return this.formatWriteResponse(result, 'updated project');
        } catch (e: any) {
          return this.toolError(e.message);
        }
      }
    );

    this.server.registerTool(
      'delete_honeybadger_project',
      {
        description: 'Delete a Honeybadger project permanently. DANGEROUS - requires explicit confirmation.',
        annotations: {
          title: 'Delete Project',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
        },
        inputSchema: {
          id: z.number().min(1).describe('The project ID to delete'),
          confirm: z.boolean().describe('Must be explicitly set to true to confirm deletion'),
        },
      },
      async ({ id, confirm }) => {
        if (!confirm) {
          return this.toolError('Deletion requires explicit confirmation (set confirm: true)');
        }
        try {
          await this.makeHoneybadgerRequest(`/projects/${id}`, { method: 'DELETE' });
          return this.formatWriteResponse({ id }, 'deleted project');
        } catch (e: any) {
          return this.toolError(e.message);
        }
      }
    );
  }

  // ── Analysis generator ───────────────────────────────────────────────────────

  private generateAnalysis(
    fault: HoneybadgerFault,
    notices: HoneybadgerNotice[],
    includeContext: boolean,
    countsData: any,
    affectedUsersData: any
  ): string {
    const latestNotice = notices[0];

    let analysis = `# Honeybadger Issue Analysis

## Fault Overview
- **ID**: ${fault.id}
- **Error Class**: ${fault.klass}
- **Message**: ${fault.message}
- **Environment**: ${fault.environment}
- **Occurrences**: ${fault.notices_count}
- **First Seen**: ${fault.created_at}
- **Last Seen**: ${fault.last_notice_at}
- **Status**: ${fault.resolved ? 'Resolved' : 'Unresolved'}
- **URL**: ${fault.url}

## Error Analysis

### Error Type
The error "${fault.klass}" suggests:`;

    if (fault.klass.includes('NoMethodError')) {
      analysis += `
- A method is being called on an object that doesn't respond to it
- Possible nil object or wrong object type
- Missing method definition or typo in method name`;
    } else if (fault.klass.includes('NameError')) {
      analysis += `
- Undefined variable or constant
- Typo in variable/constant name
- Scope issues`;
    } else if (fault.klass.includes('ArgumentError')) {
      analysis += `
- Wrong number of arguments passed to a method
- Invalid argument values
- Method signature mismatch`;
    } else if (fault.klass.includes('ActiveRecord')) {
      analysis += `
- Database-related error
- Possible migration issues
- Invalid queries or constraints`;
    } else {
      analysis += `
- Review the specific error class documentation
- Check for common patterns in this error type`;
    }

    if (latestNotice) {
      analysis += `

### Stack Trace Analysis
`;
      const backtrace = latestNotice.backtrace?.slice(0, 10) || [];
      backtrace.forEach((frame, index) => {
        if (index === 0) {
          analysis += `
**Primary Error Location:**
- File: \`${frame.file}\`
- Method: \`${frame.method}\`
- Line: ${frame.number}`;

          if (frame.source) {
            analysis += `
- Context:
\`\`\`
${Object.entries(frame.source).map(([line, code]) => `${line}: ${code}`).join('\n')}
\`\`\``;
          }
        } else if (index < 5) {
          analysis += `
- ${frame.file}:${frame.number} in \`${frame.method}\``;
        }
      });

      if (includeContext && latestNotice.context) {
        analysis += `

### Request Context
\`\`\`json
${JSON.stringify(latestNotice.context, null, 2)}
\`\`\``;
      }

      if (includeContext && latestNotice.params && Object.keys(latestNotice.params).length > 0) {
        analysis += `

### Request Parameters
\`\`\`json
${JSON.stringify(latestNotice.params, null, 2)}
\`\`\``;
      }
    }

    // Trend data (from fault counts, last 30 days)
    if (countsData) {
      analysis += `

## Trend Analysis (Last 30 Days)
- Total fault count data: ${JSON.stringify(countsData)}`;
    }

    // User impact data
    const affectedUsers = Array.isArray(affectedUsersData)
      ? affectedUsersData
      : (affectedUsersData?.results || []);
    if (affectedUsers.length > 0) {
      analysis += `

## Impact Assessment
- Unique users affected: ${affectedUsersData?.total_count || affectedUsers.length}
- Top affected users:
${affectedUsers.slice(0, 5).map((u: any) => `  - ${u.user}: ${u.count} occurrences`).join('\n')}`;
    }

    analysis += `

## Recommended Fix Strategies

### Immediate Actions
1. **Reproduce the Error**
   - Use the provided context and parameters
   - Set up similar conditions in development
   - Add logging around the error location

2. **Quick Fixes**`;

    if (fault.klass.includes('NoMethodError')) {
      analysis += `
   - Add nil checks: \`object&.method_name\`
   - Verify object type before method calls
   - Check method spelling and availability`;
    } else if (fault.klass.includes('ArgumentError')) {
      analysis += `
   - Review method signatures
   - Validate input parameters
   - Add parameter validation`;
    } else if (fault.klass.includes('ActiveRecord')) {
      analysis += `
   - Check database migrations
   - Validate model associations
   - Review query syntax`;
    }

    analysis += `

### Long-term Solutions
1. **Add Error Handling**
   - Implement proper exception handling
   - Add user-friendly error messages
   - Log detailed error information

2. **Add Tests**
   - Write unit tests covering the error scenario
   - Add integration tests for the affected flow
   - Include edge case testing

3. **Code Review**
   - Review similar patterns in codebase
   - Look for related potential issues
   - Implement defensive programming practices

### Monitoring
- Set up alerts for this error pattern
- Monitor error frequency after fixes
- Track related errors that might emerge

## Next Steps
1. Examine the code at the primary error location
2. Set up local reproduction using the provided context
3. Implement the recommended fixes
4. Add appropriate tests
5. Deploy and monitor the fix effectiveness

---
*Analysis generated from Honeybadger fault #${fault.id}*`;

    return analysis;
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Honeybadger MCP server running on stdio');
  }
}

const server = new HoneybadgerMCPServer();
server.run().catch(console.error);
