# 제출용 Security Gate 패키징 검증

검증일: 2026-10-09. 대상은 제출용 작업본의 `apps/security-gate/`이며 원본 lab은 읽기 전용으로 유지했습니다. 기존 Engine 연동, Docker 실행, 클라우드 배포, Git commit/push/PR/merge는 수행하지 않았습니다.

## 문서 역할과 정보 보존

- `README.md`: 제출본의 현재 구성·설치·실행·JSON 1.0/2.0/3.0·정책·Engine 인터페이스·범위·한계.
- `docs/LAB_VALIDATION_HISTORY.md`: 원본 530줄 README 전문을 보존한 실험 이력. 원본의 개인 절대 경로만 `<SECURITY_GATE_ROOT>`로 바꾸었습니다. 과거 미설치/미구현 문구와 단계별 테스트 수는 당시 상태입니다.
- 이 문서: 새 제출본에서 실제 수행한 검증, 제외·미검증 항목과 변경 범위.

README를 삭제하지 않고 직접 갱신했습니다. 전체 정보가 이력 문서에 남아 있는지 원본 전문과 비교했고, 설치/운영/계약/인터페이스에 필요한 항목은 현재 README에 유지했습니다.

## 복사와 변경 범위

원본에서 소스·테스트·fixture·로컬 규칙·스키마·requirements·문서/예시 68개를 명시적으로 복사했습니다. 최종 제출 후보는 70개입니다. 모든 경로는 `apps/security-gate/` 아래이며 git add/commit은 하지 않았습니다.

원본과 바이트 단위로 동일한 파일은 58개입니다. 여기에는 Scanner 소스, CLI, 기존 테스트 전체, fixture, 로컬 규칙, JSON 스키마와 requirements가 포함됩니다. 코드나 검사 정책은 수정하지 않았습니다.

원본 대비 정리한 파일 10개:

- `.gitignore`: 가상환경·임시 보고서·캐시·로그·DB·바이너리·개인 인증 파일 제외, 명시적 인공 `settings.env` fixture 네 개 예외.
- `README.md`: 제출본용 현재 가이드로 직접 갱신.
- `examples/README.md`: 원본 실제/모의 검증의 출처와 경로 익명화 안내.
- `examples/request-v3.json`: 패키지 디렉터리 기준 상대 입력 경로.
- `examples/normal-v3.json`, `docker-risk-v3.json`, `semgrep-risk-v3.json`, `secret-risk-v3.json`, `combined-risk-v3.json`, `cleanup-failure-v3.json`: 개인 절대 경로 접두사만 익명화한 정규화 결과.

새 문서 2개: `docs/LAB_VALIDATION_HISTORY.md`, `docs/PACKAGING_VALIDATION.md`.

원본 `.venv`, `.tmp`, 로컬 DB, 로그, 캐시, 바이너리, 진단 원본 보고서, 개인 환경 파일은 복사하지 않았습니다. 제출본의 pytest 임시 파일과 JUnit 보고서는 Git ignore 대상입니다. 네 개 `settings.env` fixture는 실제 인증정보가 없는 공개 인공 테스트 데이터입니다.

## 자동화 테스트: 실제 실행

원본 Python 가상환경의 인터프리터와 설치된 테스트 의존성을 읽기 전용으로 사용했습니다. 검사 대상/임포트 경로는 복사된 제출본이며, bytecode 쓰기를 비활성화하고 모든 테스트 임시 경로를 제출본 내부로 지정했습니다. 새 가상환경 설치와 네트워크 다운로드는 수행하지 않았습니다.

