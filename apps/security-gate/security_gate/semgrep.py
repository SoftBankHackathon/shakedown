"""Offline local-rule Semgrep adapter with an injectable CLI runner."""
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
from contextlib import contextmanager, nullcontext
import errno
from functools import partial

from .discovery import validate_target
from .models import ScanError
from .parsing import read_bounded
from .source_targets import empty_coverage, sources
from .source_syntax import validate_sources

PROJECT_ROOT = Path(__file__).resolve().parents[1]
RULE_FILE = PROJECT_ROOT / "semgrep_rules" / "python-security.yml"
JAVA_RULE_FILE = PROJECT_ROOT / "semgrep_rules" / "java-security.yml"
WEB_RULE_FILE = PROJECT_ROOT / "semgrep_rules" / "javascript-typescript-security.yml"
RULE_FILES = (RULE_FILE, JAVA_RULE_FILE, WEB_RULE_FILE)
RULES = {
    "security-gate-python-eval": ("HIGH", "PYTHON_DYNAMIC_EVAL"),
    "security-gate-python-shell-true": ("HIGH", "PYTHON_SHELL_EXECUTION"),
    "security-gate-java-runtime-exec": ("HIGH", "JAVA_COMMAND_EXECUTION"),
    "security-gate-java-process-builder": ("HIGH", "JAVA_PROCESS_EXECUTION"),
    "security-gate-web-dynamic-eval": ("HIGH", "WEB_DYNAMIC_EVAL"),
    "security-gate-web-function-constructor": ("HIGH", "WEB_DYNAMIC_FUNCTION"),
    "security-gate-web-shell-exec": ("HIGH", "WEB_SHELL_EXECUTION"),
}
DEFAULT_TIMEOUT_SECONDS = 30.0
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_STDERR_BYTES = 1024 * 1024
MAX_FINDINGS = 1000


def result(target, *, findings=None, error=None, applicable=True, scanned=0, coverage=None,
           scanned_units=0, scanned_languages=None):
    findings = findings or []
    coverage = coverage or empty_coverage()
    return {
        "tool": "semgrep", "scope": "local_multilanguage_mvp_rules",
        "target_path": str(target),
        "scan_status": "FAILED" if error else "SUCCESS" if applicable else "NOT_APPLICABLE",
        "decision": "SCAN_FAILED" if error else "DENY" if findings else "REVIEW"
                    if coverage["unsupported_files"] or coverage["unscanned_sources"] or not applicable else "ALLOW",
        "findings": findings, "errors": [error] if error else [], "scanned_files": scanned,
        "scanned_units": scanned_units, "scanned_languages": scanned_languages or [],
        **coverage,
    }


def find_executable():
    # Prefer the scanner's installed dependency, never a target's executable.
    directory = PROJECT_ROOT / ".venv" / ("Scripts" if os.name == "nt" else "bin")
    executable = directory / ("semgrep.exe" if os.name == "nt" else "semgrep")
    if executable.is_file():
        return str(validate_target(executable))
    return None


def environment(snapshot):
    # Semgrep uses XDG paths only when these directories already exist.
    (snapshot / ".config").mkdir(exist_ok=True)
    (snapshot / ".cache").mkdir(exist_ok=True)
    allowed = {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"}
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    env.update({
        "APPDATA": str(snapshot / ".config"),
        "LOCALAPPDATA": str(snapshot / ".cache"), "XDG_CONFIG_HOME": str(snapshot / ".config"),
        "XDG_CACHE_HOME": str(snapshot / ".cache"), "TMPDIR": str(snapshot),
        "TEMP": str(snapshot), "TMP": str(snapshot),
        "SEMGREP_SETTINGS_FILE": str(snapshot / "settings.yml"),
        "SEMGREP_ENABLE_VERSION_CHECK": "0", "SEMGREP_SEND_METRICS": "off",
        "PYTHONUTF8": "1", "PYTHONNOUSERSITE": "1",
    })
    if os.name == "nt":
        # Match the logged-in profile used by the working direct Windows CLI.
        # Settings, caches and temporary files still stay in the disposable snapshot.
        if os.environ.get("USERPROFILE"):
            env["USERPROFILE"] = os.environ["USERPROFILE"]
    else:
        env["HOME"] = env["USERPROFILE"] = str(snapshot)
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
    output_dir = env.get("TMPDIR", cwd)
    with tempfile.TemporaryFile(dir=output_dir) as stdout, tempfile.TemporaryFile(dir=output_dir) as stderr:
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


@contextmanager
def _runtime_lock(root, deadline):
    """Serialize access to Semgrep's shared settings and cache under .tmp."""
    with (root / "semgrep-runtime.lock").open("a+b") as handle:
        if handle.seek(0, os.SEEK_END) == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            acquire = lambda: msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            release = lambda: msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            acquire = lambda: fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            release = lambda: fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        while True:
            try:
                handle.seek(0)
                acquire()
                break
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN):
                    raise
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired("semgrep runtime lock", 0)
                time.sleep(min(remaining, 0.05))
        try:
            yield
        finally:
            handle.seek(0)
            release()


