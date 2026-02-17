#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import axios from 'axios';
import { z } from 'zod';

interface HoneybadgerConfig {
  apiKey: string;
  projectId?: string;
  baseUrl?: string;
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
    this.server = new McpServer(
      {
        name: 'honeybadger-mcp',
        version: '0.2.1',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Get configuration from environment variables
    this.config = {
      apiKey: process.env.HONEYBADGER_API_KEY || '',
      projectId: process.env.HONEYBADGER_PROJECT_ID,
      baseUrl: process.env.HONEYBADGER_BASE_URL || 'https://app.honeybadger.io',
    };

    this.setupTools();
  }

  private setupTools() {
    // Register get_honeybadger_fault tool
    // @ts-expect-error - TypeScript has issues with deep type instantiation in MCP SDK
    this.server.registerTool(
      'get_honeybadger_fault',
      {
        description: 'Fetch a specific fault/error from Honeybadger by ID',
        inputSchema: {
          fault_id: z.string().describe('The ID of the fault to fetch'),
          project_id: z.string().optional().describe('Optional project ID (uses env var if not provided)'),
        },
      },
      async ({ fault_id, project_id }) => {
        const pid = project_id || this.config.projectId;
        if (!pid) {
          throw new Error('Project ID is required');
        }

        const data = await this.makeHoneybadgerRequest(`/projects/${pid}/faults/${fault_id}`);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }
    );

    // Register get_honeybadger_notices tool
    this.server.registerTool(
      'get_honeybadger_notices',
      {
        description: 'Fetch notices (occurrences) for a specific fault',
        inputSchema: {
          fault_id: z.string().describe('The ID of the fault to fetch notices for'),
          project_id: z.string().optional().describe('Optional project ID (uses env var if not provided)'),
          limit: z.number().default(10).describe('Number of notices to fetch (default: 10, max: 100)'),
        },
      },
      async ({ fault_id, project_id, limit = 10 }) => {
        const pid = project_id || this.config.projectId;
        if (!pid) {
          throw new Error('Project ID is required');
        }

        const data = await this.makeHoneybadgerRequest(`/projects/${pid}/faults/${fault_id}/notices`, {
          limit: Math.min(limit, 100),
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }
    );

    // Register list_honeybadger_faults tool
    this.server.registerTool(
      'list_honeybadger_faults',
      {
        description: 'List recent faults from Honeybadger',
        inputSchema: {
          project_id: z.string().optional().describe('Optional project ID (uses env var if not provided)'),
          limit: z.number().default(20).describe('Number of faults to fetch (default: 20, max: 100)'),
          environment: z.string().optional().describe('Filter by environment (e.g., production, staging)'),
          resolved: z.boolean().optional().describe('Filter by resolved status'),
        },
      },
      async ({ project_id, limit = 20, environment, resolved }) => {
        const pid = project_id || this.config.projectId;
        if (!pid) {
          throw new Error('Project ID is required');
        }

        const params: any = {
          limit: Math.min(limit, 100),
        };

        if (environment) params.environment = environment;
        if (typeof resolved === 'boolean') params.resolved = resolved;

        const data = await this.makeHoneybadgerRequest(`/projects/${pid}/faults`, params);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }
    );

    // Register analyze_honeybadger_issue tool
    this.server.registerTool(
      'analyze_honeybadger_issue',
      {
        description: 'Comprehensive analysis of a Honeybadger issue with fix suggestions',
        inputSchema: {
          fault_id: z.string().describe('The ID of the fault to analyze'),
          project_id: z.string().optional().describe('Optional project ID (uses env var if not provided)'),
          include_context: z.boolean().default(true).describe('Include request context and parameters in analysis'),
        },
      },
      async ({ fault_id, project_id, include_context = true }) => {
        const pid = project_id || this.config.projectId;
        if (!pid) {
          throw new Error('Project ID is required');
        }

        // Fetch fault details
        const fault = await this.makeHoneybadgerRequest(`/projects/${pid}/faults/${fault_id}`);

        // Fetch recent notices
        const notices = await this.makeHoneybadgerRequest(`/projects/${pid}/faults/${fault_id}/notices`, {
          limit: 5,
        });

        // Create comprehensive analysis
        const analysis = this.generateAnalysis(fault, notices.results || [], include_context);

        return {
          content: [
            {
              type: 'text',
              text: analysis,
            },
          ],
        };
      }
    );
  }

  private async makeHoneybadgerRequest(endpoint: string, params: any = {}) {
    if (!this.config.apiKey) {
      throw new Error('HONEYBADGER_API_KEY environment variable is required');
    }

    const username = this.config.apiKey;
    const password = '';
    const url = `${this.config.baseUrl}/v2${endpoint}`;
    const credentials = Buffer.from(`${username}:${password}`).toString('base64');

    try {
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Accept': 'application/json',
        },
        params,
      });

      return response.data;
    } catch (error: any) {
      if (error.response) {
        throw new Error(
          `Honeybadger API error: ${error.response.status} - ${error.response.data?.error || error.response.statusText}`
        );
      }
      throw new Error(`Network error: ${error.message}`);
    }
  }

  private generateAnalysis(fault: HoneybadgerFault, notices: HoneybadgerNotice[], includeContext: boolean): string {
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

    // Add error type analysis
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

      // Analyze backtrace
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

    analysis += `

## Recommended Fix Strategies

### Immediate Actions
1. **Reproduce the Error**
   - Use the provided context and parameters
   - Set up similar conditions in development
   - Add logging around the error location

2. **Quick Fixes**`;

    // Add specific fix suggestions based on error type
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
