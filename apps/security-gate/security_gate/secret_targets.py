"""Bounded UTF-8 text snapshots for directory secret scans, without execution."""
import io
import stat
import zipfile

from .discovery import MAX_FILES, iter_files, validate_target
from .models import ScanError
from .parsing import read_bounded_bytes

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


def text_files(target, max_file_bytes):
    """Return (root, [(path, text)], excluded_binaries) for a directory target."""
    root = validate_target(target)
    if not root.is_dir():
        raise ScanError("GITLEAKS_DIRECTORY_REQUIRED")
    paths = []
    for path in iter_files(root, limit_code="SECRET_DISCOVERY_LIMIT_EXCEEDED"):
        paths.append(path)
        if len(paths) > MAX_FILES:
            raise ScanError("SECRET_DISCOVERY_LIMIT_EXCEEDED")
    inputs, total, excluded = [], 0, 0
    for path in sorted(paths):
        data = read_bounded_bytes(path, max_file_bytes)
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise ScanError("SECRET_TOTAL_SIZE_LIMIT_EXCEEDED")
        if is_wrapper_jar(path, data):
            excluded += 1
            continue
        source = data.decode("utf-8-sig")
        if "\x00" in source:
            raise ScanError("GITLEAKS_UNSUPPORTED_TEXT")
        inputs.append((path, source))
    return root, inputs, excluded
