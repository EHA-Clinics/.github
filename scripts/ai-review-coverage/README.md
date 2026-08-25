# AI Review Coverage gate

**Canonical location.** These scripts live here, in `EHA-Clinics/.github`, and nowhere else.
`.github/workflows/ai-code-review.yml` checks this directory out at a **pinned SHA** and runs it
inside the caller's job, so the copy that is tested is the copy that executes. Both
`eha_care` and `eha-care-infra` are private, so neither can be the canonical source for the
other's run; this repository is public, so the default `GITHUB_TOKEN` reads it from either
caller with **no new secret**.

A test-only mirror in an app repo could stay green while the executing copy is broken. That is
exactly the vacuous-gate class **EHAC-2057** exists to kill, so there is no mirror.

## Why this exists

`AI Review (Council)` returned *"No high-confidence issues survived cross-check validation"* on
`eha_care` PR #3515 (EHAC-1986, S1 cross-tenant PHI) while the entire 298-line
`tenantRoster.ts` tenant-isolation primitive sat **outside the model's prompt window** — and the
PR author's own prose was substituted as evidence in its place. Three faults composed:

1. a raw 60,000-char mid-stream `String.slice` of the diff (`elek@88813716 strategy.ts:282`),
   which drops files *including their `diff --git` name lines*;
