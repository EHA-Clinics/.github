/**
 * elek-prompt-budget.mjs — a verbatim port of elek's prompt-budget model, so this
 * organisation can measure which changed files actually reached the review prompt.
 *
 * PORTED FROM: selimozten/elek@3748508413fb355ae696b8fa98d1075930d12106 (v1.1.4),
 *              src/review/diff-context.ts (209 lines), plus the two constants that
 *              select the budget: src/review/strategy.ts:55
 *              DEFAULT_CHANGED_FILES_PROMPT_CHARS = 200_000 and strategy.ts:355
 *              `changedFilesBlock(data, maxChars = DEFAULT_CHANGED_FILES_PROMPT_CHARS)`,
 *              which calls `formatChangedFilesForPrompt(data.diff, maxChars)` with NO
 *              options object — so `fullDiffThresholdChars` keeps its 80_000 default.
 *
 * SUPERSEDED REGIME, recorded because it is the EHAC-2057 root cause: at the previous pin
 * selimozten/elek@88813716bf744e2666c078d655abef990b7d82aa, src/review/strategy.ts:282
 * built the changed-files block with a raw mid-stream `data.diff.slice(0, 60_000)`. Files
 * past that byte offset vanished entirely, INCLUDING their `diff --git` name lines, and the
 * lens was told only "diff truncated for prompt budget". On eha_care PR #3515 that dropped
 * `src/common/services/tenantRoster.ts` outright, the acceptance gates in
 * src/review/contract.ts then converted the missing context into silence ("drop it instead
 * of posting a caveat"), and the check reported green.
 *
 * THESE CONSTANTS ARE OBSERVED UPSTREAM IMPLEMENTATION DETAILS, NOT A CONTRACT. On any elek
 * bump, re-read `src/review/diff-context.ts` at the new ref and update both
 * `ELEK_REF_VERIFIED` and `BUDGET` here, plus the `ELEK_REF` literal in
 * .github/workflows/ai-code-review.yml. Until all three agree, branch U1 makes the coverage
 * gate red by design — an unverified model must not be allowed to certify coverage.
 *
 * Node built-ins only. Pure functions only: no network, no exec, no filesystem writes.
 */

/** The elek ref this budget model was read at and verified against. */
export const ELEK_REF_VERIFIED = '3748508413fb355ae696b8fa98d1075930d12106';

/** The six upstream constants that decide what reaches the prompt. */
export const BUDGET = Object.freeze({
  /** strategy.ts:55 DEFAULT_CHANGED_FILES_PROMPT_CHARS — the absolute ceiling. */
  maxChars: 200_000,
  /** diff-context.ts DEFAULT_FULL_DIFF_THRESHOLD_CHARS — above this, per-file slices. */
  fullDiffThreshold: 80_000,
  /** diff-context.ts MIN_FILE_SLICE_CHARS. */
  minFileSlice: 700,
  /** diff-context.ts MAX_FILE_SLICE_CHARS — the clamp that actually binds in practice. */
  maxFileSlice: 4_000,
  /** diff-context.ts MAX_OVERVIEW_FILES — files named in the overview block. */
  maxOverviewFiles: 250,
  /** diff-context.ts `Math.min(files.length, 40)` in the per-file budget divisor. */
  packerFileDivisorCap: 40,
});

/** Literal strings from the upstream packer, reproduced so block lengths match exactly. */
const SLICE_HEADER_LINES = Object.freeze([
  '# Representative diff slices',
  '# Slices are prioritized toward non-deleted production files so later application changes are not starved by early docs/workflow churn.',
]);
const SLICE_TRUNCATION_MARKER =
  '# ... file diff truncated; inspect this file directly if it is relevant.';
/** diff-context.ts reserves this many characters inside slicePatch for the marker line. */
const SLICE_MARKER_RESERVE = 140;
/** diff-context.ts adds this safety margin to every block-fit test. */
const BLOCK_FIT_MARGIN = 240;
/** diff-context.ts subtracts this from maxChars before dividing the per-file budget. */
const PACKER_OVERHEAD_RESERVE = 1_200;

