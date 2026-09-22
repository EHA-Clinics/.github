/**
 * read-coverage-streak.test.mjs — EHAC-2280 AC #3 / EHAC-2231.
 *
 * Every figure the reader publishes has a test that makes it come out WRONG on purpose. A
 * streak reader whose only test is "healthy in, healthy out" proves it can count, not that
 * it can stop counting — and stopping is the whole job. The fixtures under fixtures/council
 * are the same current-schema records the gate's own replay suite uses.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_NAME,
  CONCLUSIONS_WITH_A_RECORD,
  STREAK_BREAKING_CLASS,
  attemptsOf,
  classifyEntry,
  computeStreaks,
  fetchEntry,
  listRuns,
  main,
  parseArgs,
  percentile,
  renderMarkdown,
  summarizeCoverageRecords,
} from './read-coverage-streak.mjs';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'council');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

/** Build observations newest-first: index 0 is the most recent run. */
const entriesOf = (...items) =>
  items.map((item, i) => {
    const created_at = `2026-09-${String(20 - i).padStart(2, '0')}T12:00:00Z`;
    const run_id = 1000 - i;
    if (item && typeof item === 'object' && 'kind' in item && !('verdict' in item)) return { run_id, created_at, ...item };
    return { run_id, created_at, kind: 'record', record: item };
  });

/** A healthy record with one attempt re-classed, so the streak logic has something to trip on. */
const withAttemptClass = (record, lensId, failureClass, { elekStatus } = {}) => {
  const copy = structuredClone(record);
  const attempt = copy.models.attempts.find((a) => a.lens_id === lensId);
  attempt.conclusion = 'failure';
  attempt.failure_class = failureClass;
  if (elekStatus) copy.models.policy.elek_status = elekStatus;
  return copy;
};

describe('percentile — nearest rank, null on empty', () => {
  it('returns null for an empty sample rather than a number that looks measured', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([null, undefined, NaN], 99)).toBeNull();
  });

  it('ranks by nearest rank', () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(ten, 50)).toBe(5);
    expect(percentile(ten, 90)).toBe(9);
    expect(percentile(ten, 99)).toBe(10);
    expect(percentile([42], 99)).toBe(42);
  });
});

describe('classifyEntry', () => {
  it('trusts an explicit kind, otherwise a JSON object is a record and anything else is absent', () => {
    expect(classifyEntry({ kind: 'expired' })).toBe('expired');
    expect(classifyEntry({ record: fixture('healthy-council') })).toBe('record');
    expect(classifyEntry({ record: null })).toBe('absent');
    expect(classifyEntry({ record: [] })).toBe('absent');
  });
});

describe('attemptsOf — physical attempts, or a MARKED projection of logical runs', () => {
  it('returns the recorded attempt history when the record carries one', () => {
    const attempts = attemptsOf(fixture('failover-succeeded'));
    expect(attempts).toHaveLength(7);
    expect(attempts.some((a) => a.projected_from_runs)).toBe(false);
  });

  it('projects runs one-to-one and marks them when there is no attempt history', () => {
    const attempts = attemptsOf(fixture('tolerance-breached'));
    expect(attempts).toHaveLength(6);
    expect(attempts.every((a) => a.projected_from_runs === true)).toBe(true);
    expect(attempts.filter((a) => a.failure_class === 'stall')).toHaveLength(2);
  });

  it('returns nothing for a record with no models block', () => {
    expect(attemptsOf({})).toEqual([]);
    expect(attemptsOf(null)).toEqual([]);
  });
});

