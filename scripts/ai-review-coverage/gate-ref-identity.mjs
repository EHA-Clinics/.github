#!/usr/bin/env node
/**
 * gate-ref-identity.mjs — R13: the EXECUTED gate copy is the TESTED gate copy.
 *
 * `ai-code-review.yml` checks `scripts/ai-review-coverage/` out of THIS repository at a
 * pinned SHA, in two places, and then runs it. The pre-existing invariant asserts only that
 * those refs LOOK like commit identifiers (40 hex, not a branch). That is a shape assertion,
 * not an identity assertion: a change to `assert-review-coverage.mjs` or
 * `measure-review-coverage.mjs` can ship, pass all 138 specs, and never execute, because the
 * job executes the copy at the pin and the suite tests the copy at HEAD. Every signal is
 * green and the gate is running last week's code.
 *
 * This module compares the gate-script TREE at each pinned ref against the gate-script tree
 * under test. Trees, not commits: an unrelated commit that does not touch the gate directory
 * leaves the tree identical and must not be reported, or the rule reds on every merge and is
 * switched off within a week.
 *
 * ── Disposition (SPEC Q6) ────────────────────────────────────────────────────────────────
 *   push: main            → a differing tree is an ERROR.
 *   pull_request, and the PR itself modifies scripts/ai-review-coverage/
 *                         → a differing tree is a loud WARNING.
 *   pull_request, and it does not
 *                         → a differing tree is an ERROR.
 *
 * The pin is SELF-REFERENTIAL, so closing drift takes two ordered commits: PR-1 changes the
 * scripts and merges as A; PR-2 bumps both `ref:` lines to A and merges as B. PR-1 therefore
 * legitimately carries a stale pin at the moment it is reviewed, and an unconditional PR
 * error would block the very sequence this rule exists to protect — hence the warning window.
 * A PR that does NOT touch the gate scripts has no such excuse, so it errors.
 *
 * The two rejected shapes, and why:
 *   - main-only: leaves every PR author blind until after merge, so the drift is discovered
 *     by the person who did not cause it.
 *   - warn-always: a verdict nobody enforces, which is this phase's entire subject.
 *
 * ⚠ THE WARNING WINDOW IS NARROW BY CONSTRUCTION. Only TREE IDENTITY is downgraded. The
 * pre-existing pin invariants — 40-hex, never a branch name, and the two refs EQUAL TO EACH
 * OTHER — remain unconditional errors in every event, and R13-DISAGREE below keeps the last
 * of those unconditional here too. A typo'd ref still errors on format; a ref pointing at a
 * real but WRONG commit is the one case that merges on a warning, and the post-merge
 * assertions in the pin-bump change catch it immediately afterwards. That residual is
 * bounded, recorded, and deliberately not eliminated.
 *
 * ⚠ THIS RULE IS EXPECTED TO REPORT AGAINST THE CURRENT TREE. Measured 2026-08-11: HEAD is
 * 393d3c66e1bd31c5518ffd75f6b77d48e8b445ae, both pins are
 * 33a5d280515531b39f752a695926df0a913893dd, and the gate-script trees differ
 * (ee47ec6bd054d967aa5af712fa510a9932693f50 vs 64ab450d27b4af805fae406b0c640a05e2ebc5b4).
 * The finding IS the deliverable. It is cleared by BUMPING THE PINS, never by relaxing the
 * comparison, excluding a path, or suppressing the step.
 *
 * Deliberately dependency-free (Node built-ins only) and PURE: the rule takes a resolver
 * rather than shelling out itself, so both directions can be specified without a repository.
 * A rule embedded in its own spec can only ever be exercised against whatever the repository
 * happens to contain, which makes the pull-request branch untestable.
 */

import { spawnSync } from 'node:child_process';

/** The directory whose tree identity is the subject of R13. */
export const GATE_SCRIPT_DIR = 'scripts/ai-review-coverage';

/** Keys that make GitHub report a failing job or step as green. */
export const ERROR_SUPPRESSION_KEYS = Object.freeze(['continue-on-error']);

/**
 * The `ref:` lines of the cross-repository gate checkouts, matched at their exact
 * indentation. Indentation anchoring is this repository's substitute for a YAML parser: a
 * loose match would also pick up a `ref:` at some other nesting depth and silently change
 * what the rule is about.
 *
 * @param {string} source workflow YAML
 * @returns {{ref: string, index: number}[]}
 */
export function pinnedGateRefs(source) {
  return [...String(source ?? '').matchAll(/^ {10}ref: (\S+)\s*$/gm)].map((m, index) => ({
    ref: m[1],
    index,
  }));
}

/**
 * True when the changed-path set contains anything under the gate-script directory. This is
 * the ONLY input that opens the warning window, so it is deliberately narrow: a path merely
 * mentioning the directory name elsewhere does not count.
 *
 * @param {string[]} changedPaths
 */
export function touchesGateScripts(changedPaths) {
  if (!Array.isArray(changedPaths)) return false;
  return changedPaths.some((p) => String(p ?? '').startsWith(`${GATE_SCRIPT_DIR}/`));
}

