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
 *   U8 producer/gate council-policy drift (EHAC-2231) — the tolerance the review job was
 *      given is not the tolerance this gate was given, so the two halves are enforcing
 *      different policies while both could report success
 *   U7 the council did not reach QUORUM (EHAC-2162; quorum rule EHAC-2231) — the aggregate
 *      `review.conclusion` can say "success" while individual lenses failed. Up to
 *      `COUNCIL_MAX_DEGRADED` (default 1) reviewer lenses may drop with a ::warning:: and
 *      exit 0; a failed validator, a wiped reviewer panel, or an unclassifiable failed run
 *      still reds.
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
import {
  NOT_REVIEWED_REASONS,
  REVIEWER_ROLES,
  VALIDATOR_ROLES,
  computeVerdict,
} from './measure-review-coverage.mjs';

/** needs.<job>.result values that mean there is no coverage evidence to audit. */
const BROKEN_REVIEW_RESULTS = new Set(['failure', 'cancelled', 'skipped']);

const out = (line) => process.stdout.write(`${line}\n`);
const error = (message) => out(`::error::${message}`);
const warning = (message) => out(`::warning::${message}`);

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

/**
 * Reviewer lenses that may drop while the council still counts as having reviewed.
 *
 * 1, not 0, because a council is a REDUNDANCY mechanism and unanimity-of-availability throws
 * that redundancy away (see `deriveCouncilQuorum`). 1, not 2, because two simultaneous
 * dropouts out of four reviewer lenses is half the panel — at that point the check name
 * genuinely does overstate the work.
 */
export const DEFAULT_COUNCIL_MAX_DEGRADED = 1;

/**
 * Read the degraded-lens tolerance from the environment, failing CLOSED on anything
 * unreadable. An unparseable or negative value becomes 0 (unanimity) rather than the default:
 * a misconfigured knob must never widen what the gate tolerates.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {number}
 */
