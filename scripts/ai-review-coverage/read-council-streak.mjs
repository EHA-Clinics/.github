/**
 * read-council-streak.mjs — report how many of the last N council runs finished WITHOUT a
 * wall-clock timeout, and report how many records were actually read to say so.
 *
 * EHAC-2280 AC #3 asks for a streak over live pull-request traffic. The dangerous way to
 * answer that is the obvious one: fetch some runs, look for evidence of a timeout, find none,
 * and report a perfect streak. That procedure returns "10/10" just as readily when it read ten
 * clean records as when it read NOTHING AT ALL — the two are indistinguishable in its output.
 * A measurement that cannot come out badly is not a measurement, and this repository has
 * shipped that shape before (EHAC-2057).
 *
 * So the contract here is deliberately awkward:
 *
 *   1. Every run is CLASSIFIED — `parsed`, `not_reviewed`, or `unparsed` — and the counts are
 *      printed beside the streak. `parsed N of M` is not decoration; it is the number that
 *      makes the streak interpretable.
 *   2. The process EXITS NON-ZERO when `unparsed > 0` or when `parsed === 0`. An incomplete
 *      read is a failed measurement, reported as such, never silently narrowed to a smaller
 *      denominator that happens to look perfect.
 *   3. Absence is never evidence. A run whose record cannot be obtained is `unparsed`; it is
 *      NOT "a run with no timeouts".
 *
 * SOURCE ORDER, and why there are two.
 *   (1) The `ai-review-coverage` ARTIFACT — a first-class resource, published deliberately by
 *       the review job with `if: always()` and `if-no-files-found: error`.
 *   (2) FALLBACK, for runs predating that artifact only: the `COVERAGE_JSON:` line the runner
 *       incidentally echoes when it renders the gate job's environment. That echo is a side
 *       effect of how Actions prints a step's env, not a published interface, and it is the
 *       precise reason source (1) was added. It is read here so historical runs are not simply
 *       invisible — but it is read with node string operations, never a shell pipeline: under
 *       `pipefail` a `grep -q` that closes the pipe early raises SIGPIPE and turns a PRESENT
 *       marker into an ABSENT one (141), which would corrupt this measurement in the exact
 *       direction that flatters it.
 *
 * Dependency-free (node built-ins + `gh`), and every `gh` call is injectable so the classifier
 * is unit-testable against fixtures without a network.
 */
import { execFile as execFileCb } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/**
 * Failure classes that mean "the wall clock ran out", which is what AC #3 counts.
 *
 * `stall` belongs here with `timeout`. Both are the run being killed for producing nothing in
 * time; EHAC-2231 split them apart only so the CAUSE is legible (a silent stream versus slow
 * work). Counting only `timeout` would let the shape measured on eha_care #3291 — 600 seconds
 * of complete silence, twice — read as a clean run.
 */
export const TIMEOUT_FAILURE_CLASSES = Object.freeze(['timeout', 'stall']);

/** Classification of a single workflow run. */
export const RUN_CLASSES = Object.freeze(['parsed', 'not_reviewed', 'unparsed']);

/**
 * Decide what a single fetched record tells us.
 *
 * @param {object|null} record parsed coverage record, or null when none could be obtained
 * @param {string} [source] where it came from, for the report
 * @returns {{class: string, timedOut: boolean, reason: string, offenders: string[]}}
 */
