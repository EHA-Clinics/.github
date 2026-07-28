/**
 * workflow-invariants.test.mjs — asserts the SHIPPED workflow YAML cannot be vacuous.
 *
 * EHAC-2057 is a gate that could not fail. The two mechanisms that make a GitHub gate
 * unfailable are (a) an error-suppression key, which makes GitHub report a failing job as
 * GREEN, and (b) a skipped job, because "successful check statuses are success, skipped and
 * neutral" — a skipped check counts as passing. Neither is visible from a unit test of the
 * gate's JavaScript; both are visible only in the YAML. So this spec reads the real file
 * from disk and parses it.
 *
 * Deliberately dependency-free: Node built-ins only, block isolation by indentation. Adding
 * a YAML parser to prove the gate is honest would put a third-party package between the
 * assertion and the artefact.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ELEK_REF_VERIFIED } from './elek-prompt-budget.mjs';

const WORKFLOW = join(import.meta.dirname, '..', '..', '.github', 'workflows', 'ai-code-review.yml');
const TESTS_WORKFLOW = join(import.meta.dirname, '..', '..', '.github', 'workflows', 'coverage-gate-tests.yml');

/** Keys that make GitHub report a failing job or step as green. */
const ERROR_SUPPRESSION_KEYS = ['continue-on-error'];

const source = () => readFileSync(WORKFLOW, 'utf8');

/** True for a `jobs.<id>:` line (two-space indent, bare key, nothing after the colon). */
const isJobKeyLine = (line) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line);

/**
 * Isolate a top-level job block by walking back from any line inside it to the enclosing
 * `jobs.<id>:` key, then forward to the next one.
 * @param {string} text
 * @param {RegExp} anchor a line pattern known to live inside the wanted job
 * @returns {{key: string, block: string, lines: string[]}}
 */
function jobBlock(text, anchor) {
  const lines = text.split('\n');
  const hit = lines.findIndex((line) => anchor.test(line));
  if (hit < 0) throw new Error(`anchor ${anchor} not found in ${WORKFLOW}`);
  let start = hit;
  while (start > 0 && !isJobKeyLine(lines[start])) start--;
  if (!isJobKeyLine(lines[start])) throw new Error('could not find the enclosing job key');
  let end = start + 1;
  while (end < lines.length && !isJobKeyLine(lines[end])) end++;
  const slice = lines.slice(start, end);
  return { key: lines[start].trim().replace(/:$/, ''), block: slice.join('\n'), lines: slice };
}

/** Strip `#` comment lines so a comment mentioning a forbidden key cannot fail the spec. */
const withoutComments = (block) =>
  block
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

describe('the AI Review Coverage job cannot be suppressed and cannot be skipped', () => {
  const gate = () => jobBlock(source(), /^ {4}name:\s*AI Review Coverage\s*$/);

  it('exists as its own top-level job named exactly "AI Review Coverage"', () => {
    const { key, block } = gate();
    // The job NAME is a branch-protection API contract string: the required-check context
    // is `<caller job name> / AI Review Coverage`. Renaming it breaks 4 protection entries
    // across 2 repos after promotion. Locked by CONTEXT D-01.
    expect(key).toBe('coverage-gate');
    expect(block).toMatch(/^ {4}name: AI Review Coverage(?: |$)/m);
  });

  it('carries no error-suppression key', () => {
    const block = withoutComments(gate().block);
    for (const key of ERROR_SUPPRESSION_KEYS) {
      expect(block, `gate job must not contain ${key} — GitHub would report a failing job as green`).not.toContain(key);
    }
  });

  it('has an `if:` of exactly always() — nothing else', () => {
    const matches = gate()
      .lines.map((line) => line.match(/^ {4}if:\s*(.+?)\s*$/))
      .filter(Boolean);
    // Exactly one job-level `if:`, and its value is exactly always(). Any other condition
    // (a paths-filter output, a draft check, success()) makes the job skippable, and a
    // skipped check counts as passing.
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe('always()');
  });

  it('has no step-level `if:` that could skip the assertion', () => {
    const stepIfs = gate().lines.filter((line) => /^ {8}if:/.test(line));
    expect(stepIfs).toEqual([]);
  });

  it('needs the review job, so it cannot report before the review has resolved', () => {
    expect(gate().block).toMatch(/^ {4}needs: review\s*$/m);
  });

  it('actually runs the asserting script', () => {
    expect(gate().block).toContain('assert-review-coverage.mjs');
    expect(gate().block).toContain('REVIEW_RESULT: ${{ needs.review.result }}');
    expect(gate().block).toContain('COVERAGE_JSON: ${{ needs.review.outputs.coverage_json }}');
  });

  it('does not request `actions: read` (U3 comes from review_summary_json, not the log API)', () => {
    expect(withoutComments(source())).not.toContain('actions: read');
  });
});

