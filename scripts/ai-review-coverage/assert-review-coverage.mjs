#!/usr/bin/env node
/**
 * assert-review-coverage.mjs — ASSERTING half of the `AI Review Coverage` gate (EHAC-2057).
 *
 * Runs in the separate `coverage-gate` job (`needs: review`, `if: always()`, no
 * error-suppression key) and turns the coverage record into an exit code, which is the only
 * thing GitHub converts into a check conclusion.
 *
 * IT DOES NOT TRUST THE UPSTREAM VERDICT STRING. Every UNKNOWN branch U1-U7 is
 * INDEPENDENTLY RE-DERIVED from the coverage record's own fields, and the PARTIAL/COMPLETE
 * verdict is RECOMPUTED from the rollup counts. Feeding it `verdict: "COMPLETE"` alongside
 * `source_partial: 1` still exits 1. A gate that rubber-stamps a verdict it was handed is
 * the same class of defect as the review that reported green on a diff it never saw.
 *
 * | Verdict | Trigger | Exit |
 * |---|---|---|
 * | COMPLETE            | every changed file WHOLE                            | 0 |
 * | PARTIAL_NON_SOURCE  | only priority >= 1 files PARTIAL/ABSENT              | 0 + ::warning:: |
 * | PARTIAL_SOURCE      | any priority 0 file PARTIAL/ABSENT                   | 1 + ::error:: |
 * | UNKNOWN             | any branch U1-U7                                    | 1 |
 * | NOT_REVIEWED        | deterministic, allowlisted reason only               | 0 + ::warning:: |
 * | —                   | needs.review.result in {failure,cancelled,skipped}   | 1 |
 *
 * Branches, and the defect each one exists to catch:
 *   U1 elek pin drift        U2 empty/unmeasured diff      U3 strategy downgrade
 *   U4 head-SHA mismatch     U5 record structurally incomplete / no prompt built
 *   U6 unparseable file header
 *   U7 a council model run that did not succeed (EHAC-2162) — the aggregate
 *      `review.conclusion` can say "success" while individual lenses failed.
 *
 * It never posts a PR comment: elek's sticky comment is the review surface.
 *
 * Usage:
 *   REVIEW_RESULT="${{ needs.review.result }}" \
 *   COVERAGE_JSON='${{ needs.review.outputs.coverage_json }}' \
 *     node assert-review-coverage.mjs
 */

import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';

import { ELEK_REF_VERIFIED } from './elek-prompt-budget.mjs';
import { NOT_REVIEWED_REASONS, computeVerdict } from './measure-review-coverage.mjs';

/** needs.<job>.result values that mean there is no coverage evidence to audit. */
const BROKEN_REVIEW_RESULTS = new Set(['failure', 'cancelled', 'skipped']);

const out = (line) => process.stdout.write(`${line}\n`);
const error = (message) => out(`::error::${message}`);
const warning = (message) => out(`::warning::${message}`);

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

/**
 * Independently re-derive every UNKNOWN branch from the coverage record's own fields, then
 * union that with any branch the producer recorded. Re-derivation is what makes this half
 * genuinely independent of the producer's judgement.
 *
 * @param {any} coverage
 * @returns {{branch: string, message: string}[]}
 */
