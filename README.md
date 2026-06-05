# EHA Clinics - Organization Defaults

This repository contains organization-wide defaults and reusable workflows for the EHA-Clinics GitHub organization.

## Reusable Workflows

### `ai-code-review.yml`

Model-agnostic AI code review workflow using Databricks AI Gateway. Supports DeepSeek V4-Pro and MIMO V2.5-Pro via OpenRouter endpoints.

**Usage:**

```yaml
jobs:
  review:
    uses: EHA-Clinics/.github/.github/workflows/ai-code-review.yml@<SHA-PIN>
    secrets:
      DATABRICKS_TOKEN: ${{ secrets.DATABRICKS_TOKEN }}
      DATABRICKS_WORKSPACE_URL: ${{ secrets.DATABRICKS_WORKSPACE_URL }}
    with:
      model: 'canonical-openrouter-deepseek-v4pro'
```

**Inputs:**

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | `canonical-openrouter-deepseek-v4pro` | Databricks serving endpoint name |
| `thinking` | string | `high` | Reasoning effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `max_turns` | number | `20` | Max conversation turns |
| `exclude_patterns` | string | `pnpm-lock.yaml,package-lock.json,*.lock,dist/,node_modules/` | Comma-separated exclude patterns |
| `include_patterns` | string | (empty) | Comma-separated include patterns |
| `mode` | string | `review` | `review` (read-only) or `review+edit` (pushes fixes) |

**Secrets:**

| Secret | Required | Description |
|--------|----------|-------------|
| `DATABRICKS_TOKEN` | Yes | Databricks personal access token |
| `DATABRICKS_WORKSPACE_URL` | Yes | Databricks workspace URL (e.g., `https://dbc-xxx.cloud.databricks.com`) |

## Security

- All actions are pinned to full commit SHAs.
- Workflows run with least privilege: `contents: read`, `pull-requests: write` only.
- The AI reviewer cannot approve, merge, or close PRs (structural guarantee via MCP server).

## See Also

- [EHA Care Monorepo](https://github.com/EHA-Clinics/eha_care)
- [EHA Care Infra](https://github.com/EHA-Clinics/eha-care-infra)