export function classifyRecord(record, source = 'unknown') {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { class: 'unparsed', timedOut: false, reason: 'no record could be obtained', offenders: [] };
  }

  // A review that deliberately did not happen (out of scope, draft, filtered actor) is a real,
  // healthy outcome — but it exercised no model, so it can neither support nor break a streak
  // about model timeouts. It is reported separately rather than padding the denominator.
  if (record.verdict === 'NOT_REVIEWED' || (record.not_reviewed !== null && record.not_reviewed !== undefined)) {
    const reason =
      typeof record.not_reviewed === 'string'
        ? record.not_reviewed
        : (record.not_reviewed?.reason ?? 'not_reviewed');
    return { class: 'not_reviewed', timedOut: false, reason, offenders: [] };
  }

  const runs = record?.models?.runs;
  if (!Array.isArray(runs)) {
    // THE CASE THIS TOOL EXISTS FOR. `models.runs: null` with positive input_tokens means the
    // review demonstrably executed and the record still cannot say what happened — the job was
    // cancelled by its own ceiling, or the summary never finalised. Reading that as "no
    // timeouts observed" is precisely the false clean streak. It is `unparsed`.
    const tokens = record?.review?.input_tokens ?? record?.input_tokens ?? null;
    return {
      class: 'unparsed',
      timedOut: false,
      reason:
        Number(tokens) > 0
          ? `models.runs is not an array while input_tokens=${tokens} — the review ran and the record cannot say how`
          : 'models.runs is not an array',
      offenders: [],
    };
  }

  const offenders = runs
    .filter(
      (r) =>
        TIMEOUT_FAILURE_CLASSES.includes(r?.failure_class) ||
        TIMEOUT_FAILURE_CLASSES.includes(r?.termination_reason),
    )
    .map((r) => `${r?.lens_id ?? r?.role ?? 'unknown'}:${r?.failure_class ?? r?.termination_reason}`);

  return {
    class: 'parsed',
    timedOut: offenders.length > 0,
    reason: offenders.length > 0 ? `timeout-class failures: ${offenders.join(', ')}` : `${runs.length} run(s), none timed out`,
    offenders,
  };
}

/**
 * Compute the report from already-classified runs. Pure, so the arithmetic is testable without
 * touching the network.
 *
 * @param {Array<{id:number, class:string, timedOut:boolean, reason:string, source:string}>} classified
 * @param {number} requested
 */
export function summarise(classified, requested) {
  const parsed = classified.filter((r) => r.class === 'parsed');
  const unparsed = classified.filter((r) => r.class === 'unparsed');
  const notReviewed = classified.filter((r) => r.class === 'not_reviewed');
  const timedOut = parsed.filter((r) => r.timedOut);

  // The streak is over PARSED, review-executing runs only, and its denominator is stated. It
  // is NOT "the number of runs we looked at" — that would silently absorb every record we
  // failed to read.
  const streak = { numerator: parsed.length - timedOut.length, denominator: parsed.length };

  // WHY EITHER CONDITION IS FATAL. `unparsed > 0`: the read is incomplete, so any streak is
  // computed over an unknown subset and the missing records are exactly the ones most likely
  // to have died on the clock. `parsed === 0`: there is no measurement at all, and 0/0 must
  // never render as success.
  const failures = [];
  if (unparsed.length > 0) {
    failures.push(
      `${unparsed.length} of ${classified.length} run(s) could not be parsed — the streak CANNOT be measured over ${classified.length} runs`,
    );
  }
  if (parsed.length === 0) {
    failures.push('zero records were parsed — there is no streak to report, only an empty read');
  }

  return {
    requested,
    runs_considered: classified.length,
    parsed: parsed.length,
    unparsed: unparsed.length,
    not_reviewed: notReviewed.length,
    timed_out: timedOut.length,
    streak,
    failures,
    ok: failures.length === 0,
  };
}

/** Render the report. `parsed N of M` is mandatory output, never conditional. */
export function renderReport(summary, classified) {
  const lines = [
    `requested: ${summary.requested}`,
    `runs_considered: ${summary.runs_considered}`,
    `parsed: ${summary.parsed}`,
    `unparsed: ${summary.unparsed}`,
    `not_reviewed: ${summary.not_reviewed}`,
    `parsed ${summary.parsed} of ${summary.runs_considered}`,
    `timeout_free_streak: ${summary.streak.numerator}/${summary.streak.denominator}`,
  ];
  for (const run of classified) {
    lines.push(`  run ${run.id} [${run.class}${run.timedOut ? ', TIMED OUT' : ''}] via ${run.source}: ${run.reason}`);
  }
  for (const f of summary.failures) lines.push(`FAILED MEASUREMENT: ${f}`);
  return `${lines.join('\n')}\n`;
}

/* ── the `gh` boundary — everything below here talks to GitHub, and is injectable ────────── */

