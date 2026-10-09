"""Bounded UTF-8 text snapshots for directory secret scans, without execution."""
import io
import os
from pathlib import Path
import stat
import zipfile

from .discovery import is_link, validate_target
from .models import ScanError
from .parsing import read_bounded_bytes

EXCLUDED_DIRECTORIES = frozenset({".git", ".venv", "venv", "node_modules", "__pycache__",
                                  ".pytest_cache", ".pytest-tmp", ".tmp", ".pip-cache"})
MAX_ENTRIES = 10_000
MAX_FILES = 256
MAX_TOTAL_BYTES = 8 * 1024 * 1024


def is_wrapper_jar(path, data):
    """Exclude only a structurally valid Gradle wrapper JAR, never arbitrary bytes.

    Archive contents are format-checked in memory with bounded expansion, not
    executed or extracted. This verifies format, not provenance or absence of secrets.
    """
    if path.parts[-3:] != ("gradle", "wrapper", "gradle-wrapper.jar"):
        return False
    # Text renamed to .jar remains text and must still reach Gitleaks.
    if not data.startswith(b"PK\x03\x04"):
        return False
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            names = [item.filename for item in entries]
            if (not entries or len(entries) > MAX_FILES or len(names) != len(set(names))
                    or sum(item.file_size for item in entries) > MAX_TOTAL_BYTES
                    or "META-INF/MANIFEST.MF" not in names
                    or "org/gradle/wrapper/GradleWrapperMain.class" not in names):
                raise ScanError("GITLEAKS_INVALID_BUILD_BINARY")
            for item in entries:
                if (item.flag_bits & 1 or item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                        or item.filename.startswith("/") or "\\" in item.filename
                        or ":" in item.filename or ".." in item.filename.split("/")
                        or stat.S_ISLNK(item.external_attr >> 16)):
                    raise ScanError("GITLEAKS_INVALID_BUILD_BINARY")
                # read validates local headers, bounded decompression and CRC.
                content = archive.read(item)
                if item.filename.endswith(".class") and not content.startswith(b"\xca\xfe\xba\xbe"):
                    raise ScanError("GITLEAKS_INVALID_BUILD_BINARY")
                if item.filename == "META-INF/MANIFEST.MF" and not content.startswith(b"Manifest-Version:"):
                    raise ScanError("GITLEAKS_INVALID_BUILD_BINARY")
    except (zipfile.BadZipFile, ValueError, RuntimeError, NotImplementedError, EOFError):
        raise ScanError("GITLEAKS_INVALID_BUILD_BINARY") from None
    return True


def text_files(target, max_file_bytes, excluded=None):
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
        data = read_bounded_bytes(path, max_file_bytes)
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise ScanError("SECRET_TOTAL_SIZE_LIMIT_EXCEEDED")
        if is_wrapper_jar(path, data):
            if excluded is not None:
                excluded.append(path)
            continue
        source = data.decode("utf-8-sig")
        if "\x00" in source:
            raise ScanError("GITLEAKS_UNSUPPORTED_TEXT")
        inputs.append((path, source))
    return root, inputs
