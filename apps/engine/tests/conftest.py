from pathlib import Path
import uuid
import pytest
from fastapi.testclient import TestClient
from engine.api import create_app
from engine.projects import ProjectStore

@pytest.fixture
def repository(tmp_path):
    root = tmp_path / 'board'
    root.mkdir()
    (root / 'build.gradle').write_text("plugins { id 'org.springframework.boot' version '3.3.0' }\njava { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\ndependencies { runtimeOnly 'com.mysql:mysql-connector-j' }", encoding='utf-8')
    resources = root / 'src/main/resources'
    resources.mkdir(parents=True)
    (resources / 'application.yml').write_text('server:\n  port: 8181\nspring:\n  datasource:\n    url: jdbc:mysql://db:3306/board_db\n    username: app\n    password: NEVER_EMIT_PASSWORD_123\n  jpa:\n    hibernate:\n      ddl-auto: update\n    show-sql: false\nsecurity:\n  api-key: NEVER_EMIT_API_KEY_456\n', encoding='utf-8')
    java = root / 'src/main/java/example'
    java.mkdir(parents=True)
    (java / 'BoardController.java').write_text('''
@RestController
@RequestMapping("/api")
public class BoardController {
    @PostMapping("/login")
    public String login(@RequestParam("email") String email,
                        @RequestParam("password") String password, HttpSession session) { return "ok"; }
    @GetMapping("/posts/{id}")
    public String post() { return "ok"; }
}
''', encoding='utf-8')
    return root

@pytest.fixture
def store(tmp_path):
    return ProjectStore(tmp_path / 'state/projects.sqlite3')

@pytest.fixture
def client(store):
    with TestClient(create_app(store)) as client:
        yield client


def pytest_configure(config):
    # Keep test writes inside engine even when pytest is invoked from repo root.
    if config.option.basetemp is None:
        data = Path(__file__).resolve().parents[1] / '.data'
        data.mkdir(exist_ok=True)
        config.option.basetemp = str(data / ('pytest-' + uuid.uuid4().hex[:12]))
