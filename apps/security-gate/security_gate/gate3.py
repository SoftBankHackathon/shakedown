"""Opt-in version 3 integration, preserving the version 1 and 2 paths."""
from .gate import scan_repository
from .gitleaks import scan_gitleaks
from .models import REASON_CODES, combine_decisions


def scan_full_repository(target, *, docker_timeout_seconds=5.0, semgrep_timeout_seconds=30.0,
                         gitleaks_timeout_seconds=30.0, max_file_bytes=1024 * 1024,
                         semgrep_runner=None, gitleaks_runner=None):
    previous = scan_repository(target, docker_timeout_seconds=docker_timeout_seconds,
                               semgrep_timeout_seconds=semgrep_timeout_seconds,
                               max_file_bytes=max_file_bytes, semgrep_runner=semgrep_runner)
    secrets = scan_gitleaks(target, timeout_seconds=gitleaks_timeout_seconds,
                           max_file_bytes=max_file_bytes, runner=gitleaks_runner)
    decision = combine_decisions([previous["decision"], secrets["decision"]])
    return {"schema_version": "3.0", "scope": "docker_semgrep_and_gitleaks_text_secrets",
            "target_path": previous["target_path"], "decision": decision,
            "scan_status": "FAILED" if decision == "SCAN_FAILED" else "SUCCESS",
            "reason_code": REASON_CODES[decision],
            "docker_compose": previous["docker_compose"], "semgrep": previous["semgrep"],
            "gitleaks": secrets, "findings": previous["findings"] + secrets["findings"]}
