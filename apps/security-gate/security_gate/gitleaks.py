"""Gitleaks directory adapter: no git history, no source execution, no raw logs."""
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time

from .discovery import validate_target
from .models import ScanError
from .parsing import read_bounded
from .secret_targets import text_files

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONFIG_FILE = PROJECT_ROOT / "gitleaks_rules" / "gitleaks.toml"
DEFAULT_TIMEOUT_SECONDS = 30.0
FINDINGS_EXIT_CODE = 10
MIN_VERSION = (8, 24, 2)
MAX_REPORT_BYTES = 8 * 1024 * 1024
MAX_LOG_BYTES = 1024 * 1024
MAX_FINDINGS = 1000


def result(target, *, findings=None, error=None, version=None, scanned=0, applicable=True, excluded=0):
    findings = findings or []
    return {"tool": "gitleaks", "scope": "local_directory_text_secrets", "target_path": str(target),
            "scan_status": "FAILED" if error else "SUCCESS" if applicable else "NOT_APPLICABLE",
            "decision": "SCAN_FAILED" if error else "DENY" if findings else "ALLOW" if applicable else "REVIEW",
            "version": version, "scanned_files": scanned, "excluded_binary_files": excluded, "findings": findings,
            "errors": [error] if error else []}


def find_executable():
    path = PROJECT_ROOT / "tools" / "gitleaks" / ("gitleaks.exe" if os.name == "nt" else "gitleaks")
    return str(validate_target(path)) if path.is_file() else None


def environment(base):
    allowed = {"SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"}
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    env.update({"HOME": str(base), "USERPROFILE": str(base), "APPDATA": str(base / ".config"),
                "LOCALAPPDATA": str(base / ".cache"), "XDG_CONFIG_HOME": str(base / ".config"),
                "XDG_CACHE_HOME": str(base / ".cache"), "TMPDIR": str(base), "TMP": str(base),
                "TEMP": str(base)})
    return env


def run_cli(command, *, cwd, env, timeout):
    """Bounded pipes; scan logs are discarded, not saved or echoed to the user."""
    version_call = command[1] == "version"
    report_path = Path(command[command.index("--report-path") + 1]) if "--report-path" in command else None
    overflow, read_failed = threading.Event(), threading.Event()
    stdout_buffer, counts = bytearray(), [0, 0]
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)

    def drain(pipe, index):
        try:
            while chunk := pipe.read(8192):
                counts[index] += len(chunk)
                if counts[index] > (4096 if version_call and index == 0 else MAX_LOG_BYTES):
                    overflow.set()
                    break
                if version_call and index == 0:
                    stdout_buffer.extend(chunk)
        except (OSError, ValueError):
            read_failed.set()
        finally:
            pipe.close()

    threads = [threading.Thread(target=drain, args=(pipe, index), daemon=True)
               for index, pipe in enumerate((process.stdout, process.stderr))]
    try:
        for thread in threads:
            thread.start()
        deadline = time.monotonic() + timeout
        while True:
            if overflow.is_set():
                raise ScanError("GITLEAKS_OUTPUT_LIMIT_EXCEEDED")
            if report_path is not None and report_path.exists() and report_path.lstat().st_size > MAX_REPORT_BYTES:
                raise ScanError("GITLEAKS_REPORT_LIMIT_EXCEEDED")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout)
            try:
                process.wait(timeout=min(remaining, 0.05))
                break
            except subprocess.TimeoutExpired:
                continue
        for thread in threads:
            thread.join(timeout=0.5)
        if any(thread.is_alive() for thread in threads) or read_failed.is_set():
            raise ScanError("GITLEAKS_OUTPUT_READ_FAILED")
        if overflow.is_set():
            raise ScanError("GITLEAKS_OUTPUT_LIMIT_EXCEEDED")
        return subprocess.CompletedProcess(command, process.returncode, bytes(stdout_buffer),
                                           b"OUTPUT_PRESENT" if counts[1] else b"")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=2)
        for thread in threads:
            if thread.is_alive():
                thread.join(timeout=0.5)


