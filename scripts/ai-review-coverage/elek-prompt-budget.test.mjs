/**
 * elek-prompt-budget.test.mjs — the offline drift gate around the vendored upstream packer
 * (EHAC-2057, EHAC-2103, R14 / D-04).
 *
 * There are four assertions here, and each one exists because there is a distinct way the
 * second implementation this change deleted could come back:
 *
 *   1. BLOB-HASH AGREEMENT — the vendored file's bytes are upstream's bytes. Catches a hand
 *      edit inside vendored code (the "I just fixed a lint complaint" path).
 *   2. PIN AGREEMENT — the commit the vendored file was taken at is the commit the review
 *      workflow actually pins. Catches a version bump that leaves a stale model behind.
 *   3. GOLDEN-OUTPUT AGREEMENT — the model's output equals values FROZEN at that pin. Catches
 *      any change to the wrapper, the vendored module or the runtime that alters the answer.
 *   4. NO SURVIVING RESTATEMENT — checked mechanically, three ways, plus an enumerated list of
 *      the wrapper's permitted declarations, so the boundary is a list and not a judgement.
 *
 * Each is demonstrated on a deliberate divergence: an assertion whose reporting case has never
 * been run is a claim, not a check.
 *
 * WHAT NONE OF THEM PROVES, stated rather than implied away: that the GitHub Action executing
 * at runtime uses these semantics. The only link is assertion 2, and it links by COMMIT
 * IDENTITY, not by execution.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ELEK_REF_VERIFIED,
  PRIORITY_PROBES,
  PROBE_PREFIX,
  VENDOR_MANIFEST,
  attributeCoverage,
  derivePromptPriorities,
  shownCharsFromPrompt,
} from './elek-prompt-budget.mjs';
import { blobSha, goldenInputs } from './generate-goldens.mjs';
import { parseUnifiedDiffFiles } from './vendor/diff-context.ts';

const HERE = import.meta.dirname;
const FIXTURES = join(HERE, 'fixtures');
const GOLDEN = join(FIXTURES, 'golden');
const VENDORED = join(HERE, 'vendor', 'diff-context.ts');
const MANIFEST_PATH = join(HERE, 'vendor', 'diff-context.manifest.json');
const WRAPPER = join(HERE, 'elek-prompt-budget.mjs');
const REVIEW_WORKFLOW = join(HERE, '..', '..', '.github', 'workflows', 'ai-code-review.yml');
const TESTS_WORKFLOW = join(HERE, '..', '..', '.github', 'workflows', 'coverage-gate-tests.yml');

const read = (path) => readFileSync(path, 'utf8');
const fixture = (name) => read(join(FIXTURES, name));

/**
 * The literal runtime the gate workflow must declare. A LITERAL, deliberately: an earlier draft
 * of this work asserted the version-SHAPED pattern `node-version: .?2[0-9]`, which the measured
 * pre-change value `node-version: 22` already satisfied — a probe that was green before the task
 * began and could not go red, inside the phase whose subject is checks that cannot fail.
 */
const REQUIRED_NODE_VERSION = '24.10.0';

// ---------------------------------------------------------------------------------------
// 1. Blob-hash agreement — the vendored bytes are upstream's bytes
// ---------------------------------------------------------------------------------------

