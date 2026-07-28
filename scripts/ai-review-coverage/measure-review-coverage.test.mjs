import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ELEK_REF_VERIFIED, parseUnifiedDiffFiles } from './elek-prompt-budget.mjs';
import { buildCoverage } from './measure-review-coverage.mjs';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const fixturePath = (name) => join(FIXTURES, name);
const read = (name) => readFileSync(fixturePath(name), 'utf8');

const TENANT_ROSTER = 'apps/ehacare/frontend/src/common/services/tenantRoster.ts';
const SDK_ADAPTER = 'apps/ehacare/frontend/src/common/services/sdkClientAdapter.ts';

/** A clean, review-happened environment: nothing here should trip U1-U6. */
const healthyEnv = (over = {}) => ({
  ELEK_REF: ELEK_REF_VERIFIED,
  REQUESTED_STRATEGY: 'council',
  EXECUTED_STRATEGY: 'council',
  REVIEW_CONCLUSION: 'success',
  REVIEW_INPUT_TOKENS: '83000',
  ...over,
});

const healthyContext = (over = {}) => ({
  baseRef: 'v2',
  headRef: 'feat/EHAC-1986-tenant-isolation',
  headShaGit: '9a95ce41d874f87039428fed12ce64b9f39266cb',
  headShaEvent: '9a95ce41d874f87039428fed12ce64b9f39266cb',
  changedFilesApi: 15,
  shallow: false,
  actor: 'adothompson',
  eventName: 'pull_request',
  ...over,
});

const byPath = (coverage, path) => coverage.inventory.find((row) => row.path === path);

describe('the truncating fixture is measured, not predicted', () => {
  it('is exactly 137,015 utf8 units — and 137,552 bytes, which is what wc -c would have reported', () => {
    const diff = read('pr-3515.diff');
    // Size is fs.readFileSync(path,'utf8').length. NEVER wc -c: elek slices on JS
    // String.length (UTF-16 code units), and the 537-unit skew below is exactly the
    // boundary flake that gets gates error-suppressed six weeks later.
    expect(diff.length).toBe(137_015);
    expect(statSync(fixturePath('pr-3515.diff')).size).toBe(137_552);
    expect(statSync(fixturePath('pr-3515.diff')).size - diff.length).toBe(537);
  });

  it('splits into 15 files by the anchored regex', () => {
    expect(parseUnifiedDiffFiles(read('pr-3515.diff'))).toHaveLength(15);
  });
});

