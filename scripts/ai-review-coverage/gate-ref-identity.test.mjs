/**
 * gate-ref-identity.test.mjs — R13.
 *
 * Every test here is written so that it FAILS if the corresponding rule is removed. A suite
 * that only feeds clean input proves the parser runs, not that it detects anything, so each
 * behaviour gets a positive case (a violation IS reported) as well as a negative one.
 *
 * The rule is PURE and takes a resolver, so both directions are specified with inline
 * template-literal fixtures and a fake resolver — no repository, no fixture files. The
 * pull-request-touching-gate-scripts branch is untestable any other way: it depends on the
 * event and the changed-path set, neither of which a checkout can be made to have on demand.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GATE_SCRIPT_DIR,
  changedPathsFromGit,
  findSuppressionKeys,
  inspectGateRefIdentity,
  makeGitTreeResolver,
  pinnedGateRefs,
  stripYamlComments,
  touchesGateScripts,
} from './gate-ref-identity.mjs';

const PIN_A = 'a'.repeat(40);
const PIN_B = 'b'.repeat(40);
const TREE_HEAD = '1'.repeat(40);
const TREE_OLD = '2'.repeat(40);

/** Two gate checkouts at the indentation the real workflow uses. */
const reviewWorkflow = (refA = PIN_A, refB = refA) => `name: AI Code Review

jobs:
  review:
    name: AI Code Review (council)
    steps:
      - name: Checkout coverage gate scripts
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          repository: EHA-Clinics/.github
          ref: ${refA}
          sparse-checkout: ${GATE_SCRIPT_DIR}
  coverage-gate:
    name: AI Review Coverage
    steps:
      - name: Checkout coverage gate scripts
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          repository: EHA-Clinics/.github
          ref: ${refB}
          sparse-checkout: ${GATE_SCRIPT_DIR}
`;

/** A resolver that maps refs to trees from a table, and throws for anything unmapped. */
const resolverFrom = (table) => (ref) => {
  if (!(ref in table)) throw new Error(`fatal: bad object ${ref}`);
  return table[ref];
};

const inspect = (over = {}) =>
  inspectGateRefIdentity({
    workflowSource: reviewWorkflow(),
    headTree: TREE_HEAD,
    changedPaths: [],
    eventName: 'push',
    resolveTree: resolverFrom({ [PIN_A]: TREE_HEAD }),
    ...over,
  });

const codes = (findings) => findings.map((f) => f.code);
const errors = (findings) => findings.filter((f) => f.level === 'error');
const warnings = (findings) => findings.filter((f) => f.level === 'warning');

describe('helpers', () => {
  it('extracts both pinned refs at their exact indentation', () => {
    expect(pinnedGateRefs(reviewWorkflow(PIN_A, PIN_B)).map((r) => r.ref)).toEqual([PIN_A, PIN_B]);
    // Eight spaces is a different nesting level and must NOT be picked up — a loose match
    // would silently change what the rule is about.
    expect(pinnedGateRefs(`        ref: ${PIN_A}\n`)).toEqual([]);
  });

  it('recognises a change under the gate-script directory and nothing else', () => {
    expect(touchesGateScripts([`${GATE_SCRIPT_DIR}/assert-review-coverage.mjs`])).toBe(true);
    expect(touchesGateScripts(['README.md'])).toBe(false);
    // A path that merely mentions the directory name is not a change to it.
    expect(touchesGateScripts([`docs/${GATE_SCRIPT_DIR}-notes.md`])).toBe(false);
    // A set we could not read is not an empty set.
    expect(touchesGateScripts(undefined)).toBe(false);
  });
});

