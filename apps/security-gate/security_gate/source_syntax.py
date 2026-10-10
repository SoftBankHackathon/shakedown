"""Limited AST syntax preflight in an isolated, time-bounded Python process.

The child parses source strings from stdin. It never imports or executes those
strings, opens target files, or constructs executable bytecode from them.
"""
import json
from pathlib import Path
import subprocess
import sys
import sysconfig
import time

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


# Only this interpreter's installed packages are added; -S still prevents .pth
# execution/site initialization and -I excludes the target repo and PYTHONPATH.
JAVA_CHECK_PROGRAM = (
    "import sys\nsys.path.extend(" + repr(list(dict.fromkeys(
        sysconfig.get_path(key) for key in ("purelib", "platlib")))) + ")\n"
    + """
import json
from tree_sitter import Language, Parser
import tree_sitter_java

parser = Parser(Language(tree_sitter_java.language()))
for source in json.load(sys.stdin):
    tree = parser.parse(source.encode("utf-8"))
    if tree.root_node.has_error:
        sys.exit(65)
"""
)


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
    """Parse the exact strings later scanned, without compiling/executing them.

    Python uses the interpreter grammar; Java uses pinned Tree-sitter grammar.
    This is syntax-only, not type checking or a guarantee of build success.
    Other languages still rely on errors reported by Semgrep, which is not a
    complete syntax preflight.
    """
    if timeout_seconds <= 0:
        raise ScanError("SOURCE_SYNTAX_TIMEOUT")
    deadline = time.monotonic() + timeout_seconds
    for suffix, program in ((".py", CHECK_PROGRAM), (".java", JAVA_CHECK_PROGRAM)):
        _check([source for path, source in inputs if path.suffix.lower() == suffix],
               program, timeout_seconds=deadline - time.monotonic())