describe('computeStreaks', () => {
  const healthy = fixture('healthy-council');
  const mimo = fixture('mimo-reasoning-complete');
  const failover = fixture('failover-succeeded');

  it('counts an unbroken window and says so', () => {
    const s = computeStreaks(entriesOf(healthy, mimo, failover));
    expect(s.timeout_free).toEqual({ length: 3, broken_by: null });
    expect(s.healthy).toEqual({ length: 3, broken_by: null });
  });

  it('a stall that a failover absorbed is NOT a timeout — the logical run succeeded', () => {
    // failover-succeeded: tests stalled on flash, succeeded on pro. Neither streak breaks.
    const s = computeStreaks(entriesOf(failover));
    expect(s.timeout_free.length).toBe(1);
    expect(s.healthy.length).toBe(1);
  });

  it(`stops the timeout streak at the first ${STREAK_BREAKING_CLASS}-class attempt, newest first, and names it`, () => {
    const timedOut = withAttemptClass(mimo, 'tests', STREAK_BREAKING_CLASS, { elekStatus: 'healthy' });
    const s = computeStreaks(entriesOf(healthy, healthy, timedOut, healthy, healthy));
    expect(s.timeout_free.length).toBe(2);
    expect(s.timeout_free.broken_by.run_id).toBe(998);
    expect(s.timeout_free.broken_by.reason).toMatch(/tests@openrouter\/deepseek\/deepseek-v4-flash/);
    // The two streaks are independent: this record still reads healthy, so THAT streak runs on.
    expect(s.healthy.length).toBe(5);
  });

  it('stops the healthy streak on a degraded council even when nothing timed out', () => {
    const s = computeStreaks(entriesOf(healthy, fixture('one-reviewer-degraded'), healthy));
    expect(s.healthy.length).toBe(1);
    expect(s.healthy.broken_by.reason).toBe('elek_status degraded');
    expect(s.timeout_free.length).toBe(3);
  });

  it('skips NOT_REVIEWED records without breaking or counting them', () => {
    const notReviewed = { ...structuredClone(healthy), verdict: 'NOT_REVIEWED', not_reviewed: { reason: 'pull_request_is_draft', actor: 'x' } };
    const s = computeStreaks(entriesOf(healthy, notReviewed, healthy));
    expect(s.timeout_free.length).toBe(2);
    expect(s.healthy.length).toBe(2);
  });

  it('skips out-of-window kinds (expired, cancelled, not_executed) without breaking', () => {
    const s = computeStreaks(entriesOf(healthy, { kind: 'expired' }, { kind: 'cancelled' }, { kind: 'not_executed' }, healthy));
    expect(s.timeout_free.length).toBe(2);
    expect(s.healthy.length).toBe(2);
  });

  it('BREAKS both streaks on a fault — a run we cannot read is a run we cannot vouch for', () => {
    const s = computeStreaks(entriesOf(healthy, { kind: 'absent', detail: 'no artifact' }, healthy, healthy));
    expect(s.timeout_free.length).toBe(1);
    expect(s.healthy.length).toBe(1);
    expect(s.timeout_free.broken_by).toEqual({ run_id: 999, created_at: '2026-09-19T12:00:00Z', reason: 'no readable coverage record (absent)' });
  });

  it('is order-independent in the input — it sorts by created_at itself', () => {
    const timedOut = withAttemptClass(mimo, 'risk', STREAK_BREAKING_CLASS);
    const ordered = entriesOf(healthy, healthy, timedOut);
    expect(computeStreaks([...ordered].reverse()).timeout_free.length).toBe(2);
  });
});

