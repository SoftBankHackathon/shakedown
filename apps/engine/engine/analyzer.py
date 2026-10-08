"""Extend the imported static analyzer with team Analysis and file evidence."""
import os
import re
from pathlib import Path
import yaml
from engine.legacy_analyzer import AnalysisError, ENV_REFERENCE, EXCLUDED, Evidence, RepoAnalyzer as LegacyAnalyzer
from engine.models import Analysis, DeployConfig, Route

SAFE_SETTINGS = {
    'spring.datasource.username': r'[A-Za-z_][A-Za-z0-9_.-]{0,63}',
    'spring.jpa.hibernate.ddl-auto': r'none|validate|update|create|create-drop',
    'spring.jpa.show-sql': r'true|false',
    'server.port': r'[0-9]{1,5}',
}
SENSITIVE = re.compile(r'password|passwd|secret|token|credential|api.?key|private.?key|access.?key', re.I)

class RepoAnalyzer(LegacyAnalyzer):
    def _env_example(self, text: str, e: Evidence) -> None:
        super()._env_example(text, e)
        for line in text.splitlines():
            match = re.match(r"(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)", line.strip())
            if match and SENSITIVE.search(match[1]):
                value = match[2].strip().strip("\"'")
                e.extra.setdefault('secrets', set()).add(match[1])
                if value and not ENV_REFERENCE.search(value):
                    e.extra.setdefault('secret_values', set()).add(value)

    def _compose(self, text: str, e: Evidence) -> None:
        super()._compose(text, e)
        data = yaml.safe_load(text)
        for service in data.get('services', {}).values():
            environment = service.get('environment', {})
            entries = environment.items() if isinstance(environment, dict) else (
                item.split('=', 1) for item in environment if isinstance(item, str) and '=' in item
            )
            for key, raw in entries:
                if SENSITIVE.search(str(key)):
                    e.extra.setdefault('secrets', set()).add(str(key))
                    value = str(raw)
                    e.extra['secrets'].update(m[1] for m in ENV_REFERENCE.finditer(value))
                    if raw is not None and value and not ENV_REFERENCE.search(value):
                        e.extra.setdefault('secret_values', set()).add(value)
                        e.warn('A hardcoded sensitive compose setting was omitted; inject it through the target secret store.')

    def _application(self, name: str, text: str, e: Evidence) -> None:
        super()._application(name, text, e)
        if name.endswith('properties'):
            flat = {}
            for line in text.splitlines():
                if line.lstrip().startswith(('#', '!')):
                    continue
                match = re.match(r'\s*([^\s=:]+)\s*[=:]\s*(.*)', line)
                if match:
                    flat[match[1]] = match[2].strip()
            documents = [flat]
        else:
            documents = [self._flatten(doc) for doc in yaml.safe_load_all(text) if isinstance(doc, dict)]
        settings = e.extra.setdefault('settings', {})
        secret_keys = e.extra.setdefault('secrets', set())
        for flat in documents:
            for key, raw in flat.items():
                value = str(raw).lower() if isinstance(raw, bool) else str(raw)
                env_key = re.sub(r'[^A-Za-z0-9]', '_', key).upper()
                if SENSITIVE.search(key):
                    secret_keys.add(env_key)
                    secret_keys.update(m[1] for m in ENV_REFERENCE.finditer(value))
                    if value and not ENV_REFERENCE.search(value):
                        e.extra.setdefault('secret_values', set()).add(value)
                        e.warn('A hardcoded sensitive setting was omitted; inject it through the target secret store.')
                    continue
                if key in SAFE_SETTINGS and re.fullmatch(SAFE_SETTINGS[key], value):
                    settings.setdefault(env_key, set()).add(value)
                    e.records.append({'field': 'env.' + env_key, 'value': value, 'file': e.file, 'source': 'rule'})
                if key == 'spring.datasource.url':
                    match = re.fullmatch(r'jdbc:(mysql|mariadb|postgresql)://([A-Za-z0-9_.-]+)(?::([0-9]{1,5}))?/([A-Za-z0-9_]+)(?:\?.*)?', value)
                    if match:
                        db, host, port, db_name = match.groups()
                        e.add('database_name', db_name)
                        url = f'jdbc:{db}://{host}' + (f':{port}' if port else '') + f'/{db_name}'
                        settings.setdefault('SPRING_DATASOURCE_URL', set()).add(url)
                        e.records.append({'field': 'env.SPRING_DATASOURCE_URL', 'value': url, 'file': e.file, 'source': 'rule'})
                        if '?' in value:
                            e.warn('JDBC query parameters were omitted from env; verify required connection options.')
                    else:
                        e.warn('Datasource URL is unresolved or includes unsupported data; supply it before deployment.')

    def _result(self, config: DeployConfig, e: Evidence, root: Path, app_root: Path) -> Analysis:
        if not config.framework:
            raise AnalysisError('Unsupported or ambiguous repository stack; select a supported application directory.')
        framework_file = next((r['file'] for r in e.records if r['field'] == 'framework' and r['value'] == config.framework), None)
        stack = config.framework
        if stack == 'spring-boot':
            stack += '-' + (config.build_tool or 'unknown')
        e.records = [r for r in e.records if r['field'] not in {'runtime', 'framework', 'build_tool'}]
        manifest = next((p.relative_to(root).as_posix() for p in self._discover(root, e)
                         if p.parent == app_root and p.name in {'build.gradle', 'build.gradle.kts', 'pom.xml', 'package.json', 'requirements.txt', 'pyproject.toml'}), None)
        e.records.append({'field': 'stack', 'value': stack, 'file': framework_file or manifest, 'source': 'rule'})
        for record in e.records:
            if record['field'] == 'runtime_version':
                record['field'] = 'java_version' if config.runtime == 'java' else 'runtime_version'
        defaults = {'spring-boot': 8080, 'nextjs': 3000, 'express': 3000, 'react': 3000,
                    'vue': 5173, 'fastapi': 8000, 'django': 8000, 'flask': 5000}
        port = config.port
        if port is None or not 1 <= port <= 65535:
            port = defaults[config.framework]
            e.records.append({'field': 'port', 'value': str(port), 'file': None, 'source': 'default'})
            e.warn('port uses a framework default; verify the actual listening port before deployment.')
        health_path = config.health_path
        if not health_path or not re.fullmatch(r'/[A-Za-z0-9_./{}-]*', health_path):
            health_path = '/'
            e.records.append({'field': 'health_path', 'value': '/', 'file': None, 'source': 'default'})
            e.warn('health_path defaults to /; HTTP availability has not been checked.')
        else:
            e.warn('health_path is a static candidate; target infrastructure must verify public URL health.')
        routes, session = self._java_sources(root, app_root, e)
        if session:
            e.warn('Server session references were detected; runtime behavior has not been checked.')
        if not session:
            e.records.append({'field': 'uses_server_session', 'value': 'false', 'file': None, 'source': 'default'})
            e.warn('No server session use was detected; uses_server_session=false needs confirmation.')
        settings = e.extra.get('settings', {})
        env = {key: next(iter(values)) for key, values in settings.items() if len(values) == 1}
        if any(len(values) > 1 for values in settings.values()):
            e.warn('Conflicting environment settings were omitted; select an application profile.')
        secret_keys = e.extra.get('secrets', set())
        secret_keys.update(key for key in config.required_env_keys if key not in env)
        for key in secret_keys:
            env.pop(key, None)
        if secret_keys:
            e.warn('secret_env lists names only, including unclassified environment references; confirm secret mappings with infra.')
        database_name = e.one('database_name')
        if config.database.type and database_name is None:
            e.warn('database_name is unknown or ambiguous; confirm database provisioning settings.')
        java = None
        if config.runtime == 'java' and config.runtime_version:
            java = int(config.runtime_version.split('.')[0])
        if e.one('database') is None:
            database_name = None
        secret_values = e.extra.get('secret_values', set())
        for key, value in list(env.items()):
            if any(secret in value for secret in secret_values):
                del env[key]
                secret_keys.add(key)
        if database_name and any(secret in database_name for secret in secret_values):
            database_name = None
        e.records = [r for r in e.records if not any(secret in r['value'] for secret in secret_values)]
        e.warnings = [w for w in e.warnings if w not in {
            'port is unknown or ambiguous; no default was assumed.',
            'health_path is unknown or ambiguous; no default was assumed.',
        }]
        summary = f'Static rules detected {stack}; {len(routes)} Spring route candidates. Deployment readiness is unverified.'
        return Analysis(stack=stack, port=port, java_version=java, database=config.database.type,
                        database_name=database_name, health_path=health_path, uses_server_session=session,
                        summary=summary, routes=routes, evidence=e.records, env=env,
                        secret_env=sorted(secret_keys), warnings=e.warnings)

    def _java_sources(self, root: Path, app_root: Path, e: Evidence) -> tuple[list[Route], bool]:
        routes = []
        session = False
        count = 0
        visited = 0
        source_root = app_root / 'src' / 'main'
        if any(p.is_symlink() or p.is_junction() for p in [app_root / 'src', source_root]):
            e.warn('Linked Java source directory was skipped; route/session analysis is incomplete.')
            return routes, session
        for directory, directories, files in os.walk(source_root, followlinks=False):
            directories[:] = sorted(d for d in directories if d not in EXCLUDED and not (Path(directory) / d).is_symlink() and not (Path(directory) / d).is_junction())
            visited += 1
            if visited > 5000:
                e.warn('Java directory scan limit reached; route/session analysis is incomplete.')
                break
            for name in sorted(files):
                path = Path(directory) / name
                if not name.endswith('.java') or path.is_symlink():
                    continue
                count += 1
                if count > self.max_files:
                    e.warn('Java file scan limit reached; route/session analysis is incomplete.')
                    return routes, session
                try:
                    if path.stat().st_size > self.max_file_bytes:
                        e.warn('Java file exceeds size limit; route/session analysis is incomplete.')
                        continue
                    text = path.read_text(encoding='utf-8-sig')
                except (OSError, UnicodeError):
                    e.warn('Java source could not be read; route/session analysis is incomplete.')
                    continue
                tokens = r'"(?:\\.|[^"\\])*"|/\*.*?\*/|//[^\n]*'
                text = re.sub(tokens, lambda m: ' ' if m[0].startswith(('//', '/*')) else m[0], text, flags=re.S)
                filename = path.relative_to(root).as_posix()
                session_text = re.sub(r'(?m)^\s*import\s+[^;]+;', '', text)
                session_text = re.sub(r'"(?:\\.|[^"\\])*"', '', session_text)
                if re.search(r'\bHttpSession\b|@SessionAttributes\b|\.getSession\s*\(', session_text):
                    session = True
                    e.records.append({'field': 'uses_server_session', 'value': 'true', 'file': filename, 'source': 'rule'})
                class_at = re.search(r'\bclass\s+\w+', text)
                if not class_at or not re.search(r'@(?:RestController|Controller)\b', text[:class_at.start()]):
                    continue
                prefix = ''
                class_mapping = re.search(r'@RequestMapping\b(?:\s*\(([^)]*)\))?', text[:class_at.start()])
                if class_mapping:
                    prefix = self._mapping_path(class_mapping[1] or '', e)
                    if prefix is None:
                        continue
                mapping = re.compile(r'@(Get|Post|Put|Patch|Delete|Request)Mapping\b(?:\s*\(([^)]*)\))?')
                body = text[class_at.end():]
                for match in mapping.finditer(body):
                    args = match[2] or ''
                    path_part = self._mapping_path(args, e)
                    if path_part is None:
                        continue
                    route_path = '/' + (prefix.rstrip('/') + '/' + path_part.lstrip('/')).strip('/')
                    if not re.fullmatch(r'/[A-Za-z0-9_./{}-]*', route_path):
                        e.warn('Unsupported Spring route path was omitted.')
                        continue
                    method = match[1].upper()
                    if method == 'REQUEST':
                        methods = re.findall(r'RequestMethod\.([A-Z]+)', args)
                        if len(methods) != 1:
                            e.warn('RequestMapping without one explicit method was omitted.')
                            continue
                        method = methods[0]
                    next_mapping = mapping.search(body, match.end())
                    end = next_mapping.start() if next_mapping else len(body)
                    declaration = body[match.end():end].split('{', 1)[0]
                    params = []
                    for parameter in re.finditer(r'@RequestParam(?:\s*\((.*?)\))?\s+(?:final\s+)?[\w<>.?]+\s+([A-Za-z_][A-Za-z0-9_]*)', declaration, re.S):
                        explicit = re.search(r'(?:^|\b(?:value|name)\s*=\s*)"([A-Za-z_][A-Za-z0-9_]*)"', (parameter[1] or '').strip())
                        params.append(explicit[1] if explicit else parameter[2])
                    if '@RequestBody' in declaration:
                        params.append('(JSON body)')
                    routes.append(Route(method=method, path=route_path, file=filename, params=params))
                    e.records.append({'field': 'routes', 'value': f'{method} {route_path}', 'file': filename, 'source': 'rule'})
        e.warn('Route discovery supports simple Spring annotations only; request bodies and dynamic mappings need confirmation.')
        return routes, session

    @staticmethod
    def _mapping_path(args: str, e: Evidence) -> str | None:
        args = args.strip()
        if not args:
            return ''
        match = re.match(r'"([^"\n]*)"(?:\s*,|\s*$)', args)
        if match is None:
            match = re.search(r'\b(?:value|path)\s*=\s*"([^"\n]*)"(?:\s*,|\s*$)', args)
        if match and '${' not in match[1]:
            return match[1]
        if re.match(r'(?:method|produces|consumes|headers|params|name)\s*=', args) and not re.search(r'\b(?:path|value)\s*=', args):
            return ''
        e.warn('Complex Spring route annotations were omitted; route discovery is partial.')
        return None