describe('R13 — the executed gate copy is the tested gate copy', () => {
  it('errors on the default branch when the pinned tree differs', () => {
    const findings = inspect({
      eventName: 'push',
      resolveTree: resolverFrom({ [PIN_A]: TREE_OLD }),
    });
    expect(codes(findings)).toContain('R13-IDENTITY');
    expect(errors(findings)).toHaveLength(1);
    expect(warnings(findings)).toHaveLength(0);
  });

  it('errors on a pull request that does not touch the gate scripts', () => {
    // No excuse for a stale pin: this PR is not mid-ordered-pair.
    const findings = inspect({
      eventName: 'pull_request',
      changedPaths: ['README.md', 'docs/guide.md'],
      resolveTree: resolverFrom({ [PIN_A]: TREE_OLD }),
    });
    expect(codes(findings)).toContain('R13-IDENTITY');
    expect(errors(findings)).toHaveLength(1);
  });

  it('warns and does not error on a pull request that touches the gate scripts', () => {
    // PR-1 of the two-commit sequence legitimately carries a stale pin at review time. An
    // unconditional error here would block the very sequence the rule protects.
    const findings = inspect({
      eventName: 'pull_request',
      changedPaths: [`${GATE_SCRIPT_DIR}/gate-ref-identity.mjs`],
      resolveTree: resolverFrom({ [PIN_A]: TREE_OLD }),
    });
    expect(codes(findings)).toContain('R13-IDENTITY');
    expect(warnings(findings)).toHaveLength(1);
    expect(errors(findings)).toHaveLength(0);
  });

  it('reports nothing when the pinned tree matches', () => {
    // The accepting control. Without it this could be a rule that cannot pass, which breaks
    // the same property as one that cannot fail.
    expect(inspect()).toEqual([]);
    expect(
      inspect({
        eventName: 'pull_request',
        changedPaths: [`${GATE_SCRIPT_DIR}/gate-ref-identity.mjs`],
      }),
    ).toEqual([]);
  });

  it('reports a finding when the resolver throws', () => {
    // The trap this exists to close: an assertion that PASSES because it could not look is
    // strictly worse than no assertion. The shallow default checkout makes this the COMMON
    // case, not an edge one.
    const findings = inspect({ resolveTree: () => { throw new Error('fatal: bad object'); } });
    expect(codes(findings)).toEqual(['R13-RESOLVE']);
    expect(errors(findings)).toHaveLength(1);
    expect(findings[0].message).toContain('bad object');
  });

  it('reports a finding when the resolver returns an empty tree identifier', () => {
    // An empty read is not agreement. This is the failed-read-as-absence substitution.
    const findings = inspect({ resolveTree: () => '' });
    expect(codes(findings)).toEqual(['R13-RESOLVE']);
  });

  it('reports a finding when the tree under test cannot be resolved', () => {
    const findings = inspect({ headTree: null });
    expect(codes(findings)).toContain('R13-RESOLVE');
    expect(errors(findings).length).toBeGreaterThan(0);
  });

  it('reports a finding when the changed-path set could not be read', () => {
    // Not an empty set. A rule acting on a fact it does not have must say so.
    const findings = inspect({ eventName: 'pull_request', changedPaths: null });
    expect(codes(findings)).toContain('R13-RESOLVE');
  });

  it('reports when the two pinned refs disagree with each other', () => {
    // Unconditional in EVERY event — untouched by the Q6 warning downgrade, which applies to
    // tree identity only. Both trees match HEAD here, so the ONLY thing that can red this
    // case is the disagreement itself.
    const findings = inspectGateRefIdentity({
      workflowSource: reviewWorkflow(PIN_A, PIN_B),
      headTree: TREE_HEAD,
      changedPaths: [`${GATE_SCRIPT_DIR}/x.mjs`],
      eventName: 'pull_request',
      resolveTree: resolverFrom({ [PIN_A]: TREE_HEAD, [PIN_B]: TREE_HEAD }),
    });
    expect(codes(findings)).toEqual(['R13-DISAGREE']);
    expect(errors(findings)).toHaveLength(1);
  });
});

describe('the resolver fetches explicitly and asserts reachability before resolving a tree', () => {
  /** Records argv in order; `fail` names the subcommand that should exit non-zero. */
  const fakeGit = (calls, fail = null) => (args) => {
    calls.push(args);
    const status = args[0] === fail ? 1 : 0;
    return { status, stdout: args[0] === 'rev-parse' ? `${TREE_OLD}\n` : '', stderr: status ? 'boom' : '' };
  };

  it('runs fetch, then cat-file -e, then rev-parse — in that order', () => {
    // `fetch-depth: 0` fetches the history of SURVIVING refs; a squashed or deleted PR tip is
    // not among them, so the explicit per-ref fetch is not redundant with the depth. Asserting
    // the ARGV is the binding proof — a grep for the command text is satisfiable by a comment.
    const calls = [];
    const tree = makeGitTreeResolver({ git: fakeGit(calls) })(PIN_A);
    expect(calls).toEqual([
      ['fetch', '--no-tags', 'origin', PIN_A],
      ['cat-file', '-e', `${PIN_A}^{commit}`],
      ['rev-parse', `${PIN_A}:${GATE_SCRIPT_DIR}`],
    ]);
    expect(tree).toBe(TREE_OLD);
  });

  it('throws when the ref is unreachable, and never reaches rev-parse', () => {
    const calls = [];
    expect(() => makeGitTreeResolver({ git: fakeGit(calls, 'cat-file') })(PIN_A)).toThrow(
      /not reachable/,
    );
    expect(calls.map((c) => c[0])).toEqual(['fetch', 'cat-file']);
  });

  it('tolerates a failing fetch when the object is already present', () => {
    // Some servers refuse an arbitrary SHA in a want. If the object is already in the
    // checkout that is not a failure, and redding here would be a red unrelated to pin
    // identity — the state in which someone weakens the rule to clear it.
    const calls = [];
    expect(makeGitTreeResolver({ git: fakeGit(calls, 'fetch') })(PIN_A)).toBe(TREE_OLD);
  });

  it('throws when the gate directory does not exist at the ref', () => {
    const calls = [];
    expect(() => makeGitTreeResolver({ git: fakeGit(calls, 'rev-parse') })(PIN_A)).toThrow(
      /rev-parse/,
    );
  });
});

