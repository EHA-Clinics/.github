import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ELEK_REF_VERIFIED } from './elek-prompt-budget.mjs';
import { BUCKET_TOKENS, bucketReviewRecords, evaluateRecordSet } from './assert-review-coverage.mjs';

const SCRIPT = join(import.meta.dirname, 'assert-review-coverage.mjs');
const SOURCE_FILE = 'apps/ehacare/frontend/src/common/services/tenantRoster.ts';

/**
 * Run the real CLI in a child process so the assertions are about EXIT CODES, which is
 * the only thing GitHub turns into a check conclusion. A mocked call cannot prove that.
 */
const run = (env = {}) =>
  spawnSync(process.execPath, [SCRIPT], {
    // Deliberately minimal env: no inherited GITHUB_* from the developer's shell or CI.
    env: { PATH: process.env.PATH, REVIEW_RESULT: 'success', ...env },
    encoding: 'utf8',
  });

const inventoryRow = (over = {}) => ({
  path: SOURCE_FILE,
  priority: 0,
  patch_chars: 15_215,
  shown_chars: 15_215,
  pct: 100,
  status: 'added',
  verdict: 'WHOLE',
  ...over,
});

const payload = (over = {}) =>
  JSON.stringify({
    schema: 1,
    verdict: 'COMPLETE',
    not_reviewed: null,
    unknown_reasons: [],
    elek: { ref: ELEK_REF_VERIFIED, ref_verified: ELEK_REF_VERIFIED, pin_ok: true },
    strategy: { requested: 'council', executed: 'council', match: true },
    refs: {
      base_ref: 'v2',
      head_ref: 'feat/x',
      head_sha_git: 'a'.repeat(40),
      head_sha_event: 'a'.repeat(40),
      sha_match: true,
      shallow: false,
    },
    diff: {
      chars: 14_599,
      files_diff: 2,
      changed_files_api: 2,
      regime: 'FULL',
      slice_ceiling_observed: null,
      prompt_chars: 14_700,
    },
    review: { conclusion: 'success', input_tokens: 83_000, cost_usd: 0.0496 },
    // A healthy council: three distinct models, every run succeeded. Mirrors the real
    // modelRuns shape from elek review_summary_json (EHAC-2162 / EHAC-2103).
    models: {
      runs: [
        { role: 'reviewer', lens_id: 'risk', model_label: 'deepseek/deepseek-v4-pro', conclusion: 'success' },
        { role: 'reviewer', lens_id: 'design', model_label: 'xiaomi/mimo-v2.5-pro', conclusion: 'success' },
        { role: 'reviewer', lens_id: 'tests', model_label: 'openrouter/z-ai/glm-5.1', conclusion: 'success' },
        { role: 'validator', lens_id: null, model_label: 'openrouter/z-ai/glm-5.1', conclusion: 'success' },
      ],
      configured: {
        review_models: ['deepseek/deepseek-v4-pro', 'xiaomi/mimo-v2.5-pro', 'openrouter/z-ai/glm-5.1'],
        validator_model: 'openrouter/z-ai/glm-5.1',
      },
      distinct_models: ['deepseek/deepseek-v4-pro', 'openrouter/z-ai/glm-5.1', 'xiaomi/mimo-v2.5-pro'],
      rollup: {
        runs_total: 4,
        reviewer_lenses_total: 3,
        reviewer_lenses_failed: 0,
        validator_runs_total: 1,
        validator_runs_failed: 0,
        failed_lens_ids: [],
      },
    },
    rollup: {
      files_total: 2,
      whole: 2,
      source_partial: 0,
      source_absent: 0,
      non_source_partial: 0,
      non_source_absent: 0,
      unknown_paths: 0,
    },
    inventory: [inventoryRow()],
    inventory_truncated: false,
    ...over,
  });