export function deriveUnknownBranches(coverage) {
  /** @type {{branch: string, message: string}[]} */
  const found = [];
  const add = (branch, message) => found.push({ branch, message });

  // U1 — elek pin drift.
  const ref = coverage?.elek?.ref ?? null;
  if (ref !== ELEK_REF_VERIFIED) {
    add(
      'U1',
      `U1 elek pin drift: coverage was measured at elek ref "${ref ?? '(unset)'}" but the prompt-budget model is only verified against ${ELEK_REF_VERIFIED}.`,
    );
  }

  // U5 — structural completeness of the record itself.
  if (!coverage?.rollup || typeof coverage.rollup !== 'object') {
    add('U5', 'U5 coverage record carries no rollup block — the measurement did not complete.');
  }

  const notReviewed = coverage?.not_reviewed ?? null;
  if (!notReviewed) {
    const inputTokens = num(coverage?.review?.input_tokens);
    if (inputTokens === null || inputTokens <= 0) {
      // EHAC-2099: include the elek conclusion the record already carries. The bare message
      // reads as prompt-budget exhaustion and was misdiagnosed that way on eha_care #3530,
      // where the true cause was `conclusion: "skipped"` — elek declined at detectTrigger
      // and never read the diff. Naming it turns a ~40-minute investigation into one line.
      //
      // Still UNKNOWN, still exit 1. `skipped` is elek's OWN output, and treating an empty
      // elek output as a deliberate decline is the fail-open that computeNotReviewed
      // (measure-review-coverage.mjs) exists to avoid; routing it to NOT_REVIEWED would turn
      // this correctly-red gate green.
      const conclusion = coverage?.review?.conclusion ?? null;
      const hint =
        conclusion === 'skipped'
          ? ' — "skipped" means elek declined at trigger detection (no trigger phrase in the PR body, or the actor was not allowed) and never read the diff'
          : '';
      add(
        'U5',
        `U5 review input_tokens is absent or 0 — there is no evidence a review prompt was ever built (elek reported conclusion "${conclusion ?? 'unset'}"${hint}).`,
      );
    }
  }

  // U2 — empty (or unmeasured) diff while the PR reports changed files.
  //
  // EHAC-2164: `num()` returns null for an absent field, and `null === 0` is false. The
  // original `filesDiff === 0` therefore let a record that carries a valid rollup but no
  // `diff.files_diff` slip past U2 entirely; U5's rollup check then passed and computeVerdict
  // returned COMPLETE with exit 0. A MISSING value read as a PASS — the one construct in this
  // gate where absence was treated as evidence of health.
  //
  // Absent and zero are different facts and are reported as such, but both are unknowns: we
  // cannot establish coverage from either. This matches the fail-closed doctrine the rest of
  // this file already follows (empty/unparseable COVERAGE_JSON is exit 1, not a pass).
  const filesDiff = num(coverage?.diff?.files_diff);
  const changedApi = num(coverage?.diff?.changed_files_api);
  if ((filesDiff === null || filesDiff === 0) && (changedApi === null || changedApi > 0)) {
    const measured =
      filesDiff === null
        ? 'the coverage record does not report a measured file count'
        : 'the measured diff contains 0 files';
    add(
      'U2',
      `U2 ${measured}${changedApi ? ` while the pull request reports ${changedApi} changed file(s)` : ' and the pull-request changed-file count is unavailable'} — coverage cannot be established.`,
    );
  }

  // U3 — executed strategy differs from requested (Fault 5). Derived from the pair itself,
  // never from the record's own `match` boolean.
  const requested = coverage?.strategy?.requested ?? null;
  const executed = coverage?.strategy?.executed ?? null;
  if (requested && executed && requested !== executed) {
    add(
      'U3',
      `U3 requested review strategy "${requested}" but elek executed "${executed}" — the check name reports a strategy that did not run.`,
    );
  }

  // U4 — branch tip vs check-run head SHA.
  const shaGit = coverage?.refs?.head_sha_git ?? null;
  const shaEvent = coverage?.refs?.head_sha_event ?? null;
  if (shaGit && shaEvent && shaGit !== shaEvent) {
    add(
      'U4',
      `U4 the reviewed branch tip (${shaGit}) is not the pull-request head SHA (${shaEvent}) — the review and the check run describe different trees.`,
    );
  }

  // U6 — a changed-file path that would not parse.
  const unknownPaths = num(coverage?.rollup?.unknown_paths);
  if (unknownPaths !== null && unknownPaths > 0) {
    add(
      'U6',
      `U6 ${unknownPaths} changed-file header(s) parsed as "(unknown)" — the inventory cannot claim to name every changed file.`,
    );
  }

  // U7 — a council lens that did not succeed (EHAC-2162).
  //
  // The gate previously audited only the AGGREGATE `review.conclusion`. On eha_care PR #3564
  // (run 31223046934) the `tests` reviewer lens and `validator-self-review` BOTH returned
  // conclusion "failure", the validator reconciled anyway, and the check reported "analysis
  // complete" with full diff coverage. A 3-lens council that ran 2 lenses is the same defect
  // as U3 — the check name reports work that did not happen — so it reds for the same reason.
  //
  // Re-derived from `models.runs` here rather than read from `models.rollup`, consistent with
  // every other branch in this function: the producer's own arithmetic is never the authority.
  const notReviewedForModels = coverage?.not_reviewed ?? null;
  if (!notReviewedForModels) {
    const runs = coverage?.models?.runs ?? null;
    const inputTokensForModels = num(coverage?.review?.input_tokens);
    if (!Array.isArray(runs)) {
      // Absent modelRuns is only an unknown when a review demonstrably ran. Records from
      // before this field existed, or from a genuinely skipped review, are already covered by
      // U5 and must not be double-reported here.
      if (inputTokensForModels !== null && inputTokensForModels > 0) {
        add(
          'U7',
          'U7 the review reported input tokens but the coverage record carries no per-lens model runs — which models actually ran cannot be established.',
        );
      }
    } else {
      const failedRuns = runs.filter((r) => r?.conclusion !== 'success');
      if (failedRuns.length > 0) {
        const named = failedRuns
          .map((r) => `${r?.lens_id ?? r?.role ?? '(unknown)'} (${r?.model_label ?? 'unknown model'} -> ${r?.conclusion ?? 'no conclusion'})`)
          .join(', ');
        add(
          'U7',
          `U7 ${failedRuns.length} of ${runs.length} council model run(s) did not succeed: ${named}. The review is degraded — part of the council never returned, so the check name overstates the work performed.`,
        );
      }
    }
  }

  // Union with what the producer recorded, de-duplicated by message.
  const seen = new Set(found.map((f) => f.message));
  for (const reason of coverage?.unknown_reasons ?? []) {
    const branch = reason?.branch ?? 'U5';
    const message = `${branch} ${reason?.message ?? 'unknown reason'}`;
    if (!seen.has(message)) {
      seen.add(message);
      found.push({ branch, message });
    }
  }

  return found;
}

