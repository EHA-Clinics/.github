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
import {
  GATE_SCRIPT_DIR,
  changedPathsFromGit,
  findSuppressionKeys,
  inspectGateRefIdentity,
  makeGitTreeResolver,
  runGit,
} from './gate-ref-identity.mjs';

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

  // EHAC-2103 — the configured council must reach the PRODUCER, not just the elek step.
  // Before this, review_models/validator_model were passed only to elek, so the coverage
  // record had nothing to compare modelRuns against and the comment's model claims were
  // structurally uncheckable. Dropping either line silently returns us to that state.
  it('passes the configured council models to the producer', () => {
    const block = review().block;
    expect(block).toMatch(/^ {10}REVIEW_MODELS: \$\{\{ inputs\.review_models \}\}\s*$/m);
    expect(block).toMatch(/^ {10}VALIDATOR_MODEL: \$\{\{ inputs\.validator_model \}\}\s*$/m);
  });

  // EHAC-2060 — scope must be a VERDICT inside this job, never a skip upstream.
  //
  // The whole promotion blocker was that a caller-side `on.pull_request.paths` filter or a
  // draft `if:` prevents the workflow dispatching, so no check run is created and a required
  // context stays pending forever. These invariants keep the decision here, where it can
  // still produce a green NOT_REVIEWED.
  it('resolves review scope in a step, so an out-of-scope PR still reports', () => {
    const block = review().block;
    expect(block).toContain('id: scope');
    expect(block).toMatch(/^ {8}if: steps\.scope\.outputs\.in_scope == 'true'\s*$/m);
    expect(block).toMatch(/^ {10}SKIP_REASON: \$\{\{ steps\.scope\.outputs\.skip_reason \}\}\s*$/m);
  });

  // EHAC-2060 — the producer's `if: always()` is worthless if its script is not on disk.
  // A step with no `if:` defaults to success(), so before this the gate-script checkout
  // skipped on every failed review and the producer died on "Cannot find module".
  it('checks out the gate scripts even when the review failed', () => {
    const block = review().block;
    expect(block).toMatch(
      /- name: Checkout coverage gate scripts\n(?: {8}#.*\n)* {8}if: always\(\)/,
    );
  });

  it('gates only the elek step on scope — never the job', () => {
    // A job-level `if:` here would skip the coverage job too (it `needs: review`), which is
    // exactly the absence-not-green failure this work exists to remove.
    const jobIfs = review().lines.filter((line) => /^ {4}if:/.test(line));
    expect(jobIfs).toEqual([]);
  });
});

