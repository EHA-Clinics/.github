/**
 * elek-prompt-budget.mjs — the coverage gate's prompt-budget model (EHAC-2057, EHAC-2103).
 *
 * WHAT CHANGED, AND WHY (D-04 / R14). This file used to be a hand-written PORT of elek's
 * packer: it restated the upstream constants and reimplemented the upstream selection
 * arithmetic. That is two implementations of one idea. They agreed on the day the port was
 * written and would have had to be re-derived, by hand, on every elek bump — and a bump that
 * changed the packer without changing the port would have left the gate modelling a version
 * that no longer runs, with every signal still green.
 *
 * There is now ONE implementation. `vendor/diff-context.ts` is the upstream packer, vendored
 * byte-for-byte at the pinned commit, and this file EXECUTES it. Everything below is
 * measurement of what that execution produced.
 *
 * PERMITTED RESPONSIBILITIES OF THIS FILE — the list is exhaustive, and
 * `elek-prompt-budget.test.mjs` asserts that the file declares nothing outside it:
 *   1. marshal arguments into the vendored functions (including the reference inputs used to
 *      read upstream's own file ranking back out of its output);
 *   2. measure what the vendored packer's OUTPUT actually contains, per changed file;
 *   3. carry the vendored module's provenance forward as `ELEK_REF_VERIFIED`;
 *   4. format the coverage report the two halves of the gate consume.
 * Reading a diff from disk belongs to `measure-review-coverage.mjs`, not here.
 *
 * WHAT IS DELIBERATELY NOT HERE. Not one upstream constant. Not the prompt ceiling, not the
 * full-diff threshold, not the slice clamps, not the divisor cap, not the block-fit margin.
 * `formatChangedFilesForPrompt` is called with its own default arguments so that upstream's
 * defaults bind — which is also exactly how elek's own `changedFilesBlock` calls it — so
 * this file never needs to name a number upstream owns. A spec case asserts that none of
 * those literal values appears anywhere in this source.
 *
 * STATED LIMITATION, written rather than implied away: nothing in this file or its spec
 * proves that the GitHub Action executing at runtime uses these semantics. The only link is
 * that `vendor/diff-context.manifest.json`'s `upstream_commit` equals the action pin in
 * .github/workflows/ai-code-review.yml, and that is a link by COMMIT IDENTITY, not by
 * execution. It is asserted; it is not an execution proof, and it must not be read as one.
 *
 * RUNTIME DEPENDENCY: importing a typed module directly requires a Node runtime with
 * unflagged type stripping. The gate workflow pins that runtime as a literal version, and
 * the spec asserts both the literal AND — behaviourally — that this import does not throw.
 *
 * Node built-ins only. Pure functions only: no network, no exec, no filesystem writes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  applyExcludePaths,
  formatChangedFilesForPrompt,
  parseUnifiedDiffFiles,
} from './vendor/diff-context.ts';

/**
 * Provenance of the vendored packer. This file is the single source of truth for which elek
 * commit the gate models; `upstream_blob_sha` is upstream's own git blob identifier for the
 * vendored bytes and is re-checked offline by the spec with `git hash-object -t blob`.
 */
export const VENDOR_MANIFEST = Object.freeze(
  JSON.parse(readFileSync(join(import.meta.dirname, 'vendor', 'diff-context.manifest.json'), 'utf8')),
);

/**
 * The elek ref this budget model is derived from — READ FROM THE MANIFEST, never retyped.
 * `measure-review-coverage.mjs` reds the gate (U1) when the workflow's ELEK_REF disagrees,
 * and `workflow-invariants.test.mjs` asserts the action pin equals this value.
 */
export const ELEK_REF_VERIFIED = VENDOR_MANIFEST.upstream_commit;

/**
 * Reference inputs for reading upstream's own file ranking back out of its output.
 *
 * WHY THIS EXISTS. The gate's predicate is source-weighted: it must distinguish production
 * source from tests, docs and deletions, and it must do so EXACTLY as elek does, or the gate
 * and the reviewer disagree about which files mattered (CONTEXT D-06). elek's classifier
 * (`promptPriority`) is module-private upstream — it is not exported, so it cannot be called.
 * Reimplementing it here would put back the second copy this change exists to delete.
 *
 * So it is not reimplemented; it is OBSERVED. `comparePromptPriority` orders the slice blocks
 * upstream emits by (priority ascending, churn descending, path ascending). Feeding upstream a
 * synthetic diff that contains one minimal section per changed path, plus these six reference
 * sections — each given strictly MORE churn than every synthetic real section, so a reference
 * always sorts first within its own class — makes the emitted order read as:
 *
 *     [ref 0][real files of priority 0][ref 1][priority 1]…[ref 6][priority 6]
 *
 * A file's priority is therefore the priority of the nearest reference that precedes it. The
 * classification is upstream's; only the reference paths are ours.
 *
 * These paths are INPUTS to upstream, not a restatement of its rules. If a future elek changes
 * what counts as production code, the references reorder, the spec's anchor case reds, and the
 * disagreement is reported — which is the whole point. A silently diverging second copy is what
 * we are removing.
 */