def _mapped_name(raw, snapshot, mapping):
    if not isinstance(raw, str):
        raise ScanError("SEMGREP_INVALID_RESULT")
    path = Path(raw)
    path = Path(os.path.abspath(path if path.is_absolute() else snapshot / path))
    if path.parent != snapshot or path.name not in mapping:
        raise ScanError("SEMGREP_UNEXPECTED_RESULT_PATH")
    return path.name


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
        unit = mapping[_mapped_name(item.get("path"), snapshot, mapping)]
        start = item.get("start")
        if not isinstance(start, dict) or type(start.get("line")) is not int or start["line"] < 1:
            raise ScanError("SEMGREP_INVALID_RESULT")
        severity, reason = RULES[item["check_id"]]
        # Do not forward extra.message, lines, metavars, traces, stdout, or stderr.
        findings.append({"tool": "semgrep", "rule_id": item["check_id"], "severity": severity,
                         "file_path": str(unit.path), "line": unit.original_line(start["line"]),
                         "decision": "DENY", "reason_code": reason})
    scanned = {_mapped_name(path, snapshot, mapping) for path in payload["paths"]["scanned"]}
    error = "SEMGREP_SCAN_ERRORS" if payload["errors"] else None
    # Compare units, not original paths: multiple scripts can share one HTML
    # file. A missing second script must never be hidden by the first script.
    if scanned != set(mapping):
        error = "SEMGREP_INCOMPLETE_SCAN"
    return (findings, error, len({mapping[name].path for name in scanned}), len(scanned),
            sorted({mapping[name].language for name in scanned}))


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
    coverage = empty_coverage()
    try:
        root, inputs = sources(target, max_file_bytes, coverage)
        done = partial(result, root, coverage=coverage)
        if not inputs:
            return done(applicable=False)
        executable = find_executable()
        if executable is None and runner is None:
            return done(error="SEMGREP_NOT_INSTALLED")
        validate_sources(inputs, timeout_seconds=deadline - time.monotonic())
        for rule_file in RULE_FILES:
            validate_target(rule_file)
            read_bounded(rule_file, 64 * 1024)
        temporary_root = PROJECT_ROOT / ".tmp"
        temporary_root.mkdir(exist_ok=True)
        validate_target(temporary_root)
        with tempfile.TemporaryDirectory(prefix="semgrep-", dir=temporary_root) as temporary:
            snapshot = Path(temporary)
            mapping = {}
            for index, unit in enumerate(inputs):
                name = f"source_{index:04d}{unit.suffix}"
                (snapshot / name).write_text(unit.text, encoding="utf-8", newline="")
                mapping[name] = unit
            (snapshot / ".semgrepignore").write_text("", encoding="utf-8")
            command = [executable or "mock-semgrep", "scan",
                       *[arg for rule_file in RULE_FILES for arg in ("--config", str(rule_file))],
                       "--json", "--error", "--strict", "--oss-only", "--metrics", "off",
                       "--disable-version-check", "--disable-nosem", "--no-git-ignore",
                       "--no-rewrite-rule-ids", "--no-secrets-validation", "--jobs", "1",
                       "--timeout", "5", "--timeout-threshold", "1", "--max-memory", "256",
                       "--max-target-bytes", str(max_file_bytes), "--",
                       *(str(snapshot / name) for name in mapping)]
            # The working direct CLI probe uses the common .tmp runtime root;
            # source files still live in a separate snapshot for each scan.
            env = environment(temporary_root)
            # Only the real CLI shares the runtime root, so only it takes the lock.
            with _runtime_lock(temporary_root, deadline) if runner is None else nullcontext():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(command, timeout_seconds)
                completed = (runner or run_cli)(command, cwd=PROJECT_ROOT, env=env, timeout=remaining)
            if completed.returncode not in (0, 1):
                return done(error="SEMGREP_EXECUTION_FAILED")
            if len(completed.stdout) > MAX_OUTPUT_BYTES:
                raise ScanError("SEMGREP_OUTPUT_LIMIT_EXCEEDED")
            try:
                payload = json.loads(completed.stdout)
            except (ValueError, UnicodeError):
                return done(error="SEMGREP_INVALID_JSON")
            findings, error, scanned, scanned_units, scanned_languages = _normalize(payload, snapshot, mapping)
            if completed.returncode == 1 and not findings:
                error = error or "SEMGREP_EXECUTION_FAILED"
            return done(findings=findings, error=error, scanned=scanned,
                        scanned_units=scanned_units, scanned_languages=scanned_languages)
    except subprocess.TimeoutExpired:
        return result(target, error="SEMGREP_TIMEOUT", coverage=coverage)
    except ScanError as exc:
        return result(target, error=exc.code, coverage=coverage)
    except (OSError, UnicodeError):
        return result(target, error="SEMGREP_IO_FAILED", coverage=coverage)
    except Exception:
        return result(target, error="SEMGREP_INTERNAL_ERROR", coverage=coverage)
