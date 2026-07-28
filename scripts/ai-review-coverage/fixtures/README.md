# AI review coverage — test fixtures

Every fixture in this directory is a **real, verbatim `git diff`**. None is hand-written or
hand-trimmed. The gate they exercise (EHAC-2057) exists because a green check was mistaken for
coverage, so its own proof of failability must not be a mock.

Measurement rule that applies to every row below: character counts are
`fs.readFileSync(path, 'utf8').length` (UTF-16 code units, which is what elek's
`String.slice`/`String.length` operates on). **Never `wc -c`.** The byte column is recorded only
to make the divergence visible.

| Fixture | utf8 units | bytes | real file headers | naive `diff --git` occurrences |
|---|---:|---:|---:|---:|
| `pr-3515.diff` | 137,015 | 137,552 | 15 | 15 |
| `small-complete.diff` | 14,599 | 14,639 | 2 | 2 |
| `embedded-diff-header.diff` | 26,048 | 26,128 | **2** | **7** |

---

## `pr-3515.diff` — the truncating fixture (the gate's proof of failability)

The diff of **`EHA-Clinics/eha_care` PR #3515** (EHAC-1986, tenant isolation), the PR on which
`AI Review (Council)` reported *"No high-confidence issues survived cross-check validation"*
while the entire 298-line `src/common/services/tenantRoster.ts` tenant-isolation primitive sat
outside the model's prompt window — and the PR author's own prose was substituted as evidence
in its place.

Generated from **SHAs, not branch names**, so it survives branch deletion:

```bash
# run in the eha_care checkout
git -c core.autocrlf=false -c diff.noprefix=false \
    diff f803c66642365d7d6710c55679c5185d827d8900...9a95ce41d874f87039428fed12ce64b9f39266cb \
  > scripts/ai-review-coverage/fixtures/pr-3515.diff
```

* base: `v2` @ `f803c66642365d7d6710c55679c5185d827d8900`
* head: `feat/EHAC-1986-tenant-isolation` @ `9a95ce41d874f87039428fed12ce64b9f39266cb`
* three-dot (merge-base) form and the two explicit `-c` git settings reproduce exactly what
  elek's `getGitDiff` emits (`git diff origin/<base>...origin/<head>`).

**Measured on the committed file:** 137,015 utf8 units / 137,552 bytes / 15 file sections.
The 537-unit skew is the trap: `wc -c` reports the byte figure, and a gate that is 0.9% off at a
budget boundary produces the flaky red that gets `continue-on-error` added six weeks later.

**Evidence trail:** council run
[`actions/runs/30343932186`](https://github.com/EHA-Clinics/eha_care/actions/runs/30343932186)
(verbatim `[size] changed_lines=2432 strategy=council max_council_changed_lines=1200; downgrading
to crosscheck.` → `execution_strategy=crosscheck`); manual review `#4797970624`; PR #3515.

**What the gate must conclude from it:** verdict `PARTIAL_SOURCE`, with
`apps/ehacare/frontend/src/common/services/tenantRoster.ts` PARTIAL (`shownChars < patchChars`),
and a non-zero `assert-review-coverage.mjs` exit. The verdict string is asserted exactly, so the
red is attributable to real truncation and never to an `UNKNOWN` shortcut.

---

## `small-complete.diff` — the green control

A real, small diff from this repository's own history:

```bash
# run in the EHA-Clinics/.github checkout
git -c core.autocrlf=false -c diff.noprefix=false \
    diff 0edf64a b7765ffbe390a064a3938141264115efef00e736 \
  > scripts/ai-review-coverage/fixtures/small-complete.diff
```

14,599 utf8 units over 2 files. Overview + full diff stays under elek's
`DEFAULT_FULL_DIFF_THRESHOLD_CHARS = 80_000`, so v1.1.4 inlines the whole diff and every file is
`WHOLE` ⇒ verdict `COMPLETE`, exit 0. Without this control a gate that reds on everything would
look identical to a gate that works.

---

## `embedded-diff-header.diff` — the anchored-regex control

A real, path-scoped diff of the `eha_care` commit
`07d0c71fe034885358c1d683c3945f165803516a` ("chore: archive v1.9.1 milestone files"), narrowed
to two archived `*-SUMMARY.md` files whose **content** quotes unified diffs:

```bash
# run in the eha_care checkout
git -c core.autocrlf=false -c diff.noprefix=false \
    diff 07d0c71fe034885358c1d683c3945f165803516a^ 07d0c71fe034885358c1d683c3945f165803516a \
    -- ".planning/milestones/v1.9.1-phases/05.8.1-drive-bettercare-staging-argocd-application-back-to-synced-o/05.8.1-01-SUMMARY.md" \
       ".planning/milestones/v1.9.1-phases/21-ehac-1443-docker-secret-remediation-plan/21-07-SUMMARY.md" \
  > scripts/ai-review-coverage/fixtures/embedded-diff-header.diff
```

It contains **2** real file headers and **7** occurrences of the string `diff --git` — the other
five are *added lines* (`+diff --git a/… b/…`) inside the archived summaries. A
`grep -c 'diff --git'` style count reports 7 and silently over-splits the file inventory. The
anchored multiline regex `/^diff --git .+$/gm` — elek's own regex, verbatim — reports 2.

Using elek's exact regex is deliberate: a gate that disagrees with the tool it audits produces
false reds and gets disabled. Where both are wrong, they are wrong the same way.

---

## Regenerating a fixture

Do **not** hand-edit these files. Re-run the command recorded above, then update the measured
figures in the table and in `measure-review-coverage.test.mjs` from the **committed** file — never
carry a predicted number forward.
