import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ELEK_REF_VERIFIED } from './elek-prompt-budget.mjs';
// R14: the diff splitter is UPSTREAM's, imported from the vendored packer. The wrapper no
// longer re-exports it — it does not own it, and a re-export would blur that.
import { parseUnifiedDiffFiles } from './vendor/diff-context.ts';
import {
  NOT_REVIEWED_REASONS,
  SCOPE_SKIP_REASONS,
  buildCoverage,
  deriveModels,
  renderJobSummary,
} from './measure-review-coverage.mjs';

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
    expect(coverage.diff.slice_ceiling_observed).toBe(3_846); // R14: observed, not upstream's internal budget
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
    // MEASURED on the committed fixture, then independently confirmed two ways:
    //  (a) by hand: patch.slice(0, 4000-140).replace(/\n[^\n]*$/,'') — the last newline
    //      inside the 3,860-char cut sits at index 3,822;
    //  (b) by executing the REAL elek@3748508 src/review/diff-context.ts
    //      formatChangedFilesForPrompt(diff, 200_000) and asserting the emitted prompt
    //      contains exactly patch.slice(0, 3822) and no further content for this file.
    // 74% of the tenant-isolation primitive is still outside the prompt at v1.1.4 — which
    // is why the pin bump alone was never the fix and this gate is load-bearing.
    expect(roster.shown_chars).toBe(3_822);
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

describe('scope skip reasons make an inapplicable review REPORTABLE (EHAC-2060)', () => {
  // The promotion blocker in one sentence: on eha_care #3574/#3576/#3554 no AI Review
  // Coverage check run existed at all, and a required context that is never reported blocks
  // the PR forever. These cases prove the check can now be GREEN instead of ABSENT.
  const noReviewEnv = (over = {}) =>
    healthyEnv({ REVIEW_INPUT_TOKENS: '', REVIEW_CONCLUSION: 'skipped', ...over });

  it('an out-of-scope PR yields NOT_REVIEWED, not UNKNOWN', () => {
    const coverage = buildCoverage({
      diffText: read('small-complete.diff'),
      env: noReviewEnv({ SKIP_REASON: 'no_files_in_review_scope' }),
      context: healthyContext({ changedFilesApi: 2 }),
    });
    expect(coverage.verdict).toBe('NOT_REVIEWED');
    expect(coverage.not_reviewed.reason).toBe('no_files_in_review_scope');
  });

  it('a draft PR yields NOT_REVIEWED, not UNKNOWN', () => {
    const coverage = buildCoverage({
      diffText: read('small-complete.diff'),
      env: noReviewEnv({ SKIP_REASON: 'pull_request_is_draft' }),
      context: healthyContext({ changedFilesApi: 2 }),
    });
    expect(coverage.verdict).toBe('NOT_REVIEWED');
    expect(coverage.not_reviewed.reason).toBe('pull_request_is_draft');
  });

  // The fail-open this could so easily have been. A skip reason must never be able to
  // explain away a review that demonstrably ran, or any PR could be waved through by
  // setting one env var.
  it('a skip reason NEVER suppresses a review that actually ran', () => {
    const coverage = buildCoverage({
      diffText: read('pr-3515.diff'),
      env: healthyEnv({ SKIP_REASON: 'no_files_in_review_scope' }),
      context: healthyContext(),
    });
    expect(coverage.not_reviewed).toBeNull();
    expect(coverage.verdict).toBe('PARTIAL_SOURCE');
  });

  it('an unrecognised skip reason degrades to UNKNOWN, never to a pass', () => {
    const coverage = buildCoverage({
      diffText: read('small-complete.diff'),
      env: noReviewEnv({ SKIP_REASON: 'because_i_said_so' }),
      context: healthyContext({ changedFilesApi: 2 }),
    });
    expect(coverage.not_reviewed).toBeNull();
    expect(coverage.verdict).toBe('UNKNOWN');
  });

  it('every scope skip reason is inside the closed allowlist', () => {
    for (const reason of SCOPE_SKIP_REASONS) {
      expect(NOT_REVIEWED_REASONS).toContain(reason);
    }
  });
});

