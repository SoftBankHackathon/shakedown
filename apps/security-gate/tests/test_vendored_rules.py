"""Pinned third-party rule provenance and offline execution contract."""
import hashlib
import json

from security_gate import semgrep


def test_vendored_rules_match_recorded_upstream_bytes():
    root = semgrep.PROJECT_ROOT / 'semgrep_rules/vendor'
    manifest = json.loads((root / 'manifest.json').read_text())
    for entry in manifest:
        assert hashlib.sha256((root / entry['file']).read_bytes()).hexdigest() == entry['sha256']
        assert len(entry['url'].split('/blob/')[1].split('/')[0]) == 40
    recorded = {(root / entry['file']).resolve() for entry in manifest}
    assert all(path.resolve() in recorded for path in (*semgrep.GO_RULE_FILES, semgrep.RUST_RULE_FILE))
