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

- #11 engine: 203 passed, including 14 real scanner integration cases. Safe/risky Python, Java, JavaScript and TypeScript produce ALLOW/DENY; a Java project without Compose reaches image planning with an existing Dockerfile. Invalid Java also blocks image planning before Docker/LLM calls.
- #12 additionally verifies real scanner → architecture create → select → resolve, then changing the source to a dangerous eval causes DENY. This tests the rule path without LLM or AWS.
- Gate regression after the Java parser fix: **424 passed, 1 skipped**, including real Semgrep/Gitleaks. The skip is Windows-profile handling on macOS. Both previously failing Java syntax cases pass without changing their expected SCAN_FAILED result.
- Existing Java board: REVIEW (exit 2), Compose NOT_APPLICABLE, Java+JavaScript 30 files scanned; Gitleaks ALLOW, validated wrapper JAR excluded (1). Remaining coverage gaps: EXTERNAL_SCRIPT_REFERENCE and TEMPLATE_EXPRESSION. The engine must continue to block it.

## Java syntax regression and fix

Before the fix, both real tests expected SCAN_FAILED for `class Broken { void broken( {`, but Semgrep 1.180.0 returned ALLOW through the merged adapter:

- `tests/test_java_support.py::test_real_java_cli_scenarios[invalid-SCAN_FAILED-3]`
- `tests/test_semgrep_real.py::test_real_java_parse_error_is_scan_failed`

Reproduce from `apps/security-gate` with `.venv/bin/python -m pytest tests/test_java_support.py tests/test_semgrep_real.py -q` after installing both tools. The tests were not weakened or removed. Disabling Semgrep optimizations did not fix the behavior, so that attempted flag change was discarded. The fix adds open-source Tree-sitter 0.25.2 + tree-sitter-java 0.23.5 (MIT), using root_node.has_error in an isolated, time-bounded process before Semgrep. No target compilation, dependency resolution or execution occurs. Missing parser/crash/timeout fails closed. Engine and gate requirements both install the pinned packages. Do not treat ALLOW as a compilation or complete security guarantee.

The previous blanket “Python-only / absent Compose blocks / any wrapper binary fails” description is obsolete for #25. Unsupported source/template coverage remains a blocker; the two Java syntax regressions are now fixed. No actual AWS redeployment was performed for this integration revision.

Additional parser checks cover missing braces, invalid assignments, unavailable classpath dependencies, records, sealed classes, switch expressions, no static initializer execution, missing parser and shared Python/Java timeout budget. Tested on macOS with scanner Python 3.12.13 and engine Python 3.14.5; Windows was not executed. Grammar support is bounded by the pinned libraries. The later multi-language update below adds JS/TS preflight.

## Multi-language parser extension

Reuses pinned upstream Tree-sitter grammars for JavaScript/JSX, TypeScript/TSX, Go, Rust, C/C++, C#, Ruby and PHP. Python keeps ast.parse and Java keeps tree-sitter-java. No custom grammar or target execution is introduced.

Discovery collects syntax-only languages under the existing size/link/total limits. They remain unsupported for Semgrep security rules, so valid syntax yields REVIEW and invalid syntax yields SCAN_FAILED; neither permits image building or deployment. Scanned-file counters continue to describe security-rule coverage. Mixed repositories cannot hide these unsupported files.

Extracted HTML/SVG scripts/handlers use their effective JS/TS suffix. A dynamic template expression that is not valid JavaScript now produces SCAN_FAILED while retaining its coverage gap. Headers ending .h accept either C or C++ syntax. New/preview language constructs outside pinned grammar support can still fail.

Language/extension fixtures cover valid and invalid inputs, JSX/TSX and TypeScript angle assertions, PHP with HTML, C/C++ headers, extraction failures, mixed supported/unsupported sources and input size limits. Engine integration checks JS/TS syntax failure and valid/invalid Go never being approved. No AWS resources were created.

Latest validation: gate 424 passed / 1 Windows-only skip; #11 engine 203 passed. The new language suite contributes 72 real-parser/contract cases. Python 3.12 scanner and Python 3.14 engine environments both have pinned grammar dependencies installed.

## Go / Rust security-rule extension

Go and Rust are no longer syntax-only. Three unchanged, pinned upstream rules are included: patched-codes/gosec-derived dynamic executable and constructed SQL (MIT repository with Apache-2.0 file notices), and Trail of Bits Result-function unwrap/expect audit (AGPL-3.0). Licenses, source commits and hashes are under semgrep_rules/vendor. The gate's schema recognizes their original IDs and sanitized reason codes. An audit finding is treated as DENY for review; absence of findings is only a limited-rule ALLOW, not comprehensive security certification. C/C++/C#/Ruby/PHP remain syntax-only REVIEW.

Validation: gate suite 426 passed / 1 Windows-only skip, plus the separately added provenance/hash test passed (427 passing cases total). Real scanner safe/risky Go/Rust and SQL parameterization comparison passed. Engine #11: 207 passed, including real Go/Rust gate contracts. No Docker build, AWS deployment or target execution in these checks.
