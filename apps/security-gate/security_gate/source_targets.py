"""Bounded Python source discovery; never follows links or imports sources."""
import os
from pathlib import Path
import stat

from .discovery import is_link, validate_target
from .models import ScanError
from .parsing import read_bounded

EXCLUDED_DIRECTORIES = frozenset({".git", ".venv", "venv", "__pycache__",
                                  ".pytest_cache", ".pytest-tmp", ".tmp", ".pip-cache"})
MAX_ENTRIES = 10_000
MAX_FILES = 256
MAX_TOTAL_BYTES = 8 * 1024 * 1024


def sources(target, max_file_bytes):
    root = validate_target(target)
    if not root.is_dir():
        raise ScanError("SEMGREP_DIRECTORY_REQUIRED")
    pending, paths, visited = [(root, 0)], [], 0
    while pending:
        directory, depth = pending.pop()
        if depth > 64:
            raise ScanError("SOURCE_DISCOVERY_LIMIT_EXCEEDED")
        if is_link(directory.lstat()):
            raise ScanError("SYMLINK_OR_REPARSE_POINT")
        with os.scandir(directory) as entries:
            for entry in entries:
                visited += 1
                if visited > MAX_ENTRIES:
                    raise ScanError("SOURCE_DISCOVERY_LIMIT_EXCEEDED")
                if entry.name in EXCLUDED_DIRECTORIES:
                    continue
                metadata = entry.stat(follow_symlinks=False)
                if is_link(metadata):
                    raise ScanError("SYMLINK_OR_REPARSE_POINT")
                if stat.S_ISDIR(metadata.st_mode):
                    pending.append((Path(entry.path), depth + 1))
                elif entry.name.endswith(".py"):
                    if not stat.S_ISREG(metadata.st_mode):
                        raise ScanError("UNSUPPORTED_PATH_TYPE")
                    paths.append(Path(entry.path))
                    if len(paths) > MAX_FILES:
                        raise ScanError("SOURCE_DISCOVERY_LIMIT_EXCEEDED")
    total = 0
    result = []
    for path in sorted(paths):
        source = read_bounded(path, max_file_bytes)
        total += len(source.encode("utf-8"))
        if total > MAX_TOTAL_BYTES:
            raise ScanError("SOURCE_TOTAL_SIZE_LIMIT_EXCEEDED")
        result.append((path, source))
    return root, result
