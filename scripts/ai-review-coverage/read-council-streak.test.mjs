/**
 * read-council-streak.test.mjs — proves the streak reader CANNOT report a clean streak from an
 * empty or partial read (EHAC-2280 AC #3).
 *
 * The cases below are chosen for what they would catch, not for coverage. The load-bearing one
 * is "ten runs, ONE record unreadable": a naive reader finds no timeout evidence in the nine it
 * managed to read, finds nothing at all in the tenth, and reports 10/10. That is the false
 * clean streak this whole tool exists to make impossible, and it is asserted here in both
 * directions — the exit code AND the parsed count.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  TIMEOUT_FAILURE_CLASSES,
  classifyRecord,
  extractRecordFromLog,
  readCouncilStreak,
  renderReport,
  summarise,
} from './read-council-streak.mjs';

const SCRIPT = join(import.meta.dirname, 'read-council-streak.mjs');

/** A minimal healthy coverage record: a council that ran and finished. */
const cleanRecord = (lenses = 4) => ({
  schema: 1,
  verdict: 'COMPLETE',
  not_reviewed: null,
  review: { input_tokens: 83000 },
  models: {
    runs: Array.from({ length: lenses }, (_, i) => ({
      role: 'reviewer',
      lens_id: `lens-${i}`,
      conclusion: 'success',
      failure_class: null,
    })),
  },
});

const timedOutRecord = (failureClass = 'timeout') => {
  const rec = cleanRecord(4);
  rec.models.runs[2] = { role: 'reviewer', lens_id: 'tests', conclusion: 'failure', failure_class: failureClass };
  return rec;
};

/**
 * Drive the real pipeline with a stubbed `gh`. `records` is keyed by run id; a value of
 * `undefined` means BOTH sources come back empty, i.e. the record cannot be obtained.
 */
function stubExec(records) {
  const ids = Object.keys(records).map(Number);
  return async (args) => {
    if (args[0] === 'api' && args.includes('--paginate')) {
      return `${ids.map((id) => JSON.stringify({ id, status: 'completed', conclusion: 'success' })).join('\n')}\n`;
    }
    if (args[0] === 'api' && /artifacts$/.test(args[1])) {
      const id = Number(args[1].match(/runs\/(\d+)/)[1]);
      return records[id] === undefined ? '' : 'ai-review-coverage\n';
    }
    if (args[0] === 'run' && args[1] === 'view') {
      const id = Number(args[2]);
      return records[id] === undefined ? 'some log with no marker\n' : `COVERAGE_JSON: ${JSON.stringify(records[id])}\n`;
    }
    if (args[0] === 'run' && args[1] === 'download') {
      // Force the artifact path to fall through to the log echo, so these fixtures exercise
      // the FALLBACK reader too rather than only the happy artifact path.
      throw new Error('download unavailable in fixture mode');
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
}

const run = (records) => readCouncilStreak({ repo: 'X/Y', workflow: 'w.yml', count: 10, exec: stubExec(records) });

const tenRuns = (fn) => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [1000 + i, fn(i)]));

describe('the streak reader reports a measurement, never a claim', () => {
  it('ten clean records: 10/10, parsed 10 of 10, ok', async () => {
    const { summary } = await run(tenRuns(() => cleanRecord()));
    expect(summary.parsed).toBe(10);
    expect(summary.unparsed).toBe(0);
    expect(summary.streak).toEqual({ numerator: 10, denominator: 10 });
    expect(summary.ok).toBe(true);
  });

  // ── THE CASE THAT MATTERS ────────────────────────────────────────────────────────────────
  // Nine readable, one not. A reader that scored "absence of timeout evidence" would report a
  // perfect 10/10 here. This one must refuse to report a streak at all.
  it('ten runs with ONE unreadable record: NOT ok, and says parsed 9', async () => {
    const { summary, classified } = await run(tenRuns((i) => (i === 4 ? undefined : cleanRecord())));
    expect(summary.parsed).toBe(9);
    expect(summary.unparsed).toBe(1);
    expect(summary.ok, 'an incomplete read must never report ok').toBe(false);
    expect(summary.failures.join(' ')).toMatch(/could not be parsed/);

    const report = renderReport(summary, classified);
    expect(report).toContain('parsed 9 of 10');
    // And critically: the streak is NOT silently recomputed as a clean 9/9 headline with no
    // sign that a record went missing.
    expect(report).toMatch(/FAILED MEASUREMENT/);
  });

  it('zero records: NOT ok, and never renders 0/0 as a pass', async () => {
    const { summary } = await run(tenRuns(() => undefined));
    expect(summary.parsed).toBe(0);
    expect(summary.ok).toBe(false);
    expect(summary.failures.join(' ')).toMatch(/zero records were parsed/);
  });

  it('an empty run list is a failed measurement, not a perfect streak', async () => {
    const { summary } = await run({});
    expect(summary.runs_considered).toBe(0);
    expect(summary.parsed).toBe(0);
    expect(summary.ok).toBe(false);
  });

  it('counts a real timeout against the streak and names the lens', async () => {
    const { summary, classified } = await run(tenRuns((i) => (i === 7 ? timedOutRecord() : cleanRecord())));
    expect(summary.parsed).toBe(10);
    expect(summary.ok, 'a fully-read window with a timeout is a VALID measurement').toBe(true);
    expect(summary.streak).toEqual({ numerator: 9, denominator: 10 });
    expect(classified.find((c) => c.timedOut).reason).toContain('tests:timeout');
  });

  it('treats `stall` as a wall-clock failure, not a clean run', async () => {
    // eha_care #3291: 600 seconds of complete silence, twice. Scoring only `timeout` would
    // have read that as a healthy lens.
    const { summary } = await run(tenRuns((i) => (i === 1 ? timedOutRecord('stall') : cleanRecord())));
    expect(TIMEOUT_FAILURE_CLASSES).toContain('stall');
    expect(summary.streak).toEqual({ numerator: 9, denominator: 10 });
  });

  it('excludes NOT_REVIEWED runs from the denominator and reports them separately', async () => {
    const notReviewed = { schema: 1, verdict: 'NOT_REVIEWED', not_reviewed: 'no_files_in_review_scope', models: { runs: [] } };
    const { summary } = await run(tenRuns((i) => (i < 3 ? notReviewed : cleanRecord())));
    expect(summary.not_reviewed).toBe(3);
    expect(summary.parsed).toBe(7);
    expect(summary.streak).toEqual({ numerator: 7, denominator: 7 });
    expect(summary.ok).toBe(true);
  });
});

