"""Bounded source discovery; never follows links or executes project code."""
import os
from pathlib import Path
import stat
from urllib.parse import unquote, urlsplit

from .discovery import is_link, validate_target
from .models import ScanError
from .parsing import read_bounded
from .source_units import MAX_UNITS, SourceUnit, TemplateScripts

EXCLUDED_DIRECTORIES = frozenset({".git", ".venv", "venv", "__pycache__",
                                  ".pytest_cache", ".pytest-tmp", ".tmp", ".pip-cache"})
MAX_ENTRIES = 10_000
MAX_FILES = 256
MAX_TOTAL_BYTES = 8 * 1024 * 1024
SUPPORTED = {".py": "python", ".java": "java", ".js": "javascript", ".jsx": "javascript",
             ".mjs": "javascript", ".cjs": "javascript", ".ts": "typescript", ".tsx": "typescript",
             ".mts": "typescript", ".cts": "typescript"}
SUFFIXES = {"python": ".py", "java": ".java", "javascript": ".js", "typescript": ".ts"}
UNSUPPORTED = {
    ".vue": "vue", ".svelte": "svelte",
    ".kt": "kotlin", ".kts": "kotlin", ".scala": "scala", ".groovy": "groovy",
    ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php", ".phtml": "php",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
    ".cs": "csharp", ".swift": "swift", ".dart": "dart", ".lua": "lua",
    ".sh": "shell", ".bash": "shell", ".ps1": "powershell", ".pl": "perl",
    ".r": "r", ".ex": "elixir", ".exs": "elixir", ".clj": "clojure",
    ".jsp": "jsp", ".sql": "sql", ".fs": "fsharp", ".vb": "visualbasic",
}
# Explicit non-application-source scope. These still go through secret scanning.
DATA_SUFFIXES = frozenset({".md", ".txt", ".rst", ".yaml", ".yml", ".json", ".xml",
    ".toml", ".ini", ".cfg", ".conf", ".properties", ".env", ".html", ".htm", ".css",
    ".csv", ".lock", ".gradle", ".jar", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg"})
DATA_NAMES = frozenset({"Dockerfile", "Makefile", "gradlew", "gradlew.bat", "mvnw", "mvnw.cmd",
    "README", "LICENSE", "NOTICE", ".gitignore", ".gitattributes", ".dockerignore", ".semgrepignore"})


def source_language(path):
    suffix = path.suffix.lower()
    if suffix in SUPPORTED:
        return SUPPORTED[suffix]
    if path.name.endswith(".gradle.kts"):
        return None
    if suffix in UNSUPPORTED:
        return UNSUPPORTED[suffix]
    if path.name in DATA_NAMES or path.name.startswith(".env"):
        return None
    return None if suffix in DATA_SUFFIXES else "unknown"


def empty_coverage():
    return {"detected_languages": [], "unsupported_languages": [], "unsupported_files": 0,
            "unscanned_sources": 0, "coverage_gaps": []}


def sources(target, max_file_bytes, coverage=None):
    root = validate_target(target)
    if not root.is_dir():
        raise ScanError("SEMGREP_DIRECTORY_REQUIRED")
    pending, paths, visited = [(root, 0)], [], 0
    detected, unsupported = set(), set()
    unsupported_files = 0
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
                metadata = entry.stat(follow_symlinks=False)
                if is_link(metadata):
                    raise ScanError("SYMLINK_OR_REPARSE_POINT")
                if entry.name in EXCLUDED_DIRECTORIES and stat.S_ISDIR(metadata.st_mode):
                    continue
                if stat.S_ISDIR(metadata.st_mode):
                    pending.append((Path(entry.path), depth + 1))
                else:
                    if not stat.S_ISREG(metadata.st_mode):
                        raise ScanError("UNSUPPORTED_PATH_TYPE")
                    path = Path(entry.path)
                    language = source_language(path)
                    if language:
                        detected.add(language)
                    if path.suffix.lower() in SUPPORTED or path.suffix.lower() in {".html", ".htm", ".svg"}:
                        paths.append(path)
                    elif language:
                        unsupported.add(language)
                        unsupported_files += 1
                    if len(paths) > MAX_FILES:
                        raise ScanError("SOURCE_DISCOVERY_LIMIT_EXCEEDED")
    total = 0
    result, gaps, references = [], [], []
    for path in sorted(paths):
        source = read_bounded(path, max_file_bytes)
        total += len(source.encode("utf-8"))
        if total > MAX_TOTAL_BYTES:
            raise ScanError("SOURCE_TOTAL_SIZE_LIMIT_EXCEEDED")
        if path.suffix.lower() in SUPPORTED:
            language = SUPPORTED[path.suffix.lower()]
            suffix = path.suffix.lower() if path.suffix.lower() in {".jsx", ".tsx"} else SUFFIXES[language]
            result.append(SourceUnit(path, source, language, suffix))
        else:
            template = TemplateScripts(path).finish(source)
            result.extend(template.units)
            detected.update(template.languages)
            gaps.extend(template.gaps)
            references.extend((path, value) for value in template.references)
        if len(result) > MAX_UNITS:
            raise ScanError("SOURCE_UNIT_LIMIT_EXCEEDED")
    standalone = {unit.path for unit in result if unit.path.suffix.lower() in SUPPORTED}
    for parent, reference in references:
        try:
            url = urlsplit(reference)
            if url.scheme or url.netloc:
                gaps.append("EXTERNAL_SCRIPT_REFERENCE")
                continue
            relative = unquote(url.path)
            local = Path(os.path.abspath(parent.parent / relative))
            if not relative or not local.is_relative_to(root) or local not in standalone:
                gaps.append("UNRESOLVED_SCRIPT_REFERENCE")
        except ValueError:
            gaps.append("UNRESOLVED_SCRIPT_REFERENCE")
    if any(len(unit.text.encode("utf-8")) > max_file_bytes for unit in result):
        raise ScanError("FILE_SIZE_LIMIT_EXCEEDED")
    if sum(len(unit.text.encode("utf-8")) for unit in result) > MAX_TOTAL_BYTES:
        raise ScanError("SOURCE_TOTAL_SIZE_LIMIT_EXCEEDED")
    if coverage is not None:
        coverage.update(detected_languages=sorted(detected), unsupported_languages=sorted(unsupported),
                        unsupported_files=unsupported_files, unscanned_sources=len(gaps),
                        coverage_gaps=sorted(set(gaps)))
    return root, result