describe('assertion 1 — blob-hash agreement with upstream', () => {
  it('records repository, path, commit and upstream blob sha in a SIBLING manifest', () => {
    for (const key of ['upstream_repo', 'upstream_path', 'upstream_commit', 'upstream_blob_sha']) {
      expect(VENDOR_MANIFEST[key], `manifest is missing ${key}`).toBeTruthy();
    }
    expect(VENDOR_MANIFEST.upstream_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(VENDOR_MANIFEST.upstream_blob_sha).toMatch(/^[0-9a-f]{40}$/);
    // The provenance is auditable: the exact fetch command and the API field it came from.
    expect(VENDOR_MANIFEST.provenance.fetch_command).toContain(VENDOR_MANIFEST.upstream_commit);
    expect(VENDOR_MANIFEST.provenance.sha_field).toBe('.sha');
    expect(VENDOR_MANIFEST.provenance.recompute_offline).toContain('git hash-object -t blob');
  });

  it('carries NO local header — the vendored file is upstream bytes and nothing else', () => {
    // A header would break the byte-identity the blob sha asserts, which is why provenance
    // lives in the sibling manifest. Both reviewers derived the self-referential half of this
    // (a file recording its own hash can never match a naive hash of itself); the byte-identity
    // half follows from the same observation.
    const head = read(VENDORED).split('\n').slice(0, 5).join('\n');
    expect(head).not.toMatch(/upstream|vendored|sha256|content hash/i);
    // Positively: the file begins exactly where upstream's does.
    expect(read(VENDORED).startsWith('export interface ChangedFilePatch {')).toBe(true);
  });

  it('KNOWN-GOOD → silent: git hash-object over the vendored file equals the recorded sha', () => {
    expect(blobSha(VENDORED)).toBe(VENDOR_MANIFEST.upstream_blob_sha);
  });

  it('KNOWN-BAD → reported: a one-character divergence changes the blob sha', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vendor-drift-'));
    const doctored = join(dir, 'diff-context.ts');
    const source = read(VENDORED);
    // One character: a single space appended to the first line. The kind of thing a formatter
    // does, which is the most likely real-world cause of this assertion firing.
    writeFileSync(doctored, source.replace('export interface', 'export  interface'));
    expect(read(doctored)).not.toBe(source);
    expect(blobSha(doctored)).not.toBe(VENDOR_MANIFEST.upstream_blob_sha);
  });

  it('the recorded identity is UPSTREAM’S, not a digest we computed over what we wrote', () => {
    // A hash we mint ourselves proves only that we hashed our own bytes: an edit updating both
    // the file and the digest would pass. A git blob sha is upstream's published identifier for
    // those bytes, so the manifest names where it came from and how to recompute it offline.
    expect(VENDOR_MANIFEST.provenance.sha_source).toMatch(/contents API/i);
    expect(VENDOR_MANIFEST.provenance.sha_source).toMatch(/NOT a digest we computed/i);
    expect(VENDOR_MANIFEST.provenance.sha_command).toContain('gh api');
  });
});

// ---------------------------------------------------------------------------------------
// 2. Pin agreement — the vendored commit is the commit the workflow executes
// ---------------------------------------------------------------------------------------

/**
 * Pure rule, so both directions are specifiable without editing the shipped workflow.
 * @param {string} manifestCommit
 * @param {string} workflowSource
 * @returns {string[]} findings; empty means agreement
 */
function pinAgreementFindings(manifestCommit, workflowSource) {
  const match = String(workflowSource).match(/uses: selimozten\/elek@([0-9a-f]{40})/);
  if (!match) return ['the review workflow does not pin selimozten/elek to a 40-hex commit'];
  if (match[1] !== manifestCommit) {
    return [`vendored at ${manifestCommit} but the workflow pins ${match[1]} — re-vendor before bumping`];
  }
  return [];
}