def _version(completed):
    if completed.returncode != 0 or completed.stderr:
        raise ScanError("GITLEAKS_VERSION_FAILED")
    raw = completed.stdout
    if not isinstance(raw, (str, bytes)) or len(raw) > 64:
        raise ScanError("GITLEAKS_VERSION_INVALID")
    try:
        value = raw.decode("ascii").strip() if isinstance(raw, bytes) else raw.strip()
    except UnicodeError:
        raise ScanError("GITLEAKS_VERSION_INVALID") from None
    match = re.fullmatch(r"v?(\d{1,3})\.(\d{1,3})\.(\d{1,3})", value)
    if not match:
        raise ScanError("GITLEAKS_VERSION_INVALID")
    numbers = tuple(map(int, match.groups()))
    if numbers[0] != 8 or numbers < MIN_VERSION:
        raise ScanError("GITLEAKS_UNSUPPORTED_VERSION")
    return ".".join(str(part) for part in numbers)


def _original_path(raw, base, inputs_dir, mapping):
    if not isinstance(raw, str):
        raise ScanError("GITLEAKS_INVALID_RESULT")
    path = Path(raw)
    candidates = [path] if path.is_absolute() else [base / path, inputs_dir / path]
    for candidate in candidates:
        candidate = Path(os.path.abspath(candidate))
        if candidate.parent == inputs_dir and candidate.name in mapping:
            return mapping[candidate.name]
    raise ScanError("GITLEAKS_UNEXPECTED_RESULT_PATH")


def normalize(payload, base, inputs_dir, mapping):
    if not isinstance(payload, list):
        raise ScanError("GITLEAKS_INVALID_RESULT")
    if len(payload) > MAX_FINDINGS:
        raise ScanError("GITLEAKS_FINDING_LIMIT_EXCEEDED")
    findings = []
    for item in payload:
        if not isinstance(item, dict):
            raise ScanError("GITLEAKS_INVALID_RESULT")
        rule = item.get("RuleID")
        if not isinstance(rule, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,127}", rule):
            raise ScanError("GITLEAKS_INVALID_RULE_ID")
        original = _original_path(item.get("File"), base, inputs_dir, mapping)
        line = item.get("StartLine")
        if type(line) is not int or line < 1:
            raise ScanError("GITLEAKS_INVALID_RESULT")
        # Reject unredacted secrets injected into permitted metadata as well.
        for field in ("Secret", "Match"):
            value = item.get(field)
            if isinstance(value, str) and value and value != "REDACTED":
                if value in rule or value in str(original):
                    raise ScanError("GITLEAKS_SENSITIVE_METADATA")
        findings.append({"tool": "gitleaks", "rule_id": rule, "file_path": str(original),
                         "line": line, "severity": "HIGH", "reason_code": "SECRET_EXPOSURE",
                         "decision": "DENY"})
    return findings