describe('summarizeCoverageRecords', () => {
  const healthy = fixture('healthy-council');

  it('counts every exclusion somewhere, so nothing disappears from the census', () => {
    const notReviewed = { ...structuredClone(healthy), verdict: 'NOT_REVIEWED', not_reviewed: { reason: 'no_files_in_review_scope' } };
    const s = summarizeCoverageRecords(entriesOf(
      healthy, notReviewed, { kind: 'expired' }, { kind: 'cancelled' }, { kind: 'not_executed' }, { kind: 'absent' }, { kind: 'unreadable', detail: 'bad json' },
    ));
    expect(s.census).toEqual({ inspected: 7, records: 2, councils: 1, not_reviewed: 1, expired: 1, cancelled: 1, not_executed: 1, faults: 2 });
    expect(s.not_reviewed_reasons).toEqual({ no_files_in_review_scope: 1 });
    expect(s.faults.map((f) => f.kind)).toEqual(['absent', 'unreadable']);
    expect(s.faults[1].detail).toBe('bad json');
  });

  it('builds the failure-class census over PHYSICAL attempts, per model and overall', () => {
    const s = summarizeCoverageRecords(entriesOf(fixture('failover-succeeded'), fixture('tolerance-breached')));
    // failover-succeeded: one stall on flash (then pro succeeded). tolerance-breached (projected): two stalls.
    expect(s.failure_classes).toEqual({ stall: 3 });
    expect(s.models['deepseek/deepseek-v4-flash'].failure_classes).toEqual({ stall: 2 });
    expect(s.models['deepseek/deepseek-v4-pro'].failure_classes).toEqual({ stall: 1 });
    expect(s.models['deepseek/deepseek-v4-pro'].failover_in).toBe(1);
  });

  it('collapses the openrouter/ prefix so one model is one row', () => {
    const s = summarizeCoverageRecords(entriesOf(fixture('mimo-reasoning-complete')));
    expect(Object.keys(s.models)).toEqual([
      'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro', 'xiaomi/mimo-v2.5-pro', 'z-ai/glm-5.3-flash',
    ]);
  });

  it('reports reasoning-token and serving-provider distributions per model, with sample sizes', () => {
    const record = structuredClone(healthy);
    const design = record.models.runs.find((r) => r.lens_id === 'design');
    const others = record.models.runs.filter((r) => r !== design);
    design.native_tokens_reasoning = 1200;
    design.serving_provider = 'Xiaomi';
    for (const r of others) { r.native_tokens_reasoning = null; r.serving_provider = 'Novita'; }
    const second = structuredClone(record);
    second.models.runs.find((r) => r.lens_id === 'design').native_tokens_reasoning = 300;
    const s = summarizeCoverageRecords(entriesOf(record, second));
    const mimo = s.models['xiaomi/mimo-v2.5-pro'];
    expect(mimo.native_tokens_reasoning).toEqual({ n: 2, p50: 300, p90: 1200, p99: 1200, max: 1200 });
    expect(mimo.serving_providers).toEqual({ Xiaomi: 2 });
    expect(s.models['deepseek/deepseek-v4-pro'].native_tokens_reasoning.n).toBe(0);
    expect(s.models['deepseek/deepseek-v4-pro'].native_tokens_reasoning.p99).toBeNull();
  });

  it('buckets councils by diff size and carries the outcome into the bucket', () => {
    const big = structuredClone(healthy);
    big.diff.chars = 250_000;
    big.models.policy.elek_status = 'degraded';
    const s = summarizeCoverageRecords(entriesOf(healthy, big));
    const small = s.size_vs_outcome.buckets.find((b) => b.label === '< 20k chars');
    const mid = s.size_vs_outcome.buckets.find((b) => b.label === '100k – 300k');
    expect(small).toMatchObject({ n: 1, elek_status: { healthy: 1 } });
    expect(mid).toMatchObject({ n: 1, elek_status: { degraded: 1 } });
    expect(s.size_vs_outcome.unsized).toBe(0);
  });

  it('flags every council whose configured roster differs from the NEWEST one', () => {
    const older = structuredClone(healthy);
    older.models.configured.review_models = ['openrouter/deepseek/deepseek-v4-pro', 'x', 'y', 'z'];
    const s = summarizeCoverageRecords(entriesOf(healthy, healthy, older));
    expect(s.roster.drift).toHaveLength(1);
    expect(s.roster.drift[0].run_id).toBe(998);
    expect(Object.keys(s.roster.seen)).toHaveLength(2);
    expect(s.roster.current).toBe(`${healthy.models.configured.review_models.join(',')} → ${healthy.models.configured.validator_model}`);
  });

  it('census the validator roles separately, with the independence collapse visible (EHAC-2833)', () => {
    const s = summarizeCoverageRecords(entriesOf(healthy));
    const validate = s.validator_roles;
    // healthy-council carries no attempt history, so attemptsOf PROJECTS each logical run
    // into one marked attempt: two validator-role logical runs -> two validator attempts,
    // both successful, no durations (projections carry none).
    expect(validate.logical_runs).toBe(2);
    expect(validate.failed_runs).toBe(0);
    expect(validate.attempts).toBe(2);
    expect(validate.failed_attempts).toBe(0);
    expect(validate.independence_collapses).toBe(0);
    expect(validate.stale_head).toBe(0);
    expect(validate.duration_seconds.n).toBe(0);
  });

  it('counts stale-head councils (U4) and 404 failover collapses into the validator census', () => {
    const raced = structuredClone(healthy);
    raced.refs = { ...healthy.refs, head_sha_git: 'a'.repeat(40), head_sha_event: 'b'.repeat(40), sha_match: false };
    const collapsed = structuredClone(healthy);
    // A measured attempt history (older fixtures carry none) with a 404 failover: the audit
    // was ASSIGNED to the validator and ran on a reviewer model.
    collapsed.models.attempts = [{
      lens_id: 'validator-self-review', role: 'validator-review', attempt: 1,
      assigned_model: 'openrouter/deepseek/deepseek-v4-pro-0813', actual_model: 'z-ai/glm-5.3-flash',
      failover: true, conclusion: 'success', failure_class: null, duration_seconds: 312.4,
      projected_from_runs: false,
    }];
    const s = summarizeCoverageRecords(entriesOf(raced, collapsed));
    expect(s.validator_roles.stale_head).toBe(1);
    // raced contributes its 2 projected validator attempts, collapsed its 1 measured one.
    expect(s.validator_roles.attempts).toBe(3);
    expect(s.validator_roles.independence_collapses).toBe(1);
    expect(s.validator_roles.failover_in).toBe(1);
    expect(s.validator_roles.duration_seconds.n).toBe(1);
  });

  it('records the window and the pin census', () => {
    const s = summarizeCoverageRecords(entriesOf(healthy, healthy));
    expect(s.window).toEqual({ newest: '2026-09-20T12:00:00Z', oldest: '2026-09-19T12:00:00Z' });
    expect(s.elek_pins).toEqual({ [healthy.elek.ref]: 2 });
  });

  it('is honest about an empty window', () => {
    const s = summarizeCoverageRecords([]);
    expect(s.census.inspected).toBe(0);
    expect(s.streaks.timeout_free).toEqual({ length: 0, broken_by: null });
    expect(renderMarkdown(s)).toMatch(/No council records in the window/);
  });
});

