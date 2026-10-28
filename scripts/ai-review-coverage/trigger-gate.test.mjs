/**
 * trigger-gate.test.mjs — the council never checks out code it must not trust (DL-20261023-460).
 *
 * Fix C (DL-20261023-445 cause 2) checks the PR HEAD out into a job that holds
 * OPENROUTER_API_KEY. That is safe only while the head is code a repository writer pushed and
 * the trigger came from someone trusted, so the first step of the review job refuses, before any
 * checkout:
 *
 *   - a PR whose head repository is not the base repository (a fork, or a deleted fork);
 *   - a comment trigger whose author_association is not OWNER, MEMBER or COLLABORATOR;
 *   - a PR event the gate does not know (fail closed rather than guess).
 *
 * These specs EXECUTE the shipped step: the `run:` block is cut out of the real workflow file and
 * run under bash, with a stub `gh` on PATH that answers `gh api … --jq F` by running jq F over a
 * fixture pull-request object. A unit test of a re-implementation would prove the copy, not the
 * gate. Every refusal is paired with the admit it must not swallow (AGENTS.md, gate design 1–2).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const WORKFLOW = join(import.meta.dirname, '..', '..', '.github', 'workflows', 'ai-code-review.yml');
const source = () => readFileSync(WORKFLOW, 'utf8');

const BASE = 'EHA-Clinics/eha_care';
const HEAD_SHA = 'a'.repeat(40);

/**
 * Cut one step's literal `run: |` body out of the workflow, dedented. The step is found by its
 * exact `- name:` line, so a rename fails this spec loudly instead of testing nothing.
 * @param {string} text
 * @param {string} name
 * @returns {{env: string, run: string}}
 */
