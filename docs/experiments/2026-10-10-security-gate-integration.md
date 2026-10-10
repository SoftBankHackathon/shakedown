# Merged Security Gate integration — 2026-10-10

Baseline: main `de3261d` (PR #25, including #26); PR #11 remains the base of #12.

## Engine adjustments

- Validate the bundled v3 schemas with local-only reference resolution. Malformed or contradictory ALLOW responses fail closed.
- Accept Docker REVIEW/NOT_APPLICABLE only with no files/errors, alongside overall ALLOW/SUCCESS and successful Semgrep/Gitleaks. No generic REVIEW bypass.
- Preserve source/secret coverage validation, including unsupported source counts and required scan results.
- Canonicalize the engine-owned temporary snapshot directory on macOS (`/var` aliases `/private/var`). User input paths and scanner link rejection remain unchanged.
- Carry these changes into image planning/build and architecture create/select/resolve. No cloud resources were created.

## Observed validation

Installed project-local Semgrep 1.180.0 and official Gitleaks 8.30.0; verified the release archive checksum. Tools and temporary files are ignored by Git.

- #11 engine: 198 passed, including 9 real scanner integration cases. Safe/risky Python, Java, JavaScript and TypeScript produce ALLOW/DENY; a Java project without Compose reaches image planning with an existing Dockerfile. No Docker or LLM call in these checks.
- #12 additionally verifies real scanner → architecture create → select → resolve, then changing the source to a dangerous eval causes DENY. This tests the rule path without LLM or AWS.
- Gate regression: **340 passed, 2 failed, 1 skipped**. The skip is Windows-profile handling on macOS. This is not an all-green gate regression.
- Existing Java board: REVIEW (exit 2), Compose NOT_APPLICABLE, Java+JavaScript 30 files scanned; Gitleaks ALLOW, validated wrapper JAR excluded (1). Remaining coverage gaps: EXTERNAL_SCRIPT_REFERENCE and TEMPLATE_EXPRESSION. The engine must continue to block it.

## Unresolved upstream scanner failures

Both real tests expect SCAN_FAILED for `class Broken { void broken( {`, but Semgrep 1.180.0 returns ALLOW through the merged adapter:

- `tests/test_java_support.py::test_real_java_cli_scenarios[invalid-SCAN_FAILED-3]`
- `tests/test_semgrep_real.py::test_real_java_parse_error_is_scan_failed`

Reproduce from `apps/security-gate` with `.venv/bin/python -m pytest tests/test_java_support.py tests/test_semgrep_real.py -q` after installing both tools. The tests were not weakened or removed. Disabling Semgrep optimizations did not fix the behavior, so that attempted flag change was discarded. Resolving this requires scanner/parser coverage work; do not treat schema-valid ALLOW as a compilation or complete security guarantee.

The previous blanket “Python-only / absent Compose blocks / any wrapper binary fails” description is obsolete for #25. Unsupported coverage and the two real parse failures above remain distinct blockers. No actual AWS redeployment was performed for this integration revision.