/**
 * Apply the coverage contract. Pure: returns the exit code and the lines to print, so the
 * decision is unit-testable without a process.
 *
 * @param {{reviewResult: string|undefined, coverageRaw: string|undefined}} args
 * @returns {{exitCode: number, verdict: string, lines: string[], summary: string[]}}
 */
export function evaluate({ reviewResult, coverageRaw }) {
  const lines = [];
  const summary = ['## AI Review Coverage — gate', ''];
  const result = String(reviewResult ?? '').trim();

  // 1. The review job itself.
  if (result === '') {
    lines.push(
      '::error::needs.review.result was not provided to the coverage gate — failing closed.',
    );
    summary.push('**UNKNOWN** — `needs.review.result` was not provided.');
    return { exitCode: 1, verdict: 'UNKNOWN', lines, summary };
  }
  if (BROKEN_REVIEW_RESULTS.has(result)) {
    lines.push(
      `::error::the AI review job reported "${result}", so it produced no coverage evidence. A review that did not complete cannot certify that every changed file was inspected.`,
    );
    summary.push(`**UNKNOWN** — the review job reported \`${result}\`.`);
    return { exitCode: 1, verdict: 'UNKNOWN', lines, summary };
  }

  // 2. The coverage record must exist and parse.
  const raw = String(coverageRaw ?? '').trim();
  if (raw === '') {
    lines.push(
      '::error::U5 COVERAGE_JSON is empty or missing — the review job did not export a coverage record. Failing closed: an unmeasured review is not a passing review.',
    );
    summary.push('**UNKNOWN (U5)** — `coverage_json` was empty or missing.');
    return { exitCode: 1, verdict: 'UNKNOWN', lines, summary };
  }
  let coverage;
  try {
    coverage = JSON.parse(raw);
  } catch (err) {
    lines.push(`::error::U5 COVERAGE_JSON did not parse: ${err?.message ?? err}`);
    summary.push('**UNKNOWN (U5)** — `coverage_json` did not parse.');
    return { exitCode: 1, verdict: 'UNKNOWN', lines, summary };
  }

  // 3. NOT_REVIEWED — the single deliberate exit-0-without-coverage branch. Reached only
  //    from the producer's own deterministic actor/event computation, and only for a reason
  //    in the closed allowlist. Anything else falls through to UNKNOWN.
  const notReviewed = coverage?.not_reviewed ?? null;
  if (notReviewed) {
    const reason = notReviewed?.reason ?? '';
    if (!NOT_REVIEWED_REASONS.includes(reason)) {
      lines.push(
        `::error::UNKNOWN the coverage record claims NOT_REVIEWED with reason "${reason || '(none)'}", which is outside the closed allowlist [${NOT_REVIEWED_REASONS.join(', ')}]. Failing closed.`,
      );
      summary.push(`**UNKNOWN** — non-allowlisted \`NOT_REVIEWED\` reason \`${reason}\`.`);
      return { exitCode: 1, verdict: 'UNKNOWN', lines, summary };
    }
  }

  // 4. Re-derive every UNKNOWN branch from the record's own fields.
  const derived = deriveUnknownBranches(coverage);
  const effective = notReviewed ? derived.filter((d) => d.branch === 'U1') : derived;

  // 5. Recompute the verdict from the rollup counts — never trust coverage.verdict.
  const verdict = computeVerdict({
    rollup: coverage?.rollup ?? {},
    unknownReasons: effective,
    notReviewed,
  });

  if (coverage?.verdict && coverage.verdict !== verdict) {
    lines.push(
      `::warning::the coverage record reported verdict "${coverage.verdict}" but the gate recomputed "${verdict}" from the rollup counts. The recomputed verdict is authoritative.`,
    );
  }

  summary.push(`**Recomputed verdict:** \`${verdict}\``, '');

  if (verdict === 'UNKNOWN') {
    for (const branch of effective) {
      lines.push(`::error::UNKNOWN ${branch.message}`);
      summary.push(`- **${branch.branch}** — ${branch.message}`);
    }
    return { exitCode: 1, verdict, lines, summary };
  }

  if (verdict === 'NOT_REVIEWED') {
    lines.push(
      `::warning::NOT_REVIEWED — ${notReviewed.reason} (actor "${notReviewed.actor ?? '?'}"). No review was requested, so there is no coverage claim to audit. This is the one deliberate exit-0-without-coverage branch; widening its reason allowlist is a promotion-time decision.`,
    );
    summary.push(`> No review was requested (\`${notReviewed.reason}\`).`);
    return { exitCode: 0, verdict, lines, summary };
  }

  const inventory = Array.isArray(coverage?.inventory) ? coverage.inventory : [];
  const cutSource = inventory.filter(
    (row) => num(row?.priority) === 0 && (row?.verdict === 'PARTIAL' || row?.verdict === 'ABSENT'),
  );

  if (verdict === 'PARTIAL_SOURCE') {
    lines.push(
      `::error::PARTIAL_SOURCE — ${num(coverage?.rollup?.source_partial) ?? 0} production-source file(s) were only partially shown to the reviewer and ${num(coverage?.rollup?.source_absent) ?? 0} were absent entirely. A review that never saw the code cannot certify it.`,
    );
    for (const row of cutSource) {
      lines.push(
        `::error file=${row.path},line=1,title=AI review coverage::${row.verdict}: ${row.shown_chars} of ${row.patch_chars} diff characters (${row.pct}%) reached the review prompt.`,
      );
      summary.push(
        `- \`${row.path}\` — **${row.verdict}**, ${row.shown_chars}/${row.patch_chars} chars (${row.pct}%)`,
      );
    }
    if (cutSource.length === 0) {
      // Rollup says source was cut but the inventory does not name the file (capped
      // inventory, or a producer bug). Still red — the counts are authoritative.
      summary.push(
        '- the rollup reports cut production-source files that the published inventory does not name (inventory capped, or a producer defect).',
      );
    }
    return { exitCode: 1, verdict, lines, summary };
  }

  if (verdict === 'PARTIAL_NON_SOURCE') {
    lines.push(
      `::warning::PARTIAL_NON_SOURCE — ${num(coverage?.rollup?.non_source_partial) ?? 0} partial and ${num(coverage?.rollup?.non_source_absent) ?? 0} absent file(s), all tests/fixtures/docs/workflows. No production-source file was cut, so this is advisory.`,
    );
    summary.push('> Only tests/fixtures/docs/workflows were cut. Advisory only.');
    return { exitCode: 0, verdict, lines, summary };
  }

  lines.push(
    `::notice::COMPLETE — all ${num(coverage?.rollup?.files_total) ?? 0} changed file(s) reached the review prompt in full.`,
  );
  summary.push('> Every changed file reached the review prompt in full.');
  return { exitCode: 0, verdict, lines, summary };
}