describe('assertion 2 — pin agreement between the vendored copy and the executed action', () => {
  it('KNOWN-GOOD → silent: the manifest commit equals the action pin in the review workflow', () => {
    expect(pinAgreementFindings(VENDOR_MANIFEST.upstream_commit, read(REVIEW_WORKFLOW))).toEqual([]);
  });

  it('KNOWN-BAD → reported: a manifest commit that differs from the pin', () => {
    const findings = pinAgreementFindings('0'.repeat(40), read(REVIEW_WORKFLOW));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('re-vendor before bumping');
  });

  it('KNOWN-BAD → reported: a workflow with no 40-hex pin at all is a FINDING, not an absence', () => {
    expect(pinAgreementFindings(VENDOR_MANIFEST.upstream_commit, 'uses: selimozten/elek@main\n')).toHaveLength(1);
    expect(pinAgreementFindings(VENDOR_MANIFEST.upstream_commit, '')).toHaveLength(1);
  });

  it('ELEK_REF_VERIFIED is READ FROM the manifest, never retyped beside it', () => {
    expect(ELEK_REF_VERIFIED).toBe(VENDOR_MANIFEST.upstream_commit);
    // The wrapper must not carry the commit as its own literal — that would be a second copy
    // of the pin, free to disagree with the manifest the bytes were actually checked against.
    const declarations = read(WRAPPER).replace(/^ \*.*$/gm, '');
    expect(declarations).not.toContain(VENDOR_MANIFEST.upstream_commit);
  });

  it('states the limitation: pin agreement links by commit identity, NOT by execution', () => {
    const stated = `${read(WRAPPER)}\n${JSON.stringify(VENDOR_MANIFEST)}`;
    expect(stated).toMatch(/COMMIT IDENTITY, not by\s+\**\s*execution/i);
  });

  it('the vendor action pin is UNCHANGED by this plan — the version move is deferred', () => {
    // Bumping here would invalidate the budget model, the pin-verification symbol and the
    // pr-3515 truncation fixture in one commit, and the truncation fixture would then pass for
    // the wrong reason because a newer packer may stop truncating it.
    expect(read(REVIEW_WORKFLOW)).toContain('selimozten/elek@3748508413fb355ae696b8fa98d1075930d12106');
    expect(VENDOR_MANIFEST.notes.join('\n')).toMatch(/COUPLING NOTE/);
  });
});

// ---------------------------------------------------------------------------------------
// 3. Golden-output agreement — frozen expected values, not a second live call
// ---------------------------------------------------------------------------------------

const goldenManifest = () => JSON.parse(read(join(GOLDEN, 'MANIFEST.json')));
const golden = (name) => JSON.parse(read(join(GOLDEN, `${name}.json`)));

describe('assertion 3 — golden-output agreement', () => {
  it('the goldens were generated from THIS vendored module at THIS pin', () => {
    const m = goldenManifest();
    expect(m.inputs.upstream_commit).toBe(VENDOR_MANIFEST.upstream_commit);
    expect(m.inputs.upstream_blob_sha).toBe(VENDOR_MANIFEST.upstream_blob_sha);
    expect(m.inputs.vendored_blob_sha).toBe(blobSha(VENDORED));
    // Not the git commit that lands them: a commit sha cannot be written into a file that the
    // commit contains. Content hashes are recomputable offline and are checked here.
    expect(m.inputs.generator_blob_sha).toBe(blobSha(join(HERE, 'generate-goldens.mjs')));
  });

  it('covers EVERY committed .diff fixture — a per-artefact floor, never an aggregate one', () => {
    const inputs = goldenInputs(FIXTURES);
    expect(inputs.length).toBeGreaterThanOrEqual(3);
    expect(goldenManifest().fixtures).toEqual(inputs);
    const written = readdirSync(GOLDEN).filter((n) => n.endsWith('.diff.json')).sort();
    expect(written).toEqual(inputs.map((n) => `${n}.json`));
  });

  it('KNOWN-GOOD → silent: the model reproduces every committed golden exactly', () => {
    for (const name of goldenInputs(FIXTURES)) {
      expect(attributeCoverage(fixture(name)), `${name} differs from its golden`).toEqual(golden(name));
    }
  });

  it('KNOWN-BAD → reported: a perturbed golden no longer matches', () => {
    for (const name of goldenInputs(FIXTURES)) {
      const perturbed = { ...golden(name), prompt_chars: golden(name).prompt_chars + 1 };
      expect(attributeCoverage(fixture(name))).not.toEqual(perturbed);
    }
  });

  it('KNOWN-BAD → reported: a restated constant that changes the answer breaks the golden', () => {
    // Reintroducing an upstream constant into the wrapper is only harmful because it can
    // disagree with upstream. Simulate the disagreement directly: override the ceiling the way
    // a stale restated copy would, and every fixture diverges from its frozen value.
    for (const name of goldenInputs(FIXTURES)) {
      const withStaleConstant = attributeCoverage(fixture(name), { maxChars: 10_000 });
      expect(withStaleConstant).not.toEqual(golden(name));
    }
  });

  it('the goldens are not a snapshot of themselves: their prompt sizes match values measured BEFORE this change', () => {
    // These three numbers were produced by the previous, independently written implementation,
    // which the repository recorded as having been verified against a real execution of elek at
    // this same pin. They were NOT recomputed by this change, so agreement with them is external
    // corroboration that the rewrite did not quietly redefine the measurement.
    const measuredBefore = {
      'pr-3515.diff': 52_715,
      'small-complete.diff': 14_751,
      'embedded-diff-header.diff': 26_366,
    };
    for (const [name, promptChars] of Object.entries(measuredBefore)) {
      expect(golden(name).prompt_chars, `${name} prompt size`).toBe(promptChars);
      expect(attributeCoverage(fixture(name)).prompt_chars).toBe(promptChars);
    }
  });
});

