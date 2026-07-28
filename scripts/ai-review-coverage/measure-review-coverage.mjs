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
]);

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
 * @param {{actorFilter: string, actor: string, inputTokens: number|null}} args
 * @returns {{reason: string, actor: string}|null}
 */
export function computeNotReviewed({ actorFilter, actor, inputTokens }) {
  if (inputTokens && inputTokens > 0) return null; // a review did happen — audit it
  const who = String(actor ?? '').trim();
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
export function buildCoverage({ diffText, env = {}, context = {}, inventoryCap = DEFAULT_INVENTORY_CAP }) {
  /** @type {{branch: string, message: string}[]} */
  const unknown = [];
  const addUnknown = (branch, message) => unknown.push({ branch, message });

  let attribution;
  try {
    if (typeof diffText !== 'string') {
      throw new Error(`diff text is ${diffText === undefined ? 'missing' : typeof diffText}`);
    }
    attribution = attributeCoverage(diffText);
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
      `elek pin is "${elekRef || '(unset)'}"; the prompt-budget model in elek-prompt-budget.mjs was verified against ${ELEK_REF_VERIFIED} and has not been re-verified. Re-read src/review/diff-context.ts at the new ref, update ELEK_REF_VERIFIED and BUDGET, and update the ELEK_REF literal in ai-code-review.yml.`,
    );
  }

  // ---- elek step outputs (U5) -----------------------------------------------------
  let summary = null;
  const rawSummary = typeof env.REVIEW_SUMMARY_JSON === 'string' ? env.REVIEW_SUMMARY_JSON.trim() : '';
  if (rawSummary !== '') {
    try {
      summary = JSON.parse(rawSummary);
    } catch (err) {
      addUnknown('U5', `review_summary_json did not parse: ${err?.message ?? err}`);
    }
  }

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

  // ---- NOT_REVIEWED precheck ------------------------------------------------------
  const notReviewed = computeNotReviewed({
    actorFilter: env.ACTOR_FILTER,
    actor,
    inputTokens,
  });

  if (!notReviewed) {
    if (inputTokens === null) {
      addUnknown(
        'U5',
        'review input_tokens is absent or 0 — no evidence a review prompt was ever built.',
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
  if (attribution.rollup.files_total === 0) {
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
      per_file_budget: attribution.per_file_budget,
      prompt_chars: attribution.prompt_chars,
    },
    review: {
      conclusion,
      input_tokens: inputTokens,
      cost_usd: costUsd,
      actor: actor || null,
      event: eventName || null,
    },
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
      per_file_budget: null,
      prompt_chars: null,
    },
    review: { conclusion: null, input_tokens: null, cost_usd: null, actor: null, event: null },
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
    `| prompt regime | \`${coverage.diff.regime ?? '?'}\`${coverage.diff.per_file_budget ? `, per-file budget ${coverage.diff.per_file_budget}` : ''} |`,
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

  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, renderJobSummary(coverage));
    } catch (err) {
      process.stderr.write(`[ai-review-coverage] job summary write failed: ${err?.message ?? err}\n`);
    }
  }

  const oneLine = JSON.stringify(coverage);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `coverage_json=${oneLine}\n`);
  } else {
    // Offline: stdout carries ONLY the JSON so `JSON.parse "$(...)"` works.
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
