/**
 * assert-caller-shape.mjs — EHAC-2060/EHAC-2167.
 *
 * Checks the CALLING repository's own AI-review caller workflows for the three shapes that
 * silently break the `AI Review Coverage` check, and reports them from inside the shared
 * workflow so every consumer gets the guard from one place.
 *
 * WHY THIS IS CENTRAL AND NOT A PER-REPO TEST
 * -------------------------------------------
 * `eha_care` encodes these rules in a vitest spec. Porting that spec to the other eleven
 * consumers is not possible on equal terms: five of them (eha-care-mobile, lomis-drive,
 * lomis-suite, lomis-com-watch, epims, planfeld) have no root test runner at all, and the
 * rest are jest / pytest / bats — three more implementations of the same three rules, each
 * able to rot independently. That is the very drift class EHAC-2167 exists to remove, so the
 * guard belongs where the workflow already runs: here.
 *
 * WHAT IT CHECKS
 * --------------
 *   C1  no workflow-level `paths:` under the `pull_request:` trigger
 *   C2  no job-level `if:` on the automatic caller's review job
 *   C3  every reusable-workflow ref is a 40-hex SHA, and all callers agree on ONE SHA
 *
 * C1 and C2 both make a check UNREPORTABLE rather than failing: a paths-filtered workflow
 * never dispatches, and a skipped job produces no check run. A required context that is
 * never reported leaves the pull request pending forever. A gate that cannot fail is bad; a
 * gate that cannot PASS breaks the same property from the other side.
 *
 * The on-demand caller is exempt from C2 by design: its job-level `if:` is the `@ai-review`
 * gate, and removing it would invoke a paid council run on every `issue_comment` in the repo.
 *
 * Deliberately dependency-free — Node built-ins only, block isolation by indentation, the
 * same choice `workflow-invariants.test.mjs` makes and for the same reason: putting a
 * third-party YAML parser between the assertion and the artefact weakens the assertion.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A file is an AI-review caller if it calls the shared reusable workflow. */
const CALLER_RE = /^\s*uses:\s*\S*\.github\/\.github\/workflows\/ai-code-review\.yml@(\S+)/gm;

/** An on-demand caller is comment-triggered; its job-level `if:` is load-bearing. */
export const isOnDemand = (text) =>
  /^on:/m.test(text) && /^\s{2}(issue_comment|pull_request_review_comment):/m.test(text);

/**
 * Count `paths:` keys inside the workflow-level `pull_request:` trigger block.
 * Same implementation as eha_care's spec so the two read identically.
 */
export function countWorkflowLevelPaths(text) {
  let inPullRequest = false;
  let count = 0;
  for (const line of text.split('\n')) {
    if (/^ {2}pull_request:/.test(line)) {
      inPullRequest = true;
      continue;
    }
    if (inPullRequest && /^ {2}[a-z_]+:/.test(line)) break;
    if (inPullRequest && /^\s+paths:/.test(line)) count++;
  }
  return count;
}

/** Job-level `if:` keys — exactly four spaces, i.e. the indent that skips a whole job. */
export const jobLevelIfs = (text) =>
  text.split('\n').filter((line) => /^ {4}if:/.test(line));

/** Every reusable-workflow ref in a file. */
export const reusableRefs = (text) =>
  [...text.matchAll(CALLER_RE)].map((m) => m[1].replace(/\s+#.*$/, '').trim());

export function inspectCallers(files) {
  const findings = [];
  const allRefs = [];

  for (const { name, text } of files) {
    const refs = reusableRefs(text);
    if (refs.length === 0) continue;
    allRefs.push(...refs.map((ref) => ({ name, ref })));

    const onDemand = isOnDemand(text);

    if (!onDemand) {
      const paths = countWorkflowLevelPaths(text);
      if (paths > 0) {
        findings.push({
          code: 'C1',
          file: name,
          message:
            `has a workflow-level \`paths:\` filter. A paths-filtered workflow never ` +
            `dispatches on an out-of-scope PR, so NO check run is created and "not applicable" ` +
            `cannot be distinguished from a broken integration. Pass \`scope_paths\` instead — it is evaluated ` +
            `inside this workflow and yields a green NOT_REVIEWED verdict.`,
        });
      }

      const ifs = jobLevelIfs(text);
      if (ifs.length > 0) {
        findings.push({
          code: 'C2',
          file: name,
          message:
            `has a job-level \`if:\` (${ifs.length}). A skipped job produces NO check run, ` +
            `not a green one. Drafts are already handled inside this workflow, which reports ` +
            `them as a green NOT_REVIEWED verdict.`,
        });
      }
    }

    for (const ref of refs) {
      if (!/^[0-9a-f]{40}$/.test(ref)) {
        findings.push({
          code: 'C3',
          file: name,
          message:
            `pins the reusable workflow at \`${ref}\`, which is not a 40-hex SHA. A branch ` +
            `or tag ref lets the shared workflow change underneath this repo — the pin-drift ` +
            `class EHAC-2167 exists to remove.`,
        });
      }
    }
  }

  const distinct = [...new Set(allRefs.map((r) => r.ref))];
  if (distinct.length > 1) {
    findings.push({
      code: 'C3',
      file: allRefs.map((r) => r.name).join(', '),
      message:
        `callers disagree on the reusable-workflow SHA (${distinct.join(', ')}). A caller ` +
        `left behind keeps the OLD behaviour — exactly how EHAC-2099 persisted in the ` +
        `on-demand caller after its fix shipped for the automatic one.`,
    });
  }

  return findings;
}

export function readWorkflowDir(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null; // no workflows dir — reported by the caller, never silently "clean"
  }
  return names
    .filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

/* c8 ignore start — entrypoint */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const dir = process.env.CALLER_WORKFLOWS_DIR || '.github/workflows';
  const mode = process.env.CALLER_SHAPE_MODE === 'enforce' ? 'enforce' : 'warn';

  const files = readWorkflowDir(dir);
  if (files === null) {
    console.log(`::warning title=AI review caller shape::no ${dir} directory found — nothing inspected`);
    process.exit(0);
  }

  const findings = inspectCallers(files);
  const callerCount = files.filter((f) => reusableRefs(f.text).length > 0).length;

  // Non-vacuity: say out loud how many caller files were actually inspected. "0 findings"
  // over 0 files is not a pass, and this is the line that makes the difference visible.
  console.log(`Inspected ${files.length} workflow file(s); ${callerCount} call this workflow.`);

  if (callerCount === 0) {
    console.log('::warning title=AI review caller shape::no caller file matched — the shape guard inspected NOTHING');
    process.exit(0);
  }

  for (const f of findings) {
    console.log(`::warning title=AI review caller shape (${f.code})::${f.file} ${f.message}`);
  }

  if (findings.length === 0) {
    console.log(`All ${callerCount} caller file(s) are promotable: no paths: filter, no job-level if:, one 40-hex pin.`);
    process.exit(0);
  }

  console.log(`${findings.length} caller-shape finding(s) in ${mode} mode.`);
  process.exit(mode === 'enforce' ? 1 : 0);
}
/* c8 ignore stop */
