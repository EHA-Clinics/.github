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
