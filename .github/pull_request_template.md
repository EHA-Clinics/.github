## Summary

<!-- What reusable-workflow behavior changes, and why? -->

## Contract impact

- [ ] Workflow inputs, outputs, permissions, and job names remain compatible or the change is documented
- [ ] Third-party actions and Elek are pinned to immutable 40-character commit SHAs
- [ ] Elek pin, vendor manifest, council fixtures, goldens, and truncation proof agree
- [ ] AI review remains advisory and no branch-protection requirement is introduced

## Verification

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm test`
- [ ] A deliberate bad fixture fails for the intended reason
- [ ] A known-good fixture passes
- [ ] Live canary URL added below, or marked pending until the PR commit is remotely available

Canary: <!-- URL or pending reason -->

## Rollout and rollback

<!-- List caller pin order, observable success signals, and the preceding known-good SHA. -->