/**
 * @typedef {Object} ChangedFilePatch
 * @property {string}  path             new path (old path for deletions), or `(unknown)`
 * @property {string}  oldPath
 * @property {'added'|'deleted'|'modified'|'renamed'} status
 * @property {number}  additions
 * @property {number}  deletions
 * @property {string}  patch            the file's raw diff section
 * @property {boolean} pathParseFailed  true when the `diff --git` header would not parse (U6)
 */

/**
 * Split a unified diff into per-file sections, exactly as elek does.
 *
 * The anchored multiline regex is load-bearing: a `grep -c 'diff --git'`-style count
 * over-matches on any diff that ADDS a file whose content quotes a diff (an archived
 * summary, a committed `.patch` fixture), silently over-splitting the inventory. Using
 * elek's own regex means the gate and the reviewer agree even where both are wrong.
 *
 * @param {unknown} diff
 * @returns {ChangedFilePatch[]}
 */
export function parseUnifiedDiffFiles(diff) {
  if (typeof diff !== 'string' || diff === '') return [];

  const starts = [...diff.matchAll(/^diff --git .+$/gm)].map((match) => match.index ?? 0);
  if (starts.length === 0) return [];

  const files = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = starts[i + 1] ?? diff.length;
    const patch = diff.slice(start, end).replace(/\n+$/, '');
    const firstLine = patch.split('\n', 1)[0] ?? '';
    const { oldPath, newPath, parsed } = parseDiffHeader(firstLine);
    const status = patch.includes('\ndeleted file mode ')
      ? 'deleted'
      : patch.includes('\nnew file mode ')
        ? 'added'
        : patch.includes('\nrename from ') || patch.includes('\nrename to ')
          ? 'renamed'
          : 'modified';
    const counts = countPatchChanges(patch);
    files.push({
      path: status === 'deleted' ? oldPath : newPath,
      oldPath,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      patch,
      pathParseFailed: !parsed,
    });
  }
  return files;
}

/**
 * elek's `parseDiffHeader`, plus a `parsed` flag we need for U6. Upstream silently returns
 * `(unknown)`; a gate that silently accepts `(unknown)` cannot know what it failed to see.
 * @param {string} line
 */
function parseDiffHeader(line) {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!match) return { oldPath: '(unknown)', newPath: '(unknown)', parsed: false };
  return { oldPath: unquotePath(match[1]), newPath: unquotePath(match[2]), parsed: true };
}

/** @param {string} path */
function unquotePath(path) {
  return path.replace(/^"|"$/g, '');
}

