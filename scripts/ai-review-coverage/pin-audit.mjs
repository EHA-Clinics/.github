#!/usr/bin/env node
/**
 * pin-audit.mjs — the OPERATOR-RUN fleet pin audit (EHAC-2845).
 *
 * WHY THIS REPLACES THE SCHEDULED pin-inventory.yml
 * -------------------------------------------------
 * The weekly cross-repo pin inventory needed a stored credential with repo read on every
 * consumer. That credential does not exist here: a correct fine-grained PAT (org member,
 * org policy Allow, the eight consumer repos selected, Contents: read) is still org-denied
 * with `Resource not accessible by personal access token (HTTP 403)`, and a GitHub App
 * installation on those repos is blocked by a GitHub-side bug (EHAC-2845 / GitHub Support).
 * The report is observability, not a gate, so it is not worth that credential — the
 * scheduled workflow is retired.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * It runs with the OPERATOR'S OWN `gh` login, which already has repo read on the consumers.
 * It deliberately stores NO cross-repo credential: there is nothing in CI to leak, rotate
 * or mis-scope. Run it at every org-workflow rollout, BEFORE claiming "fleet rollout
 * complete" — the claim that EHAC-2841 showed was made while several consumers were still
 * two org re-pins behind.
 *
 * This is observability, not a gate: without `--expect` it always exits 0. With `--expect`
 * it exits 1 on any required caller that is not AT that exact org SHA (a caller pinned there
 * passes even once org main has moved on — aging is not a rollout failure), which is the
 * rollout-acceptance check. Drift is reported separately and can be placed by date for pins
 * whose commit never touched the called file.
 *
 * Usage:
 *   node scripts/ai-review-coverage/pin-audit.mjs
 *   node scripts/ai-review-coverage/pin-audit.mjs --expect <new-org-sha>
 *   node scripts/ai-review-coverage/pin-audit.mjs --repos a/b,c/d --json audit.json
 */

import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { writeFileSync } from 'node:fs';

/**
 * The declared consumer matrix (EHAC-2845): the core five. Consumers span two orgs —
 * EHA-Clinics and eHealthAfrica — but the canonical workflow and history repo remains
 * EHA-Clinics/.github, so every caller `uses:` it and both `extractOrgPin`'s regex and
 * `fetchHistory`'s `repos/EHA-Clinics/.github/...` history path are unchanged. Other repos
 * adopt as they need and are not audited by default; add one here only for a core rollout.
 */
export const DEFAULT_REPOS = Object.freeze([
  'EHA-Clinics/eha_care',
  'EHA-Clinics/eha-care-infra',
  'eHealthAfrica/kemiqa',
  'eHealthAfrica/aiki',
  'eHealthAfrica/eha-cloud-devops',
]);

/** The caller files whose pins are inspected in each consumer. */
export const SCANNED_FILES = Object.freeze([
  'ai-code-review.yml',
  'ai-review-on-demand.yml',
  'ai-review-streak.yml',
]);

/**
 * Files whose absence is a FAILURE under `--expect`. The streak caller legitimately does
 * not exist in most repos (a repo has no councils to read), so an
 * absent `ai-review-streak.yml` is informational, never a rollout failure.
 */
export const REQUIRED_FILES = Object.freeze([
  'ai-code-review.yml',
  'ai-review-on-demand.yml',
]);

const ORG_PIN_RE = /EHA-Clinics\/\.github\/\.github\/workflows\/([A-Za-z0-9._-]+\.yml)@([0-9a-f]{40})/;

/**
 * First org reusable-workflow pin in `text`, or null. Requires a 40-hex SHA, so branch/tag
 * refs do not match, and the `EHA-Clinics/.github/.github/workflows/` prefix keeps
 * third-party `uses:` lines out.
 */
export function extractOrgPin(text) {
  const m = String(text ?? '').match(ORG_PIN_RE);
  return m ? { target: m[1], sha: m[2] } : null;
}

/**
 * Classify one contents read. Absence of evidence is not evidence of absence: a genuine 404
 * (the caller file does not exist) is `absent`, distinct from a repo the API refused to
 * read (403, network), which is `unverified` — never silently skipped.
 */
