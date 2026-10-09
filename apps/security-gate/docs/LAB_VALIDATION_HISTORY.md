# Original lab validation history

This is historical validation of the source lab, not a claim that optional scanner binaries are installed in this checkout. Local paths have been anonymized; use the package README for current setup.

# Security Gate Lab — 독립 Security Gate MVP / STEP 4 최종 검증

독립적인 Python 정적 검사기입니다. 기본 CLI는 Docker Compose의 `services.*.privileged`, `--with-semgrep`은 Python AST·Semgrep, `--with-gitleaks`는 세 도구의 전체 검사를 선택합니다.
검사 대상 코드·스크립트, Docker, 셸 명령, 환경변수 치환을 실행하지 않습니다.
`ALLOW`는 활성화한 필수 검사가 정의한 제한된 정책을 통과했다는 뜻입니다. 기본 CLI의 ALLOW는 Docker privileged 검사 통과이며 전체 보안 승인이 아닙니다.

## Windows PowerShell 실행

모든 명령은 다음 작업 폴더에서 실행합니다. 설치에 네트워크 권한이 필요하면 임의로 권한을 확대하지 말고 승인된 일반 PowerShell에서 설치하세요.

```powershell
Set-Location '<SECURITY_GATE_ROOT>'
python -m venv .venv  # 기존 .venv가 있으면 생략
New-Item -ItemType Directory -Force -Path .tmp | Out-Null
$env:TEMP = Join-Path $PWD '.tmp'
$env:TMP = $env:TEMP
.\.venv\Scripts\python.exe -m pip install --cache-dir .pip-cache -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q

# 정적 검사 예제: stdout에 JSON 보고서 출력
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\safe
$LASTEXITCODE  # 0: ALLOW
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\deny
$LASTEXITCODE  # 1: DENY
.\.venv\Scripts\python.exe -m security_gate .\tests\fixtures\dynamic
$LASTEXITCODE  # 2: REVIEW

# 임의의 로컬 디렉터리 또는 이름이 일치하는 Compose 파일
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\safe\compose.yaml --max-file-bytes 1048576 --timeout-seconds 5
```

실행 전 대상 경로가 허용된 작업 범위 안에 있는지 확인하세요. 검사기는 로컬 경로를 읽는 도구이며 임의 경로 접근을 별도로 허가하는 도구가 아닙니다.
pytest 임시 파일은 `pytest.ini`에 따라 작업 폴더의 `.pytest-tmp`에 생성됩니다.
검사기만 사용할 경우 `requirements.txt`로 설치하면 됩니다. `requirements-dev.txt`에는 pytest와 jsonschema가 추가됩니다.

## 탐색과 판정

디렉터리를 재귀 탐색해 이름이 정확히 `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`인 파일을 모두 검사합니다.
다른 이름의 파일을 직접 지정하면 검사 대상이 없는 것으로 처리합니다. 숨김 폴더와 가상환경도 제외하지 않으므로 검사할 디렉터리를 좁혀 지정하세요.

| 판정 | 검사 상태 | 종료 코드 | 의미 |
| --- | --- | --- | --- |
| ALLOW | SUCCESS | 0 | 최소 한 파일의 서비스 검사를 성공했고 privileged 위험·불확실성이 없음 |
| DENY | SUCCESS | 1 | privileged가 YAML boolean true 또는 문자열 true로 지정됨 |
| REVIEW | SUCCESS | 2 | 환경변수 식, null, 숫자, 문자열 false 등 확정할 수 없는 값 |
| REVIEW | NOT_APPLICABLE | 2 | 일치하는 검사 파일이 없음 |
| SCAN_FAILED | FAILED | 3 | 경로·읽기·YAML·구조 오류, 안전 제한 초과, 워커 실패 |

`privileged`가 없거나 boolean false인 서비스는 해당 규칙을 통과합니다. 빈/누락 services, 서비스 값이 객체가 아닌 경우는 실패합니다.
복수 파일의 전체 판정 우선순위는 `SCAN_FAILED > DENY > REVIEW > ALLOW`입니다.
위험 발견과 실패가 섞이면 위험 근거를 유지하면서 전체 판정은 SCAN_FAILED입니다. 실패·파일 없음에 자동 ALLOW를 적용하지 않습니다.
CLI 인자 자체가 잘못된 경우 argparse의 사용 오류 메시지와 종료 코드 2를 반환하며 JSON 검사 보고서는 생성하지 않습니다.

## JSON 보고서

계약은 `security_gate/report.schema.json`에 있습니다. 예를 들어 DENY 근거는 다음 필드를 포함합니다.

```json
{
  "decision": "DENY",
  "file_path": "<absolute compose path>",
  "service": "admin",
  "rule_id": "DOCKER_COMPOSE_PRIVILEGED",
  "reason_code": "PRIVILEGED_ENABLED",
  "location": {"line": 4, "column": 17, "path": ["services", "admin", "privileged"]}
}
```

행·열은 1부터 시작하며 privileged 값의 위치를 가리킵니다. 실제 설정값, 환경변수 값, 전체 소스, 파서 예외 원문은 출력하지 않습니다.
요청한 파일 경로와 서비스명은 근거 식별을 위해 보고서에 포함되므로 보고서를 공유할 때 이 메타데이터도 고려하세요.

## 안전 제한과 범위

- PyYAML `safe_load`로만 값 구성. 토큰과 노드 검사 후 파싱합니다. 별칭·앵커·모든 명시적 YAML 태그·중복 키·비문자열/merge 키는 지원하지 않고 SCAN_FAILED로 처리합니다.
- 기본 파일 크기 1 MiB(사용자 설정 1 byte–16 MiB), 전체 읽은 UTF-8 내용 8 MiB, 보고서 근거 1,000개, 서비스명 길이 256자로 제한합니다.
- 탐색 항목 10,000개, Compose 파일 256개, 디렉터리 깊이 64, YAML 깊이 64, YAML 토큰 100,000개를 제한합니다.
- 기본 전체 검사 시간은 워커 시작·탐색·파싱을 포함해 5초(설정 최대 60초)입니다. 별도 프로세스를 종료해 실패 처리하며 워커 정리에 최대 약 1.1초가 추가될 수 있습니다. 운영체제 프로세스 시작 자체의 지연까지 보장하는 실시간 제한은 아닙니다.
- 심볼릭 링크와 Windows reparse point/junction, 경로의 링크 조상은 거부합니다. 파일 열기 전후 종류와 식별자를 비교하고 가능한 OS에서는 `O_NOFOLLOW`를 사용합니다. 동시 파일 변경에 대한 완전한 OS 보안 격리는 제공하지 않으므로 변경되지 않는 로컬 스냅샷을 권장합니다.
- UTF-8/UTF-8 BOM을 지원합니다. 환경변수 치환, `.env`, Compose override 병합, `include`, `extends`, 외부 파일 해석은 하지 않습니다. 발견한 각 파일의 직접 선언만 검사합니다.
- PyYAML의 YAML 1.1 boolean 해석을 사용합니다. Docker Compose 자체의 전체 스키마/실행 동작을 검증하지 않습니다. 특권 외 네트워크·볼륨·capabilities 등 위험은 이 단계의 범위 밖입니다.
- 심볼릭 링크 생성이 권한상 불가능한 환경에서는 해당 실제 링크 테스트가 SKIP되며 권한 확대를 시도하지 않습니다. pytest 요약의 skipped도 확인하세요.

