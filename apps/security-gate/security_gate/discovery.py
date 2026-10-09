"""Bounded discovery without following symbolic links or reparse points."""
import os
import stat
from pathlib import Path

from .models import ScanError

COMPOSE_NAMES = frozenset({"compose.yaml", "compose.yml", "docker-compose.yaml",
                           "docker-compose.yml"})
MAX_ENTRIES = 10_000
MAX_FILES = 256
MAX_DIRECTORY_DEPTH = 64


def is_link(metadata):
    return (stat.S_ISLNK(metadata.st_mode)
            or bool(getattr(metadata, "st_file_attributes", 0)
                    & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)))


def validate_target(target):
    path = Path(os.path.abspath(os.fspath(target)))
    # Check every component, including linked ancestors of a supplied file.
    for component in reversed((path, *path.parents)):
        if is_link(component.lstat()):
            raise ScanError("SYMLINK_OR_REPARSE_POINT")
    metadata = path.lstat()
    if not (stat.S_ISREG(metadata.st_mode) or stat.S_ISDIR(metadata.st_mode)):
        raise ScanError("UNSUPPORTED_PATH_TYPE")
    return path


def discover(target):
    path = validate_target(target)
    if path.is_file():
        return [path] if path.name in COMPOSE_NAMES else []
    found, pending, visited = [], [(path, 0)], 0
    while pending:
        directory, depth = pending.pop()
        if depth > MAX_DIRECTORY_DEPTH:
            raise ScanError("DISCOVERY_LIMIT_EXCEEDED")
        if is_link(directory.lstat()):
            raise ScanError("SYMLINK_OR_REPARSE_POINT")
        with os.scandir(directory) as entries:
            for entry in entries:
                visited += 1
                if visited > MAX_ENTRIES:
                    raise ScanError("DISCOVERY_LIMIT_EXCEEDED")
                metadata = entry.stat(follow_symlinks=False)
                if is_link(metadata):
                    # A linked directory may hide another Compose file.
                    if entry.name in COMPOSE_NAMES or not stat.S_ISREG(metadata.st_mode):
                        raise ScanError("SYMLINK_OR_REPARSE_POINT")
                    continue
                if stat.S_ISDIR(metadata.st_mode):
                    pending.append((Path(entry.path), depth + 1))
                elif entry.name in COMPOSE_NAMES:
                    if not stat.S_ISREG(metadata.st_mode):
                        raise ScanError("UNSUPPORTED_PATH_TYPE")
                    found.append(Path(entry.path))
                    if len(found) > MAX_FILES:
                        raise ScanError("DISCOVERY_LIMIT_EXCEEDED")
    return sorted(found)
