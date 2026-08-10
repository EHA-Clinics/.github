/**
 * assert-caller-shape.test.mjs — EHAC-2060/EHAC-2167.
 *
 * Every test here is written so that it FAILS if the corresponding rule is removed. A suite
 * that only feeds clean input proves the parser runs, not that it detects anything, so each
 * rule gets a positive case (a violation IS reported) as well as a negative one.
 */
import { describe, expect, it } from 'vitest';

import {
  countWorkflowLevelPaths,
  inspectCallers,
  isOnDemand,
  jobLevelIfs,
  reusableRefs,
} from './assert-caller-shape.mjs';

const CANON = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const promotableCaller = (sha = CANON) => `name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

jobs:
  review:
    name: AI Review (Council)
    uses: EHA-Clinics/.github/.github/workflows/ai-code-review.yml@${sha}
    with:
      scope_paths: 'apps/**'
    secrets:
      OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}
`;

const onDemandCaller = (sha = CANON) => `name: AI Code Review On Demand

on:
  issue_comment:
    types: [created]

jobs:
  review:
    name: AI Review On Demand (Council)
    if: contains(github.event.comment.body, '@ai-review')
    uses: EHA-Clinics/.github/.github/workflows/ai-code-review.yml@${sha}
    secrets:
      OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}
`;

const f = (name, text) => ({ name, text });

describe('helpers', () => {
  it('counts a workflow-level paths: filter', () => {
    const withPaths = promotableCaller().replace(
      '    types: [opened, synchronize, ready_for_review, reopened]\n',
      "    types: [opened]\n    paths:\n      - 'apps/**'\n",
    );
    expect(countWorkflowLevelPaths(withPaths)).toBe(1);
    expect(countWorkflowLevelPaths(promotableCaller())).toBe(0);
  });

  it('finds job-level ifs at exactly four spaces, not step-level ones', () => {
    expect(jobLevelIfs(onDemandCaller())).toHaveLength(1);
    expect(jobLevelIfs(promotableCaller())).toHaveLength(0);
    // six spaces is a STEP-level if — not a job skip, must not be counted
    expect(jobLevelIfs('jobs:\n  a:\n    steps:\n      if: always()\n')).toHaveLength(0);
  });

  it('extracts the ref and strips a trailing comment', () => {
    expect(reusableRefs(promotableCaller())).toEqual([CANON]);
    const commented = `    uses: EHA-Clinics/.github/.github/workflows/ai-code-review.yml@${CANON} # <SHARED_WF_SHA>`;
    expect(reusableRefs(commented)).toEqual([CANON]);
  });

  it('recognises a comment-triggered caller', () => {
    expect(isOnDemand(onDemandCaller())).toBe(true);
    expect(isOnDemand(promotableCaller())).toBe(false);
  });
});

describe('C1 — workflow-level paths:', () => {
  it('REPORTS a paths-filtered automatic caller', () => {
    const withPaths = promotableCaller().replace(
      '    types: [opened, synchronize, ready_for_review, reopened]\n',
      "    types: [opened]\n    paths:\n      - 'apps/**'\n",
    );
    const findings = inspectCallers([f('ai-code-review.yml', withPaths)]);
    expect(findings.map((x) => x.code)).toContain('C1');
  });

  it('accepts a promotable caller', () => {
    expect(inspectCallers([f('ai-code-review.yml', promotableCaller())])).toEqual([]);
  });
});

describe('C2 — job-level if:', () => {
  it('REPORTS a draft gate on the automatic caller', () => {
    const drafted = promotableCaller().replace(
      '    name: AI Review (Council)\n',
      '    name: AI Review (Council)\n    if: ${{ !github.event.pull_request.draft }}\n',
    );
    const findings = inspectCallers([f('ai-code-review.yml', drafted)]);
    expect(findings.map((x) => x.code)).toContain('C2');
  });

  it('EXEMPTS the on-demand caller, whose if: is the @ai-review gate', () => {
    // Removing that gate would invoke a paid council run on every issue_comment.
    expect(inspectCallers([f('ai-review-on-demand.yml', onDemandCaller())])).toEqual([]);
  });
});

describe('C3 — pin discipline', () => {
  it('REPORTS a branch ref', () => {
    const branchPinned = promotableCaller('main');
    const findings = inspectCallers([f('ai-code-review.yml', branchPinned)]);
    expect(findings.map((x) => x.code)).toContain('C3');
  });

  it('REPORTS callers that disagree on the SHA', () => {
    const findings = inspectCallers([
      f('ai-code-review.yml', promotableCaller(CANON)),
      f('ai-review-on-demand.yml', onDemandCaller(OTHER)),
    ]);
    expect(findings.map((x) => x.code)).toContain('C3');
  });

  it('accepts two callers on the SAME sha', () => {
    expect(
      inspectCallers([
        f('ai-code-review.yml', promotableCaller(CANON)),
        f('ai-review-on-demand.yml', onDemandCaller(CANON)),
      ]),
    ).toEqual([]);
  });
});

describe('non-vacuity', () => {
  it('ignores workflow files that are not callers', () => {
    const unrelated = 'name: CI\non:\n  push:\njobs:\n  a:\n    if: true\n    runs-on: ubuntu-latest\n';
    // An unrelated workflow with a job-level `if:` must NOT be reported — otherwise the
    // guard would red every repo for workflows it has no opinion about.
    expect(inspectCallers([f('ci.yml', unrelated)])).toEqual([]);
  });

  it('returns nothing for an empty file set — which the entrypoint reports as inspecting NOTHING', () => {
    // Guards the "0 findings over 0 files looks like a pass" trap. The empty result is
    // correct here; the entrypoint is what must not present it as success.
    expect(inspectCallers([])).toEqual([]);
  });
});
