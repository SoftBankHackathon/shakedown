"""Offline local-rule Semgrep adapter with an injectable CLI runner."""
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

from .discovery import validate_target
from .models import ScanError
from .parsing import read_bounded
from .source_targets import sources
from .source_syntax import validate_sources

PROJECT_ROOT = Path(__file__).resolve().parents[1]
RULE_FILE = PROJECT_ROOT / "semgrep_rules" / "python-security.yml"
RULES = {
    "security-gate-python-eval": ("HIGH", "PYTHON_DYNAMIC_EVAL"),
    "security-gate-python-shell-true": ("HIGH", "PYTHON_SHELL_EXECUTION"),
}
DEFAULT_TIMEOUT_SECONDS = 30.0
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_STDERR_BYTES = 1024 * 1024
MAX_FINDINGS = 1000


def result(target, *, findings=None, error=None, applicable=True, scanned=0):
    findings = findings or []
    return {
        "tool": "semgrep", "scope": "local_python_mvp_rules",
        "target_path": str(target),
        "scan_status": "FAILED" if error else "SUCCESS" if applicable else "NOT_APPLICABLE",
        "decision": "SCAN_FAILED" if error else "DENY" if findings else "ALLOW" if applicable else "REVIEW",
        "findings": findings, "errors": [error] if error else [], "scanned_files": scanned,
    }


def find_executable():
    # Prefer the scanner's installed dependency, never a target's executable.
    directory = PROJECT_ROOT / ".venv" / ("Scripts" if os.name == "nt" else "bin")
    executable = directory / ("semgrep.exe" if os.name == "nt" else "semgrep")
    if executable.is_file():
        return str(validate_target(executable))
    return None


