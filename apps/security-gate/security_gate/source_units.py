"""Source units and conservative script extraction; no rendering or execution."""
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
import re

from .models import ScanError

MAX_UNITS = 512
TEMPLATE_VALUE = re.compile(r"\[\[(?:\$|\*)\{[^{}\r\n]*\}\]\]|\[\((?:\$|\*)\{[^{}\r\n]*\}\)\]")


@dataclass(frozen=True)
class SourceUnit:
    path: Path
    text: str
    language: str
    suffix: str
    line_offset: int = 0
    fixed_line: int | None = None

    def __iter__(self):
        # Preserve the (path, source) protocol used by Python AST preflight.
        yield self.path
        yield self.text

    def original_line(self, line):
        return self.fixed_line or line + self.line_offset


class TemplateScripts(HTMLParser):
    """Extract static script bodies/handlers and explicitly record coverage gaps."""

    def __init__(self, path):
        super().__init__(convert_charrefs=True)
        self.path = path
        self.units = []
        self.gaps = []
        self.references = []
        self.languages = set()
        self.script = None
        self.script_count = 0

    def gap(self, reason):
        self.gaps.append(reason)

    def add(self, text, line, language="javascript", handler=False):
        if not text.strip():
            return
        self.languages.add(language)
        # Rendering is deliberately not attempted. Preserve literal code for
        # scanning, but never approve a template with unresolved expressions.
        text, count = TEMPLATE_VALUE.subn("__SECURITY_GATE_TEMPLATE_VALUE__", text)
        if count:
            self.gap("TEMPLATE_EXPRESSION")
        if handler:
            text = "function __security_gate_event__(){" + text + "\n}"
        self.units.append(SourceUnit(self.path, text, language,
                                     ".ts" if language == "typescript" else ".js",
                                     line - 1, line if handler else None))
        if len(self.units) > MAX_UNITS:
            raise ScanError("SOURCE_UNIT_LIMIT_EXCEEDED")

    def handle_starttag(self, tag, attrs):
        raw = self.get_starttag_text()
        if len({name for name, _ in attrs}) != len(attrs):
            self.gap("MALFORMED_TEMPLATE")
        for name, value in attrs:
            if not value:
                continue
            event = name.split(":")[-1].startswith("on")
            url = value.lstrip().lower().startswith("javascript:")
            if event or url:
                if event and ":" in name and not TEMPLATE_VALUE.search(value):
                    self.gap("TEMPLATE_EXPRESSION")
                match = re.search(r"\s" + re.escape(name) + r"\s*=", raw, re.I)
                line = self.getpos()[0] + (raw[:match.start() + 1].count("\n") if match else 0)
                self.add(value.split(":", 1)[1] if url else value, line, handler=True)
        if tag.lower() != "script":
            return
        attrs = dict(attrs)
        self.script_count += 1
        if self.script_count > MAX_UNITS:
            raise ScanError("SOURCE_UNIT_LIMIT_EXCEEDED")
        kind = (attrs.get("type") or "").strip().lower()
        language = "typescript" if kind in {"text/typescript", "application/typescript"} else "javascript"
        inert = kind in {"application/json", "application/ld+json", "importmap", "speculationrules"}
        if not inert:
            self.languages.add(language)
        if kind not in {"", "module", "text/javascript", "application/javascript", "text/ecmascript",
                        "application/ecmascript", "text/typescript", "application/typescript"} and not inert:
            self.gap("UNSUPPORTED_SCRIPT_TYPE")
        if (attrs.get("language") or "").lower() not in {"", "javascript", "ecmascript"}:
            self.gap("UNSUPPORTED_SCRIPT_TYPE")
        if "src" in attrs:
            self.references.append(attrs["src"] or "")
        if any(name.endswith(":src") for name in attrs):
            self.gap("DYNAMIC_SCRIPT_REFERENCE")
        if any(name in attrs for name in ("th:text", "th:utext")):
            self.gap("TEMPLATE_EXPRESSION")
        self.script = {"line": self.getpos()[0] + raw.count("\n"), "parts": [],
                       "language": language, "inert": inert}

    def handle_startendtag(self, tag, attrs):
        if tag.lower() == "script":
            self.gap("MALFORMED_TEMPLATE")
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_data(self, data):
        if self.script is not None:
            self.script["parts"].append(data)

    def handle_endtag(self, tag):
        if tag.lower() == "script" and self.script is not None:
            script, self.script = self.script, None
            text = "".join(script["parts"])
            if not script["inert"]:
                self.add(text, script["line"], script["language"])

    def finish(self, source):
        self.feed(source)
        self.close()
        if self.script is not None:
            self.gap("MALFORMED_TEMPLATE")
            self.handle_endtag("script")
        # Conservative mismatch detection includes suspicious malformed tags.
        if len(re.findall(r"<script\b", source, re.I)) != self.script_count:
            self.gap("MALFORMED_TEMPLATE")
        return self