describe('deriveModels — per-lens ground truth (EHAC-2162, EHAC-2103)', () => {
  // The real modelRuns from eha_care PR #3564, run 31223046934.
  const PR_3564_RUNS = [
    { role: 'reviewer', lensId: 'risk', modelLabel: 'deepseek/deepseek-v4-pro', conclusion: 'success' },
    { role: 'reviewer', lensId: 'design', modelLabel: 'xiaomi/mimo-v2.5-pro', conclusion: 'success' },
    { role: 'reviewer', lensId: 'tests', modelLabel: 'openrouter/z-ai/glm-5.1', conclusion: 'failure' },
    { role: 'reviewer', lensId: 'operations', modelLabel: 'deepseek/deepseek-v4-pro', conclusion: 'success' },
    { role: 'validator-review', lensId: 'validator-self-review', modelLabel: 'openrouter/z-ai/glm-5.1', conclusion: 'failure' },
    { role: 'validator', modelLabel: 'openrouter/z-ai/glm-5.1', conclusion: 'success' },
  ];

  it('counts failed reviewer lenses and failed validator runs separately', () => {
    const models = deriveModels({ modelRuns: PR_3564_RUNS });
    expect(models.rollup.runs_total).toBe(6);
    expect(models.rollup.reviewer_lenses_total).toBe(4);
    expect(models.rollup.reviewer_lenses_failed).toBe(1);
    expect(models.rollup.validator_runs_total).toBe(2);
    expect(models.rollup.validator_runs_failed).toBe(1);
    expect(models.rollup.failed_lens_ids).toEqual(['tests', 'validator-self-review']);
  });

  it('records GLM among the distinct models even though the posted comment erases it', () => {
    const models = deriveModels({ modelRuns: PR_3564_RUNS });
    // The whole point of EHAC-2103: elek's comment rewrote every GLM mention to the deepseek
    // label. modelRuns did not, so the gate can still see all three models.
    expect(models.distinct_models).toEqual([
      'deepseek/deepseek-v4-pro',
      'openrouter/z-ai/glm-5.1',
      'xiaomi/mimo-v2.5-pro',
    ]);
  });

  it('treats an absent or unrecognised conclusion as not-success, never as a pass', () => {
    const models = deriveModels({
      modelRuns: [
        { role: 'reviewer', lensId: 'risk', modelLabel: 'm', conclusion: 'success' },
        { role: 'reviewer', lensId: 'design', modelLabel: 'm' },
        { role: 'reviewer', lensId: 'tests', modelLabel: 'm', conclusion: 'timeout' },
      ],
    });
    expect(models.rollup.reviewer_lenses_failed).toBe(2);
  });

  it('returns runs: null when the summary carries no modelRuns array', () => {
    expect(deriveModels({ run: { conclusion: 'success' } }).runs).toBeNull();
    expect(deriveModels(null).runs).toBeNull();
  });

  it('records the configured council alongside the observed one', () => {
    const models = deriveModels(
      { modelRuns: PR_3564_RUNS },
      { REVIEW_MODELS: 'deepseek/deepseek-v4-pro, xiaomi/mimo-v2.5-pro', VALIDATOR_MODEL: 'openrouter/z-ai/glm-5.1' },
    );
    expect(models.configured.review_models).toEqual(['deepseek/deepseek-v4-pro', 'xiaomi/mimo-v2.5-pro']);
    expect(models.configured.validator_model).toBe('openrouter/z-ai/glm-5.1');
  });

  it('buildCoverage attaches the models block, and renderJobSummary publishes it', () => {
    const coverage = buildCoverage({
      diffText: read('small-complete.diff'),
      env: healthyEnv({
        REVIEW_SUMMARY_JSON: JSON.stringify({
          run: { conclusion: 'success' },
          entity: { actor: 'adothompson', event: 'pull_request' },
          review: { requestedStrategy: 'council', executedStrategy: 'council' },
          cost: { inputTokens: 83_000 },
          modelRuns: PR_3564_RUNS,
        }),
        REVIEW_MODELS: 'deepseek/deepseek-v4-pro,xiaomi/mimo-v2.5-pro,openrouter/z-ai/glm-5.1',
        VALIDATOR_MODEL: 'openrouter/z-ai/glm-5.1',
      }),
      context: healthyContext({ changedFilesApi: 2 }),
    });
    expect(coverage.models.rollup.reviewer_lenses_failed).toBe(1);

    const summary = renderJobSummary(coverage);
    expect(summary).toContain('Model attribution');
    // The attribution must NAME the model the posted comment erases.
    expect(summary).toContain('openrouter/z-ai/glm-5.1');
    expect(summary).toContain('validator-self-review');
    expect(summary).toContain('Distinct models observed:** 3');
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

describe('CLI — --diff-file is EXPLICIT offline mode', () => {
  // Regression lock. `--diff-file` originally inferred offline mode from GITHUB_OUTPUT
  // being unset, but GitHub Actions ALWAYS sets GITHUB_OUTPUT, so the JSON went to the job
  // output file and `COV="$(node measure…)"` came back empty. `Coverage Gate Tests` caught
  // it on PR #5. Offline mode must be selected by the flag, never inferred from the env.
  it('prints the coverage JSON to stdout even when GITHUB_OUTPUT is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-review-coverage-'));
    const outputFile = join(dir, 'github_output');
    const summaryFile = join(dir, 'github_step_summary');
    writeFileSync(outputFile, '');
    writeFileSync(summaryFile, '');

    const proc = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, 'measure-review-coverage.mjs'),
        '--diff-file',
        fixturePath('pr-3515.diff'),
      ],
      {
        env: {
          PATH: process.env.PATH,
          ELEK_REF: ELEK_REF_VERIFIED,
          REQUESTED_STRATEGY: 'council',
          EXECUTED_STRATEGY: 'council',
          REVIEW_INPUT_TOKENS: '83000',
          GITHUB_OUTPUT: outputFile,
          GITHUB_STEP_SUMMARY: summaryFile,
        },
        encoding: 'utf8',
      },
    );

    expect(proc.status).toBe(0);
    const parsed = JSON.parse(proc.stdout);
    expect(parsed.verdict).toBe('PARTIAL_SOURCE');
    // A fixture measurement is not a job output and must not masquerade as one.
    expect(readFileSync(outputFile, 'utf8')).toBe('');
    expect(readFileSync(summaryFile, 'utf8')).toBe('');
  });

  it('exits 0 even on a diff it cannot measure (the producer never fails the review job)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-review-coverage-'));
    const empty = join(dir, 'empty.diff');
    writeFileSync(empty, '');
    const proc = spawnSync(
      process.execPath,
      [join(import.meta.dirname, 'measure-review-coverage.mjs'), '--diff-file', empty],
      { env: { PATH: process.env.PATH, ELEK_REF: ELEK_REF_VERIFIED }, encoding: 'utf8' },
    );
    expect(proc.status).toBe(0);
    expect(JSON.parse(proc.stdout).verdict).toBe('UNKNOWN');
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