const gh = async (args) => {
  const { stdout } = await execFile('gh', args, { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
};

/**
 * List the last `count` runs of `workflow` on `repo`, pull-request events only.
 *
 * `-R OWNER/REPO` is passed to EVERY gh call, not just this one: `gh run view` fails with
 * "failed to determine base repo" whenever the CWD is not itself a git checkout of that repo,
 * which is the normal case when this is run from a planning directory.
 */
export async function listRuns({ repo, workflow, count, exec = gh }) {
  const raw = await exec([
    'api',
    '--paginate',
    `repos/${repo}/actions/workflows/${workflow}/runs?event=pull_request&per_page=${Math.max(count, 30)}`,
    '--jq',
    '.workflow_runs[] | {id, status, conclusion, created_at, head_branch, run_number}',
  ]);
  const runs = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  // Only COMPLETED runs can be measured; an in-flight run has no final record yet and must not
  // be counted as either clean or broken.
  return runs.filter((r) => r.status === 'completed').slice(0, count);
}

/** Download and read the `ai-review-coverage` artifact for one run. Returns null if absent. */
export async function fetchArtifactRecord({ repo, runId, exec = gh }) {
  let listing;
  try {
    listing = await exec(['api', `repos/${repo}/actions/runs/${runId}/artifacts`, '--jq', '.artifacts[].name']);
  } catch {
    return null;
  }
  if (!listing.split('\n').some((n) => n.trim() === 'ai-review-coverage')) return null;

  const dir = mkdtempSync(join(tmpdir(), 'council-streak-'));
  try {
    await exec(['run', 'download', String(runId), '-R', repo, '-n', 'ai-review-coverage', '-D', dir]);
    const file = readdirSync(dir)
      .map((n) => join(dir, n))
      .find((p) => statSync(p).isFile() && basename(p).endsWith('.json'));
    if (!file) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Extract the coverage record from the runner's incidental `COVERAGE_JSON:` env echo.
 *
 * Pure string handling on the fetched text — NO shell pipeline. Under `set -o pipefail` a
 * `grep -q` closing the pipe early yields SIGPIPE/141, which reads as "marker absent" for a
 * marker that was in fact present. That bug would silently shrink this tool's denominator.
 *
 * @param {string} logText
 */
export function extractRecordFromLog(logText) {
  if (typeof logText !== 'string' || logText.length === 0) return null;
  const lines = logText.split('\n');
  // Last occurrence wins: a re-run appends, and the final attempt is the one that counts.
  for (let i = lines.length - 1; i >= 0; i--) {
    const marker = lines[i].indexOf('COVERAGE_JSON: ');
    if (marker === -1) continue;
    const candidate = lines[i].slice(marker + 'COVERAGE_JSON: '.length).trim();
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // A truncated echo is NOT a clean run. Keep looking; if nothing parses we return null
      // and the caller classifies the run `unparsed`, which is the honest answer.
    }
  }
  return null;
}

export async function fetchLogRecord({ repo, runId, exec = gh }) {
  try {
    return extractRecordFromLog(await exec(['run', 'view', String(runId), '-R', repo, '--log']));
  } catch {
    return null;
  }
}

/** Resolve one run's record, artifact first, log echo second. */
export async function resolveRecord({ repo, runId, exec = gh }) {
  const fromArtifact = await fetchArtifactRecord({ repo, runId, exec });
  if (fromArtifact) return { record: fromArtifact, source: 'artifact' };
  const fromLog = await fetchLogRecord({ repo, runId, exec });
  if (fromLog) return { record: fromLog, source: 'log-echo (pre-artifact fallback)' };
  return { record: null, source: 'none' };
}

export async function readCouncilStreak({ repo, workflow, count, exec = gh }) {
  const runs = await listRuns({ repo, workflow, count, exec });
  const classified = [];
  for (const run of runs) {
    const { record, source } = await resolveRecord({ repo, runId: run.id, exec });
    const verdict = classifyRecord(record, source);
    classified.push({ id: run.id, source, ...verdict });
  }
  return { summary: summarise(classified, count), classified };
}

function parseArgs(argv) {
  const out = { repo: null, workflow: 'ai-code-review.yml', count: 10 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') out.repo = argv[++i];
    else if (argv[i] === '--workflow') out.workflow = argv[++i];
    else if (argv[i] === '--count') out.count = Number(argv[++i]);
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.repo) throw new Error('usage: read-council-streak.mjs --repo OWNER/REPO [--workflow F] [--count N]');
  if (!Number.isInteger(args.count) || args.count <= 0) throw new Error(`--count must be a positive integer, got ${args.count}`);

  const { summary, classified } = await readCouncilStreak(args);
  process.stdout.write(renderReport(summary, classified));
  // Non-zero on an incomplete read. This is the whole point: the caller must not be able to
  // mistake "we could not measure" for "the streak is clean".
  process.exitCode = summary.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'read-council-streak.mjs';
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`read-council-streak: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  });
}