/** @param {string} patch */
function countPatchChanges(patch) {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions++;
    if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

/**
 * elek's `formatFileOverview`. Reproduced verbatim because its LENGTH feeds the per-file
 * budget arithmetic — a paraphrase would silently shift every slice boundary.
 * @param {ChangedFilePatch[]} files
 * @returns {string}
 */
export function formatFileOverview(files) {
  const shown = files.slice(0, BUDGET.maxOverviewFiles);
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const lines = [
    `# Changed file overview (${files.length} file${files.length === 1 ? '' : 's'}, +${totalAdditions}/-${totalDeletions})`,
    ...shown.map(
      (file) => `# - ${file.path} (${file.status}, +${file.additions}/-${file.deletions})`,
    ),
  ];
  if (files.length > shown.length) {
    lines.push(`# - ... ${files.length - shown.length} more file(s)`);
  }
  return lines.join('\n');
}

/**
 * elek's `promptPriority`. 0 = production source, 1 = tests, 2 = other, 4 = docs/workflows,
 * 5/6 = deletions. The coverage predicate is source-weighted off exactly this function, so
 * the gate and the reviewer rank files identically (CONTEXT D-06).
 * @param {ChangedFilePatch} file
 * @returns {number}
 */
export function promptPriority(file) {
  const nonCode = isDocsOrWorkflow(file.path);
  if (file.status === 'deleted' && nonCode) return 6;
  if (file.status === 'deleted') return 5;
  if (isProductionCode(file.path)) return 0;
  if (isTestCode(file.path)) return 1;
  if (nonCode) return 4;
  return 2;
}

/**
 * elek's `comparePromptPriority`: priority asc, then churn desc, then path.
 * @param {ChangedFilePatch} a
 * @param {ChangedFilePatch} b
 */
export function comparePromptPriority(a, b) {
  const score = promptPriority(a) - promptPriority(b);
  if (score !== 0) return score;
  const churn = b.additions + b.deletions - (a.additions + a.deletions);
  if (churn !== 0) return churn;
  return a.path.localeCompare(b.path);
}

/** @param {string} path */
function isDocsOrWorkflow(path) {
  const lower = path.toLowerCase();
  return (
    lower.startsWith('.github/') ||
    lower.startsWith('docs/') ||
    lower === 'readme.md' ||
    lower.startsWith('readme.') ||
    lower.startsWith('changelog.') ||
    lower.endsWith('.md') ||
    lower.endsWith('.mdx') ||
    lower.endsWith('.rst') ||
    lower.endsWith('.adoc')
  );
}

/** @param {string} path */
function isProductionCode(path) {
  const lower = path.toLowerCase();
  if (isTestCode(lower) || isDocsOrWorkflow(lower)) return false;
  return /\.(ts|tsx|js|jsx|mjs|cjs|go|rs|py|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|ex|exs|erl|hrl|sql)$/.test(
    lower,
  );
}

/** @param {string} path */
function isTestCode(path) {
  const lower = path.toLowerCase();
  return (
    lower.includes('/test/') ||
    lower.includes('/tests/') ||
    lower.includes('__tests__/') ||
    lower.includes('.test.') ||
    lower.includes('.spec.') ||
    lower.endsWith('_test.go')
  );
}

/**
 * elek's `slicePatch`, verbatim — needed for its exact LENGTH in the fit test below.
 * @param {string} patch
 * @param {number} maxChars
 * @returns {string}
 */
function slicePatch(patch, maxChars) {
  if (patch.length <= maxChars) return patch;
  const slice = patch
    .slice(0, Math.max(0, maxChars - SLICE_MARKER_RESERVE))
    .replace(/\n[^\n]*$/, '');
  return `${slice}\n${SLICE_TRUNCATION_MARKER}`;
}

/**
 * How many characters OF THE ORIGINAL PATCH survive `slicePatch`. This is the number the
 * coverage verdict turns on, and it is derived from the ported packer — never defaulted to
 * `patch.length`, which would make the gate arithmetically incapable of going red.
 * @param {string} patch
 * @param {number} maxChars
 * @returns {number}
 */
function shownCharsOf(patch, maxChars) {
  if (patch.length <= maxChars) return patch.length;
  return patch
    .slice(0, Math.max(0, maxChars - SLICE_MARKER_RESERVE))
    .replace(/\n[^\n]*$/, '').length;
}

/**
 * @typedef {Object} PackResult
 * @property {'FULL'|'SLICES'} regime
 * @property {number|null} perFileBudget
 * @property {Map<string, number>} shown   path -> characters of that file's patch in the prompt
 * @property {string[]} omittedPaths       files dropped from the prompt entirely
 * @property {number} promptChars          size of the changed-files block elek would emit
 */

/**
 * Reproduce elek's `formatChangedFilesForPrompt` selection, returning WHAT WAS SHOWN rather
 * than the prompt text.
 *
 * @param {ChangedFilePatch[]} files  output of parseUnifiedDiffFiles for `diffText`
 * @param {string} diffText           the same diff those files were parsed from
 * @param {{maxChars?: number, fullDiffThreshold?: number}} [options]
 * @returns {PackResult}
 */
export function packPromptSlices(files, diffText, options = {}) {
  const maxChars = options.maxChars ?? BUDGET.maxChars;
  const fullDiffThreshold = options.fullDiffThreshold ?? BUDGET.fullDiffThreshold;

  const overview = formatFileOverview(files);
  const fullDiffWithOverview = `${overview}\n\n# Full diff\n${diffText}`;
  if (
    fullDiffWithOverview.length <= maxChars &&
    fullDiffWithOverview.length <= fullDiffThreshold
  ) {
    return {
      regime: 'FULL',
      perFileBudget: null,
      shown: new Map(files.map((file) => [file.path, file.patch.length])),
      omittedPaths: [],
      promptChars: fullDiffWithOverview.length,
    };
  }

  const sorted = [...files].sort(comparePromptPriority);
  const remainingBudget = Math.max(0, maxChars - overview.length - PACKER_OVERHEAD_RESERVE);
  const perFileBudget = Math.max(
    BUDGET.minFileSlice,
    Math.min(
      BUDGET.maxFileSlice,
      Math.floor(
        remainingBudget / Math.max(1, Math.min(files.length, BUDGET.packerFileDivisorCap)),
      ),
    ),
  );

  const blocks = [overview, '', ...SLICE_HEADER_LINES];
  const included = new Set();
  const shown = new Map();

  for (const file of sorted) {
    const slice = slicePatch(file.patch, perFileBudget);
    const header = `\n# ${file.path} (${file.status}, +${file.additions}/-${file.deletions})\n`;
    const block = `${header}${slice}`;
    const nextLength = blocks.join('\n').length + block.length + BLOCK_FIT_MARGIN;
    if (nextLength > maxChars) continue; // omitted from the prompt entirely
    blocks.push(block);
    included.add(file.path);
    shown.set(file.path, shownCharsOf(file.patch, perFileBudget));
  }

  const omittedPaths = files.filter((f) => !included.has(f.path)).map((f) => f.path);
  if (omittedPaths.length > 0) {
    blocks.push('');
    blocks.push(
      `# ... ${omittedPaths.length} changed file(s) omitted from diff slices; see the full file overview above and inspect files with read/grep/find/ls as needed.`,
    );
  }
  blocks.push('');
  blocks.push(
    `# ... diff truncated by file for prompt budget; original diff was ${diffText.length.toLocaleString('en-US')} characters.`,
  );

  for (const file of files) {
    if (!shown.has(file.path)) shown.set(file.path, 0);
  }

  return {
    regime: 'SLICES',
    perFileBudget,
    shown,
    omittedPaths,
    promptChars: blocks.join('\n').slice(0, maxChars).length,
  };
}

/**
 * @typedef {Object} CoverageFile
 * @property {string} path
 * @property {number} priority
 * @property {string} status
 * @property {number} patch_chars
 * @property {number} shown_chars
 * @property {number} pct
 * @property {'WHOLE'|'PARTIAL'|'ABSENT'} verdict
 */

/**
 * Attribute per-file coverage for a diff: what elek would have shown each file, and the
 * rollup counts the gate's predicate is computed from.
 *
 * @param {unknown} diffText
 * @param {{maxChars?: number, fullDiffThreshold?: number}} [options]
 */
export function attributeCoverage(diffText, options = {}) {
  const text = typeof diffText === 'string' ? diffText : '';
  const parsed = parseUnifiedDiffFiles(text);
  const packed = packPromptSlices(parsed, text, options);

  /** @type {CoverageFile[]} */
  const files = parsed.map((file) => {
    const patchChars = file.patch.length;
    const shownChars = packed.shown.get(file.path) ?? 0;
    const verdict = shownChars === 0 ? 'ABSENT' : shownChars >= patchChars ? 'WHOLE' : 'PARTIAL';
    return {
      path: file.path,
      priority: promptPriority(file),
      status: file.status,
      patch_chars: patchChars,
      shown_chars: shownChars,
      pct: patchChars === 0 ? 0 : Math.floor((shownChars / patchChars) * 100),
      verdict,
      path_parse_failed: file.pathParseFailed,
    };
  });

  const rollup = {
    files_total: files.length,
    whole: files.filter((f) => f.verdict === 'WHOLE').length,
    source_partial: files.filter((f) => f.priority === 0 && f.verdict === 'PARTIAL').length,
    source_absent: files.filter((f) => f.priority === 0 && f.verdict === 'ABSENT').length,
    non_source_partial: files.filter((f) => f.priority !== 0 && f.verdict === 'PARTIAL').length,
    non_source_absent: files.filter((f) => f.priority !== 0 && f.verdict === 'ABSENT').length,
    unknown_paths: files.filter((f) => f.path_parse_failed || f.path === '(unknown)').length,
  };

  return {
    regime: packed.regime,
    per_file_budget: packed.perFileBudget,
    prompt_chars: packed.promptChars,
    diff_chars: text.length,
    files,
    rollup,
  };
}