/** Deep-merge helper for the nested rollup/diff/refs blocks. */
const withRollup = (over) => {
  const base = JSON.parse(payload());
  base.rollup = { ...base.rollup, ...over };
  return JSON.stringify(base);
};

describe('coverage verdicts -> exit codes', () => {
  it('COMPLETE exits 0', () => {
    const result = run({ COVERAGE_JSON: payload() });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('COMPLETE');
  });

  it('PARTIAL_NON_SOURCE exits 0 with a ::warning::', () => {
    const result = run({
      COVERAGE_JSON: withRollup({ non_source_partial: 1, whole: 1 }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::');
    expect(result.stdout).toContain('PARTIAL_NON_SOURCE');
  });

  it('PARTIAL_SOURCE exits 1 with a ::error:: annotation per offending source file', () => {
    const base = JSON.parse(payload());
    base.rollup = { ...base.rollup, source_partial: 1, whole: 1 };
    base.inventory = [inventoryRow({ shown_chars: 3_818, pct: 25, verdict: 'PARTIAL' })];

    const result = run({ COVERAGE_JSON: JSON.stringify(base) });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('PARTIAL_SOURCE');
    expect(result.stdout).toContain(`::error file=${SOURCE_FILE},line=1,title=AI review coverage::`);
  });

  // EHAC-2164 — GREEN on known-good, the control for the U2 absent-vs-zero fix. A genuinely
  // empty diff on a PR the API also reports as empty is not an unknown: there was nothing to
  // cover. Without this the fix could not be distinguished from one that reds on every zero.
  it('files_diff: 0 with changed_files_api: 0 still exits 0 — a real empty diff is not unknown', () => {
    const base = JSON.parse(payload());
    base.diff = { ...base.diff, files_diff: 0, changed_files_api: 0 };
    base.rollup = { ...base.rollup, files_total: 0, whole: 0 };
    base.inventory = [];
    const result = run({ COVERAGE_JSON: JSON.stringify(base) });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('U2');
  });

  // EHAC-2162 — GREEN on known-good. A full council where every run succeeded must pass, or
  // U7 would be a gate that cannot pass rather than one that cannot fail.
  it('a healthy council where every model run succeeded exits 0 without U7', () => {
    const base = JSON.parse(payload());
    expect(base.models.runs.every((r) => r.conclusion === 'success')).toBe(true);
    const result = run({ COVERAGE_JSON: JSON.stringify(base) });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('U7');
  });

  // EHAC-2162 — absent modelRuns must NOT red when no review ran at all. That case is already
  // U5's (or NOT_REVIEWED's) to report; double-reporting it would make every Renovate PR red.
  it('a NOT_REVIEWED record with no modelRuns still exits 0 — U7 does not double-report', () => {
    const base = JSON.parse(payload());
    base.verdict = 'NOT_REVIEWED';
    base.not_reviewed = { reason: 'actor_is_bot_not_allowlisted', actor: 'renovate[bot]' };
    base.models.runs = null;
    base.review = { conclusion: 'skipped', input_tokens: null, cost_usd: 0, actor: 'renovate[bot]', event: 'pull_request' };
    const result = run({ COVERAGE_JSON: JSON.stringify(base) });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('U7');
  });

  it('never posts a PR comment (elek’s sticky comment is the review surface)', () => {
    const result = run({ COVERAGE_JSON: payload() });
    expect(result.stdout).not.toMatch(/gh (pr|api)/);
    expect(result.stderr).not.toMatch(/gh (pr|api)/);
  });
});

describe('UNKNOWN branches — every one exits non-zero', () => {
  const expectUnknown = (env, branch) => {
    const result = run(env);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::');
    expect(result.stdout).toContain('UNKNOWN');
    if (branch) expect(result.stdout).toContain(branch);
  };

  it('U1: elek pin drift', () => {
    const base = JSON.parse(payload());
    base.elek = { ref: '0'.repeat(40), ref_verified: ELEK_REF_VERIFIED, pin_ok: false };
    expectUnknown({ COVERAGE_JSON: JSON.stringify(base) }, 'U1');
  });

  it('U2: empty diff while the PR reports changed files', () => {
    const base = JSON.parse(payload());
    base.diff = { ...base.diff, files_diff: 0, changed_files_api: 15 };
    expectUnknown({ COVERAGE_JSON: JSON.stringify(base) }, 'U2');
  });

  // A pull request touching ONLY excluded paths measures zero reviewable files. That is a
  // deliberately empty scope, not a missing diff — and it is the exact pull request
  // exclude_paths exists to serve, so treating it as U2 would red-line the feature's own
  // primary use case with a message blaming getGitDiff for a failure that never happened.
  //
  // Files can only be excluded AFTER being parsed out of the diff, so a non-empty exclusion
  // list is itself proof the diff was measured.
  it('U2 does NOT fire when zero reviewable files is explained by exclusions', () => {
    const base = JSON.parse(payload());
    base.diff = {
      ...base.diff,
      files_diff: 0,
      changed_files_api: 2,
      excluded_files: ['.planning/a.md', '.planning/b.py'],
    };
    const result = run({ COVERAGE_JSON: JSON.stringify(base) });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('U2');
  });

  // The complement, and the one that matters for safety: exclusions being CONFIGURED must not
  // suppress U2. Only exclusions actually APPLIED prove the diff parsed. An empty list here
  // means nothing was excluded, so a zero file count is still an unexplained empty diff.
  it('U2 still fires when the exclusion list is present but empty', () => {
    const base = JSON.parse(payload());
    base.diff = { ...base.diff, files_diff: 0, changed_files_api: 15, excluded_files: [] };
    expectUnknown({ COVERAGE_JSON: JSON.stringify(base) }, 'U2');
  });

  // Fail-closed for records written by an older gate that has no exclusion field at all:
  // absence reads as zero exclusions, and U2 behaves exactly as it did before.
  it('U2 still fires when the exclusion field is absent entirely', () => {
    const base = JSON.parse(payload());
    base.diff = { ...base.diff, files_diff: 0, changed_files_api: 15 };
    delete base.diff.excluded_files;
    expectUnknown({ COVERAGE_JSON: JSON.stringify(base) }, 'U2');
  });

  // EHAC-2164 — RED on known-bad. Before the fix `num()` returned null for the absent field,
  // `null === 0` was false, U2 never fired, and this exact record exited 0 as COMPLETE.
  // The rollup below is deliberately VALID so U5's rollup check cannot be what reds it —
  // this test fails for the U2 reason or it is not testing anything.
  it('U2: files_diff absent (not zero) while the PR reports changed files', () => {
    const base = JSON.parse(payload());
    base.diff = { ...base.diff, changed_files_api: 15 };
    delete base.diff.files_diff;
    expect(base.rollup && typeof base.rollup === 'object').toBe(true);
    const result = run({ COVERAGE_JSON: JSON.stringify(base) });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('U2');
    expect(result.stdout).toContain('does not report a measured file count');
  });

  // EHAC-2162 — RED on known-bad, reproducing the real defect verbatim.
  //
  // These are the actual modelRuns from eha_care PR #3564, run 31223046934: the `tests`
  // reviewer lens and `validator-self-review` both returned conclusion "failure", the final
  // validator succeeded, and the check reported "analysis complete" with a green coverage
  // gate. Every other field below is HEALTHY — full diff coverage, matching strategy, no pin
  // drift, positive input tokens — so this test can only red for the U7 reason.
  it('U7: council lenses that failed while the aggregate conclusion says success', () => {
    const base = JSON.parse(payload());
    base.models.runs = [
      { role: 'reviewer', lens_id: 'risk', model_label: 'deepseek/deepseek-v4-pro', conclusion: 'success' },
      { role: 'reviewer', lens_id: 'design', model_label: 'xiaomi/mimo-v2.5-pro', conclusion: 'success' },
      { role: 'reviewer', lens_id: 'tests', model_label: 'openrouter/z-ai/glm-5.1', conclusion: 'failure' },
      { role: 'reviewer', lens_id: 'operations', model_label: 'deepseek/deepseek-v4-pro', conclusion: 'success' },
      { role: 'validator-review', lens_id: 'validator-self-review', model_label: 'openrouter/z-ai/glm-5.1', conclusion: 'failure' },
      { role: 'validator', lens_id: null, model_label: 'openrouter/z-ai/glm-5.1', conclusion: 'success' },
    ];
    // The aggregate elek reported for that run, and the reason the gate stayed green.
    expect(base.review.conclusion).toBe('success');
    expect(base.verdict).toBe('COMPLETE');

    const result = run({ COVERAGE_JSON: JSON.stringify(base) });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('U7');
    expect(result.stdout).toContain('tests');
    expect(result.stdout).toContain('validator-self-review');
    expect(result.stdout).toContain('2 of 6');
  });

  // EHAC-2162 — the gate must not accept "we cannot tell" as a pass either.
  it('U7: modelRuns absent while the review reported input tokens', () => {
    const base = JSON.parse(payload());
    base.models.runs = null;
    expect(base.review.input_tokens).toBeGreaterThan(0);
    expectUnknown({ COVERAGE_JSON: JSON.stringify(base) }, 'U7');
  });

  it('U3: executed strategy differs from requested', () => {
    const base = JSON.parse(payload());
    base.strategy = { requested: 'council', executed: 'crosscheck', match: false };
    expectUnknown({ COVERAGE_JSON: JSON.stringify(base) }, 'U3');
  });

  it('U4: head SHA mismatch', () => {
    const base = JSON.parse(payload());
    base.refs = { ...base.refs, head_sha_git: 'a'.repeat(40), head_sha_event: 'b'.repeat(40), sha_match: false };
    expectUnknown({ COVERAGE_JSON: JSON.stringify(base) }, 'U4');
  });

  it('U5: COVERAGE_JSON missing entirely', () => {
    expectUnknown({}, 'U5');
  });

  it('U5: COVERAGE_JSON empty string', () => {
    expectUnknown({ COVERAGE_JSON: '' }, 'U5');
  });

  it('U5: COVERAGE_JSON unparseable', () => {
    expectUnknown({ COVERAGE_JSON: '{not json' }, 'U5');
  });

  it('U5: input_tokens zero', () => {
    const base = JSON.parse(payload());
    base.review = { ...base.review, input_tokens: 0 };
    expectUnknown({ COVERAGE_JSON: JSON.stringify(base) }, 'U5');
  });

  it('U5: input_tokens absent', () => {
    const base = JSON.parse(payload());
    delete base.review.input_tokens;
    expectUnknown({ COVERAGE_JSON: JSON.stringify(base) }, 'U5');
  });

  it('U5: rollup block missing (a measurement bug must be red, not silent)', () => {
    const base = JSON.parse(payload());
    delete base.rollup;
    expectUnknown({ COVERAGE_JSON: JSON.stringify(base) }, 'U5');
  });

  // EHAC-2099 — the eha_care #3530 shape: elek declined at detectTrigger, so it exited 0
  // with conclusion "skipped", no input tokens and no cost, having never read the diff.
  describe('U5: elek declined at trigger detection (conclusion "skipped")', () => {
    const declined = () => {
      const base = JSON.parse(payload());
      base.review = { conclusion: 'skipped', input_tokens: null, cost_usd: 0 };
      base.strategy = { requested: 'council', executed: null, match: null };
      return JSON.stringify(base);
    };

    it('exits 1 — a review that never started cannot certify anything', () => {
      // The point of the case: `skipped` must NOT be mistaken for a deliberate decline and
      // routed to NOT_REVIEWED (exit 0). That would be a fail-open on elek's own output.
      expectUnknown({ COVERAGE_JSON: declined() }, 'U5');
    });

    it('names the conclusion in the message instead of only "no evidence"', () => {
      const result = run({ COVERAGE_JSON: declined() });
      expect(result.stdout).toContain('conclusion "skipped"');
      // The actionable half: say what "skipped" means, so the next reader does not spend the
      // investigation on prompt-budget truncation the way #3530's did.
      expect(result.stdout).toMatch(/declined at trigger detection/);
    });

    it('reports "unset" rather than "undefined" when no conclusion was recorded', () => {
      const base = JSON.parse(payload());
      base.review = { input_tokens: null };
      const result = run({ COVERAGE_JSON: JSON.stringify(base) });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('conclusion "unset"');
      expect(result.stdout).not.toContain('undefined');
    });

    it('still exits 0 when an allowlisted NOT_REVIEWED reason accompanies it', () => {
      // A bot PR also yields no input tokens. The existing precheck must keep winning, so
      // the sharper message does not turn Renovate into a permanent red.
      const base = JSON.parse(payload());
      base.review = { conclusion: 'skipped', input_tokens: 0, cost_usd: 0 };
      base.not_reviewed = { reason: 'actor_is_bot_not_allowlisted', actor: 'renovate[bot]' };
      const result = run({ COVERAGE_JSON: JSON.stringify(base) });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('NOT_REVIEWED');
    });
  });

  it('U6: a changed-file path parsed as (unknown)', () => {
    expectUnknown({ COVERAGE_JSON: withRollup({ unknown_paths: 1 }) }, 'U6');
  });

  it('an upstream-recorded unknown_reason is honoured even if the gate cannot re-derive it', () => {
    const base = JSON.parse(payload());
    base.unknown_reasons = [{ branch: 'U5', message: 'measurement threw: boom' }];
    expectUnknown({ COVERAGE_JSON: JSON.stringify(base) });
  });
});

describe('needs.review.result — a broken review yields no coverage evidence', () => {
  for (const result of ['failure', 'cancelled', 'skipped']) {
    it(`REVIEW_RESULT=${result} exits 1`, () => {
      const proc = run({ REVIEW_RESULT: result, COVERAGE_JSON: payload() });
      expect(proc.status).toBe(1);
      expect(proc.stdout).toContain('::error::');
      expect(proc.stdout).toContain(result);
    });
  }

  it('REVIEW_RESULT absent exits 1 (fail closed)', () => {
    const proc = spawnSync(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH, COVERAGE_JSON: payload() },
      encoding: 'utf8',
    });
    expect(proc.status).toBe(1);
  });
});

describe('NOT_REVIEWED — the single exit-0-without-coverage branch', () => {
  it('exits 0 with a ::warning:: for an allowlisted reason', () => {
    const base = JSON.parse(payload());
    base.not_reviewed = { reason: 'actor_not_in_actor_filter', actor: 'carol' };
    base.review = { ...base.review, input_tokens: 0 };
    const result = run({ COVERAGE_JSON: JSON.stringify(base) });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::');
    expect(result.stdout).toContain('NOT_REVIEWED');
  });

  it('exits 0 for a bot actor (no Renovate red storm)', () => {
    const base = JSON.parse(payload());
    base.not_reviewed = { reason: 'actor_is_bot_not_allowlisted', actor: 'renovate[bot]' };
    base.review = { ...base.review, input_tokens: 0 };
    expect(run({ COVERAGE_JSON: JSON.stringify(base) }).status).toBe(0);
  });

  it('exits 1 for a reason outside the closed allowlist', () => {
    const base = JSON.parse(payload());
    base.not_reviewed = { reason: 'because_i_said_so' };
    const result = run({ COVERAGE_JSON: JSON.stringify(base) });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('UNKNOWN');
  });
});

describe('no rubber-stamping — the verdict is recomputed from rollup counts', () => {
  it('exits 1 when an upstream verdict says COMPLETE but source_partial is 1', () => {
    const base = JSON.parse(payload());
    base.verdict = 'COMPLETE';
    base.rollup = { ...base.rollup, source_partial: 1 };
    base.inventory = [inventoryRow({ shown_chars: 10, pct: 0, verdict: 'PARTIAL' })];

    const result = run({ COVERAGE_JSON: JSON.stringify(base) });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('PARTIAL_SOURCE');
  });

  it('exits 1 when an upstream verdict says COMPLETE but a UNKNOWN branch is derivable', () => {
    const base = JSON.parse(payload());
    base.verdict = 'COMPLETE';
    base.unknown_reasons = [];
    base.strategy = { requested: 'council', executed: 'solo', match: true };
    const result = run({ COVERAGE_JSON: JSON.stringify(base) });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('U3');
  });

  it('exits 1 when source_absent is non-zero even with a COMPLETE verdict string', () => {
    const base = JSON.parse(payload());
    base.verdict = 'COMPLETE';
    base.rollup = { ...base.rollup, source_absent: 2 };
    expect(run({ COVERAGE_JSON: JSON.stringify(base) }).status).toBe(1);
  });
});

/**
 * R12 — verdict bucketing across a record SET (EHAC-2165).
 *
 * Driven through the CLI in a child process for the same reason as every other case in this
 * file: the exit code is the only thing GitHub turns into a check conclusion. Each case
 * asserts the REASON TOKEN as well, because an exit produced for an unrelated reason is not
 * proof of the rule.
 */
describe('R12 — review record sets are bucketed by verdict', () => {
  const runSet = (recordSet) =>
    spawnSync(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH, REVIEW_RECORD_SET_JSON: JSON.stringify(recordSet) },
      encoding: 'utf8',
    });

  const ALL_FAILED = 'REVIEW_SET_ALL_REAL_REVIEWS_FAILED';
  const UNKNOWN = 'REVIEW_SET_UNKNOWN';

  const realRecord = (id, verdict) => ({ id, verdict, conclusion: 'success', not_reviewed: null });

  /**
   * THE SHARED BUILDER for the state-3 / state-4 boundary. Both cases come from here and
   * differ by EXACTLY ONE FIELD — the reason on the last record. If the two cases were built
   * separately they could drift into differing by something else, and the pair would stop
   * proving that the DECLARATION is the discriminator.
   */
  const declinedOnlySet = ({ lastReason = 'actor_is_bot_not_allowlisted' } = {}) => [
    {
      id: 'renovate-1',
      verdict: 'NOT_REVIEWED',
      conclusion: 'skipped',
      not_reviewed: { reason: 'actor_is_bot_not_allowlisted', actor: 'renovate[bot]' },
      cost_usd: 0,
    },
    {
      id: 'renovate-2',
      verdict: 'NOT_REVIEWED',
      conclusion: 'skipped',
      not_reviewed: { reason: lastReason, actor: 'renovate[bot]' },
      cost_usd: 0,
    },
  ];

  it('state 1 REPORTS the outage shape: every real review failed while declined records read green', () => {
    // The observed 2026-08-09 window, in miniature: real reviews all dead, bot records green,
    // the aggregate reading partly healthy. Nothing else in this payload is unhealthy, so the
    // ONLY thing that can red it is the bucketing.
    const result = runSet([
      realRecord('pr-1', 'UNKNOWN'),
      realRecord('pr-2', 'UNKNOWN'),
      realRecord('pr-3', 'PARTIAL_SOURCE'),
      ...declinedOnlySet(),
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(ALL_FAILED);
    expect(result.stdout).not.toContain(UNKNOWN);
  });

  it('state 2 ACCEPTS a set in which at least one real review succeeded', () => {
    // As load-bearing as the reporting case. Without it this could be a rule that CANNOT
    // PASS, which breaks the same property as one that cannot fail.
    const result = runSet([
      realRecord('pr-1', 'UNKNOWN'),
      realRecord('pr-2', 'COMPLETE'),
      ...declinedOnlySet(),
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(ALL_FAILED);
    expect(result.stdout).not.toContain(UNKNOWN);
  });

  it('state 4 ACCEPTS a declined-only set in which every record declares a recognised reason', () => {
    // Reporting this would red EVERY dependency-bot pull request, and a rule that reds every
    // bot PR is switched off within a week. The single-record NOT_REVIEWED path already
    // covers it, so reporting here would double-report as well.
    const result = runSet(declinedOnlySet());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('DECLINED-ONLY');
    expect(result.stdout).not.toContain(UNKNOWN);
  });

  it('state 3 REPORTS the same set with one record declaring an unrecognised reason', () => {
    // THE DISCRIMINATOR CASE, and the whole repair. Same builder, same shape, one field
    // changed. If this and the case above both exited 0 the rule could not detect an outage;
    // if both exited non-zero every bot PR would red. They must differ, and the only thing
    // that differs is whether the record explained itself.
    const result = runSet(declinedOnlySet({ lastReason: 'something_nobody_recognises' }));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(UNKNOWN);
    expect(result.stdout).not.toContain(ALL_FAILED);
  });

  it('state 3 REPORTS a record whose verdict field is missing entirely', () => {
    const set = declinedOnlySet();
    delete set[1].verdict;
    const result = runSet(set);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(UNKNOWN);
  });

  it('state 3 REPORTS an empty record set rather than calling it healthy', () => {
    // Nothing examined is not the same as nothing wrong. This is the fail-open an empty
    // bucket set would otherwise produce.
    const result = runSet([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(UNKNOWN);
  });

  it('state 3 REPORTS a truncated read, where fewer records came back than the run declares', () => {
    // A truncated read is a FAILURE TO LOOK. Reading it as "these are all the records" is the
    // failed-read-as-absence substitution.
    const result = runSet({ reported_count: 9, records: declinedOnlySet() });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(UNKNOWN);
  });

  it('fails closed when the record set does not parse', () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH, REVIEW_RECORD_SET_JSON: '{not json' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(UNKNOWN);
  });

  it('emits two DISTINCT tokens, so the two reds are separately attributable', () => {
    // "Every real review failed" and "we cannot tell whether a review happened" need
    // different investigations. One token for both sends the next person to the wrong place.
    expect(BUCKET_TOKENS.allFailed).not.toBe(BUCKET_TOKENS.unknown);
    expect(runSet([realRecord('a', 'UNKNOWN')]).stdout).toContain(BUCKET_TOKENS.allFailed);
    expect(runSet([]).stdout).toContain(BUCKET_TOKENS.unknown);
  });

  it('buckets by VERDICT even when the run conclusion disagrees with it', () => {
    // THE CASE THAT MAKES "bucket by verdict, never by conclusion" AN ASSERTION RATHER THAN A
    // COMMENT. Every other fixture here has conclusion and verdict agreeing, so a rule that
    // bucketed on `conclusion === 'success'` would satisfy all of them — proven by mutation:
    // that substitution passed the whole suite before this case existed. Conclusion is the
    // aggregate, and the aggregate is exactly what lied for ~16 hours.
    //
    // A declined bot record that the run nevertheless marked "success":
    //   by verdict    -> declined -> DECLINED-ONLY, exit 0 (correct; it is a bot PR)
    //   by conclusion -> real     -> ACTIVE-FAILING, exit 1 (reds every bot PR)
    const declinedButMarkedSuccess = runSet([
      {
        id: 'renovate-3',
        verdict: 'NOT_REVIEWED',
        conclusion: 'success',
        not_reviewed: { reason: 'actor_is_bot_not_allowlisted', actor: 'renovate[bot]' },
      },
    ]);
    expect(declinedButMarkedSuccess.status).toBe(0);
    expect(declinedButMarkedSuccess.stdout).toContain('DECLINED-ONLY');

    // A real, completed review whose JOB was reported skipped:
    //   by verdict    -> real, passing -> ACTIVE-HEALTHY, exit 0 (correct; it reviewed)
    //   by conclusion -> unknown       -> UNKNOWN, exit 1
    const realButMarkedSkipped = runSet([
      { id: 'pr-9', verdict: 'COMPLETE', conclusion: 'skipped', not_reviewed: null },
    ]);
    expect(realButMarkedSkipped.status).toBe(0);
    expect(realButMarkedSkipped.stdout).toContain('ACTIVE-HEALTHY');
  });

  it('assigns every record to exactly one bucket, from a field on the record', () => {
    const set = [
      realRecord('r', 'COMPLETE'),
      ...declinedOnlySet(),
      { id: 'u', verdict: 'WAT', not_reviewed: null },
    ];
    const { real, declined, unknown } = bucketReviewRecords(set);
    expect([real.length, declined.length, unknown.length]).toEqual([1, 2, 1]);
    expect(real.length + declined.length + unknown.length).toBe(set.length);
    // Bucket by VERDICT, never by conclusion: the declined records and a dead review both
    // carry conclusion "skipped", so a conclusion-based rule cannot tell them apart.
    const byConclusion = set.filter((r) => r.conclusion === 'skipped');
    expect(byConclusion).toHaveLength(2);
  });

  it('the four states are total and disjoint — every payload matches exactly one', () => {
    // A payload the contract cannot classify means a fifth, unstated behaviour, which is
    // where a gate acquires a silent branch.
    const cases = [
      [[realRecord('a', 'UNKNOWN')], 'ACTIVE-FAILING', 1],
      [[realRecord('a', 'COMPLETE')], 'ACTIVE-HEALTHY', 0],
      [declinedOnlySet({ lastReason: 'nope' }), 'UNKNOWN', 1],
      [declinedOnlySet(), 'DECLINED-ONLY', 0],
      [[], 'UNKNOWN', 1],
      [[{ id: 'x' }], 'UNKNOWN', 1],
      [[realRecord('a', 'PARTIAL_NON_SOURCE')], 'ACTIVE-HEALTHY', 0],
    ];
    const seen = new Set();
    for (const [records, state, exitCode] of cases) {
      const verdict = evaluateRecordSet(records);
      expect(verdict.state, JSON.stringify(records)).toBe(state);
      expect(verdict.exitCode, JSON.stringify(records)).toBe(exitCode);
      expect(verdict.token === null).toBe(exitCode === 0);
      seen.add(state);
    }
    // All four states are actually exercised, so this is not three cases and a gap.
    expect([...seen].sort()).toEqual(['ACTIVE-FAILING', 'ACTIVE-HEALTHY', 'DECLINED-ONLY', 'UNKNOWN']);
  });

  describe('non-vacuity', () => {
    it('does not fire on the healthy single-run path this gate already covers', () => {
      // The record-set rule must not double-report a run the existing rules handle. The
      // ordinary CLI path is unchanged and emits neither token.
      const result = run({ COVERAGE_JSON: payload() });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain(ALL_FAILED);
      expect(result.stdout).not.toContain(UNKNOWN);
    });

    it('buckets nothing when given nothing, and the caller reports that as UNKNOWN not a pass', () => {
      // 0 findings over 0 records must NOT be indistinguishable from a clean result. The
      // empty partition is correct; state 3 is what stops it reading as health.
      expect(bucketReviewRecords([])).toEqual({ real: [], declined: [], unknown: [] });
      expect(bucketReviewRecords(undefined)).toEqual({ real: [], declined: [], unknown: [] });
      expect(evaluateRecordSet([]).exitCode).toBe(1);
    });
  });
});