def _scan_snapshot(target, executable, base, deadline, max_file_bytes, runner):
    version = _version(runner([executable, "version"], cwd=base, env=environment(base),
                              timeout=max(0.000001, deadline - time.monotonic())))
    excluded = []
    root, inputs = text_files(target, max_file_bytes, excluded)
    if not inputs:
        return result(root, version=version, applicable=False, excluded=len(excluded))
    validate_target(CONFIG_FILE)
    read_bounded(CONFIG_FILE, 64 * 1024)
    inputs_dir = base / "input"
    inputs_dir.mkdir()
    mapping = {}
    for index, (path, source) in enumerate(inputs):
        # Content rules run on anonymous .txt names; original config/ignores and
        # path-based suppressions never control this snapshot.
        name = f"source_{index:04d}.txt"
        (inputs_dir / name).write_text(source, encoding="utf-8", newline="")
        mapping[name] = path
    ignore = base / ".gitleaksignore"
    ignore.write_text("", encoding="utf-8")
    report_path = base / "report.json"  # Outside the scanned input directory.
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise subprocess.TimeoutExpired("gitleaks", 0)
    command = [executable, "dir", str(inputs_dir), "--config", str(CONFIG_FILE),
               "--report-format", "json", "--report-path", str(report_path), "--redact=100",
               "--exit-code", str(FINDINGS_EXIT_CODE), "--log-level", "error", "--no-banner",
               "--no-color", "--ignore-gitleaks-allow", "--gitleaks-ignore-path", str(ignore),
               "--max-target-megabytes", "0", "--max-decode-depth", "0"]
    completed = runner(command, cwd=base, env=environment(base), timeout=remaining)
    if completed.returncode not in (0, FINDINGS_EXIT_CODE):
        return result(root, error="GITLEAKS_EXECUTION_FAILED", version=version)
    if not report_path.exists():
        return result(root, error="GITLEAKS_REPORT_MISSING", version=version)
    if report_path.lstat().st_size > MAX_REPORT_BYTES:
        raise ScanError("GITLEAKS_REPORT_LIMIT_EXCEEDED")
    try:
        payload = json.loads(read_bounded(report_path, MAX_REPORT_BYTES))
    except (ValueError, UnicodeError):
        return result(root, error="GITLEAKS_INVALID_JSON", version=version)
    findings = normalize(payload, base, inputs_dir, mapping)
    error = "GITLEAKS_SCAN_ERRORS" if completed.stderr else None
    if (completed.returncode == FINDINGS_EXIT_CODE) != bool(findings):
        error = error or "GITLEAKS_INCONSISTENT_RESULT"
    return result(root, findings=findings, error=error, version=version, scanned=len(inputs), excluded=len(excluded))


def scan_gitleaks(target, *, timeout_seconds=DEFAULT_TIMEOUT_SECONDS, max_file_bytes=1024 * 1024, runner=None):
    """Return only allowlisted fields, even on tool, JSON, or cleanup failure."""
    try:
        target = os.path.abspath(os.fspath(target))
    except (ValueError, TypeError):
        return result("", error="INVALID_PATH")
    if (type(timeout_seconds) not in (int, float) or not math.isfinite(timeout_seconds)
            or not 0 < timeout_seconds <= 120 or type(max_file_bytes) is not int
            or not 1 <= max_file_bytes <= 16 * 1024 * 1024):
        return result(target, error="INVALID_SCAN_LIMITS")
    cleanup_started = False
    report = None
    deadline = time.monotonic() + timeout_seconds
    try:
        root = validate_target(target)
        if not root.is_dir():
            raise ScanError("GITLEAKS_DIRECTORY_REQUIRED")
        executable = find_executable()
        if executable is None and runner is None:
            return result(target, error="GITLEAKS_NOT_INSTALLED")
        temporary_root = PROJECT_ROOT / ".tmp"
        if temporary_root.exists():
            validate_target(temporary_root)
        else:
            temporary_root.mkdir()
        with tempfile.TemporaryDirectory(prefix="gitleaks-", dir=temporary_root) as directory:
            base = Path(directory)
            try:
                report = _scan_snapshot(target, executable or "mock-gitleaks", base, deadline,
                                        max_file_bytes, runner or run_cli)
            except subprocess.TimeoutExpired:
                report = result(target, error="GITLEAKS_TIMEOUT")
            except ScanError as exc:
                report = result(target, error=exc.code)
            except (OSError, UnicodeError):
                report = result(target, error="GITLEAKS_IO_FAILED")
            except Exception:
                report = result(target, error="GITLEAKS_INTERNAL_ERROR")
            cleanup_started = True
        return report
    except ScanError as exc:
        return result(target, error=exc.code)
    except OSError:
        if cleanup_started and report is not None:
            # The report is already normalized. Preserve known risks even when
            # removing the temporary source/report directory fails afterward.
            report["scan_status"] = "FAILED"
            report["decision"] = "SCAN_FAILED"
            report["errors"].append("GITLEAKS_CLEANUP_FAILED")
            return report
        return result(target, error="GITLEAKS_CLEANUP_FAILED" if cleanup_started else "GITLEAKS_IO_FAILED")
    except Exception:
        return result(target, error="GITLEAKS_INTERNAL_ERROR")