export function classifyRead({ status, stderr = '', body = '' } = {}) {
  const s = Number(status);
  const err = String(stderr ?? '');
  if (s === 404 || /HTTP 404/.test(err)) {
    return { kind: 'absent', pin: null, target: null, detail: 'ABSENT (no such file)' };
  }
  if (Number.isFinite(s) && s >= 200 && s < 300) {
    const hit = extractOrgPin(body);
    if (hit) return { kind: 'pin', pin: hit.sha, target: hit.target, detail: null };
    return { kind: 'unverified', pin: null, target: null, detail: 'UNVERIFIED (no pin found)' };
  }
  return { kind: 'unverified', pin: null, target: null, detail: 'UNVERIFIED (unreadable)' };
}

/**
 * Re-pins behind for `sha` in `chain` (oldest→newest). The exact case counts entries after
 * the pinned commit. When the pin is not IN the chain — legitimate, because a reusable-workflow
 * ref can be any commit where the called file exists, including one that never touched it —
 * fall back to the pin commit's date and count file-touching commits newer than it. Without a
 * usable date the answer is `'unknown'`, never a guessed number.
 */
export function computeDrift(chain, sha, pinDateIso) {
  if (!Array.isArray(chain)) return 'unknown';
  const idx = chain.findIndex((entry) => (typeof entry === 'string' ? entry : entry?.sha) === sha);
  if (idx >= 0) return chain.length - 1 - idx;
  if (!pinDateIso) return 'unknown';
  const pinMs = Date.parse(pinDateIso);
  if (!Number.isFinite(pinMs) || chain.length === 0) return 'unknown';
  const dates = chain.map((entry) => (typeof entry === 'string' ? NaN : Date.parse(entry?.committedAt)));
  if (dates.some((ms) => !Number.isFinite(ms))) return 'unknown';
  return dates.filter((ms) => ms > pinMs).length;
}

/**
 * Finalize each pin row: `verified` when the pin is the newest commit that touched its file,
 * `drifted` when it is behind or its position cannot be established. `pinDateByPin` carries the
 * pinned commit's date (one fetch per distinct pin) so an off-chain pin can still be placed by
 * date. Absent/unverified rows keep their class. Every row carries `drift`
 * (0 | number | 'unknown' | null).
 */
export function applyDrift(rows, historyByTarget = {}, pinDateByPin = {}) {
  return rows.map((row) => {
    if (row.kind !== 'pin') return { ...row, drift: null, state: row.kind };
    const chain = historyByTarget[row.target] ?? [];
    const drift = computeDrift(chain, row.pin, pinDateByPin[row.pin] ?? null);
    return { ...row, drift, state: drift === 0 ? 'verified' : 'drifted' };
  });
}

/** Mutually exclusive counts over the four states. */
export function summarize(rows) {
  const counts = { verified: 0, drifted: 0, absent: 0, unverified: 0 };
  for (const row of rows) {
    if (row.state === 'verified') counts.verified++;
    else if (row.state === 'drifted') counts.drifted++;
    else if (row.state === 'absent') counts.absent++;
    else counts.unverified++;
  }
  return counts;
}

const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 8) : String(sha));

const failureOf = (row, expectedSha) => {
  const where = `${row.repo} ${row.workflow}`;
  if (row.kind === 'absent') return `${where}: ABSENT — required caller file missing`;
  if (row.kind === 'unverified') return `${where}: UNVERIFIED — ${row.detail}`;
  const drift = row.drift === null || row.drift === undefined ? '?' : row.drift;
  return `${where}: pinned \`${short(row.pin)}\` ≠ expected \`${short(expectedSha)}\` (${drift} re-pin(s) behind)`;
};

/**
 * Rollout acceptance: every required caller must be AT `expectedSha`. A readable row passes
 * when its pin equals `expectedSha`, even when it has drifted — org main moving on afterwards
 * is normal aging, not a rollout failure. Failures are: a required file absent, an unverified
 * row, or a present row pinned elsewhere (the message shows both its pin and its drift). An
 * absent `ai-review-streak.yml` is tolerated (non-required).
 */
export function evaluateExpect(rows, expectedSha) {
  const failures = [];
  for (const row of rows) {
    if (row.kind === 'absent') {
      if (REQUIRED_FILES.includes(row.workflow)) failures.push(failureOf(row, expectedSha));
      continue;
    }
    if (row.kind === 'unverified') { failures.push(failureOf(row, expectedSha)); continue; }
    if (row.pin === expectedSha) continue;
    failures.push(failureOf(row, expectedSha));
  }
  return { ok: failures.length === 0, failures };
}

