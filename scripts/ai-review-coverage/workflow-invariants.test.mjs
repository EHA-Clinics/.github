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
import { NOT_REVIEWED_REASONS } from './measure-review-coverage.mjs';
import {
  findSuppressionKeys,
  inspectGateCheckoutIdentity,
} from './gate-ref-identity.mjs';

const WORKFLOW = join(import.meta.dirname, '..', '..', '.github', 'workflows', 'ai-code-review.yml');
const TESTS_WORKFLOW = join(import.meta.dirname, '..', '..', '.github', 'workflows', 'coverage-gate-tests.yml');

/** Keys that make GitHub report a failing job or step as green. */
const ERROR_SUPPRESSION_KEYS = ['continue-on-error'];

const source = () => readFileSync(WORKFLOW, 'utf8');

/** Read a quoted workflow_call input default without depending on a YAML parser. */
function stringInputDefault(input) {
  const match = source().match(
    new RegExp(`^ {6}${input}:\\n(?:(?!^ {6}[A-Za-z0-9_-]+:)[\\s\\S])*?^ {8}default: '([^']*)'`, 'm'),
  );
  if (!match) throw new Error(`quoted default for ${input} not found in ${WORKFLOW}`);
  return match[1];
}

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
    // The job name is an observability contract consumed by dashboards and automation.
    // The check is permanently advisory and is not a branch-protection requirement.
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
  // A caller-side `on.pull_request.paths` filter or draft `if:` prevents the workflow from
  // dispatching, making an intentional decline indistinguishable from a missing run. These
  // invariants keep the decision here, where it can produce a named NOT_REVIEWED result.
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

  // EHAC-2294 — bot AUTHORSHIP is decided here, and it has to be, because elek decides it
  // from `github.actor` and therefore decides it wrongly. Measured 2026-08-22..24: 41 of 125
  // model runs were bot-authored PRs, all 41 with a human actor.
  it('declines a bot-authored PR inside the scope step, before elek is invoked', () => {
    const block = review().block;
    // The verdict is emitted as a skip_reason, so it flows through the existing SKIP_REASON
    // wiring asserted above and lands in the coverage record rather than skipping the check.
    expect(block).toContain('skip_reason=pr_author_is_bot_not_allowlisted');
    // The decision needs the allowlist, or it would decline a bot a caller deliberately
    // admitted — disagreeing with elek about who is allowed, in the stricter direction.
    expect(block).toMatch(/^ {10}ALLOWED_BOTS: \$\{\{ inputs\.allowed_bots \}\}\s*$/m);
  });

  it('resolves the PR author BEFORE the elek step, not after it', () => {
    // Ordering is the whole mechanism: decided after elek ran, this would be an explanation
    // rather than a control, and the council would already have been paid for.
    const block = review().block;
    // Both anchors are LINE-EXACT on purpose. An earlier draft used indexOf on the bare step
    // name and silently matched a renamed `AI Code Review via OpenRouterX` by prefix — the
    // ordering claim held against a step that no longer existed. Caught by mutating the step
    // name and finding the suite still green.
    const decision = block.search(/^ *echo "skip_reason=pr_author_is_bot_not_allowlisted"/m);
    const elek = block.search(/^ {6}- name: AI Code Review via OpenRouter$/m);
    expect(decision).toBeGreaterThan(-1);
    expect(elek).toBeGreaterThan(-1);
    expect(decision).toBeLessThan(elek);
  });

  it('declines closed or merged pull requests before invoking elek', () => {
    const block = review().block;
    const decision = block.search(/^ *echo "skip_reason=pull_request_not_open"/m);
    const elek = block.search(/^ {6}- name: AI Code Review via OpenRouter$/m);
    expect(block).toContain('PR_STATE');
    expect(decision).toBeGreaterThan(-1);
    expect(elek).toBeGreaterThan(-1);
    expect(decision).toBeLessThan(elek);
  });

  // EHAC-2294 — the gate above was INERT on the comment path until this landed.
  //
  // On an `issue_comment` event there is no `github.event.pull_request`, and no on-demand
  // caller in either consumer passes `pr_number`. PR_NUMBER was therefore empty, every lookup
  // in the step was skipped, and `@ai-review` on a Renovate PR still bought a full council —
  // observed live on eha-care-infra #506 (run 32849221664) the first time it was tried.
  //
  // A shipped control that is silently inert on one of its two trigger paths is the exact
  // failure class this file exists to catch, so it is asserted rather than remembered.
  it('resolves the PR number on the issue_comment path too, or the gate is inert there', () => {
    const block = review().block;
    const line = block.match(/^ {10}PR_NUMBER: (.+)$/m);
    expect(line, 'PR_NUMBER is no longer declared in the scope step').not.toBeNull();
    expect(line[1]).toContain('github.event.issue.number');
    // Ordering matters: pull_request.number must still win where it exists, because
    // issue.number is absent on pull_request events and would otherwise blank the value.
    expect(line[1].indexOf('github.event.pull_request.number')).toBeLessThan(
      line[1].indexOf('github.event.issue.number'),
    );
  });

  it('fails OPEN when the author lookup fails — a human PR is never silently skipped', () => {
    // The asymmetry is deliberate and is the reason this is asserted rather than assumed: a
    // needless council costs dollars, a silently skipped one costs a defect on the base
    // branch. Same posture as the `could not list changed files` branch.
    const block = review().block;
    expect(block).toMatch(
      /could not resolve the pull request state and author — treating it as open and human so the review still runs/,
    );
  });
});