describe('buildCoverage — the fixture-driven red', () => {
  it('yields verdict exactly PARTIAL_SOURCE on the real PR #3515 diff', () => {
    const coverage = buildCoverage({
      diffText: read('pr-3515.diff'),
      env: healthyEnv(),
      context: healthyContext(),
    });

    // Asserted exactly, so the red is attributable to real truncation of production
    // source and never to an UNKNOWN shortcut.
    expect(coverage.verdict).toBe('PARTIAL_SOURCE');
    expect(coverage.unknown_reasons).toEqual([]);
    expect(coverage.not_reviewed).toBeNull();
    expect(coverage.diff.chars).toBe(137_015);
    expect(coverage.diff.files_diff).toBe(15);
    expect(coverage.diff.regime).toBe('SLICES');
    expect(coverage.diff.per_file_budget).toBe(4_000);
  });

  it('reports tenantRoster.ts — the whole tenant-isolation primitive — as PARTIAL', () => {
    const coverage = buildCoverage({
      diffText: read('pr-3515.diff'),
      env: healthyEnv(),
      context: healthyContext(),
    });
    const roster = byPath(coverage, TENANT_ROSTER);

    expect(roster).toBeDefined();
    expect(roster.priority).toBe(0);
    expect(roster.verdict).toBe('PARTIAL');
    expect(roster.patch_chars).toBe(15_215);
    expect(roster.shown_chars).toBeLessThan(roster.patch_chars);
    expect(roster.shown_chars).toBeGreaterThan(0);
    // Measured from the committed fixture through the verbatim port of
    // diff-context.ts slicePatch(): patch.slice(0, 4000-140).replace(/\n[^\n]*$/,'').
    expect(roster.shown_chars).toBe(3_818);
    expect(roster.pct).toBe(25);
  });

  it('derives shownChars from the ported packer — at least one file is genuinely cut', () => {
    const coverage = buildCoverage({
      diffText: read('pr-3515.diff'),
      env: healthyEnv(),
      context: healthyContext(),
    });
    const cut = coverage.inventory.filter((row) => row.shown_chars !== row.patch_chars);
    // If shownChars ever defaulted to patchChars the gate would be arithmetically
    // incapable of red. This assertion is the guard against that.
    expect(cut.length).toBeGreaterThan(0);
    expect(cut.every((row) => row.shown_chars < row.patch_chars)).toBe(true);
    // No file is dropped whole at this size: the failure mode is truncation, not omission.
    expect(coverage.rollup.source_absent).toBe(0);
    expect(coverage.rollup.source_partial).toBe(4);
    expect(coverage.rollup.files_total).toBe(15);
  });

  it('keeps a WHOLE production file WHOLE (the predicate is not "everything is partial")', () => {
    const coverage = buildCoverage({
      diffText: read('pr-3515.diff'),
      env: healthyEnv(),
      context: healthyContext(),
    });
    const adapter = byPath(coverage, SDK_ADAPTER);
    expect(adapter.priority).toBe(0);
    expect(adapter.verdict).toBe('WHOLE');
    expect(adapter.shown_chars).toBe(adapter.patch_chars);
    expect(adapter.pct).toBe(100);
  });
});

describe('buildCoverage — the green control', () => {
  it('yields COMPLETE with every file WHOLE on small-complete.diff', () => {
    const diff = read('small-complete.diff');
    const coverage = buildCoverage({
      diffText: diff,
      env: healthyEnv(),
      context: healthyContext({ changedFilesApi: 2 }),
    });

    expect(coverage.verdict).toBe('COMPLETE');
    expect(coverage.diff.regime).toBe('FULL');
    expect(coverage.inventory).toHaveLength(2);
    expect(coverage.inventory.every((row) => row.verdict === 'WHOLE')).toBe(true);
    expect(coverage.rollup).toMatchObject({
      source_partial: 0,
      source_absent: 0,
      non_source_partial: 0,
      non_source_absent: 0,
      unknown_paths: 0,
    });
  });
});

describe('buildCoverage — PARTIAL_NON_SOURCE (synthetic subset of the real diff)', () => {
  // Real file sections, re-selected: every production-source file in the subset fits
  // inside the 4,000-char per-file clamp, so only tests/fixtures get cut.
  const NON_SOURCE_CUT_SUBSET = new Set([
    SDK_ADAPTER,
    'apps/ehacare/frontend/src/__tests__/helpers/tenantIsolationFixtures.ts',
    'apps/ehacare/frontend/src/ambulatory/features/encounter/services/encounterService.isolation.test.ts',
    'apps/ehacare/frontend/src/ambulatory/features/encounter/services/encounterService.test.ts',
    'apps/ehacare/frontend/src/ambulatory/features/labtest/services/labOrders.isolation.test.ts',
    'apps/ehacare/frontend/src/ambulatory/features/labtest/services/labOrders.test.ts',
    'apps/ehacare/frontend/src/ambulatory/features/prescription/services/prescriptionService.isolation.test.ts',
    'apps/ehacare/frontend/src/common/services/tenantRoster.test.ts',
    'e2e/bettercare/tests/clinical-list-tenant-isolation.spec.ts',
  ]);

  const subsetDiff = () => {
    const sections = parseUnifiedDiffFiles(read('pr-3515.diff'))
      .filter((file) => NON_SOURCE_CUT_SUBSET.has(file.path))
      .map((file) => file.patch);
    expect(sections).toHaveLength(NON_SOURCE_CUT_SUBSET.size);
    return `${sections.join('\n')}\n`;
  };

  it('warns but does not fail when only tests/fixtures are cut', () => {
    const diff = subsetDiff();
    // Must still be above the full-diff threshold, or the subset would trivially be COMPLETE.
    expect(diff.length).toBeGreaterThan(80_000);

    const coverage = buildCoverage({
      diffText: diff,
      env: healthyEnv(),
      context: healthyContext({ changedFilesApi: NON_SOURCE_CUT_SUBSET.size }),
    });

    expect(coverage.diff.regime).toBe('SLICES');
    expect(coverage.verdict).toBe('PARTIAL_NON_SOURCE');
    expect(coverage.rollup.source_partial).toBe(0);
    expect(coverage.rollup.source_absent).toBe(0);
    expect(coverage.rollup.non_source_partial).toBe(5);
    expect(byPath(coverage, SDK_ADAPTER).verdict).toBe('WHOLE');
  });
});