// ---------------------------------------------------------------------------------------
// 4. No surviving restatement — mechanical, three ways, plus an enumerated boundary
// ---------------------------------------------------------------------------------------

/** Numeric literals in a source, underscores normalised away. */
const numericLiterals = (source) =>
  new Set([...source.matchAll(/\b\d[\d_]*\b/g)].map((m) => Number(m[0].replace(/_/g, ''))));

/**
 * The upstream constants that decide what reaches the prompt, DERIVED from the vendored file
 * rather than retyped here — so a re-vendor updates this check automatically.
 *
 * Single-digit values are excluded: they are unavoidable in any code (`slice(0, …)`, priority
 * ranks) and carry no packing semantics. Every constant that does carry packing semantics is
 * comfortably above that floor, and the spec below asserts the derived set is not empty and
 * does contain the two headline values — otherwise this check could pass by deriving nothing.
 */
const upstreamPackingConstants = () =>
  [...numericLiterals(read(VENDORED))].filter((n) => n >= 10).sort((a, b) => a - b);

/** Output captions a restatement would have to reproduce to match upstream's block lengths. */
const UPSTREAM_CAPTIONS = Object.freeze([
  '# Representative diff slices',
  '# Slices are prioritized toward non-deleted production files',
  '# ... file diff truncated; inspect this file directly if it is relevant.',
  '# Changed file overview (',
  '# ... diff truncated by file for prompt budget; original diff was ',
  ' more file(s)',
  ' changed file(s) omitted from diff slices',
  '(diff unavailable; inspect files from the workspace if needed)',
  '# Full diff',
]);

/** Exports of the vendored module. A wrapper function of the same name is a reimplementation. */
const VENDORED_EXPORTS = Object.freeze(['parseUnifiedDiffFiles', 'formatChangedFilesForPrompt']);

/**
 * The wrapper's permitted top-level declarations, ENUMERATED. "No restatement of behaviour" is
 * unverifiable as prose and gives legitimate wrapper-specific accounting no way to be told apart
 * from a surviving paraphrase. A list makes the boundary checkable: anything not on it must be
 * argued for and added, in review, deliberately.
 */
const PERMITTED_DECLARATIONS = Object.freeze([
  'VENDOR_MANIFEST', //          carry the vendored module's provenance forward
  'ELEK_REF_VERIFIED', //        the same, as the symbol the rest of the gate imports
  'PRIORITY_PROBES', //          reference INPUTS used to read upstream's own ranking back out
  'PROBE_PREFIX', //             the same
  'PROBE_MAX_CHARS', //          the same
  'probeSection', //             marshal those inputs into a diff upstream will accept
  'derivePromptPriorities', //   execute upstream's sorter and read the ranking off its output
  'shownCharsFromPrompt', //     measure what the emitted prompt actually contains
  'attributeCoverage', //        format the report the two halves of the gate consume
]);

/** Top-level `function`/`const`/`let` names declared in a module source. */
const declaredNames = (source) =>
  [...source.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|let)\s+([A-Za-z_$][\w$]*)/gm)].map(
    (m) => m[1],
  );

/**
 * The three mechanical no-restatement checks, as a pure rule so a doctored source can be fed in.
 * @param {string} wrapperSource
 * @param {number[]} forbiddenConstants
 * @returns {string[]}
 */
