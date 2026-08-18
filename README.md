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
      review_models: 'deepseek/deepseek-v4-pro,xiaomi/mimo-v2.5-pro,deepseek/deepseek-v4-flash'
      validator_model: 'deepseek/deepseek-v4-pro'
      thinking: 'high'
      severity_threshold: 'important'
      max_cost_usd: '0.25'
      cost_rates: 'xiaomi/mimo-v2.5-pro=0.435:0.87,deepseek/deepseek-v4-flash=0.14:0.28'
```

**Inputs:**

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `review_strategy` | string | `council` | Review strategy: `council` (4 lenses + validator), `crosscheck`, or `solo`. |
| `review_models` | string | `deepseek/deepseek-v4-pro,xiaomi/mimo-v2.5-pro,deepseek/deepseek-v4-flash` | Comma-separated OpenRouter model IDs round-robined across the 4 lenses. |
| `validator_model` | string | `deepseek/deepseek-v4-pro` | Model that synthesizes lens findings and posts the single deduplicated review. |
| `thinking` | string | `high` | Reasoning effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `max_turns` | number | `30` | Max conversation turns per reviewer. Raised from `20` on 2026-08-16: the `tests` lane was flaking against the ceiling rather than the diff, failing twice at 20 and then passing at 18 on a near-identical diff. |
| `severity_threshold` | string | `important` | Minimum severity to post (`info`, `important`, `critical`). |
| `max_cost_usd` | string | `1.00` | Per-PR cost guardrail; elek auto-downgrades council → crosscheck → solo on large diffs to stay within budget. |
| `cost_rates` | string | `xiaomi/mimo-v2.5-pro=0.435:0.87,deepseek/deepseek-v4-flash=0.14:0.28` | `model=input:output` USD-per-million-token overrides for models without built-in OpenRouter pricing. DeepSeek uses OpenRouter's built-in rates. |
| `mode` | string | `review` | `review` (read-only) or `review+edit` (pushes fixes). |
| `model` | string | `deepseek/deepseek-v4-pro` | Single-model override for `solo` strategy; ignored under `council`. |
| `trigger_phrase` | string | `@ai-review` | Comment phrase that triggers an on-demand review. |
| `scope_paths` | string | (unset) | Comma-separated globs limiting which changed files are in scope. Evaluated **inside** this workflow, so an out-of-scope PR reports a green `NOT_REVIEWED` rather than no check run at all. Prefer this over a `paths:` filter on the caller — see the note below the table. |
| `actor_filter` | string | (unset) | Allowlist of **human** actors. **Authoritative and exclusive when set**: `isActorAuthorized` returns the list result and never consults repo permissions, so anyone absent is denied. When unset, falls back to `OWNER`/`MEMBER`/`COLLABORATOR` and then a repo-permission lookup. |
| `allowed_bots` | string | (unset) | Allowlist of bot actors (`*` permits all). Without it, a bot-authored PR cannot be reviewed at all. ⚠ Setting `allowed_bots` **without** `actor_filter` on a post-v1.1.4 pin flips the actor gate to strict-deny for humans — see the caution below. |
| `job_timeout_minutes` | number | `30` | Wall-clock ceiling for the WHOLE review job — the council plus the validator, not one model run. The real bound is serial: `setup + reviewer_cap + validator_cap`, because lenses run in parallel but the validator runs after them. A job killed by this cap loses the coverage record entirely, so raise it **before** raising `run_timeout_seconds`, never after. |
| `run_timeout_seconds` | string | `600` | Per-run budget for the elek step. Cannot exceed the job's own cap. |
| `stall_timeout_seconds` | string | `0` | **Stream-idle watchdog**, passed to elek. Terminates a model run that emits no pi stream event for this long and reports failure class `stall` — which `run_timeout_seconds` alone cannot distinguish from genuinely slow work. `0` disables it. Do not set it from intuition: calibrate from `maxIdleSecondsObserved` on your own successful runs, then use ≥3× the p99 idle gap, well under `run_timeout_seconds`. |
| `max_degraded_lenses` | string | `1` | How many **reviewer** lenses may fail while the review still counts. Passed to elek *and* to the coverage gate, which evaluate it independently and fail closed on drift. Never tolerated at any value: a failed validator/validator-review run, a wiped reviewer panel, an unclassifiable failed run, or a value not below the reviewer count. A degraded council passes with a warning naming every dropped lens. Invalid values resolve to `0` (strict). |
| `disable_mcp` | string | `0` | `1` disables MCP, which also disables inline PR comments. |
| `max_council_changed_lines` | string | `0` | **RETIRED 2026-08-15 — accepted but no longer forwarded.** The pinned elek no longer declares this input, so passing it produced a permanent yellow "unexpected input" annotation. Kept only so existing callers do not break; setting it has no effect. |
| `prompt` | string | `Please review this PR for correctness, security, and potential issues.` | The review instruction, so a repo can shape its own review. Only honoured on `pull_request` events — a caller cannot inject a prompt on an on-demand run. |
| `pr_number` | number | (unset) | Target PR for on-demand runs, where the event carries no PR context. |

> **`workflow_dispatch` is not a review path.** elek rejects the event outright
> (`Unsupported event: workflow_dispatch`) before any model call, so a dispatch cannot be used to
> green-prove a change. Use `@ai-review` on a live PR, or close/reopen to force a genuine run.

> **Do not add a `paths:` filter to a caller whose check is a required status context.** A
> paths-filtered workflow never dispatches on an out-of-scope PR, so no check run is created and the
> required context stays pending forever. Use `scope_paths` instead: it turns "out of scope" from an
> absent check into a green `NOT_REVIEWED` one, and still skips the model call.

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
