#!/usr/bin/env node
/**
 * read-coverage-streak.mjs — the STREAK READER for the `AI Review Coverage` record
 * (EHAC-2280 AC #3 / AC #5; EHAC-2231 measurements).
 *
 * WHY THIS EXISTS
 * ---------------
 * Every council run persists its coverage record as the `ai-review-coverage` artifact
 * (ai-code-review.yml, "Persist coverage record" → "Upload coverage record"). The record
 * carries, per model run, the failure class, the OpenRouter endpoint that actually served it,
 * the reasoning tokens the provider billed, and the physical attempt history. Until this
 * script existed nothing READ those records back: "ten consecutive councils without a
 * timeout" (EHAC-2280 AC #3) was a count nobody could produce, and the reasoning cap that
 * elek's `types.ts`, the workflow's `reasoning_max_tokens` input and eha-care-infra's budget
 * gate all say must be sized from `native_tokens_reasoning` had no distribution to size from.
 *
 * CONTRACT
 * --------
 *  - Reads ARTIFACTS, never job logs. A log echo is an incidental rendering with no format
 *    contract, and an absent echo parses identically to a clean one (T-2280-04).
 *  - A completed review run (success, failure or timed_out) with NO artifact is a FAULT, not
 *    a miss. The upload step runs `if: always()` with `if-no-files-found: error`, so absence
 *    means the contract was broken somewhere; this reader names the run and exits 1. A
 *    "perfect streak" computed over an empty read is the measurement that cannot come out
 *    badly, and it is the one this tool must never produce.
 *  - An EXPIRED artifact (90-day retention) is out of the observation window: reported,
 *    excluded from every figure, neither a pass nor a fault.
 *  - `NOT_REVIEWED` records ran no council. Counted separately; never a link in a streak.
 *  - A BROKEN streak is not an error exit. This is an observability tool. The only non-zero
 *    exits are faults (absent/unreadable record, nothing inspected, listing failure).
 *
 * Pure core + thin CLI, the same split as measure-review-coverage.mjs: everything reachable
 * from `summarizeCoverageRecords` runs offline against fixtures/council/*.json; the
 * `gh`-driven fetch layer is confined to `listRuns` / `fetchEntry`.
 *
 * Usage:
 *   GH_TOKEN=… node read-coverage-streak.mjs --repo EHA-Clinics/eha_care [--limit 40]
 *       [--workflows ai-code-review.yml,ai-review-on-demand.yml]
 *       [--json summary.json] [--markdown out.md] [--entries entries.json]
 *   node read-coverage-streak.mjs --from-entries entries.json [--json …] [--markdown …]
 *
 * `--entries` writes the raw observations (run metadata + record) so an analysis can be
 * re-run offline and the sizing evidence can be attached to a ticket unchanged.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { normalizeReasoningModel } from './reasoning-policy.mjs';

export const ARTIFACT_NAME = 'ai-review-coverage';
export const DEFAULT_WORKFLOWS = Object.freeze(['ai-code-review.yml', 'ai-review-on-demand.yml']);
export const DEFAULT_LIMIT = 40;

/**
 * The class whose absence AC #3 counts. `timeout` — the wall clock expired while work was
 * still arriving — is the one class elek deliberately never retries (strategy.ts), so the
 * only way to a clean streak is for runs to actually finish. That is what makes it the
 * right thing to count and `elek_status` the wrong one: a council can be `degraded` for
 * reasons a retry absorbed, and `healthy` for reasons nothing measured.
 */
export const STREAK_BREAKING_CLASS = 'timeout';

/** Run conclusions after which the upload step MUST have executed. Anything else did not run jobs. */
export const CONCLUSIONS_WITH_A_RECORD = Object.freeze(['success', 'failure', 'timed_out']);

export const SIZE_BUCKETS = Object.freeze([
  { label: '< 20k chars', max: 20_000 },
  { label: '20k – 100k', max: 100_000 },
  { label: '100k – 300k', max: 300_000 },
  { label: '≥ 300k', max: Infinity },
]);

