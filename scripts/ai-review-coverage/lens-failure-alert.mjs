/**
 * Alert when one council lens fails repeatedly inside a rolling window.
 *
 * WHY. The 2026-10-27 council diagnosis (DL-20261023-401) found 17/54 councils
 * degraded while the daily model-health probe stayed green: the probe is
 * one-turn, and the failures were multi-turn lens failures (runaway generation,
 * timeouts, invalid output). A lens that fails twice in a day is a signal no
 * single council can carry — each one still reported a verdict, and with
 * `max_degraded_lenses: 1` a single failed lens is tolerated as "degraded".
 *
 * This reader answers one question from records, not logs: which reviewer lenses
 * failed in at least `threshold` councils inside the last `windowHours`, and
 * which runs they were. A lens counts as failing for a council only when its
 * DECISIVE attempt (the last attempt for that lens in the record) failed, so a
 * failure rescued by the retry is not counted.
 *
 * It is an OBSERVABILITY reader, not a gate: it exits 0 when it finds failures
 * and non-zero only on faults (unreadable input, no councils). The alert itself
 * is the workflow's tracking issue.
 *
 * Input is the `--entries` output of read-coverage-streak.mjs:
 *   GH_TOKEN=… node read-coverage-streak.mjs --repo O/R --limit 20 --entries entries.json
 *   node lens-failure-alert.mjs --entries entries.json --window-hours 24 --threshold 2 \
 *        [--json alert.json] [--markdown alert.md] [--github-output]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { classifyEntry, attemptsOf } from './read-coverage-streak.mjs';

export const DEFAULT_WINDOW_HOURS = 24;
export const DEFAULT_THRESHOLD = 2;
export const DEFAULT_LIMIT = 20;
/** Lens ids reach an issue title and a shell loop; anything else is not a lens id. */
export const LENS_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Count decisive reviewer-lens failures per lens inside the rolling window.
 *
 * The anchor is the newest council record's `created_at` unless `now` is given,
 * so an offline re-run over a fixture is deterministic and a live run can be
 * anchored to the clock.
 */
