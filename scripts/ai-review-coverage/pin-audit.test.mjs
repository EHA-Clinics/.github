/**
 * pin-audit.test.mjs — EHAC-2845.
 *
 * Unit tests for the pure core of the operator-run fleet pin audit. No `gh` calls: the fetch
 * layer is a thin CLI shell around these functions, and the whole point of the split is that
 * the classification and drift arithmetic are testable offline. The retired workflow's
 * workflow-invariants block asserted the same properties against the YAML; those move here,
 * against the code that actually computes them.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REPOS,
  REQUIRED_FILES,
  SCANNED_FILES,
  applyDrift,
  classifyRead,
  computeDrift,
  evaluateExpect,
  extractOrgPin,
  renderMarkdown,
  summarize,
} from './pin-audit.mjs';

const SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const OTHER_SHA = '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567';

const caller = (ref = SHA) => [
  'name: AI code review',
  'on: pull_request',
  'jobs:',
  '  review:',
  '    uses: EHA-Clinics/.github/.github/workflows/ai-code-review.yml@' + ref,
  '    with:',
  '      model: x',
].join('\n');

const row = (over = {}) => ({
  repo: 'EHA-Clinics/eha_care',
  workflow: 'ai-code-review.yml',
  kind: 'pin',
  pin: SHA,
  target: 'ai-code-review.yml',
  detail: null,
  drift: 0,
  state: 'verified',
  ...over,
});

describe('DEFAULT_REPOS — the declared consumer matrix', () => {
  it('is exactly the seven EHAC-2845 consumers', () => {
    expect(DEFAULT_REPOS).toEqual([
      'EHA-Clinics/eha_care',
      'EHA-Clinics/eha-care-infra',
      'EHA-Clinics/eha-clinic',
      'EHA-Clinics/eha-clinic-recruitment-odoo-api',
      'EHA-Clinics/get-care',
      'EHA-Clinics/ehacare-clinical-decision-support',
      'EHA-Clinics/eha-care-mobile',
    ]);
  });

  it('scans three caller files and requires two of them', () => {
    expect(SCANNED_FILES).toEqual(['ai-code-review.yml', 'ai-review-on-demand.yml', 'ai-review-streak.yml']);
    expect(REQUIRED_FILES).toEqual(['ai-code-review.yml', 'ai-review-on-demand.yml']);
  });
});

describe('extractOrgPin', () => {
  it('finds the target and 40-hex sha on a realistic org uses: line', () => {
    expect(extractOrgPin(caller())).toEqual({ target: 'ai-code-review.yml', sha: SHA });
  });

  it('ignores third-party and non-org uses: lines', () => {
    const text = [
      'uses: actions/checkout@v4',
      'uses: EHA-Clinics/eha-care-infra/.github/workflows/ai-code-review.yml@' + SHA,
      'uses: selimozten/elek@' + SHA,
    ].join('\n');
    expect(extractOrgPin(text)).toBeNull();
  });

  it('returns null for branch/tag refs and for files with no org call', () => {
    expect(extractOrgPin(caller('main'))).toBeNull();
    expect(extractOrgPin(caller('v1.2.3'))).toBeNull();
    expect(extractOrgPin('name: nothing here\non: push\n')).toBeNull();
    expect(extractOrgPin(null)).toBeNull();
  });
});

describe('classifyRead — absence of evidence is not evidence of absence', () => {
  it('a 2xx read carrying an org pin is a pin', () => {
    const r = classifyRead({ status: 200, body: caller() });
    expect(r.kind).toBe('pin');
    expect(r.pin).toBe(SHA);
    expect(r.target).toBe('ai-code-review.yml');
  });

  it('a 404 is ABSENT, whether stated by status or by the gh stderr', () => {
    expect(classifyRead({ status: 404 })).toMatchObject({ kind: 'absent', detail: 'ABSENT (no such file)' });
    expect(classifyRead({ status: null, stderr: 'gh: Not Found (HTTP 404)' }))
      .toMatchObject({ kind: 'absent', detail: 'ABSENT (no such file)' });
  });

  it('a 403 is UNVERIFIED (unreadable) — never silently skipped', () => {
    expect(classifyRead({ status: 403, stderr: 'HTTP 403' }))
      .toMatchObject({ kind: 'unverified', detail: 'UNVERIFIED (unreadable)' });
    expect(classifyRead({ status: null, stderr: 'dial tcp: network is unreachable' }))
      .toMatchObject({ kind: 'unverified', detail: 'UNVERIFIED (unreadable)' });
  });

  it('a readable file with no org pin is UNVERIFIED (no pin found)', () => {
    expect(classifyRead({ status: 200, body: 'name: x\non: push\n' }))
      .toMatchObject({ kind: 'unverified', detail: 'UNVERIFIED (no pin found)' });
  });
});

describe('computeDrift — org commits that touched the called file after the pin', () => {
  const chain = ['c0', 'c1', 'c2', 'c3']; // oldest → newest

  it('is 0 at the head and counts entries after the pin', () => {
    expect(computeDrift(chain, 'c3')).toBe(0);
    expect(computeDrift(chain, 'c1')).toBe(2);
  });

  it("is 'unknown' when the pin is not in the chain", () => {
    expect(computeDrift(chain, 'ffffffff')).toBe('unknown');
    expect(computeDrift(undefined, 'c3')).toBe('unknown');
  });
});

describe('applyDrift + summarize — mutually exclusive classes', () => {
  it('marks a head pin verified, a behind pin drifted, and keeps absent/unverified as-is', () => {
    const rows = [
      row({ target: 'ai-code-review.yml', pin: 'c3' }),
      row({ workflow: 'ai-review-on-demand.yml', target: 'ai-review-on-demand.yml', pin: 'c0' }),
      row({ workflow: 'ai-review-streak.yml', kind: 'absent', pin: null, target: null, detail: 'ABSENT (no such file)' }),
      row({ workflow: 'ai-review-streak.yml', kind: 'unverified', pin: null, target: null, detail: 'UNVERIFIED (unreadable)' }),
    ];
    const finalized = applyDrift(rows, {
      'ai-code-review.yml': ['c0', 'c1', 'c2', 'c3'],
      'ai-review-on-demand.yml': ['c0', 'c1', 'c2', 'c3'],
    });

    expect(finalized[0]).toMatchObject({ state: 'verified', drift: 0 });
    expect(finalized[1]).toMatchObject({ state: 'drifted', drift: 3 });
    expect(finalized[2]).toMatchObject({ state: 'absent', drift: null });
    expect(finalized[3]).toMatchObject({ state: 'unverified', drift: null });

    const summary = summarize(finalized);
    expect(summary).toEqual({ verified: 1, drifted: 1, absent: 1, unverified: 1 });
    // A drifted row must NOT be counted as verified.
    expect(summary.verified).toBe(1);
  });

  it("marks an unplaceable pin drifted with drift 'unknown'", () => {
    const [r] = applyDrift([row({ pin: 'ffffffff' })], { 'ai-code-review.yml': ['c0', 'c1'] });
    expect(r.state).toBe('drifted');
    expect(r.drift).toBe('unknown');
  });
});

describe('evaluateExpect — rollout acceptance', () => {
  const absentStreak = row({
    workflow: 'ai-review-streak.yml',
    kind: 'absent',
    pin: null,
    target: null,
    detail: 'ABSENT (no such file)',
    drift: null,
    state: 'absent',
  });

  it('is ok when every required row is verified at the expected sha', () => {
    const rows = [row(), row({ workflow: 'ai-review-on-demand.yml' }), absentStreak];
    expect(evaluateExpect(rows, SHA)).toEqual({ ok: true, failures: [] });
  });

  it('tolerates an absent streak row but fails on an absent REQUIRED row', () => {
    const streakOk = evaluateExpect([row(), row({ workflow: 'ai-review-on-demand.yml' }), absentStreak], SHA);
    expect(streakOk.ok).toBe(true);

    const requiredAbsent = evaluateExpect([row({ kind: 'absent', pin: null, target: null, detail: 'ABSENT (no such file)', drift: null, state: 'absent' })], SHA);
    expect(requiredAbsent.ok).toBe(false);
    expect(requiredAbsent.failures).toHaveLength(1);
    expect(requiredAbsent.failures[0]).toMatch(/ABSENT — required caller file missing/);
  });

  it('fails on a present-but-wrong pin', () => {
    const { ok, failures } = evaluateExpect([row({ pin: OTHER_SHA, state: 'verified', drift: 0 })], SHA);
    expect(ok).toBe(false);
    expect(failures[0]).toMatch(/≠ expected/);
  });

  it('fails on a drifted row', () => {
    const { ok, failures } = evaluateExpect([row({ state: 'drifted', drift: 2 })], SHA);
    expect(ok).toBe(false);
    expect(failures[0]).toMatch(/DRIFTED/);
  });

  it('fails on an unverified row', () => {
    const { ok, failures } = evaluateExpect([row({ kind: 'unverified', pin: null, target: null, detail: 'UNVERIFIED (unreadable)', drift: null, state: 'unverified' })], SHA);
    expect(ok).toBe(false);
    expect(failures[0]).toMatch(/UNVERIFIED/);
  });
});

describe('renderMarkdown — the report shape', () => {
  it('renders a short pin or the classification detail, and the four-class summary line', () => {
    const rows = [
      row(),
      row({ workflow: 'ai-review-streak.yml', kind: 'absent', pin: null, target: null, detail: 'ABSENT (no such file)', drift: null, state: 'absent' }),
    ];
    const md = renderMarkdown(rows, summarize(rows));
    expect(md).toMatch(/^\| repo \| workflow \| pin \| drift \(re-pins behind\) \|$/m);
    expect(md).toContain(`\`${SHA.slice(0, 8)}\``);
    expect(md).toContain('ABSENT (no such file)');
    expect(md).toContain('Summary: 1 verified, 0 drifted, 1 absent, 0 unverified.');
  });
});