describe('classifyRecord — absence is never evidence of health', () => {
  it('calls models.runs=null with positive tokens UNPARSED, never clean', () => {
    const cancelled = { verdict: 'UNKNOWN', not_reviewed: null, review: { input_tokens: 91000 }, models: { runs: null } };
    const v = classifyRecord(cancelled);
    expect(v.class).toBe('unparsed');
    expect(v.timedOut).toBe(false);
    expect(v.reason).toContain('the review ran and the record cannot say how');
  });

  it('rejects a null, an array and a string as records', () => {
    for (const junk of [null, [], 'COMPLETE', 42]) {
      expect(classifyRecord(junk).class).toBe('unparsed');
    }
  });

  it('counts a termination_reason timeout even when failure_class is absent', () => {
    const rec = cleanRecord(2);
    rec.models.runs[0] = { role: 'reviewer', lens_id: 'risk', conclusion: 'failure', termination_reason: 'timeout' };
    expect(classifyRecord(rec).timedOut).toBe(true);
  });
});

describe('extractRecordFromLog — the fallback cannot be fooled by a truncated echo', () => {
  it('reads a record out of the runner env echo', () => {
    const rec = extractRecordFromLog(`noise\nCOVERAGE_JSON: ${JSON.stringify({ verdict: 'COMPLETE' })}\nmore noise`);
    expect(rec.verdict).toBe('COMPLETE');
  });

  it('returns null on a TRUNCATED echo rather than a partial object', () => {
    expect(extractRecordFromLog('COVERAGE_JSON: {"verdict":"COMP')).toBeNull();
  });

  it('returns null when the marker is absent, and on empty input', () => {
    expect(extractRecordFromLog('nothing here')).toBeNull();
    expect(extractRecordFromLog('')).toBeNull();
    expect(extractRecordFromLog(undefined)).toBeNull();
  });

  it('prefers the LAST marker, so a re-run is read rather than its first attempt', () => {
    const log = [
      `COVERAGE_JSON: ${JSON.stringify({ verdict: 'UNKNOWN' })}`,
      `COVERAGE_JSON: ${JSON.stringify({ verdict: 'COMPLETE' })}`,
    ].join('\n');
    expect(extractRecordFromLog(log).verdict).toBe('COMPLETE');
  });
});

describe('summarise — the exit conditions are exactly the two dangerous reads', () => {
  const c = (klass, timedOut = false) => ({ id: 1, class: klass, timedOut, reason: '', source: 's' });

  it('is ok only when every considered run parsed and at least one did', () => {
    expect(summarise([c('parsed'), c('parsed')], 2).ok).toBe(true);
    expect(summarise([c('parsed'), c('unparsed')], 2).ok).toBe(false);
    expect(summarise([c('not_reviewed')], 1).ok, 'not_reviewed only means nothing was measured').toBe(false);
    expect(summarise([], 10).ok).toBe(false);
  });

  it('always renders a parsed-of-considered line, whatever the outcome', () => {
    for (const set of [[c('parsed')], [c('unparsed')], []]) {
      expect(renderReport(summarise(set, 10), set)).toMatch(/parsed \d+ of \d+/);
    }
  });
});

describe('the CLI surfaces the exit code, not just the text', () => {
  it('rejects a missing --repo and a non-positive --count', () => {
    for (const args of [[], ['--repo', 'X/Y', '--count', '0'], ['--repo', 'X/Y', '--count', 'abc']]) {
      const proc = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
      expect(proc.status, `expected non-zero for: ${args.join(' ')}`).not.toBe(0);
    }
  });
});