## 모듈과 다음 단계

`discovery.py`는 파일 탐색, `parsing.py`는 안전 읽기·파싱, `rules/privileged.py`는 규칙, `models.py`는 판정 집계, `scanner.py`는 실행 제한, `cli.py`는 JSON CLI를 담당합니다.
fixture와 자동화 테스트는 판정·위치·JSON 스키마·비밀값 비노출·실패 시 승인 방지·제한 처리를 검증합니다.

STEP 1의 `scan()` API, 기본 CLI, `report.schema.json`의 버전 1.0 계약을 유지합니다.
STEP 2는 별도 Semgrep 모듈과 선택 가능한 통합 CLI를 추가합니다. Gitleaks, GitHub Clone, Engine 연동은 구현하거나 실행하지 않았습니다.

## STEP 2 — Semgrep 연동

`security_gate/semgrep.py`는 Semgrep CLI 어댑터, `source_targets.py`는 Python 소스 탐색, `gate.py`는 두 검사 결과의 통합을 담당합니다.
Semgrep은 선택적 의존성이며, 검사기 프로젝트의 `.venv/Scripts/semgrep.exe`(Windows) 또는 `.venv/bin/semgrep`(POSIX)에 설치된 CLI만 사용합니다.
검사 대상의 실행 파일이나 PATH에서 찾은 다른 실행 파일을 호출하지 않습니다. 미설치 시 Python 검사 결과는 `SCAN_FAILED / SEMGREP_NOT_INSTALLED`입니다.
Python 파일이 전혀 없으면 `NOT_APPLICABLE / REVIEW`이며 Semgrep을 실행하지 않습니다.