describe('buildCoverage — UNKNOWN detection (U1-U6)', () => {
  const cover = (env, context, diffText = read('small-complete.diff')) =>
    buildCoverage({ diffText, env: healthyEnv(env), context: healthyContext(context) });

  const branches = (coverage) => coverage.unknown_reasons.map((r) => r.branch);

  it('U1: elek pin drift', () => {
    const coverage = cover({ ELEK_REF: '0'.repeat(40) }, {});
    expect(coverage.verdict).toBe('UNKNOWN');
    expect(branches(coverage)).toContain('U1');
  });

  it('U2: empty diff while the PR reports changed files', () => {
    const coverage = cover({}, { changedFilesApi: 15 }, '');
    expect(coverage.verdict).toBe('UNKNOWN');
    expect(branches(coverage)).toContain('U2');
  });

  it('U3: executed strategy differs from the requested strategy', () => {
    const coverage = cover({ EXECUTED_STRATEGY: 'crosscheck' }, {});
    expect(coverage.verdict).toBe('UNKNOWN');
    expect(branches(coverage)).toContain('U3');
    expect(coverage.strategy).toMatchObject({
      requested: 'council',
      executed: 'crosscheck',
      match: false,
    });
  });

  it('U4: branch tip disagrees with the check-run head SHA', () => {
    const coverage = cover({}, { headShaGit: 'a'.repeat(40), headShaEvent: 'b'.repeat(40) });
    expect(coverage.verdict).toBe('UNKNOWN');
    expect(branches(coverage)).toContain('U4');
  });

  it('U5: input_tokens absent or zero', () => {
    expect(branches(cover({ REVIEW_INPUT_TOKENS: '0' }, {}))).toContain('U5');
    expect(branches(cover({ REVIEW_INPUT_TOKENS: '' }, {}))).toContain('U5');
    expect(branches(cover({ REVIEW_INPUT_TOKENS: 'not-a-number' }, {}))).toContain('U5');
  });

  it('U5: unparseable review_summary_json', () => {
    const coverage = cover({ REVIEW_SUMMARY_JSON: '{not json' }, {});
    expect(coverage.verdict).toBe('UNKNOWN');
    expect(branches(coverage)).toContain('U5');
  });

  it('U6: a header path that will not parse', () => {
    const coverage = cover({}, { changedFilesApi: 1 }, 'diff --git nonsense\nindex a..b\n+x\n');
    expect(coverage.verdict).toBe('UNKNOWN');
    expect(branches(coverage)).toContain('U6');
  });

  it('records a shallow repository without escalating on its own', () => {
    const coverage = cover({}, { shallow: true });
    // elek re-fetches --depth=100 over our fetch-depth: 0 checkout, so a shallow marker
    // is routine; escalating on it alone would produce a red storm.
    expect(coverage.refs.shallow).toBe(true);
    expect(coverage.verdict).toBe('COMPLETE');
  });
});

