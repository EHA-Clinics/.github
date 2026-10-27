import { describe, expect, it } from 'vitest';
import { computeLensFailures, renderMarkdown } from './lens-failure-alert.mjs';

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
    const entries = [
      council('run-1', '2026-10-27T10:00:00Z', [attempt('tests', 'failure', { failure_class: 'timeout' }), attempt('risk', 'success')]),
      council('run-2', '2026-10-27T14:00:00Z', [attempt('tests', 'failure', { failure_class: 'runaway' }), attempt('risk', 'success')]),
      healthy('run-3', '2026-10-27T18:00:00Z'),
    ];
    const report = computeLensFailures(entries);
    expect(report.inspected).toBe(3);
    expect(report.alerts).toHaveLength(1);
    expect(report.alerts[0].lens).toBe('tests');
    expect(report.alerts[0].failures).toBe(2);
    expect(report.alerts[0].failure_classes).toEqual(['runaway', 'timeout']);
    expect(renderMarkdown(report)).toContain('| tests | **2** |');
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

  it('refuses to report over an empty sample', () => {
    expect(computeLensFailures([]).inspected).toBe(0);
    expect(computeLensFailures([{ run_id: 'x', kind: 'absent' }]).inspected).toBe(0);
  });
});