// EHAC-2166 — the council model config, guarded on the two ways it has actually gone wrong.
describe('council model configuration', () => {
  // Model-AGNOSTIC by design. An earlier draft asserted a specific model version and was
  // wrong twice over: glm-5.2 had to be reverted within the hour, and then GLM left the
  // council entirely. A version-pinned invariant would have blocked both changes. What must
  // hold whatever the council is made of: no cost_rates entry may name a model the council
  // does not actually use.
  it('carries no orphan cost_rates entry', () => {
    const yaml = withoutComments(source());

    // Read the model lines and the rates line separately. A whole-file scan is what let an
    // earlier draft match inside the rates line and, through greedy backtracking past the
    // `=`, yield a truncated id that could never be found again.
    const defaults = yaml.split('\n').filter((l) => /^ {8}default: '[^']*'/.test(l));
    const rateLine = defaults.find((l) => /=\d/.test(l));
    const modelLines = defaults.filter((l) => !/=\d/.test(l));
    expect(rateLine, 'cost_rates default not found').toBeDefined();

    const configured = new Set(
      modelLines.flatMap((l) => (l.match(/'([^']*)'/)?.[1] ?? '').split(',').map((s) => s.trim())),
    );
    const priced = (rateLine.match(/'([^']*)'/)?.[1] ?? '')
      .split(',')
      .map((e) => e.split('=')[0].trim())
      .filter(Boolean);
    expect(priced.length, 'cost_rates is empty').toBeGreaterThan(0);

    // A rate for a model nobody runs is dead config that silently rots — which is exactly how
    // `glm-5.1=0.98:3.08` survived for months while OpenRouter charged 1.40:4.40, leaving
    // max_cost_usd enforcing a budget against numbers that were not the price.
    for (const m of priced) {
      expect([...configured], `cost_rates prices "${m}", which no lens or validator uses`).toContain(m);
    }
  });

  it('does not use z-ai/glm-5.1 — it never converges (EHAC-2166)', () => {
    // Measured: >620s with zero content on a payload deepseek answered in 6.7s, and still
    // zero content at reasoning effort "low". Not repairable by configuration.
    //
    // Scoped to the CONFIG lines, not the whole file. `withoutComments` only strips `#`
    // lines, so a YAML `description: >` block that explains WHY glm-5.1 was removed counts
    // as content and would fail this test — punishing the documentation that stops someone
    // reintroducing it. What must hold is that no model line names it.
    const defaults = source()
      .split('\n')
      .filter((l) => /^ {8}default: '[^']*'/.test(l));
    expect(defaults.length, 'no default: lines found — the parser has drifted').toBeGreaterThan(0);
    for (const line of defaults) {
      expect(line, 'a model/rate default still names glm-5.1').not.toContain('glm-5.1');
    }
  });

  it('provider-qualifies any z-ai id, so pi cannot self-route it to NVIDIA', () => {
    // A bare `z-ai/*` id routes to NVIDIA (no key -> hang); deepseek/* and xiaomi/* already
    // resolve to OpenRouter. No z-ai model is configured today, so this currently holds
    // vacuously — kept deliberately as a trap for whoever reintroduces one.
    const yaml = withoutComments(source());
    for (const m of yaml.matchAll(/z-ai\/[a-z0-9.\-]+/g)) {
      const idx = m.index ?? 0;
      expect(yaml.slice(Math.max(0, idx - 11), idx), `bare z-ai id at offset ${idx}`).toContain('openrouter/');
    }
  });
});

describe('caller-shape guard is wired and cannot be silently suppressed (EHAC-2060)', () => {
  it('runs assert-caller-shape.mjs from the pinned gate checkout', () => {
    // Running it from anywhere but .ai-review-gate would execute a copy this repo does not
    // pin, reintroducing the drift class the guard exists to detect.
    expect(source()).toMatch(
      /run: node \.ai-review-gate\/scripts\/ai-review-coverage\/assert-caller-shape\.mjs/,
    );
  });

  it('declares a CALLER_SHAPE_MODE', () => {
    expect(source()).toMatch(/^ {10}CALLER_SHAPE_MODE: (warn|enforce)$/m);
  });

  it('carries NO continue-on-error anywhere in the workflow', () => {
    // The suppressor class. `continue-on-error` makes a FAILING step report green, which is
    // precisely how EHAC-2057 became a gate that could not fail. Warn-vs-enforce is carried
    // by CALLER_SHAPE_MODE and the script's exit code, never by hiding the failure.
    expect(source()).not.toMatch(/continue-on-error:\s*true/);
  });

  it('runs the shape check with if: always()', () => {
    // The caller's shape is exactly what needs reporting when the review DIED. A step with
    // no `if:` defaults to success() and would skip in that case — the same defect that
    // silently disabled the gate-script checkout on every failed review.
    //
    // The slice MUST end at the next step. An earlier version took a fixed 1,200-character
    // window, which ran past this step into "Measure review coverage" — whose own
    // `if: always()` satisfied the assertion. Deleting the line under test changed nothing
    // and the test still passed: a check that could not fail, inside the very suite that
    // exists to forbid checks that cannot fail. It was caught only by deleting the line and
    // watching, and it is the reason this comment is longer than the assertion.
    const yaml = source();
    const idx = yaml.indexOf('- name: Check caller workflow shape');
    expect(idx).toBeGreaterThan(-1);
    const next = yaml.indexOf('\n      - name:', idx + 1);
    const block = yaml.slice(idx, next === -1 ? yaml.length : next);
    expect(block).not.toContain('- name: Measure review coverage'); // slice really is bounded
    expect(block).toMatch(/^ {8}if: always\(\)$/m);
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

  // R13 — the SHA-shape assertion above proves the ref LOOKS like a commit. It does not
  // prove the commit holds the gate code this suite is testing. Those are different claims,
  // and the gap between them is a change to a runtime gate module that ships, passes all of
  // these specs, and never executes.
  //
  // Disposition is SPEC Q6, implemented in gate-ref-identity.mjs: an error on the default
  // branch and on a PR that does not touch the gate scripts, a loud WARNING on a PR that
  // does — because the pin is self-referential and PR-1 of the ordered pair legitimately
  // carries a stale pin at review time.
  //
  // ⚠ MEASURED 2026-08-11: the pins are one commit behind HEAD and the trees DIFFER. This
  // case is expected to WARN here (this branch modifies the gate scripts) and to ERROR on
  // main after merge. That red is the finding. It is cleared by BUMPING THE PINS in the
  // follow-up commit — never by relaxing the comparison, excluding a path, or suppressing
  // the step.
  it('proves each pinned ref holds the gate-script tree under test (R13)', () => {
    const repoRoot = join(import.meta.dirname, '..', '..');
    const head = runGit(['rev-parse', `HEAD:${GATE_SCRIPT_DIR}`], repoRoot);

    // A read that ERRORS while resolving a tree is a FAILURE, never a skip. Letting this
    // spec pass when it could not look would recreate, inside the suite that exists to
    // forbid unfailable checks, exactly the defect it forbids.
    expect(head.status, `git rev-parse HEAD:${GATE_SCRIPT_DIR} failed: ${head.stderr}`).toBe(0);

    const findings = inspectGateRefIdentity({
      workflowSource: source(),
      headTree: head.stdout.trim(),
      changedPaths: changedPathsFromGit({ cwd: repoRoot }),
      eventName: process.env.GITHUB_EVENT_NAME ?? 'pull_request',
      resolveTree: makeGitTreeResolver({ cwd: repoRoot }),
    });

    for (const warning of findings.filter((f) => f.level === 'warning')) {
      process.stdout.write(`::warning::${warning.code} ${warning.message}\n`);
    }
    const errors = findings.filter((f) => f.level === 'error');
    expect(errors.map((e) => `${e.code} ${e.message}`)).toEqual([]);
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
    const match = source().match(/uses: EHA-Clinics\/elek@([0-9a-f]{40})/);
    expect(match).not.toBeNull();
    // If these ever diverge the gate reds by design (U1) — but a failing unit test with a
    // clear message beats surprising a PR author.
    expect(match[1]).toBe(ELEK_REF_VERIFIED);
  });

  it('gives the elek step `id: review` (Fault 4 — the outputs were unreachable without it)', () => {
    expect(source()).toMatch(/^ {8}id: review\s*$/m);
  });

  it('wires actor_filter through to elek', () => {
    const text = source();
    for (const key of ['actor_filter']) {
      expect(text).toMatch(new RegExp(`^ {6}${key}:\\s*$`, 'm')); // workflow_call input
      expect(text).toMatch(new RegExp(`^ {10}${key}: \\$\\{\\{ inputs\\.${key} \\}\\}\\s*$`, 'm'));
    }
  });

  it('accepts max_council_changed_lines but no longer forwards it', () => {
    // The pinned action no longer declares this input, so forwarding it produced a permanent
    // yellow "unexpected input" annotation on every run. It is still ACCEPTED so that no caller
    // breaks by continuing to pass it, and it was already inert at its '0' default. Both halves
    // are asserted: dropping the input would break callers, and restoring the passthrough would
    // bring the annotation back.
    const text = source();
    expect(text).toMatch(/^ {6}max_council_changed_lines:\s*$/m);
    expect(text).not.toMatch(/^ {10}max_council_changed_lines: \$\{\{ inputs\./m);
  });

  it('no longer carries the superseded pin or its obsolete justification', () => {
    const text = source();
    expect(text).not.toContain('88813716bf744e2666c078d655abef990b7d82aa');
    expect(text).not.toContain('no release tag yet exposes');
  });
});

/**
 * EHAC-2099 — the trigger must not depend on PR-description prose.
 *
 * `detectTrigger` (elek src/github/trigger.ts:11-46) returns null unless `prompt` is
 * non-empty, the phrase is in `triggerText` (the PR BODY on a pull_request event), or a `pi`
 * label is present. Auto-review therefore rode on the caller's PR template containing
 * "@ai-review"; a hand-written body silently skipped review while the job reported pass.
 *
 * These assertions read the YAML because the defect is invisible from the JavaScript: there
 * is no unit test of elek, and the only artefact that decides whether a review happens at
 * all is this one expression.
 */
describe('the elek step forces a trigger on PR events without hijacking comment requests', () => {
  /** The single `prompt:` line passed to the elek step. */
  const promptLine = () => {
    const match = source().match(/^ {10}prompt: (.+?)\s*$/m);
    if (!match) throw new Error('no `prompt:` input is passed to the elek step');
    return match[1];
  };

  it('passes a prompt to elek at all', () => {
    // Without this, a PR whose body lacks the trigger phrase is never reviewed and the
    // check still reports pass. This is the assertion that would have caught #3530.
    expect(() => promptLine()).not.toThrow();
  });

  it('gates the prompt on pull_request, so a reviewer’s own comment text survives', () => {
    // NOT cosmetic. An unconditional prompt wins at run.ts:16-18 on the issue_comment and
    // pull_request_review_comment paths, discarding the words the reviewer actually typed —
    // "@ai-review focus only on X" would silently become the generic sentence, with no
    // symptom anywhere. This is the guard against "simplifying" the conditional away.
    const line = promptLine();
    expect(line).toContain("github.event_name == 'pull_request'");
    // A ternary/`||` fallback, so non-PR events resolve to empty rather than to the sentence.
    expect(line).toMatch(/\|\|\s*''\s*\}\}$/);
  });

  it('asks for a review rather than some unrelated instruction', () => {
    // EHAC-2167 moved the STRING into an input; the step now passes `inputs.prompt`. Assert
    // the input's DEFAULT still asks for a review, so an unset caller is unchanged.
    const decl = source().match(/^ {6}prompt:\n {8}type: string\n {8}default: '([^']*)'/m);
    expect(decl, 'no `prompt` workflow_call input with a string default').not.toBeNull();
    expect(decl[1]).toMatch(/review this pr/i);
  });

  // EHAC-2167 — the gate is NOT caller-controllable. inputs.prompt supplies the text; the
  // event condition decides whether any prompt is sent. Handing that decision to callers is
  // exactly how EHAC-2099 happened, and kemiqa then repeated it for 18 days.
  it('sources the prompt text from the input but keeps the gate in the workflow', () => {
    expect(promptLine()).toBe("${{ github.event_name == 'pull_request' && inputs.prompt || '' }}");
  });

  // EHAC-2167 — ported from eHealthAfrica/.github. Declared AND passed through, or the
  // migration of kemiqa (which passes '900') silently halves its budget.
  it('declares and passes run_timeout_seconds and allowed_bots', () => {
    for (const key of ['run_timeout_seconds', 'allowed_bots']) {
      expect(source(), `${key} is not declared as a workflow_call input`).toMatch(
        new RegExp(`^ {6}${key}:\\n {8}type: string`, 'm'),
      );
      expect(source(), `${key} is declared but never passed to the elek step`).toMatch(
        new RegExp(`^ {10}${key}: \\$\\{\\{ inputs\\.${key} \\}\\}\\s*$`, 'm'),
      );
    }
  });

  it('still passes trigger_phrase, which continues to govern the comment paths', () => {
    expect(source()).toMatch(/^ {10}trigger_phrase: \$\{\{ inputs\.trigger_phrase \}\}\s*$/m);
  });

  it('documents that setting trigger_phrase is necessary but not sufficient', () => {
    // The old description named only the "you forgot to set trigger_phrase" half, which is
    // how the body-text dependency stayed invisible through two EHAC-2057 passes.
    expect(source()).toMatch(/necessary but NOT\s*\n?\s*#?\s*sufficient/);
  });
});

describe('the tests workflow is itself unsuppressed', () => {
  // The file's own header states there is deliberately no error-suppression key anywhere in
  // it. This promotes that PROSE CONTRACT into an EXECUTED assertion.
  //
  // It calls findSuppressionKeys — the same pure function specified in BOTH directions in
  // gate-ref-identity.test.mjs, against a fixture that carries the key (reported), a fixture
  // that carries it COMMENTED OUT (not reported), and this live file. One implementation,
  // two directions. Reading only the live file would establish that the rule does not fire
  // on clean input, which is not evidence that it fires on dirty input.
  it('has no error-suppression key', () => {
    const findings = findSuppressionKeys(readFileSync(TESTS_WORKFLOW, 'utf8'));
    expect(findings.map((f) => f.message)).toEqual([]);
  });

  it('re-proves the fixture-driven red from the shell, not only through Vitest', () => {
    const text = readFileSync(TESTS_WORKFLOW, 'utf8');
    expect(text).toContain('--diff-file scripts/ai-review-coverage/fixtures/pr-3515.diff');
    expect(text).toContain('PARTIAL_SOURCE');
  });

  // R13 — without full history the resolver cannot see the pinned commits, and because a
  // resolution failure is (correctly) a finding, the identity assertion would red for a
  // reason unrelated to pin identity. That is the state in which someone weakens the rule to
  // clear it, so the depth is part of the assertion rather than an incidental setting.
  it('checks out full history, so the identity assertion can resolve the pinned refs', () => {
    const text = readFileSync(TESTS_WORKFLOW, 'utf8');
    expect(text).toMatch(/^ {10}fetch-depth: 0\s*$/m);
  });
});

/**
 * The two job names in this workflow are a BRANCH-PROTECTION INTERFACE CONTRACT: a required
 * context is matched by name, so renaming one silently detaches protection in every
 * consuming repository — the check simply stops being reported and the PR stops being
 * gated, with no error anywhere.
 *
 * Asserted STRUCTURALLY, as four-space `name:` keys inside a job block. A `grep` for the
 * name would also be satisfied by the several PROSE COMMENTS in this file that discuss the
 * job names, so it could pass with the real job renamed out from under it.
 */
describe('the review job names are unchanged (branch-protection interface contract)', () => {
  const jobNames = () => [...source().matchAll(/^ {4}name: (.+?)\s*$/gm)].map((m) => m[1]);

  it('still declares exactly the two named review jobs', () => {
    expect(jobNames()).toEqual([
      'AI Code Review (${{ inputs.review_strategy }})',
      'AI Review Coverage',
    ]);
  });

  it('each name is a job-block key, not a comment mentioning one', () => {
    // jobBlock walks back to the enclosing `jobs.<id>:` key and throws if there is none, so a
    // name that only appears in prose cannot satisfy this.
    expect(jobBlock(source(), /^ {4}name: AI Review Coverage\s*$/).key).toBe('coverage-gate');
    expect(jobBlock(source(), /^ {4}name: AI Code Review \(/).key).toBe('review');
  });
});

/**
 * README parity — the published interface must match the shipped one.
 *
 * Added 2026-08-16 after an audit found the README documenting 11 of 19 workflow_call
 * inputs, and 2 of those 11 wrong: `max_cost_usd` shown as `0.25` when the workflow had
 * defaulted to `1.00` since the guardrail was widened, and `model` shown as unset when it
 * carries a real default. Eight inputs were absent entirely — including `actor_filter`,
 * whose semantics had JUST been corrected in PR #24, and `allowed_bots`, which flips the
 * actor gate to strict-deny for humans when set alone.
 *
 * That is the same failure family the rest of this file guards, one level up: not a gate
 * that cannot fail, but DOCUMENTATION that cannot be wrong-flagged. A consumer repo
 * configures this workflow from the README; a README that disagrees with the YAML is a
 * silent misconfiguration generator, and every caller inherits it.
 *
 * Dependency-free like the rest of this spec: the inputs block is isolated by indentation
 * rather than parsed with a YAML library, for the reason given in the file header.
 */
describe('the README documents the workflow_call interface accurately', () => {
  const README = join(import.meta.dirname, '..', '..', 'README.md');

  /** Extract `name -> default` for every workflow_call input, by indentation. */
  const workflowInputs = () => {
    const lines = source().split('\n');
    const start = lines.findIndex((l) => /^ {4}inputs:\s*$/.test(l));
    if (start < 0) throw new Error('workflow_call inputs block not found');
    const out = new Map();
    let current = null;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^ {0,4}\S/.test(line) && line.trim() !== '') break; // dedented out of the block
      const key = line.match(/^ {6}([a-z_]+):\s*$/);
      if (key) {
        current = key[1];
        out.set(current, null);
        continue;
      }
      const def = line.match(/^ {8}default:\s*(.+?)\s*$/);
      if (def && current && out.get(current) === null) {
        out.set(current, def[1].replace(/^'(.*)'$/, '$1'));
      }
    }
    return out;
  };

  /** Extract `name -> documented default` from the README's input table. */
  const readmeRows = () => {
    const rows = new Map();
    const re = /^\|\s*`([a-z_]+)`\s*\|\s*[a-z]+\s*\|\s*([^|]*?)\s*\|/gm;
    for (const m of readFileSync(README, 'utf8').matchAll(re)) {
      rows.set(m[1], m[2].trim().replace(/^`(.*)`$/, '$1'));
    }
    return rows;
  };

  it('documents every workflow_call input', () => {
    const undocumented = [...workflowInputs().keys()].filter((k) => !readmeRows().has(k));
    expect(undocumented, `inputs missing from the README table: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('states the correct default for every input it documents', () => {
    const inputs = workflowInputs();
    const rows = readmeRows();
    const wrong = [];
    for (const [name, actual] of inputs) {
      if (!rows.has(name)) continue;
      const documented = rows.get(name);
      // `(unset)` is the table's way of saying "no default". Four inputs (`actor_filter`,
      // `allowed_bots`, `scope_paths`, `pr_number`) declare `default: ''`, which is
      // functionally unset — a caller that omits them and a caller that passes the empty
      // string are indistinguishable downstream — so both spellings satisfy `(unset)`.
      // Any other value must match byte-for-byte.
      const unset = actual === null || actual === "''" || actual === '';
      if (documented === '(unset)') {
        if (!unset) wrong.push(`${name}: README says unset, workflow defaults to ${actual}`);
        continue;
      }
      if (unset) {
        wrong.push(`${name}: README says ${documented}, workflow declares no default`);
        continue;
      }
      if (documented !== actual) {
        wrong.push(`${name}: README says ${documented}, workflow defaults to ${actual}`);
      }
    }
    expect(wrong, wrong.join('; ')).toEqual([]);
  });

  it('finds a non-trivial number of inputs, so neither assertion can pass vacuously', () => {
    // Both checks above are satisfied by an empty extraction. If the indentation walk or the
    // table regex stops matching, they would go green while checking nothing.
    expect(workflowInputs().size).toBeGreaterThanOrEqual(15);
    expect(readmeRows().size).toBeGreaterThanOrEqual(15);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * EHAC-2231 — ONE declared tolerance must reach BOTH consumers, and the watchdog must reach
 * elek. These are wiring assertions, not behaviour assertions: the behaviour is proven in
 * assert-review-coverage.test.mjs, and it is worth nothing if the value never arrives.
 *
 * The specific defect being guarded: `max_degraded_lenses` declared and passed to elek but NOT
 * to the asserter would leave the gate on its own default. Every healthy run would still pass,
 * and the two halves would diverge only on the run where the tolerance actually mattered —
 * which is the run nobody is watching.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */
describe('the stall watchdog and the degradation tolerance are wired end to end', () => {
  for (const key of ['stall_timeout_seconds', 'max_degraded_lenses']) {
    it(`declares ${key} as a workflow_call input with a default`, () => {
      expect(source(), `${key} is not declared as a workflow_call input`).toMatch(
        new RegExp(`^ {6}${key}:\\n {8}type: string`, 'm'),
      );
      expect(source(), `${key} is declared without a default`).toMatch(
        new RegExp(`^ {6}${key}:[\\s\\S]{0,2000}?^ {8}default: '`, 'm'),
      );
    });

    it(`passes ${key} through to the elek step`, () => {
      expect(source(), `${key} is declared but never reaches elek`).toMatch(
        new RegExp(`^ {10}${key}: \\$\\{\\{ inputs\\.${key} \\}\\}\\s*$`, 'm'),
      );
    });
  }

  it('passes the SAME max_degraded_lenses to the producer and to the asserter', () => {
    // Exactly two COUNCIL_MAX_DEGRADED lines, both sourced from the same input expression.
    const passthroughs = [...source().matchAll(/^ {10}COUNCIL_MAX_DEGRADED: (.+?)\s*$/gm)].map((m) => m[1]);
    expect(passthroughs, 'COUNCIL_MAX_DEGRADED must reach BOTH the producer and the asserter').toHaveLength(2);
    expect(new Set(passthroughs).size, 'the two consumers were given DIFFERENT expressions').toBe(1);
    expect(passthroughs[0]).toBe('${{ inputs.max_degraded_lenses }}');
  });

  it('gives COUNCIL_MAX_DEGRADED to the coverage-gate job, not only to the review job', () => {
    const gate = jobBlock(source(), /^ {4}name: AI Review Coverage\s*$/);
    expect(withoutComments(gate.block)).toMatch(/COUNCIL_MAX_DEGRADED: \$\{\{ inputs\.max_degraded_lenses \}\}/);
  });

  it('defaults max_degraded_lenses to 1 — the tolerance consumers already have', () => {
    // Declaring 0 here would revert every consumer of this workflow to unanimity, because
    // assert-review-coverage.mjs has shipped DEFAULT_COUNCIL_MAX_DEGRADED = 1 since the quorum
    // landed. That is the defect EHAC-2231 exists to remove, reintroduced as a side effect.
    expect(source()).toMatch(/^ {6}max_degraded_lenses:[\s\S]{0,3000}?^ {8}default: '1'\s*$/m);
  });

  it('defaults stall_timeout_seconds to 0 — a threshold must be measured, not guessed', () => {
    // A non-zero fleet-wide default would convert healthy slow lenses into false stalls on
    // repositories whose idle telemetry nobody has looked at yet.
    expect(source()).toMatch(/^ {6}stall_timeout_seconds:[\s\S]{0,3000}?^ {8}default: '0'\s*$/m);
  });

  it('keeps the two review job names unchanged (branch-protection contract)', () => {
    // Re-asserted HERE as well as in its own describe, because this change touches both jobs'
    // env blocks and the required context string is `<caller job name> / AI Review Coverage`.
    expect(source()).toMatch(/^ {4}name: AI Review Coverage\s*$/m);
    expect(source()).toMatch(/^ {4}name: AI Code Review \(\$\{\{ inputs\.review_strategy \}\}\)\s*$/m);
  });

  // Deliberately NOT re-asserting "no continue-on-error" here: the canonical check lives in
  // the caller-shape describe above and strips comments first, which this file's prose
  // legitimately contains ("NO `continue-on-error:` here, deliberately"). A second, naive copy
  // of that rule would red on the comment explaining why the rule exists.
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * EHAC-2231 — the job ceiling is adjustable, and defaults to what the literal used to be.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */
describe('the review job ceiling is an input, defaulting to the previous literal', () => {
  it('declares job_timeout_minutes with default 30', () => {
    expect(source()).toMatch(/^ {6}job_timeout_minutes:\n {8}type: number/m);
    expect(source(), 'a default other than 30 would change every consumer silently').toMatch(
      /^ {6}job_timeout_minutes:[\s\S]{0,3000}?^ {8}default: 30\s*$/m,
    );
  });

  it('drives the REVIEW job timeout from that input, not a literal', () => {
    const review = jobBlock(source(), /^ {4}name: AI Code Review \(/);
    expect(withoutComments(review.block)).toMatch(
      /^ {4}timeout-minutes: \$\{\{ inputs\.job_timeout_minutes \}\}\s*$/m,
    );
  });

  it('leaves the coverage-gate job on its own small literal cap', () => {
    // The asserter is a few seconds of Node. Tying it to the council's ceiling would be
    // meaningless, and a 45-minute cap on it would hide a hung gate script.
    const gate = jobBlock(source(), /^ {4}name: AI Review Coverage\s*$/);
    expect(withoutComments(gate.block)).toMatch(/^ {4}timeout-minutes: \d+\s*$/m);
  });
});