현재 Semgrep은 [Windows에서도 공식적으로 지원합니다](https://semgrep.dev/blog/2025/semgrep-community-edition-fall-release-2025).
이 작업 환경에 설치하지 못해도 모의 테스트는 독립적으로 실행할 수 있습니다. 설치에 권한 확대가 필요하면 임의로 진행하지 않습니다.

```powershell
Set-Location '<SECURITY_GATE_ROOT>'
New-Item -ItemType Directory -Force -Path .tmp | Out-Null
$env:TEMP = Join-Path $PWD '.tmp'
$env:TMP = $env:TEMP

# 선택적 설치: 허용된 일반 PowerShell 환경에서 수행
.\.venv\Scripts\python.exe -m pip install --cache-dir .pip-cache -r requirements-semgrep.txt
.\.venv\Scripts\semgrep.exe --version

# 기존 STEP 1 출력(버전 1.0)
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\safe

# STEP 2 통합 출력(버전 2.0), 검사 대상은 실행하지 않음
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\semgrep\vulnerable --with-semgrep
$LASTEXITCODE  # Semgrep 탐지 검증 성공 시 1: DENY
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\semgrep\safe --with-semgrep --semgrep-timeout-seconds 30
$LASTEXITCODE  # 두 검사 모두 성공 시 0: ALLOW

# 전체 회귀 + 모의 + 설치되어 있으면 실제 CLI 검사
.\.venv\Scripts\python.exe -m pytest -q -rs
# 실제 CLI 검사만: 설치되지 않았으면 명시적으로 SKIP
.\.venv\Scripts\python.exe -m pytest -q -rs -m semgrep_real
# 실제 CLI 검사 제외: STEP 1 및 모의/어댑터 검증
.\.venv\Scripts\python.exe -m pytest -q -rs -m 'not semgrep_real'
```

위 예제의 위험 Python fixture는 **정적 검사 대상**입니다. 해당 `sample.py`를 직접 실행하지 마세요.
실제 CLI 테스트는 모의 실행을 사용하지 않으며, 설치된 Semgrep이 오류를 내면 SKIP하지 않고 테스트를 실패시킵니다.
`tests/test_semgrep.py`의 모의 테스트는 결과 정규화와 실패 처리만 검증합니다. 모의 JSON에 있는 탐지 결과를 실제 규칙의 탐지 성공으로 간주하지 않습니다.

### 로컬 규칙과 검사 범위

고정된 `semgrep_rules/python-security.yml`만 `--config`로 전달합니다. Registry, URL, `auto`, 원격 규칙 다운로드를 사용하지 않습니다.

| 규칙 ID | 패턴 | 위험도 | 판정 / 이유 코드 |
| --- | --- | --- | --- |
| security-gate-python-eval | `eval(...)` | HIGH | DENY / PYTHON_DYNAMIC_EVAL |
| security-gate-python-shell-true | `subprocess.run/call/Popen/check_call/check_output(..., shell=True, ...)` | HIGH | DENY / PYTHON_SHELL_EXECUTION |

이는 MVP의 직접 호출 패턴 검사입니다. 입력의 실제 신뢰도, 복잡한 별칭·래퍼, 동적으로 계산한 `shell` 값, 다른 언어, 전체 취약점 범주를 판단하지 않습니다.
`eval`의 상수 입력도 차단할 수 있습니다. 정상 fixture는 `ast.literal_eval`과 `shell=False`를 사용합니다.
외부 Repository를 새로 가져오지 않고, 허가된 로컬 디렉터리의 `.py` 파일만 읽습니다.
`.git`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.pytest-tmp`, `.tmp`, `.pip-cache` 이름은 소스 탐색에서 제외됩니다. 이 제외는 기존 Docker 탐색에는 적용되지 않습니다.

### 실행 제한과 비밀값 보호

- `.py` 파일 최대 256개, 탐색 항목 10,000개, 깊이 64, 기본 파일당 1 MiB, 누적 UTF-8 내용 8 MiB로 제한합니다. 링크와 reparse point는 제외 디렉터리 밖에서 모두 거부합니다.
- 소스를 작업 폴더의 `.tmp/semgrep-*`에 익명 파일명으로 복사합니다. 대상의 `.semgrepignore`, `.semgrep.yml`, `.git` 설정은 복사하거나 사용하지 않습니다. fixture 경로의 소스는 Python으로 import/실행하지 않습니다.
- `semgrep scan`을 인자 배열과 `shell=False`로 호출합니다. 로컬 빌드, autofix, Pro/Secrets 기능을 활성화하지 않습니다. `--oss-only`, `--metrics off`, `--disable-version-check`, `--no-secrets-validation`을 사용하고 인증·규칙·Python 경로 관련 외부 환경변수는 전달하지 않습니다.
- [공식 CLI 옵션](https://semgrep.dev/docs/cli-reference)에 따라 `--strict`, `--error`, `--disable-nosem`, `--no-git-ignore`, `--no-rewrite-rule-ids`를 사용합니다. 사용 중인 버전에서 옵션을 지원하지 않으면 실행 실패로 처리합니다.
- 전체 준비와 CLI 실행의 기본 제한은 30초(최대 120초), Semgrep 규칙/파일당 제한은 5초, 메모리 설정은 256 MiB입니다. 준비 이후 남은 시간을 CLI에 전달합니다. OS I/O·프로세스 시작·결과 정규화와 정리까지의 엄격한 실시간 상한은 보장하지 않습니다.
- 시간 초과/출력 제한 시 프로세스를 중단합니다. Windows는 `taskkill /T /F`, POSIX는 프로세스 그룹 종료를 사용합니다. 종료·임시 폴더 정리 시간이 추가될 수 있으며 OS 권한 때문에 자식 프로세스 종료가 실패하는 상황까지 보안 격리로 보장하지 않습니다.
- CLI stdout 8 MiB, stderr 1 MiB, 탐지 결과 1,000개로 제한합니다. raw 출력은 임시 파일에만 보관하고 정리합니다. 보고서에는 `extra.message`, 코드 줄, metavars, trace, stdout/stderr, 예외 원문을 전달하지 않습니다.
- Semgrep의 `paths.scanned`가 복사한 전체 파일과 일치해야 성공합니다. 누락·범위 밖 경로·알 수 없는 규칙·JSON 구조 오류·파싱 오류·Semgrep 오류는 SCAN_FAILED입니다. 크기 제한 등으로 일부 파일만 검사된 결과를 ALLOW로 처리하지 않습니다.
- Python 소스는 Semgrep 전에 아래 AST 사전 검증도 통과해야 합니다. `scanned` 포함과 빈 `errors`만으로 Python 문법의 유효성을 판단하지 않습니다.
- 신뢰된 로컬 규칙과 위 옵션으로 네트워크 동작을 억제합니다. 이 Python 어댑터 자체는 운영체제 수준의 네트워크/파일시스템 샌드박스를 제공하지 않습니다. 소스 동시 변경에 대한 완전한 격리도 보장하지 않습니다.

### 통합 JSON 계약

`--with-semgrep` 또는 `security_gate.gate.scan_repository(path)`를 사용하면 `schema_version: "2.0"` 보고서를 반환합니다.
`docker_compose`에는 기존 1.0 보고서 전체가 들어 있고 `semgrep`에는 도구별 결과가 들어 있습니다. 최상위 `findings`에는 두 도구의 공통 근거 필드를 모읍니다.

```json
{
  "tool": "semgrep",
  "rule_id": "security-gate-python-eval",
  "severity": "HIGH",
  "file_path": "<original absolute source path>",
  "line": 5,
  "decision": "DENY",
  "reason_code": "PYTHON_DYNAMIC_EVAL"
}
```

우선순위와 종료 코드는 STEP 1과 동일합니다. 한 도구가 실패하면 전체 SCAN_FAILED이며, 다른 도구의 탐지 근거는 유지합니다.
두 검사가 모두 명시적으로 ALLOW여야 전체 ALLOW입니다. Compose 파일이 없는 Python Repository는 STEP 1의 NOT_APPLICABLE / REVIEW를 유지하므로 전체 REVIEW입니다.
Docker 근거의 서비스명·행·열은 원본 `docker_compose` 보고서에 보존됩니다. 경로와 서비스명은 식별 메타데이터로 출력하지만 비밀값 원문은 출력하지 않습니다.
`security_gate/gate.schema.json`은 버전 2.0 계약입니다. 오프라인 JSON Schema 검증 시 기존 `report.schema.json`을 `urn:security-gate:docker-report:v1`로 등록해야 합니다. `tests/test_semgrep.py`의 Registry 예제를 참고하세요. 원격 스키마 조회는 필요하지 않습니다.

### 미검증 심볼릭 링크와 외부 Repository 검사 전 확인

STEP 1 실제 검증은 `58 passed / 3 skipped / 0 failed`입니다. 미검증 3개는 파일 링크, 디렉터리 링크, 직접 지정 경로의 링크 조상이며 Windows `os.symlink` 생성이 OSError로 실패했습니다.
기존 링크 거부 코드는 유지합니다. 이번 작업에서 관리자 권한 요청, 개발자 모드 활성화, Windows 설정 변경을 하지 않습니다.

실제 외부 Repository 검사 전에는 이미 링크 생성 권한이 있는 승인된 환경(예: 기존 Linux 테스트 환경)에서 허가된 작업 폴더 안의 fixture만 사용해 다음 검증을 수행해야 합니다. 이 단계에서 새 Clone이나 외부 Repository 접근은 수행하지 않았습니다.

```powershell
.\.venv\Scripts\python.exe -m pytest -q -rs tests\test_security_gate.py -k real_symlink
```

세 경우가 SKIP 없이 통과하는지 확인하세요. Windows junction/reparse point의 실제 파일시스템 검증도 필요합니다. 현재 reparse 속성 분기는 단위 테스트로만 확인합니다.
링크가 정상 파일 검사로 넘어가지 않고 SCAN_FAILED가 되며, 링크 대상 내용을 읽거나 실행하지 않는지를 승인된 고정 스냅샷에서 확인해야 합니다.
Semgrep 소스 탐색과 익명 경로의 범위 검사도 별도로 검증하세요. 현재 모의 경로 이탈 테스트는 Semgrep JSON의 잘못된 경로가 보고서로 넘어가는 것을 방지하는 검증이며 실제 링크 생성 검증을 대체하지 않습니다.

### STEP 3 준비

도구 어댑터, 도구별 결과, 공통 근거 필드, 실패 우선 집계, CLI runner 주입 지점을 분리했습니다.
STEP 2에서 마련한 구조를 바탕으로 아래 STEP 3에 Gitleaks 어댑터와 로컬 설정을 추가했습니다. 기존 Engine과 실제로 연동하지 않습니다.

### STEP 2 초기 연동의 검증 기록

2026-10-09 작업 환경(Python 3.12.10, PyYAML 6.0.3, pytest 9.1.1, jsonschema 4.26.0)에서 전체 테스트는 **102 passed / 7 skipped / 0 failed**입니다.
STEP 1은 기존 테스트 파일을 수정하지 않고 58 passed / 3 skipped를 유지했습니다. 추가한 어댑터·모의·통합·로컬 규칙 구성 테스트는 44개 통과했습니다.
실제 Semgrep CLI는 설치되지 않았으며 설치·다운로드·권한 확대를 수행하지 않았습니다. 실제 CLI 테스트 4개는 미설치 사유로 건너뛰었습니다.
따라서 실제 `eval`/`shell=True` 탐지 성공 사례는 아직 없으며, 로컬 규칙의 실제 문법·매칭, Semgrep core 실행과 OS별 자식 프로세스 종료 동작도 실제 엔진으로 미검증입니다.
CLI 직접 실행에서는 Semgrep 미설치가 전체 SCAN_FAILED로 반환되는 것을 확인했습니다. 기존 심볼릭 링크 3개와 실제 junction 검증도 앞 절의 미검증 항목으로 남습니다.
Semgrep 설치 후 위 `semgrep_real` 테스트와 전체 테스트를 재실행하고 이 기록과 구분해 새 검증 결과를 남기세요.

### Semgrep 1.180.0 진단에 따른 Python 구문 사전 검증

사용자가 일반 PowerShell에서 확인한 실제 CLI 결과는 정상 코드 exit 0 / 탐지 0건, 취약 코드 exit 1 / 탐지 2건, invalid 코드 exit 0 / 탐지 0건입니다.
세 파일 모두 `scanned`에 포함되었고 `errors`는 비어 있었습니다. `--strict`와 `--verbose`도 invalid의 오류를 보고하지 않았습니다.
이는 어댑터가 JSON 오류를 무시한 경우가 아니라, Semgrep의 성공 출력만으로 Python 문법의 유효성을 확인할 수 없었던 경우입니다.
`tests/fixtures/semgrep/invalid/sample.py`는 Python 3.12.10의 `ast.parse()`에서 `SyntaxError: '(' was never closed`가 발생하는 실제 구문 오류입니다.

`security_gate/source_syntax.py`를 추가하여 크기·경로·링크 검사를 통과한 소스 문자열 전체를 Semgrep 호출 전에 `ast.parse(..., mode="exec")`로 검사합니다.
검증한 문자열과 Semgrep에 복사하는 문자열은 동일합니다. 구문 검증에 실패하면 Semgrep을 호출하지 않으며 다음 코드로 SCAN_FAILED를 반환합니다.

| 오류 코드 | 의미 |
| --- | --- |
| SOURCE_SYNTAX_INVALID | 실행 중인 Python 문법으로 AST를 생성할 수 없음 |
| SOURCE_SYNTAX_TIMEOUT | 구문 검증에 배정한 시간이 만료됨 |
| SOURCE_SYNTAX_CHECK_FAILED | 검증 프로세스 시작 실패, 자원 오류, 비정상 종료 등 |

별도 Python 프로세스를 `-I -S -B`와 `shell=False`로 실행하고, 대상은 stdin의 JSON 문자열 데이터로만 전달합니다.
검증 프로세스는 대상 파일을 열거나 import/실행하지 않으며, 대상의 bytecode 또는 pyc를 만들지 않습니다.
`-I -S`는 환경변수·사용자 모듈·site 초기화의 영향을 줄이고 `-B`는 모듈 캐시 쓰기를 막습니다. 이는 OS 권한 격리를 추가하는 옵션은 아닙니다.
소스의 크기·누적 크기 제한과 심볼릭 링크 거부는 기존 읽기 단계에 그대로 적용됩니다. AST 검증은 전체 Semgrep 시간 예산에서 남은 시간을 사용합니다.
stderr와 소스 원문은 보고하지 않습니다. 복잡한 AST 입력이 Python 프로세스를 비정상 종료시켜도 부모 검사기는 자동 승인하지 않습니다.

검사 문법은 Security Gate를 실행하는 Python 버전에 따릅니다. 현재 검증 버전은 Python 3.12.10입니다.
다른 버전, 특히 더 새로운 Python 버전에서만 유효한 구문도 현재 인터프리터가 파싱하지 못하면 SOURCE_SYNTAX_INVALID로 처리합니다.
이 사전 검증은 [AST 생성 단계](https://docs.python.org/3.12/library/ast.html#ast.parse)에 한정됩니다. 타입·이름·스코프·정식 컴파일·런타임 유효성 전체를 검증하는 것은 아닙니다.
AST 생성 자체의 자원 사용은 크기 및 시간으로 제한하지만, 별도의 OS 메모리 상한은 추가하지 않았습니다.

Semgrep의 exit 1은 검증된 탐지 결과가 있으면 기존과 같이 DENY이며 도구 실패로 바꾸지 않습니다.
JSON 1.0/2.0 스키마와 기본 Docker CLI는 변경하지 않았습니다. 기존 실패 테스트와 invalid fixture를 유지하고 SOURCE_SYNTAX_INVALID 검증을 강화했습니다.

### 구문 오류 수정의 현재 검증 결과

샌드박스에서 Semgrep 실제 CLI 테스트를 제외한 명령은 다음과 같습니다.

```powershell
.\.venv\Scripts\python.exe -m pytest -q -rs -m 'not semgrep_real'
```

결과는 **124 passed / 3 skipped / 0 failed / 4 deselected**입니다. STEP 1의 58개 통과 테스트와 실제 AST 파싱, 소스 미실행, 크기·링크·시간 제한, 오류 비노출, 통합 JSON 스키마 및 모의 Semgrep 탐지/실패 처리를 포함합니다.
3개 SKIP은 기존 Windows 실제 심볼릭 링크 생성 실패입니다. 실제 Semgrep 테스트 4개는 삭제하거나 조건을 완화하지 않고 이 명령에서만 선택하지 않았습니다.
invalid fixture의 통합 CLI는 `SCAN_FAILED`, `errors: ["SOURCE_SYNTAX_INVALID"]`, 종료 코드 3을 확인했습니다. 이 경로는 Semgrep을 실행하기 전에 실패합니다.

현재 작업 폴더의 `.tmp/semgrep-diagnostics/summary.json`은 앞선 제한 환경 재실행으로 덮어쓴 exit 2 / valid_json false 기록이며, 사용자 확인의 정상 진단 결과와 다릅니다.
앞선 stderr는 `CertOpenSystemStore returned NULL` 시작 오류입니다. 사용자 제공의 exit 0/1/0 결과는 위에 별도 출처로 기록했으며 현재 파일을 정상 결과로 재작성하지 않았습니다.
진단 스크립트 재실행, 샌드박스 외부 권한 요청, 관리자 권한 또는 시스템 설정 변경은 이 검증을 위해 하지 않습니다.

최종 수정본의 실제 Semgrep 및 전체 테스트는 일반 PowerShell에서 사용자가 다음 명령으로 확인합니다. 진단 스크립트는 다시 실행할 필요가 없습니다.

```powershell
Set-Location '<SECURITY_GATE_ROOT>'
.\.venv\Scripts\python.exe -m pytest -q -rs
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\semgrep\safe --with-semgrep
$LASTEXITCODE  # 예상: 0 / ALLOW
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\semgrep\vulnerable --with-semgrep
$LASTEXITCODE  # 예상: 1 / DENY, 탐지 2건
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\semgrep\invalid --with-semgrep
$LASTEXITCODE  # 확인됨: 3 / SCAN_FAILED / SOURCE_SYNTAX_INVALID
```

위 safe/vulnerable 결과는 최종 수정본을 일반 PowerShell에서 재검증할 기대값이며, 이번 샌드박스 검증에서 새로 실행한 실제 CLI 성공 결과로 보고하지 않습니다.

## STEP 3 — Gitleaks 디렉터리 Secret 검사

`security_gate/gitleaks.py`는 독립 Gitleaks 어댑터, `secret_targets.py`는 UTF-8 텍스트 수집, `gate3.py`는 세 도구 결과의 통합을 담당합니다.
Gitleaks는 Python 패키지가 아닌 네이티브 CLI입니다. 자동 설치나 다운로드를 수행하지 않습니다.
프로젝트의 `tools/gitleaks/gitleaks.exe`(Windows), `tools/gitleaks/gitleaks`(POSIX)만 사용하며 PATH나 검사 대상에서 실행 파일을 찾지 않습니다.
스캔마다 먼저 설치 여부와 `gitleaks version` 결과를 확인합니다. 지원 정책은 8.24.2 이상 8.x이며 지원하지 않는 버전·버전 확인 실패·미설치는 SCAN_FAILED입니다.

### 일반 PowerShell 설치와 실행

[공식 Releases](https://github.com/gitleaks/gitleaks/releases)에서 지원 버전의 Windows 아키텍처에 맞는 ZIP을 작업 폴더의 `.tmp/gitleaks.zip`으로 다운로드하세요.
같은 릴리스의 체크섬과 비교한 뒤 작업 폴더 안에 압축을 해제합니다. Clone, Docker, 시스템 PATH 변경, 관리자 권한은 필요하지 않습니다.

```powershell
Set-Location '<SECURITY_GATE_ROOT>'
New-Item -ItemType Directory -Force -Path .tmp, tools\gitleaks | Out-Null
# 공식 릴리스 ZIP을 .tmp\gitleaks.zip으로 저장한 뒤 확인/해제
Get-FileHash -Algorithm SHA256 -LiteralPath .tmp\gitleaks.zip
Expand-Archive -LiteralPath .tmp\gitleaks.zip -DestinationPath tools\gitleaks
.\tools\gitleaks\gitleaks.exe version

# JSON 1.0: 기존 Docker 검사
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\safe
# JSON 2.0: 기존 Docker + Semgrep
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\semgrep\safe --with-semgrep
# JSON 3.0: Docker + Semgrep + Gitleaks 모두 필수 검사로 활성화
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\gitleaks\safe --with-gitleaks
$LASTEXITCODE  # 설치/검사가 모두 성공하면 0: ALLOW
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\gitleaks\secret --with-gitleaks --gitleaks-timeout-seconds 30
$LASTEXITCODE  # 실제 가짜 토큰 탐지가 성공하면 1: DENY

# 전체 회귀 테스트
.\.venv\Scripts\python.exe -m pytest -q -rs
# 모의 Gitleaks + 실제 AST + STEP 1 회귀; 실제 CLI 테스트만 제외
.\.venv\Scripts\python.exe -m pytest -q -rs -m 'not semgrep_real and not gitleaks_real'
# 실제 Gitleaks: 설치되지 않았으면 미설치 사유로 SKIP
.\.venv\Scripts\python.exe -m pytest -q -rs -m gitleaks_real
```

`--with-gitleaks`는 Semgrep도 활성화합니다. 두 옵션을 모두 지정해도 JSON 3.0을 반환합니다. 각 도구 시간 제한은 별도이며 전체 실행은 그 합과 준비·정리 시간이 될 수 있습니다.
소스 fixture를 직접 실행하지 마세요. Gitleaks 미설치 상태에서는 `GITLEAKS_NOT_INSTALLED`와 전체 SCAN_FAILED가 예상됩니다.
단독 Python API는 `security_gate.gitleaks.scan_gitleaks(path)`, 통합 API는 `security_gate.gate3.scan_full_repository(path)`입니다.

### 탐지 정책과 안전한 입력

[공식 디렉터리 모드](https://github.com/gitleaks/gitleaks/blob/master/README.md#dir)인 `gitleaks dir`만 사용합니다. Git history, Git 명령, remote, 네트워크 비밀키 검증은 사용하지 않습니다.
고정 `gitleaks_rules/gitleaks.toml`은 설치한 바이너리 내장 기본 규칙을 확장합니다. 규칙을 네트워크에서 동적으로 내려받지 않습니다.
내장 규칙은 API key·token 등 알려진 Secret 형식을 찾고, 추가 로컬 규칙 `security-gate-lab-api-token`은 서비스에서 발급하지 않은 `SGLAB_FAKE_TOKEN_` 테스트 네임스페이스만 검사합니다.
fixture는 실제 유효한 비밀키를 포함하지 않습니다. 실제 엔진 탐지가 검증되지 않은 동안 모의 결과를 실제 성공 사례로 보고하지 않습니다.

- 모든 일반 파일을 UTF-8/UTF-8 BOM 텍스트로 읽습니다. 숨김 파일과 `.env`도 포함됩니다. 파일 256개, 항목 10,000개, 디렉터리 깊이 64, 기본 파일당 1 MiB, 누적 8 MiB를 제한합니다.
- `.git`, `.venv`, `venv`, `node_modules`, `__pycache__`, `.pytest_cache`, `.pytest-tmp`, `.tmp`, `.pip-cache` 디렉터리는 검사 범위에서 제외합니다. 링크/reparse point는 제외 이름이어도 거부합니다.
- NUL·지원하지 않는 인코딩·파일 크기 초과·특수 파일·읽기 오류를 조용히 건너뛰지 않고 SCAN_FAILED로 처리합니다. 바이너리/아카이브가 포함된 디렉터리는 이 MVP 텍스트 검사 범위로 자동 승인되지 않습니다.
- 기존 안전 읽기의 링크 거부와 파일 열기 전후 식별자 비교를 사용합니다. 검사 대상 소스는 import/실행하지 않습니다. Python 구문 오류 파일도 Secret 검사 자체에서는 텍스트로 검사할 수 있지만, 통합 판정은 기존 AST 실패를 유지합니다.
- 내용은 `.tmp/gitleaks-*`의 `input` 디렉터리에 익명 `.txt` 파일명으로 복사합니다. 검사 대상의 설정·ignore 파일은 정책으로 사용하지 않고 일반 내용으로만 검사합니다.
- 고정 `--config`, 빈 별도 `.gitleaksignore`, `--ignore-gitleaks-allow`를 사용하며 외부 `GITLEAKS_CONFIG*`와 PATH를 전달하지 않습니다. 보고서 경로는 `input` 밖에 두어 자기 보고서를 재검사하지 않습니다.
- 파일당 엔진 크기 제한으로 조용히 생략하지 않도록 입력 크기를 어댑터에서 먼저 제한합니다. 아카이브 탐색·재귀 디코딩은 비활성화합니다.

### 종료 코드와 Secret 원문 보호

Secret 탐지에는 `--exit-code 10`을 지정합니다. 0과 빈 보고서는 ALLOW, 10과 유효한 탐지 보고서는 DENY입니다.
그 외 종료 코드, 탐지 수와 종료 코드 불일치, 누락 보고서, 잘못된 JSON/필드, 오류 로그, 시간 초과, 정리 실패는 SCAN_FAILED입니다.
`--log-level error`에서 stderr가 발생하면 원문을 보관·출력하지 않고 GITLEAKS_SCAN_ERRORS로 처리합니다. 로그나 예외에 있는 원문을 보고서로 전달하지 않습니다.

`--redact=100`, `--no-banner`, `--no-color`를 지정합니다. 스캔 stdout/stderr는 파이프로 크기만 확인하며 내용은 버립니다. 버전 stdout도 숫자 버전 형식만 허용합니다.
최종 근거에는 다음 7개 필드만 있습니다. Secret, Match, Description, Fingerprint, Author, Email, 주변 코드 등은 전달하지 않습니다.

```json
{
  "tool": "gitleaks",
  "rule_id": "security-gate-lab-api-token",
  "file_path": "<original absolute source path>",
  "line": 2,
  "severity": "HIGH",
  "reason_code": "SECRET_EXPOSURE",
  "decision": "DENY"
}
```

원본 JSON 보고서는 엔진 버전에 따라 민감 필드를 포함할 수 있다고 취급합니다. 보고서 8 MiB, 로그 스트림 각각 1 MiB(버전 stdout 4 KiB), 탐지 1,000개를 제한합니다.
기본 전체 Gitleaks 시간 예산은 버전 확인·준비·CLI를 포함해 30초(설정 최대 120초)입니다. 구버전 CLI에 없는 `--timeout`에 의존하지 않고 남은 시간을 어댑터의 프로세스 대기로 제한합니다. OS 시작·I/O·정리 시간까지 엄격한 실시간 상한이나 별도 OS 메모리 한도를 보장하지 않습니다.
마스킹 옵션만 신뢰하지 않고 보고서 필드 허용 목록으로 다시 정규화합니다. 규칙 ID·행 번호·익명 파일 경로를 검증하고, 확인 가능한 Secret 값이 메타데이터에 들어가도 실패 처리합니다.
임시 보고서와 복사 소스는 성공·탐지·오류·시간 초과 모두 `TemporaryDirectory`로 정리합니다. 정리에 실패하면 자동 승인하지 않습니다.
POSIX 임시 디렉터리는 기본 private 권한을 사용하고 Windows는 작업 폴더 ACL을 상속합니다. 이 정리는 일반 삭제이며 물리적 디스크 지우기나 백업 제거를 보장하지 않습니다. 관리자 권한이나 ACL/시스템 설정 변경을 수행하지 않습니다.

### JSON 계약과 남은 범위

기존 JSON 1.0/2.0 스키마와 API는 변경하지 않았습니다. `security_gate/gate3.schema.json`에 선택적 JSON 3.0 계약을 추가했습니다.
세 도구의 원래 결과를 `docker_compose`, `semgrep`, `gitleaks`에 담고 공통 `findings`를 합칩니다.
우선순위는 SCAN_FAILED > DENY > REVIEW > ALLOW입니다. 필수 도구가 실패하면 다른 도구가 통과해도 ALLOW가 되지 않습니다.
Compose가 없거나 Python/Secret 대상이 없으면 기존 정책에 따라 REVIEW가 남습니다. 검사 성공은 명시한 각 도구의 제한된 규칙을 통과했다는 의미입니다.
오프라인 스키마 검증은 기존 1.0을 `urn:security-gate:docker-report:v1`, 2.0을 `urn:security-gate:integrated-report:v2`로 Registry에 등록합니다. 원격 스키마 조회는 필요하지 않습니다.

익명 스냅샷을 사용하므로 원래 파일명·확장자·경로에 의존하는 Gitleaks 규칙은 동일하게 동작한다고 보장하지 않습니다. 이 단계는 텍스트 내용의 Secret 패턴 검사입니다.
Gitleaks JSON은 Semgrep처럼 모든 검사 파일 목록을 제공하지 않으므로 파일별 실제 검사 완료를 독립적으로 증명하지 못합니다. 어댑터의 `scanned_files`는 정상 CLI 완료 후 제출한 파일 수이며 엔진의 파일별 확인 목록이 아닙니다.
고정·제한된 텍스트 스냅샷, 크기 생략 비활성화, 오류 로그 확인으로 미검사 위험을 줄였지만 OS 샌드박스·동시 파일 변경·엔진 자체의 false negative에 대한 완전한 보장은 제공하지 않습니다.
현재 Windows 실제 심볼릭 링크 3개와 junction의 실제 검증도 앞 절의 미검증 항목입니다. 이 구현은 디렉터리 모드의 단일 Gitleaks 프로세스를 중단하며, 예상하지 못한 하위 프로세스 트리까지 OS 격리로 보장하지는 않습니다.

### STEP 3 초기 연동 검증 기록 — Gitleaks 설치 전

변경 전 전체 pytest는 **128 passed / 3 skipped / 0 failed**였습니다.
STEP 3의 전체 회귀 결과는 **184 passed / 6 skipped / 0 failed**이며, 신규 Gitleaks 모의·어댑터·통합·설정 테스트 56개가 통과했습니다.
기존 Docker·Semgrep·AST 테스트를 유지했고 실제 Semgrep 테스트 4개도 전체 회귀에서 통과했습니다.
6개 SKIP은 Windows 실제 심볼릭 링크 3개와 Gitleaks 미설치에 따른 실제 정상·가짜 Secret·세 도구 통합 검사 3개입니다.
Gitleaks 바이너리는 프로젝트와 PATH에서 확인되지 않았고, 실제 Gitleaks 버전은 미확인입니다. 설치·다운로드·권한 확대·보안 설정 변경을 수행하지 않았습니다.
어댑터를 직접 호출하여 `GITLEAKS_NOT_INSTALLED / SCAN_FAILED` 반환을 확인했습니다. 실제 Secret 탐지 성공 사례는 아직 없으며 모의 탐지를 실제 성공으로 보고하지 않습니다.
민감 필드 비노출, 스캔 로그 폐기, 버전 검증, 잘못된 JSON, 실행 오류, 시간 초과, 보고서/입력 크기 제한, 정리 실패 시 승인 방지를 자동화 테스트로 검증했습니다.
성공·탐지·JSON 오류·부분 보고서를 남긴 시간 초과에서 임시 보고서와 스냅샷이 삭제되는 것을 확인했습니다. 실제 바이너리의 redaction 동작과 실제 Go 규칙 매칭은 위 사용자 실행 명령으로 추가 검증해야 합니다.
팀 GitHub·shakedown·기존 Engine 접근/변경, Git remote·Push·PR·Merge, Docker 실행, 클라우드 배포를 수행하지 않았습니다.

## STEP 4 — 최종 아키텍처와 실행

작업 폴더는 `<SECURITY_GATE_ROOT>`입니다. 현재 실제 검증 버전은 Python 3.12.10, Semgrep 1.180.0, Gitleaks 8.30.0입니다.
위 초기 단계의 미설치 기록은 해당 시점의 이력이며, 아래 최종 검증은 설치된 두 CLI를 사용합니다.

호출 흐름은 `main.py / python -m security_gate` → `cli.py` → 버전에 맞는 집계 함수 → 각 독립 Scanner → 구조화 JSON과 종료 코드입니다.
각 Scanner가 정적 데이터를 검사하고 도구별 상태·근거를 반환하며, 집계 모듈이 우선순위에 따라 전체 판정을 계산합니다.

| 모듈 | 역할 |
| --- | --- |
| main.py, security_gate/__main__.py, cli.py | 로컬 경로·옵션 입력, JSON 출력, 종료 코드 |
| scanner.py, discovery.py, parsing.py, rules/privileged.py | 제한된 탐색·안전 YAML 파싱·Docker privileged 검사 |
| source_targets.py, source_syntax.py | 제한된 Python 읽기와 소스를 실행하지 않는 AST 사전 검증 |
| semgrep.py, semgrep_rules/python-security.yml | 로컬 규칙 Semgrep 실행, 시간/출력 제한, 근거 필드 정규화 |
| secret_targets.py, gitleaks.py, gitleaks_rules/gitleaks.toml | UTF-8 텍스트 스냅샷, Gitleaks dir 검사, Secret 비노출·정리 |
| models.py, gate.py, gate3.py | 각각 JSON 1.0, Docker+Semgrep 2.0, 세 검사 3.0 집계 |
| report.schema.json, gate.schema.json, gate3.schema.json | 기존 버전별 JSON 계약과 오프라인 검증 |
| tests/test_final_integration.py | 정상·개별/복합 위험·실패·CLI·버전 호환성 최종 매트릭스 |

```powershell
Set-Location '<SECURITY_GATE_ROOT>'

# 기존 JSON 계약을 선택하는 명령
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\safe
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\semgrep\safe --with-semgrep
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\gitleaks\safe --with-gitleaks
$LASTEXITCODE  # 정상 3.0: 0 / ALLOW

# 개별 위험
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\integration\docker_risk --with-gitleaks
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\semgrep\vulnerable --with-gitleaks
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\gitleaks\secret --with-gitleaks

# 복합 위험: Docker + Semgrep + Gitleaks
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\integration\combined --with-gitleaks
$LASTEXITCODE  # 1 / DENY

# Python 문법 오류: 소스 실행 없이 사전 검증 실패
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\semgrep\invalid --with-gitleaks
$LASTEXITCODE  # 3 / SCAN_FAILED / SOURCE_SYNTAX_INVALID

# 전체 회귀와 실제 Scanner 검증
.\.venv\Scripts\python.exe -m pytest -q -rs
# 최종 31개 시나리오만
.\.venv\Scripts\python.exe -m pytest -q -rs tests\test_final_integration.py
# 실제 CLI가 제한 환경에서 실패할 때 실행 가능한 모의·AST·Docker 검증
.\.venv\Scripts\python.exe -m pytest -q -rs -m 'not semgrep_real and not gitleaks_real'
```

권한 때문에 실제 CLI가 시작하지 못하면 자동 승인하지 않고 SCAN_FAILED를 반환합니다. 관리자/샌드박스 외부 실행 권한을 요청하거나 시스템 설정을 바꾸지 않고 일반 PowerShell에서 위 명령으로 확인합니다.
설정된 검사 시간은 Docker 기본 5초, Semgrep/AST 기본 30초, Gitleaks 기본 30초입니다. 순차 실행하며 OS 시작·I/O·정리 시간이 추가될 수 있습니다.

### 검사 결과와 최종 판정

| 조건 | 도구별 판정 | 최종 처리 |
| --- | --- | --- |
| 모든 필수 검사 성공, 근거 없음 | 모두 ALLOW | ALLOW / SUCCESS / exit 0 |
| privileged true, Semgrep 위험, Secret 노출 | 해당 도구 DENY | 실패가 없으면 DENY / SUCCESS / exit 1 |
| 미확정 값, 대상 없음 등 정책 확인 필요 | REVIEW | 실패·DENY가 없으면 REVIEW / exit 2 |
| 미설치·실행 오류·시간 초과·JSON 오류·AST 오류·미검사/접근 오류·정리 실패 | SCAN_FAILED | 항상 SCAN_FAILED / FAILED / exit 3 |

집계 우선순위는 `SCAN_FAILED > DENY > REVIEW > ALLOW`입니다. 실패 보고서에는 실패한 도구의 `scan_status`, `decision`, `errors`와 최상위 `REQUIRED_SCAN_FAILED`가 남습니다.
이미 정상화한 위험 근거는 도구별 `findings`와 최상위 `findings`에 보존합니다. 다른 도구의 실패로 기존 위험을 없애거나 자동 승인하지 않습니다.
서로 다른 규칙이 같은 위치를 탐지한 경우 규칙별 정책 근거를 유지합니다. 단순 위치 기준으로 합치지 않습니다. 통합 테스트는 최상위 목록과 각 도구 목록의 정확한 개수·내용을 비교해 집계 단계의 중복 추가와 누락을 확인합니다.

최종 테스트에서 발견한 유일한 구현 수정은 Gitleaks의 정리 실패 처리입니다. 이전에는 Secret을 탐지·정규화한 뒤 정리 오류가 발생하면 그 근거가 사라졌습니다.
현재는 기존 근거·버전·파일 수·오류 코드를 보존하고 `GITLEAKS_CLEANUP_FAILED`를 추가하면서 FAILED / SCAN_FAILED로 바꿉니다. 실패 시 임시 파일이 실제로 남을 수 있으므로 상태 확인과 작업 폴더 내 수동 정리가 필요합니다.
`gate3.py`, `gate.py`, `cli.py`, 기존 스키마와 규칙을 재작성하거나 변경하지 않았습니다.

### JSON 3.0 입력과 출력 예시

입력 JSON 예시는 `examples/request-v3.json`이며, 기존 Python API의 키워드 인자를 표현합니다. `scan_full_repository(**request)`로 호출할 수 있습니다. CLI에는 같은 조건을 로컬 경로와 옵션으로 전달합니다.

```json
{
  "target": "D:\\workspaces\\orca-workspace\\security-gate-lab\\tests\\fixtures\\gitleaks\\safe",
  "docker_timeout_seconds": 5.0,
  "semgrep_timeout_seconds": 30.0,
  "gitleaks_timeout_seconds": 30.0,
  "max_file_bytes": 1048576
}
```

실제 출력 전문은 `examples/normal-v3.json`, `docker-risk-v3.json`, `semgrep-risk-v3.json`, `secret-risk-v3.json`, `combined-risk-v3.json`에 있습니다.
이 파일들은 최종 실제 Scanner 테스트에서 생성한 **정규화된 결과**입니다. CLI 로그나 Gitleaks 원본 보고서가 아닙니다.
`examples/cleanup-failure-v3.json`은 정리 실패를 주입한 **모의 테스트**의 결과이며 실제 OS 정리 실패 관측으로 보고하지 않습니다. 각 예시에는 도구별 상태와 전체 근거가 모두 포함됩니다.

복합 위험 출력의 최상위 필드는 다음과 같습니다. 아래는 구조 설명을 위한 요약이며 스키마를 검증할 때는 예시 파일 전문을 사용합니다.

```json
{
  "schema_version": "3.0",
  "scope": "docker_semgrep_and_gitleaks_text_secrets",
  "decision": "DENY",
  "scan_status": "SUCCESS",
  "reason_code": "RISK_DETECTED"
}
```

JSON 1.0/2.0/3.0의 필드·버전·기본 CLI 선택은 유지합니다. CLI 호환성 테스트는 각 스키마를 검증하고 3.0 안의 Docker·Semgrep 보고서가 기존 경로 결과와 같은지 확인합니다.

### Secret 및 보고서 보관 정책

테스트 토큰은 인공 네임스페이스이며 실제 서비스에서 발급한 유효한 비밀키를 사용하지 않습니다.
최종 JSON과 예시는 허용된 근거 필드만 포함합니다. Secret/Match/Description/Fingerprint/주변 코드·원문 예외는 포함하지 않습니다. CLI stderr와 JSON에 테스트 Secret이 없는지도 검증합니다.
스캔 중 임시 복사 소스와 Gitleaks 원본 보고서는 `.tmp/gitleaks-*`에만 존재하고 정상 종료·DENY·JSON 오류·시간 초과 때 정리합니다. 물리적 보안 삭제나 백업 제거는 보장하지 않습니다.
JUnit 검증 파일 `.tmp/final-validation.xml`은 테스트 결과와 정규화한 예시를 포함합니다. `examples/*.json`은 검토 가능한 정규화 출력 문서로 유지합니다. 사용자 입력 경로 같은 메타데이터는 포함되므로 공유 범위를 고려하세요.
Semgrep 과거 진단 폴더는 일반 Scanner 결과 보관소로 사용하지 않으며 이번 검증에서 진단 스크립트를 실행하거나 기존 진단 파일을 덮어쓰지 않습니다.

### 향후 Engine 연결 지점과 남은 한계

향후 호출 지점은 `security_gate.gate3.scan_full_repository(local_path, ...)` 또는 현재 CLI의 `--with-gitleaks`입니다. 실제 기존 Engine에는 연결하지 않았습니다.
Engine이 허가한 고정 로컬 스냅샷 경로를 전달하고, 버전 3.0 스키마와 도구 상태·근거를 검사한 뒤 **명시적 ALLOW만** 승인 조건으로 사용할 수 있습니다. REVIEW·DENY·SCAN_FAILED와 호출 자체 실패는 승인하지 않는 처리가 필요합니다.
기본 1.0/선택적 2.0 경로는 각각 검사 범위가 좁으므로 전체 세 도구 승인과 같은 의미로 취급하지 않습니다.

남은 한계는 Windows 실제 심볼릭 링크 3개와 junction 미검증, Python 실행 버전의 제한된 AST 문법, 두 Python 위험 패턴, UTF-8 텍스트 중심 Secret 검사, 익명 경로에 의한 경로 기반 규칙 차이입니다.
Compose의 환경변수 해석·override/include/extends 병합, Git history Secret 검사, 바이너리·압축/인코딩 콘텐츠 확장, OS 완전 격리 및 동시 파일 변경 방지는 범위에 포함되지 않습니다.
Gitleaks의 `scanned_files`는 제출한 파일 수이며 파일별 엔진 완료 목록을 증명하지 않습니다. ALLOW는 정의된 범위·규칙의 통과이며 전체 보안 보장이 아닙니다.

### STEP 4 최종 검증 결과

변경 전 전체 테스트는 사용자 확인과 동일한 **187 passed / 0 failed / 3 skipped**였습니다.
새 통합 테스트에서 정리 실패 시 Gitleaks 탐지 근거가 사라지는 문제를 재현했고, 해당 오류 처리만 수정한 뒤 신규 31개 테스트와 전체 회귀 테스트를 재실행했습니다.
최종 결과는 **218 passed / 0 failed / 3 skipped**입니다. 모든 기존 테스트를 유지했으며 Windows 실제 심볼릭 링크 생성 불가 3개를 미검증 항목으로 남겼습니다.

실제 Semgrep 1.180.0·Gitleaks 8.30.0을 사용한 최종 시나리오 5개와 CLI 실행 2개가 통과했습니다.

| 실제 시나리오 | Docker 근거 | Semgrep 근거 | Gitleaks 근거 | 최종 판정 |
| --- | ---: | ---: | ---: | --- |
| 정상 | 0 | 0 | 0 | ALLOW |
| Docker privileged | 1 | 0 | 0 | DENY |
| Python 취약 코드 | 0 | 2 | 0 | DENY |
| 가짜 Secret | 0 | 0 | 1 | DENY |
| 복합 위험 | 1 | 2 | 1 | DENY |

Gitleaks는 `settings.env`의 인공 테스트 토큰을 `security-gate-lab-api-token`으로 탐지했습니다. 실제 Secret 값·매칭 원문·주변 소스는 정규화 JSON과 CLI stdout/stderr에 포함되지 않았습니다.
정상 CLI 종료 코드 0과 복합 위험 CLI 종료 코드 1도 실제 하위 프로세스 호출로 확인했습니다. 검사 대상의 Python 함수와 스크립트는 실행하지 않았습니다.

미설치·실행 오류·시간 초과·잘못된 JSON·읽기/접근 오류·미검사 목록·AST 문법 오류·오류 로그·정리 실패는 모의 오류 주입으로 검증했습니다.
모의 정리 실패 사례는 위험 근거 4개를 보존하고 최종 SCAN_FAILED를 반환합니다. 실제 도구를 제거하거나 OS 접근 권한을 바꾸는 방식으로 실패를 만들지 않았습니다.
기존 실제 엔진 테스트와 AST 문법 오류 테스트도 전체 회귀에 포함됐습니다. 추가 파일의 예시와 출처는 [examples/README.md](examples/README.md)에 있습니다.

최종 회귀와 정규화 보고서 예시를 감사 가능한 JUnit 파일에 기록한 명령은 다음과 같습니다.

```powershell
.\.venv\Scripts\python.exe -m pytest -q -rs -o junit_family=xunit1 --junitxml=.tmp\final-validation.xml
```

현재 테스트 종료 후 Scanner의 작업용 임시 디렉터리가 남는지 확인하며 과거 진단 폴더와 구분합니다. 과거 진단 파일을 재생성하거나 삭제하는 작업은 수행하지 않습니다.
이번 STEP 4에서 코드 수정은 `security_gate/gitleaks.py`의 정리 실패 결과 보존뿐입니다. 추가 파일은 통합 테스트, 필요한 fixture 6개, 정규화 예시·문서입니다.
현재 MVP에 새 도구·스캔 기능·Engine 연결·배포·Git 원격 작업을 추가하지 않았습니다.
