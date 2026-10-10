"""Version 2 aggregate, preserving the entire version 1 Docker report."""
from .models import REASON_CODES, combine_decisions
from .scanner import scan
from .semgrep import scan_semgrep


def scan_repository(target, *, docker_timeout_seconds=5.0, semgrep_timeout_seconds=30.0,
                    max_file_bytes=1024 * 1024, semgrep_runner=None):
    docker = scan(target, timeout_seconds=docker_timeout_seconds, max_file_bytes=max_file_bytes)
    semgrep = scan_semgrep(target, timeout_seconds=semgrep_timeout_seconds,
                          max_file_bytes=max_file_bytes, runner=semgrep_runner)
    decisions = [semgrep["decision"]]
    if docker["scan_status"] != "NOT_APPLICABLE":
        decisions.append(docker["decision"])
    decision = combine_decisions(decisions)
    findings = []
    for file in docker["files"]:
        for item in file["findings"]:
            findings.append({"tool": "docker_compose", "rule_id": item["rule_id"],
                             "severity": "HIGH" if item["decision"] == "DENY" else "UNKNOWN",
                             "file_path": item["file_path"], "line": item["location"]["line"],
                             "decision": item["decision"], "reason_code": item["reason_code"]})
    findings.extend(semgrep["findings"])
    return {
        "schema_version": "2.0", "scope": "docker_compose_privileged_and_semgrep_multilanguage_mvp",
        "target_path": docker["target_path"], "decision": decision,
        "scan_status": "FAILED" if decision == "SCAN_FAILED" else "SUCCESS",
        "reason_code": REASON_CODES[decision],
        "docker_compose": docker, "semgrep": semgrep, "findings": findings,
    }
