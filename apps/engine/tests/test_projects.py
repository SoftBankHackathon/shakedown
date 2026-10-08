import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
import pytest
from engine.analyzer import AnalysisError, RepoAnalyzer
from engine.models import Analysis, CreateProjectRequest, Project
from engine.projects import ProjectStore, WORKSPACE, normalize_repo


def test_spring_boot_analysis(repository):
    result = RepoAnalyzer().analyze(repository)
    assert result.stack == 'spring-boot-gradle'
    assert result.port == 8181
    assert result.java_version == 21
    assert result.database == 'mysql'
    assert result.database_name == 'board_db'
    assert result.uses_server_session
    assert result.env['SPRING_DATASOURCE_USERNAME'] == 'app'
    assert result.env['SPRING_JPA_SHOW_SQL'] == 'false'
    assert 'SPRING_DATASOURCE_PASSWORD' in result.secret_env
    assert {(r.method, r.path) for r in result.routes} == {('POST', '/api/login'), ('GET', '/api/posts/{id}')}
    assert result.routes[0].params == ['email', 'password']
    assert any(e.field == 'port' and e.value == '8181' and e.file.endswith('application.yml') and e.source == 'rule' for e in result.evidence)
    assert any(e.field == 'java_version' and e.file == 'build.gradle' for e in result.evidence)


def test_all_analysis_fields(repository):
    expected = {'stack', 'port', 'java_version', 'database', 'database_name', 'health_path',
                'uses_server_session', 'summary', 'routes', 'evidence', 'env', 'secret_env', 'warnings'}
    assert set(RepoAnalyzer().analyze(repository).model_dump()) == expected


def test_health(client):
    assert client.get('/api/health').json() == {'ok': True}


def test_projects_list_and_detail(client, repository):
    assert client.get('/api/projects').json() == []
    response = client.post('/api/projects', json={'repo': str(repository), 'name': 'Board', 'targets': ['aws', 'local']})
    assert response.status_code == 200
    project = response.json()
    assert project['targets'] == ['aws', 'local']
    assert client.get('/api/projects').json() == [project]
    assert client.get('/api/projects/' + project['id']).json() == project
    assert client.get('/api/projects/missing').status_code == 404


def test_project_contract_against_fixture(client, repository):
    response = client.post('/api/projects', json={'repo': str(repository)})
    fixture = json.loads((WORKSPACE / 'packages/contracts/fixtures/project.json').read_text(encoding='utf-8'))
    project = response.json()
    assert set(project) == set(fixture)
    assert set(project['analysis']) == set(fixture['analysis'])
    assert Project.model_validate(project).repo == normalize_repo(str(repository))
    assert set(project['analysis_cost']) == {'calls', 'input_tokens', 'output_tokens', 'krw'}
    assert project['analysis_cost']['calls'] == 0
    assert project['ports'] == {}  # No actual host port has been allocated.
    assert project['last_deployment'] is None
    for route in project['analysis']['routes']:
        assert set(route) == {'method', 'path', 'file', 'params'}
    for evidence in project['analysis']['evidence']:
        assert set(evidence) == {'field', 'value', 'file', 'source'}


def test_no_secret_values_in_responses_disk_or_logs(client, repository, store, caplog, capsys):
    (repository / '.env.example').write_text('API_TOKEN=NEVER_EMIT_ENV_VALUE_789\n', encoding='utf-8')
    response = client.post('/api/projects', json={'repo': str(repository)})
    assert response.status_code == 200
    project = response.json()
    all_output = response.text + client.get('/api/projects').text
    all_output += client.get('/api/projects/' + project['id']).text + caplog.text
    captured = capsys.readouterr()
    all_output += captured.out + captured.err + store.path.read_bytes().decode('utf-8', errors='ignore')
    for sentinel in ['NEVER_EMIT_PASSWORD_123', 'NEVER_EMIT_API_KEY_456', 'NEVER_EMIT_ENV_VALUE_789']:
        assert sentinel not in all_output
    assert all(s['value'] == '••••••••' for s in project['secrets'])
    assert 'API_TOKEN' in project['analysis']['secret_env']
    assert 'SPRING_DATASOURCE_PASSWORD' not in project['analysis']['env']


def test_duplicate_repo_reuses_project(client, repository):
    first = client.post('/api/projects', json={'repo': str(repository)}).json()
    with patch('engine.analyzer.RepoAnalyzer.analyze', side_effect=AssertionError('must not reanalyze')):
        second = client.post('/api/projects', json={'repo': str(repository / '.'), 'name': 'Changed', 'targets': ['local', 'gcp']}).json()
    assert first == second
    assert len(client.get('/api/projects').json()) == 1


