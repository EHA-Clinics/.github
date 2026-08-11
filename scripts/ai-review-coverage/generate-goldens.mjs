#!/usr/bin/env node
/**
 * generate-goldens.mjs — regenerate `fixtures/golden/`, the FROZEN expected outputs of the
 * prompt-budget model (EHAC-2057, R14).
 *
 * WHY GOLDENS AND NOT A LIVE COMPARISON. The obvious equivalence test — run the wrapper, run
 * the vendored packer, compare — proves nothing, because after D-04 the wrapper's whole job is
 * to call that packer. Both sides would be recomputed by the same change, so the comparison is
 * `A == A`. A golden is a value frozen in a commit: a later change to the wrapper, to the
 * vendored module, or to the runtime that alters the computation shows up as a difference
 * against something that change did NOT recompute.
 *
 * RUN THIS ONLY WHEN THE VENDORED PACKER MOVES. Regenerating goldens to make a red test go
 * green destroys the only property they have. If a golden mismatches and the elek pin has not
 * moved, that is a finding about your change, not a stale fixture.
 *
 *   node scripts/ai-review-coverage/generate-goldens.mjs
 *
 * The manifest it writes records the INPUTS the goldens were produced from — the pinned
 * upstream commit, the vendored file's upstream blob SHA, and this generator's own blob SHA.
 * Deliberately NOT the git commit that lands them: a commit SHA cannot be written into a file
 * that the commit itself contains, which is the same self-referential trap that made an earlier
 * draft of this work record a file's own hash inside the file. Content hashes are recomputable
 * offline (`git hash-object -t blob`) and the spec re-checks all three.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { VENDOR_MANIFEST, attributeCoverage } from './elek-prompt-budget.mjs';

const HERE = import.meta.dirname;
const FIXTURES = join(HERE, 'fixtures');
const GOLDEN = join(FIXTURES, 'golden');
const GENERATOR = join(HERE, 'generate-goldens.mjs');
const VENDORED = join(HERE, 'vendor', 'diff-context.ts');

/** Every committed `.diff` fixture is a golden input; none is opted out. */
export function goldenInputs(dir = FIXTURES) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.diff'))
    .sort();
}

/** `git hash-object -t blob <path>` — the same identifier the spec recomputes. */
export function blobSha(path) {
  return execFileSync('git', ['hash-object', '-t', 'blob', path], { encoding: 'utf8' }).trim();
}

function main() {
  mkdirSync(GOLDEN, { recursive: true });
  const inputs = goldenInputs();
  if (inputs.length === 0) throw new Error('no .diff fixtures found — refusing to write an empty golden set');

  for (const name of inputs) {
    const diff = readFileSync(join(FIXTURES, name), 'utf8');
    const record = attributeCoverage(diff);
    writeFileSync(join(GOLDEN, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(
      `${name}: regime=${record.regime} prompt_chars=${record.prompt_chars} files=${record.rollup.files_total}\n`,
    );
  }

  const manifest = {
    what: 'Expected outputs of attributeCoverage(), frozen at the pinned upstream packer.',
    regenerate_with: 'node scripts/ai-review-coverage/generate-goldens.mjs',
    regenerate_only_when: 'the elek pin moves and vendor/diff-context.ts is re-vendored',
    inputs: {
      upstream_commit: VENDOR_MANIFEST.upstream_commit,
      upstream_blob_sha: VENDOR_MANIFEST.upstream_blob_sha,
      vendored_blob_sha: blobSha(VENDORED),
      generator_blob_sha: blobSha(GENERATOR),
    },
    fixtures: inputs,
  };
  writeFileSync(join(GOLDEN, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`wrote ${inputs.length} golden(s) + MANIFEST.json\n`);
}

if (process.argv[1] && process.argv[1].endsWith('generate-goldens.mjs')) main();