// EHAC-2166 — the council model config, guarded on the two ways it has actually gone wrong.
describe('council model configuration', () => {
  it('assigns one distinct model to each lens, with GLM 5.3 Flash on Operations', () => {
    const models = stringInputDefault('review_models').split(',').map((model) => model.trim());

    expect(models).toEqual([
      'deepseek/deepseek-v4-pro',
      'xiaomi/mimo-v2.5-pro',
      'deepseek/deepseek-v4-flash',
      'openrouter/z-ai/glm-5.3-flash',
    ]);
    expect(new Set(models).size).toBe(4);
    expect(stringInputDefault('validator_model')).toBe('deepseek/deepseek-v4-pro');
  });

  it('budgets GLM 5.3 Flash at the conservative standard rate', () => {
    const rates = stringInputDefault('cost_rates').split(',');
    expect(rates).toContain('openrouter/z-ai/glm-5.3-flash=0.15:0.50');
  });

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
    // resolve to OpenRouter. GLM 5.3 Flash therefore carries an explicit provider prefix.
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

describe('every gate checkout executes the called workflow commit', () => {
  it('uses job.workflow_repository and job.workflow_sha in both gate checkouts', () => {
    expect(inspectGateCheckoutIdentity(source())).toEqual([]);
    expect(
      inspectGateCheckoutIdentity(source().replace('ref: ${{ job.workflow_sha }}', 'ref: main')),
    ).toEqual([expect.objectContaining({ code: 'GATE-CHECKOUT-REF' })]);
  });

  it('sparse-checks-out only the gate directory, with credentials not persisted', () => {
    const text = source();
    expect([...text.matchAll(/^ {10}sparse-checkout: scripts\/ai-review-coverage\s*$/gm)]).toHaveLength(2);
    expect([...text.matchAll(/^ {10}repository: \$\{\{ job\.workflow_repository \}\}\s*$/gm)]).toHaveLength(2);
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
  it('checks out only the revision under test; job context supplies runtime identity', () => {
    const text = readFileSync(TESTS_WORKFLOW, 'utf8');
    expect(text).toMatch(/^ {10}fetch-depth: 1\s*$/m);
  });
});

/**
 * The two job names in this workflow are an OBSERVABILITY INTERFACE CONTRACT: dashboards
 * and automation match the context by name, so renaming one silently fragments telemetry.
 * These checks remain permanently advisory and are not branch-protection requirements.
 *
 * Asserted STRUCTURALLY, as four-space `name:` keys inside a job block. A `grep` for the
 * name would also be satisfied by the several PROSE COMMENTS in this file that discuss the
 * job names, so it could pass with the real job renamed out from under it.
 */
describe('the review job names are unchanged (observability interface contract)', () => {
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

  it('keeps the two review job names unchanged (observability contract)', () => {
    // Re-asserted HERE as well as in its own describe because this change touches both jobs'
    // env blocks and dashboards consume the exact emitted context names.
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

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * EHAC-2280 — three inputs reach elek, and the coverage record becomes a first-class artifact.
 *
 * Written RED against the unchanged workflow and recorded that way before the YAML moved.
 * A workflow invariant that has only ever been observed green is indistinguishable from a
 * tautology, and this repo's own defect history (EHAC-2057) is exactly that shape.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */
describe('EHAC-2280 — the serial-budget guard and routing knobs reach elek', () => {
  const review = () => jobBlock(source(), /^ {4}name: AI Code Review \(/);

  // THE defect this case exists for: `job_timeout_minutes` has been a workflow_call input
  // since EHAC-2231 and drives `timeout-minutes:`, but it was never forwarded to the action.
  // elek's serial-arithmetic guard (eha-v1.4.0) reads it from its own inputs, so without this
  // line the guard reports `unchecked` on every run in the fleet and the ENFORCING half of
  // AC #4 is inert — a check that is shipped, wired and incapable of firing.
  it('forwards job_timeout_minutes to the elek step, not just to timeout-minutes', () => {
    expect(withoutComments(review().block)).toMatch(
      /^ {10}job_timeout_minutes: \$\{\{ inputs\.job_timeout_minutes \}\}\s*$/m,
    );
  });

  it('declares and forwards openrouter_provider_preferences and reasoning_max_tokens', () => {
    const text = source();
    const block = withoutComments(review().block);
    for (const key of ['openrouter_provider_preferences', 'reasoning_max_tokens']) {
      expect(text, `${key} is not a workflow_call input`).toMatch(
        new RegExp(`^ {6}${key}:\\n {8}type: string`, 'm'),
      );
      expect(block, `${key} is declared but never reaches elek`).toMatch(
        new RegExp(`^ {10}${key}: \\$\\{\\{ inputs\\.${key} \\}\\}\\s*$`, 'm'),
      );
    }
  });

  // Both new inputs must stay UNSET by default. A default here would change behaviour for
  // twelve repos that never opted in — the blast-radius argument the T9 release rested on.
  it('leaves both new inputs unset by default', () => {
    const text = source();
    for (const key of ['openrouter_provider_preferences', 'reasoning_max_tokens']) {
      const decl = text.match(new RegExp(`^ {6}${key}:\\n([\\s\\S]*?)(?=^ {6}[a-z_]+:$)`, 'm'));
      expect(decl, `${key} declaration not found`).not.toBeNull();
      expect(decl[1], `${key} must not carry a default`).not.toMatch(/^ {8}default:/m);
    }
  });
});

describe('EHAC-2280 — the coverage record is uploaded as a first-class artifact', () => {
  const review = () => jobBlock(source(), /^ {4}name: AI Code Review \(/);

  /** The `- name: X` step slice inside a job block, comments included. */
  function stepBlock(block, name) {
    const lines = block.split('\n');
    const hit = lines.findIndex((l) => l.trim() === `- name: ${name}`);
    if (hit < 0) throw new Error(`step "${name}" not found`);
    let end = hit + 1;
    while (end < lines.length && !/^ {6}- name: /.test(lines[end])) end++;
    return lines.slice(hit, end).join('\n');
  }

  // WHY THIS EXISTS. Before it, the coverage record's only post-hoc surface was the RUNNER'S
  // INCIDENTAL ECHO of the COVERAGE_JSON env block in the gate job's log — a side effect of
  // Actions' env rendering, not a resource anyone published. The job summary omits the failure
  // class entirely. Any reader scraping that log reports a PERFECT streak when the echo is
  // absent, which is the vacuous-read defect AC #3 exists to prevent. This makes the record a
  // durable, addressable artifact instead.
  it('writes the record to a file and uploads it, both with if: always()', () => {
    const block = review().block;
    const write = stepBlock(block, 'Persist coverage record');
    const upload = stepBlock(block, 'Upload coverage record');
    for (const [label, step] of [['write', write], ['upload', upload]]) {
      expect(step, `${label} step must run even when the review failed`).toMatch(
        /^ {8}if: always\(\)\s*$/m,
      );
      // `continue-on-error` makes a failing step report GREEN — the mechanism EHAC-2057 was.
      expect(withoutComments(step), `${label} step carries an error suppressor`).not.toMatch(
        /^\s*continue-on-error:/m,
      );
    }
  });

  it('pins actions/upload-artifact to a 40-hex SHA and errors when the file is missing', () => {
    const upload = stepBlock(review().block, 'Upload coverage record');
    expect(upload).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40}/);
    expect(upload).toMatch(/^ {10}name: ai-review-coverage\s*$/m);
    // Without this, a run that produced no record uploads nothing and reports success —
    // the reader would then see an ABSENT artifact as an ordinary miss rather than a fault.
    expect(upload).toMatch(/^ {10}if-no-files-found: error\s*$/m);
    expect(upload).toMatch(/^ {10}retention-days: \d+\s*$/m);
  });

  // T-2280-04. `${{ }}` interpolated into a `run:` body is a script-injection sink: the
  // expression is substituted textually BEFORE the shell sees it. The record must reach the
  // script through an `env:` variable and be read as "$COVERAGE_JSON".
  it('never interpolates the coverage expression into a run: body', () => {
    const write = stepBlock(review().block, 'Persist coverage record');
    // Anchor on the real `run:` KEY LINE, and strip comments first. Slicing at the first
    // literal "run:" matched this step's own prose explaining the rule — an assertion that
    // reds on the comment justifying it is noise, not a finding.
    const body = withoutComments(write).split('\n');
    const at = body.findIndex((l) => /^ {8}run: /.test(l));
    expect(at, 'the persist step has no run: key').toBeGreaterThan(-1);
    const runBody = body.slice(at).join('\n');
    expect(runBody).not.toContain('steps.coverage.outputs.coverage_json');
    expect(write).toMatch(/^ {10}COVERAGE_JSON: \$\{\{ steps\.coverage\.outputs\.coverage_json \}\}\s*$/m);
    expect(runBody).toContain('"$COVERAGE_JSON"');
  });
});

/**
 * EHAC-2294 — the gate's own README must list the SAME NOT_REVIEWED reasons the code accepts.
 *
 * Added because it had already drifted and nobody noticed. Until 2026-08-25 §4 of
 * `scripts/ai-review-coverage/README.md` said the allowlist held "exactly two entries" while
 * `NOT_REVIEWED_REASONS` held five — EHAC-2060 added two and EHAC-2231 a third, each without
 * touching the prose.
 *
 * That is not a documentation nicety. This list is the ONE branch that exits 0 without a
 * coverage claim, the README is where its members are justified, and the code itself says
 * widening it is an operating-policy decision, not an implementation detail. That decision
 * cannot be taken against a list that does not say what it contains.
 */
describe('the README documents the NOT_REVIEWED allowlist accurately (EHAC-2294)', () => {
  const readmeText = () =>
    readFileSync(join(import.meta.dirname, 'README.md'), 'utf8');

  /** Reasons named as inline code in the README's §4 block. */
  const documented = () => {
    const text = readmeText();
    const start = text.indexOf('### 4. `NOT_REVIEWED` is the single exit-0-without-coverage branch');
    expect(start, 'README §4 heading not found — has it been renamed?').toBeGreaterThan(-1);
    const end = text.indexOf('\n### ', start + 1);
    const section = text.slice(start, end === -1 ? undefined : end);
    return new Set(
      [...section.matchAll(/`([a-z_]+)`/g)]
        .map((m) => m[1])
        .filter((name) => NOT_REVIEWED_REASONS.includes(name)),
    );
  };

  it('names every reason the code accepts', () => {
    const undocumented = NOT_REVIEWED_REASONS.filter((r) => !documented().has(r));
    expect(
      undocumented,
      `NOT_REVIEWED reasons missing from README §4: ${undocumented.join(', ')}`,
    ).toEqual([]);
  });

  it('does not state a count that contradicts the list', () => {
    // The specific way it drifted: a hardcoded "exactly two entries" outliving three additions.
    const section = readmeText();
    const claimed = section.match(/allowlist,\s+\*{0,2}(\w+)\*{0,2}\s+entries/i);
    expect(claimed, 'README §4 no longer states an entry count in the expected form').not.toBeNull();
    const words = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
    const asNumber = words[claimed[1].toLowerCase()] ?? Number(claimed[1]);
    expect(asNumber).toBe(NOT_REVIEWED_REASONS.length);
  });
});
