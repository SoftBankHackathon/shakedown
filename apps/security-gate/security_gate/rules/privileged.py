"""STEP 1 rule: Docker Compose services.*.privileged."""
from ..models import RULE_ID, ScanError
from ..parsing import mapping_value


def check(data, root, file_path):
    if not isinstance(data, dict) or not isinstance(data.get("services"), dict):
        raise ScanError("INVALID_COMPOSE_STRUCTURE")
    if not data["services"]:
        raise ScanError("NO_SERVICES_TO_CHECK")
    findings = []
    services_node = mapping_value(root, "services")
    for service, config in data["services"].items():
        if not isinstance(service, str) or not service or not isinstance(config, dict):
            raise ScanError("INVALID_SERVICE_STRUCTURE")
        if len(service) > 256:
            raise ScanError("SERVICE_NAME_LIMIT_EXCEEDED")
        if "privileged" not in config or config["privileged"] is False:
            continue
        value = config["privileged"]
        # Quoted true denies, and so does any value that cannot be resolved statically (e.g. ${VAR}).
        enabled = value is True or (isinstance(value, str) and value.strip().lower() == "true")
        node = mapping_value(mapping_value(services_node, service), "privileged")
        findings.append({
            "decision": "DENY", "file_path": str(file_path),
            "service": service, "rule_id": RULE_ID,
            "reason_code": "PRIVILEGED_ENABLED" if enabled else "PRIVILEGED_UNRESOLVED",
            "location": {"line": node.start_mark.line + 1,
                         "column": node.start_mark.column + 1,
                         "path": ["services", service, "privileged"]},
        })
    return findings