function stepScript(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  if (start < 0) throw new Error(`step "${name}" not found in ${WORKFLOW}`);
  let end = start + 1;
  while (end < lines.length && !/^ {6}- /.test(lines[end]) && !/^ {2}\S/.test(lines[end])) end++;
  const step = lines.slice(start, end);
  const runAt = step.findIndex((line) => line === '        run: |');
  if (runAt < 0) throw new Error(`step "${name}" has no literal run block`);
  const body = [];
  for (const line of step.slice(runAt + 1)) {
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if (!line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return { env: step.slice(0, runAt).join('\n'), run: body.join('\n') };
}

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the shipped "Resolve PR head" step.
 * @param {{event: string, pr?: object|null, association?: string, isPr?: string, prNumber?: string, apiFails?: boolean}} o
 */
function runGate(o) {
  const dir = mkdtempSync(join(tmpdir(), 'trigger-gate-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  spawnSync('mkdir', [bin]);
  const fixture = join(dir, 'pull.json');
  writeFileSync(fixture, JSON.stringify(o.pr ?? {}));
  // A minimal `gh`: only `gh api <path> --jq <filter>` exists, answered from the fixture.
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/usr/bin/env bash',
      'echo "gh $*" >> "$GH_CALLS"',
      o.apiFails ? 'echo "HTTP 404" >&2; exit 1' : '',
      'filter=""',
      'while [ $# -gt 0 ]; do case "$1" in --jq) filter="$2"; shift 2;; *) shift;; esac; done',
      'exec jq -r "$filter" "$GH_FIXTURE"',
    ].join('\n'),
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const output = join(dir, 'output');
  writeFileSync(output, '');
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  const { run } = stepScript(source(), 'Resolve PR head');
  const result = spawnSync('bash', ['-c', run], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GH_FIXTURE: fixture,
      GH_CALLS: calls,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: BASE,
      EVENT_NAME: o.event,
      COMMENT_ASSOCIATION: o.association ?? '',
      PR_NUMBER: o.prNumber ?? '42',
      IS_PR: o.isPr ?? 'true',
    },
  });
  return {
    status: result.status,
    log: `${result.stdout}${result.stderr}`,
    outputs: readFileSync(output, 'utf8'),
    calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
  };
}

const pull = (headRepo) => ({
  head: { sha: HEAD_SHA, repo: headRepo === null ? null : { full_name: headRepo } },
  base: { repo: { full_name: BASE } },
});

const ADMITTED = `ref=refs/pull/42/head\nsha=${HEAD_SHA}\n`;

describe('the fork-PR trigger gate runs the shipped step', () => {
  it('admits a same-repository PR commented on by a MEMBER, and resolves its head', () => {
    const r = runGate({ event: 'issue_comment', association: 'MEMBER', pr: pull(BASE) });
    expect(r.status).toBe(0);
    expect(r.outputs).toBe(ADMITTED);
  });

  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('admits a %s comment on a same-repository PR', (association) => {
    const r = runGate({ event: 'pull_request_review_comment', association, pr: pull(BASE) });
    expect(r.status).toBe(0);
    expect(r.outputs).toBe(ADMITTED);
  });

  it('admits a same-repository pull_request event, which carries no comment', () => {
    const r = runGate({ event: 'pull_request', pr: pull(BASE) });
    expect(r.status).toBe(0);
    expect(r.outputs).toBe(ADMITTED);
  });

  it('compares repository names case-insensitively, as GitHub does', () => {
    const r = runGate({ event: 'pull_request', pr: pull(BASE.toLowerCase()) });
    expect(r.status).toBe(0);
    expect(r.outputs).toBe(ADMITTED);
  });

  it('REFUSES a fork PR on a pull_request event, before any ref is emitted', () => {
    const r = runGate({ event: 'pull_request', pr: pull('someone/eha_care') });
    expect(r.status).not.toBe(0);
    expect(r.outputs).toBe('');
    expect(r.log).toMatch(/::error::.*fork/i);
    expect(r.log).toContain('someone/eha_care');
  });

  it('REFUSES a fork PR even when a MEMBER comments @ai-review on it', () => {
    const r = runGate({ event: 'issue_comment', association: 'MEMBER', pr: pull('someone/eha_care') });
    expect(r.status).not.toBe(0);
    expect(r.outputs).toBe('');
  });

  it('REFUSES a PR whose head repository is gone (a deleted fork reads as null)', () => {
    const r = runGate({ event: 'pull_request', pr: pull(null) });
    expect(r.status).not.toBe(0);
    expect(r.outputs).toBe('');
  });

  it.each(['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN', ''])(
    'REFUSES a comment trigger from author_association "%s" on a same-repository PR',
    (association) => {
      const r = runGate({ event: 'issue_comment', association, pr: pull(BASE) });
      expect(r.status).not.toBe(0);
      expect(r.outputs).toBe('');
      expect(r.log).toMatch(/::error::.*author_association/);
    },
  );

  it('REFUSES a lower-case or padded association rather than normalising it', () => {
    for (const association of ['member', ' MEMBER', 'MEMBER ']) {
      const r = runGate({ event: 'issue_comment', association, pr: pull(BASE) });
      expect(r.status, JSON.stringify(association)).not.toBe(0);
    }
  });

  it('REFUSES a PR event it does not know, rather than guessing it is safe', () => {
    const r = runGate({ event: 'pull_request_target', pr: pull(BASE) });
    expect(r.status).not.toBe(0);
    expect(r.outputs).toBe('');
  });

  it('FAILS CLOSED when the pull request cannot be read', () => {
    const r = runGate({ event: 'pull_request', pr: pull(BASE), apiFails: true });
    expect(r.status).not.toBe(0);
    expect(r.outputs).toBe('');
  });

  it('leaves a non-PR run alone: no API read, no ref, no refusal', () => {
    const r = runGate({ event: 'workflow_dispatch', isPr: 'false', prNumber: '', pr: pull('someone/x') });
    expect(r.status).toBe(0);
    expect(r.outputs).toBe('');
    expect(r.calls).toBe('');
  });
});

describe('the gate is wired where it can act', () => {
  const reviewSteps = () =>
    source()
      .split('\n')
      .filter((line) => /^ {6}- name: /.test(line))
      .map((line) => line.replace(/^ {6}- name: /, ''));

  it('is the FIRST step of the review job, so nothing of the PR is on disk when it runs', () => {
    expect(reviewSteps()[0]).toBe('Resolve PR head');
  });

  it('takes the event name and the comment association from the event, not from the PR', () => {
    const { env } = stepScript(source(), 'Resolve PR head');
    expect(env).toMatch(/^ {10}EVENT_NAME: \$\{\{ github\.event_name \}\}$/m);
    expect(env).toMatch(/^ {10}COMMENT_ASSOCIATION: \$\{\{ github\.event\.comment\.author_association \}\}$/m);
  });

  it('interpolates no expression into the script body (env only, so no injection)', () => {
    const { run } = stepScript(source(), 'Resolve PR head');
    expect(run).not.toContain('${{');
  });

  it('checks the PR out only from the ref the gate emitted', () => {
    const { env } = stepScript(source(), 'Assert the workspace is the reviewed head');
    expect(env).toContain('EXPECTED_SHA: ${{ steps.pr_head.outputs.sha }}');
    expect(source()).toMatch(/- name: Checkout PR\n(?: {8}.*\n)*? {10}ref: \$\{\{ steps\.pr_head\.outputs\.ref \}\}\n/);
  });
});

describe('a PR cannot plant the gate-script directory', () => {
  /** Run the shipped assert step in a scratch git repo whose tree is `files`. */
  function runAssert(files) {
    const dir = mkdtempSync(join(tmpdir(), 'trigger-gate-tree-'));
    dirs.push(dir);
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    for (const [path, body] of Object.entries(files)) {
      spawnSync('mkdir', ['-p', join(dir, path, '..')]);
      if (typeof body === 'object') spawnSync('ln', ['-s', body.symlink, join(dir, path)]);
      else writeFileSync(join(dir, path), body);
    }
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 't', '--allow-empty');
    const sha = git('rev-parse', 'HEAD').stdout.trim();
    const { run } = stepScript(source(), 'Assert the workspace is the reviewed head');
    const result = spawnSync('bash', ['-c', run], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, EXPECTED_SHA: sha },
    });
    return { status: result.status, log: `${result.stdout}${result.stderr}` };
  }

  it('passes an ordinary tree', () => {
    expect(runAssert({ 'src/a.ts': 'x\n' }).status).toBe(0);
  });

  it('REFUSES a tree carrying .ai-review-gate/, which the gate scripts are checked out into', () => {
    const r = runAssert({ '.ai-review-gate/scripts/ai-review-coverage/assert-review-coverage.mjs': 'x\n' });
    expect(r.status).not.toBe(0);
    expect(r.log).toMatch(/::error::.*\.ai-review-gate/);
  });

  it('REFUSES a tree carrying .ai-review-gate as a plain file', () => {
    expect(runAssert({ '.ai-review-gate': 'x\n' }).status).not.toBe(0);
  });

  it('REFUSES a tree carrying .ai-review-gate as a dangling symlink', () => {
    expect(runAssert({ '.ai-review-gate': { symlink: '/nonexistent' } }).status).not.toBe(0);
  });
});