describe('changedPathsFromGit refuses to report an unreadable set as empty', () => {
  const git = (results) => (args) => results[args[0]] ?? { status: 0, stdout: '', stderr: '' };

  it('throws when the merge base cannot be computed', () => {
    expect(() =>
      changedPathsFromGit({ git: git({ 'merge-base': { status: 128, stdout: '', stderr: 'no merge base' } }) }),
    ).toThrow(/merge-base/);
  });

  it('unions the committed diff with the uncommitted working tree', () => {
    const paths = changedPathsFromGit({
      git: git({
        'merge-base': { status: 0, stdout: 'deadbeef\n', stderr: '' },
        diff: { status: 0, stdout: 'a.mjs\nb.mjs\n', stderr: '' },
        status: { status: 0, stdout: '?? c.mjs\n M a.mjs\n', stderr: '' },
      }),
    });
    expect(paths.sort()).toEqual(['a.mjs', 'b.mjs', 'c.mjs']);
  });
});

describe('findSuppressionKeys — a pure function over workflow source', () => {
  const workflowWith = (body) => `name: Fixture

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Do a thing
${body}        run: echo hello
`;

  it('REPORTS a step carrying an error-suppression key', () => {
    const findings = findSuppressionKeys(workflowWith('        continue-on-error: true\n'));
    expect(codes(findings)).toEqual(['SUPPRESSION']);
    expect(findings[0].key).toBe('continue-on-error');
  });

  it('does NOT report a commented-out suppression key', () => {
    // A comment is not a suppression. A token-counting rule cannot tell the difference, and
    // this fixture is the only thing that forces the distinction — which is why testing the
    // live clean file alone would establish nothing.
    expect(findSuppressionKeys(workflowWith('        # continue-on-error: true\n'))).toEqual([]);
  });

  it('does NOT report a suppression key inside a quoted string', () => {
    expect(findSuppressionKeys(workflowWith("        name: 'no continue-on-error here'\n"))).toEqual(
      [],
    );
  });

  it('does not report the live coverage-gate-tests.yml, whose header says so deliberately', () => {
    const live = readFileSync(
      join(import.meta.dirname, '..', '..', '.github', 'workflows', 'coverage-gate-tests.yml'),
      'utf8',
    );
    expect(findSuppressionKeys(live)).toEqual([]);
    // Non-vacuity for THIS case: the same live file with one key spliced in IS reported, so
    // the green above is a property of the file and not of an inert rule.
    expect(findSuppressionKeys(live.replace('    steps:', '    continue-on-error: true\n    steps:'))).toHaveLength(1);
  });

  it('strips a trailing comment but keeps a # inside quotes', () => {
    expect(stripYamlComments('  a: b # note\n')[0]).toBe('  a: b');
    expect(stripYamlComments(`  a: 'b # c'\n`)[0]).toBe(`  a: 'b # c'`);
  });
});

describe('non-vacuity', () => {
  it('reports nothing for a workflow with no cross-repository gate checkout', () => {
    // Otherwise the rule would red every workflow it has no opinion about.
    const unrelated = 'name: CI\non:\n  push:\njobs:\n  a:\n    runs-on: ubuntu-latest\n';
    expect(
      inspectGateRefIdentity({
        workflowSource: unrelated,
        headTree: TREE_HEAD,
        changedPaths: [],
        eventName: 'push',
        resolveTree: () => { throw new Error('the resolver must not even be called'); },
      }),
    ).toEqual([]);
  });

  it('returns nothing for empty input — which the caller must not present as a pass', () => {
    // Guards the "0 findings over 0 refs looks like a pass" trap. The empty result is correct
    // here; what must not happen is a caller reporting it as an inspection that succeeded.
    expect(
      inspectGateRefIdentity({
        workflowSource: '',
        headTree: TREE_HEAD,
        changedPaths: [],
        eventName: 'push',
        resolveTree: () => TREE_HEAD,
      }),
    ).toEqual([]);
    expect(pinnedGateRefs('')).toEqual([]);
    expect(findSuppressionKeys('')).toEqual([]);
  });
});