/** Nearest-rank percentile over finite values. Null on an empty sample — never 0. */
export function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const count = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
const modelKey = (label) => {
  const s = String(label ?? '').trim();
  return s ? normalizeReasoningModel(s) : '(unknown model)';
};
const stats = (values) => ({
  n: values.length,
  p50: percentile(values, 50),
  p90: percentile(values, 90),
  p99: percentile(values, 99),
  max: values.length ? Math.max(...values) : null,
});

/**
 * One observation. `kind` is decided by the fetch layer from facts the API states:
 *   record      — artifact downloaded and parsed to a JSON object
 *   expired     — artifact existed and is past retention                (out of window)
 *   cancelled   — run cancelled; the upload step may never have executed (out of window)
 *   not_executed — run never ran jobs (startup_failure, skipped, action_required, in progress)
 *   absent      — completed run with no artifact                       (FAULT)
 *   unreadable  — artifact present but not a JSON object               (FAULT)
 * A test-built entry may omit `kind`; a record makes it `record`, anything else `absent`.
 */
export function classifyEntry(entry) {
  if (entry.kind) return entry.kind;
  return entry.record && typeof entry.record === 'object' && !Array.isArray(entry.record) ? 'record' : 'absent';
}

export const OUT_OF_WINDOW_KINDS = Object.freeze(['expired', 'cancelled', 'not_executed']);
export const FAULT_KINDS = Object.freeze(['absent', 'unreadable']);

/**
 * Physical attempts for a record. Older records (before EHAC-2231's attempt history) carry
 * logical runs only; those are PROJECTED to one attempt each and marked, so the failure-class
 * census still sees them and nobody mistakes the projection for measured history.
 */
export function attemptsOf(record) {
  const attempts = record?.models?.attempts;
  if (Array.isArray(attempts)) return attempts;
  const runs = record?.models?.runs;
  if (!Array.isArray(runs)) return [];
  return runs.map((r) => ({
    lens_id: r.lens_id ?? null,
    role: r.role ?? null,
    attempt: 1,
    assigned_model: r.assigned_model_label ?? r.model_label ?? null,
    actual_model: r.actual_model_label ?? r.model_label ?? null,
    failover: r.failover_used ?? false,
    conclusion: r.conclusion ?? null,
    failure_class: r.failure_class ?? null,
    duration_seconds: null,
    projected_from_runs: true,
  }));
}

const newestFirst = (entries) =>
  [...entries].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

/**
 * Two streaks, both counted newest-first and both broken by the first run that fails them.
 * Out-of-window entries are skipped; NOT_REVIEWED records are skipped; a FAULT breaks both —
 * a run whose record cannot be read is a run we cannot vouch for.
 */
export function computeStreaks(entries) {
  const ordered = newestFirst(entries);
  const timeoutFree = { length: 0, broken_by: null };
  const healthy = { length: 0, broken_by: null };
  for (const e of ordered) {
    const kind = classifyEntry(e);
    if (OUT_OF_WINDOW_KINDS.includes(kind)) continue;
    if (kind !== 'record') {
      const b = { run_id: e.run_id, created_at: e.created_at ?? null, reason: `no readable coverage record (${kind})` };
      timeoutFree.broken_by ??= b;
      healthy.broken_by ??= b;
      break;
    }
    const r = e.record;
    if (r.verdict === 'NOT_REVIEWED') continue;
    if (!timeoutFree.broken_by) {
      const timedOut = attemptsOf(r).filter((a) => a.failure_class === STREAK_BREAKING_CLASS);
      if (timedOut.length > 0) {
        timeoutFree.broken_by = {
          run_id: e.run_id,
          created_at: e.created_at ?? null,
          reason: `${timedOut.length} attempt(s) classed ${STREAK_BREAKING_CLASS}: ` +
            timedOut.map((a) => `${a.lens_id ?? '?'}@${a.actual_model ?? a.assigned_model ?? '?'}`).join(', '),
        };
      } else {
        timeoutFree.length++;
      }
    }
    if (!healthy.broken_by) {
      const status = r.models?.policy?.elek_status ?? null;
      if (status === 'healthy') healthy.length++;
      else healthy.broken_by = { run_id: e.run_id, created_at: e.created_at ?? null, reason: `elek_status ${status ?? 'unreported'}` };
    }
    if (timeoutFree.broken_by && healthy.broken_by) break;
  }
  return { timeout_free: timeoutFree, healthy };
}