function restatementFindings(wrapperSource, forbiddenConstants) {
  const findings = [];
  const present = numericLiterals(wrapperSource);
  for (const value of forbiddenConstants) {
    if (present.has(value)) findings.push(`upstream constant ${value} is restated in the wrapper`);
  }
  for (const caption of UPSTREAM_CAPTIONS) {
    if (wrapperSource.includes(caption)) findings.push(`upstream output caption is restated: ${caption}`);
  }
  for (const name of declaredNames(wrapperSource)) {
    if (VENDORED_EXPORTS.includes(name)) findings.push(`the wrapper redefines a vendored export: ${name}`);
  }
  return findings;
}

describe('assertion 4 — no surviving restatement, defined mechanically', () => {
  it('the derived forbidden set is real: non-empty, and it contains the two headline constants', () => {
    // Without this floor the whole check could pass by deriving an empty set — a check that
    // cannot fail, inside the plan whose subject is checks that cannot fail.
    const constants = upstreamPackingConstants();
    expect(constants.length).toBeGreaterThanOrEqual(6);
    expect(constants).toContain(200_000); // the prompt ceiling
    expect(constants).toContain(80_000); // the full-diff threshold
    expect(constants).toEqual([40, 120, 140, 240, 250, 700, 1_200, 4_000, 80_000, 200_000]);
    for (const caption of UPSTREAM_CAPTIONS) {
      expect(read(VENDORED), `caption not found upstream: ${caption}`).toContain(caption);
    }
  });

  it('KNOWN-GOOD → silent: the wrapper restates no constant, no caption and no vendored export', () => {
    expect(restatementFindings(read(WRAPPER), upstreamPackingConstants())).toEqual([]);
  });

  it('KNOWN-BAD → reported: a constant kept "for reference"', () => {
    const doctored = `${read(WRAPPER)}\n/** for reference */\nconst FULL_DIFF_THRESHOLD = 80_000;\n`;
    const findings = restatementFindings(doctored, upstreamPackingConstants());
    expect(findings).toContain('upstream constant 80000 is restated in the wrapper');
  });

  it('KNOWN-BAD → reported: an upstream output caption copied in to match block lengths', () => {
    const doctored = `${read(WRAPPER)}\nconst HEADER = '# Representative diff slices';\n`;
    expect(restatementFindings(doctored, upstreamPackingConstants())).toContain(
      'upstream output caption is restated: # Representative diff slices',
    );
  });

  it('KNOWN-BAD → reported: a wrapper function named after a vendored export', () => {
    const doctored = `${read(WRAPPER)}\nfunction parseUnifiedDiffFiles(diff) { return []; }\n`;
    expect(restatementFindings(doctored, upstreamPackingConstants())).toContain(
      'the wrapper redefines a vendored export: parseUnifiedDiffFiles',
    );
  });

  it('declares EXACTLY its enumerated responsibilities and nothing else', () => {
    expect(declaredNames(read(WRAPPER)).sort()).toEqual([...PERMITTED_DECLARATIONS].sort());
  });

  it('KNOWN-BAD → reported: an extra declaration is outside the enumerated boundary', () => {
    const doctored = `${read(WRAPPER)}\nfunction slicePatch(p, n) { return p.slice(0, n); }\n`;
    expect(declaredNames(doctored).sort()).not.toEqual([...PERMITTED_DECLARATIONS].sort());
  });
});

// ---------------------------------------------------------------------------------------
// Runtime capability — behavioural, plus the workflow's literal version
// ---------------------------------------------------------------------------------------