2. acceptance gates that convert missing context into silence (`contract.ts`: *"drop it instead
   of posting a caveat"*) — byte-identical at v1.1.4 and at `main`, so the bump did not fix it;
3. a job named `AI Review (Council)` that actually ran **`crosscheck`**, because
   `DEFAULT_MAX_COUNCIL_CHANGED_LINES = 1_200` silently downgraded it, so the check name
   reported a strategy that never ran.

This gate is the "refuse loudly" half that elek does not have. It does **not** judge review
quality; it answers one question — *did the reviewer actually see the changed code?*

---

## Contract: verdicts and exit codes

`AI Review Coverage` is a separate job from `AI Review (Council)`, so *"review incomplete"* and
*"review broken"* stay separate signals.

| Verdict | Trigger | Exit | Surface |
|---|---|---:|---|
| `COMPLETE` | every changed file `WHOLE` | 0 | job-summary inventory table |
| `PARTIAL_NON_SOURCE` | only `promptPriority >= 1` files PARTIAL/ABSENT | 0 | `::warning::` + table |
| `PARTIAL_SOURCE` | **any** `promptPriority 0` file PARTIAL/ABSENT | **1** | `::error::` per file + table |
| `UNKNOWN` | any branch U1–U6 below | **1** | `::error::` naming the branch |
| `NOT_REVIEWED` | deterministic, allowlisted reason only | 0 | `::warning::` + banner |
| — | `needs.review.result` ∈ {`failure`, `cancelled`, `skipped`} | **1** | `::error::` |

The **full per-file inventory is published regardless of verdict**, so softening the predicate
later needs no new instrumentation.

### The UNKNOWN branches — every one exits non-zero

`exit 0` on "we could not measure" is the seductive bug: it is the PR #3515 logic one level up.
Each branch has its own passing test case.

| ID | Branch | Detection source |
|---|---|---|
| U1 | elek pin drift: `ELEK_REF !== ELEK_REF_VERIFIED` | the workflow's literal `ELEK_REF` env vs the frozen constant |
| U2 | empty diff while the PR reports changed files | catches elek's `getGitDiff` `catch -> return ""`, which the lenses see as *"(diff unavailable)"* |
| U3 | `executedStrategy !== requestedStrategy` | `review_summary_json.review` (Fault 5) |
| U4 | `git rev-parse origin/<head>` ≠ `pull_request.head.sha` | branch tip vs check-run SHA |
| U5 | missing/unparseable `coverage_json` or `review_summary_json`; `input_tokens` absent or 0; no `rollup` block | step outputs |
| U6 | any file whose `diff --git` header parses as `(unknown)` | header parse |

Two design choices worth stating outright:

* **The asserting half does not trust the producer's verdict string.** It re-derives U1–U6 from
  the record's own fields and **recomputes** the verdict from rollup counts. A spec feeds
  `verdict: "COMPLETE"` alongside `source_partial: 1` and asserts exit 1.
* **A shallow repository is recorded, not escalated.** elek re-fetches `--depth=100` over our
  `fetch-depth: 0` checkout, so a shallow marker may be entirely routine; a bare escalation
  would produce a red storm.

### Measurement rules that are non-negotiable

* Size is `fs.readFileSync(path, 'utf8').length` — **never `wc -c`**. On the PR #3515 fixture
  that is 137,015 utf8 units vs 137,552 bytes: a **537-unit** skew. A gate 0.9% off at a budget
  boundary produces the flaky red that gets error-suppression added six weeks later.
* The file split uses the anchored `/^diff --git .+$/gm` — **elek's own regex** — so the gate
  and the reviewer agree even where both are wrong the same way. A `grep -c 'diff --git'` count
  reports 7 on `fixtures/embedded-diff-header.diff` where the truth is 2.
* Measurement runs **inside the `review` job, after the elek step, in the same checkout and git
  config** (`-c core.autocrlf=false -c diff.noprefix=false`, both recorded). That collapses the
  whole `core.autocrlf` / `diff.noprefix` / `.gitattributes` / two-dot-fallback divergence class.
* The producer **can never exit non-zero and always emits**: a measurement bug becomes verdict
  `UNKNOWN` (red), never silence.
* The gate **never posts a PR comment**. elek's sticky comment is the review surface; a second
  bot comment per push is the alert fatigue that got the Phase-65 GHAS probe deleted.

---

## `coverage_json` schema

Emitted by `measure-review-coverage.mjs` as a single-line `coverage_json` step output, exported
as `jobs.review.outputs.coverage_json`, consumed as `needs.review.outputs.coverage_json`.

```jsonc
{
  "schema": 1,
  "verdict": "COMPLETE | PARTIAL_NON_SOURCE | PARTIAL_SOURCE | UNKNOWN | NOT_REVIEWED",
  "not_reviewed": null,                       // or { reason, actor }
  "unknown_reasons": [ { "branch": "U3", "message": "..." } ],
  "elek":     { "ref": "<40-hex>", "ref_verified": "<40-hex>", "pin_ok": true },
  "strategy": { "requested": "council", "executed": "council", "match": true },
  "refs":     { "base_ref": "v2", "head_ref": "feat/x", "head_sha_git": "...",
                "head_sha_event": "...", "sha_match": true, "shallow": false },
  "git_config": { "core.autocrlf": "false", "diff.noprefix": "false" },
  "diff":     { "chars": 137015, "files_diff": 15, "changed_files_api": 15,
                "regime": "FULL | SLICES", "slice_ceiling_observed": 3846, "prompt_chars": 52715,
                "ranking_anomalies": [] },
  "review":   { "conclusion": "success", "input_tokens": 83000, "cost_usd": 0.0496,
                "actor": "...", "event": "pull_request" },
  "rollup":   { "files_total": 15, "whole": 6, "source_partial": 4, "source_absent": 0,
                "non_source_partial": 5, "non_source_absent": 0, "unknown_paths": 0 },
  "inventory": [ { "path": "...", "priority": 0, "status": "added",
                   "patch_chars": 15215, "shown_chars": 3822, "pct": 25,
                   "verdict": "WHOLE | PARTIAL | ABSENT" } ],
  "inventory_truncated": false                // inventory capped at 250 rows; rollup is whole-population
}
```

It carries **paths, sizes and counts only** — never diff content, never tokens, never secrets.

---

## Running the tests locally

```bash
cd <this repo>
pnpm install --frozen-lockfile
pnpm test
```

`vitest` is pinned to **exactly `4.1.9`** — the version already resolved in `eha_care`'s
`pnpm-lock.yaml` — so no new package enters the supply chain. The gate modules themselves are
Node-built-ins-only ESM.

Measure a fixture, or any diff, by hand:

```bash
ELEK_REF=3748508413fb355ae696b8fa98d1075930d12106 \
REQUESTED_STRATEGY=council EXECUTED_STRATEGY=council REVIEW_INPUT_TOKENS=83000 \
  node scripts/ai-review-coverage/measure-review-coverage.mjs \
    --diff-file scripts/ai-review-coverage/fixtures/pr-3515.diff
```

`--diff-file` is **explicit** offline mode: stdout carries only the coverage JSON, and no job
output or step summary is written. (It used to infer offline mode from `GITHUB_OUTPUT` being
unset, which is never true inside Actions — `Coverage Gate Tests` caught that on PR #5, and two
specs now lock the behaviour.)

Then assert on it:

```bash
REVIEW_RESULT=success COVERAGE_JSON="$COV" \
  node scripts/ai-review-coverage/assert-review-coverage.mjs; echo "exit=$?"
```

### Proof that the gate can fail

| Claim | Evidence |
|---|---|
| Reds on real truncation | `fixtures/pr-3515.diff` → verdict exactly `PARTIAL_SOURCE`; `tenantRoster.ts` shows **3,822 of 15,215** chars (25%); assert exits **1** |
| Greens on full coverage | `fixtures/small-complete.diff` → `COMPLETE`, exit 0 |
| There is no second implementation to be unfaithful | R14 deleted the port. `elek@3748508 src/review/diff-context.ts` is vendored byte-identically and **executed**; `elek-prompt-budget.mjs` measures its output and names none of its constants. The rewrite reproduces the previously measured prompt sizes to the character (52,715 / 14,751 / 26,366) and every per-file boundary — those values were produced by the earlier implementation and were **not** recomputed by this change, so agreement with them is external corroboration rather than a snapshot of itself |
| The vendored copy cannot drift unreported | `git hash-object -t blob` over `vendor/diff-context.ts` equals upstream's own blob sha in the sibling manifest; the manifest commit equals the workflow's action pin; and every fixture's output equals a golden frozen at that pin. All three are demonstrated on a deliberate divergence in `elek-prompt-budget.test.mjs` |
| The YAML cannot be vacuous | `workflow-invariants.test.mjs` parses the shipped workflow and asserts no error-suppression key, `if:` exactly `always()`, no step-level `if:`, `needs: review`, both gate `ref:`s 40-hex and equal |

---

## Known limitations and promotion blockers

The gate landed **advisory** (CONTEXT D-04). Promotion is tracked as **EHAC-2060**. These six
items are the reasons it is not required today.

### 1. The caller's `paths:` filter blocks promotion

`eha_care`'s push caller filters on `apps/**`, `libs/**`, `.github/**`; `eha-care-infra`'s on
`infrastructure/**`, `kubernetes/**`, `services/**`, `.github/**`.

A `paths:`-filtered workflow **can never host a required check**: on a non-matching PR the
workflow never runs, no check run is created, and the required check stays *Pending* forever,
blocking the merge. Promotion needs `dorny/paths-filter` + `if:` instead of a top-level
`paths:` — **and even then only the *review step* may be conditional. The gate job must always
report**, because a skipped check counts as passing. Today's workaround: the `@ai-review`
on-demand caller has no `paths:` filter.

Consequence to state plainly: on any PR that touches neither of those globs — for example one
touching only `scripts/**` or `e2e/**` — this gate is **absent**, not green.

### 2. Required-check strings: 4 entries, 2 unique strings

The context string for a reusable-workflow job is `<caller job name> / <called job name>`. Both
`eha-care-infra` callers use job names identical to `eha_care`'s, so there are only **two
distinct strings**, each needing an entry in **both** repositories:

* `AI Review (Council) / AI Review Coverage`
* `AI Review On Demand (Council) / AI Review Coverage`

Current `eha_care` `v2` required contexts are exactly `EHACare Lint Test`,
`EHACare Unit/Integration Test`, `Fixture Health`.

The job `name:` is a branch-protection API contract string. **Do not rename
`AI Review Coverage`.**

### 3. Cancellation — MEASURED, and it costs one red per superseded push

This started as an open question. It is now answered by direct observation on
`EHA-Clinics/eha_care` PR #3518, run `30377721519`, deliberately superseded mid-flight by a
force-push:

```
workflow run                                   completed / cancelled
AI Review (Council) / AI Code Review (council)  conclusion=cancelled
AI Review (Council) / AI Review Coverage        conclusion=failure    ← it DID get scheduled
```

So an `if: always()` job **is** scheduled on a concurrency-cancelled run, and this gate reports
`failure` (not `cancelled`), failing closed as designed. Worth noting that the gate job sat in
`queued` for a while first — treat "still queued" as "not yet resolved", not as "skipped".

The consequence is quantified rather than feared: with `cancel-in-progress: true`, **every
superseded force-push deterministically produces one red `AI Review Coverage` check** on the
stale head. That is tolerable while advisory — the newer run posts a newer check under the same
name and supersedes it in the PR UI — but it is the dominant false-red source and must be
budgeted before promotion (EHAC-2060). If the rate is unacceptable, fix the cancel branch
honestly by detecting run supersession. **Never make `cancelled` exit 0.**

### 3b. `trigger_phrase` is a body-content precondition — and it used to fail open

Found live, on this gate's own first run (`eha_care` PR #3518, run `30376963132`):

```
No trigger detected — exiting cleanly
REVIEW_CONCLUSION: skipped
```

…while `AI Review (Council) / AI Code Review (council)` reported **✓ green in 1m0s**.

elek's `trigger_phrase` is `@ai-review`, normally supplied by the repo's PR template. A PR whose
body omits it — anyone who clears the template — gets a **green** `AI Review (Council)` check
with **zero** review behind it. That is the EHAC-2057 defect through a different door, and it
was invisible until a gate existed that could see it. The coverage gate now catches it as
`UNKNOWN` / **U5** (*"review input_tokens is absent or 0 — no evidence a review prompt was ever
built"*).

**`trigger_phrase_absent` is deliberately NOT in the `NOT_REVIEWED` allowlist.** Adding it would
turn this back into a green, which would re-create the exact fail-open. The honest report is red:
the check claimed a review and none happened.

Promotion consequence (EHAC-2060): if this check becomes *required* while the trigger phrase
remains a body-content precondition, a template-cleared PR blocks on a permanently red check.
Either the trigger phrase must stop being optional, or the `pull_request` path must not depend on
body content at all. **Do not "fix" this by widening the allowlist.**

### 4. `NOT_REVIEWED` is the single exit-0-without-coverage branch

Closed reason allowlist, **six entries**. `NOT_REVIEWED_REASONS` in `measure-review-coverage.mjs`
is the source of truth and a test now holds this list equal to it — until 2026-08-25 this section
claimed "exactly two entries" while the code carried five, having drifted through EHAC-2060 and
EHAC-2231 without anyone updating it.

Decided from the **actor/event precheck**:

* `actor_not_in_actor_filter`
* `actor_is_bot_not_allowlisted` — the *actor* is an unlisted bot

Decided by the **`Resolve review scope` step**, before elek is invoked (`SCOPE_SKIP_REASONS`):

* `no_files_in_review_scope` (EHAC-2060)
* `pull_request_is_draft` (EHAC-2060)
* `pr_author_is_bot_not_allowlisted` (EHAC-2294) — the pull request's *author* is an unlisted
  bot, **whoever pushed the button**. Distinct from `actor_is_bot_not_allowlisted` because elek's
  `isActorAllowed` reads `github.actor`: a human rebasing a Renovate branch made the bot
  allowlist stop applying, and a six-lens council would read a regenerated lockfile. Measured
  2026-08-22..24 across `eha_care` and `eha-care-infra`: 41 of 125 model runs — 33% of all
  AI-review spend — were bot-authored pull requests, and **all 41 had a human as `github.actor`**.
  Reusing the actor reason would have produced records naming a human next to a claim that the
  actor was a bot.

Decided by the **rollup**:

* `all_changed_files_excluded` (EHAC-2231) — every changed file matched `exclude_paths`

Any other reason falls through to `UNKNOWN` (red). The branch is reached **only** from the
gate's own deterministic actor/event computation, never inferred from an empty elek output, and
it is suppressed entirely when a review demonstrably happened (`input_tokens > 0`) — otherwise
it would be a fail-open. It always emits a `::warning::` and a job-summary banner.

It exists because without it every Renovate PR becomes a permanent red, which is the alert
fatigue that got the Phase-65 GHAS probe deleted. **Widening this allowlist is a promotion-time
decision** (EHAC-2060), not an implementation detail.

Two honest caveats about the allowlist as it stands:

* **`actor_not_in_actor_filter` is currently unreachable for humans.** Verified in
  `elek@3748508 src/github/trigger.ts:52-77`: `isActorAllowed` checks the list and then falls
  through to `return !actor.endsWith("[bot]")`, so a non-bot actor off the list is still allowed
  and *is* reviewed. The entry is kept for forward-compatibility with the post-v1.1.4 narrowing
  of the empty default, and it is harmless — the branch is suppressed whenever a review
  demonstrably happened (`input_tokens > 0`). The entry that does real work today is
  `actor_is_bot_not_allowlisted`.
* **This also means `actor_filter` is not the security control it was planned to be.** See
  limitation 6 and EHAC-2059.

### 5. `ignore_paths` reclaims no prompt budget — do not re-derive path-sharding

`.elek.yml` `ignore_paths` is **prompt text only**, still at v1.1.4: `formatConfigPromptBlock`
renders it into an `<elek_config>` text block and there is **no glob matcher anywhere in elek's
source**. It never filters `data.diff`.

On PR #3515, **75.3% of the model's 60,000-char window was spent on files `.elek.yml` declares
ignored**. Path-sharding a review via `config_path` + generated `ignore_paths` is therefore
**structurally impossible**. v1.1.4's `promptPriority` achieves *de facto* what `ignore_paths`
claims — by budget priority, not exclusion.

Real chunking needs a fork of `diff-context.ts`: **EHAC-2058**. Measured evidence that the pin
bump alone is insufficient: at v1.1.4, `tenantRoster.ts` is present-and-first but only **26%
shown**, and the packer uses just **52,715 of its 200,000-char budget** because the `<= 80,000`
full-diff gate and the 4,000-char per-file clamp bind first.

### 6. Pin re-verification procedure

**R14 / D-04 changed this.** There used to be a hand-written *port* of elek's packer here: a
second implementation that restated the upstream constants and had to be re-derived by hand on
every bump. Two copies of one idea agree on the day they are written and can disagree silently
ever after. There is now **one** implementation — `vendor/diff-context.ts` is the upstream
packer, vendored byte-for-byte at the pinned commit, and `elek-prompt-budget.mjs` **executes**
it and measures what it emitted.

The vendored file carries **no local header**: a header would break the byte-identity that its
provenance asserts. Provenance lives in the sibling `vendor/diff-context.manifest.json`, which
records `upstream_repo`, `upstream_path`, `upstream_commit` and `upstream_blob_sha` — the last
being **upstream's own git blob identifier**, taken from the contents API at fetch time, not a
digest we computed over what we wrote. (A self-computed digest proves only that we hashed our
own bytes: an edit updating both the file and the digest would pass.) It is recomputable offline
with `git hash-object -t blob`.

On any elek bump, in one change:

1. re-fetch `src/review/diff-context.ts` at the new ref into `vendor/`, unmodified;
2. update `upstream_commit` and `upstream_blob_sha` in `vendor/diff-context.manifest.json`
   (`ELEK_REF_VERIFIED` is **read from** that file, never retyped);
3. update the literal `ELEK_REF` env value in `.github/workflows/ai-code-review.yml`;
4. regenerate `fixtures/golden/` with `node scripts/ai-review-coverage/generate-goldens.mjs`;
5. **by hand:** re-check that `fixtures/pr-3515.diff` still truncates. A newer packer may stop
   truncating it, at which point the `Prove the fixture-driven red end-to-end` step in
   `coverage-gate-tests.yml` would pass for the wrong reason.

Until 1–3 agree, **U1 keeps the gate red by design**, and `elek-prompt-budget.test.mjs` reports
the disagreement offline: blob-hash agreement catches a hand-edited vendored copy, pin agreement
catches a bump without a re-vendor, and the committed goldens catch any change to the model, the
vendored module or the runtime that alters the answer.

**Stated limitation.** None of those assertions proves that the Action executing at runtime uses
these semantics. The only link is pin agreement, and it is a link by *commit identity*, not by
execution.

Two figures are no longer published, and one is new. `per_file_budget` is gone: it was elek's
*internal* slice budget, it does not appear anywhere in elek's output, and the only way to
publish it was to restate the arithmetic. `slice_ceiling_observed` replaces it with what can
actually be measured — the largest slice that survived into the prompt (3,846 on `pr-3515.diff`,
against an internal budget of 4,000).

The pin itself is revisited in **EHAC-2059**: `main` (`cbb7202b`, untagged) replaces `execSync`
with `execFileSync` + `isSafeGitRefName` in `src/github/git.ts`, a genuine shell-injection fix,
and narrows `actor_filter`'s empty default from *all humans* to *owners/members/collaborators*.

**Correction to the planning assumption, recorded because it changes the risk picture.** The
plan (CONTEXT D-05) and the research it rested on both treated an explicit `actor_filter` as
*the* compensating control for that shell-injection surface at v1.1.4. **It is not.** From
`elek@3748508 src/github/trigger.ts:52-77`:

```ts
if (inputs.actorFilter) {
  const allowed = inputs.actorFilter.split(",").map((s) => s.trim());
  if (allowed.includes(actor)) return true;
}
if (inputs.allowedBots) { /* … */ }
return !actor.endsWith("[bot]");     // ← every non-bot actor is allowed anyway
```

The list is **additive, not exclusive**: it does not narrow the human trigger surface at all. It
is still set by all four callers — it documents intent, is forward-compatible with the
post-v1.1.4 narrowing, and makes the bot deny explicit — but the mitigations actually carrying
the risk today are that both calling repositories are private, that fork PRs receive no
secrets, and that `mode: review` is read-only. That raises the priority of **EHAC-2059**, and it
is the reason the caller files say so in a comment rather than shipping a claim that overstates
a control.

---

## Follow-ups

| Key | Title |
|---|---|
| [EHAC-2058](https://ehealthnigeria.atlassian.net/browse/EHAC-2058) | Fork elek `diff-context.ts` for real per-file map-reduce diff chunking |
| [EHAC-2059](https://ehealthnigeria.atlassian.net/browse/EHAC-2059) | Revisit the elek pin once `execFileSync` + `isSafeGitRefName` ships in a tag |
| [EHAC-2060](https://ehealthnigeria.atlassian.net/browse/EHAC-2060) | Promote `AI Review Coverage` to a required check after the advisory soak |

Parent: [EHAC-2057](https://ehealthnigeria.atlassian.net/browse/EHAC-2057). Per a standing
operator rule, nothing is filed on `selimozten/elek` or any other third-party repository.

## Files

| File | Role |
|---|---|
| `vendor/diff-context.ts` | **upstream bytes and nothing else** — `elek@3748508 src/review/diff-context.ts`, byte-identical, no local header |
| `vendor/diff-context.manifest.json` | provenance for the above: repo, path, commit, upstream blob sha, the fetch command, and the coupling note for the deferred version move |
| `elek-prompt-budget.mjs` | **executes** the vendored packer and measures its output; carries no upstream constant. Re-exports `ELEK_REF_VERIFIED` from the manifest |
| `generate-goldens.mjs` | one-off regenerator for `fixtures/golden/`; run it only when the vendored packer moves |
| `fixtures/golden/` | frozen expected outputs + a manifest naming the inputs they were produced from |
| `measure-review-coverage.mjs` | producer: pure `buildCoverage` core + thin CLI; runs in the `review` job; never exits non-zero |
| `assert-review-coverage.mjs` | consumer: re-derives U1–U6, recomputes the verdict, exits per the contract |
| `workflow-invariants.test.mjs` | parses the shipped workflow YAML and asserts the gate cannot be suppressed or skipped |
| `fixtures/` | three real `git diff`s + their provenance; see `fixtures/README.md` |
