# Vendored security rules

Rules are preserved unmodified, including original IDs/messages. Source commits and SHA-256 hashes are recorded in manifest.json. Runtime scanning uses these local files, never remote configuration.

- patched-codes/semgrep-rules: repository MIT; selected Go rules explicitly credit gosec under Apache-2.0. Both license texts and source headers are retained.
- trailofbits/semgrep-rules: AGPL-3.0. The Rust audit rule is retained as a separate file with its full license and source link; it detects unwrap/expect in Result-returning functions, not all Rust vulnerabilities. Keep these notices and the rule source when distributing the scanner.

Selected Go checks: dynamic process executable and constructed SQL queries. Selected Rust check: panic-prone Result handling (audit finding, not proof of exploitable code). This gate maps selected findings to DENY for review; limited rule coverage is not a guarantee of safety. No dependency vulnerability database is included.
