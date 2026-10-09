"""Bounded UTF-8 text snapshots for directory secret scans, without execution."""
import os
from pathlib import Path
import stat

from .discovery import is_link, validate_target
from .models import ScanError
from .parsing import read_bounded

EXCLUDED_DIRECTORIES = frozenset({".git", ".venv", "venv", "node_modules", "__pycache__",
                                  ".pytest_cache", ".pytest-tmp", ".tmp", ".pip-cache"})
MAX_ENTRIES = 10_000
MAX_FILES = 256
MAX_TOTAL_BYTES = 8 * 1024 * 1024


def text_files(target, max_file_bytes):
    root = validate_target(target)
    if not root.is_dir():
        raise ScanError("GITLEAKS_DIRECTORY_REQUIRED")
    paths, pending, visited = [], [(root, 0)], 0
    while pending:
        directory, depth = pending.pop()
        if depth > 64:
            raise ScanError("SECRET_DISCOVERY_LIMIT_EXCEEDED")
        if is_link(directory.lstat()):
            raise ScanError("SYMLINK_OR_REPARSE_POINT")
        with os.scandir(directory) as entries:
            for entry in entries:
                visited += 1
                if visited > MAX_ENTRIES:
                    raise ScanError("SECRET_DISCOVERY_LIMIT_EXCEEDED")
                metadata = entry.stat(follow_symlinks=False)
                if entry.name in EXCLUDED_DIRECTORIES and stat.S_ISDIR(metadata.st_mode) and not is_link(metadata):
                    continue
                if is_link(metadata):
                    raise ScanError("SYMLINK_OR_REPARSE_POINT")
                if stat.S_ISDIR(metadata.st_mode):
                    pending.append((Path(entry.path), depth + 1))
                else:
                    if not stat.S_ISREG(metadata.st_mode):
                        raise ScanError("UNSUPPORTED_PATH_TYPE")
                    paths.append(Path(entry.path))
                    if len(paths) > MAX_FILES:
                        raise ScanError("SECRET_DISCOVERY_LIMIT_EXCEEDED")
    inputs, total = [], 0
    for path in sorted(paths):
        source = read_bounded(path, max_file_bytes)
        if "\x00" in source:
            raise ScanError("GITLEAKS_UNSUPPORTED_TEXT")
        total += len(source.encode("utf-8"))
        if total > MAX_TOTAL_BYTES:
            raise ScanError("SECRET_TOTAL_SIZE_LIMIT_EXCEEDED")
        inputs.append((path, source))
    return root, inputs