export const PRIORITY_PROBES = Object.freeze([
  { priority: 0, suffix: 'production.ts', deleted: false },
  { priority: 1, suffix: 'unit.test.ts', deleted: false },
  { priority: 2, suffix: 'opaque.bin', deleted: false },
  { priority: 4, suffix: 'notes.md', deleted: false },
  { priority: 5, suffix: 'gone.ts', deleted: true },
  { priority: 6, suffix: 'gone.md', deleted: true },
]);

/**
 * Path prefix for the reference sections. Long and arbitrary so it cannot collide with a real
 * changed path; a collision is reported as an anomaly rather than silently absorbed.
 */
export const PROBE_PREFIX = 'zzz-eha-coverage-probe-8f21c4de/';

/** Ceiling handed to the ranking run. Ours, not upstream's: it exists only to guarantee that
 * the ranking run omits nothing, so that every path is observable in the emitted order. */
const PROBE_MAX_CHARS = 1_000_000_000;

/** Padding per synthetic line. Ours, not upstream's: it exists only to make the ranking
 * input's blocks large enough that forcing the slice regime omits nothing. Deliberately NOT
 * equal to upstream's block-fit margin: reusing that value would trip (and deserve to trip)
 * the no-restatement check, whether or not the reuse was coincidental. The digits are not
 * written out even in this comment, because that check reads literals in comments too. */
const PROBE_LINE_PAD_CHARS = 1_536;

/**
 * Build one minimal unified-diff section. Used ONLY to construct the ranking input; the real
 * diff is never rewritten.
 *
 * @param {string} path
 * @param {boolean} deleted  reproduce upstream's deleted-file marker, which its classifier reads
 * @param {string} token     unique marker, so the section is locatable in the emitted output
 *                           without parsing upstream's block-header format
 * @param {number} addedLines churn: exactly this many `+` lines, so churn is ours to control
 * @returns {string}
 */
function probeSection(path, deleted, token, addedLines) {
  const marker = deleted ? '\ndeleted file mode 100644' : '';
  // Each added line is padded so a section is substantially larger than the per-block
  // bookkeeping the packer adds around it. With hairline sections the slice regime costs MORE
  // characters than the inlined diff (a header per file, plus a fit margin, and nothing long
  // enough to actually truncate), so the tail of the ranking input was dropped and those files
  // read back with no priority at all. Padding makes each block genuinely truncatable, which
  // is what lets every file survive the ranking run. The token stays at the START of the line
  // so it survives truncation, and padding does not change churn — that is the line COUNT,
  // which the caller still controls.
  const pad = '.'.repeat(PROBE_LINE_PAD_CHARS);
  const body = Array.from({ length: addedLines }, (_, i) => `+${token}${i}${pad}`).join('\n');
  return (
    `diff --git a/${path} b/${path}${marker}\n` +
    `index 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}\n`
  );
}

/**
 * @typedef {Object} PriorityReading
 * @property {(file: {path: string, status: string}) => number|null} priorityOf
 * @property {string[]} anomalies  reference sections that did not come back, or path collisions
 * @property {number[]} referenceOrder  the reference priorities in the order upstream emitted them
 */

/**
 * Read upstream's own priority for each changed file by executing its sorter.
 *
 * @param {{path: string, status: string}[]} files output of the vendored `parseUnifiedDiffFiles`
 * @returns {PriorityReading}
 */
