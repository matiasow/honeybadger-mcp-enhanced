# Honeybadger MCP Server Enhanced

Enhanced MCP server for Honeybadger error tracking with 15 tools and full API parity. Access and analyze your errors directly from Claude Code, Cursor, or any MCP-compatible client.

> **Based on** [vishalzambre/honeybadger-mcp](https://github.com/vishalzambre/honeybadger-mcp) — this project is a fork that extends the original with additional tools, full API parity, read-only mode, and structured error handling.

## Prerequisites

- Node.js 18+
- Honeybadger account with API access

## Installation

**Via Claude Code CLI (recommended):**

```bash
claude mcp add honeybadger \
  -e HONEYBADGER_API_KEY=your_token \
  -e HONEYBADGER_PROJECT_ID=12345 \
  -- npx -y honeybadger-mcp-enhanced
```

**Global install:**

```bash
npm install -g honeybadger-mcp-enhanced
```

**From source:**

```bash
git clone git@github.com:matiasow/honeybadger-mcp.git
cd honeybadger-mcp
npm install && npm run build
```

## Configuration

For other MCP clients (e.g. Cursor), add to `~/.cursor/mcp_servers.json`:

```json
{
  "mcpServers": {
    "honeybadger": {
      "command": "honeybadger-mcp-enhanced",
      "env": {
        "HONEYBADGER_API_KEY": "your_personal_auth_token",
        "HONEYBADGER_PROJECT_ID": "12345"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HONEYBADGER_API_KEY` | **Yes** | — | Personal auth token from https://app.honeybadger.io/users/auth_tokens |
| `HONEYBADGER_PROJECT_ID` | No | — | Default project ID (can be overridden per tool call) |
| `HONEYBADGER_READ_ONLY` | No | `true` | Set to `"false"` to enable write operations |
| `HONEYBADGER_BASE_URL` | No | `https://app.honeybadger.io` | Override for self-hosted instances |

> **Important:** The server runs in **read-only mode by default**. Write tools (`create_honeybadger_project`, `update_honeybadger_project`, `delete_honeybadger_project`) are hidden unless `HONEYBADGER_READ_ONLY=false` is explicitly set.

### Getting Your API Key

1. Go to https://app.honeybadger.io/users/auth_tokens
2. Create a Personal Auth Token
3. Use it as `HONEYBADGER_API_KEY`

### Finding Your Project ID

The project ID is in the URL when viewing a project: `https://app.honeybadger.io/projects/{PROJECT_ID}`

## Available Tools

### Projects

#### `list_honeybadger_projects`
List all projects you have access to.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account_id` | string | No | Filter by account ID |
| `page` | number | No | Page number (default: 1) |
| `per_page` | number | No | Results per page, max 100 (default: 20) |

#### `get_honeybadger_project`
Get detailed information about a specific project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | **Yes** | Project ID |

#### `get_honeybadger_project_occurrence_counts`
Get occurrence counts over time for a project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | number | No | Project ID (uses `HONEYBADGER_PROJECT_ID` if omitted) |
| `period` | string | No | `hour`, `day`, `week`, or `month` (default: `hour`) |
| `environment` | string | No | Filter by environment |

#### `get_honeybadger_project_integrations`
List configured integrations (Slack, PagerDuty, etc.) for a project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | number | No | Project ID |

#### `get_honeybadger_project_report`
Get structured report data for a project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | number | No | Project ID |
| `report` | string | **Yes** | `notices_by_class`, `notices_by_location`, `notices_by_user`, or `notices_per_day` |
| `start` | string | No | Start timestamp (RFC3339) |
| `stop` | string | No | Stop timestamp (RFC3339) |
| `environment` | string | No | Filter by environment |

#### `create_honeybadger_project` ⚠️ Write
Create a new project. Requires `HONEYBADGER_READ_ONLY=false`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account_id` | string | **Yes** | Account to create the project in |
| `name` | string | **Yes** | Project name |
| `resolve_errors_on_deploy` | boolean | No | Auto-resolve faults on deploy |
| `disable_public_links` | boolean | No | Disable public fault sharing links |
| `user_url` | string | No | URL pattern for user admin pages |
| `source_url` | string | No | URL pattern linking backtraces to your git browser |
| `purge_days` | number | No | Data retention in days |
| `user_search_field` | string | No | Context field for user lookup (e.g. `context.user_email`) |

#### `update_honeybadger_project` ⚠️ Write
Update an existing project. Requires `HONEYBADGER_READ_ONLY=false`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | **Yes** | Project ID |
| `name` | string | No | New name |
| `resolve_errors_on_deploy` | boolean | No | Auto-resolve faults on deploy |
| `disable_public_links` | boolean | No | Disable public fault sharing links |
| `user_url` | string | No | URL pattern for user admin pages |
| `source_url` | string | No | URL pattern linking backtraces to your git browser |
| `purge_days` | number | No | Data retention in days |
| `user_search_field` | string | No | Context field for user lookup |

#### `delete_honeybadger_project` ⚠️ Write — Destructive
Permanently delete a project. Requires `HONEYBADGER_READ_ONLY=false`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | number | **Yes** | Project ID |
| `confirm` | boolean | **Yes** | Must be `true` to confirm deletion |

---

### Faults

#### `list_honeybadger_faults`
List faults for a project with filtering and ordering.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | number | No | Project ID |
| `q` | string | No | Search query |
| `order` | string | No | `recent` or `frequent` (default: `recent`) |
| `limit` | number | No | Max results, up to 25 (default: 20) |
| `page` | number | No | Page number |
| `created_after` | string | No | Filter faults created after this timestamp (RFC3339) |
| `occurred_after` | string | No | Filter faults that occurred after this timestamp (RFC3339) |
| `occurred_before` | string | No | Filter faults that occurred before this timestamp (RFC3339) |

#### `get_honeybadger_fault`
Get detailed information about a specific fault.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fault_id` | number | **Yes** | Fault ID |
| `project_id` | number | No | Project ID |

#### `get_honeybadger_fault_counts`
Get fault count statistics with optional filtering.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | number | No | Project ID |
| `q` | string | No | Search query |
| `created_after` | string | No | RFC3339 timestamp |
| `occurred_after` | string | No | RFC3339 timestamp |
| `occurred_before` | string | No | RFC3339 timestamp |

#### `list_honeybadger_fault_notices`
List individual error occurrences (notices) for a fault.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fault_id` | number | **Yes** | Fault ID |
| `project_id` | number | No | Project ID |
| `limit` | number | No | Max results, up to 25 (default: 10) |

#### `list_honeybadger_fault_affected_users`
List users who were affected by a fault.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fault_id` | number | **Yes** | Fault ID |
| `project_id` | number | No | Project ID |
| `q` | string | No | Search query |

---

### Analytics

#### `query_honeybadger_insights`
Execute a BadgerQL query against Insights data.

> **Note:** BadgerQL/Insights is a premium Honeybadger feature. This tool returns a `Not found` error if your plan does not include it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | number | No | Project ID |
| `query` | string | **Yes** | BadgerQL query string |
| `ts` | string | No | Time range: `today`, `week`, or ISO 8601 duration like `PT3H` (default: `PT3H`) |
| `timezone` | string | No | IANA timezone, e.g. `America/New_York` |

#### `analyze_honeybadger_issue`
Comprehensive AI-powered analysis of an error with stack trace review, fix suggestions, trend data, and affected user impact.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fault_id` | number | **Yes** | Fault ID |
| `project_id` | number | No | Project ID |
| `include_context` | boolean | No | Include request context in analysis (default: true) |

---

## Usage Examples

### Investigating a production incident

```
Show me the most frequent unresolved errors from the last 24 hours
→ list_honeybadger_faults (order: frequent, occurred_after: ...)

Analyze fault 127320184 in detail
→ analyze_honeybadger_issue (fault_id: 127320184)

Which users were affected?
→ list_honeybadger_fault_affected_users (fault_id: 127320184)
```

### Project discovery

```
List all my Honeybadger projects
→ list_honeybadger_projects

What integrations are configured for project 41227?
→ get_honeybadger_project_integrations (project_id: 41227)

Show me a report of errors by class for the last week
→ get_honeybadger_project_report (report: notices_by_class, start: ..., stop: ...)
```

### Custom analytics with BadgerQL

```
Top 10 error classes by count over the last week
→ query_honeybadger_insights (query: "SELECT class, COUNT(*) as count FROM notices GROUP BY class ORDER BY count DESC LIMIT 10", ts: "week")
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Authentication failed` | Verify `HONEYBADGER_API_KEY` is a valid Personal Auth Token |
| `Not found` | Check project and fault IDs are correct integers |
| Write tools not appearing | Set `HONEYBADGER_READ_ONLY=false` in your MCP config |
| `Rate limit exceeded` | Wait a moment and retry |

**Run the server directly to see output:**
```bash
HONEYBADGER_API_KEY=your_key node dist/index.js
```

**Check MCP client logs:**
- macOS Cursor: `~/Library/Logs/Cursor/`
- Claude Code: check terminal output

## Security

- Never commit your API key to version control
- The server runs read-only by default — write operations require explicit opt-in
- Use environment-specific API keys where possible

## Contributing

1. Add new tools in `registerReadTools()` or `registerWriteTools()` in `src/index.ts`
2. Use `z.number()` for all ID parameters, `z.string()` only for `account_id`
3. Wrap every handler in `try/catch` returning `this.toolError(e.message)` on failure
4. Add `annotations: { title, readOnlyHint, destructiveHint }` to every tool
5. Run `npm run build` to verify no TypeScript errors

## Support

- **Honeybadger API docs**: https://docs.honeybadger.io/api/
- **MCP protocol**: https://modelcontextprotocol.io