export function computeLensFailures(entries, options = {}) {
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const now = options.now ?? null;

  const councils = (Array.isArray(entries) ? entries : [])
    .filter((entry) => classifyEntry(entry) === 'record')
    .map((entry) => ({
      run_id: entry.run_id ?? null,
      created_at: entry.created_at ?? null,
      workflow: entry.workflow ?? null,
      attempts: attemptsOf(entry.record),
    }))
    .filter((entry) => entry.attempts.length > 0 && entry.created_at);

  if (councils.length === 0) {
    return { window_hours: windowHours, threshold, since: null, inspected: 0, councils: 0, alerts: [], faults: [] };
  }

  const newest = councils.reduce((max, entry) => (entry.created_at > max ? entry.created_at : max), '');
  const anchor = now ?? newest;
  const sinceMs = new Date(anchor).getTime() - windowHours * 3_600_000;
  const since = new Date(sinceMs).toISOString();
  const anchorMs = new Date(anchor).getTime();
  const inWindow = councils.filter((entry) => {
    const at = new Date(entry.created_at).getTime();
    return at >= sinceMs && at <= anchorMs;
  });

  /** lens_id -> failures in the window */
  const failures = new Map();
  for (const entry of inWindow) {
    // The DECISIVE attempt per lens: the last one this council recorded. A retry
    // that rescued the lens means the lens did not fail for this council.
    const decisive = new Map();
    for (const attempt of entry.attempts) {
      if (attempt.role && attempt.role !== 'reviewer') continue;
      const rawLens = attempt.lens_id ?? 'unknown';
      const lens = LENS_ID.test(rawLens) ? rawLens : 'invalid-lens-id';
      const previous = decisive.get(lens);
      if (previous === undefined || (attempt.attempt ?? 1) >= (previous.attempt ?? 1)) {
        decisive.set(lens, attempt);
      }
    }
    for (const [lens, attempt] of decisive) {
      if (attempt.conclusion !== 'failure') continue;
      const hits = failures.get(lens) ?? [];
      hits.push({
        run_id: entry.run_id,
        created_at: entry.created_at,
        workflow: entry.workflow,
        failure_class: attempt.failure_class ?? 'unknown',
      });
      failures.set(lens, hits);
    }
  }

  for (const hits of failures.values()) hits.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  const alerts = [...failures.entries()]
    .filter(([, hits]) => hits.length >= threshold)
    .map(([lens, hits]) => ({
      lens,
      failures: hits.length,
      first_seen: hits[0].created_at,
      last_seen: hits[hits.length - 1].created_at,
      runs: hits,
      latest_run: hits[hits.length - 1].run_id,
      failure_classes: [...new Set(hits.map((hit) => hit.failure_class))].sort(),
    }))
    .sort((a, b) => b.failures - a.failures || a.lens.localeCompare(b.lens));

  return {
    window_hours: windowHours,
    threshold,
    since,
    inspected: inWindow.length,
    councils: councils.length,
    alerts,
    faults: [],
  };
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push('## AI council lens alert', '');
  lines.push(
    `Window: last **${report.window_hours}h** (since ${report.since}) across **${report.inspected}** council record(s). ` +
      `Threshold: **${report.threshold}** failures of one lens.`,
  );
  lines.push('');
  if (report.alerts.length === 0) {
    lines.push('No lens failed repeatedly in the window.');
    return `${lines.join('\n')}\n`;
  }
  lines.push('| lens | failures | classes | first | last |', '|---|---|---|---|---|');
  for (const alert of report.alerts) {
    lines.push(
      `| ${alert.lens} | **${alert.failures}** | ${alert.failure_classes.join(', ')} | ${alert.first_seen} | ${alert.last_seen} |`,
    );
  }
  lines.push('');
  for (const alert of report.alerts) {
    lines.push(`<details><summary>${alert.lens}: ${alert.failures} run(s)</summary>`, '');
    for (const run of alert.runs) {
      lines.push(`- \`${run.run_id}\` ${run.created_at} — ${run.failure_class}${run.workflow ? ` (${run.workflow})` : ''}`);
    }
    lines.push('', '</details>');
    lines.push('', `<!-- lens-alert lens=${alert.lens} last-run=${alert.latest_run} -->`);
  }
  return `${lines.join('\n')}\n`;
}

export function parseArgs(argv) {
  const options = {
    entries: null,
    windowHours: DEFAULT_WINDOW_HOURS,
    threshold: DEFAULT_THRESHOLD,
    json: null,
    markdown: null,
    githubOutput: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[i];
    };
    if (flag === '--entries') options.entries = next();
    else if (flag === '--window-hours') options.windowHours = Number(next());
    else if (flag === '--threshold') options.threshold = Number(next());
    else if (flag === '--json') options.json = next();
    else if (flag === '--markdown') options.markdown = next();
    else if (flag === '--github-output') options.githubOutput = true;
    else throw new Error(`unknown flag: ${flag}`);
  }
  if (!options.entries) throw new Error('--entries is required');
  if (!Number.isFinite(options.windowHours) || options.windowHours <= 0) throw new Error('--window-hours must be a positive number');
  if (!Number.isInteger(options.threshold) || options.threshold < 1) throw new Error('--threshold must be a positive integer');
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const entries = JSON.parse(readFileSync(options.entries, 'utf8'));
    const report = computeLensFailures(entries, { windowHours: options.windowHours, threshold: options.threshold });
    if (report.inspected === 0) {
      // Absence of records is a FAULT: an alert over an empty sample would be a
      // check that cannot fail.
      throw new Error('no readable council records in the input; refusing to report "no alerts" over an empty sample');
    }
    const markdown = renderMarkdown(report);
    if (options.json) writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
    if (options.markdown) writeFileSync(options.markdown, markdown);
    if (options.githubOutput) {
      const out = process.env.GITHUB_OUTPUT;
      const lines = [`alert=${report.alerts.length > 0}`, `lenses=${report.alerts.map((a) => a.lens).join(',')}`, `count=${report.alerts.length}`];
      if (out) writeFileSync(out, `${lines.join('\n')}\n`, { flag: 'a' });
    }
    process.stdout.write(markdown);
    process.exit(0);
  } catch (error) {
    console.error(`lens-failure-alert: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
