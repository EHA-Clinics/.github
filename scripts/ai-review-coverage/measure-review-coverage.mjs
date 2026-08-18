#!/usr/bin/env node
/**
 * measure-review-coverage.mjs — PRODUCER half of the `AI Review Coverage` gate (EHAC-2057).
 *
 * Runs INSIDE the `review` job, immediately after the elek step, in the same checkout and
 * the same git config. That placement is deliberate and load-bearing: measuring here
 * collapses to zero the whole class of divergence between what elek measured and what we
 * measure (`core.autocrlf`, `diff.noprefix`, `.gitattributes` diff drivers, `diff.renames`,
 * two-dot fallback, the shallow boundary elek's own `--depth=100` re-fetch can introduce).
 *
 * CONTRACT: this script MUST NEVER exit non-zero and MUST ALWAYS emit a coverage record.
 * A measurement bug has to surface as verdict `UNKNOWN` (which the asserting half turns
 * red) rather than as silence. Silence-on-failure is the exact defect EHAC-2057 is about.
 *
 * It also never posts a PR comment: elek's sticky comment is the review surface, and a
 * second bot comment per push is the alert fatigue that got the Phase-65 GHAS probe deleted.
 *
 * Usage:
 *   # in CI (inside the review job, after the elek step)
 *   node measure-review-coverage.mjs
 *
 *   # offline / local, prints the coverage JSON to stdout when GITHUB_OUTPUT is unset
 *   ELEK_REF=<pin> REQUESTED_STRATEGY=council EXECUTED_STRATEGY=council \
 *     REVIEW_INPUT_TOKENS=83000 \
 *     node measure-review-coverage.mjs --diff-file fixtures/pr-3515.diff
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { ELEK_REF_VERIFIED, attributeCoverage } from './elek-prompt-budget.mjs';

/** Published inventory cap. The ROLLUP counts always cover the whole population. */
export const DEFAULT_INVENTORY_CAP = 250;

/**
 * Closed allowlist of deterministic reasons that mean "no review was requested", as opposed
 * to "a review claimed completeness". Anything not in this set falls through to UNKNOWN.
 * Widening this list is a promotion-time decision, not an implementation detail.
 */
export const NOT_REVIEWED_REASONS = Object.freeze([
  'actor_not_in_actor_filter',
  'actor_is_bot_not_allowlisted',
  // EHAC-2060. Both are decided by the `Resolve review scope` step BEFORE elek is invoked,
  // from the changed-file list and the draft flag — never inferred from an empty elek output.
  // They exist so a PR the review does not apply to yields a GREEN check rather than NO
  // check: a required context that is never reported blocks the PR forever.
  'no_files_in_review_scope',
  'pull_request_is_draft',
]);

/** The subset of NOT_REVIEWED_REASONS that the workflow decides, not the actor precheck. */
export const SCOPE_SKIP_REASONS = Object.freeze(['no_files_in_review_scope', 'pull_request_is_draft']);

/** Git settings we pin explicitly and record, so the measurement is reproducible. */
export const GIT_CONFIG = Object.freeze({ 'core.autocrlf': 'false', 'diff.noprefix': 'false' });