실행 cwd: 제출용 `apps/security-gate`.

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
New-Item -ItemType Directory -Force -Path .tmp | Out-Null
$env:TEMP = Join-Path $PWD '.tmp'
$env:TMP = $env:TEMP
# 패키징 검증에만 원본의 설치된 인터프리터를 읽기 전용으로 사용
& 'D:\workspaces\orca-workspace\security-gate-lab\.venv\Scripts\python.exe' -B -m pytest -q -rs -o junit_family=xunit1 --junitxml=.tmp/packaging-validation.xml
```

결과: **204 passed / 0 failed / 17 skipped**, 31.82초. JUnit: 221 tests, failures 0, errors 0, skipped 17. 기존 STEP 1·2·3·4 테스트를 삭제하거나 수정하지 않았습니다.

| 건너뜀 사유 | 개수 |
| --- | ---: |
| 제출본 Semgrep CLI 미설치: 실제 Semgrep 테스트 | 4 |
| 제출본 Gitleaks CLI 미설치: 실제 Gitleaks 테스트 | 3 |
| 두 CLI 미설치: 최종 실제 통합/CLI 테스트 | 7 |
| Windows 실제 심볼릭 링크 생성 OSError | 3 |

204개 통과에는 실제 Docker YAML 파싱, Python AST 파싱, 모의 Semgrep/Gitleaks 결과, 오류·타임아웃·누락·정리 실패 주입, Secret 비노출 및 세 버전 JSON 계약 검증이 포함됩니다. 모의 탐지 통과를 실제 Scanner 탐지 성공으로 보고하지 않습니다.

## 제출본 CLI 및 JSON 추가 확인

원본 인터프리터로 제출본 `main.py`를 실행하고 stdout/stderr와 종료 코드를 캡처했습니다. 대상 fixture 코드는 직접 실행하지 않았습니다. 각각 출력 JSON을 해당 버전 스키마로 검증했습니다.

| 실제 제출본 호출 | JSON | 결과 | exit |
| --- | --- | --- | ---: |
| tests/fixtures/safe | 1.0 | ALLOW / SUCCESS | 0 |
| tests/fixtures/deny | 1.0 | DENY / SUCCESS | 1 |
| tests/fixtures/dynamic | 1.0 | REVIEW / SUCCESS | 2 |
| tests/fixtures/malformed | 1.0 | SCAN_FAILED / FAILED | 3 |
| 존재하지 않는 로컬 경로 | 1.0 | SCAN_FAILED / FAILED | 3 |
| semgrep/safe --with-semgrep | 2.0 | SCAN_FAILED / SEMGREP_NOT_INSTALLED | 3 |
| semgrep/invalid --with-semgrep | 2.0 | SCAN_FAILED / SOURCE_SYNTAX_INVALID | 3 |
| integration/combined --with-gitleaks | 3.0 | SCAN_FAILED / 두 CLI 미설치, Docker 위험 근거 1개 보존 | 3 |

정규화 출력 예시 6개는 익명화 후 JSON 3.0 오프라인 스키마 검증을 모두 통과했습니다. API 입력 예시 1개는 출력 스키마 검증 대상이 아닙니다.

제출본 Semgrep/Gitleaks 바이너리는 설치되지 않았습니다. 두 도구의 실제 탐지·native redaction·프로세스 종료·실제 정상 통합 ALLOW는 이 제출본에서 재검증하지 못했습니다. 원본의 실제 Semgrep 1.180.0 및 Gitleaks 8.30.0 탐지 기록은 역사 문서/예시로만 보존했습니다.

## 민감정보 보호와 제외 확인

- CLI 추가 확인 8건의 stdout/stderr, 출력 예시 6개, 이번 JUnit 보고서에 fixture의 테스트 Secret 원문이 없는지 확인했습니다.
- 기존 테스트가 원본 보고서의 Secret/Match/Description/Fingerprint/주변 소스, 예외·오류 로그 원문의 비노출을 검증합니다.
- 정상·탐지·JSON 오류·타임아웃·정리 실패 처리 테스트가 유지됩니다. 실제 Gitleaks 임시 보고서의 동작은 바이너리 설치 후 재검증이 필요합니다.
- `git check-ignore`로 `.venv`, `.tmp`, `.env`, Gitleaks 실행 파일, DB, 로그, `.aws/credentials`, 개인 credential JSON이 제외되는지 확인했습니다.
- 네 개 인공 `settings.env` fixture는 ignore되지 않고 제출 후보에 포함되는지 확인했습니다. 실제 Secret을 쓰거나 파일을 만들지 않았습니다.
- Scanner 임시 자료는 정상/실패 시 정리하는 정책을 유지합니다. 정리 실패는 SCAN_FAILED이며 일반 삭제를 물리적 보안 삭제로 간주하지 않습니다.

## 기존 팀 기능 회귀의 제한

기존 Engine 테스트 수집만 다음 명령으로 시도했습니다. bytecode 쓰기를 끄고 basetemp/cache를 새 패키지 내부로 지정했습니다.

```powershell
# cwd: apps/security-gate, 위와 같은 PYTHONDONTWRITEBYTECODE/TEMP/TMP
& 'D:\workspaces\orca-workspace\security-gate-lab\.venv\Scripts\python.exe' -B -m pytest --collect-only -q -c ../engine/pytest.ini ../engine/tests --basetemp=.tmp/engine-regression -o cache_dir=.tmp/engine-cache
```

`conftest.py`의 `fastapi.testclient` import에서 **ModuleNotFoundError: No module named 'fastapi'**, exit 1로 수집이 중단됐습니다. Engine 테스트는 실행되지 않았으며 회귀 통과로 보고하지 않습니다. 보안 검사기의 0 failed와 별개의 검증 제한입니다.

제출용 저장소에 Node 의존성 디렉터리도 없었습니다. 기존 Web/Shakedown/infra 테스트·빌드·배포는 실행하지 않았으며, 이를 해결하려고 기존 디렉터리에 의존성을 설치하거나 파일을 수정하지 않았습니다. 팀의 기존 CI 환경에서 해당 회귀를 별도로 확인해야 합니다.

## 변경 범위의 무결성 확인

작업 전후 원본 파일 7,110개를 읽어 상대 경로와 파일별 SHA-256으로 구성한 집계 해시를 비교했습니다. `.git`는 제외했습니다. 파일 수와 해시가 동일합니다.

```text
원본 집계 SHA-256:
5544a7f1ee4751720f259073971d6c32b2fad331c34c477eebbaad4dbe366fe1
```

제출용 저장소의 기존 파일 170개(`.git` 및 새 `apps/security-gate` 제외)도 작업 전후 경로·내용 해시가 동일합니다. Git status의 변경 후보는 새 패키지 내부에만 있습니다. 이는 파일 미변경 증거이며 기존 기능 테스트 통과를 대신하지 않습니다.

## 사용자가 수행할 실제 Scanner 재검증

일반 PowerShell에서 제출본 README대로 패키지 `.venv`와 Gitleaks를 준비한 뒤 아래 명령을 실행하세요. 관리자/시스템 설정 변경은 필요하지 않습니다.

```powershell
# 팀 저장소 루트에서
Set-Location .\apps\security-gate
.\.venv\Scripts\semgrep.exe --version
.\tools\gitleaks\gitleaks.exe version
.\.venv\Scripts\python.exe -m pytest -q -rs
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\gitleaks\safe --with-gitleaks
$LASTEXITCODE  # 모든 필수 검사 완료 시 ALLOW / 0
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\integration\combined --with-gitleaks
$LASTEXITCODE  # 모든 필수 검사 완료 시 DENY / 1, Docker 1 + Semgrep 2 + Gitleaks 1
.\.venv\Scripts\python.exe .\main.py .\tests\fixtures\semgrep\invalid --with-gitleaks
$LASTEXITCODE  # SCAN_FAILED / 3, SOURCE_SYNTAX_INVALID
```

Windows 심볼릭 링크 3개와 실제 junction은 README의 승인된 기존 환경 검증 안내를 따릅니다. 이 패키징을 위해 관리자 권한이나 Windows 설정 변경을 요청하지 않습니다. 기존 Engine에는 실제로 연결하지 않았고, 향후 입력 경로·CLI/API·JSON·종료 코드·실패 정책은 README에 문서화했습니다.