/* ────────────────────────────────────────────────────────────────────────────────────────
 * R12 — VERDICT BUCKETING, across a SET of review records (EHAC-2165).
 *
 * WHAT THIS DETECTS: a review record set whose aggregate reads partly healthy because the
 * greens in it are of a DIFFERENT KIND from the reds. From 2026-08-09 a newly published
 * `pi-ai` broke elek's floating `pi install npm:pi-mcp-adapter || true`, killing AI review
 * org-wide — eleven consecutive failures across six branches, invisible for ~16 HOURS,
 * because every green in the window was a declined-bot NOT_REVIEWED record. Nobody was
 * lying; the arithmetic was. Failures were being averaged against successes that were not
 * successes of the same thing.
 *
 * WHAT THIS DOES NOT DETECT, AND CANNOT: the CAUSE. The offending install lives inside the
 * third-party action's own composite steps, `v1.1.4` ships no lockfile of any kind, and no
 * action input reaches it — there is NO caller-side lever at the pinned version. The durable
 * hermetic fix re-points at EHAC-2059, which is deferred. The existing workaround (the
 * plugin is disabled) remains load-bearing: do not remove it believing the install was
 * repaired, because it was not.
 *
 * BUCKET BY VERDICT, NEVER BY CONCLUSION. A declined bot record carries conclusion
 * "skipped", and so does a review that died before it started. The verdict is the only field
 * that distinguishes them, and membership is decided by a FIELD ON EACH RECORD — never
 * inferred from another bucket being empty, which is the inference that produced the outage.
 *
 * | Bucket     | Membership                                                                  |
 * |------------|-----------------------------------------------------------------------------|
 * | `real`     | the verdict names a review that EXECUTED and produced a coverage judgement   |
 * | `declined` | verdict NOT_REVIEWED **and** a reason in the closed allowlist                |
 * | `unknown`  | anything else: verdict absent, empty, unrecognised, or NOT_REVIEWED with an   |
 * |            | unrecognised or missing reason — a record that declares NOTHING              |
 *
 * `unknown` is the DISCRIMINATOR, and it is the whole repair. A declined-only run and a
 * total outage share a shape — an empty `real` bucket — and differ only by whether every
 * non-real record positively explained itself. An earlier draft of this rule reasoned from
 * bucket emptiness alone and therefore required a declined-only set to exit both 0 and
 * non-zero. Two reviewers derived that contradiction independently. Do not reintroduce it.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/** Verdicts that mean a review ran and the gate judged its coverage. */