describe('runtime capability to execute the vendored typed module', () => {
  it('BEHAVIOURAL: a bare Node process imports the vendored typed module without throwing', () => {
    // Vitest transforms TypeScript itself, so importing the module from a spec proves nothing
    // about the runtime. The gate's CLI half runs under plain `node`, so the capability is
    // asserted the way it is actually depended on: in a child process, with no bundler.
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `const m = await import(${JSON.stringify(VENDORED)}); if (typeof m.formatChangedFilesForPrompt !== 'function') process.exit(3);`],
      { encoding: 'utf8' },
    );
    expect(result.stderr).not.toMatch(/ERR_UNKNOWN_FILE_EXTENSION|Unexpected token|strip-types/);
    expect(result.status, `bare node could not import the vendored module:\n${result.stderr}`).toBe(0);
  });

  it('the gate workflow declares the runtime as a LITERAL version, and it is not the pre-change 22', () => {
    const workflow = read(TESTS_WORKFLOW);
    expect(workflow).toMatch(new RegExp(`^ +node-version: ${REQUIRED_NODE_VERSION.replace(/\./g, '\\.')}$`, 'm'));
    // Explicit: the measured pre-change value must be gone. A version-SHAPED pattern such as
    // `node-version: .?2[0-9]` was satisfied by `22` before any change was made.
    expect(workflow).not.toMatch(/^ +node-version: 22\s*$/m);
  });
});

// ---------------------------------------------------------------------------------------
// Measurement properties that must survive the rewrite
// ---------------------------------------------------------------------------------------