def test_persistence(store, repository):
    project = store.create(CreateProjectRequest(repo=str(repository)))
    reopened = ProjectStore(store.path)
    assert reopened.get(project.id) == project
    assert reopened.create(CreateProjectRequest(repo=str(repository))) == project


def test_concurrent_duplicate_import(store, repository):
    with ThreadPoolExecutor(max_workers=4) as pool:
        projects = list(pool.map(lambda _: store.create(CreateProjectRequest(repo=str(repository))), range(4)))
    assert len({p.id for p in projects}) == 1
    assert len(store.list()) == 1


@pytest.mark.parametrize('repo', ['', ' ', 'https://evil.invalid/x/y', 'https://user:NEVER_EMIT_AUTH@github.com/a/b',
                                  'https://github.com/a/b?token=NEVER_EMIT_AUTH', 'git@github.com:a/b',
                                  'https://github.com/../b', 'https://github.com/a/b/tree/main'])
def test_invalid_repository(client, repo):
    response = client.post('/api/projects', json={'repo': repo})
    assert response.status_code == 400
    assert 'NEVER_EMIT_AUTH' not in response.text
    assert client.get('/api/projects').json() == []


def test_missing_local_repo(client, tmp_path):
    assert client.post('/api/projects', json={'repo': str(tmp_path / 'missing')}).status_code == 400


def test_unsupported_repository(client, tmp_path):
    assert client.post('/api/projects', json={'repo': str(tmp_path)}).status_code == 400


@pytest.mark.parametrize('body', [{}, {'repo': 123}, {'repo': 'x', 'name': 1}, {'repo': 'x', 'targets': ['local']},
                                {'repo': 'x', 'targets': ['local', 'bogus']}, {'repo': 'x', 'password': 'NEVER_EMIT_VALIDATION'},
                                {'repo': 'x', 'targets': ['local', 'local']}, {'repo': 'x', 'name': ' '}])
def test_invalid_request_sanitized(client, body):
    response = client.post('/api/projects', json=body)
    assert response.status_code == 400
    assert 'NEVER_EMIT_VALIDATION' not in response.text


def test_cors_preflight(client):
    response = client.options('/api/projects', headers={'Origin': 'http://localhost:3700',
                                                      'Access-Control-Request-Method': 'POST',
                                                      'Access-Control-Request-Headers': 'content-type'})
    assert response.status_code == 200
    assert response.headers['access-control-allow-origin'] == 'http://localhost:3700'
    denied = client.options('/api/projects', headers={'Origin': 'https://evil.invalid', 'Access-Control-Request-Method': 'POST'})
    assert 'access-control-allow-origin' not in denied.headers


def test_defaults_are_honest(repository):
    (repository / 'src/main/resources/application.yml').unlink()
    result = RepoAnalyzer().analyze(repository)
    assert result.port == 8080 and result.health_path == '/'
    for field in ['port', 'health_path']:
        assert any(e.field == field and e.source == 'default' and e.file is None for e in result.evidence)
    assert any('default' in warning for warning in result.warnings)


def test_conflicting_ports_are_not_claimed_as_detected(repository):
    (repository / 'Dockerfile').write_text('FROM eclipse-temurin:21\nEXPOSE 9000\n', encoding='utf-8')
    result = RepoAnalyzer().analyze(repository)
    assert result.port == 8080
    assert any('Conflicting port' in warning for warning in result.warnings)
    assert any(e.field == 'port' and e.source == 'default' for e in result.evidence)


@pytest.mark.parametrize('filename,contents,stack', [
    ('pom.xml', '<project><properties><java.version>17</java.version></properties><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>', 'spring-boot-maven'),
    ('build.gradle.kts', 'plugins { id("org.springframework.boot") }\njava { toolchain { languageVersion.set(JavaLanguageVersion.of(17)) } }', 'spring-boot-gradle'),
    ('package.json', '{"dependencies":{"next":"15"}}', 'nextjs'),
    ('requirements.txt', 'fastapi==0.115\n', 'fastapi'),
])
def test_supported_manifests(tmp_path, filename, contents, stack):
    (tmp_path / filename).write_text(contents, encoding='utf-8')
    assert RepoAnalyzer().analyze(tmp_path).stack == stack


def test_canonical_github():
    assert normalize_repo('https://github.com/Owner/Board.git/') == normalize_repo('https://github.com/owner/board')


@pytest.mark.parametrize('error', [subprocess.TimeoutExpired('git', 60), subprocess.CalledProcessError(1, 'git', stderr='NEVER_EMIT_CLONE')])
def test_clone_errors_are_safe(client, error):
    with patch('engine.legacy_analyzer.subprocess.run', side_effect=error):
        response = client.post('/api/projects', json={'repo': 'https://github.com/example/board'})
    assert response.status_code == 400
    assert 'NEVER_EMIT_CLONE' not in response.text


