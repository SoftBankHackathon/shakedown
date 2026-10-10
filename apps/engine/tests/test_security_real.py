"""Optional real scanner-to-engine checks. No LLM, Docker execution or cloud calls."""
from pathlib import Path
from types import SimpleNamespace
import shutil

import pytest
from engine import security
from engine.deployments import LocalRunner
from engine.image_builder import ImageBuilder, PlanRequest

ROOT = security.GATE_ROOT
pytestmark = pytest.mark.skipif(
    not (ROOT / '.venv/bin/semgrep').is_file() or not (ROOT / 'tools/gitleaks/gitleaks').is_file(),
    reason='Requires real project-local Semgrep and Gitleaks CLIs (POSIX)')


@pytest.mark.parametrize('language', ['java', 'javascript', 'typescript', 'python', 'go', 'rust'])
@pytest.mark.parametrize('safe', [True, False])
def test_real_scanner_contract(language, safe):
    name = ('safe' if safe else 'vulnerable')
    if language != 'python': name = language + '_' + name
    root = ROOT / 'tests/fixtures/semgrep' / name
    if safe:
        assert security.require_allow(root)['decision'] == 'ALLOW'
    else:
        with pytest.raises(security.SecurityGateError, match='DENY'):
            security.require_allow(root)


def test_real_java_without_compose_reaches_image_plan(tmp_path):
    source = tmp_path / 'source'
    shutil.copytree(ROOT / 'tests/fixtures/semgrep/java_safe', source)
    (source / 'Dockerfile').write_text('FROM scratch\nCOPY . /src\n')
    builder = ImageBuilder(tmp_path / 'plans', None, LocalRunner())
    try:
        plan = builder.plan(SimpleNamespace(id='java-real', repo=str(source)), PlanRequest(use_ai=False))
        assert plan['source'] == 'existing'
        assert plan['security_gate']['decision'] == 'ALLOW'
    finally:
        builder.close()


def test_real_invalid_java_blocks_image_planning(tmp_path):
    source = tmp_path / 'source'
    source.mkdir()
    (source / 'Broken.java').write_text('class Broken { void broken( {')
    (source / 'Dockerfile').write_text('FROM scratch\nCOPY . /src\n')
    builder = ImageBuilder(tmp_path / 'plans', None, LocalRunner())
    try:
        with pytest.raises(security.SecurityGateError, match='SCAN_FAILED'):
            builder.plan(SimpleNamespace(id='java-invalid', repo=str(source)), PlanRequest(use_ai=False))
    finally:
        builder.close()


@pytest.mark.parametrize('filename,source,decision', [
    ('app.js', 'const value = ;', 'SCAN_FAILED'),
    ('app.ts', 'const value: = ;', 'SCAN_FAILED'),
    ('main.c', 'int main(void) { return 0; }', 'REVIEW'),
    ('main.go', 'package main\nfunc main( {', 'SCAN_FAILED'),
])
def test_real_multilanguage_preflight_blocks_engine(tmp_path, filename, source, decision):
    (tmp_path / filename).write_text(source)
    with pytest.raises(security.SecurityGateError, match=decision):
        security.require_allow(tmp_path)