describe('measurement properties preserved through the rewrite', () => {
  it('character counts are string length over decoded text, never a byte count', () => {
    const name = 'pr-3515.diff';
    const text = fixture(name);
    const bytes = Buffer.byteLength(text, 'utf8');
    expect(text.length).toBe(137_015);
    expect(bytes).toBe(137_552);
    // The skew is real and measurable — 537 characters on this fixture. Switching to a byte
    // count would silently shift every threshold the model computes.
    expect(bytes).not.toBe(text.length);
    expect(attributeCoverage(text).diff_chars).toBe(text.length);
  });

  it('diff splitting is ANCHORED, so a header quoted inside a patch body is not a new file', () => {
    const diff = fixture('embedded-diff-header.diff');
    const naive = (diff.match(/diff --git/g) || []).length;
    expect(naive).toBe(7); // a substring count over-matches badly on this real diff
    const files = parseUnifiedDiffFiles(diff);
    expect(files).toHaveLength(2);
    for (const file of files) expect(file.patch.startsWith('diff --git ')).toBe(true);
    // And the measurement anchors the same way: neither file absorbs the other's quoted header.
    const record = attributeCoverage(diff);
    expect(record.rollup.files_total).toBe(2);
    expect(record.files.every((f) => f.verdict === 'WHOLE')).toBe(true);
  });

  it('an unparseable header is reported as unknown, never silently accepted', () => {
    const diff = 'diff --git weird-header-without-a-and-b\nindex 0000000..1111111 100644\n+x\n';
    const record = attributeCoverage(diff);
    expect(record.files).toHaveLength(1);
    expect(record.files[0].path).toBe('(unknown)');
    expect(record.files[0].path_parse_failed).toBe(true);
    expect(record.rollup.unknown_paths).toBe(1);
  });

  it('an input with no file headers yields an empty inventory rather than an invented one', () => {
    for (const input of ['', 'not a diff at all\n']) {
      const record = attributeCoverage(input);
      expect(record.rollup.files_total).toBe(0);
      expect(record.files).toEqual([]);
      expect(record.ranking_anomalies).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------
// The ranking is upstream's, read back out of upstream's output
// ---------------------------------------------------------------------------------------

describe('file ranking is OBSERVED from the vendored sorter, not reimplemented', () => {
  const patch = (path, status = 'modified') => ({ path, oldPath: path, status });

  it('the reference sections come back in ascending priority order', () => {
    // If a future elek changes what counts as production code, this reds — which is the entire
    // point of reading the ranking rather than keeping a second copy of the rules.
    const reading = derivePromptPriorities([patch('src/app.ts')]);
    expect(reading.referenceOrder).toEqual(PRIORITY_PROBES.map((p) => p.priority));
    expect(reading.anomalies).toEqual([]);
  });

  it('classifies production source, tests, opaque files, docs and deletions as elek does', () => {
    const files = [
      patch('src/common/services/tenantRoster.ts'),
      patch('src/common/services/tenantRoster.test.ts'),
      patch('e2e/bettercare/tests/thing.spec.ts'),
      patch('docs/guides/DEVELOPER_STANDARDS.md'),
      patch('.github/workflows/ai-code-review.yml'),
      patch('config/tenants.yaml'),
      patch('src/a.ts', 'deleted'),
      patch('README.md', 'deleted'),
    ];
    const { priorityOf } = derivePromptPriorities(files);
    expect(files.map(priorityOf)).toEqual([0, 1, 1, 4, 4, 2, 5, 6]);
  });

  it('reports a changed path that collides with the reference prefix instead of absorbing it', () => {
    const reading = derivePromptPriorities([patch(`${PROBE_PREFIX}production.ts`)]);
    expect(reading.anomalies.join('\n')).toContain('collides with the ranking reference prefix');
  });
});

// ---------------------------------------------------------------------------------------
// The model can still report a cut — the gate remains arithmetically able to go red
// ---------------------------------------------------------------------------------------

describe('coverage attribution over the real #3515 diff', () => {
  it('separates cut production source from cut tests', () => {
    const { rollup, regime, slice_ceiling_observed } = attributeCoverage(fixture('pr-3515.diff'));
    expect(regime).toBe('SLICES');
    expect(rollup.files_total).toBe(15);
    expect(rollup.source_partial).toBe(4);
    expect(rollup.source_absent).toBe(0);
    expect(rollup.whole).toBe(6);
    expect(rollup.non_source_partial).toBe(5);
    expect(rollup.non_source_absent).toBe(0);
    expect(rollup.unknown_paths).toBe(0);
    expect(rollup.whole + rollup.source_partial + rollup.non_source_partial).toBe(15);
    // OBSERVED, not upstream's internal budget: the largest slice that actually survived.
    expect(slice_ceiling_observed).toBe(3_846);
  });

  it('reports files dropped from the prompt ENTIRELY when the ceiling really binds', () => {
    // The default budget under-uses its ceiling on this diff, so nothing is dropped. Squeeze the
    // ceiling and the model must report ABSENT — proof it is arithmetically capable of the worst
    // verdict, not merely of PARTIAL.
    const squeezed = attributeCoverage(fixture('pr-3515.diff'), { maxChars: 3_000 });
    expect(squeezed.rollup.source_absent).toBe(4);
    expect(squeezed.rollup.non_source_absent).toBe(10);
    expect(squeezed.rollup.source_partial).toBe(1);
    expect(squeezed.rollup.whole).toBe(0);
    expect(squeezed.slice_ceiling_observed).toBe(528);
  });

  it('reports every file WHOLE when the full diff is inlined', () => {
    const { rollup, regime, slice_ceiling_observed } = attributeCoverage(fixture('small-complete.diff'));
    expect(regime).toBe('FULL');
    expect(rollup.whole).toBe(rollup.files_total);
    expect(rollup.source_partial + rollup.non_source_partial).toBe(0);
    expect(slice_ceiling_observed).toBeNull();
  });
});

describe('shownCharsFromPrompt', () => {
  it('counts nothing for a patch whose header never appears in the emitted text', () => {
    expect(shownCharsFromPrompt('# Changed file overview (0 files)\n', 'diff --git a/x b/x\n+y')).toBe(0);
  });

  it('is total on non-string input rather than throwing inside the gate', () => {
    expect(shownCharsFromPrompt(null, 'x')).toBe(0);
    expect(shownCharsFromPrompt('x', null)).toBe(0);
    expect(shownCharsFromPrompt('x', '')).toBe(0);
  });
});

// A guard on the guard: `git hash-object` must actually be reachable, or every blob assertion
// above would be failing for an environmental reason rather than a substantive one.
describe('the blob-hash tooling is present', () => {
  it('git hash-object is executable in this environment', () => {
    expect(execFileSync('git', ['hash-object', '-t', 'blob', MANIFEST_PATH], { encoding: 'utf8' }).trim()).toMatch(
      /^[0-9a-f]{40}$/,
    );
  });
});