def test_remote_analysis_uses_same_team_contract(repository):
    def clone(command, **kwargs):
        import shutil
        destination = Path(command[-1])
        assert 'core.symlinks=false' in command and 'init.templateDir=' in command
        assert kwargs['env']['GIT_TERMINAL_PROMPT'] == '0'
        shutil.copytree(repository, destination)
    with patch('engine.legacy_analyzer.subprocess.run', side_effect=clone):
        analysis = RepoAnalyzer().analyze('https://github.com/example/board')
    assert isinstance(analysis, Analysis)
    assert analysis.stack == 'spring-boot-gradle'


def test_team_sample_without_modification():
    analysis = RepoAnalyzer().analyze(WORKSPACE / 'samples/kty-board')
    assert analysis.stack == 'spring-boot-gradle'
    assert analysis.java_version == 21
    assert analysis.database == 'mysql'
    assert analysis.database_name == 'board_db'
    assert analysis.uses_server_session
    assert len(analysis.routes) >= 10


def test_no_deployments_are_fabricated(client, repository):
    project = client.post('/api/projects', json={'repo': str(repository)}).json()
    assert client.get('/api/deployments', params={'project_id': project['id']}).json() == []
    response = client.post('/api/projects/' + project['id'] + '/deployments', json={'shakedown': True, 'autofix': True})
    assert response.status_code == 501
    assert client.get('/api/projects/' + project['id']).json()['last_deployment'] is None


def test_unexpected_errors_are_sanitized(client):
    with patch('engine.projects.ProjectStore.create', side_effect=RuntimeError('NEVER_EMIT_EXCEPTION')):
        response = client.post('/api/projects', json={'repo': 'https://github.com/example/board'})
    assert response.status_code == 500
    assert 'NEVER_EMIT_EXCEPTION' not in response.text


def test_jdbc_query_credentials_omitted(repository):
    config = repository / 'src/main/resources/application.properties'
    config.write_text('spring.datasource.url=jdbc:mysql://db:3306/board_db?password=NEVER_EMIT_QUERY\n', encoding='utf-8')
    result = RepoAnalyzer().analyze(repository)
    assert 'NEVER_EMIT_QUERY' not in result.model_dump_json()
    assert '?' not in result.env['SPRING_DATASOURCE_URL']


def test_malformed_config_warns_without_echo(repository):
    (repository / 'src/main/resources/application.yml').write_text('spring: [NEVER_EMIT_PARSE\n', encoding='utf-8')
    result = RepoAnalyzer().analyze(repository)
    assert 'NEVER_EMIT_PARSE' not in result.model_dump_json()
    assert any('could not be parsed' in w for w in result.warnings)


def test_env_value_matching_password_is_removed(repository):
    config = repository / 'src/main/resources/application.properties'
    config.write_text('spring.datasource.username=NEVER_EMIT_PASSWORD_123\n', encoding='utf-8')
    analysis = RepoAnalyzer().analyze(repository)
    assert 'NEVER_EMIT_PASSWORD_123' not in analysis.model_dump_json()
    assert 'SPRING_DATASOURCE_USERNAME' not in analysis.env


def test_secret_defaults_in_compose_are_names_only(repository):
    (repository / 'compose.yml').write_text('services:\n  app:\n    environment:\n      API_KEY: ${API_KEY:NEVER_EMIT_DEFAULT}\n      DB_PASSWORD: NEVER_EMIT_COMPOSE\n', encoding='utf-8')
    analysis = RepoAnalyzer().analyze(repository)
    assert {'API_KEY', 'DB_PASSWORD'} <= set(analysis.secret_env)
    assert 'NEVER_EMIT_DEFAULT' not in analysis.model_dump_json()
    assert 'NEVER_EMIT_COMPOSE' not in analysis.model_dump_json()


def test_sensitive_key_contents_are_not_database_evidence(repository):
    config = repository / 'src/main/resources/application.yml'
    config.write_text('spring:\n  datasource:\n    password: jdbc:postgresql:NEVER_EMIT_MARKER\n', encoding='utf-8')
    analysis = RepoAnalyzer().analyze(repository)
    assert analysis.database == 'mysql'  # Only the build dependency establishes it.
    assert 'NEVER_EMIT_MARKER' not in analysis.model_dump_json()


def test_actuator_candidate_has_default_evidence(repository):
    with (repository / 'build.gradle').open('a', encoding='utf-8') as stream:
        stream.write("\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-actuator' }\n")
    analysis = RepoAnalyzer().analyze(repository)
    assert analysis.health_path == '/actuator/health'
    assert any(e.field == 'health_path' and e.source == 'default' for e in analysis.evidence)
    assert any('unverified' in warning for warning in analysis.warnings)


