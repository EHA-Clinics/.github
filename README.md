# EHA Clinics - Organization Defaults

This repository contains organization-wide defaults and reusable workflows for the EHA-Clinics GitHub organization.

## Reusable Workflows

### `ai-code-review.yml`

AI code review workflow powered by [elek](https://github.com/selimozten/elek)'s **council strategy** over **OpenRouter direct**.

A council run has two phases:

1. **4 read-only lens reviewers** — Risk, Design, Tests, and Operations — run in parallel with no MCP access. Each lens is round-robined onto a model (Risk → DeepSeek V4-Pro, Design → MiMo V2.5-Pro, Tests → GLM 5.1, Operations → DeepSeek V4-Pro), giving 3-lab model diversity.
2. **A single GLM 5.1 validator/synthesizer** treats every lens finding as a hypothesis, drops speculative/cosmetic/duplicate/stale items, requires severity + confidence + evidence + impact + fix, and posts **one** deduplicated tracking comment plus inline comments on changed lines.

The engine talks to models through **OpenRouter direct** (`provider: openrouter`), not the Databricks AI Gateway. OpenRouter is elek's tested path for tool-enabled reasoning models.

**Usage:**

```yaml
jobs:
  review:
    uses: EHA-Clinics/.github/.github/workflows/ai-code-review.yml@<SHA-PIN>
    secrets:
      OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
    with:
      review_strategy: 'council'
      review_models: 'deepseek/deepseek-v4-pro,xiaomi/mimo-v2.5-pro,openrouter/z-ai/glm-5.1'
      validator_model: 'openrouter/z-ai/glm-5.1'
      thinking: 'high'
      severity_threshold: 'important'
      max_cost_usd: '0.25'
      cost_rates: 'openrouter/z-ai/glm-5.1=0.98:3.08,xiaomi/mimo-v2.5-pro=0.435:0.87'
```

**Inputs:**

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `review_strategy` | string | `council` | Review strategy: `council` (4 lenses + validator), `crosscheck`, or `solo`. |
| `review_models` | string | `deepseek/deepseek-v4-pro,xiaomi/mimo-v2.5-pro,openrouter/z-ai/glm-5.1` | Comma-separated OpenRouter model IDs round-robined across the 4 lenses. |
| `validator_model` | string | `openrouter/z-ai/glm-5.1` | Model that synthesizes lens findings and posts the single deduplicated review. |
| `thinking` | string | `high` | Reasoning effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `max_turns` | number | `20` | Max conversation turns per reviewer. |
| `severity_threshold` | string | `important` | Minimum severity to post (`info`, `important`, `critical`). |
| `max_cost_usd` | string | `0.25` | Per-PR cost guardrail; elek auto-downgrades council → crosscheck → solo on large diffs to stay within budget. |
| `cost_rates` | string | `openrouter/z-ai/glm-5.1=0.98:3.08,xiaomi/mimo-v2.5-pro=0.435:0.87` | `model=input:output` USD-per-million-token overrides for models without built-in OpenRouter pricing. DeepSeek uses OpenRouter's built-in rates. |
| `mode` | string | `review` | `review` (read-only) or `review+edit` (pushes fixes). |
| `model` | string | (unset) | Single-model override for `solo` strategy; ignored under `council`. |
| `trigger_phrase` | string | `@ai-review` | Comment phrase that triggers an on-demand review. |

**Secrets:**

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key. Set once as an org-level secret to cover all repos. |

## Adopting in a New Repo

1. **Set the secret.** Add `OPENROUTER_API_KEY` as an org-level GitHub Actions secret (Settings → Secrets and variables → Actions → New organization secret), scoped to all repos, or as a repo-level secret.
2. **Add a caller workflow.** Create `.github/workflows/ai-code-review.yml` in your repo with a single `review` job that references the shared workflow at a full commit SHA pin (`@<SHA-PIN>`) and passes the council `with:` inputs above.
3. **(Optional) Add `.elek.yml`.** Drop a repo-local `.elek.yml` to set `knowledge_paths`, `ignore_paths`, and `instructions` so the council reads your standards and skips generated/fixture files.
4. **Open a test PR.** Open a small PR and confirm the council posts one tracking comment with the four lenses running in parallel before finalizing the SHA pin org-wide.

## Cost

A council run costs roughly **~$0.15–0.20/PR** (up from ~$0.04 for the old dual-solo setup). The `max_cost_usd` guardrail auto-downgrades the strategy on large diffs to keep cost bounded.

## Security

- All actions are pinned to full commit SHAs.
- Workflows run with least privilege: `contents: read`, `pull-requests: write` only.
- The AI reviewer cannot approve, merge, or close PRs (structural guarantee via the MCP server).
- Only the secret **name** `OPENROUTER_API_KEY` is referenced here; no secret value ever appears in a workflow or this README.

## See Also

- [EHA Care Monorepo](https://github.com/EHA-Clinics/eha_care)
- [EHA Care Infra](https://github.com/EHA-Clinics/eha-care-infra)
