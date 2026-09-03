import { describe, expect, it } from 'vitest';

import {
  WORKFLOW_REPOSITORY_EXPRESSION,
  WORKFLOW_SHA_EXPRESSION,
  findSuppressionKeys,
  gateCheckoutContexts,
  inspectGateCheckoutIdentity,
  stripYamlComments,
} from './gate-ref-identity.mjs';

const checkout = (repository = WORKFLOW_REPOSITORY_EXPRESSION, ref = WORKFLOW_SHA_EXPRESSION) => `
      - name: Checkout coverage gate scripts
        uses: actions/checkout@${'a'.repeat(40)}
        with:
          repository: ${repository}
          ref: ${ref}
          sparse-checkout: scripts/ai-review-coverage
`;

const workflow = (first = checkout(), second = checkout()) => `name: AI review
jobs:
  review:
    steps:${first}
  coverage:
    steps:${second}
`;

describe('gate checkout identity', () => {
  it('accepts both checkouts at the called workflow repository and immutable SHA', () => {
    expect(gateCheckoutContexts(workflow())).toEqual([
      { repository: WORKFLOW_REPOSITORY_EXPRESSION, ref: WORKFLOW_SHA_EXPRESSION },
      { repository: WORKFLOW_REPOSITORY_EXPRESSION, ref: WORKFLOW_SHA_EXPRESSION },
    ]);
    expect(inspectGateCheckoutIdentity(workflow())).toEqual([]);
  });

  it('reports a floating or hand-maintained ref', () => {
    const findings = inspectGateCheckoutIdentity(workflow(checkout(undefined, 'main')));
    expect(findings.map((finding) => finding.code)).toContain('GATE-CHECKOUT-REF');
  });

  it('reports a hard-coded repository', () => {
    const findings = inspectGateCheckoutIdentity(workflow(checkout('EHA-Clinics/.github')));
    expect(findings.map((finding) => finding.code)).toContain('GATE-CHECKOUT-REPOSITORY');
  });

  it('reports a missing checkout instead of treating zero observations as agreement', () => {
    expect(inspectGateCheckoutIdentity('name: unrelated')).toEqual([
      expect.objectContaining({ code: 'GATE-CHECKOUT-COUNT' }),
    ]);
  });
});

describe('error-suppression checks', () => {
  it('reports a real suppression key', () => {
    expect(findSuppressionKeys('steps:\n  continue-on-error: true\n')).toEqual([
      expect.objectContaining({ code: 'SUPPRESSION', key: 'continue-on-error' }),
    ]);
  });

  it('ignores comments and quoted text', () => {
    expect(findSuppressionKeys('# continue-on-error: true\n')).toEqual([]);
    expect(findSuppressionKeys("name: 'no continue-on-error here'\n")).toEqual([]);
    expect(stripYamlComments("name: 'a # value' # note\n")[0]).toBe("name: 'a # value'");
  });
});