export function derivePromptPriorities(files) {
  const keyOf = (file) => `${file.status === 'deleted' ? 'D' : 'M'} ${file.path}`;
  const anomalies = [];

  const index = new Map();
  const unique = [];
  for (const file of files) {
    const key = keyOf(file);
    if (!index.has(key)) {
      index.set(key, unique.length);
      unique.push(file);
    }
    if (typeof file.path === 'string' && file.path.startsWith(PROBE_PREFIX)) {
      anomalies.push(`changed path collides with the ranking reference prefix: ${file.path}`);
    }
  }

  const markers = [];
  const sections = [];
  PRIORITY_PROBES.forEach((probe, i) => {
    const token = `EHAPROBE${i}X`;
    markers.push({ token, probe });
    sections.push(probeSection(`${PROBE_PREFIX}${probe.suffix}`, probe.deleted, token, 2));
  });
  unique.forEach((file, i) => {
    const token = `EHAREAL${i}X`;
    markers.push({ token, real: i });
    sections.push(probeSection(file.path, file.status === 'deleted', token, 1));
  });

  // Force the slice regime, which is the only regime that sorts.
  //
  // This used to pass `fullDiffThresholdChars: 0`. That option no longer exists — upstream
  // deleted the separate full-diff threshold — and an unknown property is silently ignored,
  // so the ranking run returned the FULL regime, nothing was ordered, and EVERY file was
  // read back as the priority of the last reference. Source files then scored as priority 6
  // and a starved review measured COMPLETE. Silent, and wrong in the dangerous direction.
  //
  // So force it by BUDGET instead, which no upstream option controls: the packer inlines the
  // full diff only when overview+diff fits within maxChars, so measuring that exact length
  // and asking for one character less guarantees slices. The length is OBSERVED from
  // upstream's own FULL output rather than recomputed, so this survives any future change to
  // the overview format, the caption, or the constants — none of which this file may name.
  const probeDiff = sections.join('');
  const inlined = formatChangedFilesForPrompt(probeDiff, PROBE_MAX_CHARS);
  const ranked = formatChangedFilesForPrompt(probeDiff, Math.max(1, inlined.length - 1));
  if (ranked.endsWith(probeDiff)) {
    // Structural check, same relationship attributeCoverage uses to name the regime: if the
    // emitted text still ends with the whole input, the ranking run did not slice and the
    // order below is not upstream's ranking. Report it rather than derive from it.
    anomalies.push('ranking run did not enter the slice regime; priorities are unreliable');
  }

  const placed = markers
    .map((entry) => ({ ...entry, at: ranked.indexOf(`+${entry.token}0`) }))
    .sort((a, b) => a.at - b.at);

  for (const entry of placed) {
    if (entry.at >= 0) continue;
    anomalies.push(
      entry.probe
        ? `ranking reference of priority ${entry.probe.priority} did not appear in the emitted order`
        : `changed path ${unique[entry.real]?.path ?? '(unknown)'} did not appear in the emitted order`,
    );
  }

  const byUniqueIndex = [];
  const referenceOrder = [];
  let current = null;
  for (const entry of placed) {
    if (entry.at < 0) continue;
    if (entry.probe) {
      current = entry.probe.priority;
      referenceOrder.push(entry.probe.priority);
    } else {
      byUniqueIndex[entry.real] = current;
    }
  }

  return {
    priorityOf: (file) => {
      const at = index.get(keyOf(file));
      const value = at === undefined ? null : byUniqueIndex[at];
      return value === undefined ? null : value;
    },
    anomalies,
    referenceOrder,
  };
}

/**
 * How many characters of `patch` reached `prompt` — measured on the emitted text, not predicted.
 *
 * The block upstream emits for an included file begins with that file's own `diff --git` line
 * and continues with a PREFIX of its patch (a slice, or the whole patch). So: anchor on the
 * patch's first line appearing as a whole line, then count the common prefix from there.
 *
 * Two details are load-bearing.
 *
 * - The anchor requires the header to be a WHOLE line (`\n…\n`). A diff that adds a file whose
 *   content quotes a diff header carries that text as `+diff --git …` or ` diff --git …`, which
 *   cannot match — the `embedded-diff-header.diff` fixture exists for exactly this, and a naive
 *   substring anchor would attribute one file's content to another.
 * - Every occurrence is tried and the longest run kept, because a quoted header could in
 *   principle appear bare. Keeping the longest is conservative in the honest direction: a run
 *   only counts if those characters really are in the prompt.
 *
 * The final trailing-newline trim recovers upstream's own accounting: when it truncates, it cuts
 * at a line boundary and then appends its marker line, so the prompt and the patch share the
 * boundary newline and diverge on the character after it. That shared newline is not content of
 * the file that survived, so it is not counted.
 *
 * @param {string} prompt the text the vendored packer emitted
 * @param {string} patch  the file's full patch, as the vendored parser split it
 * @returns {number} characters of `patch` present in `prompt`; 0 when the file was omitted
 */
export function shownCharsFromPrompt(prompt, patch) {
  if (typeof prompt !== 'string' || typeof patch !== 'string' || patch === '') return 0;
  const anchor = `\n${patch.split('\n', 1)[0] ?? ''}\n`;
  let best = 0;
  let from = 0;
  for (;;) {
    const at = prompt.indexOf(anchor, from);
    if (at < 0) break;
    const start = at + 1;
    const limit = Math.min(patch.length, prompt.length - start);
    let run = 0;
    while (run < limit && prompt.charCodeAt(start + run) === patch.charCodeAt(run)) run++;
    if (run > 0 && patch[run - 1] === '\n') run--;
    if (run > best) best = run;
    from = at + 1;
  }
  return best;
}

