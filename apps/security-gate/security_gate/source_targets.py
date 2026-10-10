"""Bounded source discovery; never follows links or executes project code."""
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .discovery import MAX_FILES, iter_files, validate_target
from .models import ScanError
from .parsing import read_bounded
from .source_syntax import SYNTAX_SUFFIXES
from .source_units import MAX_UNITS, SourceUnit, TemplateScripts

MAX_TOTAL_BYTES = 8 * 1024 * 1024
# Security-rule coverage only. Syntax-only grammars must not enter this map.
# extension -> (language, snapshot suffix). JSX/TSX preserve their parser dialect.
SUPPORTED = {".go": ("go", ".go"), ".rs": ("rust", ".rs"), ".py": ("python", ".py"), ".java": ("java", ".java"),
             ".js": ("javascript", ".js"), ".jsx": ("javascript", ".jsx"),
             ".mjs": ("javascript", ".js"), ".cjs": ("javascript", ".js"),
             ".ts": ("typescript", ".ts"), ".tsx": ("typescript", ".tsx"),
             ".mts": ("typescript", ".ts"), ".cts": ("typescript", ".ts")}
# Markup whose inline scripts and handlers are extracted as JavaScript units.
TEMPLATE_SUFFIXES = frozenset({".html", ".htm", ".svg"})
UNSUPPORTED = {
    ".vue": "vue", ".svelte": "svelte",
    ".kt": "kotlin", ".kts": "kotlin", ".scala": "scala", ".groovy": "groovy",
    ".rb": "ruby", ".php": "php", ".phtml": "php",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
    ".cxx": "cpp", ".hh": "cpp", ".hxx": "cpp",
    ".cs": "csharp", ".swift": "swift", ".dart": "dart", ".lua": "lua",
    ".sh": "shell", ".bash": "shell", ".ps1": "powershell", ".pl": "perl",
    ".r": "r", ".ex": "elixir", ".exs": "elixir", ".clj": "clojure",
    ".jsp": "jsp", ".fs": "fsharp", ".vb": "visualbasic",
}
# 못 본 범위 중 보고만 하고 막지 않는 것: 템플릿 값, 외부·누락·동적 script 참조.
# 그 밖의 gap(깨진 템플릿, 미지원 script 타입, 새로 생길 gap)은 막는다. gate.schema.json의 ALLOW 조건과 같아야 한다.
REPORTED_GAPS = frozenset({"TEMPLATE_EXPRESSION", "EXTERNAL_SCRIPT_REFERENCE",
                           "UNRESOLVED_SCRIPT_REFERENCE", "DYNAMIC_SCRIPT_REFERENCE"})


def source_language(path):
    """검사 가능 언어(SUPPORTED)와 알려진 미지원 언어(UNSUPPORTED)만 소스로 본다.
    확장자를 모르는 파일(설정·문서·이미지·.sql 등)은 소스로 보지 않고 Secret 검사만 받는다."""
    suffix = path.suffix.lower()
    if suffix in SUPPORTED:
        return SUPPORTED[suffix][0]
    if path.name.endswith(".gradle.kts"):  # Gradle 빌드 스크립트
        return None
    return UNSUPPORTED.get(suffix)


def empty_coverage():
    return {"detected_languages": [], "unsupported_languages": [], "unsupported_files": 0,
            "unscanned_sources": 0, "coverage_gaps": []}


def sources(target, max_file_bytes, coverage=None, *, syntax_only=None):
    root = validate_target(target)
    if not root.is_dir():
        raise ScanError("SEMGREP_DIRECTORY_REQUIRED")
    paths, detected, unsupported, unsupported_files = [], set(), set(), 0
    for path in iter_files(root, limit_code="SOURCE_DISCOVERY_LIMIT_EXCEEDED"):
        language = source_language(path)
        if language:
            detected.add(language)
        suffix = path.suffix.lower()
        if suffix in SUPPORTED or suffix in TEMPLATE_SUFFIXES:
            paths.append(path)
        elif language:
            unsupported.add(language)
            unsupported_files += 1
            if syntax_only is not None and suffix in SYNTAX_SUFFIXES:
                paths.append(path)
        if len(paths) > MAX_FILES:
            raise ScanError("SOURCE_DISCOVERY_LIMIT_EXCEEDED")
    total = 0
    result, gaps, references = [], [], []
    for path in sorted(paths):
        # read_bounded enforces max_file_bytes per file; only the total needs checking here.
        source = read_bounded(path, max_file_bytes)
        total += len(source.encode("utf-8"))
        if total > MAX_TOTAL_BYTES:
            raise ScanError("SOURCE_TOTAL_SIZE_LIMIT_EXCEEDED")
        suffix = path.suffix.lower()
        if suffix in SUPPORTED:
            result.append(SourceUnit(path, source, *SUPPORTED[suffix]))
        elif suffix in SYNTAX_SUFFIXES:
            syntax_only.append((path, source))
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
    if coverage is not None:
        coverage.update(detected_languages=sorted(detected), unsupported_languages=sorted(unsupported),
                        unsupported_files=unsupported_files, unscanned_sources=len(gaps),
                        coverage_gaps=sorted(set(gaps)))
    return root, result