describe('renderMarkdown', () => {
  it('states the streak, the census and the faults', () => {
    const s = summarizeCoverageRecords(entriesOf(fixture('healthy-council'), { kind: 'absent', detail: 'no artifact on a failure run' }), { source: 'unit' });
    const md = renderMarkdown(s);
    expect(md).toMatch(/^## AI Review coverage streak — unit/m);
    expect(md).toMatch(/\*\*1\*\* consecutive council\(s\) with no `timeout`-class attempt — broken by run 999/);
    expect(md).toMatch(/\*\*1 fault\(s\)\*\*/);
    expect(md).toMatch(/### ⛔ Faults/);
    expect(md).toMatch(/run 999 .*absent — no artifact on a failure run/);
  });

  it('omits the fault section when there are none', () => {
    expect(renderMarkdown(summarizeCoverageRecords(entriesOf(fixture('healthy-council'))))).not.toMatch(/Faults/);
  });
});

describe('parseArgs', () => {
  it('requires a repo unless re-analysing saved entries', () => {
    expect(() => parseArgs([])).toThrow(/--repo/);
    expect(parseArgs(['--from-entries', 'x.json']).fromEntries).toBe('x.json');
  });

  it('splits workflows and validates the limit', () => {
    const o = parseArgs(['--repo', 'o/r', '--workflows', 'a.yml, b.yml', '--limit', '7']);
    expect(o.workflows).toEqual(['a.yml', 'b.yml']);
    expect(o.limit).toBe(7);
    expect(() => parseArgs(['--repo', 'o/r', '--limit', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--repo', 'o/r', '--bogus'])).toThrow(/unknown argument/);
  });
});

describe('listRuns — stubbed gh', () => {
  const page = (runs) => JSON.stringify({ workflow_runs: runs });
  const run = (id, created_at, extra = {}) => ({ id, created_at, status: 'completed', conclusion: 'success', event: 'pull_request', head_branch: 'b', ...extra });

  it('merges both workflows, sorts newest first and honours the limit', () => {
    const calls = [];
    const ghExec = (args) => {
      calls.push(args[1]);
      if (args[1].includes('ai-code-review.yml')) return page([run(1, '2026-09-20T10:00:00Z'), run(2, '2026-09-18T10:00:00Z')]);
      return page([run(3, '2026-09-19T10:00:00Z')]);
    };
    const runs = listRuns({ repo: 'o/r', workflows: ['ai-code-review.yml', 'ai-review-on-demand.yml'], limit: 2, ghExec });
    expect(runs.map((r) => r.run_id)).toEqual([1, 3]);
    expect(runs[1].workflow).toBe('ai-review-on-demand.yml');
    expect(calls).toHaveLength(2);
  });

  it('warns and continues when one workflow cannot be listed', () => {
    const warnings = [];
    const ghExec = (args) => {
      if (args[1].includes('missing.yml')) throw new Error('HTTP 404');
      return page([run(9, '2026-09-20T10:00:00Z')]);
    };
    const runs = listRuns({ repo: 'o/r', workflows: ['missing.yml', 'ai-code-review.yml'], limit: 5, ghExec, warn: (m) => warnings.push(m) });
    expect(runs.map((r) => r.run_id)).toEqual([9]);
    expect(warnings[0]).toMatch(/listing missing.yml failed/);
  });
});

describe('fetchEntry — every failure mode is a kind, never a throw', () => {
  const base = { run_id: 5, created_at: '2026-09-20T10:00:00Z', head_branch: 'b', event: 'pull_request', workflow: 'ai-code-review.yml', status: 'completed', conclusion: 'success' };
  const artifacts = (list) => JSON.stringify({ artifacts: list });
  const dir = () => mkdtempSync(join(tmpdir(), 'streak-test-'));

  it('does not consult the API for runs that never executed or were cancelled', () => {
    const ghExec = () => { throw new Error('must not be called'); };
    expect(fetchEntry({ repo: 'o/r', run: { ...base, status: 'in_progress' }, dir: dir(), ghExec }).kind).toBe('not_executed');
    expect(fetchEntry({ repo: 'o/r', run: { ...base, conclusion: 'cancelled' }, dir: dir(), ghExec }).kind).toBe('cancelled');
    expect(fetchEntry({ repo: 'o/r', run: { ...base, conclusion: 'startup_failure' }, dir: dir(), ghExec }).kind).toBe('not_executed');
    expect(CONCLUSIONS_WITH_A_RECORD).toEqual(['success', 'failure', 'timed_out']);
  });

  it('reports a completed run with no artifact as a FAULT', () => {
    const e = fetchEntry({ repo: 'o/r', run: { ...base, conclusion: 'failure' }, dir: dir(), ghExec: () => artifacts([{ name: 'other', expired: false }]) });
    expect(e.kind).toBe('absent');
    expect(e.detail).toMatch(new RegExp(`no ${ARTIFACT_NAME} artifact on a failure run`));
  });

  it('reports an expired artifact as out of window, not a fault', () => {
    const e = fetchEntry({ repo: 'o/r', run: base, dir: dir(), ghExec: () => artifacts([{ name: ARTIFACT_NAME, expired: true }]) });
    expect(e.kind).toBe('expired');
  });

  it('reads the downloaded record, and classes a non-object as unreadable', () => {
    const target = dir();
    const stub = (body) => (args) => {
      if (args[0] === 'api') return artifacts([{ name: ARTIFACT_NAME, expired: false }]);
      // `gh run download … -D <target>/<run_id>` — write where the reader will look.
      writeFileSync(join(args[args.indexOf('-D') + 1], 'coverage.json'), body);
      return '';
    };
    const good = fetchEntry({ repo: 'o/r', run: base, dir: target, ghExec: stub(JSON.stringify(fixture('healthy-council'))) });
    expect(good.kind).toBe('record');
    expect(good.record.verdict).toBe('COMPLETE');

    const bad = fetchEntry({ repo: 'o/r', run: { ...base, run_id: 6 }, dir: target, ghExec: stub('[]') });
    expect(bad.kind).toBe('unreadable');
    expect(bad.detail).toMatch(/not a JSON object/);

    const empty = fetchEntry({ repo: 'o/r', run: { ...base, run_id: 7 }, dir: target, ghExec: stub('') });
    expect(empty.kind).toBe('unreadable');
  });

  it('classes a failed download as unreadable and names the cause', () => {
    const ghExec = (args) => {
      if (args[0] === 'api') return artifacts([{ name: ARTIFACT_NAME, expired: false }]);
      const err = new Error('boom'); err.stderr = 'HTTP 403: forbidden\nmore'; throw err;
    };
    const e = fetchEntry({ repo: 'o/r', run: base, dir: dir(), ghExec });
    expect(e.kind).toBe('unreadable');
    expect(e.detail).toBe('download failed: HTTP 403: forbidden');
  });
});

describe('main — offline re-analysis and exit codes', () => {
  const write = (name, entries) => {
    const p = join(mkdtempSync(join(tmpdir(), 'streak-main-')), name);
    writeFileSync(p, JSON.stringify(entries));
    return p;
  };

  it('exits 0 on a clean window and writes the summary and markdown where asked', async () => {
    const entries = write('clean.json', entriesOf(fixture('healthy-council'), fixture('mimo-reasoning-complete')));
    const out = join(mkdtempSync(join(tmpdir(), 'streak-out-')), 'x');
    const code = await main(['--from-entries', entries, '--json', `${out}.json`, '--markdown', `${out}.md`], {});
    expect(code).toBe(0);
    const summary = JSON.parse(readFileSync(`${out}.json`, 'utf8'));
    expect(summary.streaks.healthy.length).toBe(2);
    expect(summary.source).toMatch(/clean\.json \(offline\)/);
    expect(readFileSync(`${out}.md`, 'utf8')).toMatch(/\*\*2\*\* consecutive council\(s\) with `elek_status: healthy`/);
  });

  it('exits 1 on a fault, even when every readable record is healthy', async () => {
    const entries = write('fault.json', entriesOf(fixture('healthy-council'), { kind: 'absent', detail: 'gone' }));
    const md = join(mkdtempSync(join(tmpdir(), 'streak-out-')), 'x.md');
    expect(await main(['--from-entries', entries, '--markdown', md], {})).toBe(1);
  });

  it('exits 1 when it inspected NOTHING — an empty read is not a clean streak', async () => {
    const entries = write('empty.json', []);
    const md = join(mkdtempSync(join(tmpdir(), 'streak-out-')), 'x.md');
    expect(await main(['--from-entries', entries, '--markdown', md], {})).toBe(1);
  });
});