/**
 * @typedef {Object} CoverageFile
 * @property {string} path
 * @property {number|null} priority
 * @property {string} status
 * @property {number} patch_chars
 * @property {number} shown_chars
 * @property {number} pct
 * @property {'WHOLE'|'PARTIAL'|'ABSENT'} verdict
 * @property {boolean} path_parse_failed
 */

/**
 * Attribute per-file coverage for a diff by EXECUTING the vendored packer and measuring what
 * it emitted.
 *
 * `options` is a pass-through for specs and probes. Left undefined — which is how the gate
 * calls it, and how elek's own caller calls upstream — every budget decision is taken by
 * upstream's own default arguments.
 *
 * @param {unknown} diffText
 * @param {{maxChars?: number, fullDiffThresholdChars?: number}} [options]
 */
export function attributeCoverage(diffText, options = {}) {
  const text = typeof diffText === 'string' ? diffText : '';
  const excludePaths = Array.isArray(options.excludePaths) ? options.excludePaths : [];
  // `maxChars` and `excludePaths` are REPORTED by the elek run, not re-derived here. The
  // budget is per-model and reservation-aware upstream; modelling it as a flat default with
  // zero reservation made the gate believe the reviewer saw MORE than it did, which is a
  // false green in a safety gate. `fullDiffThresholdChars` is gone: upstream deleted it, and
  // continuing to pass it only made an ignored property look load-bearing.
  const prompt = formatChangedFilesForPrompt(text, options.maxChars, { excludePaths });
  const allParsed = text === '' ? [] : parseUnifiedDiffFiles(text);
  // Files the run EXCLUDED were never sent, so they are not "unreviewed" — they are out of
  // scope. Counting them as ABSENT would red every PR that touches an excluded path. The
  // partition comes from the vendored helper so the gate and the packer cannot disagree
  // about what an exclude glob matches.
  const { kept: parsed, excluded } = applyExcludePaths(allParsed, excludePaths);

  const ranking =
    parsed.length === 0
      ? { priorityOf: () => null, anomalies: [], referenceOrder: [] }
      : derivePromptPriorities(parsed);

  /** @type {CoverageFile[]} */
  const files = parsed.map((file) => {
    const patchChars = file.patch.length;
    const shownChars = shownCharsFromPrompt(prompt, file.patch);
    const verdict = shownChars === 0 ? 'ABSENT' : shownChars >= patchChars ? 'WHOLE' : 'PARTIAL';
    return {
      path: file.path,
      priority: ranking.priorityOf(file),
      status: file.status,
      patch_chars: patchChars,
      shown_chars: shownChars,
      pct: patchChars === 0 ? 0 : Math.floor((shownChars / patchChars) * 100),
      verdict,
      // Upstream's own signal for a header it could not parse: it substitutes this sentinel
      // for BOTH paths. A gate that silently accepts it cannot know what it failed to see (U6).
      path_parse_failed: file.path === '(unknown)' && file.oldPath === '(unknown)',
    };
  });

  const truncated = files.filter((file) => file.shown_chars > 0 && file.shown_chars < file.patch_chars);

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
    // Echoed so a reader of the record can see WHICH budget the verdict was measured against,
    // and whether it came from the run or from upstream's default.
    budget_chars_used: options.maxChars ?? null,
    budget_source: options.maxChars === undefined ? 'upstream-default' : 'reported-by-run',
    excluded_paths: [...excludePaths],
    excluded_files: excluded.map((file) => file.path),
    // The full diff is inlined verbatim in exactly one regime, so the emitted text ends with it.
    // Structural, not a marker grep: it reads the relationship between the two strings rather
    // than a caption upstream happens to print, which a paraphrase of that caption would fake.
    regime: prompt.endsWith(text) ? 'FULL' : 'SLICES',
    // OBSERVED, not upstream's internal per-file budget. That budget is not recoverable from
    // upstream's output, and the only way to publish it would be to restate the arithmetic this
    // change exists to delete. What can be measured is the largest slice that actually survived.
    slice_ceiling_observed: truncated.length === 0 ? null : Math.max(...truncated.map((f) => f.shown_chars)),
    prompt_chars: prompt.length,
    diff_chars: text.length,
    ranking_anomalies: ranking.anomalies,
    files,
    rollup,
  };
}