/**
 * Remove YAML comments so a comment mentioning a forbidden key cannot be read as the key.
 *
 * A token-counting rule cannot tell `continue-on-error: true` from
 * `# continue-on-error: true`, and the difference is the whole point: one suppresses a
 * failure and the other explains why we do not. Full-line comments go entirely; a trailing
 * comment is stripped only when the text before the `#` has balanced quotes, so a `#` inside
 * a quoted string survives.
 *
 * @param {string} source
 * @returns {string[]} cleaned lines, index-aligned with the input
 */
export function stripYamlComments(source) {
  return String(source ?? '')
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line)) return '';
      let out = line;
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== '#') continue;
        if (i > 0 && !/\s/.test(line[i - 1])) continue;
        const before = line.slice(0, i);
        const singles = (before.match(/'/g) ?? []).length;
        const doubles = (before.match(/"/g) ?? []).length;
        if (singles % 2 === 0 && doubles % 2 === 0) {
          // trimEnd so a stripped line is not distinguishable from one that never carried a
          // comment by trailing whitespace alone.
          out = before.trimEnd();
          break;
        }
      }
      return out;
    });
}

/**
 * Error-suppression keys present in workflow SOURCE. A pure function over text, so it can be
 * specified with a fixture that HAS one — which a read of the live file alone can never do.
 * Testing only a clean input establishes that the rule does not fire, which is not evidence
 * that it fires.
 *
 * @param {string} source workflow YAML
 * @returns {{code: string, level: 'error', line: number, key: string, message: string}[]}
 */
export function findSuppressionKeys(source) {
  const findings = [];
  const lines = stripYamlComments(source);
  for (const [i, line] of lines.entries()) {
    for (const key of ERROR_SUPPRESSION_KEYS) {
      if (new RegExp(`(^|\\s)${key}\\s*:`).test(line)) {
        findings.push({
          code: 'SUPPRESSION',
          level: 'error',
          line: i + 1,
          key,
          message: `line ${i + 1} carries \`${key}\`, which makes GitHub report a failing step as green.`,
        });
      }
    }
  }
  return findings;
}

/**
 * The R13 rule. Pure: every repository interaction arrives through `resolveTree`.
 *
 * @param {object} args
 * @param {string} args.workflowSource   the review workflow's YAML
 * @param {string} args.headTree         gate-script tree identifier of the tree under test
 * @param {string[]} args.changedPaths   paths changed by this event
 * @param {string} args.eventName        `pull_request`, `push`, …
 * @param {(ref: string) => string} args.resolveTree  ref -> gate-script tree identifier
 * @returns {{code: string, level: 'error'|'warning', ref?: string, message: string}[]}
 */
export function inspectGateRefIdentity({
  workflowSource,
  headTree,
  changedPaths,
  eventName,
  resolveTree,
}) {
  const findings = [];
  const refs = pinnedGateRefs(workflowSource);

  // Non-vacuity: a workflow with no cross-repository gate checkout is not this rule's
  // business. Returning nothing here is correct; the CALLER is what must not present
  // "nothing inspected" as a pass.
  if (refs.length === 0) return findings;

  const unique = [...new Set(refs.map((r) => r.ref))];

  // Unconditional in EVERY event, and untouched by the Q6 warning downgrade: two gate
  // checkouts executing different copies of the gate is incoherent regardless of context.
  if (unique.length > 1) {
    findings.push({
      code: 'R13-DISAGREE',
      level: 'error',
      message: `the ${refs.length} gate-script checkouts pin ${unique.length} different commits (${unique.join(', ')}); both jobs must execute the same copy of the gate.`,
    });
  }

  // A changed-path set we could not read is a FAILED READ, never an empty set. Reading it as
  // empty would flip the disposition to "PR does not touch the gate scripts", i.e. it would
  // make the rule STRICTER for the wrong reason — but it would also mean the rule is acting
  // on a fact it does not have, so it is reported.
  const pathsUnreadable = !Array.isArray(changedPaths);
  if (pathsUnreadable) {
    findings.push({
      code: 'R13-RESOLVE',
      level: 'error',
      message:
        'the changed-path set for this event could not be read, so the pull-request disposition cannot be decided. Failing closed: an assertion that cannot look must not pass.',
    });
  }

  const midOrderedPair = eventName === 'pull_request' && touchesGateScripts(changedPaths);
  const level = midOrderedPair ? 'warning' : 'error';

  // The tree under test is half the comparison. Without it there is nothing to compare
  // against, and returning no findings would be the assertion passing because it could not
  // look — strictly worse than not having the assertion at all.
  if (!headTree) {
    findings.push({
      code: 'R13-RESOLVE',
      level: 'error',
      message: `the gate-script tree under test could not be resolved (\`git rev-parse HEAD:${GATE_SCRIPT_DIR}\`). Failing closed.`,
    });
  }

  for (const ref of unique) {
    let tree;
    try {
      tree = resolveTree(ref);
    } catch (err) {
      // NEVER swallow. A resolver that throws means the object is absent from the checkout
      // (this repository's gate checkouts are shallow) or git errored; either way the rule
      // could not look, and "could not look" is a finding.
      findings.push({
        code: 'R13-RESOLVE',
        level: 'error',
        ref,
        message: `could not resolve the gate-script tree at ${ref}: ${err?.message ?? err}`,
      });
      continue;
    }
    if (!tree) {
      findings.push({
        code: 'R13-RESOLVE',
        level: 'error',
        ref,
        message: `the resolver returned no gate-script tree identifier for ${ref}. Failing closed rather than treating an empty read as agreement.`,
      });
      continue;
    }
    if (headTree && tree !== headTree) {
      findings.push({
        code: 'R13-IDENTITY',
        level,
        ref,
        message: `the workflow executes ${GATE_SCRIPT_DIR} from ${ref}, whose tree is ${tree}, but the tree under test is ${headTree}. The executed gate copy is NOT the tested gate copy${
          level === 'warning'
            ? ' — reported as a warning because this pull request modifies the gate scripts and is therefore mid-ordered-pair. Bump both `ref:` lines in the FOLLOW-UP commit.'
            : '. Bump both `ref:` lines to the merged commit; do not relax this comparison.'
        }`,
      });
    }
  }

  return findings;
}

