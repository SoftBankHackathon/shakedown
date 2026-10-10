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


# Grammar selection is local policy, never a target-provided package name.
GRAMMARS = {
    "java": ("tree_sitter_java", "language"),
    "javascript": ("tree_sitter_javascript", "language"),
    "typescript": ("tree_sitter_typescript", "language_typescript"),
    "tsx": ("tree_sitter_typescript", "language_tsx"),
    "go": ("tree_sitter_go", "language"),
    "rust": ("tree_sitter_rust", "language"),
    "c": ("tree_sitter_c", "language"),
    "cpp": ("tree_sitter_cpp", "language"),
    "csharp": ("tree_sitter_c_sharp", "language"),
    "ruby": ("tree_sitter_ruby", "language"),
    "php": ("tree_sitter_php", "language_php"),
}
SYNTAX_SUFFIXES = {
    ".java": ("java",),
    **{suffix: ("javascript",) for suffix in (".js", ".jsx", ".mjs", ".cjs")},
    **{suffix: ("typescript",) for suffix in (".ts", ".mts", ".cts")},
    ".tsx": ("tsx",), ".go": ("go",), ".rs": ("rust",),
    ".c": ("c",), ".h": ("c", "cpp"),
    **{suffix: ("cpp",) for suffix in (".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx")},
    ".cs": ("csharp",), ".rb": ("ruby",), ".php": ("php",), ".phtml": ("php",),
}
# -S prevents .pth/site initialization; -I excludes target repo/PYTHONPATH.
TREE_SITTER_CHECK_PROGRAM = (
    "import sys\nsys.path.extend(" + repr(list(dict.fromkeys(
        sysconfig.get_path(key) for key in ("purelib", "platlib")))) + ")\n"
    + "GRAMMARS = " + repr(GRAMMARS) + "\n"
    + """
import importlib
import json
from tree_sitter import Language, Parser

parsers = {}
for grammars, source in json.load(sys.stdin):
    valid = False
    for grammar in grammars:
        if grammar not in parsers:
            module, entrypoint = GRAMMARS[grammar]
            parsers[grammar] = Parser(Language(getattr(importlib.import_module(module), entrypoint)()))
        tree = parsers[grammar].parse(source.encode("utf-8"))
        if not tree.root_node.has_error:
            valid = True
            break
    if not valid:
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
    """Syntax-only validation of exact bounded strings, never compilation.

    SourceUnit.suffix is used for extracted HTML scripts/handlers and JSX/TSX.
    A .h header may use C or C++; either grammar accepting it suffices, without
    granting security-rule coverage. Unsupported extensions remain unapproved.
    """
    if timeout_seconds <= 0:
        raise ScanError("SOURCE_SYNTAX_TIMEOUT")
    deadline = time.monotonic() + timeout_seconds
    python_sources, tree_sources = [], []
    for item in inputs:
        path, source = item
        suffix = getattr(item, "suffix", path.suffix).lower()
        if suffix == ".py":
            python_sources.append(source)
        elif suffix in SYNTAX_SUFFIXES:
            tree_sources.append((SYNTAX_SUFFIXES[suffix], source))
    _check(python_sources, CHECK_PROGRAM, timeout_seconds=deadline - time.monotonic())
    _check(tree_sources, TREE_SITTER_CHECK_PROGRAM, timeout_seconds=deadline - time.monotonic())
