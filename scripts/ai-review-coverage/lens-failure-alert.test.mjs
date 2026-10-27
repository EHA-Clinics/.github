import { describe, expect, it } from 'vitest';
import { computeLensFailures, parseArgs, renderMarkdown } from './lens-failure-alert.mjs';

const attempt = (lens, conclusion, extra = {}) => ({
  lens_id: lens,
  role: 'reviewer',
  attempt: 1,
  assigned_model: 'openrouter/minimax/minimax-m3',
  actual_model: 'openrouter/minimax/minimax-m3',
  failover: false,
  conclusion,
  failure_class: conclusion === 'failure' ? (extra.failure_class ?? 'timeout') : null,
  duration_seconds: 10,
  ...extra,
});

const council = (runId, createdAt, attempts) => ({
  run_id: runId,
  created_at: createdAt,
  workflow: 'ai-review-on-demand.yml',
  kind: 'record',
  record: { models: { attempts } },
});

const healthy = (runId, createdAt) =>
  council(runId, createdAt, [
    attempt('risk', 'success'),
    attempt('design', 'success'),
    attempt('tests', 'success'),
    attempt('operations', 'success'),
  ]);

describe('computeLensFailures', () => {
  it('alerts when one lens fails in two councils inside 24h', () => {
    // Deliberately NOT newest-first: the reader must order the hits itself.
    const entries = [
      council('run-2', '2026-10-27T14:00:00Z', [attempt('tests', 'failure', { failure_class: 'runaway' }), attempt('risk', 'success')]),
      council('run-1', '2026-10-27T10:00:00Z', [attempt('tests', 'failure', { failure_class: 'timeout' }), attempt('risk', 'success')]),
      healthy('run-3', '2026-10-27T18:00:00Z'),
    ];
    const report = computeLensFailures(entries);
    expect(report.inspected).toBe(3);
    expect(report.alerts).toHaveLength(1);
    expect(report.alerts[0].lens).toBe('tests');
    expect(report.alerts[0].failures).toBe(2);
    expect(report.alerts[0].failure_classes).toEqual(['runaway', 'timeout']);
    // Ordered independently of the input order.
    expect(report.alerts[0].first_seen).toBe('2026-10-27T10:00:00Z');
    expect(report.alerts[0].last_seen).toBe('2026-10-27T14:00:00Z');
    expect(report.alerts[0].latest_run).toBe('run-2');
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('| tests | **2** |');
    // The de-duplication marker the workflow greps for.
    expect(markdown).toContain('<!-- lens-alert lens=tests last-run=run-2 -->');
  });

  it('stays quiet for a single failure, and for failures outside the window', () => {
    const oneFailure = [
      council('run-1', '2026-10-27T10:00:00Z', [attempt('tests', 'failure')]),
      healthy('run-2', '2026-10-27T14:00:00Z'),
    ];
    expect(computeLensFailures(oneFailure).alerts).toEqual([]);

    const farApart = [
      council('run-1', '2026-10-25T10:00:00Z', [attempt('tests', 'failure')]),
      council('run-2', '2026-10-27T10:00:00Z', [attempt('tests', 'failure')]),
    ];
    // Anchor is the NEWEST record (10-27T10:00Z); the 10-25 failure is outside 24h.
    expect(computeLensFailures(farApart).alerts).toEqual([]);
  });

  it('does not count a failure the retry rescued (decisive attempt wins)', () => {
    const rescued = [
      council('run-1', '2026-10-27T10:00:00Z', [
        attempt('tests', 'failure', { attempt: 1, failure_class: 'stall' }),
        attempt('tests', 'success', { attempt: 2, failover: true }),
      ]),
      council('run-2', '2026-10-27T14:00:00Z', [attempt('tests', 'failure', { failure_class: 'timeout' })]),
    ];
    const report = computeLensFailures(rescued);
    // Only run-2 failed decisively, so this is one failure, not two.
    expect(report.alerts).toEqual([]);
  });

  it('ignores validator roles: a breaker is a council breach, not a lens alert', () => {
    const entries = [
      council('run-1', '2026-10-27T10:00:00Z', [{ ...attempt('tests', 'failure'), role: 'validator-review' }]),
      council('run-2', '2026-10-27T14:00:00Z', [{ ...attempt('tests', 'failure'), role: 'validator' }]),
    ];
    expect(computeLensFailures(entries).alerts).toEqual([]);
  });

  it('bounds the window at the anchor when `now` is supplied', () => {
    const entries = [
      council('run-1', '2026-10-27T10:00:00Z', [attempt('tests', 'failure')]),
      council('run-2', '2026-10-27T23:00:00Z', [attempt('tests', 'failure')]),
    ];
    // Anchored at noon: run-1 is inside 24h, run-2 is in the future and excluded.
    const report = computeLensFailures(entries, { now: '2026-10-27T12:00:00Z' });
    expect(report.alerts).toEqual([]);
    expect(report.inspected).toBe(1);
  });

  it('never emits an unsafe lens id into the issue path', () => {
    const entries = [
      council('run-1', '2026-10-27T10:00:00Z', [attempt('tests; rm -rf /', 'failure')]),
      council('run-2', '2026-10-27T14:00:00Z', [attempt('tests; rm -rf /', 'failure')]),
    ];
    const report = computeLensFailures(entries);
    expect(report.alerts[0].lens).toBe('invalid-lens-id');
    expect(renderMarkdown(report)).not.toContain('rm -rf');
  });

  it('parses the CLI contract and refuses malformed flags', () => {
    const defaults = parseArgs(['--entries', 'entries.json']);
    expect(defaults).toMatchObject({ entries: 'entries.json', windowHours: 24, threshold: 2, githubOutput: false });
    expect(parseArgs(['--entries', 'e.json', '--window-hours', '12', '--threshold', '3', '--github-output'])).toMatchObject({
      windowHours: 12,
      threshold: 3,
      githubOutput: true,
    });
    expect(() => parseArgs([])).toThrow(/--entries is required/);
    expect(() => parseArgs(['--entries', 'e.json', '--window-hours', '0'])).toThrow(/positive number/);
    expect(() => parseArgs(['--entries', 'e.json', '--threshold', '1.5'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--entries', 'e.json', '--nope'])).toThrow(/unknown flag/);
  });

  it('refuses to report over an empty sample', () => {
    expect(computeLensFailures([]).inspected).toBe(0);
    expect(computeLensFailures([{ run_id: 'x', kind: 'absent' }]).inspected).toBe(0);
  });
});
