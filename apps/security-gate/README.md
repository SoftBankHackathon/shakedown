# Security Gate — 독립 보안 검사 MVP

허가된 로컬 경로의 Docker Compose 위험 설정, Python·Java·JavaScript·TypeScript 취약 코드, 텍스트 Secret 노출을 정적으로 검사합니다. 검사 대상 소스는 실행하지 않습니다. 기존 Engine API 연결, Clone, Docker 실행, 배포 기능은 포함하지 않습니다.

이 README는 **제출본의 현재 설치·실행·연동 인터페이스**입니다. 기존 530줄 README 전문과 STEP별 실험 기록은 [docs/LAB_VALIDATION_HISTORY.md](docs/LAB_VALIDATION_HISTORY.md)에 보존했습니다. 원본 실험의 성공 결과와 제출본에서 새로 수행한 결과를 구분하며, 이번 패키징 검증은 [docs/PACKAGING_VALIDATION.md](docs/PACKAGING_VALIDATION.md)에 기록합니다.

## 구성과 모듈별 역할

호출 흐름: `main.py / python -m security_gate` → `cli.py` → 버전별 집계 함수 → 독립 Scanner → JSON stdout + 종료 코드.

| 모듈 | 역할 |
| --- | --- |
| main.py, security_gate/__main__.py, cli.py | 로컬 경로·옵션 입력, JSON 출력, 종료 코드 |
| scanner.py, discovery.py, parsing.py, rules/privileged.py | 제한된 탐색, 안전 YAML 파싱, Docker privileged 검사 |
| source_targets.py, source_units.py, source_syntax.py | 다중 언어 수집·템플릿 추출·미검사 범위 식별, Python 전용 AST 검증 |
| semgrep.py, semgrep_rules/*.yml | 로컬 고정 규칙 Semgrep 실행, 실패 처리, 결과 정규화 |
| secret_targets.py, gitleaks.py, gitleaks_rules/gitleaks.toml | UTF-8 텍스트 수집, Gitleaks dir 검사, Secret 비노출·정리 |
| models.py, gate.py, gate3.py | 각각 JSON 1.0, Docker+Semgrep 2.0, 세 검사 3.0 집계 |
| report.schema.json, gate.schema.json, gate3.schema.json | 버전별 출력 계약, 오프라인 스키마 검증 |
| tests/, examples/ | 회귀·모의·실제 CLI 테스트, 출처를 표시한 정규화 예시 |

## 일반 PowerShell 설치

팀 저장소 루트에서 시작합니다. 최초 설치는 사용자가 허용된 네트워크의 일반 PowerShell에서 수행합니다. 관리자 권한, 시스템 PATH 또는 보안 설정 변경은 필요하지 않습니다. 제출본에는 가상환경과 CLI 바이너리가 포함되지 않습니다.

```powershell
Set-Location .\apps\security-gate
python -m venv .venv  # 기존 환경이 있으면 생략
New-Item -ItemType Directory -Force -Path .tmp | Out-Null
$env:TEMP = Join-Path $PWD '.tmp'
$env:TMP = $env:TEMP
.\.venv\Scripts\python.exe -m pip install --cache-dir .pip-cache -r requirements-dev.txt

# Semgrep: 어댑터는 이 패키지의 .venv 내 실행 파일만 사용
.\.venv\Scripts\python.exe -m pip install --cache-dir .pip-cache -r requirements-semgrep.txt
.\.venv\Scripts\semgrep.exe --version
```

`requirements.txt`는 PyYAML, `requirements-dev.txt`는 pytest·jsonschema, `requirements-semgrep.txt`는 선택적 Semgrep 의존성입니다. 원본에서 검증한 버전은 Python 3.12.10, Semgrep 1.180.0, Gitleaks 8.30.0입니다. 의존성 범위가 완전 고정된 lockfile은 아니므로 설치 버전을 기록하고 실제 테스트를 다시 실행하세요.

Gitleaks는 Python 패키지가 아닌 네이티브 CLI입니다. [공식 Releases](https://github.com/gitleaks/gitleaks/releases)에서 Windows 아키텍처에 맞는 ZIP을 `.tmp/gitleaks.zip`으로 저장하고, 같은 릴리스의 체크섬과 비교한 다음 아래 명령을 실행합니다. 지원 정책은 **8.24.2 이상, 9 미만**입니다.

```powershell
New-Item -ItemType Directory -Force -Path tools\gitleaks | Out-Null
Get-FileHash -Algorithm SHA256 -LiteralPath .tmp\gitleaks.zip
Expand-Archive -LiteralPath .tmp\gitleaks.zip -DestinationPath tools\gitleaks
.\tools\gitleaks\gitleaks.exe version
```

실행 파일 위치는 Windows에서 `.venv/Scripts/semgrep.exe`, `tools/gitleaks/gitleaks.exe`, POSIX에서 `.venv/bin/semgrep`, `tools/gitleaks/gitleaks`입니다. PATH나 검사 대상에서 실행 파일을 찾지 않습니다. `.gitignore`는 가상환경·임시 파일·바이너리·로그·DB·개인 인증 파일을 제외하며, 명시적으로 인공 데이터만 담은 네 개 `settings.env` fixture를 포함합니다.

## 실행 명령과 대상 경로

이후 모든 명령은 `apps/security-gate`에서 실행합니다. 상대 경로는 현재 작업 디렉터리를 기준으로 합니다. 검사는 허가된 로컬 디렉터리만 대상으로 하며, 기본 Docker 모드는 일치하는 Compose 파일도 직접 지정할 수 있습니다.

```powershell
# JSON 1.0: Docker만
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\safe
.\.venv\Scripts\python.exe -m security_gate .\tests\fixtures\dynamic

# JSON 2.0: Docker + Python AST + Semgrep
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\semgrep\safe --with-semgrep
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\semgrep\vulnerable --with-semgrep

# JSON 3.0: Docker + Semgrep + Gitleaks 모두 필수로 활성화
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\gitleaks\safe --with-gitleaks
$LASTEXITCODE  # 모든 도구 설치·검사 성공 시 0: ALLOW
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\integration\docker_risk --with-gitleaks
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\gitleaks\secret --with-gitleaks
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\integration\combined --with-gitleaks
$LASTEXITCODE  # 모든 도구 검사 완료 시 1: DENY
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\semgrep\invalid --with-gitleaks
$LASTEXITCODE  # 3: SCAN_FAILED, SOURCE_SYNTAX_INVALID

# 시간·크기 제한을 명시한 통합 검사
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\gitleaks\safe --with-gitleaks --max-file-bytes 1048576 --timeout-seconds 5 --semgrep-timeout-seconds 30 --gitleaks-timeout-seconds 30
```

`--with-gitleaks`는 Semgrep도 활성화합니다. 두 옵션을 모두 지정해도 JSON 3.0입니다. 도구가 없거나 실행하지 못하면 SCAN_FAILED이며 정상 예시의 기대 ALLOW가 보장되지 않습니다. Fixture의 `sample.py`는 정적 검사 데이터이므로 직접 실행하지 마세요.

## JSON 1.0 / 2.0 / 3.0 입출력 계약

CLI 입력은 `path` 위치 인자와 위 옵션입니다. JSON stdin을 받는 CLI 또는 HTTP API는 구현하지 않았습니다. `examples/request-v3.json`은 Python API의 키워드 인자를 표현하는 DTO 예시입니다.

| 버전 | 선택 / Python API | 출력과 스키마 |
| --- | --- | --- |
| 1.0 | 기본 CLI / security_gate.scanner.scan(path) | schema_version, scope, target_path, scan_status, decision, files, errors / report.schema.json |
| 2.0 | --with-semgrep / security_gate.gate.scan_repository(path) | schema_version, scope, target_path, decision, scan_status, reason_code, docker_compose, semgrep, findings / gate.schema.json |
| 3.0 | --with-gitleaks / security_gate.gate3.scan_full_repository(target) | 2.0의 공통 구조에 gitleaks 도구 결과 추가 / gate3.schema.json |

스키마 파일은 모두 `security_gate/`에 있습니다. JSON 1.0의 Docker 근거에는 `decision`, `file_path`, `service`, `rule_id`, `reason_code`, `location`이 있습니다. `location`은 1부터 시작하는 `line`, `column`, `["services", service, "privileged"]` 경로를 담습니다. 실제 설정값은 포함하지 않습니다.

2.0/3.0의 공통 근거는 아래 일곱 필드만 사용합니다. Docker의 서비스명·열 번호는 중첩된 기존 1.0 보고서에 보존합니다.

```json
{
  "tool": "gitleaks",
  "rule_id": "security-gate-lab-api-token",
  "file_path": "<SECURITY_GATE_ROOT>/tests/fixtures/gitleaks/secret/settings.env",
  "line": 1,
  "severity": "HIGH",
  "reason_code": "SECRET_EXPOSURE",
  "decision": "DENY"
}
```

Python API 입력 예시:

```json
{
  "target": "tests/fixtures/gitleaks/safe",
  "docker_timeout_seconds": 5.0,
  "semgrep_timeout_seconds": 30.0,
  "gitleaks_timeout_seconds": 30.0,
  "max_file_bytes": 1048576
}
```

사용 방법은 `security_gate.gate3.scan_full_repository(**request)`입니다. 실제 Engine에서는 승인된 절대 경로를 전달하세요. CLI에는 같은 값을 경로와 옵션으로 전달합니다.

JSON 3.0 출력 구조를 설명하는 요약 예시입니다. 아래 중첩 객체는 생략되어 있으므로 완전한 스키마 검증에는 [examples/normal-v3.json](examples/normal-v3.json) 등 전문을 사용하세요.

```json
{
  "schema_version": "3.0",
  "scope": "docker_semgrep_and_gitleaks_text_secrets",
  "target_path": "<authorized absolute repository path>",
  "decision": "ALLOW",
  "scan_status": "SUCCESS",
  "reason_code": "ALL_APPLICABLE_CHECKS_PASSED",
  "docker_compose": {"schema_version": "1.0", "decision": "ALLOW"},
  "semgrep": {"tool": "semgrep", "decision": "ALLOW"},
  "gitleaks": {"tool": "gitleaks", "decision": "ALLOW"},
  "findings": []
}
```

[examples/README.md](examples/README.md)는 정상·개별 위험·복합 위험·정리 실패 출력의 출처와 개수를 설명합니다. 기존 실제 lab 보고서의 개인 절대 경로만 `<SECURITY_GATE_ROOT>`로 익명화했습니다. 예시는 제출본의 실시간 승인 결과가 아닙니다. `cleanup-failure-v3.json`은 모의 오류 주입 결과입니다.

오프라인 JSON Schema 검증은 1.0 스키마를 `urn:security-gate:docker-report:v1`, 2.0을 `urn:security-gate:integrated-report:v2`로 Registry에 등록합니다. 원격 스키마 조회는 필요하지 않습니다. `tests/test_semgrep.py`와 `tests/test_final_integration.py`의 Registry 검증을 참고하세요.

## 판정 정책과 종료 코드

| 조건 | 최종 판정 | 종료 코드 |
| --- | --- | ---: |
| 활성화된 모든 필수 검사가 명시적으로 성공하고 근거 없음 | ALLOW / SUCCESS | 0 |
| privileged true, Semgrep 차단 패턴, Secret 탐지 | 실패가 없으면 DENY / SUCCESS | 1 |
| 미확정 값 또는 검사 대상 없음 | 실패·DENY가 없으면 REVIEW | 2 |
| 미설치·실행 오류·시간 초과·JSON 오류·AST 오류·접근/미검사 오류·정리 실패 | SCAN_FAILED / FAILED | 3 |

집계 우선순위는 `SCAN_FAILED > DENY > REVIEW > ALLOW`입니다. 실패를 취약점 미발견으로 취급하지 않습니다. 위험과 실패가 함께 발생하면 전체 SCAN_FAILED로 반환하고 정상화한 기존 위험 근거를 보존합니다. 최상위 `reason_code`는 각각 `ALL_APPLICABLE_CHECKS_PASSED`, `RISK_DETECTED`, `REVIEW_REQUIRED`, `REQUIRED_SCAN_FAILED`입니다. 이 필드는 2.0/3.0에 있으며 1.0에는 추가하지 않습니다.

검사 대상이 없으면 도구별 `NOT_APPLICABLE / REVIEW`가 남습니다. 2.0/3.0에서는 **Compose만 해당 없을 때** 이 REVIEW를 집계에서 제외합니다. 지원되는 Python/Java/JavaScript/TypeScript 소스가 하나 이상이고, 모든 제출 단위의 Semgrep 검사와 3.0의 Secret 검사가 성공하며 위험·미지원 소스·미검사 범위가 없으면 ALLOW입니다. 소스 없음, 미지원 소스만 존재, 혼합 프로젝트의 미지원 소스, Secret 검사 대상 없음은 자동 ALLOW하지 않습니다. 1.0 Docker 단독 판정은 유지합니다. 최상위 `SUCCESS`는 REVIEW를 승인한다는 뜻이 아닙니다.

JSON 1.0/2.0/3.0 버전·중첩 구조·종료 코드 0/1/2/3은 유지합니다. 2.0 `scope`는 `docker_compose_privileged_and_semgrep_multilanguage_mvp`, Semgrep `scope`는 `local_multilanguage_mvp_rules`로 확장했습니다. Semgrep의 `detected_languages`와 `unsupported_languages`/`unsupported_files`는 수집 범위, `scanned_languages`/`scanned_units`는 CLI가 보고한 실제 검사 단위, `scanned_files`는 그 원본 파일 수입니다. `coverage_gaps`와 `unscanned_sources`는 미검사 사유와 그 발생 횟수이며, 같은 파일에도 여러 사유가 생길 수 있습니다. Gitleaks의 `excluded_binary_files`는 검증 후 제외한 바이너리 수입니다. 갱신된 스키마는 이전 Python 및 Python/Java scope와 기존 예시도 수용하지만, 구버전의 엄격한 스키마 소비자는 함께 갱신해야 합니다. 새 규칙 근거와 Compose NOT_APPLICABLE 예외도 스키마에 반영했습니다.

기존 위험 근거는 도구별 결과와 최상위 `findings`에 유지합니다. 같은 행이어도 서로 다른 규칙의 근거는 보존하며, 집계 테스트는 중복 추가·누락을 비교합니다. Gitleaks 정리 실패도 근거·버전·파일 수를 보존하고 `GITLEAKS_CLEANUP_FAILED`를 기록합니다.

Semgrep의 native exit 1은 유효한 탐지 결과가 있으면 DENY입니다. Gitleaks는 native exit 10을 Secret 탐지에 사용하며 최종 Gate는 DENY exit 1로 변환합니다. 그 밖의 실행 오류 및 결과·종료 코드 불일치는 SCAN_FAILED입니다. CLI 인자 자체가 잘못된 경우 argparse의 usage 오류 exit 2이며 JSON 보고서는 생성하지 않습니다. Engine은 이 경우를 REVIEW JSON으로 오인하면 안 됩니다.

## Docker 검사 구성과 안전 제한

디렉터리를 재귀 탐색해 정확히 `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`인 파일을 검사합니다. 다른 이름을 직접 지정하면 대상 없음입니다. Docker 탐색은 숨김 폴더·가상환경을 자동 제외하지 않으므로 검사 범위를 좁게 지정하세요.

`services.*.privileged`가 YAML boolean true 또는 문자열 true이면 `DOCKER_COMPOSE_PRIVILEGED / PRIVILEGED_ENABLED`로 DENY입니다. 속성 없음·boolean false는 통과하며, 환경변수식·null·숫자·문자열 false 등 미확정 값은 REVIEW입니다. 잘못된 YAML·비어 있는 services·서비스 객체 오류는 SCAN_FAILED입니다.

### 공통 읽기와 Docker 제한

- PyYAML `safe_load`로만 값 구성. 토큰과 노드 검사 후 파싱합니다. 별칭·앵커·모든 명시적 YAML 태그·중복 키·비문자열/merge 키는 지원하지 않고 SCAN_FAILED로 처리합니다.
- 기본 파일 크기 1 MiB(사용자 설정 1 byte–16 MiB), 전체 읽은 UTF-8 내용 8 MiB, 보고서 근거 1,000개, 서비스명 길이 256자로 제한합니다.
- 탐색 항목 10,000개, Compose 파일 256개, 디렉터리 깊이 64, YAML 깊이 64, YAML 토큰 100,000개를 제한합니다.
- 기본 전체 검사 시간은 워커 시작·탐색·파싱을 포함해 5초(설정 최대 60초)입니다. 별도 프로세스를 종료해 실패 처리하며 워커 정리에 최대 약 1.1초가 추가될 수 있습니다. 운영체제 프로세스 시작 자체의 지연까지 보장하는 실시간 제한은 아닙니다.
- 심볼릭 링크와 Windows reparse point/junction, 경로의 링크 조상은 거부합니다. 파일 열기 전후 종류와 식별자를 비교하고 가능한 OS에서는 `O_NOFOLLOW`를 사용합니다. 동시 파일 변경에 대한 완전한 OS 보안 격리는 제공하지 않으므로 변경되지 않는 로컬 스냅샷을 권장합니다.
- UTF-8/UTF-8 BOM을 지원합니다. 환경변수 치환, `.env`, Compose override 병합, `include`, `extends`, 외부 파일 해석은 하지 않습니다. 발견한 각 파일의 직접 선언만 검사합니다.
- PyYAML의 YAML 1.1 boolean 해석을 사용합니다. Docker Compose 자체의 전체 스키마/실행 동작을 검증하지 않습니다. 특권 외 네트워크·볼륨·capabilities 등 위험은 이 단계의 범위 밖입니다.
- 심볼릭 링크 생성이 권한상 불가능한 환경에서는 해당 실제 링크 테스트가 SKIP되며 권한 확대를 시도하지 않습니다. pytest 요약의 skipped도 확인하세요.

## Semgrep 검사 구성

### 로컬 규칙과 검사 범위

고정된 `semgrep_rules/python-security.yml`, `semgrep_rules/java-security.yml`, `semgrep_rules/javascript-typescript-security.yml`만 각각 `--config`로 전달합니다. Registry, URL, `auto`, 원격 규칙 다운로드를 사용하지 않습니다.

| 규칙 ID | 패턴 | 위험도 | 판정 / 이유 코드 |
| --- | --- | --- | --- |
| security-gate-python-eval | `eval(...)` | HIGH | DENY / PYTHON_DYNAMIC_EVAL |
| security-gate-python-shell-true | `subprocess.run/call/Popen/check_call/check_output(..., shell=True, ...)` | HIGH | DENY / PYTHON_SHELL_EXECUTION |
| security-gate-java-runtime-exec | `Runtime.getRuntime().exec(...)`, Runtime 타입 변수의 `exec(...)` | HIGH | DENY / JAVA_COMMAND_EXECUTION |
| security-gate-java-process-builder | `new ProcessBuilder(...).start()`, ProcessBuilder 타입 변수의 `start()` | HIGH | DENY / JAVA_PROCESS_EXECUTION |
| security-gate-web-dynamic-eval | `eval(...)`, `window.eval(...)`, `globalThis.eval(...)` | HIGH | DENY / WEB_DYNAMIC_EVAL |
| security-gate-web-function-constructor | `new Function(...)`, `Function(...)` | HIGH | DENY / WEB_DYNAMIC_FUNCTION |
| security-gate-web-shell-exec | Node child_process의 직접 `exec`/`execSync`, `require` 호출 패턴 | HIGH | DENY / WEB_SHELL_EXECUTION |

이는 MVP의 직접 호출 패턴 검사입니다. 입력의 실제 신뢰도, 복잡한 별칭·래퍼, 동적으로 계산한 `shell` 값, 다른 언어, 전체 취약점 범주를 판단하지 않습니다.
`eval`의 상수 입력도 차단할 수 있습니다. 정상 fixture는 `ast.literal_eval`과 `shell=False`를 사용합니다.
외부 Repository를 새로 가져오지 않고, 허가된 로컬 디렉터리의 `.py`, `.java`, `.js/.jsx/.mjs/.cjs`, `.ts/.tsx/.mts/.cts`를 수집합니다. 스냅샷에는 해당 언어의 `.py/.java/.js/.jsx/.ts/.tsx` 확장자를 사용하며 AST 사전 검증은 `.py`에만 적용합니다. Java 규칙은 정규화된 타입명도 다루지만 javac 빌드·타입 검증, SQL injection, Spring 인증/인가, XSS, 역직렬화, 파일 간 데이터 흐름은 검사하지 않습니다. 명령이 상수여도 실행 패턴은 차단합니다. 규칙 문법은 [Semgrep 공식 문서](https://semgrep.dev/docs/writing-rules/pattern-syntax)를 따릅니다.

Kotlin, Go, Ruby, PHP, C/C++, C#, Rust, Scala, Swift, Groovy, 셸, Vue/Svelte 전용 파일 등은 미지원으로 REVIEW합니다. 알려지지 않은 확장자·확장자 없는 파일도 명시된 데이터/빌드 파일명이 아니면 `unknown`으로 REVIEW합니다. 언어 추가 시 확장자 분류·고정 규칙·정규화 허용 목록·스키마·실제 CLI fixture를 함께 확장해야 합니다.

HTML/SVG의 인라인 script, `on*`/`th:on*` 이벤트 코드, javascript URL은 별도 JavaScript 단위로 추출합니다. 한 파일의 여러 단위 중 하나라도 `paths.scanned`에서 빠지면 SCAN_FAILED입니다. 근거는 원본 파일·행으로 매핑하며, 이벤트 속성은 해당 속성 시작 행을 가리킵니다. script의 TypeScript MIME도 구분합니다. JSON 데이터 script는 실행 소스 대상이 아니며 Secret 검사는 유지합니다.

로컬 script 참조는 수집된 소스와 대조하고 원격 URL은 내려받지 않습니다. 외부/누락/동적 참조, 알 수 없는 script 타입, 손상·중복 속성 템플릿은 `coverage_gaps`로 REVIEW합니다. Thymeleaf의 알려진 `[[${...}]]`/`[(${...})]` 표현식은 실행하지 않고 고정 식별자로 치환해 나머지 코드만 검사하며, 반드시 `TEMPLATE_EXPRESSION`을 남겨 ALLOW를 금지합니다. 그 외 파서가 처리하지 못하는 구문은 SCAN_FAILED입니다. 전체 브라우저 DOM 또는 템플릿 렌더링 검증은 제공하지 않습니다.

정적 HTML/CSS, 설정·문서, Gradle 빌드 스크립트(`.gradle`, `.gradle.kts`), 명시된 빌드 파일과 wrapper 런처(`gradlew`, `gradlew.bat`, `mvnw`, `mvnw.cmd`)는 애플리케이션 소스 규칙 범위 밖이며 텍스트 Secret 검사만 수행합니다. 정확한 분류 목록은 `source_targets.py`의 상수에 있습니다. 파일 확장자/이름을 위장한 코드를 전부 식별한다고 보장하지 않습니다. 언어 목록은 발견 기준이며 실제 검사 성공 여부는 `scan_status`, `scanned_files`, 미지원 파일 수를 함께 확인합니다.
`.git`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.pytest-tmp`, `.tmp`, `.pip-cache` 이름은 소스 탐색에서 제외됩니다. 이 제외는 기존 Docker 탐색에는 적용되지 않습니다.

### 실행 제한과 비밀값 보호

- 지원 소스 및 HTML/SVG 파일 합계 최대 256개, 추출 후 검사 단위 최대 512개, 탐색 항목 10,000개, 깊이 64, 기본 파일/단위당 1 MiB, 원본·추출 내용 각각 누적 8 MiB로 제한합니다. 링크와 reparse point는 제외 디렉터리 이름이어도 거부합니다.
- 소스를 작업 폴더의 `.tmp/semgrep-*`에 익명 파일명으로 복사합니다. 대상의 `.semgrepignore`, `.semgrep.yml`, `.git` 설정은 복사하거나 사용하지 않습니다. fixture 경로의 소스는 Python으로 import/실행하지 않습니다.
- `semgrep scan`을 인자 배열과 `shell=False`로 호출합니다. 로컬 빌드, autofix, Pro/Secrets 기능을 활성화하지 않습니다. `--oss-only`, `--metrics off`, `--disable-version-check`, `--no-secrets-validation`을 사용하고 인증·규칙·Python 경로 관련 외부 환경변수는 전달하지 않습니다.
- [공식 CLI 옵션](https://semgrep.dev/docs/cli-reference)에 따라 `--strict`, `--error`, `--disable-nosem`, `--no-git-ignore`, `--no-rewrite-rule-ids`를 사용합니다. 사용 중인 버전에서 옵션을 지원하지 않으면 실행 실패로 처리합니다.
- 전체 준비와 CLI 실행의 기본 제한은 30초(최대 120초), Semgrep 규칙/파일당 제한은 5초, 메모리 설정은 256 MiB입니다. 준비 이후 남은 시간을 CLI에 전달합니다. OS I/O·프로세스 시작·결과 정규화와 정리까지의 엄격한 실시간 상한은 보장하지 않습니다.
- 시간 초과/출력 제한 시 프로세스를 중단합니다. Windows는 `taskkill /T /F`, POSIX는 프로세스 그룹 종료를 사용합니다. 종료·임시 폴더 정리 시간이 추가될 수 있으며 OS 권한 때문에 자식 프로세스 종료가 실패하는 상황까지 보안 격리로 보장하지 않습니다.
- CLI stdout 8 MiB, stderr 1 MiB, 탐지 결과 1,000개로 제한합니다. raw 출력은 임시 파일에만 보관하고 정리합니다. 보고서에는 `extra.message`, 코드 줄, metavars, trace, stdout/stderr, 예외 원문을 전달하지 않습니다.
- Semgrep의 `paths.scanned`가 복사한 전체 검사 단위와 일치해야 성공합니다. 누락·범위 밖 경로·알 수 없는 규칙·JSON 구조 오류·파싱 오류·Semgrep 오류는 SCAN_FAILED입니다. 동일 원본 파일의 다른 script 단위 누락도 검사합니다.
- Python 소스는 Semgrep 전에 아래 AST 사전 검증도 통과해야 합니다. `scanned` 포함과 빈 `errors`만으로 Python 문법의 유효성을 판단하지 않습니다.
- 신뢰된 로컬 규칙과 위 옵션으로 네트워크 동작을 억제합니다. 이 Python 어댑터 자체는 운영체제 수준의 네트워크/파일시스템 샌드박스를 제공하지 않습니다. 소스 동시 변경에 대한 완전한 격리도 보장하지 않습니다.

### Python AST 사전 검증

Semgrep 1.180.0이 실제 Python 문법 오류 fixture를 scanned에 포함하고 errors 없이 exit 0을 반환한 원본 진단을 근거로, Python 구문 검증을 별도로 수행합니다.

`security_gate/source_syntax.py`는 크기·경로·링크 검사를 통과한 소스 문자열 전체를 Semgrep 호출 전에 `ast.parse(..., mode="exec")`로 검사합니다.
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

## Gitleaks 검사 구성과 민감정보 보호

### 탐지 정책과 안전한 입력

[공식 디렉터리 모드](https://github.com/gitleaks/gitleaks/blob/master/README.md#dir)인 `gitleaks dir`만 사용합니다. Git history, Git 명령, remote, 네트워크 비밀키 검증은 사용하지 않습니다.
고정 `gitleaks_rules/gitleaks.toml`은 설치한 바이너리 내장 기본 규칙을 확장합니다. 규칙을 네트워크에서 동적으로 내려받지 않습니다.
내장 규칙은 API key·token 등 알려진 Secret 형식을 찾고, 추가 로컬 규칙 `security-gate-lab-api-token`은 서비스에서 발급하지 않은 `SGLAB_FAKE_TOKEN_` 테스트 네임스페이스만 검사합니다.
fixture는 실제 유효한 비밀키를 포함하지 않습니다. 실제 엔진 탐지가 검증되지 않은 동안 모의 결과를 실제 성공 사례로 보고하지 않습니다.

- 명시된 Gradle wrapper JAR 예외 외의 모든 일반 파일을 UTF-8/UTF-8 BOM 텍스트로 읽습니다. 숨김 파일과 `.env`, `.properties`, YAML/JSON/XML, Gradle 스크립트, 소스코드도 포함됩니다. 파일 256개, 항목 10,000개, 디렉터리 깊이 64, 기본 파일당 1 MiB, 누적 원본 바이트 8 MiB를 제한하며 제외 바이너리도 이 제한에 포함합니다.
- `.git`, `.venv`, `venv`, `node_modules`, `__pycache__`, `.pytest_cache`, `.pytest-tmp`, `.tmp`, `.pip-cache` 디렉터리는 검사 범위에서 제외합니다. 링크/reparse point는 제외 이름이어도 거부합니다.
- `gradle/wrapper/gradle-wrapper.jar` 경로 끝이 정확히 일치하고 ZIP magic, ZIP 구조/CRC, Manifest, GradleWrapperMain.class 및 class magic 검증을 통과한 파일만 제외합니다. 압축 해제 크기 8 MiB·항목 256개를 제한하고 암호화·미지원 압축·중복 이름·경로 이탈·내부 링크를 거부합니다. 검증은 메모리 안에서 수행하며 추출하거나 실행하지 않습니다. 제외 수는 `excluded_binary_files`에 남습니다. 형식 확인은 공급망 신뢰나 내부 Secret 부재의 보증이 아니며, JAR 내부는 Secret 검사 범위 밖입니다.
- `.jar` 이름의 일반 텍스트는 계속 검사합니다. 다른 JAR·바이너리, NUL, 지원하지 않는 인코딩, 손상된 ZIP/JAR, 크기 초과, 특수 파일, 읽기 오류는 SCAN_FAILED입니다. 광범위한 확장자 기반 바이너리 제외는 하지 않습니다.
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

### Gitleaks 검증 한계

익명 스냅샷을 사용하므로 원래 파일명·확장자·경로에 의존하는 Gitleaks 규칙은 동일하게 동작한다고 보장하지 않습니다. 이 단계는 텍스트 내용의 Secret 패턴 검사입니다.
Gitleaks JSON은 Semgrep처럼 모든 검사 파일 목록을 제공하지 않으므로 파일별 실제 검사 완료를 독립적으로 증명하지 못합니다. 어댑터의 `scanned_files`는 정상 CLI 완료 후 제출한 파일 수이며 엔진의 파일별 확인 목록이 아닙니다.
고정·제한된 텍스트 스냅샷, 크기 생략 비활성화, 오류 로그 확인으로 미검사 위험을 줄였지만 OS 샌드박스·동시 파일 변경·엔진 자체의 false negative에 대한 완전한 보장은 제공하지 않습니다.
현재 Windows 실제 심볼릭 링크 3개와 junction의 실제 검증도 앞 절의 미검증 항목입니다. 이 구현은 디렉터리 모드의 단일 Gitleaks 프로세스를 중단하며, 예상하지 못한 하위 프로세스 트리까지 OS 격리로 보장하지는 않습니다.

### 미검증 심볼릭 링크와 외부 Repository 검사 전 확인

원본에서 계속 미검증으로 기록된 Windows 심볼릭 링크 테스트 3개는 파일 링크, 디렉터리 링크, 직접 지정 경로의 링크 조상이며 Windows `os.symlink` 생성이 OSError로 실패했습니다.
기존 링크 거부 코드는 유지합니다. 이번 작업에서 관리자 권한 요청, 개발자 모드 활성화, Windows 설정 변경을 하지 않습니다.

실제 외부 Repository 검사 전에는 이미 링크 생성 권한이 있는 승인된 환경(예: 기존 Linux 테스트 환경)에서 허가된 작업 폴더 안의 fixture만 사용해 다음 검증을 수행해야 합니다. 이 단계에서 새 Clone이나 외부 Repository 접근은 수행하지 않았습니다.

```powershell
.\.venv\Scripts\python.exe -m pytest -q -rs tests\test_security_gate.py -k real_symlink
```

세 경우가 SKIP 없이 통과하는지 확인하세요. Windows junction/reparse point의 실제 파일시스템 검증도 필요합니다. 현재 reparse 속성 분기는 단위 테스트로만 확인합니다.
링크가 정상 파일 검사로 넘어가지 않고 SCAN_FAILED가 되며, 링크 대상 내용을 읽거나 실행하지 않는지를 승인된 고정 스냅샷에서 확인해야 합니다.
Semgrep 소스 탐색과 익명 경로의 범위 검사도 별도로 검증하세요. 현재 모의 경로 이탈 테스트는 Semgrep JSON의 잘못된 경로가 보고서로 넘어가는 것을 방지하는 검증이며 실제 링크 생성 검증을 대체하지 않습니다.

## 테스트 방법과 검증 결과

현재 다중 언어 작업의 실제 결과와 Windows 초기화 오류 진단은 [MULTILANGUAGE_VALIDATION.md](docs/MULTILANGUAGE_VALIDATION.md)에 기록합니다. 아래의 패키징/원본 lab 수치는 과거 실행 기록이며 이번 실제 CLI 통과를 의미하지 않습니다.

```powershell
# 전체 회귀: 설치되어 있으면 실제 CLI 검사도 실행
.\.venv\Scripts\python.exe -m pytest -q -rs
# 실제 도구 테스트만
.\.venv\Scripts\python.exe -m pytest -q -rs -m 'semgrep_real or gitleaks_real'
# 실제 CLI를 제외한 모의·AST·Docker 검사
.\.venv\Scripts\python.exe -m pytest -q -rs -m 'not semgrep_real and not gitleaks_real'
# 최종 통합 시나리오
.\.venv\Scripts\python.exe -m pytest -q -rs tests\test_final_integration.py
```

실제 CLI 테스트는 도구가 없을 때 사유를 표시하고 SKIP합니다. 설치된 도구가 오류를 반환하면 실패하며 모의 결과로 대체하지 않습니다. 정상, Docker/Semgrep/Secret 개별 위험, 복합 위험, 미설치·실행 오류·타임아웃·JSON 오류·AST 오류·누락/접근 오류·로그 비노출·정리 실패·JSON 1.0/2.0/3.0 호환성을 검증합니다.

제출본의 전체 pytest는 **204 passed / 0 failed / 17 skipped**입니다. 17개는 실제 CLI 미설치에 따른 14개와 Windows 심볼릭 링크 생성 불가 3개입니다. 코드·테스트·규칙·requirements·JSON 스키마는 원본과 바이트 단위로 동일합니다. 실제 Semgrep·Gitleaks 탐지는 제출본에서 재실행하지 않았으며, 설치 후 위 전체 테스트와 실제 CLI 명령으로 다시 확인해야 합니다. 기존 Engine 회귀 테스트는 `fastapi` 미설치로 수집이 중단되어 미검증입니다. 자세한 실행 명령·결과는 패키징 검증 문서를 참고하세요.

원본의 최종 기록은 **218 passed / 0 failed / 3 skipped**, 실제 Semgrep 1.180.0 및 Gitleaks 8.30.0을 사용한 정상 ALLOW·개별/복합 위험 DENY입니다. 제출본에서 새로 실행한 결과는 [docs/PACKAGING_VALIDATION.md](docs/PACKAGING_VALIDATION.md)에 별도로 기록합니다. 원본의 실제 탐지 성공을 제출본의 새 실제 CLI 실행으로 보고하지 않습니다.

## Engine 담당자용 인터페이스

이번 제출본은 독립 실행만 지원하며 기존 Engine 코드는 수정하거나 연결하지 않았습니다.

1. Engine이 접근을 허가한 변경되지 않는 로컬 Repository 스냅샷의 **절대 디렉터리 경로**를 준비합니다. URL 입력, 원격 Clone, 대상 소스 실행은 지원하지 않습니다.
2. `apps/security-gate`를 cwd로 정하고 이 패키지의 Python으로 `main.py <authorized-path> --with-gitleaks`를 인자 배열·shell=False로 호출합니다. stdout은 단일 JSON, 종료 코드는 위 계약입니다. 설치 위치는 이 패키지 내부로 고정되며 검사 대상 경로에서 도구를 로드하지 않습니다.
3. 또는 `security_gate.gate3.scan_full_repository(target, *, docker_timeout_seconds=5.0, semgrep_timeout_seconds=30.0, gitleaks_timeout_seconds=30.0, max_file_bytes=1048576)`를 호출합니다. 반환값은 JSON 3.0에 해당하는 dict입니다. 모의 테스트용 runner 주입 인자는 외부 요청에 노출하지 마세요.
4. Engine 측에서 호출 자체의 실패·전체 시간 초과·빈 stdout·JSON/스키마 오류·종료 코드와 판정 불일치를 검사 실패로 처리합니다. JSON 3.0의 **명시적 ALLOW, Semgrep·Gitleaks 성공, Docker 성공 또는 NOT_APPLICABLE**을 승인 조건으로 사용합니다. REVIEW·DENY·SCAN_FAILED는 자동 승인하지 않습니다. 이번 변경에서 Engine 코드는 수정하지 않습니다.
5. 도구별 실패 코드와 위험 근거를 함께 보존합니다. 경로와 서비스명도 공유 메타데이터이므로 Engine 로그 접근 범위를 정하고 raw CLI 출력/원본 보고서를 노출하지 마세요.

도구별 기본 시간 제한은 Docker 5초, Semgrep/AST 30초, Gitleaks 30초입니다. 검사는 순차 실행하므로 전체 호출 예산은 합계에 프로세스 시작·I/O·정리 여유를 더해 별도로 정해야 합니다. 무조건 30초를 전체 호출 제한으로 해석하면 안 됩니다. API 요청/응답 계약, 작업 큐·권한 정책·배포 환경은 향후 Engine 작업에서 결정합니다.

## 현재 범위와 한계

ALLOW는 선택한 버전의 제한된 규칙 통과이며 전체 보안 보장이 아닙니다. 기본 1.0과 선택적 2.0의 ALLOW는 세 도구 검사 통과와 범위가 다릅니다.

- Docker: privileged 직접 선언만 검사합니다. 환경변수 해석·Compose override/include/extends 병합과 네트워크·볼륨·capabilities 검사는 포함하지 않습니다.
- Python: 실행 중인 Python 버전의 AST 문법과 두 직접 호출 패턴만 검사합니다. 새 버전 문법·별칭·래퍼·타입/스코프·런타임 검증은 범위 밖입니다.
- Java: Runtime.exec와 ProcessBuilder.start의 최소 로컬 패턴만 검사합니다. Spring Boot 전체 보안 검증이나 컴파일 검증은 아닙니다.
- JavaScript/TypeScript: eval, Function 생성, 직접적인 Node shell 실행 패턴을 검사합니다. 별칭/래퍼 전체, 데이터 흐름, XSS, 외부 의존성·CDN 코드, 템플릿 렌더링은 검증하지 않습니다. 지원 언어 검사 성공과 별개로 미검사 범위가 남으면 REVIEW입니다.
- Gitleaks: UTF-8 텍스트 내용만 검사합니다. Git history, 바이너리, 압축/재귀 디코딩, 원격 Secret 유효성 검증은 수행하지 않습니다. 익명 파일명에 따른 경로 기반 규칙 차이와 파일별 실제 완료 목록의 한계가 있습니다.
- Windows 심볼릭 링크 3개와 실제 junction 검증은 남아 있습니다. 관리자 권한이나 Windows 설정 변경으로 해결하지 않습니다.
- 임시 파일 정리는 일반 삭제입니다. Windows ACL은 상속되며 물리적 보안 삭제·백업 삭제를 보장하지 않습니다. 정리 실패 시 임시 자료가 남을 수 있으므로 SCAN_FAILED와 작업 폴더 상태를 확인해야 합니다.
- 크기·탐색·결과·시간 제한은 적용하지만 OS 수준의 완전한 파일/네트워크/메모리 격리나 소스 동시 변경 방지는 제공하지 않습니다. 신뢰된 도구와 고정 로컬 스냅샷을 사용하세요.

README는 현재 인터페이스의 기준이고, [LAB_VALIDATION_HISTORY.md](docs/LAB_VALIDATION_HISTORY.md)는 과거 실험·오류 수정·당시 결과를 보존하는 기록입니다. 역사 문서의 과거 미설치·미구현 문구를 현재 기능 상태로 해석하지 마세요. [PACKAGING_VALIDATION.md](docs/PACKAGING_VALIDATION.md)는 제출본의 검증 및 미검증 항목을 기록합니다.
