import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ELEK_REF_VERIFIED } from './elek-prompt-budget.mjs';

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
      per_file_budget: null,
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