describe('the review job exports the coverage record', () => {
  const review = () => jobBlock(source(), /^ {4}name: AI Code Review \(/);

  it('declares the coverage_json job output', () => {
    expect(review().block).toMatch(
      /^ {6}coverage_json: \$\{\{ steps\.coverage\.outputs\.coverage_json \}\}\s*$/m,
    );
  });

  it('runs the producer with `id: coverage` and `if: always()`', () => {
    const block = review().block;
    expect(block).toContain('id: coverage');
    expect(block).toContain('measure-review-coverage.mjs');
    // The producer must emit even when elek failed.
    expect(block).toMatch(/id: coverage\n(?: {8}#.*\n)* {8}if: always\(\)/);
  });

  it('passes the elek pin to the producer as a LITERAL SHA so U1 can detect drift', () => {
    expect(review().block).toMatch(
      new RegExp(`^ {10}ELEK_REF: ${ELEK_REF_VERIFIED}\\s*$`, 'm'),
    );
  });
});

describe('every cross-repo gate checkout is pinned to a SHA, never a branch', () => {
  it('pins ref: to a 40-hex SHA in both gate checkouts', () => {
    const refs = [...source().matchAll(/^ {10}ref: (\S+)\s*$/gm)].map((m) => m[1]);
    // T-2057-01: a floating `ref: main` would let the gate's code change underneath a
    // pinned caller — the pin-drift class this ticket is about.
    expect(refs.length).toBe(2);
    for (const ref of refs) {
      expect(ref).toMatch(/^[0-9a-f]{40}$/);
      expect(ref).not.toBe('main');
    }
    // Both checkouts must reference the SAME commit of the gate code.
    expect(new Set(refs).size).toBe(1);
  });

  it('sparse-checks-out only the gate directory, with credentials not persisted', () => {
    const text = source();
    expect([...text.matchAll(/^ {10}sparse-checkout: scripts\/ai-review-coverage\s*$/gm)]).toHaveLength(2);
    expect([...text.matchAll(/^ {10}repository: EHA-Clinics\/\.github\s*$/gm)]).toHaveLength(2);
    expect([...text.matchAll(/^ {10}persist-credentials: false\s*$/gm)].length).toBeGreaterThanOrEqual(3);
  });
});

describe('the elek step matches the verified budget model', () => {
  it('pins elek to exactly ELEK_REF_VERIFIED', () => {
    const match = source().match(/uses: selimozten\/elek@([0-9a-f]{40})/);
    expect(match).not.toBeNull();
    // If these ever diverge the gate reds by design (U1) — but a failing unit test with a
    // clear message beats surprising a PR author.
    expect(match[1]).toBe(ELEK_REF_VERIFIED);
  });

  it('gives the elek step `id: review` (Fault 4 — the outputs were unreachable without it)', () => {
    expect(source()).toMatch(/^ {8}id: review\s*$/m);
  });

  it('wires both new inputs through to elek', () => {
    const text = source();
    for (const key of ['max_council_changed_lines', 'actor_filter']) {
      expect(text).toMatch(new RegExp(`^ {6}${key}:\\s*$`, 'm')); // workflow_call input
      expect(text).toMatch(new RegExp(`^ {10}${key}: \\$\\{\\{ inputs\\.${key} \\}\\}\\s*$`, 'm'));
    }
  });

  it('no longer carries the superseded pin or its obsolete justification', () => {
    const text = source();
    expect(text).not.toContain('88813716bf744e2666c078d655abef990b7d82aa');
    expect(text).not.toContain('no release tag yet exposes');
  });
});

describe('the tests workflow is itself unsuppressed', () => {
  it('has no error-suppression key', () => {
    const text = withoutComments(readFileSync(TESTS_WORKFLOW, 'utf8'));
    for (const key of ERROR_SUPPRESSION_KEYS) {
      expect(text).not.toContain(key);
    }
  });

  it('re-proves the fixture-driven red from the shell, not only through Vitest', () => {
    const text = readFileSync(TESTS_WORKFLOW, 'utf8');
    expect(text).toContain('--diff-file scripts/ai-review-coverage/fixtures/pr-3515.diff');
    expect(text).toContain('PARTIAL_SOURCE');
  });
});
