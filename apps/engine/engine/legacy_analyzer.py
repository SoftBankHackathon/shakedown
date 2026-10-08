"""Bounded, deterministic static analysis. Repository code is never executed."""

import json
import os
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlsplit

import yaml

from engine.models import DatabaseConfig, DeployConfig

MANIFESTS = {"pom.xml", "build.gradle", "build.gradle.kts", "package.json", "requirements.txt", "pyproject.toml"}
FILES = MANIFESTS | {
    "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml",
    "application.yml", "application.yaml", "application.properties", ".env.example",
}
EXCLUDED = {".git", ".venv", "venv", "node_modules", "target", "build", "dist", "__pycache__", ".pytest_cache"}
ENV_REFERENCE = re.compile(r"(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}")
DB_NAMES = {"mysql": "mysql", "mariadb": "mariadb", "postgres": "postgresql", "postgresql": "postgresql", "mongo": "mongodb", "mongodb": "mongodb", "sqlite": "sqlite"}


class AnalysisError(ValueError):
    """Public errors contain no repository file contents or subprocess output."""


class Evidence:
    def __init__(self) -> None:
        self.values: dict[str, set[str | int]] = {}
        self.file: str | None = None
        self.records: list[dict] = []
        self.extra: dict = {}
        self.env: set[str] = set()
        self.warnings: list[str] = []
        self.database_required = False
        self.database_external_configured = False
        self.actuator = False
        self.context_paths: set[str] = set()
        self.management_paths: set[str] = set()
        self.management_ports: set[int] = set()

    def add(self, field: str, value: str | int) -> None:
        self.values.setdefault(field, set()).add(value)
        self.records.append({"field": field, "value": str(value), "file": self.file, "source": "rule"})

    def warn(self, message: str) -> None:
        if message not in self.warnings:
            self.warnings.append(message)

    def one(self, field: str) -> str | int | None:
        values = self.values.get(field, set())
        if len(values) > 1:
            self.warn(f"Conflicting {field} evidence; manual selection is required.")
            return None
        return next(iter(values)) if values else None

    def environment(self, text: str, compose: bool = False) -> None:
        for match in ENV_REFERENCE.finditer(text):
            key, suffix = match.groups()
            # Spring uses :default; Compose uses -default / :-default.
            has_default = (
                suffix.startswith(("-", ":-")) if compose
                else suffix.startswith(":") and not suffix.startswith((":?", ":-"))
            )
            if not has_default:
                self.env.add(key)