/** Default git runner. Separated so the resolver's argv can be asserted with a fake. */
export const runGit = (args, cwd) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

/**
 * A gate-script tree resolver backed by git.
 *
 * Three steps, in this order, and all three are load-bearing:
 *   1. `git fetch --no-tags origin <ref>` — an EXPLICIT per-ref fetch. `fetch-depth: 0`
 *      fetches the history of surviving refs; a commit that is not an ancestor of any
 *      surviving branch (a squashed or deleted pull-request tip) is not among them, so depth
 *      alone is an assumption dressed as a guarantee. The fetch's own exit status is
 *      TOLERATED — the object may already be present, and some servers refuse an arbitrary
 *      SHA in a want — but its stderr is carried into the failure message below.
 *   2. `git cat-file -e <ref>^{commit}` — reachability. This is the assertion; the fetch is
 *      only the attempt.
 *   3. `git rev-parse <ref>:<gate dir>` — the tree identifier.
 *
 * Any of (2) or (3) failing THROWS, which `inspectGateRefIdentity` turns into a finding.
 *
 * @param {{cwd?: string, remote?: string, git?: typeof runGit}} [options]
 * @returns {(ref: string) => string}
 */
export function makeGitTreeResolver({ cwd, remote = 'origin', git = runGit } = {}) {
  return (ref) => {
    const fetched = git(['fetch', '--no-tags', remote, ref], cwd);
    const reachable = git(['cat-file', '-e', `${ref}^{commit}`], cwd);
    if (reachable.status !== 0) {
      throw new Error(
        `${ref} is not reachable in this checkout after an explicit fetch (git fetch --no-tags ${remote} ${ref} exited ${fetched.status}: ${String(fetched.stderr ?? '').trim() || 'no stderr'}). The checkout needs fetch-depth: 0 AND the ref must still be reachable.`,
      );
    }
    const tree = git(['rev-parse', `${ref}:${GATE_SCRIPT_DIR}`], cwd);
    if (tree.status !== 0) {
      throw new Error(
        `git rev-parse ${ref}:${GATE_SCRIPT_DIR} exited ${tree.status}: ${String(tree.stderr ?? '').trim() || 'no stderr'}`,
      );
    }
    return tree.stdout.trim();
  };
}

/**
 * The paths this branch changes, unioned from the committed diff against the merge base and
 * the uncommitted working tree. THROWS if git cannot answer — a changed-path set that could
 * not be read must not be handed to the rule as an empty array.
 *
 * @param {{cwd?: string, baseRef?: string, git?: typeof runGit}} [options]
 * @returns {string[]}
 */
export function changedPathsFromGit({ cwd, baseRef = 'origin/main', git = runGit } = {}) {
  const mergeBase = git(['merge-base', baseRef, 'HEAD'], cwd);
  if (mergeBase.status !== 0) {
    throw new Error(
      `git merge-base ${baseRef} HEAD exited ${mergeBase.status}: ${String(mergeBase.stderr ?? '').trim() || 'no stderr'}`,
    );
  }
  const committed = git(['diff', '--name-only', mergeBase.stdout.trim(), 'HEAD'], cwd);
  if (committed.status !== 0) {
    throw new Error(`git diff --name-only exited ${committed.status}`);
  }
  const working = git(['status', '--porcelain'], cwd);
  if (working.status !== 0) {
    throw new Error(`git status --porcelain exited ${working.status}`);
  }
  const paths = new Set(
    committed.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const line of working.stdout.split('\n')) {
    const path = line.slice(3).trim();
    if (path) paths.add(path.includes(' -> ') ? path.split(' -> ')[1] : path);
  }
  return [...paths];
}