const asPositiveInt = (value) => {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Deterministic actor/event precheck: would elek decline to review at all?
 *
 * Computed from OUR OWN inputs (`ACTOR_FILTER` as passed to the elek step, and the event
 * actor), never inferred from an empty elek output. A review that demonstrably happened
 * (input tokens > 0) always wins — otherwise this branch would be a fail-open.
 *
 * @param {{actorFilter: string, actor: string, inputTokens: number|null, skipReason?: string}} args
 * @returns {{reason: string, actor: string}|null}
 */
export function computeNotReviewed({ actorFilter, actor, inputTokens, skipReason = '' }) {
  if (inputTokens && inputTokens > 0) return null; // a review did happen — audit it
  const who = String(actor ?? '').trim();

  // EHAC-2060 — the workflow decided, before invoking elek, that no review applied. Checked
  // after the inputTokens guard above so a review that demonstrably ran can never be
  // explained away by a stale skip reason, and validated against the closed allowlist so a
  // typo or an injected value degrades to UNKNOWN rather than to a silent pass.
  const skip = String(skipReason ?? '').trim();
  if (skip !== '' && SCOPE_SKIP_REASONS.includes(skip)) {
    return { reason: skip, actor: who || null };
  }

  if (who === '') return null;

  // elek's `allowed_bots` defaults to empty, so an unlisted bot declines regardless of
  // actor_filter. This is what keeps Renovate PRs from becoming a permanent red.
  if (/\[bot\]$/i.test(who)) return { reason: 'actor_is_bot_not_allowlisted', actor: who };

  const allow = String(actorFilter ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Empty actor_filter means "all humans" at v1.1.4 — no decline can be inferred.
  if (allow.length === 0) return null;
  if (!allow.some((entry) => entry.toLowerCase() === who.toLowerCase())) {
    return { reason: 'actor_not_in_actor_filter', actor: who };
  }
  return null;
}

/**
 * Roles in elek's `review_summary_json.modelRuns[]`. A council run emits one `reviewer` entry
 * per lens, one `validator-review` (the validator reviewing as a lens in its own right), and
 * one final `validator` that reconciles and writes the comment.
 */
export const REVIEWER_ROLES = Object.freeze(['reviewer']);
export const VALIDATOR_ROLES = Object.freeze(['validator', 'validator-review']);

/**
 * Derive the per-lens model record from elek's `review_summary_json.modelRuns[]` (EHAC-2162,
 * EHAC-2103).
 *
 * Two separate defects motivate this, and they share one input:
 *
 * EHAC-2162 — the gate previously read only `summary.run.conclusion`, the AGGREGATE. A council
 * run in which an individual reviewer lens returned `conclusion: "failure"` but the validator
 * reconciled successfully still yielded `run.conclusion: "success"`, positive input_tokens and
 * full diff coverage, so the gate reported COMPLETE / exit 0. Observed on eha_care PR #3564
 * (run 31223046934): the `tests` lens AND `validator-self-review` both failed, and the check
 * still said "analysis complete". That is the EHAC-2057 shape with a different first cause — a
 * review that partially did not happen, reported as a review that did.
 *
 * EHAC-2103 — the posted comment cannot be used to verify which models ran. elek's
 * `redactInternalModelLabels` rewrites the validator's label to the primary model's, so GLM is
 * not merely missing from the attribution, it is erased and misattributed. `modelRuns[]` is the
 * unmangled ground truth for the same run, so recording it here makes "three models reviewed
 * this" a checkable claim rather than narration.
 *
 * The configured model list is recorded ALONGSIDE the observed one but deliberately NOT
 * asserted against it yet. elek's `modelLabelFor` prefixes the provider (`deepseek/...` becomes
 * `openrouter/deepseek/...`) while an already-qualified id such as `openrouter/z-ai/glm-5.1`
 * passes through unchanged, and council lens labels come from `usage.modelLabel` rather than
 * necessarily from `modelLabelFor(inputs)`. A naive set comparison would mismatch two of the
 * three configured lenses on day one and emit a false red. False reds are how gates get
 * disabled, so stage 1 observes and stage 2 asserts against measured strings.
 *
 * @param {any} summary Parsed `review_summary_json`, or null.
 * @param {Record<string, string|undefined>} env
 * @returns {any|null} null when the summary carries no usable modelRuns array.
 */
export function deriveModels(summary, env = {}) {
  const list = (value) =>
    String(value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const configured = {
    review_models: list(env.REVIEW_MODELS),
    validator_model: String(env.VALIDATOR_MODEL ?? '').trim() || null,
  };

  const rawRuns = Array.isArray(summary?.modelRuns) ? summary.modelRuns : null;
  if (!rawRuns) {
    return { runs: null, attempts: null, configured, policy: derivePolicy(summary, env), distinct_models: [], rollup: null };
  }

  const runs = rawRuns.map((r) => ({
    role: typeof r?.role === 'string' ? r.role : null,
    lens_id: typeof r?.lensId === 'string' ? r.lensId : null,
    model_label: typeof r?.modelLabel === 'string' ? r.modelLabel : null,
    // Anything that is not the literal string "success" is treated as not-success. An absent
    // or unrecognised conclusion must not read as a pass — that is the defect class this gate
    // exists to catch, and it would be perverse to reintroduce it here.
    conclusion: typeof r?.conclusion === 'string' ? r.conclusion : null,
    input_tokens: Number.isFinite(Number(r?.inputTokens)) ? Number(r.inputTokens) : null,
    output_tokens: Number.isFinite(Number(r?.outputTokens)) ? Number(r.outputTokens) : null,
    cost_usd: Number.isFinite(Number(r?.costUsd)) ? Number(r.costUsd) : null,
    // EHAC-2231, all ADDITIVE and all null-safe. A record produced by an older elek pin simply
    // carries nulls here; nothing downstream may treat a null as a pass or as a failure, only
    // as "not reported". The census prints them because "which lens dropped, on which model,
    // and how" is the question an operator actually has, and answering it from the run log
    // meant reading six interleaved pi transcripts.
    failure_class: typeof r?.failureClass === 'string' ? r.failureClass : null,
    assigned_model_label: typeof r?.assignedModelLabel === 'string' ? r.assignedModelLabel : null,
    actual_model_label:
      typeof r?.actualModelLabel === 'string'
        ? r.actualModelLabel
        : typeof r?.modelLabel === 'string'
          ? r.modelLabel
          : null,
    failover_used: typeof r?.failoverUsed === 'boolean' ? r.failoverUsed : null,
    attempt_count: Number.isFinite(Number(r?.attemptCount)) ? Number(r.attemptCount) : null,
  }));

  const failed = (r) => r.conclusion !== 'success';
  const reviewers = runs.filter((r) => REVIEWER_ROLES.includes(r.role));
  const validators = runs.filter((r) => VALIDATOR_ROLES.includes(r.role));

  // Every PHYSICAL attempt. Separate from `runs` on purpose: a retried lens is ONE logical
  // lens for quorum arithmetic but TWO executions for cost, latency and diagnosis. Folding
  // them together is what made the previous retry invisible in the record — it was known to
  // have happened, but not what it cost, what it changed, or why it was attempted.
  const rawAttempts = Array.isArray(summary?.attempts) ? summary.attempts : null;
  const attempts = rawAttempts
    ? rawAttempts.map((a) => ({
        lens_id: typeof a?.lensId === 'string' ? a.lensId : null,
        role: typeof a?.role === 'string' ? a.role : null,
        attempt: Number.isFinite(Number(a?.attempt)) ? Number(a.attempt) : null,
        assigned_model: typeof a?.assignedModel === 'string' ? a.assignedModel : null,
        actual_model: typeof a?.actualModel === 'string' ? a.actualModel : null,
        failover: typeof a?.failover === 'boolean' ? a.failover : null,
        conclusion: typeof a?.conclusion === 'string' ? a.conclusion : null,
        failure_class: typeof a?.failureClass === 'string' ? a.failureClass : null,
        termination_reason: typeof a?.terminationReason === 'string' ? a.terminationReason : null,
        duration_seconds: Number.isFinite(Number(a?.durationSeconds)) ? Number(a.durationSeconds) : null,
        turns_used: Number.isFinite(Number(a?.turnsUsed)) ? Number(a.turnsUsed) : null,
        provider_retries: Number.isFinite(Number(a?.providerRetries)) ? Number(a.providerRetries) : null,
        input_tokens: Number.isFinite(Number(a?.inputTokens)) ? Number(a.inputTokens) : null,
        cost_usd: Number.isFinite(Number(a?.costUsd)) ? Number(a.costUsd) : null,
        time_to_first_event_seconds: Number.isFinite(Number(a?.timeToFirstEventSeconds))
          ? Number(a.timeToFirstEventSeconds)
          : null,
        max_idle_seconds_observed: Number.isFinite(Number(a?.maxIdleSecondsObserved))
          ? Number(a.maxIdleSecondsObserved)
          : null,
      }))
    : null;

  return {
    runs,
    attempts,
    configured,
    policy: derivePolicy(summary, env),
    distinct_models: [...new Set(runs.map((r) => r.model_label).filter(Boolean))].sort(),
    rollup: {
      runs_total: runs.length,
      reviewer_lenses_total: reviewers.length,
      reviewer_lenses_failed: reviewers.filter(failed).length,
      validator_runs_total: validators.length,
      validator_runs_failed: validators.filter(failed).length,
      failed_lens_ids: runs.filter(failed).map((r) => r.lens_id ?? r.role ?? '(unknown)'),
      // Physical attempts vs logical lenses. `attempts_total > runs_total` is a retry having
      // happened, which the previous record could not express at all.
      attempts_total: attempts ? attempts.length : null,
      failover_attempts: attempts ? attempts.filter((a) => a.failover === true).length : null,
    },
  };
}

/**
 * The degraded-lens tolerance, from BOTH sides, recorded side by side.
 *
 * `producer_max_degraded` is the value THIS job was handed by the reusable workflow.
 * `elek_*` is what the review run reports it actually applied. The asserter compares its own
 * COUNCIL_MAX_DEGRADED against these and fails closed, with a distinct reason, when they
 * disagree — because a producer and a gate silently applying different policies while both
 * report success is the same defect family as a gate that cannot fail.
 *
 * Everything is null-safe: a record from an older elek pin reports no policy, and "not
 * reported" must never be read as agreement.
 *
 * @param {any} summary
 * @param {Record<string, string|undefined>} env
 */
export function derivePolicy(summary, env = {}) {
  const raw = env.COUNCIL_MAX_DEGRADED;
  const producer =
    raw === undefined || String(raw).trim() === '' ? null : Number(String(raw).trim());
  const p = summary?.councilPolicy ?? null;
  const int = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    producer_max_degraded: Number.isInteger(producer) && producer >= 0 ? producer : producer === null ? null : 0,
    producer_max_degraded_raw: raw === undefined ? null : String(raw),
    elek_configured_max_degraded: p ? int(p.configuredMaxDegradedLenses) : null,
    elek_effective_max_degraded: p ? int(p.effectiveMaxDegradedLenses) : null,
    elek_status: typeof p?.status === 'string' ? p.status : null,
    elek_failed_reviewer_lens_ids: Array.isArray(p?.failedReviewerLensIds)
      ? p.failedReviewerLensIds
      : null,
    elek_warnings: Array.isArray(p?.warnings) ? p.warnings : null,
  };
}

/**
 * Pure core: turn a diff plus the elek step's outputs into the coverage record.
 *
 * @param {{
 *   diffText: unknown,
 *   env?: Record<string, string|undefined>,
 *   context?: {
 *     baseRef?: string, headRef?: string,
 *     headShaGit?: string|null, headShaEvent?: string|null,
 *     changedFilesApi?: number|null, shallow?: boolean|null,
 *     actor?: string, eventName?: string, prNumber?: number|null, repo?: string|null,
 *   },
 *   inventoryCap?: number,
 * }} args
 */
/**
 * Read the prompt budget the run ACTUALLY used, from the run's own report.
 *
 * elek emits one entry per lens, because the budget is a function of the lens model's input
 * window minus the characters reserved for body, comments, config block and user request. The
 * gate produces a single verdict, so it must pick one, and it picks the SMALLEST — the most
 * starved reviewer in the council. That is the conservative direction: measuring against the
 * roomiest lens would let a lens that saw 5% of the code pass as covered, which is the class of
 * false green this gate exists to prevent.
 *
 * When the field is absent — an older elek that does not report it — the packer's own default
 * binds, exactly as before. That case is RECORDED rather than inferred away, so a reader can
 * tell "measured against what the run reported" from "measured against a default we assumed".
 *
 * @param {any} summary parsed review_summary_json, or null
 * @returns {{maxChars: number|undefined, excludePaths: string[], source: string, lenses: number}}
 */
function reportedPromptBudget(summary) {
  const entries = Array.isArray(summary?.promptBudgets) ? summary.promptBudgets : [];
  const budgets = entries
    .map((entry) => Number(entry?.diffPromptBudgetChars))
    .filter((value) => Number.isFinite(value) && value > 0);
  const excludePaths = [
    ...new Set(
      entries.flatMap((entry) => (Array.isArray(entry?.excludePaths) ? entry.excludePaths : [])),
    ),
  ];
  if (budgets.length === 0) {
    return { maxChars: undefined, excludePaths, source: 'upstream-default', lenses: 0 };
  }
  return {
    maxChars: Math.min(...budgets),
    excludePaths,
    source: 'reported-by-run',
    lenses: budgets.length,
  };
}

export function buildCoverage({ diffText, env = {}, context = {}, inventoryCap = DEFAULT_INVENTORY_CAP }) {
  /** @type {{branch: string, message: string}[]} */
  const unknown = [];
  const addUnknown = (branch, message) => unknown.push({ branch, message });

  // The elek step's own report is parsed BEFORE measuring, because the measurement now
  // consumes it: the diff budget is per-model and reservation-aware, so it is READ from the
  // run rather than assumed. Modelling it as a flat default with zero reservation made the
  // gate believe the reviewer saw more than it did — a false green in a safety gate.
  let summary = null;
  const rawSummary = typeof env.REVIEW_SUMMARY_JSON === 'string' ? env.REVIEW_SUMMARY_JSON.trim() : '';
  if (rawSummary !== '') {
    try {
      summary = JSON.parse(rawSummary);
    } catch (err) {
      addUnknown('U5', `review_summary_json did not parse: ${err?.message ?? err}`);
    }
  }
  const reported = reportedPromptBudget(summary);

  let attribution;
  try {
    if (typeof diffText !== 'string') {
      throw new Error(`diff text is ${diffText === undefined ? 'missing' : typeof diffText}`);
    }
    attribution = attributeCoverage(diffText, {
      maxChars: reported.maxChars,
      excludePaths: reported.excludePaths,
    });
  } catch (err) {
    // A measurement bug must be RED, not silent.
    return unknownRecord(
      [{ branch: 'U5', message: `coverage measurement failed: ${err?.message ?? err}` }],
      { env, context },
    );
  }

  // ---- elek pin (U1) ---------------------------------------------------------------
  const elekRef = String(env.ELEK_REF ?? '').trim();
  const pinOk = elekRef === ELEK_REF_VERIFIED;
  if (!pinOk) {
    addUnknown(
      'U1',
      `elek pin is "${elekRef || '(unset)'}"; the vendored packer is ${ELEK_REF_VERIFIED} and has not been re-verified against it. Re-vendor src/review/diff-context.ts at the new ref, update vendor/diff-context.manifest.json (upstream_commit + upstream_blob_sha), regenerate fixtures/golden/, and update the ELEK_REF literal in ai-code-review.yml. ELEK_REF_VERIFIED is READ from the manifest — never retype it, and there is no BUDGET constant to update (an earlier version of this message said there was).`,
    );
  }

  // ---- elek step outputs (U5) -----------------------------------------------------
  const requested =
    summary?.review?.requestedStrategy || (env.REQUESTED_STRATEGY ?? '').trim() || null;
  const executed =
    summary?.review?.executedStrategy || (env.EXECUTED_STRATEGY ?? '').trim() || null;
  const inputTokens = asPositiveInt(summary?.cost?.inputTokens ?? env.REVIEW_INPUT_TOKENS);
  const conclusion = summary?.run?.conclusion || (env.REVIEW_CONCLUSION ?? '').trim() || null;
  const costUsd = Number.isFinite(Number(summary?.cost?.usd ?? env.REVIEW_COST_USD))
    ? Number(summary?.cost?.usd ?? env.REVIEW_COST_USD)
    : null;
  const actor = summary?.entity?.actor || context.actor || '';
  const eventName = summary?.entity?.event || context.eventName || '';

  // EHAC-2162 / EHAC-2103 — per-lens ground truth. Recorded unconditionally; the asserter
  // re-derives its own verdict from `models.runs` rather than trusting the rollup below.
  const models = deriveModels(summary, env);

  // ---- NOT_REVIEWED precheck ------------------------------------------------------
  const notReviewed = computeNotReviewed({
    actorFilter: env.ACTOR_FILTER,
    actor,
    inputTokens,
    skipReason: env.SKIP_REASON,
  });

  if (!notReviewed) {
    if (inputTokens === null) {
      // EHAC-2099: name the elek conclusion here. "no evidence a prompt was built" is true
      // but reads as prompt-budget exhaustion, which is what it was first misdiagnosed as on
      // eha_care #3530 — the real cause was `conclusion: skipped`, i.e. elek declined at
      // detectTrigger and never looked at the diff. The conclusion is already in scope.
      //
      // Deliberately NOT routed to NOT_REVIEWED, however loudly `skipped` invites it:
      // computeNotReviewed above is derived from OUR OWN inputs and never from an empty elek
      // output precisely because that would be a fail-open. `skipped` is elek's own output,
      // so trusting it here would convert a correctly-red gate into a green one — the exact
      // inversion this gate exists to prevent. Exit code stays 1; only the message improves.
      addUnknown(
        'U5',
        `review input_tokens is absent or 0 — no evidence a review prompt was ever built (elek reported conclusion "${conclusion ?? 'unset'}"${conclusion === 'skipped' ? '; "skipped" means elek declined at trigger detection and never read the diff' : ''}).`,
      );
    }
    if (!executed) {
      addUnknown(
        'U5',
        'executed review strategy is unknown (no review_summary_json and no EXECUTED_STRATEGY) — the check name cannot be trusted.',
      );
    }
  }

  // ---- strategy downgrade (U3), Fault 5 -------------------------------------------
  if (requested && executed && requested !== executed) {
    addUnknown(
      'U3',
      `requested strategy "${requested}" but elek executed "${executed}" — the check name would report a strategy that did not run.`,
    );
  }

  // ---- empty diff vs a non-empty PR (U2) ------------------------------------------
  const changedFilesApi =
    context.changedFilesApi === null || context.changedFilesApi === undefined
      ? null
      : Number(context.changedFilesApi);
  // A non-empty exclusion set is PROOF the diff parsed: files can only be excluded after they
  // have been parsed out of it. So "zero reviewable files" with exclusions present is a
  // deliberately empty scope, not a missing diff, and U2's premise does not hold.
  //
  // Without this, a pull request that touches ONLY excluded paths measures zero files, trips
  // U2, and is blocked as UNKNOWN — with a message blaming getGitDiff for swallowing a failure
  // that never happened. That is precisely the pull request exclude_paths exists to serve, so
  // the feature would have red-lined its own primary use case.
  const excludedCount = attribution.excluded_files.length;
  if (attribution.rollup.files_total === 0 && excludedCount === 0) {
    addUnknown(
      'U2',
      changedFilesApi && changedFilesApi > 0
        ? `the measured diff contains 0 files while the pull request reports ${changedFilesApi} changed file(s) — elek's getGitDiff swallows git failures and returns an empty diff, which the lenses see as "(diff unavailable)".`
        : 'the measured diff contains 0 files and the pull-request changed-file count is unavailable — coverage cannot be established.',
    );
  }

  // ---- branch tip vs check-run SHA (U4) -------------------------------------------
  const headShaGit = context.headShaGit ?? null;
  const headShaEvent = context.headShaEvent ?? null;
  const shaMatch = headShaGit && headShaEvent ? headShaGit === headShaEvent : null;
  if (shaMatch === false) {
    addUnknown(
      'U4',
      `git rev-parse origin/${context.headRef ?? '(head)'} is ${headShaGit} but the pull-request head SHA is ${headShaEvent} — the review and the check run describe different trees.`,
    );
  }

  // ---- unparseable header paths (U6) ----------------------------------------------
  if (attribution.rollup.unknown_paths > 0) {
    addUnknown(
      'U6',
      `${attribution.rollup.unknown_paths} changed-file header(s) parsed as "(unknown)" — the inventory cannot claim to name every changed file.`,
    );
  }

  const effectiveUnknown = notReviewed ? unknown.filter((u) => u.branch === 'U1') : unknown;
  const verdict = computeVerdict({
    rollup: attribution.rollup,
    unknownReasons: effectiveUnknown,
    notReviewed,
  });

  const inventory = attribution.files.slice(0, inventoryCap).map((file) => ({
    path: file.path,
    priority: file.priority,
    status: file.status,
    patch_chars: file.patch_chars,
    shown_chars: file.shown_chars,
    pct: file.pct,
    verdict: file.verdict,
  }));

  return {
    schema: 1,
    verdict,
    not_reviewed: notReviewed,
    unknown_reasons: effectiveUnknown,
    elek: { ref: elekRef || null, ref_verified: ELEK_REF_VERIFIED, pin_ok: pinOk },
    strategy: { requested, executed, match: requested && executed ? requested === executed : null },
    refs: {
      base_ref: context.baseRef ?? null,
      head_ref: context.headRef ?? null,
      head_sha_git: headShaGit,
      head_sha_event: headShaEvent,
      sha_match: shaMatch,
      // Recorded, NOT escalated on its own: elek re-fetches --depth=100 over our
      // fetch-depth: 0 checkout, so a shallow marker may be entirely routine.
      shallow: context.shallow ?? null,
    },
    git_config: { ...GIT_CONFIG },
    diff: {
      chars: attribution.diff_chars,
      files_diff: attribution.rollup.files_total,
      changed_files_api: changedFilesApi,
      regime: attribution.regime,
      // R14. Formerly `per_file_budget`, which was elek's INTERNAL slice budget and could only
      // be published by restating its arithmetic in a second implementation (D-04). The packer
      // does not put that number in its output, so it is no longer claimed. What is measurable
      // is the largest slice that actually survived into the prompt, and that is what is
      // published: an observation rather than a recomputation.
      slice_ceiling_observed: attribution.slice_ceiling_observed,
      prompt_chars: attribution.prompt_chars,
      // WHICH budget produced this verdict, and where it came from. The budget is per-model
      // and reservation-aware, so a verdict is only interpretable alongside it; and
      // `budget_source` distinguishes a value the run REPORTED from the packer default we
      // fell back to. Without this an operator cannot tell a genuinely starved review from a
      // gate measuring against the wrong window.
      budget_chars: attribution.budget_chars_used,
      budget_source: attribution.budget_source,
      budget_lenses_reported: reported.lenses,
      exclude_paths: attribution.excluded_paths,
      excluded_files: attribution.excluded_files,
      // Reference-ranking anomalies (a changed path colliding with the ranking prefix, or a
      // reference that did not come back). Non-empty means a priority reading is not
      // trustworthy; recorded so it is visible rather than absorbed.
      ranking_anomalies: attribution.ranking_anomalies ?? [],
    },
    review: {
      conclusion,
      input_tokens: inputTokens,
      cost_usd: costUsd,
      actor: actor || null,
      event: eventName || null,
      // EHAC-2231. WHICH terminal path elek exited through, declared by elek rather than
      // inferred here from an empty output. Inferring a decline from an absence is the exact
      // fail-open computeNotReviewed() exists to avoid, so this is recorded as evidence and
      // NOT used to widen NOT_REVIEWED — that allowlist stays closed and stays ours.
      terminal_reason: typeof summary?.review?.terminalReason === 'string' ? summary.review.terminalReason : null,
      skip_reason: typeof summary?.review?.skipReason === 'string' && summary.review.skipReason !== ''
        ? summary.review.skipReason
        : null,
      failure_message: typeof summary?.review?.failureMessage === 'string' && summary.review.failureMessage !== ''
        ? summary.review.failureMessage
        : null,
    },
    models,
    rollup: attribution.rollup,
    inventory,
    inventory_truncated: attribution.files.length > inventory.length,
  };
}

/**
 * The single implementation of the coverage predicate (CONTEXT D-06). Both halves of the
 * gate call it, so they cannot disagree. Derived ONLY from rollup counts and branch data —
 * never from an upstream verdict string.
 *
 * @param {{rollup: Record<string, number>, unknownReasons: {branch:string}[], notReviewed: unknown}} args
 * @returns {'COMPLETE'|'PARTIAL_NON_SOURCE'|'PARTIAL_SOURCE'|'UNKNOWN'|'NOT_REVIEWED'}
 */
export function computeVerdict({ rollup, unknownReasons = [], notReviewed = null }) {
  if (unknownReasons.length > 0) return 'UNKNOWN';
  if (notReviewed) return 'NOT_REVIEWED';
  const n = (key) => {
    const value = rollup?.[key];
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  };
  if (n('source_partial') + n('source_absent') > 0) return 'PARTIAL_SOURCE';
  if (n('non_source_partial') + n('non_source_absent') > 0) return 'PARTIAL_NON_SOURCE';
  return 'COMPLETE';
}

/** Minimal always-emittable record for a measurement that could not complete. */
function unknownRecord(reasons, { env = {}, context = {} } = {}) {
  return {
    schema: 1,
    verdict: 'UNKNOWN',
    not_reviewed: null,
    unknown_reasons: reasons,
    elek: {
      ref: String(env.ELEK_REF ?? '').trim() || null,
      ref_verified: ELEK_REF_VERIFIED,
      pin_ok: String(env.ELEK_REF ?? '').trim() === ELEK_REF_VERIFIED,
    },
    strategy: { requested: null, executed: null, match: null },
    refs: {
      base_ref: context.baseRef ?? null,
      head_ref: context.headRef ?? null,
      head_sha_git: null,
      head_sha_event: null,
      sha_match: null,
      shallow: null,
    },
    git_config: { ...GIT_CONFIG },
    diff: {
      chars: null,
      files_diff: null,
      changed_files_api: null,
      regime: null,
      slice_ceiling_observed: null,
      prompt_chars: null,
      budget_chars: null,
      budget_source: null,
      budget_lenses_reported: 0,
      exclude_paths: [],
      excluded_files: [],
      ranking_anomalies: [],
    },
    review: {
      conclusion: null,
      input_tokens: null,
      cost_usd: null,
      actor: null,
      event: null,
      terminal_reason: null,
      skip_reason: null,
      failure_message: null,
    },
    // Shape-consistent with buildCoverage so the asserter never has to special-case which
    // producer path emitted the record. A null `runs` means "not measured", which the
    // asserter's U7 treats as unknown when a review demonstrably ran — never as a pass.
    models: {
      runs: null,
      attempts: null,
      configured: { review_models: [], validator_model: null },
      policy: derivePolicy(null, env),
      distinct_models: [],
      rollup: null,
    },
    rollup: null,
    inventory: [],
    inventory_truncated: false,
  };
}

/**
 * Render the FULL per-file inventory as a markdown table. Published regardless of verdict,
 * so softening the predicate later needs no new instrumentation.
 * @param {ReturnType<typeof buildCoverage>} coverage
 * @returns {string}
 */
export function renderJobSummary(coverage) {
  const lines = [
    '## AI Review Coverage',
    '',
    `**Verdict:** \`${coverage.verdict}\``,
    '',
    `| | |`,
    `|---|---|`,
    `| elek pin | \`${coverage.elek.ref ?? '(unset)'}\` (${coverage.elek.pin_ok ? 'verified' : '**UNVERIFIED**'}) |`,
    `| strategy | requested \`${coverage.strategy.requested ?? '?'}\` / executed \`${coverage.strategy.executed ?? '?'}\` |`,
    `| diff | ${coverage.diff.chars ?? '?'} utf8 units, ${coverage.diff.files_diff ?? '?'} file(s) |`,
    `| prompt regime | \`${coverage.diff.regime ?? '?'}\`${coverage.diff.slice_ceiling_observed ? `, largest surviving slice ${coverage.diff.slice_ceiling_observed} (observed)` : ''} |`,
    `| review input tokens | ${coverage.review.input_tokens ?? '(none)'} |`,
    `| shallow repository | ${coverage.refs.shallow === null ? 'unknown' : String(coverage.refs.shallow)} (recorded, not escalated) |`,
    '',
  ];

  if (coverage.not_reviewed) {
    lines.push(
      `> **NOT_REVIEWED** — \`${coverage.not_reviewed.reason}\` (actor \`${coverage.not_reviewed.actor ?? '?'}\`). No review was requested, so there is no coverage claim to audit.`,
      '',
    );
  }
  for (const reason of coverage.unknown_reasons ?? []) {
    lines.push(`> **${reason.branch}** — ${reason.message}`, '');
  }

  // EHAC-2103 — the truthful model attribution.
  //
  // elek's posted comment cannot be used to verify which models ran: redactInternalModelLabels
  // rewrites the validator's label to the primary model's, so GLM is not omitted from the
  // attribution but erased and misattributed, and the footer label compounds provider prefixes
  // (`openrouter/openrouter/deepseek/openrouter/deepseek/deepseek-v4-pro`). That is upstream in
  // elek and not fixable from here. `modelRuns[]` in the same run's review_summary_json is the
  // unmangled ground truth, so this table — not the comment — is the evidence that N distinct
  // models actually reviewed the PR.
  const models = coverage.models ?? null;
  if (Array.isArray(models?.runs) && models.runs.length > 0) {
    lines.push(
      '### Model attribution (ground truth, from `review_summary_json.modelRuns`)',
      '',
      '_The posted review comment misreports these — see EHAC-2103. This table is authoritative._',
      '',
      '| Role | Lens | Model | Result |',
      '|---|---|---|---|',
    );
    for (const r of models.runs) {
      const ok = r.conclusion === 'success';
      lines.push(
        `| \`${r.role ?? '?'}\` | \`${r.lens_id ?? '—'}\` | \`${r.model_label ?? '?'}\` | ${ok ? 'success' : `**${r.conclusion ?? 'no conclusion'}**`} |`,
      );
    }
    lines.push(
      '',
      `**Distinct models observed:** ${models.distinct_models.length} — ${models.distinct_models.map((m) => `\`${m}\``).join(', ')}`,
      '',
    );
    // Configured vs observed is REPORTED, not asserted. elek's modelLabelFor prefixes the
    // provider for bare ids while leaving already-qualified ones alone, and council lens
    // labels come from usage.modelLabel, so a set comparison would emit false reds until the
    // real label forms have been measured across a range of PRs. Stage 2 of EHAC-2103 turns
    // this into an assertion against measured strings; shipping it as one today is how a gate
    // earns a reputation for crying wolf and gets switched off.
    const configured = models.configured ?? { review_models: [], validator_model: null };
    const configuredAll = [...configured.review_models, configured.validator_model].filter(Boolean);
    if (configuredAll.length > 0) {
      lines.push(
        `**Configured:** ${configuredAll.map((m) => `\`${m}\``).join(', ')} — reported for comparison only; not yet asserted (EHAC-2103 stage 2).`,
        '',
      );
    }
  }

  if ((coverage.inventory ?? []).length > 0) {
    lines.push('| File | Priority | Diff chars | Shown | % | Verdict |', '|---|---:|---:|---:|---:|---|');
    for (const row of coverage.inventory) {
      lines.push(
        `| \`${row.path}\` | ${row.priority} | ${row.patch_chars} | ${row.shown_chars} | ${row.pct}% | ${row.verdict} |`,
      );
    }
    if (coverage.inventory_truncated) {
      lines.push('', `_Inventory capped at ${coverage.inventory.length} rows; rollup counts cover all files._`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

/** Read a flag value from argv, e.g. `--diff-file path`. */
function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** execFileSync with an args array — never a shell string, so refnames cannot inject. */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function gitConfigArgs() {
  return Object.entries(GIT_CONFIG).flatMap(([key, value]) => ['-c', `${key}=${value}`]);
}

/** Resolve the PR facts from the event payload, or from the API on the comment path. */
function resolvePullRequestContext(env) {
  const eventName = env.GITHUB_EVENT_NAME ?? '';
  const repo = env.GITHUB_REPOSITORY ?? null;
  let event = {};
  if (env.GITHUB_EVENT_PATH) {
    try {
      event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    } catch {
      event = {};
    }
  }

  let pr = event.pull_request ?? null;
  if (!pr) {
    const number = event.issue?.number ?? event.pull_request?.number ?? null;
    if (repo && number) {
      try {
        pr = JSON.parse(
          execFileSync('gh', ['api', `repos/${repo}/pulls/${number}`], {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
          }),
        );
      } catch {
        pr = null;
      }
    }
  }

  return {
    repo,
    eventName,
    actor: env.GITHUB_ACTOR ?? '',
    prNumber: pr?.number ?? null,
    baseRef: pr?.base?.ref ?? null,
    headRef: pr?.head?.ref ?? null,
    headShaEvent: pr?.head?.sha ?? null,
    changedFilesApi: Number.isFinite(Number(pr?.changed_files)) ? Number(pr.changed_files) : null,
  };
}

async function main(argv, env) {
  const diffFile = argValue(argv, '--diff-file');
  // `--diff-file` is EXPLICIT offline/fixture mode. It must never be inferred from
  // `GITHUB_OUTPUT` being unset: GitHub Actions always sets GITHUB_OUTPUT, so keying off it
  // silently swallowed the JSON when the CI proof step ran the fixture (caught by
  // `Coverage Gate Tests` on PR #5). Offline mode prints to stdout and writes NO job output.
  const offline = Boolean(diffFile);
  let diffText;
  let context = {};

  if (diffFile) {
    // Offline mode: measure a fixture exactly as CI would, with no git and no API calls.
    diffText = readFileSync(diffFile, 'utf8');
    context = {
      baseRef: env.BASE_REF ?? null,
      headRef: env.HEAD_REF ?? null,
      headShaGit: null,
      headShaEvent: null,
      changedFilesApi: null,
      shallow: null,
      actor: env.GITHUB_ACTOR ?? '',
      eventName: env.GITHUB_EVENT_NAME ?? '',
    };
    // A fixture is an explicit, non-empty input; its own file count is the API count.
    context.changedFilesApi = null;
  } else {
    const pr = resolvePullRequestContext(env);
    let headShaGit = null;
    let shallow = null;
    try {
      diffText = git([
        ...gitConfigArgs(),
        'diff',
        `origin/${pr.baseRef}...origin/${pr.headRef}`,
      ]);
    } catch (err) {
      diffText = '';
      process.stderr.write(`[ai-review-coverage] git diff failed: ${err?.message ?? err}\n`);
    }
    try {
      headShaGit = git(['rev-parse', `origin/${pr.headRef}`]).trim();
    } catch {
      headShaGit = null;
    }
    try {
      shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
    } catch {
      shallow = null;
    }
    context = { ...pr, headShaGit, shallow };
  }

  const coverage = buildCoverage({ diffText, env, context });

  if (!offline && env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, renderJobSummary(coverage));
    } catch (err) {
      process.stderr.write(`[ai-review-coverage] job summary write failed: ${err?.message ?? err}\n`);
    }
  }

  const oneLine = JSON.stringify(coverage);
  if (!offline && env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `coverage_json=${oneLine}\n`);
  } else {
    // Offline / fixture mode: stdout carries ONLY the JSON so `JSON.parse "$(...)"` works,
    // even when GITHUB_OUTPUT is set (it always is, inside Actions).
    process.stdout.write(`${oneLine}\n`);
  }
}

const invokedDirectly =
  process.argv[1] && basename(process.argv[1]) === 'measure-review-coverage.mjs';
if (invokedDirectly) {
  main(process.argv.slice(2), process.env).catch((err) => {
    // Even a catastrophic failure must emit a record and exit 0 — the asserting half
    // turns UNKNOWN into the red. Exiting non-zero here would fail the review job itself.
    const coverage = unknownRecord([
      { branch: 'U5', message: `measure-review-coverage crashed: ${err?.message ?? err}` },
    ]);
    const oneLine = JSON.stringify(coverage);
    try {
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `coverage_json=${oneLine}\n`);
      } else {
        process.stdout.write(`${oneLine}\n`);
      }
    } catch {
      /* nothing further we can do; the gate reds on a missing coverage_json */
    }
    process.stderr.write(`[ai-review-coverage] ${err?.message ?? err}\n`);
  });
}
