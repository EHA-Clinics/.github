#!/usr/bin/env node
/**
 * Contract checks for the reusable workflow's two gate-script checkouts.
 *
 * GitHub exposes the called workflow's repository and immutable commit through
 * `job.workflow_repository` and `job.workflow_sha`. Using those values removes
 * the self-referential two-PR pin dance: the code tested in this repository is
 * the code each invocation checks out, including while a pull request is open.
 */

export const WORKFLOW_REPOSITORY_EXPRESSION = '${{ job.workflow_repository }}';
export const WORKFLOW_SHA_EXPRESSION = '${{ job.workflow_sha }}';

/** Keys that make GitHub report a failing job or step as green. */
export const ERROR_SUPPRESSION_KEYS = Object.freeze(['continue-on-error']);

/**
 * Remove YAML comments without stripping a `#` inside balanced quotes.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function stripYamlComments(source) {
  return String(source ?? '')
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line)) return '';
      let out = line;
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== '#') continue;
        if (i > 0 && !/\s/.test(line[i - 1])) continue;
        const before = line.slice(0, i);
        const singles = (before.match(/'/g) ?? []).length;
        const doubles = (before.match(/"/g) ?? []).length;
        if (singles % 2 === 0 && doubles % 2 === 0) {
          out = before.trimEnd();
          break;
        }
      }
      return out;
    });
}

/**
 * @param {string} source workflow YAML
 * @returns {{code: string, level: 'error', line: number, key: string, message: string}[]}
 */
export function findSuppressionKeys(source) {
  const findings = [];
  const lines = stripYamlComments(source);
  for (const [i, line] of lines.entries()) {
    for (const key of ERROR_SUPPRESSION_KEYS) {
      if (new RegExp(`(^|\\s)${key}\\s*:`).test(line)) {
        findings.push({
          code: 'SUPPRESSION',
          level: 'error',
          line: i + 1,
          key,
          message: `line ${i + 1} carries \`${key}\`, which makes GitHub report a failing step as green.`,
        });
      }
    }
  }
  return findings;
}

/**
 * Extract the repository/ref pair from each named gate checkout.
 *
 * @param {string} source workflow YAML
 * @returns {{repository?: string, ref?: string}[]}
 */
export function gateCheckoutContexts(source) {
  const lines = String(source ?? '').split('\n');
  const checkouts = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== '- name: Checkout coverage gate scripts') continue;
    let end = index + 1;
    while (end < lines.length && !/^ {6}- name: /.test(lines[end])) end++;
    const block = lines.slice(index, end).join('\n');
    checkouts.push({
      repository: block.match(/^ {10}repository: (.+?)\s*$/m)?.[1],
      ref: block.match(/^ {10}ref: (.+?)\s*$/m)?.[1],
    });
  }
  return checkouts;
}

/**
 * @param {string} source workflow YAML
 * @param {number} expectedCount
 * @returns {{code: string, level: 'error', message: string}[]}
 */
export function inspectGateCheckoutIdentity(source, expectedCount = 2) {
  const findings = [];
  const checkouts = gateCheckoutContexts(source);
  if (checkouts.length !== expectedCount) {
    findings.push({
      code: 'GATE-CHECKOUT-COUNT',
      level: 'error',
      message: `expected ${expectedCount} gate-script checkouts, found ${checkouts.length}`,
    });
  }
  for (const [index, checkout] of checkouts.entries()) {
    if (checkout.repository !== WORKFLOW_REPOSITORY_EXPRESSION) {
      findings.push({
        code: 'GATE-CHECKOUT-REPOSITORY',
        level: 'error',
        message: `gate checkout ${index + 1} must use ${WORKFLOW_REPOSITORY_EXPRESSION}`,
      });
    }
    if (checkout.ref !== WORKFLOW_SHA_EXPRESSION) {
      findings.push({
        code: 'GATE-CHECKOUT-REF',
        level: 'error',
        message: `gate checkout ${index + 1} must use ${WORKFLOW_SHA_EXPRESSION}`,
      });
    }
  }
  return findings;
}