export const REAL_REVIEW_VERDICTS = Object.freeze([
  'COMPLETE',
  'PARTIAL_NON_SOURCE',
  'PARTIAL_SOURCE',
  'UNKNOWN',
]);

/** The subset of the above that means the review both ran AND certified its coverage. */
export const PASSING_REAL_VERDICTS = Object.freeze(['COMPLETE', 'PARTIAL_NON_SOURCE']);

/**
 * The two reason tokens. DISTINCT on purpose: "every review we ran failed" and "we cannot
 * tell whether a review happened" need different investigations, and one token for both
 * sends the next person to the wrong place.
 */
export const BUCKET_TOKENS = Object.freeze({
  allFailed: 'REVIEW_SET_ALL_REAL_REVIEWS_FAILED',
  unknown: 'REVIEW_SET_UNKNOWN',
});

/**
 * Partition review records into the three disjoint buckets. Every record lands in exactly
 * one, decided by its own fields.
 *
 * @param {any[]} records
 * @returns {{real: any[], declined: any[], unknown: any[]}}
 */
export function bucketReviewRecords(records) {
  const real = [];
  const declined = [];
  const unknown = [];
  for (const record of Array.isArray(records) ? records : []) {
    const verdict = typeof record?.verdict === 'string' ? record.verdict.trim() : '';
    if (REAL_REVIEW_VERDICTS.includes(verdict)) {
      real.push(record);
    } else if (verdict === 'NOT_REVIEWED' && NOT_REVIEWED_REASONS.includes(record?.not_reviewed?.reason)) {
      // Positively declares WHY no review happened. That declaration is the only thing
      // separating this record from an outage record, so it is required, not assumed.
      declined.push(record);
    } else {
      unknown.push(record);
    }
  }
  return { real, declined, unknown };
}