const rosterOf = (record) => {
  const c = record?.models?.configured;
  if (!c || (!Array.isArray(c.review_models) && !c.validator_model)) return null;
  return `${(c.review_models ?? []).join(',')} → ${c.validator_model ?? '(unset)'}`;
};

/**
 * The pure core. `entries` is an array of observations (see classifyEntry). Returns a
 * summary that is complete on its own — every figure carries its sample size, and every
 * exclusion is counted somewhere, so the reader of the summary can tell what was NOT
 * measured. That is the non-vacuity property this whole gate family exists to keep.
 */
export function summarizeCoverageRecords(entries, { generatedAt = new Date().toISOString(), source = null } = {}) {
  const ordered = newestFirst(entries);
  const census = { inspected: ordered.length, records: 0, councils: 0, not_reviewed: 0, expired: 0, cancelled: 0, not_executed: 0, faults: 0 };
  const faults = [];
  const notReviewedReasons = {};
  const councils = [];

  for (const e of ordered) {
    const kind = classifyEntry(e);
    if (kind === 'expired') { census.expired++; continue; }
    if (kind === 'cancelled') { census.cancelled++; continue; }
    if (kind === 'not_executed') { census.not_executed++; continue; }
    if (FAULT_KINDS.includes(kind)) {
      census.faults++;
      faults.push({ run_id: e.run_id, created_at: e.created_at ?? null, workflow: e.workflow ?? null, conclusion: e.conclusion ?? null, kind, detail: e.detail ?? null });
      continue;
    }
    census.records++;
    if (e.record.verdict === 'NOT_REVIEWED') {
      census.not_reviewed++;
      count(notReviewedReasons, e.record.not_reviewed?.reason ?? '(unstated)');
      continue;
    }
    census.councils++;
    councils.push(e);
  }

  const verdicts = {};
  const elekStatus = {};
  const failureClasses = {};
  const pins = {};
  const perModel = {};
  const model = (k) => (perModel[k] ??= {
    logical_runs: 0, failed_runs: 0, attempts: 0, failed_attempts: 0, failover_in: 0,
    failure_classes: {}, serving_providers: {},
    native_tokens_reasoning: [], duration_seconds: [], generation_time_ms: [],
  });
  const sizeBuckets = SIZE_BUCKETS.map((b) => ({ label: b.label, n: 0, verdicts: {}, elek_status: {}, timeouts: 0 }));
  let unsized = 0;
  const rosters = {};
  const rosterDrift = [];
  let currentRoster = null;
  const window = { newest: null, oldest: null };
  // EHAC-2833: the validator roles get their own census. A validator failure is not a
  // quorum event — it breaches the council at ANY tolerance and (outside 404) never
  // retries — so folding it into the per-model table hid exactly the population the
  // 2026-09-21/22 PR #4235 outages belonged to. `independence_collapses` counts
  // validator-review attempts whose ACTUAL model differs from their ASSIGNED one (the
  // 404 failover runs the audit on a reviewer model); `stale_head` counts councils whose
  // record names a different head SHA than the check run (U4), so the race window can
  // be sized from records rather than anecdotes.
  const validatorRoles = new Set(['validator', 'validator-review']);
  const validatorCensus = {
    logical_runs: 0, failed_runs: 0, attempts: 0, failed_attempts: 0, failover_in: 0,
    failure_classes: {}, models: {}, independence_collapses: 0, stale_head: 0,
    duration_seconds: [],
  };

  for (const e of councils) {
    const r = e.record;
    window.newest ??= e.created_at ?? null;
    window.oldest = e.created_at ?? window.oldest;
    count(verdicts, r.verdict ?? '(unstated)');
    count(elekStatus, r.models?.policy?.elek_status ?? '(unreported)');
    count(pins, r.elek?.ref ?? '(unrecorded)');

    const attempts = attemptsOf(r);
    let timeouts = 0;
    for (const a of attempts) {
      const m = model(modelKey(a.actual_model ?? a.assigned_model));
      m.attempts++;
      if (validatorRoles.has(String(a.role ?? ''))) {
        validatorCensus.attempts++;
        count(validatorCensus.models, modelKey(a.actual_model ?? a.assigned_model));
        if (a.conclusion !== 'success') validatorCensus.failed_attempts++;
        if (a.failover === true) validatorCensus.failover_in++;
        if (a.failover === true && String(a.assigned_model ?? '') && String(a.assigned_model ?? '') !== String(a.actual_model ?? '')) {
          validatorCensus.independence_collapses++;
        }
        if (a.conclusion !== 'success') count(validatorCensus.failure_classes, a.failure_class ?? 'unclassified');
        const vd = num(a.duration_seconds);
        if (vd !== null) validatorCensus.duration_seconds.push(vd);
      }
      if (a.conclusion !== 'success') {
        m.failed_attempts++;
        const fc = a.failure_class ?? 'unclassified';
        count(failureClasses, fc);
        count(m.failure_classes, fc);
        if (fc === STREAK_BREAKING_CLASS) timeouts++;
      }
      if (a.failover === true) m.failover_in++;
      const d = num(a.duration_seconds);
      if (d !== null) m.duration_seconds.push(d);
    }
    for (const run of r.models?.runs ?? []) {
      const m = model(modelKey(run.actual_model_label ?? run.model_label));
      m.logical_runs++;
      if (run.conclusion !== 'success') m.failed_runs++;
      if (validatorRoles.has(String(run.role ?? ''))) {
        validatorCensus.logical_runs++;
        if (run.conclusion !== 'success') validatorCensus.failed_runs++;
      }
      if (typeof run.serving_provider === 'string' && run.serving_provider) count(m.serving_providers, run.serving_provider);
      const ntr = num(run.native_tokens_reasoning);
      if (ntr !== null) m.native_tokens_reasoning.push(ntr);
      const g = num(run.generation_time_ms);
      if (g !== null) m.generation_time_ms.push(g);
    }

    // U4 (stale head) — the race the streak reader can now size from records.
    if (r.refs && r.refs.sha_match === false) validatorCensus.stale_head++;

    const chars = num(r.diff?.chars);
    const idx = chars === null ? -1 : SIZE_BUCKETS.findIndex((b) => chars < b.max);
    if (idx < 0) unsized++;
    else {
      const b = sizeBuckets[idx];
      b.n++;
      count(b.verdicts, r.verdict ?? '(unstated)');
      count(b.elek_status, r.models?.policy?.elek_status ?? '(unreported)');
      b.timeouts += timeouts;
    }

    const roster = rosterOf(r);
    if (roster !== null) {
      count(rosters, roster);
      currentRoster ??= roster;
      if (roster !== currentRoster) rosterDrift.push({ run_id: e.run_id, created_at: e.created_at ?? null, roster });
    }
  }

  const models = Object.fromEntries(
    Object.entries(perModel)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, m]) => [k, {
        ...m,
        native_tokens_reasoning: stats(m.native_tokens_reasoning),
        duration_seconds: stats(m.duration_seconds),
        generation_time_ms: stats(m.generation_time_ms),
      }]),
  );

  const validator = {
    ...validatorCensus,
    duration_seconds: stats(validatorCensus.duration_seconds),
  };

  return {
    schema: 1,
    generated_at: generatedAt,
    source,
    window,
    census,
    streaks: computeStreaks(ordered),
    verdicts,
    elek_status: elekStatus,
    failure_classes: failureClasses,
    models,
    validator_roles: validator,
    size_vs_outcome: { buckets: sizeBuckets, unsized },
    roster: { current: currentRoster, seen: rosters, drift: rosterDrift },
    elek_pins: pins,
    not_reviewed_reasons: notReviewedReasons,
    faults,
  };
}