describe('buildCoverage — strategy facts come from review_summary_json when present', () => {
  it('prefers review.requestedStrategy / review.executedStrategy over the env fallback', () => {
    const summary = JSON.stringify({
      run: { conclusion: 'success' },
      entity: { actor: 'adothompson', event: 'pull_request' },
      review: { requestedStrategy: 'council', executedStrategy: 'crosscheck' },
      cost: { inputTokens: 83_000 },
    });
    const coverage = buildCoverage({
      diffText: read('small-complete.diff'),
      env: healthyEnv({ REVIEW_SUMMARY_JSON: summary, EXECUTED_STRATEGY: 'council' }),
      context: healthyContext({ changedFilesApi: 2 }),
    });
    expect(coverage.strategy.executed).toBe('crosscheck');
    expect(coverage.verdict).toBe('UNKNOWN');
    expect(coverage.unknown_reasons.map((r) => r.branch)).toContain('U3');
  });
});

describe('buildCoverage — NOT_REVIEWED is deterministic, never inferred from empty output', () => {
  it('reports NOT_REVIEWED when the actor is outside an explicit actor_filter', () => {
    const coverage = buildCoverage({
      diffText: read('small-complete.diff'),
      env: healthyEnv({
        ACTOR_FILTER: 'alice,bob',
        REVIEW_INPUT_TOKENS: '0',
      }),
      context: healthyContext({ actor: 'carol', changedFilesApi: 2 }),
    });
    expect(coverage.verdict).toBe('NOT_REVIEWED');
    expect(coverage.not_reviewed.reason).toBe('actor_not_in_actor_filter');
  });

  it('reports NOT_REVIEWED for a bot actor', () => {
    const coverage = buildCoverage({
      diffText: read('small-complete.diff'),
      env: healthyEnv({ ACTOR_FILTER: 'alice', REVIEW_INPUT_TOKENS: '0' }),
      context: healthyContext({ actor: 'renovate[bot]', changedFilesApi: 2 }),
    });
    expect(coverage.verdict).toBe('NOT_REVIEWED');
    expect(coverage.not_reviewed.reason).toBe('actor_is_bot_not_allowlisted');
  });

  it('does NOT claim NOT_REVIEWED when the actor IS allowlisted', () => {
    const coverage = buildCoverage({
      diffText: read('small-complete.diff'),
      env: healthyEnv({ ACTOR_FILTER: 'alice,adothompson' }),
      context: healthyContext({ changedFilesApi: 2 }),
    });
    expect(coverage.not_reviewed).toBeNull();
    expect(coverage.verdict).toBe('COMPLETE');
  });

  it('does NOT claim NOT_REVIEWED when actor_filter is empty (v1.1.4 = all humans)', () => {
    const coverage = buildCoverage({
      diffText: read('small-complete.diff'),
      env: healthyEnv({ ACTOR_FILTER: '' }),
      context: healthyContext({ actor: 'carol', changedFilesApi: 2 }),
    });
    expect(coverage.not_reviewed).toBeNull();
  });
});

describe('buildCoverage — never throws, always emits', () => {
  it('degrades a measurement bug to UNKNOWN rather than silence', () => {
    // A non-string diff would throw inside the parser if it were not guarded.
    const coverage = buildCoverage({ diffText: undefined, env: {}, context: {} });
    expect(coverage.verdict).toBe('UNKNOWN');
    expect(coverage.unknown_reasons.length).toBeGreaterThan(0);
  });

  it('caps the published inventory and flags the truncation', () => {
    const coverage = buildCoverage({
      diffText: read('pr-3515.diff'),
      env: healthyEnv(),
      context: healthyContext(),
      inventoryCap: 3,
    });
    expect(coverage.inventory).toHaveLength(3);
    expect(coverage.inventory_truncated).toBe(true);
    // The rollup counts stay whole-population even when the inventory is capped.
    expect(coverage.rollup.files_total).toBe(15);
  });
});
