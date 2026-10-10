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
        status, decision = "NOT_APPLICABLE", "REVIEW"
    else:
        status = "SUCCESS"
        decision = next((d for d in ("DENY", "REVIEW")
                         if any(f["decision"] == d for f in files)), "ALLOW")
    return {
        "schema_version": "1.0", "scope": SCOPE, "target_path": str(target),
        "scan_status": status, "decision": decision, "files": files,
        "errors": [error] if error else [],
    }


# Aggregators combine tool decisions by severity; the first present wins.
DECISION_ORDER = ("SCAN_FAILED", "DENY", "REVIEW", "ALLOW")
REASON_CODES = {"SCAN_FAILED": "REQUIRED_SCAN_FAILED", "DENY": "RISK_DETECTED",
                "REVIEW": "REVIEW_REQUIRED", "ALLOW": "ALL_APPLICABLE_CHECKS_PASSED"}


def combine_decisions(decisions):
    present = set(decisions)
    return next(value for value in DECISION_ORDER if value in present)