/**
 * Apply the four-state contract to a record set. Pure: returns the exit code and the lines
 * to print. The states are TOTAL and DISJOINT — every payload matches exactly one.
 *
 * | # | Condition                                                    | Exit | Token     |
 * |---|--------------------------------------------------------------|------|-----------|
 * | 1 | `real` non-empty and EVERY real record failed                 | 1    | allFailed |
 * | 2 | `real` non-empty and at least one real record passed          | 0    | none      |
 * | 3 | `real` empty and (`unknown` non-empty OR `declined` empty)     | 1    | unknown   |
 * | 4 | `real` empty and `unknown` empty and `declined` non-empty      | 0    | none      |
 *
 * State 3's second clause is what stops an EMPTY record set reading as healthy: nothing
 * examined is not the same as nothing wrong. `reportedCount` closes the other half — a read
 * that returned fewer records than the run says it has is a TRUNCATED read, which is a
 * failure to look, not an absence of findings.
 *
 * @param {any[]} records
 * @param {{reportedCount?: number}} [options]
 * @returns {{exitCode: number, state: string, token: string|null, lines: string[], summary: string[]}}
 */
export function evaluateRecordSet(records, { reportedCount } = {}) {
  const lines = [];
  const summary = ['## AI Review Coverage — review record set', ''];
  const list = Array.isArray(records) ? records : [];
  const { real, declined, unknown } = bucketReviewRecords(list);

  const declaredCount = num(reportedCount);
  const truncated = declaredCount !== null && declaredCount > list.length;

  summary.push(
    `Buckets — real: ${real.length}, declined: ${declined.length}, unknown: ${unknown.length}.`,
    '',
  );

  // State 1 — the outage shape. Reviews ran; every one of them failed. Any greens present
  // are declined records, which are not successes of the same kind and must not offset it.
  if (real.length > 0 && !real.some((r) => PASSING_REAL_VERDICTS.includes(r?.verdict))) {
    const named = real.map((r) => `${r?.id ?? r?.run_id ?? '(unnamed)'}: ${r?.verdict}`).join(', ');
    lines.push(
      `::error::${BUCKET_TOKENS.allFailed} all ${real.length} real review record(s) failed, while ${declined.length} declined record(s) reported green. The aggregate reads partly healthy because the greens are of a DIFFERENT KIND. Failing bucket: real (${named}).`,
    );
    summary.push(`**${BUCKET_TOKENS.allFailed}** — every real review failed.`);
    return { exitCode: 1, state: 'ACTIVE-FAILING', token: BUCKET_TOKENS.allFailed, lines, summary };
  }

  // State 2 — at least one review ran and certified. Healthy.
  if (real.length > 0) {
    lines.push(
      `::notice::${real.length} real review record(s), at least one of which succeeded; ${declined.length} declined, ${unknown.length} unknown.`,
    );
    summary.push('> At least one real review succeeded.');
    return { exitCode: 0, state: 'ACTIVE-HEALTHY', token: null, lines, summary };
  }

  // State 3 — no review demonstrably ran, and something failed to explain itself. Absence of
  // evidence is not evidence of health.
  if (unknown.length > 0 || declined.length === 0 || truncated) {
    const why = truncated
      ? `the run reports ${declaredCount} record(s) but only ${list.length} were read — a truncated read is a failure to look, never an absence of findings`
      : unknown.length > 0
        ? `${unknown.length} record(s) declare no recognised verdict or reason, so whether a review happened cannot be established`
        : 'the record set is empty — nothing was examined, which is not the same as nothing being wrong';
    lines.push(`::error::${BUCKET_TOKENS.unknown} no real review records are present and ${why}.`);
    summary.push(`**${BUCKET_TOKENS.unknown}** — ${why}.`);
    return { exitCode: 1, state: 'UNKNOWN', token: BUCKET_TOKENS.unknown, lines, summary };
  }

  // State 4 — every record positively declared a recognised reason for not being reviewed.
  // Healthy, and it MUST be: reporting this would red every dependency-bot pull request, and
  // a rule that reds every bot PR is switched off within a week. The single-record path
  // already handles this case, so reporting here would also double-report it.
  lines.push(
    `::notice::no review was requested on any of the ${declined.length} record(s); every one declares a recognised reason.`,
  );
  summary.push('> Declined-only: every record declares a recognised reason.');
  return { exitCode: 0, state: 'DECLINED-ONLY', token: null, lines, summary };
}