class RepoAnalyzer:
    def __init__(self, clone_timeout: int = 60, max_file_bytes: int = 1_000_000, max_files: int = 250) -> None:
        self.clone_timeout = clone_timeout
        self.max_file_bytes = max_file_bytes
        self.max_files = max_files

    @staticmethod
    def github_url(source: str) -> str:
        try:
            parsed = urlsplit(source)
            valid = (
                parsed.scheme == "https" and parsed.netloc == "github.com"
                and not parsed.query and not parsed.fragment
                and re.fullmatch(r"/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?", parsed.path)
            )
        except ValueError:
            valid = False
        if not valid:
            raise AnalysisError("Expected a public GitHub HTTPS repository URL without credentials, query or fragment.")
        path = parsed.path.rstrip("/")
        if any(segment in {".", ".."} for segment in path.split("/")[1:]):
            raise AnalysisError("Invalid GitHub repository path.")
        return "https://github.com" + path

    def analyze(self, source: str | Path) -> DeployConfig:
        source = str(source)
        if "://" in source or source.startswith("git@"):
            url = self.github_url(source)
            cache = Path(__file__).resolve().parents[1] / ".data" / "clones"
            cache.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="repo-intelligence-", dir=cache) as temporary:
                destination = Path(temporary) / "repository"
                environment = os.environ.copy()
                environment["GIT_TERMINAL_PROMPT"] = "0"
                environment["GIT_LFS_SKIP_SMUDGE"] = "1"
                try:
                    # Do not expose stderr (which may contain credentials or file data).
                    # Disable hooks and custom checkout filters inherited from user config.
                    environment["GIT_CONFIG_NOSYSTEM"] = "1"
                    environment["GIT_CONFIG_GLOBAL"] = os.devnull
                    subprocess.run(
                        ["git", "-c", "core.hooksPath=" + os.devnull, "-c", "init.templateDir=", "-c", "core.symlinks=false", "clone", "--depth", "1", "--", url, str(destination)],
                        check=True, timeout=self.clone_timeout, stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL, env=environment,
                    )
                except subprocess.TimeoutExpired:
                    raise AnalysisError("Repository clone timed out.") from None
                except (OSError, subprocess.CalledProcessError):
                    raise AnalysisError("Repository clone failed; check URL, Git availability and network access.") from None
                return self._analyze_path(destination, url)
        try:
            path = Path(source).resolve(strict=True)
        except (OSError, ValueError):
            raise AnalysisError("Local repository directory does not exist or is inaccessible.") from None
        if not path.is_dir():
            raise AnalysisError("Local repository source must be a directory.")
        return self._analyze_path(path, str(path))

    def _discover(self, root: Path, evidence: Evidence) -> list[Path]:
        found: list[Path] = []
        visited = 0
        for directory, directories, files in os.walk(root, followlinks=False):
            directories[:] = sorted(d for d in directories if d not in EXCLUDED and not (Path(directory) / d).is_symlink() and not (Path(directory) / d).is_junction())
            visited += 1
            if visited > 5000:
                evidence.warn("Directory scan limit reached; analysis is incomplete.")
                break
            for name in sorted(files):
                path = Path(directory) / name
                if re.fullmatch(r"application-.+\.(?:yml|yaml|properties)", name):
                    evidence.warn("Profile-specific Spring configuration is not evaluated; verify the active deployment profile.")
                if name not in FILES or path.is_symlink():
                    continue
                if len(found) >= self.max_files:
                    evidence.warn("File scan limit reached; analysis is incomplete.")
                    return found
                found.append(path)
        return sorted(found)

    def _analyze_path(self, root: Path, source: str) -> DeployConfig:
        e = Evidence()
        paths = self._discover(root, e)
        manifests = {p.parent for p in paths if p.name in MANIFESTS}
        # Avoid silently combining evidence from unrelated monorepo applications.
        if root in manifests:
            app_root = root
            nested = manifests - {root}
            if nested:
                e.warn("Nested project manifests found; only the root application is analyzed.")
            paths = [p for p in paths if not any(directory == p.parent or directory in p.parents for directory in nested)]
        elif len(manifests) == 1:
            app_root = next(iter(manifests))
            paths = [p for p in paths if app_root == p.parent or app_root in p.parents]
            e.warn("Application is in a subdirectory; repository-level deployment files are not applied.")
        elif len(manifests) > 1:
            app_root = root
            paths = []
            e.warn("Multiple application roots found; select a local application directory explicitly.")
        else:
            app_root = root

        dockerfile = False
        for path in paths:
            e.file = path.relative_to(root).as_posix()
            try:
                if path.stat().st_size > self.max_file_bytes:
                    e.warn(f"{path.name} exceeds the size limit and was skipped.")
                    continue
                text = path.read_text(encoding="utf-8-sig")
            except (OSError, UnicodeError):
                e.warn(f"{path.name} could not be read as UTF-8.")
                continue
            try:
                if path.name in MANIFESTS and path.parent == app_root:
                    self._manifest(path.name, text, e)
                elif path.name == ".env.example":
                    self._env_example(text, e)
                elif path.name == "Dockerfile" and path.parent == app_root:
                    dockerfile = True
                    self._docker(text, e)
                elif path.name.startswith("application."):
                    self._application(path.name, text, e)
                elif path.name in {"docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"} and path.parent == app_root:
                    self._compose(text, e)
            except (ValueError, TypeError, AttributeError, ET.ParseError, yaml.YAMLError, RecursionError):
                e.warn(f"{path.name} could not be parsed; affected fields require confirmation.")

        e.file = next((p.relative_to(root).as_posix() for p in paths if p.name in MANIFESTS), None)
        if e.actuator:
            if len(e.context_paths) <= 1 and len(e.management_paths) <= 1 and not e.management_ports:
                context = next(iter(e.context_paths), "").rstrip("/")
                base = next(iter(e.management_paths), "/actuator").rstrip("/")
                e.add("health_path", context + base + "/health")
                e.records[-1]["source"] = "default"
                e.records[-1]["file"] = None
                e.warn("Actuator health path is a candidate; availability and authentication are unverified.")
            else:
                e.warn("Actuator has conflicting paths or a separate management port; health path needs confirmation.")
        selected = {field: e.one(field) for field in ("framework", "runtime", "runtime_version", "build_tool", "port", "database", "health_path")}
        for field in ("framework", "runtime", "runtime_version", "build_tool", "port", "health_path"):
            if selected[field] is None:
                e.warn(f"{field} is unknown or ambiguous; no default was assumed.")
        if e.database_required and not selected["database"]:
            e.warn("Database is required but its type is unknown or ambiguous.")
        if e.database_required and not e.database_external_configured:
            e.warn("Database is required, but external database configuration was not confirmed; verify connection and secret injection before deployment.")
        if selected["health_path"] is None:
            e.warn("No dedicated health endpoint was confirmed; configure a post-deployment health check.")
        if e.env:
            e.warn("Environment key names were detected; values and deployment availability were not checked.")
        weights = {"framework": .20, "runtime": .20, "runtime_version": .15, "build_tool": .15, "port": .20, "health_path": .10}
        score = sum(weight for field, weight in weights.items() if selected[field] is not None)
        if e.database_required and not selected["database"]:
            score -= .15
        if any("limit" in warning or "parsed" in warning or "Nested" in warning or "subdirectory" in warning or "could not be read" in warning or "Multiple Spring" in warning for warning in e.warnings):
            score -= .10
        if any("is a candidate" in warning for warning in e.warnings):
            score -= .05
        if any("explicit fallback" in warning for warning in e.warnings):
            score -= .05
        config = DeployConfig(
            repo_url=source, framework=selected["framework"], runtime=selected["runtime"],
            runtime_version=selected["runtime_version"], build_tool=selected["build_tool"],
            port=selected["port"], database=DatabaseConfig(type=selected["database"], required=e.database_required),
            required_env_keys=sorted(e.env), dockerfile=dockerfile, health_path=selected["health_path"],
            warnings=e.warnings, confidence=round(max(0.0, score), 2),
        )

        return self._result(config, e, root, app_root)

    def _result(self, config: DeployConfig, evidence: Evidence, root: Path, app_root: Path):
        return config

    @staticmethod
    def _version(e: Evidence, runtime: str, value: str) -> None:
        value = value.strip().strip("\"'")
        if re.fullmatch(r"\d+(?:\.\d+){0,2}", value):
            if runtime == "java" and value.startswith("1."):
                value = value[2:]
            e.add("runtime", runtime)
            e.add("runtime_version", value)
        else:
            e.warn("Runtime version is a range, variable or unsupported expression; an exact version is required.")

    def _dependencies(self, text: str, e: Evidence) -> None:
        if re.search(r"(?:org\.springframework\.boot|spring-boot-starter|spring-boot-dependencies)", text):
            e.add("framework", "spring-boot")
            e.add("runtime", "java")
        if "spring-boot-starter-actuator" in text:
            e.actuator = True
        for pattern, db in (
            (r"mysql-connector(?:-java|-j)|com\.mysql", "mysql"),
            (r"mariadb-java-client|org\.mariadb", "mariadb"),
            (r"org\.postgresql|postgresql:postgresql", "postgresql"),
            (r"spring-boot-starter-data-mongodb|mongodb-driver", "mongodb"),
            (r"sqlite-jdbc", "sqlite"),
        ):
            if re.search(pattern, text):
                e.add("database", db)
                e.database_required = True
        if re.search(r"spring-boot-starter-(?:data-jpa|jdbc|data-jdbc)", text):
            e.database_required = True

    def _manifest(self, name: str, text: str, e: Evidence) -> None:
        if name in {"build.gradle", "build.gradle.kts"}:
            clean = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
            clean = re.sub(r"(?m)^\s*//.*$", "", clean)
            e.add("build_tool", "gradle")
            e.add("runtime", "java")
            self._dependencies(clean, e)
            patterns = (
                r"JavaLanguageVersion\.of\(\s*(\d+)\s*\)",
                r"(?:sourceCompatibility|targetCompatibility)\s*(?:=\s*)?(?:JavaVersion\.VERSION_([0-9_]+)|['\"]([0-9.]+)['\"]|(\d+))",
                r"(?:jvmToolchain|jvmTarget)\s*(?:\(\s*|=\s*['\"]?)(\d+)",
            )
            for pattern in patterns:
                for match in re.finditer(pattern, clean):
                    value = next(group for group in match.groups() if group is not None)
                    self._version(e, "java", value.replace("_", "."))
        elif name == "pom.xml":
            tree = ET.fromstring(text)
            clean = ET.tostring(tree, encoding="unicode")
            e.add("runtime", "java")
            e.add("build_tool", "maven")
            self._dependencies(clean, e)
            for node in tree.iter():
                if node.tag.split("}")[-1] in {"java.version", "maven.compiler.release", "maven.compiler.source", "maven.compiler.target"} and node.text:
                    self._version(e, "java", node.text)
        elif name == "package.json":
            data = json.loads(text)
            e.add("runtime", "node")
            e.add("build_tool", "npm")
            manager = data.get("packageManager", "")
            if manager:
                e.values["build_tool"] = set()
                if manager.split("@")[0] in {"npm", "yarn", "pnpm", "bun"}:
                    e.add("build_tool", manager.split("@")[0])
                else:
                    e.warn("packageManager is unsupported.")
            dependencies = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
            # Next includes React, so use the most specific known framework.
            for dependency, framework in (("next", "nextjs"), ("express", "express"), ("react", "react"), ("vue", "vue")):
                if dependency in dependencies:
                    e.add("framework", framework)
                    break
            if data.get("engines", {}).get("node"):
                self._version(e, "node", data["engines"]["node"])
            for script in data.get("scripts", {}).values():
                if isinstance(script, str):
                    e.environment(script)
                    for match in re.finditer(r"(?:\bPORT=|--port(?:=|\s+)|(?:^|\s)-p\s+)(\d+)\b", script):
                        e.add("port", int(match[1]))
        else:
            e.add("runtime", "python")
            if name == "pyproject.toml":
                import tomllib

                data = tomllib.loads(text)
                e.add("build_tool", "poetry" if "poetry" in data.get("tool", {}) else "pip")
                project = data.get("project", {})
                if project.get("requires-python"):
                    self._version(e, "python", project["requires-python"])
                packages = project.get("dependencies", [])
                packages = list(packages) + list(data.get("tool", {}).get("poetry", {}).get("dependencies", {}))
                poetry_python = data.get("tool", {}).get("poetry", {}).get("dependencies", {}).get("python")
                if isinstance(poetry_python, str):
                    self._version(e, "python", poetry_python)
                dependency_text = "\n".join(packages)
            else:
                e.add("build_tool", "pip")
                dependency_text = "\n".join(line.split("#", 1)[0] for line in text.splitlines())
            for dependency in ("fastapi", "django", "flask"):
                if re.search(r"(?im)^\s*" + dependency + r"(?:\b|\[)", dependency_text):
                    e.add("framework", dependency)

    @staticmethod
    def _env_example(text: str, e: Evidence) -> None:
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            match = re.match(r"(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
            if match:
                e.env.add(match[1])
            else:
                e.warn(".env.example contains an invalid key declaration; contents were omitted.")

    def _docker(self, text: str, e: Evidence) -> None:
        stages = []
        ports = set()
        health_paths = set()
        for line in text.splitlines():
            if line.lstrip().startswith("#"):
                continue
            match = re.match(r"\s*FROM\s+(?:--platform=\S+\s+)?(\S+)", line, re.I)
            if match:
                stages.append(match[1])
                ports.clear()
                health_paths.clear()
            match = re.match(r"\s*EXPOSE\s+(.+)", line, re.I)
            if match:
                for item in match[1].split():
                    if re.fullmatch(r"\d+(?:/tcp)?", item):
                        ports.add(int(item.split("/")[0]))
                    else:
                        e.warn("Dockerfile EXPOSE contains a variable or unsupported port declaration.")
            if re.match(r"\s*HEALTHCHECK\s", line, re.I):
                match = re.search(r"https?://(?:localhost|127\.0\.0\.1)(?::\d+)?(/[^\s'\"?;|]+)", line)
                if match:
                    health_paths.add(match[1])
        for port in ports:
            e.add("port", port)
        for health_path in health_paths:
            e.add("health_path", health_path)
        # A builder image does not establish the deployed runtime version.
        if stages:
            image = stages[-1].split("/")[-1]
            match = re.match(r"(eclipse-temurin|openjdk|amazoncorretto|node|python):([0-9]+(?:\.[0-9]+){0,2})(?:[-@].*)?$", image)
            if match:
                runtime = {"node": "node", "python": "python"}.get(match[1], "java")
                self._version(e, runtime, match[2])

    @staticmethod
    def _flatten(data: dict, prefix: str = "") -> dict[str, object]:
        flat = {}
        for key, value in data.items():
            name = f"{prefix}.{key}" if prefix else str(key)
            if isinstance(value, dict):
                flat.update(RepoAnalyzer._flatten(value, name))
            else:
                flat[name] = value
        return flat

    @staticmethod
    def _port(value: object, e: Evidence) -> None:
        if isinstance(value, bool):
            e.warn("Application port is not an integer.")
            return
        if re.fullmatch(r"\d+", str(value)):
            e.add("port", int(str(value)))
            return
        match = re.fullmatch(r"\$\{[A-Za-z_][A-Za-z0-9_]*:(\d+)\}", str(value))
        if match:
            e.add("port", int(match[1]))
            e.records[-1]["source"] = "default"
            e.warn("Application port uses an explicit fallback and may be overridden by environment.")
        else:
            e.warn("Application port depends on an unresolved value.")

    def _application(self, name: str, text: str, e: Evidence) -> None:
        if name.endswith("properties"):
            flat = {}
            for line in text.splitlines():
                if not line.strip() or line.lstrip().startswith(("#", "!")):
                    continue
                match = re.match(r"\s*([^\s=:]+)\s*[=:]\s*(.*)", line)
                if match:
                    key, value = match.groups()
                    if key in flat:
                        e.warn("application.properties contains duplicate keys; manual review is required.")
                    flat[key] = value.strip()
            documents = [flat]
        else:
            documents = [self._flatten(doc) for doc in yaml.safe_load_all(text) if isinstance(doc, dict)]
            if len(documents) > 1:
                e.warn("Multiple Spring configuration documents found; profile selection needs confirmation.")
        for flat in documents:
            for key, value in flat.items():
                e.environment(str(value))
                if key == "server.port":
                    self._port(value, e)
                if key.startswith(("spring.datasource.", "spring.data.mongodb.")):
                    e.database_required = True
                    if ENV_REFERENCE.search(str(value)):
                        e.database_external_configured = True
                    if key not in {"spring.datasource.url", "spring.datasource.driver-class-name", "spring.data.mongodb.uri"}:
                        continue
                    match = re.search(r"jdbc:(mysql|mariadb|postgresql|sqlite):", str(value))
                    if match:
                        e.add("database", match[1])
                    elif re.search(r"mongodb(?:\+srv)?://", str(value)):
                        e.add("database", "mongodb")
                    # Driver class is also explicit evidence when JDBC URL is an env reference.
                    for marker, db in (("com.mysql", "mysql"), ("org.mariadb", "mariadb"), ("org.postgresql", "postgresql")):
                        if marker in str(value):
                            e.add("database", db)
                if key in {"server.servlet.context-path", "management.endpoints.web.base-path"}:
                    if isinstance(value, str) and re.fullmatch(r"/[A-Za-z0-9_./-]*", value):
                        (e.context_paths if key.startswith("server") else e.management_paths).add(value)
                    else:
                        e.warn("Health path prefix is unresolved.")
                        e.context_paths.update({"unresolved-a", "unresolved-b"})
                if key == "management.server.port":
                    e.management_ports.add(1)
                if key == "management.endpoint.health.enabled" and str(value).lower() == "false":
                    e.management_ports.add(1)
                    e.warn("Actuator health endpoint is explicitly disabled.")

    def _compose(self, text: str, e: Evidence) -> None:
        data = yaml.safe_load(text)
        services = data.get("services", {})
        database_services = set()
        for name, service in services.items():
            image = str(service.get("image", "")).split("/")[-1].split(":")[0].split("@")[0]
            if image in DB_NAMES:
                database_services.add(name)
                e.add("database", DB_NAMES[image])
        for name, service in services.items():
            # Parse references in all services, including database credentials, by key only.
            for value in self._flatten(service).values():
                e.environment(str(value), compose=True)
            environment = service.get("environment", {})
            entries = environment.items() if isinstance(environment, dict) else (
                item.split("=", 1) for item in environment if isinstance(item, str) and "=" in item
            )
            for key, value in entries:
                if ENV_REFERENCE.search(str(value)) and (
                    name in database_services
                    or re.search(r"(?:^|_)(?:DB|DATABASE|DATASOURCE|MYSQL|MARIADB|POSTGRES|MONGODB)(?:_|$)", str(key), re.I)
                ):
                    e.database_external_configured = True
            if isinstance(environment, dict):
                e.env.update(key for key, value in environment.items() if value is None and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(key)))
            elif isinstance(environment, list):
                e.env.update(item for item in environment if isinstance(item, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", item))
            if name in database_services:
                continue
            if database_services.intersection(service.get("depends_on", [])):
                e.database_required = True
            for port in service.get("ports", []):
                if isinstance(port, dict):
                    self._port(port.get("target"), e)
                else:
                    target = str(port).rsplit(":", 1)[-1].split("/")[0]
                    self._port(target, e)
