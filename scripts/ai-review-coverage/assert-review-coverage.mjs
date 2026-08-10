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

const invokedDirectly =
  process.argv[1] && basename(process.argv[1]) === 'assert-review-coverage.mjs';
if (invokedDirectly) {
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