def environment(snapshot):
    allowed = {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"}
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    env.update({
        "HOME": str(snapshot), "USERPROFILE": str(snapshot), "APPDATA": str(snapshot / ".config"),
        "LOCALAPPDATA": str(snapshot / ".cache"), "XDG_CONFIG_HOME": str(snapshot / ".config"),
        "XDG_CACHE_HOME": str(snapshot / ".cache"), "TMPDIR": str(snapshot),
        "TEMP": str(snapshot), "TMP": str(snapshot),
        "SEMGREP_SETTINGS_FILE": str(snapshot / "settings.yml"),
        "SEMGREP_ENABLE_VERSION_CHECK": "0", "SEMGREP_SEND_METRICS": "off",
        "PYTHONUTF8": "1", "PYTHONNOUSERSITE": "1",
    })
    return env


def _stop(process, cwd):
    if os.name == "nt":
        # Semgrep spawns a core process; stop its whole process tree on timeout.
        taskkill = Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32" / "taskkill.exe"
        try:
            subprocess.run([str(taskkill), "/PID", str(process.pid), "/T", "/F"],
                           cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=2, creationflags=subprocess.CREATE_NO_WINDOW, shell=False)
        except (OSError, subprocess.TimeoutExpired):
            pass
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.kill()
    process.wait(timeout=2)


def run_cli(command, *, cwd, env, timeout):
    """Spool raw output temporarily, limit its size, and terminate timed-out scans."""
    with tempfile.TemporaryFile(dir=cwd) as stdout, tempfile.TemporaryFile(dir=cwd) as stderr:
        process = subprocess.Popen(
            command, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
            shell=False, start_new_session=os.name != "nt",
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        deadline = time.monotonic() + timeout
        try:
            while True:
                if (os.fstat(stdout.fileno()).st_size > MAX_OUTPUT_BYTES
                        or os.fstat(stderr.fileno()).st_size > MAX_STDERR_BYTES):
                    raise ScanError("SEMGREP_OUTPUT_LIMIT_EXCEEDED")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(command, timeout)
                try:
                    process.wait(timeout=min(remaining, 0.05))
                    break
                except subprocess.TimeoutExpired:
                    continue
            stdout.seek(0)
            data = stdout.read(MAX_OUTPUT_BYTES + 1)
            if len(data) > MAX_OUTPUT_BYTES or os.fstat(stderr.fileno()).st_size > MAX_STDERR_BYTES:
                raise ScanError("SEMGREP_OUTPUT_LIMIT_EXCEEDED")
            return subprocess.CompletedProcess(command, process.returncode, data, b"")
        finally:
            if process.poll() is None:
                _stop(process, cwd)


def _mapped_path(raw, snapshot, mapping):
    if not isinstance(raw, str):
        raise ScanError("SEMGREP_INVALID_RESULT")
    path = Path(raw)
    path = Path(os.path.abspath(path if path.is_absolute() else snapshot / path))
    if path.parent != snapshot or path.name not in mapping:
        raise ScanError("SEMGREP_UNEXPECTED_RESULT_PATH")
    return mapping[path.name]


def _normalize(payload, snapshot, mapping):
    if (not isinstance(payload, dict) or not isinstance(payload.get("results"), list)
            or not isinstance(payload.get("errors"), list)
            or not isinstance(payload.get("paths"), dict)
            or not isinstance(payload["paths"].get("scanned"), list)):
        raise ScanError("SEMGREP_INVALID_RESULT")
    if len(payload["results"]) > MAX_FINDINGS:
        raise ScanError("SEMGREP_FINDING_LIMIT_EXCEEDED")
    findings = []
    for item in payload["results"]:
        if not isinstance(item, dict) or item.get("check_id") not in RULES:
            raise ScanError("SEMGREP_UNKNOWN_RULE")
        original = _mapped_path(item.get("path"), snapshot, mapping)
        start = item.get("start")
        if not isinstance(start, dict) or type(start.get("line")) is not int or start["line"] < 1:
            raise ScanError("SEMGREP_INVALID_RESULT")
        severity, reason = RULES[item["check_id"]]
        # Do not forward extra.message, lines, metavars, traces, stdout, or stderr.
        findings.append({"tool": "semgrep", "rule_id": item["check_id"], "severity": severity,
                         "file_path": str(original), "line": start["line"],
                         "decision": "DENY", "reason_code": reason})
    scanned = {_mapped_path(path, snapshot, mapping) for path in payload["paths"]["scanned"]}
    error = "SEMGREP_SCAN_ERRORS" if payload["errors"] else None
    if scanned != set(mapping.values()):
        error = "SEMGREP_INCOMPLETE_SCAN"
    return findings, error, len(scanned)


def scan_semgrep(target, *, timeout_seconds=DEFAULT_TIMEOUT_SECONDS,
                 max_file_bytes=1024 * 1024, runner=None):
    """Inspect source data using bundled rules. A fake runner can test all outcomes."""
    try:
        target = os.path.abspath(os.fspath(target))
    except (TypeError, ValueError):
        return result("", error="INVALID_PATH")
    if (type(timeout_seconds) not in (int, float) or not math.isfinite(timeout_seconds)
            or not 0 < timeout_seconds <= 120 or type(max_file_bytes) is not int
            or not 1 <= max_file_bytes <= 16 * 1024 * 1024):
        return result(target, error="INVALID_SCAN_LIMITS")
    deadline = time.monotonic() + timeout_seconds
    try:
        root, inputs = sources(target, max_file_bytes)
        if not inputs:
            return result(root, applicable=False)
        validate_sources(inputs, timeout_seconds=deadline - time.monotonic())
        executable = find_executable()
        if executable is None and runner is None:
            return result(root, error="SEMGREP_NOT_INSTALLED")
        validate_target(RULE_FILE)
        read_bounded(RULE_FILE, 64 * 1024)
        temporary_root = PROJECT_ROOT / ".tmp"
        temporary_root.mkdir(exist_ok=True)
        validate_target(temporary_root)
        with tempfile.TemporaryDirectory(prefix="semgrep-", dir=temporary_root) as temporary:
            snapshot = Path(temporary)
            mapping = {}
            for index, (original, source) in enumerate(inputs):
                name = f"source_{index:04d}.py"
                (snapshot / name).write_text(source, encoding="utf-8", newline="")
                mapping[name] = original
            (snapshot / ".semgrepignore").write_text("", encoding="utf-8")
            command = [executable or "mock-semgrep", "scan", "--config", str(RULE_FILE),
                       "--json", "--error", "--strict", "--oss-only", "--metrics", "off",
                       "--disable-version-check", "--disable-nosem", "--no-git-ignore",
                       "--no-rewrite-rule-ids", "--no-secrets-validation", "--jobs", "1",
                       "--timeout", "5", "--timeout-threshold", "1", "--max-memory", "256",
                       "--max-target-bytes", str(max_file_bytes), "--", *mapping]
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout_seconds)
            completed = (runner or run_cli)(command, cwd=snapshot, env=environment(snapshot), timeout=remaining)
            if completed.returncode not in (0, 1):
                return result(root, error="SEMGREP_EXECUTION_FAILED")
            if len(completed.stdout) > MAX_OUTPUT_BYTES:
                raise ScanError("SEMGREP_OUTPUT_LIMIT_EXCEEDED")
            try:
                payload = json.loads(completed.stdout)
            except (ValueError, UnicodeError):
                return result(root, error="SEMGREP_INVALID_JSON")
            findings, error, scanned = _normalize(payload, snapshot, mapping)
            if completed.returncode == 1 and not findings:
                error = error or "SEMGREP_EXECUTION_FAILED"
            return result(root, findings=findings, error=error, scanned=scanned)
    except subprocess.TimeoutExpired:
        return result(target, error="SEMGREP_TIMEOUT")
    except ScanError as exc:
        return result(target, error=exc.code)
    except (OSError, UnicodeError):
        return result(target, error="SEMGREP_IO_FAILED")
    except Exception:
        return result(target, error="SEMGREP_INTERNAL_ERROR")
