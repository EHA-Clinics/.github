# EHA Clinics - Organization Defaults

This repository contains organization-wide defaults and reusable workflows for the EHA-Clinics GitHub organization.

## Reusable Workflows

### `ai-code-review.yml`

AI code review workflow powered by the [EHA-maintained Elek fork](https://github.com/EHA-Clinics/elek)'s **council strategy** over **OpenRouter direct**.

The review and its coverage result are permanently advisory. They provide evidence and feedback,
but are not branch-protection requirements and must not block a merge solely because a provider is
unavailable.

A council run has two phases:

1. **4 read-only lens reviewers** — Risk, Design, Tests, and Operations — run in parallel with no MCP access. The models are assigned in list order: Risk → DeepSeek V4 Pro, Design → MiMo V2.5 Pro, Tests → DeepSeek V4 Flash, Operations → GLM 5.3 Flash.
2. **A DeepSeek V4 Pro validator/synthesizer** treats every lens finding as a hypothesis, drops speculative/cosmetic/duplicate/stale items, requires severity + confidence + evidence + impact + fix, and posts **one** deduplicated tracking comment plus inline comments on changed lines.

GLM 5.3 Flash is an additive model-diversity trial assigned to the existing Operations lens under EHAC-2466; it does not increase the number of model executions. Keep the other lane assignments and validator stable while evaluating its latency, reliability, cost, and unique findings in real PRs.

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
      review_models: 'deepseek/deepseek-v4-pro,xiaomi/mimo-v2.5-pro,deepseek/deepseek-v4-flash,openrouter/z-ai/glm-5.3-flash'
      validator_model: 'deepseek/deepseek-v4-pro'
      thinking: 'high'
      severity_threshold: 'important'
      max_cost_usd: '1.00'
      cost_rates: 'xiaomi/mimo-v2.5-pro=0.435:0.87,deepseek/deepseek-v4-flash=0.14:0.28,openrouter/z-ai/glm-5.3-flash=0.15:0.50'
```

**Inputs:**

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `review_strategy` | string | `council` | Review strategy: `council` (4 lenses + validator), `crosscheck`, or `solo`. |
| `review_models` | string | `deepseek/deepseek-v4-pro,xiaomi/mimo-v2.5-pro,deepseek/deepseek-v4-flash,openrouter/z-ai/glm-5.3-flash` | Comma-separated OpenRouter model IDs assigned in order to Risk, Design, Tests, and Operations. |
| `validator_model` | string | `deepseek/deepseek-v4-pro` | Model that synthesizes lens findings and posts the single deduplicated review. |
| `thinking` | string | `high` | Requested Pi thinking: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Enabled-mode models request provider-default reasoning. |
| `max_turns` | number | `30` | Max conversation turns per reviewer. Raised from `20` on 2026-08-16: the `tests` lane was flaking against the ceiling rather than the diff, failing twice at 20 and then passing at 18 on a near-identical diff. |
| `severity_threshold` | string | `important` | Minimum severity to post (`info`, `important`, `critical`). |
| `max_cost_usd` | string | `1.00` | Per-PR cost guardrail; elek auto-downgrades council → crosscheck → solo on large diffs to stay within budget. |
| `cost_rates` | string | `xiaomi/mimo-v2.5-pro=0.435:0.87,deepseek/deepseek-v4-flash=0.14:0.28,openrouter/z-ai/glm-5.3-flash=0.15:0.50` | `model=input:output` USD-per-million-token overrides. The GLM rate uses conservative standard pricing rather than a temporary promotion. |
| `mode` | string | `review` | `review` and `review+edit` currently use the same read-only surface. |
| `model` | string | `deepseek/deepseek-v4-pro` | Single-model override for `solo` strategy; ignored under `council`. |
| `trigger_phrase` | string | `@ai-review` | Comment phrase that triggers an on-demand review. |
| `scope_paths` | string | (unset) | Comma-separated globs limiting which changed files are in scope. Evaluated **inside** this workflow, so an out-of-scope PR reports a green `NOT_REVIEWED` rather than no check run at all. Prefer this over a `paths:` filter on the caller — see the note below the table. |
| `actor_filter` | string | (unset) | Allowlist of **human** actors. **Authoritative and exclusive when set**: `isActorAuthorized` returns the list result and never consults repo permissions, so anyone absent is denied. When unset, falls back to `OWNER`/`MEMBER`/`COLLABORATOR` and then a repo-permission lookup. |
| `openrouter_provider_preferences` | string | (unset) | **EHAC-2280.** OpenRouter provider-routing preferences as a JSON object string, merged into the request's `provider` field. Parsed **fail-closed** in elek: unparseable JSON, a non-object, or any key outside the thirteen documented routing keys refuses the run rather than routing unmanaged. Unset means no `provider` object is sent and routing is exactly as before. Keep `allow_fallbacks: true` — excluding endpoints trades a latency problem for an availability one. Endpoint identity does not predict latency: the same endpoint (`deepinfra/fp8`) was measured at 386 ms and 10,277 ms seconds apart, a wider spread than between two different endpoints, which is why `preferred_min_throughput` (deprioritises, over a rolling window) is preferred to `order` (pins). |
| `openrouter_model_reasoning_modes` | string | `{"xiaomi/mimo-v2.5-pro":"enabled"}` | Canonical OpenRouter model capability map beside the council roster. `effort` preserves Pi's named control; `enabled` requests provider-default reasoning. Callers may override; app and infra inherit this default. |
| `reasoning_max_tokens` | string | (unset) | Optional OpenRouter budget replacing both effort and enabled. Controls are mutually exclusive; provider support determines enforcement. A successful request does not prove a hard token ceiling. Any scheduled off/budget conflict fails preflight. Production keeps this unset. |
| `allowed_bots` | string | (unset) | Allowlist of bot actors (`*` permits all). Bot authorship is evaluated independently from human actor trust; without this input, bot-authored PRs report `NOT_REVIEWED`. |
| `job_timeout_minutes` | number | `30` | Wall-clock ceiling for the WHOLE review job — the council plus the validator, not one model run. The real bound is serial: `setup + reviewer_cap + validator_cap`, because lenses run in parallel but the validator runs after them. A job killed by this cap loses the coverage record entirely, so raise it **before** raising `run_timeout_seconds`, never after. |
| `run_timeout_seconds` | string | `600` | Per-run budget for the elek step. Cannot exceed the job's own cap. |
| `stall_timeout_seconds` | string | `0` | **Stream-idle watchdog**, passed to elek. Terminates a model run that emits no pi stream event for this long and reports failure class `stall` — which `run_timeout_seconds` alone cannot distinguish from genuinely slow work. `0` disables it. Do not set it from intuition: calibrate from `maxIdleSecondsObserved` on your own successful runs, then use ≥3× the p99 idle gap, well under `run_timeout_seconds`. |
| `max_degraded_lenses` | string | `1` | How many **reviewer** lenses may fail while the review still counts. Passed to elek *and* to the coverage gate, which evaluate it independently and fail closed on drift. Never tolerated at any value: a failed validator/validator-review run, a wiped reviewer panel, an unclassifiable failed run, or a value not below the reviewer count. A degraded council passes with a warning naming every dropped lens. Invalid values resolve to `0` (strict). |
| `disable_mcp` | string | `0` | Emergency compatibility switch. `1` disables MCP and inline PR comments; keep the supported default `0`. |
| `max_council_changed_lines` | string | `0` | **RETIRED 2026-08-15 — accepted but no longer forwarded.** The pinned elek no longer declares this input, so passing it produced a permanent yellow "unexpected input" annotation. Kept only so existing callers do not break; setting it has no effect. |
| `prompt` | string | `Please review this PR for correctness, security, and potential issues.` | The review instruction, so a repo can shape its own review. Only honoured on `pull_request` events — a caller cannot inject a prompt on an on-demand run. |
| `pr_number` | number | (unset) | Target PR for on-demand runs, where the event carries no PR context. |

> **`workflow_dispatch` is not a review path.** elek rejects the event outright
> (`Unsupported event: workflow_dispatch`) before any model call, so a dispatch cannot be used to
> green-prove a change. Use `@ai-review` on a live PR, or close/reopen to force a genuine run.

> **Do not add a `paths:` filter to a caller.** A paths-filtered workflow never dispatches on an
> out-of-scope PR, so no check run is created and "not applicable" is indistinguishable from a broken
> integration. Use `scope_paths` instead: it turns "out of scope" into an explicit green
> `NOT_REVIEWED` result while still skipping the model call.

**Secrets:**

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | Dedicated AI-review system key, supplied as an organization secret only to audited caller repositories. |

## Adopting in a New Repo

1. **Grant the secret.** Add the repository to the selected-repository visibility of the dedicated organization `OPENROUTER_API_KEY`; do not create a shadow repository secret.
2. **Add a caller workflow.** Create `.github/workflows/ai-code-review.yml` in your repo with a single `review` job that references the shared workflow at a full commit SHA pin (`@<SHA-PIN>`) and passes the council `with:` inputs above.
3. **(Optional) Add `.elek.yml`.** Drop a repo-local `.elek.yml` to set `knowledge_paths`, `ignore_paths`, and `instructions` so the council reads your standards and skips generated/fixture files.
4. **Open a test PR.** Open a small PR and confirm the council posts one tracking comment with the four lenses running in parallel before finalizing the SHA pin org-wide. The automatic caller should omit `actor_filter` so trusted repository permissions remain authoritative; reserve a static allowlist for repositories that intentionally need stricter access.

## Cost

The `max_cost_usd` guardrail bounds each review. Actual spend varies with diff size and model output; use the emitted coverage record and OpenRouter usage when evaluating the GLM 5.3 Flash trial.

## Security

- All actions are pinned to full commit SHAs.
- Workflows run with least privilege: `contents: read`, `pull-requests: write` only.
- The AI reviewer cannot approve, merge, or close PRs (structural guarantee via the MCP server).
- Only the secret **name** `OPENROUTER_API_KEY` is referenced here; no secret value ever appears in a workflow or this README.

## See Also

- [EHA Care Monorepo](https://github.com/EHA-Clinics/eha_care)
- [EHA Care Infra](https://github.com/EHA-Clinics/eha-care-infra)

### Reasoning-mode evidence

MiMo is configured with `enabled` because its catalog exposes reasoning without named-effort
selection. `thinking: high` records the caller's request; MiMo's effective control is
`provider-default`, not named high effort. A token budget, when deliberately configured, takes
precedence over both modes. Off preserves Pi's existing payload in effort mode and omits reasoning
in enabled mode; omission does not prove that a default-on or mandatory model stops reasoning.

The shared workflow forwards the same mode map to Elek, the coverage producer, and the asserter.
Configured runs carry sanitized reasoning controls on every logical run and physical attempt,
including provider failures and failover. The job summary displays requested thinking, configured
mode, and effective control. U9 fails closed on missing or inconsistent telemetry or a producer/gate
mode-map mismatch. Historical summaries without a configured map remain parseable; a new configured
run cannot silently fall back to that legacy interpretation. Raw reasoning is never retained.