export function readCouncilMaxDegraded(env = {}) {
  const raw = env.COUNCIL_MAX_DEGRADED;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_COUNCIL_MAX_DEGRADED;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * Decide whether the council reached quorum, and how loudly to say so.
 *
 * WHY A QUORUM AND NOT UNANIMITY. This branch used to red whenever ANY of the runs did not
 * succeed. That scores a redundancy mechanism as a serial reliability chain: with 6 runs a
 * single dropout reds a REQUIRED check, which makes the council strictly less reliable than
 * the least reliable model in it, and leaves the whole repo unmergeable behind one hung HTTP
 * request. Four PRs — #3680 (a security fix), #3671, #3291, #3233 — were blocked at once this
 * way.
 *
 * EHAC-2231 measured what is actually behind the dropouts, and it is NOT one bad model:
 *   * VOLUME — a genuinely oversized prompt that cannot finish in the wall-clock budget.
 *   * STALL  — a hung request on a 3,612-char prompt, deterministic per diff, immune to both
 *              retries and a larger cap.
 * It also established that per-model blame is a POSITION ARTIFACT: lens->model binding is
 * positional over `review_models`, so whichever model occupies a slot wears that slot's
 * failures. The "offender" appeared to rotate three times under that misreading.
 *
 * A quorum makes STALL non-blocking WITHOUT pretending to fix STALL, and it stays correct
 * across that rotation. The dropout is never swallowed: a quorate-but-degraded council is
 * reported as a `::warning::` naming the lens, because a green with no annotation is the very
 * defect this file exists to prevent.
 *
 * What is never tolerated is a council that cannot claim to have reviewed — the PR #3564
 * defect this branch was created for (EHAC-2162), where the `tests` lens and
 * `validator-self-review` both failed, the validator reconciled anyway, and the check still
 * reported "analysis complete":
 *   * the validator did not run          -> nothing reconciled the lens findings
 *   * no reviewer lens succeeded         -> nothing read the diff
 *   * more than `maxDegraded` lenses down
 *   * a failed run whose role is neither -> it cannot be weighed, so it fails closed
 *
 * Re-derived from `models.runs`, never from `models.rollup`, consistent with every other
 * branch in this file: the producer's own arithmetic is never the authority.
 *
 * @param {any} coverage
 * @param {number} maxDegraded
 * @returns {{status: 'ok'|'degraded'|'breached', message: string|null}}
 */
export function deriveCouncilQuorum(coverage, maxDegraded = DEFAULT_COUNCIL_MAX_DEGRADED) {
  const ok = { status: /** @type {const} */ ('ok'), message: null };
  if (coverage?.not_reviewed) return ok;

  const runs = coverage?.models?.runs ?? null;
  const inputTokens = num(coverage?.review?.input_tokens);

  if (!Array.isArray(runs)) {
    // Absent modelRuns is only an unknown when a review demonstrably ran. Records from before
    // this field existed, or from a genuinely skipped review, are already covered by U5 and
    // must not be double-reported here.
    if (inputTokens !== null && inputTokens > 0) {
      return {
        status: 'breached',
        message:
          'U7 the review reported input tokens but the coverage record carries no per-lens model runs — which models actually ran cannot be established.',
      };
    }
    return ok;
  }

  const failed = (r) => r?.conclusion !== 'success';
  const name = (r) =>
    `${r?.lens_id ?? r?.role ?? '(unknown)'} (${r?.model_label ?? 'unknown model'} -> ${r?.conclusion ?? 'no conclusion'})`;
  const isReviewer = (r) => REVIEWER_ROLES.includes(r?.role);
  const isValidator = (r) => VALIDATOR_ROLES.includes(r?.role);

  const failedRuns = runs.filter(failed);
  if (failedRuns.length === 0) return ok;

  // Every outcome below leads with the SAME full census of what dropped, and only then gives
  // the rule-specific reason. Naming just the run that tripped the rule would hide the rest of
  // the damage from whoever has to diagnose it — on PR #3564 two runs failed and an operator
  // needs to see both, not only the validator that happened to be decisive.
  const census = `${failedRuns.length} of ${runs.length} council model run(s) did not succeed: ${failedRuns.map(name).join(', ')}.`;

  const reviewers = runs.filter(isReviewer);
  const failedReviewers = reviewers.filter(failed);
  const failedValidators = failedRuns.filter(isValidator);
  const failedUnclassified = failedRuns.filter((r) => !isReviewer(r) && !isValidator(r));

  // A failed run carrying an unrecognised (or absent) role cannot be weighed against either
  // budget, so it is not tolerated. Fail closed — the same doctrine as an absent file count.
  if (failedUnclassified.length > 0) {
    return {
      status: 'breached',
      message: `U7 ${census} ${failedUnclassified.length} of them carry a role that is neither reviewer nor validator, and an unclassifiable run cannot be weighed against the quorum, so it fails closed.`,
    };
  }

  if (failedValidators.length > 0) {
    return {
      status: 'breached',
      message: `U7 ${census} The validator did not succeed, so nothing reconciled the lens findings and the posted review is not a reconciled review.`,
    };
  }

  if (reviewers.length > 0 && failedReviewers.length >= reviewers.length) {
    return {
      status: 'breached',
      message: `U7 ${census} No reviewer lens succeeded — nothing read the diff, so the check name reports work that did not happen.`,
    };
  }

  if (failedReviewers.length > maxDegraded) {
    return {
      status: 'breached',
      message: `U7 ${census} That is ${failedReviewers.length} of ${reviewers.length} reviewer lens(es), above the tolerance of ${maxDegraded}, so the council did not reach quorum.`,
    };
  }

  return {
    status: 'degraded',
    message: `the council ran DEGRADED — ${census} That is ${failedReviewers.length} of ${reviewers.length} reviewer lens(es), within the tolerance of ${maxDegraded}, and the validator reconciled, so coverage is not blocked. The review is still thinner than the check name implies: repeated degradation is a defect to chase (EHAC-2231), not a steady state to accept.`,
  };
}

/**
 * U8 — the producer and the gate must be enforcing the SAME tolerance.
 *
 * `max_degraded_lenses` is declared ONCE by the reusable workflow and handed to three
 * consumers: elek (which enforces it while the review runs), the coverage producer (which
 * records it), and this asserter (which re-derives the verdict from the recorded runs). The
 * two evaluations are deliberately independent — this file never trusts elek's own status —
 * but they must be independent evaluations OF ONE VALUE.
 *
 * Two unrelated defaults that merely happen to agree is not the same property, and it breaks
 * silently the first time one side moves: a producer tolerating one dropout while the gate
 * tolerates none would still report success on every healthy run, and would only diverge on
 * exactly the run where the tolerance mattered.
 *
 * NOT REPORTED IS NOT AGREEMENT. A record from an older elek pin carries no policy block, and
 * a workflow that never set COUNCIL_MAX_DEGRADED on the producer carries null. Those are
 * treated as "cannot compare" and pass — because failing them closed would red every consumer
 * still on an older pin, and a rule that reds everyone is switched off within a week. What is
 * NOT tolerated is two values that are both present and different.
 *
 * @param {any} coverage
 * @param {number} gateMaxDegraded the value THIS process was given
 * @returns {{branch: string, message: string}|null}
 */
export function derivePolicyDrift(coverage, gateMaxDegraded) {
  const policy = coverage?.models?.policy ?? null;
  if (!policy) return null;

  const producer = policy.producer_max_degraded;
  if (Number.isInteger(producer) && producer !== gateMaxDegraded) {
    return {
      branch: 'U8',
      message: `U8 producer/gate council-policy drift: the review job was given max_degraded_lenses=${producer} but this gate was given ${gateMaxDegraded}. One declared value must reach both consumers; two values means the review and the check are enforcing different policies.`,
    };
  }

  const elekEffective = policy.elek_effective_max_degraded;
  if (Number.isInteger(elekEffective) && Number.isInteger(producer) && elekEffective !== producer) {
    // elek clamps a tolerance that is not below the reviewer count, so a difference here is
    // usually a misconfiguration elek already corrected — but it is still a policy this gate
    // did not apply, and it is reported rather than absorbed.
    return {
      branch: 'U8',
      message: `U8 council-policy drift: the review job was configured with max_degraded_lenses=${producer} but elek reports it actually applied ${elekEffective}${Array.isArray(policy.elek_warnings) && policy.elek_warnings.length ? ` (${policy.elek_warnings.join('; ')})` : ''}. The gate cannot certify a review against a tolerance it did not evaluate.`,
    };
  }
  return null;
}

/**
 * The failed-run census, in the form an operator actually needs (EHAC-2231).
 *
 * Printed on EVERY terminal path that has a record, including a failed review job. "Which lens
 * dropped, on which model, and how it failed" used to require reading six interleaved pi
 * transcripts out of a job log — and on the failure path the gate returned before it had even
 * parsed the record, so it printed nothing at all.
 *
 * @param {any} coverage
 * @returns {string[]}
 */
export function renderFailureCensus(coverage) {
  const runs = Array.isArray(coverage?.models?.runs) ? coverage.models.runs : [];
  const failed = runs.filter((r) => r?.conclusion !== 'success');
  const lines = [];
  if (failed.length > 0) {
    lines.push(`Failed council runs (${failed.length} of ${runs.length}):`);
    for (const r of failed) {
      const assigned = r?.assigned_model_label ?? r?.model_label ?? 'unknown model';
      const actual = r?.actual_model_label ?? r?.model_label ?? 'unknown model';
      const moved = assigned !== actual ? ` (failed over from ${assigned})` : '';
      lines.push(
        `  - ${r?.lens_id ?? r?.role ?? '(unknown lens)'} [${r?.role ?? 'no role'}] on ${actual}${moved}` +
          ` -> ${r?.conclusion ?? 'no conclusion'}, class ${r?.failure_class ?? 'unreported'}`,
      );
    }
  }
  const attempts = Array.isArray(coverage?.models?.attempts) ? coverage.models.attempts : [];
  const notable = attempts.filter((a) => a?.conclusion !== 'success' || a?.failover === true);
  if (notable.length > 0) {
    lines.push(`Attempt history (${attempts.length} physical attempt(s) across ${runs.length} logical run(s)):`);
    for (const a of notable) {
      lines.push(
        `  - ${a?.lens_id ?? '(unknown)'} attempt ${a?.attempt ?? '?'} on ${a?.actual_model ?? 'unknown model'}` +
          `${a?.failover ? ' [failover]' : ''} -> ${a?.conclusion ?? 'no conclusion'}, class ${a?.failure_class ?? 'unreported'}` +
          `, ${a?.duration_seconds ?? '?'}s, max_idle ${a?.max_idle_seconds_observed ?? '?'}s`,
      );
    }
  }
  return lines;
}

/**
 * Independently re-derive every UNKNOWN branch from the coverage record's own fields, then
 * union that with any branch the producer recorded. Re-derivation is what makes this half
 * genuinely independent of the producer's judgement.
 *
 * @param {any} coverage
 * @param {number} [maxDegraded]
 * @returns {{branch: string, message: string}[]}
 */
export function deriveUnknownBranches(coverage, maxDegraded = DEFAULT_COUNCIL_MAX_DEGRADED) {
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
  // Files can only be excluded AFTER being parsed out of the diff, so a non-empty exclusion
  // list is proof the diff was measured. Zero reviewable files alongside exclusions is a
  // deliberately empty scope, not an absent diff, and U2 must not claim otherwise — a pull
  // request touching only excluded paths would otherwise be blocked as UNKNOWN.
  //
  // Absence still fails closed, per the doctrine above: a record with no exclusion field
  // reads as zero exclusions and U2 fires exactly as it did before.
  const excludedFiles = coverage?.diff?.excluded_files;
  const excludedCount = Array.isArray(excludedFiles) ? excludedFiles.length : 0;
  if (filesDiff === 0 && excludedCount > 0) {
    // Deliberately empty scope — fall through without adding U2.
  } else if ((filesDiff === null || filesDiff === 0) && (changedApi === null || changedApi > 0)) {
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

  // U7 — the council did not reach quorum (EHAC-2162; quorum rule EHAC-2231).
  //
  // Only a BREACH is an UNKNOWN. A quorate-but-degraded council is reported by the caller as
  // a ::warning:: instead, so that one hung request cannot red a required check. The full
  // reasoning, and what is still never tolerated, lives on `deriveCouncilQuorum`.
  const quorum = deriveCouncilQuorum(coverage, maxDegraded);
  if (quorum.status === 'breached' && quorum.message) {
    add('U7', quorum.message);
  }

  // U8 — the producer and this gate must be enforcing ONE declared tolerance (EHAC-2231).
  const drift = derivePolicyDrift(coverage, maxDegraded);
  if (drift) add(drift.branch, drift.message);

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
 * Diagnostics for a review job that did not complete. NEVER affects the exit code.
 *
 * Kept deliberately total and non-throwing: this runs on the path where something already went
 * wrong, and a diagnostic that throws would replace a legible red with a stack trace.
 *
 * @param {string|undefined} coverageRaw
 * @returns {string[]}
 */
export function describeBrokenReviewEvidence(coverageRaw) {
  const raw = String(coverageRaw ?? '').trim();
  if (raw === '') {
    return [
      'no coverage record was exported alongside the failed review job, so there is no per-lens evidence to report.',
    ];
  }
  let coverage;
  try {
    coverage = JSON.parse(raw);
  } catch (err) {
    return [`a coverage record was exported but did not parse (${err?.message ?? err}).`];
  }
  const out = [];
  const terminal = coverage?.review?.terminal_reason;
  if (terminal) out.push(`elek reported terminal reason "${terminal}".`);
  const failureMessage = coverage?.review?.failure_message;
  if (failureMessage) out.push(`elek reported: ${failureMessage}`);
  const policy = coverage?.models?.policy;
  if (policy?.elek_status) {
    out.push(
      `council policy status "${policy.elek_status}" at effective tolerance ` +
        `${policy.elek_effective_max_degraded ?? 'unreported'}.`,
    );
  }
  out.push(...renderFailureCensus(coverage));
  if (out.length === 0) {
    out.push('a coverage record was exported but names no failed run — the failure is outside the council.');
  }
  return out;
}

/**
 * Apply the coverage contract. Pure: returns the exit code and the lines to print, so the
 * decision is unit-testable without a process.
 *
 * @param {{reviewResult: string|undefined, coverageRaw: string|undefined}} args
 * @returns {{exitCode: number, verdict: string, lines: string[], summary: string[]}}
 */
export function evaluate({ reviewResult, coverageRaw, env = process.env }) {
  const maxDegraded = readCouncilMaxDegraded(env);
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
    // EHAC-2231. The RESULT is unchanged and unconditional — a failed review job is red, full
    // stop, regardless of what the record says. What changes is that the record is now READ
    // when one exists. elek emits `review_summary_json` on every supported terminal path as of
    // eha-v1.3.0, so on the failure path there is usually a full per-lens census available;
    // returning before parsing it threw away the evidence exactly when "which lens died?"
    // matters most, and left operators reading six interleaved pi transcripts out of a job log.
    //
    // This is diagnostics only. Nothing below can lower the exit code.
    for (const line of describeBrokenReviewEvidence(coverageRaw)) {
      lines.push(line);
      summary.push(line.startsWith('::') ? line : `- ${line}`);
    }
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
  const derived = deriveUnknownBranches(coverage, maxDegraded);

  // A quorate-but-degraded council passes, but it is never silent: the lens that dropped is
  // named on the check. A green with no annotation here would be the same defect this whole
  // file exists to prevent — a check reporting more work than was performed.
  const quorum = deriveCouncilQuorum(coverage, maxDegraded);
  if (quorum.status === 'degraded' && quorum.message) {
    lines.push(`::warning::${quorum.message}`);
    summary.push(`> **Council degraded** — ${quorum.message}`);
    for (const line of renderFailureCensus(coverage)) {
      lines.push(line);
      summary.push(`- ${line}`);
    }
  }
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
    // The census, again as diagnostics only. A U7 message names the runs that tripped the rule;
    // this names the assigned model, the actual model, the terminal class and the attempt
    // history behind each of them, which is what an operator needs to decide whether a lens is
    // failing because of the model, the prompt, or the provider.
    for (const line of renderFailureCensus(coverage)) {
      lines.push(line);
      summary.push(`- ${line}`);
    }
    return { exitCode: 1, verdict, lines, summary };
  }

  if (verdict === 'NOT_REVIEWED') {
    lines.push(
      `::warning::NOT_REVIEWED — ${notReviewed.reason} (actor "${notReviewed.actor ?? '?'}"). No review was requested, so there is no coverage claim to audit. This is the one deliberate exit-0-without-coverage branch; widening its reason allowlist requires an explicit operating-policy decision.`,
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