// ── Markdown ────────────────────────────────────────────────────────────────────────────

const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v));
const kv = (map) => Object.entries(map).sort(([, a], [, b]) => b - a).map(([k, v]) => `${k} ×${v}`).join(', ') || '—';
const code = (s) => `\`${s}\``;

export function renderMarkdown(s) {
  const lines = [];
  const c = s.census;
  lines.push(`## AI Review coverage streak${s.source ? ` — ${s.source}` : ''}`, '');
  lines.push(`Generated ${s.generated_at}. Window ${fmt(s.window.oldest)} → ${fmt(s.window.newest)}.`, '');
  lines.push(
    `**Inspected ${c.inspected} run(s)**: ${c.councils} council(s), ${c.not_reviewed} NOT_REVIEWED, ` +
    `${c.expired} expired, ${c.cancelled} cancelled, ${c.not_executed} never executed, **${c.faults} fault(s)**.`,
    '',
  );
  if (c.councils === 0) lines.push('> ⚠️ **No council records in the window — every figure below is over an empty sample.**', '');

  lines.push('### Streaks (newest first)', '');
  const st = s.streaks;
  lines.push(`- **${st.timeout_free.length}** consecutive council(s) with no ${code(STREAK_BREAKING_CLASS)}-class attempt` +
    (st.timeout_free.broken_by ? ` — broken by run ${st.timeout_free.broken_by.run_id}: ${st.timeout_free.broken_by.reason}` : ' — unbroken in the window'));
  lines.push(`- **${st.healthy.length}** consecutive council(s) with ${code('elek_status: healthy')}` +
    (st.healthy.broken_by ? ` — broken by run ${st.healthy.broken_by.run_id}: ${st.healthy.broken_by.reason}` : ' — unbroken in the window'));
  lines.push('');

  lines.push('### Council outcomes', '');
  lines.push(`- verdicts: ${kv(s.verdicts)}`);
  lines.push(`- elek_status: ${kv(s.elek_status)}`);
  lines.push(`- failed-attempt classes: ${kv(s.failure_classes)}`);
  lines.push(`- elek pins: ${kv(s.elek_pins)}`);
  lines.push('');

  lines.push('### Per model', '');
  lines.push('| model | logical runs (failed) | attempts (failed) | failover in | serving providers | reasoning tokens n / p50 / p90 / p99 / max | attempt seconds p50 / p90 / max |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const [k, m] of Object.entries(s.models)) {
    const r = m.native_tokens_reasoning;
    const d = m.duration_seconds;
    lines.push(`| ${code(k)} | ${m.logical_runs} (${m.failed_runs}) | ${m.attempts} (${m.failed_attempts})` +
      `${Object.keys(m.failure_classes).length ? ` ${kv(m.failure_classes)}` : ''} | ${m.failover_in} | ${kv(m.serving_providers)} ` +
      `| ${r.n} / ${fmt(r.p50)} / ${fmt(r.p90)} / ${fmt(r.p99)} / ${fmt(r.max)} | ${fmt(d.p50)} / ${fmt(d.p90)} / ${fmt(d.max)} |`);
  }
  lines.push('');

  lines.push('### Validator roles (EHAC-2833)', '');
  const v = s.validator_roles;
  const vd = v.duration_seconds;
  lines.push(`- logical runs: ${v.logical_runs} (${v.failed_runs} failed) | attempts: ${v.attempts} (${v.failed_attempts} failed)` +
    `${Object.keys(v.failure_classes).length ? ` — classes: ${kv(v.failure_classes)}` : ''}`);
  lines.push(`- failovers in: ${v.failover_in} | independence collapses (audit ran on a reviewer model): ${v.independence_collapses}`);
  lines.push(`- attempt seconds n / p50 / p90 / p99 / max: ${vd.n} / ${fmt(vd.p50)} / ${fmt(vd.p90)} / ${fmt(vd.p99)} / ${fmt(vd.max)}`);
  lines.push(`- stale-head councils (U4, push raced the review): ${v.stale_head}`);
  lines.push(`- models that ran a validator role: ${kv(v.models)}`);
  lines.push('');

  lines.push('### Diff size vs outcome', '');
  lines.push('| diff.chars | councils | verdicts | elek_status | timeout attempts |');
  lines.push('|---|---|---|---|---|');
  for (const b of s.size_vs_outcome.buckets) lines.push(`| ${b.label} | ${b.n} | ${kv(b.verdicts)} | ${kv(b.elek_status)} | ${b.timeouts} |`);
  if (s.size_vs_outcome.unsized) lines.push(`| (no diff.chars) | ${s.size_vs_outcome.unsized} | | | |`);
  lines.push('');

  lines.push('### Configured roster', '');
  lines.push(`- current: ${s.roster.current ? code(s.roster.current) : '(unrecorded)'}`);
  if (s.roster.drift.length) {
    lines.push(`- **${s.roster.drift.length} council(s) ran on a different roster than the newest:**`);
    for (const d of s.roster.drift) lines.push(`  - run ${d.run_id} (${fmt(d.created_at)}): ${code(d.roster)}`);
  } else lines.push('- no roster drift in the window');
  lines.push('');

  if (Object.keys(s.not_reviewed_reasons).length) lines.push(`NOT_REVIEWED reasons: ${kv(s.not_reviewed_reasons)}`, '');

  if (s.faults.length) {
    lines.push('### ⛔ Faults — runs that should carry a record and do not', '');
    for (const f of s.faults) lines.push(`- run ${f.run_id} (${fmt(f.created_at)}, ${f.workflow ?? '?'}, ${f.conclusion ?? '?'}): ${f.kind}${f.detail ? ` — ${f.detail}` : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ── Fetch layer (gh) ─────────────────────────────────────────────────────────────────────

const firstLine = (err) => String(err?.stderr ?? err?.message ?? err).split('\n').find(Boolean) ?? String(err);

export function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** List the newest `limit` runs across the named caller workflows, merged and sorted. */
export function listRuns({ repo, workflows, limit, ghExec = gh, warn = () => {} }) {
  const runs = [];
  for (const wf of workflows) {
    const perPage = Math.min(100, Math.max(1, limit));
    let page = 1;
    let seen = 0;
    while (seen < limit) {
      let raw;
      try {
        raw = ghExec(['api', `repos/${repo}/actions/workflows/${wf}/runs?per_page=${perPage}&page=${page}`]);
      } catch (err) {
        warn(`listing ${wf} failed: ${firstLine(err)}`);
        break;
      }
      const batch = JSON.parse(raw).workflow_runs ?? [];
      for (const r of batch) {
        runs.push({ run_id: r.id, created_at: r.created_at, head_branch: r.head_branch ?? null, event: r.event ?? null, status: r.status, conclusion: r.conclusion ?? null, workflow: wf });
      }
      seen += batch.length;
      if (batch.length < perPage) break;
      page++;
    }
  }
  return newestFirst(runs).slice(0, limit);
}

/** Turn one listed run into an observation. Never throws; every failure mode is a `kind`. */
export function fetchEntry({ repo, run, dir, ghExec = gh }) {
  const base = { run_id: run.run_id, created_at: run.created_at, head_branch: run.head_branch, workflow: run.workflow, event: run.event, conclusion: run.conclusion };
  if (run.status !== 'completed') return { ...base, kind: 'not_executed', detail: `status ${run.status}` };
  if (run.conclusion === 'cancelled') return { ...base, kind: 'cancelled' };
  if (!CONCLUSIONS_WITH_A_RECORD.includes(run.conclusion)) return { ...base, kind: 'not_executed', detail: `conclusion ${run.conclusion}` };

  let artifacts;
  try {
    artifacts = (JSON.parse(ghExec(['api', `repos/${repo}/actions/runs/${run.run_id}/artifacts`])).artifacts ?? [])
      .filter((a) => a.name === ARTIFACT_NAME);
  } catch (err) {
    return { ...base, kind: 'unreadable', detail: `artifact listing failed: ${firstLine(err)}` };
  }
  if (artifacts.length === 0) return { ...base, kind: 'absent', detail: `no ${ARTIFACT_NAME} artifact on a ${run.conclusion} run` };
  if (artifacts.every((a) => a.expired)) return { ...base, kind: 'expired' };

  const target = join(dir, String(run.run_id));
  mkdirSync(target, { recursive: true });
  try {
    ghExec(['run', 'download', String(run.run_id), '-R', repo, '-n', ARTIFACT_NAME, '-D', target]);
  } catch (err) {
    return { ...base, kind: 'unreadable', detail: `download failed: ${firstLine(err)}` };
  }
  let record;
  try {
    record = JSON.parse(readFileSync(join(target, 'coverage.json'), 'utf8'));
  } catch (err) {
    return { ...base, kind: 'unreadable', detail: `coverage.json unreadable: ${firstLine(err)}` };
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { ...base, kind: 'unreadable', detail: 'coverage.json is not a JSON object' };
  return { ...base, kind: 'record', record };
}

export function collectEntries({ repo, workflows, limit, ghExec = gh, log = () => {}, warn = () => {} }) {
  const runs = listRuns({ repo, workflows, limit, ghExec, warn });
  log(`listed ${runs.length} run(s) across ${workflows.join(', ')} in ${repo}`);
  const dir = mkdtempSync(join(tmpdir(), 'ai-review-streak-'));
  try {
    return runs.map((run) => {
      const entry = fetchEntry({ repo, run, dir, ghExec });
      log(`run ${run.run_id} ${run.created_at} ${run.workflow} ${run.conclusion ?? run.status}: ${entry.kind}${entry.detail ? ` (${entry.detail})` : ''}`);
      return entry;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = { repo: null, workflows: [...DEFAULT_WORKFLOWS], limit: DEFAULT_LIMIT, json: null, markdown: null, entries: null, fromEntries: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--repo') opts.repo = next();
    else if (a === '--workflows') opts.workflows = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--limit') { opts.limit = Number(next()); if (!Number.isInteger(opts.limit) || opts.limit <= 0) throw new Error('--limit must be a positive integer'); }
    else if (a === '--json') opts.json = next();
    else if (a === '--markdown') opts.markdown = next();
    else if (a === '--entries') opts.entries = next();
    else if (a === '--from-entries') opts.fromEntries = next();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.repo && !opts.fromEntries) throw new Error('--repo owner/name is required (or --from-entries file)');
  return opts;
}

export async function main(argv, env) {
  const opts = parseArgs(argv);
  const log = (m) => process.stderr.write(`[ai-review-streak] ${m}\n`);

  let entries;
  let source;
  if (opts.fromEntries) {
    entries = JSON.parse(readFileSync(opts.fromEntries, 'utf8'));
    source = `${basename(opts.fromEntries)} (offline)`;
  } else {
    entries = collectEntries({ repo: opts.repo, workflows: opts.workflows, limit: opts.limit, log, warn: (m) => log(`WARNING ${m}`) });
    source = `${opts.repo} · ${opts.workflows.join(', ')} · newest ${opts.limit}`;
  }
  if (opts.entries) writeFileSync(opts.entries, `${JSON.stringify(entries, null, 2)}\n`);

  const summary = summarizeCoverageRecords(entries, { source });
  const markdown = renderMarkdown(summary);

  if (opts.json) writeFileSync(opts.json, `${JSON.stringify(summary, null, 2)}\n`);
  if (opts.markdown) appendFileSync(opts.markdown, `${markdown}\n`);
  else if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  else process.stdout.write(`${markdown}\n`);

  const c = summary.census;
  if (c.inspected === 0) {
    log('inspected NOTHING — zero runs listed. That is not a clean streak; it is an empty read.');
    return 1;
  }
  if (summary.faults.length > 0) {
    for (const f of summary.faults) log(`::error title=AI review coverage record missing::run ${f.run_id} (${f.conclusion}): ${f.kind}${f.detail ? ` — ${f.detail}` : ''}`);
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'read-coverage-streak.mjs';
if (invokedDirectly) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[ai-review-streak] ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
