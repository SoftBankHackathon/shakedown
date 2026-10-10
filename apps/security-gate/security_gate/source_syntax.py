"""Limited AST syntax preflight in an isolated, time-bounded Python process.

The child parses source strings from stdin. It never imports or executes those
strings, opens target files, or constructs executable bytecode from them.
"""
import json
from pathlib import Path
import subprocess
import sys

from .models import ScanError

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CHECK_PROGRAM = """
import ast
import json
import sys

try:
    for source in json.load(sys.stdin):
        ast.parse(source, filename="<security-gate-source>", mode="exec")
except (SyntaxError, ValueError):
    sys.exit(65)
except (MemoryError, RecursionError):
    sys.exit(2)
"""



def _check(sources, program, *, timeout_seconds):
    if not sources:
        return
    if timeout_seconds <= 0:
        raise ScanError("SOURCE_SYNTAX_TIMEOUT")
    payload = json.dumps(sources, ensure_ascii=False).encode("utf-8")
    command = [sys.executable, "-I", "-S", "-B", "-c", program]
    try:
        completed = subprocess.run(
            command, input=payload, cwd=PROJECT_ROOT, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=timeout_seconds, shell=False,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
    except subprocess.TimeoutExpired:
        raise ScanError("SOURCE_SYNTAX_TIMEOUT") from None
    except OSError:
        raise ScanError("SOURCE_SYNTAX_CHECK_FAILED") from None
    if completed.returncode == 65:
        raise ScanError("SOURCE_SYNTAX_INVALID")
    if completed.returncode != 0:
        raise ScanError("SOURCE_SYNTAX_CHECK_FAILED")


def validate_sources(inputs, *, timeout_seconds):
    """Validate the exact bounded strings later copied to the Semgrep snapshot.

Only Python is pre-checked, with the running interpreter's grammar. Newer or
otherwise incompatible syntax fails closed; this is not a complete Python
compilation or semantic check. Other languages have no local parser here:
Semgrep runs with --strict and reports their parse errors as SEMGREP_SCAN_ERRORS.
"""
    if timeout_seconds <= 0:
        raise ScanError("SOURCE_SYNTAX_TIMEOUT")
    _check([source for path, source in inputs if path.suffix.lower() == ".py"],
           CHECK_PROGRAM, timeout_seconds=timeout_seconds)
