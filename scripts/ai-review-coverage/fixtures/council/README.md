# Council replay fixtures (EHAC-2231)

Current-schema coverage records, one per council outcome, replayed through the **real**
`assert-review-coverage.mjs` CLI by `assert-review-coverage.test.mjs`. Both the exit code and
the reason token are asserted, because an exit code alone does not say the red was attributable
to the thing under test — a U7 firing for an unrelated reason would look identical to a U8.

| Fixture | Tolerance | Expected |
|---|---|---|
| `healthy-council.json` | 1 | exit 0, `COMPLETE`, no degraded warning |
| `failover-succeeded.json` | 1 | exit 0, `COMPLETE`, no degraded warning — the `tests` lens stalled on flash and succeeded on pro, so the LOGICAL run succeeded |
| `one-reviewer-degraded.json` | 1 | exit 0 + `::warning::` naming `tests`; **exit 1 with `U7` at tolerance 0** |
| `tolerance-breached.json` | 1 | exit 1, `U7`, "above the tolerance of 1" |
| `validator-failed.json` | 1 | exit 1, `U7`, validator role failed |
| `zero-runs.json` | 1 | exit 1, `U5` — zero runs with no allowlisted skip reason |
| `policy-mismatch.json` | 0 | exit 1, `U8` — producer was given 1, gate was given 0 |

**These are NOT old production records.** An old record is still useful for demonstrating U1 pin
drift, and it stays useful for exactly that, but it cannot be acceptance evidence for the current
policy: it predates `models.policy`, `models.attempts` and the per-run failure classes, so a
green against it would only prove the gate tolerates their absence. Hand-editing an old record's
`elek.ref` to dodge U1 is worse again — it manufactures a record that never existed.

Regenerate by hand when the schema moves. `elek.ref` must equal `ELEK_REF_VERIFIED`, which is
read from `vendor/diff-context.manifest.json`; a fixture left at an older ref fails U1 first and
masks everything the fixture was written to prove.
