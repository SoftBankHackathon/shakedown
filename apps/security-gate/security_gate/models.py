"""JSON-compatible report contract and fail-closed aggregation."""
RULE_ID = "DOCKER_COMPOSE_PRIVILEGED"
SCOPE = "docker_compose_privileged_only"


class ScanError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def file_result(path, decision, findings=None, error=None):
    return {
        "file_path": str(path), "decision": decision,
        "findings": findings or [], "error": error,
    }


def report(target, files=None, error=None):
    files = files or []
    if error or any(f["decision"] == "SCAN_FAILED" for f in files):
        status, decision = "FAILED", "SCAN_FAILED"
    elif not files:
        status, decision = "NOT_APPLICABLE", "ALLOW"
    else:
        status, decision = "SUCCESS", combine_decisions(f["decision"] for f in files)
    return {
        "schema_version": "1.0", "scope": SCOPE, "target_path": str(target),
        "scan_status": status, "decision": decision, "files": files,
        "errors": [error] if error else [],
    }


# Aggregators combine tool decisions by severity; the first present wins.
# 결과는 통과(ALLOW) 아니면 차단(DENY·SCAN_FAILED)이다. 사람이 판단할 중간 상태는 두지 않는다.
DECISION_ORDER = ("SCAN_FAILED", "DENY", "ALLOW")


def reason_code(decision, findings):
    """근거 없는 DENY는 Semgrep block_reasons(검사할 수 없는 소스)뿐이다. 스키마가 이 짝을 강제한다."""
    if decision == "DENY":
        return "RISK_DETECTED" if findings else "UNSUPPORTED_SOURCE"
    return {"SCAN_FAILED": "REQUIRED_SCAN_FAILED", "ALLOW": "ALL_APPLICABLE_CHECKS_PASSED"}[decision]


def combine_decisions(decisions):
    present = set(decisions)
    return next(value for value in DECISION_ORDER if value in present)
