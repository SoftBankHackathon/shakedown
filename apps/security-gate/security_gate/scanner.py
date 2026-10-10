"""Bounded worker process isolates discovery and parsing from the caller."""
import multiprocessing
import os
import time

import yaml

from .discovery import discover
from .models import ScanError, file_result, report
from .parsing import parse, read_bounded
from .rules.privileged import check

DEFAULT_MAX_FILE_BYTES = 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 5.0
MAX_TOTAL_FILE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_FINDINGS = 1000


def _scan_local(target, max_file_bytes):
    files = []
    total_bytes = total_findings = 0
    for path in discover(target):
        try:
            source = read_bounded(path, max_file_bytes)
            total_bytes += len(source.encode("utf-8"))
            if total_bytes > MAX_TOTAL_FILE_BYTES:
                raise ScanError("TOTAL_FILE_SIZE_LIMIT_EXCEEDED")
            data, root = parse(source)
            findings = check(data, root, path)
            total_findings += len(findings)
            if total_findings > MAX_TOTAL_FINDINGS:
                raise ScanError("FINDING_LIMIT_EXCEEDED")
            decision = "DENY" if findings else "ALLOW"
            files.append(file_result(path, decision, findings))
        except ScanError as exc:
            files.append(file_result(path, "SCAN_FAILED", error=exc.code))
            if exc.code in {"TOTAL_FILE_SIZE_LIMIT_EXCEEDED", "FINDING_LIMIT_EXCEEDED"}:
                break
        except (yaml.YAMLError, UnicodeError):
            files.append(file_result(path, "SCAN_FAILED", error="INVALID_YAML_OR_ENCODING"))
        except OSError:
            files.append(file_result(path, "SCAN_FAILED", error="FILE_READ_FAILED"))
    return report(target, files)


def _worker(target, max_file_bytes, connection):
    try:
        result = _scan_local(target, max_file_bytes)
    except ScanError as exc:
        result = report(target, error=exc.code)
    except OSError:
        result = report(target, error="PATH_ACCESS_FAILED")
    except Exception:
        result = report(target, error="INTERNAL_SCAN_ERROR")
    try:
        connection.send(result)
    except (EOFError, OSError):
        # The parent may have already closed its pipe after a timeout.
        # Never emit a traceback or exception details from the worker.
        pass
    finally:
        connection.close()


def scan(target, *, max_file_bytes=DEFAULT_MAX_FILE_BYTES,
         timeout_seconds=DEFAULT_TIMEOUT_SECONDS):
    """Return a JSON-compatible report. Only explicit successful checks ALLOW."""
    try:
        target = os.path.abspath(os.fspath(target))
    except (TypeError, ValueError):
        return report("", error="INVALID_PATH")
    if (not isinstance(max_file_bytes, int) or isinstance(max_file_bytes, bool)
            or not 1 <= max_file_bytes <= 16 * 1024 * 1024
            or not isinstance(timeout_seconds, (int, float))
            or isinstance(timeout_seconds, bool) or not 0 < timeout_seconds <= 60):
        return report(target, error="INVALID_SCAN_LIMITS")
    parent = child = process = None
    started = False
    deadline = time.monotonic() + timeout_seconds
    try:
        context = multiprocessing.get_context("spawn")
        parent, child = context.Pipe(duplex=False)
        process = context.Process(target=_worker, args=(target, max_file_bytes, child), daemon=True)
        process.start()
        started = True
        child.close()
        remaining = max(0, deadline - time.monotonic())
        if not parent.poll(remaining):
            return report(target, error="TIME_LIMIT_EXCEEDED")
        return parent.recv()
    except (EOFError, OSError, RuntimeError):
        return report(target, error="WORKER_FAILED")
    finally:
        if parent is not None:
            parent.close()
        if child is not None:
            child.close()
        if started:
            process.join(timeout=0.1)
            if process.is_alive():
                process.terminate()
                process.join(timeout=0.5)
            if process.is_alive():
                process.kill()
                process.join(timeout=0.5)
            if not process.is_alive():
                process.close()
