import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BUDGET,
  ELEK_REF_VERIFIED,
  attributeCoverage,
  comparePromptPriority,
  packPromptSlices,
  parseUnifiedDiffFiles,
  promptPriority,
} from './elek-prompt-budget.mjs';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8');

/** Minimal ChangedFilePatch stand-in for the pure priority/comparator tests. */
const filePatch = (path, overrides = {}) => ({
  path,
  oldPath: path,
  status: 'modified',
  additions: 1,
  deletions: 0,
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+x\n`,
  pathParseFailed: false,
  ...overrides,
});

describe('frozen upstream constants', () => {
  it('pins the verified elek ref to the v1.1.4 tag SHA', () => {
    expect(ELEK_REF_VERIFIED).toBe('3748508413fb355ae696b8fa98d1075930d12106');
  });

  it('is frozen so no caller can mutate the budget model at runtime', () => {
    expect(Object.isFrozen(BUDGET)).toBe(true);
  });

  it('reads the six constants ported from src/review/diff-context.ts', () => {
    // Values are OBSERVED upstream implementation details, not a contract. On any elek
    // bump these must be re-read at the new ref; until then U1 makes the gate red.
    expect(BUDGET.maxChars).toBe(200_000); // DEFAULT_CHANGED_FILES_PROMPT_CHARS (strategy.ts:55)
    expect(BUDGET.fullDiffThreshold).toBe(80_000); // DEFAULT_FULL_DIFF_THRESHOLD_CHARS
    expect(BUDGET.minFileSlice).toBe(700); // MIN_FILE_SLICE_CHARS
    expect(BUDGET.maxFileSlice).toBe(4_000); // MAX_FILE_SLICE_CHARS
    expect(BUDGET.maxOverviewFiles).toBe(250); // MAX_OVERVIEW_FILES
    expect(BUDGET.packerFileDivisorCap).toBe(40); // Math.min(files.length, 40)
  });
});

describe('parseUnifiedDiffFiles', () => {
  it('counts only real file headers — an embedded "diff --git" in an added line must not split a file', () => {
    const diff = read('embedded-diff-header.diff');

    // The discriminator: a naive substring count over-matches badly on this real diff.
    const naive = (diff.match(/diff --git/g) || []).length;
    expect(naive).toBe(7);

    const files = parseUnifiedDiffFiles(diff);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.pathParseFailed === false)).toBe(true);
    // Every parsed section must itself begin with a real header line.
    for (const file of files) {
      expect(file.patch.startsWith('diff --git ')).toBe(true);
    }
  });

  it('splits the real PR #3515 diff into 15 sections whose patches partition the input', () => {
    const diff = read('pr-3515.diff');
    const files = parseUnifiedDiffFiles(diff);
    expect(files).toHaveLength(15);
    expect(files.map((f) => f.path)).toContain(
      'apps/ehacare/frontend/src/common/services/tenantRoster.ts',
    );
  });

  it('classifies status from the real fixture (added vs modified)', () => {
    const files = parseUnifiedDiffFiles(read('pr-3515.diff'));
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('apps/ehacare/frontend/src/common/services/tenantRoster.ts').status).toBe(
      'added',
    );
    expect(
      byPath.get('apps/ehacare/frontend/src/common/services/sdkClientAdapter.ts').status,
    ).toBe('modified');
  });

  it('yields path "(unknown)" and raises the U6 anomaly flag for an unparseable header', () => {
    // `diff.noprefix=true`, a rename with an exotic path, or a C-escaped path all land here.
    const diff = 'diff --git weird-header-without-a-and-b\nindex 0000000..1111111 100644\n+x\n';
    const files = parseUnifiedDiffFiles(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('(unknown)');
    expect(files[0].pathParseFailed).toBe(true);
    expect(attributeCoverage(diff).rollup.unknown_paths).toBe(1);
  });

  it('returns an empty inventory for input with no file headers at all', () => {
    expect(parseUnifiedDiffFiles('')).toEqual([]);
    expect(parseUnifiedDiffFiles('not a diff at all\n')).toEqual([]);
  });
});

describe('promptPriority / comparePromptPriority', () => {
  it('scores production source 0, tests 1, docs+workflows 4, deletions 5/6', () => {
    expect(promptPriority(filePatch('src/common/services/tenantRoster.ts'))).toBe(0);
    expect(promptPriority(filePatch('src/common/services/tenantRoster.test.ts'))).toBe(1);
    expect(promptPriority(filePatch('e2e/bettercare/tests/thing.spec.ts'))).toBe(1);
    expect(promptPriority(filePatch('docs/guides/DEVELOPER_STANDARDS.md'))).toBe(4);
    expect(promptPriority(filePatch('.github/workflows/ai-code-review.yml'))).toBe(4);
    expect(promptPriority(filePatch('config/tenants.yaml'))).toBe(2);
    expect(promptPriority(filePatch('src/a.ts', { status: 'deleted' }))).toBe(5);
    expect(promptPriority(filePatch('README.md', { status: 'deleted' }))).toBe(6);
  });

  it('puts production source before tests before docs/workflows', () => {
    const ordered = [
      filePatch('docs/x.md'),
      filePatch('src/x.test.ts'),
      filePatch('src/x.ts'),
    ].sort(comparePromptPriority);
    expect(ordered.map((f) => f.path)).toEqual(['src/x.ts', 'src/x.test.ts', 'docs/x.md']);
  });

  it('tie-breaks equal priority by churn descending, then by path', () => {
    const ordered = [
      filePatch('src/b.ts', { additions: 1, deletions: 0 }),
      filePatch('src/a.ts', { additions: 1, deletions: 0 }),
      filePatch('src/c.ts', { additions: 90, deletions: 9 }),
    ].sort(comparePromptPriority);
    expect(ordered.map((f) => f.path)).toEqual(['src/c.ts', 'src/a.ts', 'src/b.ts']);
  });
});

describe('packPromptSlices — which regime elek picks', () => {
  it('inlines the FULL diff when overview + diff fits under the 80,000-char threshold', () => {
    const diff = read('small-complete.diff');
    const packed = packPromptSlices(parseUnifiedDiffFiles(diff), diff);
    expect(packed.regime).toBe('FULL');
    expect(packed.perFileBudget).toBeNull();
    expect(packed.omittedPaths).toEqual([]);
  });

  it('falls to per-file SLICES above the threshold, with a 4,000-char per-file clamp', () => {
    const diff = read('pr-3515.diff');
    const packed = packPromptSlices(parseUnifiedDiffFiles(diff), diff);
    expect(packed.regime).toBe('SLICES');
    // 15 files: floor((200000 - overview - 1200) / 15) is far above the clamp, so the
    // MAX_FILE_SLICE_CHARS ceiling binds. This is why the bump alone is not the fix.
    expect(packed.perFileBudget).toBe(BUDGET.maxFileSlice);
    // No file is dropped entirely at this size — the budget is under-used, not exhausted.
    expect(packed.omittedPaths).toEqual([]);
    expect(packed.promptChars).toBeLessThan(BUDGET.maxChars);
  });
});
