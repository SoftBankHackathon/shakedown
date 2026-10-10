"""Real open-source parsers and gate contracts; no project code is executed."""
from pathlib import Path

import pytest

from security_gate import semgrep, source_syntax, source_targets
from security_gate.models import ScanError
from test_semgrep import output_runner

SAMPLES = {
    'java': ('class App {}', 'class Broken { void broken( {'),
    'javascript': ('export const View = () => <div>Hello</div>;', 'const value = ;'),
    'typescript': ('const value: number = 1; interface Item { id: string }', 'const value: = ;'),
    'tsx': ('const View = (p: {name: string}) => <div>{p.name}</div>;', 'const View = () => <div>;'),
    'go': ('package main\nfunc main() {}', 'package main\nfunc main( {'),
    'rust': ('fn main() { let x: i32 = 1; }', 'fn main( {'),
    'c': ('int main(void) { return 0; }', 'int main( {'),
    'cpp': ('namespace demo { template<class T> struct Box { T value; }; }', 'namespace demo { template<'),
    'csharp': ('namespace Demo { class App { static void Main() {} } }', 'class App { void Main( {'),
    'ruby': ('class App\n  def value\n    1\n  end\nend', 'def value('),
    'php': ('<html><?php function value(): int { return 1; } ?></html>', '<?php function value( {'),
}


@pytest.mark.parametrize('suffix', list(source_syntax.SYNTAX_SUFFIXES))
@pytest.mark.parametrize('valid', [True, False])
def test_all_registered_extensions_use_real_parser(suffix, valid):
    grammar = source_syntax.SYNTAX_SUFFIXES[suffix][-1]
    source = SAMPLES[grammar][0 if valid else 1]
    inputs = [(Path('source' + suffix), source)]
    if valid:
        source_syntax.validate_sources(inputs, timeout_seconds=5)
    else:
        with pytest.raises(ScanError, match='^SOURCE_SYNTAX_INVALID$'):
            source_syntax.validate_sources(inputs, timeout_seconds=5)


@pytest.mark.parametrize('suffix', ['.c', '.h', '.cpp', '.cs', '.rb', '.php', '.phtml'])
@pytest.mark.parametrize('valid', [True, False])
def test_syntax_only_language_never_implies_security_approval(tmp_path, suffix, valid):
    grammar = source_syntax.SYNTAX_SUFFIXES[suffix][-1]
    (tmp_path / ('source' + suffix)).write_text(SAMPLES[grammar][0 if valid else 1])
    def unexpected(*args, **kwargs):
        pytest.fail('No Semgrep rules exist for this source')
    report = semgrep.scan_semgrep(tmp_path, runner=unexpected)
    assert report['unsupported_files'] == 1
    assert report['scanned_files'] == 0
    assert report['decision'] == ('DENY' if valid else 'SCAN_FAILED')
    assert report['errors'] == ([] if valid else ['SOURCE_SYNTAX_INVALID'])


def test_mixed_supported_and_syntax_only_repo_is_blocked(tmp_path):
    (tmp_path / 'app.js').write_text('const value = 1;')
    (tmp_path / 'lib.c').write_text(SAMPLES['c'][0])
    report = semgrep.scan_semgrep(tmp_path, runner=output_runner())
    assert report['decision'] == 'DENY'
    assert report['scanned_languages'] == ['javascript']
    assert report['unsupported_languages'] == ['c']


@pytest.mark.parametrize('source', [
    '<script>const value = ;</script>',
    '<button onclick="const value = ;">click</button>',
    '<script type="text/typescript">const value: = ;</script>',
])
def test_extracted_script_syntax_is_checked_using_unit_language(tmp_path, source):
    (tmp_path / 'index.html').write_text(source)
    report = semgrep.scan_semgrep(tmp_path, runner=output_runner())
    assert report['decision'] == 'SCAN_FAILED'
    assert report['errors'] == ['SOURCE_SYNTAX_INVALID']


def test_c_and_cpp_headers_both_parse():
    for source in (SAMPLES['c'][0], SAMPLES['cpp'][0]):
        source_syntax.validate_sources([(Path('shared.h'), source)], timeout_seconds=5)


def test_typescript_angle_assertion_uses_ts_not_tsx():
    source_syntax.validate_sources([(Path('app.ts'), 'const x = <number>value;')], timeout_seconds=5)


def test_syntax_only_files_obey_existing_limits(tmp_path):
    (tmp_path / 'lib.go').write_text(SAMPLES['go'][0] * 30)
    report = semgrep.scan_semgrep(tmp_path, max_file_bytes=16, runner=output_runner())
    assert report['errors'] == ['FILE_SIZE_LIMIT_EXCEEDED']


def test_syntax_only_sources_count_toward_total_size(tmp_path, monkeypatch):
    monkeypatch.setattr(source_targets, 'MAX_TOTAL_BYTES', 30)
    (tmp_path / 'lib.c').write_text(SAMPLES['c'][0])
    (tmp_path / 'lib.rs').write_text(SAMPLES['rust'][0])
    report = semgrep.scan_semgrep(tmp_path, runner=output_runner())
    assert report['errors'] == ['SOURCE_TOTAL_SIZE_LIMIT_EXCEEDED']