export function renderMarkdown(rows, summary) {
  const lines = [];
  lines.push('| repo | workflow | pin | drift (re-pins behind) |');
  lines.push('|---|---|---|---|');
  for (const row of rows) {
    const pin = row.kind === 'pin' ? `\`${short(row.pin)}\`` : row.detail;
    const drift = row.drift === null ? '?' : row.drift;
    lines.push(`| ${row.repo} | ${row.workflow} | ${pin} | ${drift} |`);
  }
  lines.push('');
  lines.push(`Summary: ${summary.verified} verified, ${summary.drifted} drifted, ${summary.absent} absent, ${summary.unverified} unverified.`);
  return lines.join('\n');
}

// ── Fetch layer (gh) ─────────────────────────────────────────────────────────────────────

export function ghApi(path, jqExpr) {
  return execFileSync('gh', ['api', path, '--jq', jqExpr], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

const stderrOf = (err) => String(err?.stderr ?? err?.message ?? err);

/** One repo × one caller file, classified. Never throws — a failed read is a class. */
export function readRow(repo, workflow, gh = ghApi) {
  let read;
  try {
    const content = gh(`repos/${repo}/contents/.github/workflows/${workflow}`, '.content');
    const body = Buffer.from(String(content).replace(/\s+/g, ''), 'base64').toString('utf8');
    read = classifyRead({ status: 200, stderr: '', body });
  } catch (err) {
    const stderr = stderrOf(err);
    read = classifyRead({ status: /HTTP 404/.test(stderr) ? 404 : null, stderr, body: '' });
  }
  return { repo, workflow, ...read };
}

/**
 * ONE history fetch per distinct called file: oldest→newest `{ sha, committedAt }` entries.
 * The API returns newest-first, so the order is reversed in JS — the jq expression only shapes
 * the fields. (The previous expression ended in `.reverse()`, which is not valid jq: it is a
 * filter, called as `reverse`, not a method. gh exited non-zero, the blanket catch below turned
 * that into an empty chain, and every pin read `'unknown'`.)
 */
export function fetchHistory(target, gh = ghApi) {
  try {
    const raw = gh(
      `repos/EHA-Clinics/.github/commits?path=.github/workflows/${target}&sha=main&per_page=100`,
      '[.[] | {sha: .sha, committedAt: .commit.committer.date}]',
    );
    return JSON.parse(raw).reverse();
  } catch {
    return [];
  }
}

/** The pinned commit's committer date, for the off-chain drift fallback. Null when unreadable. */
export function pinCommitDate(pin, gh = ghApi) {
  try {
    const date = String(gh(`repos/EHA-Clinics/.github/commits/${pin}`, '.commit.committer.date') ?? '').trim();
    return date || null;
  } catch {
    return null;
  }
}

export function parseArgs(argv) {
  const opts = { repos: [...DEFAULT_REPOS], expect: null, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--repos') opts.repos = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--expect') {
      const v = next();
      if (!/^[0-9a-f]{40}$/.test(v)) throw new Error('--expect must be a 40-hex org SHA');
      opts.expect = v;
    } else if (a === '--json') opts.json = next();
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

export async function main(argv) {
  const opts = parseArgs(argv);
  const rows = [];
  for (const repo of opts.repos) {
    for (const workflow of SCANNED_FILES) rows.push(readRow(repo, workflow));
  }

  const pinRows = rows.filter((r) => r.kind === 'pin');
  const historyByTarget = {};
  for (const target of new Set(pinRows.map((r) => r.target))) historyByTarget[target] = fetchHistory(target);

  const pinDateByPin = {};
  for (const pin of new Set(pinRows.map((r) => r.pin))) pinDateByPin[pin] = pinCommitDate(pin);

  const finalRows = applyDrift(rows, historyByTarget, pinDateByPin);
  const summary = summarize(finalRows);
  process.stdout.write(`${renderMarkdown(finalRows, summary)}\n`);
  if (opts.json) writeFileSync(opts.json, `${JSON.stringify({ rows: finalRows, summary }, null, 2)}\n`);

  if (opts.expect) {
    const { ok, failures } = evaluateExpect(finalRows, opts.expect);
    if (!ok) {
      process.stderr.write(`[pin-audit] rollout NOT complete: ${failures.length} failure(s) at ${short(opts.expect)}\n`);
      for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
      return 1;
    }
  }
  return 0;
}

/* c8 ignore start — entrypoint */
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'pin-audit.mjs';
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[pin-audit] ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
/* c8 ignore stop */