def test_unused_session_import_does_not_claim_session(repository):
    java = repository / 'src/main/java/example/BoardController.java'
    java.write_text('import jakarta.servlet.http.HttpSession;\n@RestController\npublic class BoardController {\n@GetMapping("/")\npublic String index() { return "HttpSession"; }\n}', encoding='utf-8')
    analysis = RepoAnalyzer().analyze(repository)
    assert analysis.uses_server_session is False
    assert any(e.field == 'uses_server_session' and e.source == 'default' for e in analysis.evidence)


def test_implicit_request_params_and_body(repository):
    java = repository / 'src/main/java/example/BoardController.java'
    java.write_text('''@RestController
public class BoardController {
@PostMapping("/submit")
public String submit(@RequestParam String title, @RequestParam(required=false) String content) { return "ok"; }
@PatchMapping("/posts/{id}")
public String update(@RequestBody UpdateRequest request) { return "ok"; }
}''', encoding='utf-8')
    analysis = RepoAnalyzer().analyze(repository)
    assert analysis.routes[0].params == ['title', 'content']
    assert analysis.routes[1].params == ['(JSON body)']


def test_nested_project_is_excluded(repository):
    nested = repository / 'other'
    nested.mkdir()
    (nested / 'package.json').write_text('{"dependencies":{"next":"15"}}', encoding='utf-8')
    analysis = RepoAnalyzer().analyze(repository)
    assert analysis.stack == 'spring-boot-gradle'
    assert any('Nested project' in warning for warning in analysis.warnings)


def test_monorepo_without_root_manifest_is_rejected(tmp_path):
    for folder in ['a', 'b']:
        root = tmp_path / folder
        root.mkdir()
        (root / 'package.json').write_text('{"dependencies":{"next":"15"}}', encoding='utf-8')
    with pytest.raises(AnalysisError):
        RepoAnalyzer().analyze(tmp_path)


def test_file_size_limit_keeps_evidence_honest(repository):
    resources = repository / 'src/main/resources/application.yml'
    resources.write_text('server:\n  port: 9999\n' + '# padding\n' * 100, encoding='utf-8')
    analysis = RepoAnalyzer(max_file_bytes=500).analyze(repository)
    assert analysis.port == 8080
    assert any('size limit' in warning for warning in analysis.warnings)


def test_profile_config_is_not_silently_applied(repository):
    (repository / 'src/main/resources/application-prod.yml').write_text('server:\n  port: 9999\n', encoding='utf-8')
    analysis = RepoAnalyzer().analyze(repository)
    assert analysis.port == 8181
    assert any('active deployment profile' in warning for warning in analysis.warnings)


def test_comment_does_not_detect_framework(tmp_path):
    (tmp_path / 'build.gradle').write_text('// org.springframework.boot\nplugins { id "java" }', encoding='utf-8')
    with pytest.raises(AnalysisError):
        RepoAnalyzer().analyze(tmp_path)


def test_invalid_port_defaults_with_warning(repository):
    (repository / 'src/main/resources/application.yml').write_text('server:\n  port: 99999\n', encoding='utf-8')
    analysis = RepoAnalyzer().analyze(repository)
    assert analysis.port == 8080
    assert any(e.field == 'port' and e.source == 'default' for e in analysis.evidence)


def test_malformed_json_request_does_not_echo(client):
    response = client.post('/api/projects', content='{"repo": "NEVER_EMIT_RAW"', headers={'Content-Type': 'application/json'})
    assert response.status_code == 400
    assert 'NEVER_EMIT_RAW' not in response.text


@pytest.mark.parametrize('annotation', ['@GetMapping(ROUTE_CONSTANT)', '@GetMapping(path={"/a", "/b"})'])
def test_dynamic_route_is_omitted(repository, annotation):
    java = repository / 'src/main/java/example/BoardController.java'
    java.write_text('@RestController\npublic class BoardController {\n' + annotation + '\npublic String index() { return "ok"; }\n}', encoding='utf-8')
    analysis = RepoAnalyzer().analyze(repository)
    assert analysis.routes == []
    assert any('Complex Spring route' in w for w in analysis.warnings)


def test_dynamic_class_prefix_is_not_guessed(repository):
    java = repository / 'src/main/java/example/BoardController.java'
    java.write_text('@RestController\n@RequestMapping(BASE_PATH)\npublic class BoardController {\n@GetMapping("/posts")\npublic String index() { return "ok"; }\n}', encoding='utf-8')
    assert RepoAnalyzer().analyze(repository).routes == []


def test_route_produces_is_not_misread_as_path(repository):
    java = repository / 'src/main/java/example/BoardController.java'
    java.write_text('@RestController\npublic class BoardController {\n@GetMapping(value="/posts", produces="application/json")\npublic String index() { return "ok"; }\n}', encoding='utf-8')
    assert RepoAnalyzer().analyze(repository).routes[0].path == '/posts'