const invokedDirectly =
  process.argv[1] && basename(process.argv[1]) === 'assert-review-coverage.mjs';
if (invokedDirectly && process.env.REVIEW_RECORD_SET_JSON !== undefined) {
  // R12 mode: audit a SET of review records rather than one run's coverage.
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(process.env.REVIEW_RECORD_SET_JSON);
  } catch (err) {
    parseError = err?.message ?? String(err);
  }
  if (parseError !== null) {
    out(
      `::error::${BUCKET_TOKENS.unknown} REVIEW_RECORD_SET_JSON did not parse (${parseError}). Failing closed: a record set we could not read is not a record set with nothing in it.`,
    );
    process.exit(1);
  }
  const records = Array.isArray(parsed) ? parsed : parsed?.records;
  const { exitCode, state, lines } = evaluateRecordSet(records, {
    reportedCount: Array.isArray(parsed) ? undefined : parsed?.reported_count,
  });
  out(`AI Review record set state: ${state}`);
  for (const line of lines) out(line);
  process.exit(exitCode);
} else if (invokedDirectly) {
  const { exitCode, verdict, lines, summary } = evaluate({
    reviewResult: process.env.REVIEW_RESULT,
    coverageRaw: process.env.COVERAGE_JSON,
  });
  out(`AI Review Coverage verdict: ${verdict}`);
  for (const line of lines) out(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
    } catch (err) {
      process.stderr.write(`[ai-review-coverage] job summary write failed: ${err?.message ?? err}\n`);
    }
  }
  process.exit(exitCode);
}
