# Java 지원 수정 및 검증 기록

이 문서는 첫 번째 수정 당시의 기록이다. 후속 JavaScript/TypeScript 확장 및 최신 결과는 [MULTILANGUAGE_VALIDATION.md](MULTILANGUAGE_VALIDATION.md)를 참조한다.

작업일: 2026-10-09. 브랜치: `fix/security-gate-java-support`.
**구현은 반영했으나 실제 Semgrep 검증이 막혀 완료 기준은 미충족이다.**
변경은 `apps/security-gate/` 내부에 한정했다. Commit, Push, PR, Merge, 브랜치 전환,
Docker Build/실행, 배포, 관리자 권한/Windows 설정 변경은 수행하지 않았다.

## 변경 파일 목록

기존 파일 수정:

- `README.md`: 적용 범위, 판정 정책, 바이너리 예외, JSON 호환성 설명.
- `security_gate/source_targets.py`: Java 수집, 미지원 언어·알 수 없는 파일·HTML/SVG 스크립트 식별.
- `security_gate/source_syntax.py`: Python 파일에만 AST 사전 검증.
- `security_gate/semgrep.py`: 두 로컬 규칙 파일, 확장자 보존, 언어/미지원 범위 보고.
- `security_gate/gate.py`: Compose NOT_APPLICABLE만 집계에서 제외.
- `security_gate/parsing.py`: 기존 안전 읽기 제한을 유지하는 바이트 읽기 분리.
- `security_gate/secret_targets.py`: 제한된 Gradle wrapper JAR 형식 검증 및 제외.
- `security_gate/gitleaks.py`: 제외 바이너리 개수 보고.
- `security_gate/gate.schema.json`, `security_gate/gate3.schema.json`: Java 근거·추가 필드·판정 조건.
- `tests/test_semgrep.py`, `tests/test_gitleaks.py`: 기존 Python 규칙 검증 유지, 의도적으로 바뀐 Compose 없음 기대값 반영.
- `tests/test_semgrep_real.py`: 실제 Java 정상·위험·혼합·구문 오류 테스트 추가.

새 파일:

- `semgrep_rules/java-security.yml`
- `tests/fixtures/semgrep/java_safe/BoardService.java`
- `tests/fixtures/semgrep/java_vulnerable/CommandService.java`
- `tests/test_java_support.py`
- `tests/test_java_board_real.py`
- `docs/JAVA_SUPPORT_VALIDATION.md`

총 19개 소스/문서 파일. `.venv/`, `.tmp/`, `tools/gitleaks/`는 기존 `.gitignore`에 의해 제외된다.
규칙 Registry, `--config auto`, 원격 규칙 다운로드는 사용하지 않는다.

## Gitleaks 재사용

원본은 읽기 전용으로 사용했다:
`D:\workspaces\orca-workspace\security-gate-lab\tools\gitleaks\gitleaks.exe`.
복사본은 이 패키지의 `tools/gitleaks/gitleaks.exe`이며 실제 버전 출력은 `8.30.0`이다.
원본과 복사본의 SHA-256은 다음과 같이 일치한다.

```text
9D08E3F5CFB35A98F230B97BCDA24F8D3FC66363C91868FFC98DAC0AFEBDCB72
```

`git check-ignore tools/gitleaks/gitleaks.exe`로 제외를 확인했다.
사용자 지시 이후 네트워크 다운로드를 중단했고 기존 실행 파일을 재사용했다.

## 테스트 결과

Python 3.12 환경, 설치된 Semgrep 패키지 1.180.0, Gitleaks 8.30.0으로 실행했다.

| 구분 | 통과 | 실패 | 건너뜀 |
| --- | ---: | ---: | ---: |
| 기존 회귀 221개 | 207 | 11 | 3 |
| 신규 테스트 73개 | 62 | 11 | 0 |
| 전체 | 269 | 22 | 3 |

전체 실행 시간 113.43초. 결과 파일은 `.tmp/java-full-results.xml`이다.
기존 회귀 중 Compose 없음에 대한 두 기대값만 새 정책에 맞춰 변경했고 테스트를 삭제하지 않았다.

CLI를 제외한 실행은 **258 passed / 0 failed / 3 skipped**였다.
그중 기존 회귀 204개와 신규 단위/정책 검사 54개가 통과했다.
Gitleaks 단독 실제 엔진 검사는 기존 2개와 신규 8개, 총 10개가 통과했다.
신규 8개는 wrapper JAR과 함께 `.env`, `.properties`, `.yaml`, `.json`, `.xml`,
`.gradle`, `.gradle.kts`, `.java` 텍스트의 인공 Secret 탐지를 검증한다.
JSON 및 캡처한 stdout/stderr에 인공 Secret 원문이 없는 것도 확인했다.

실패한 22개는 실제 Semgrep을 호출하는 테스트다. 정상 Python·Java fixture도 스캔 시작 전에
다음 오류로 종료되어 정규화된 결과는 `SEMGREP_EXECUTION_FAILED / SCAN_FAILED`가 된다.

```text
Failure: ca_certs_iter_on_anchors: CertOpenSystemStore returned NULL
```

허용된 pytest 명령의 샌드박스 밖 재시도에서도 동일 증상이 있었다.
기존 lab과 설치된 semgrep-core.exe 해시도 같았다. Windows 인증서 저장소·권한·시스템 설정은 변경하지 않았다.
진단용 CLI frontend 변경은 효과가 없어 최종 코드에 남기지 않았다.
**실제 Java 정상 ALLOW·위험 DENY·혼합 언어 검사 성공은 미검증이며 모의 통과로 대체하지 않는다.**
구문 오류 테스트도 먼저 정상 Java 엔진 실행을 확인하도록 작성하여, 엔진 시작 실패를 파싱 검증 성공으로 오인하지 않는다.
해당 두 테스트의 최종 보강 후 재실행 역시 정상 Java 사전 검사에서 2 failed였다.

건너뛴 3개는 Windows 실제 심볼릭 링크 생성 권한이 없는 기존 테스트다.
링크/reparse 분기와 파일/누적 크기 제한의 단위 테스트는 통과했으나 실제 junction 검증은 남아 있다.

## 요청 시나리오별 확인

| 시나리오 | 확인 결과 |
| --- | --- |
| 정상 Python + Compose → ALLOW | 기존 모의 회귀 통과, 실제 Semgrep 실행 차단 |
| 기존 Python 위험 → DENY | 기존 모의 회귀 통과, 실제 Semgrep 실행 차단 |
| 정상 Java + Compose 없음 → ALLOW | 정책/스키마 단위 검사 통과, 실제 엔진 실행 차단 |
| Java 위험 → DENY | 로컬 규칙 및 fixture 추가, 실제 탐지 미검증 |
| Java + gradle-wrapper.jar | 실제 Gitleaks에서 wrapper 제외 성공; 통합은 Semgrep 실패 |
| Java + Secret → DENY | 실제 Gitleaks 탐지/비노출 통과; 통합은 Semgrep 실패 우선 |
| 미지원 언어만 또는 Java와 혼합 | REVIEW 단위 검사 통과; unknown 및 HTML 스크립트 포함 |
| 미설치·시간 초과·부분 검사 | Java 및 기존 회귀에서 SCAN_FAILED 검증 통과 |
| 정상 Java + Python | 두 확장자 스냅샷·전체 파일 포함 검사 통과; 실제 탐지 미검증 |
| STEP 1~4 회귀 | 207 통과·11 실제 Semgrep 관련 실패·3 링크 건너뜀 |
| JSON 및 종료 코드 | 1.0/2.0/3.0 구조·이전 예시·위조 ALLOW 거부·기존 종료 코드 테스트 통과; 신규 실제 Java 정상/위험 종료 코드는 미검증 |
| Secret 원문 비노출 | 모의 예외/로그·실제 Gitleaks 보고서·stdout/stderr 검사 통과 |

## 실제 게시판 프로젝트

대상은 기존 `samples/kty-board` 디렉터리이다. 프로젝트 소스·빌드 파일을 수정하거나 실행하지 않았다.
전체 파일 49개의 검사 전후 SHA-256이 일치했다.

- Java 소스 27개 수집.
- HTML 템플릿 5개에서 미지원 JavaScript(스크립트 참조/본문 등) 확인.
- Docker: `NOT_APPLICABLE / REVIEW`, Compose 없음.
- Semgrep: `FAILED / SCAN_FAILED`, `SEMGREP_EXECUTION_FAILED`, 실제 검사 파일 0개.
- Gitleaks: `SUCCESS / ALLOW`, 텍스트 48개 제출, 검증된 wrapper JAR 1개 제외.
- 통합: **SCAN_FAILED, 종료 코드 3**, stderr는 비어 있음.

정규화 보고서는 `.tmp/java-board-report.json`, 요약은 `.tmp/java-board-summary.json`에 있다.
Java 검사가 성공하고 추가 위험이 없더라도 이 프로젝트 전체는 JavaScript 미지원 때문에 **REVIEW**가 기대값이다.
Java만 있는 정상 fixture는 Compose 없이 ALLOW가 기대값이다.

## 계약과 남은 범위

JSON 버전·중첩 구조·종료 코드 0/1/2/3은 유지한다. 1.0은 변경하지 않았다.
2.0 및 Semgrep scope는 Python/Java 범위를 나타내는 새 값으로 확장했다.
Semgrep에 언어·미지원 파일 수, Gitleaks에 바이너리 제외 수를 추가했다.
갱신된 Schema는 이전 scope와 기존 보고서를 허용하지만 구버전의 엄격한 Schema는 새 출력을 거부할 수 있다.
소비자는 새 Schema 및 Compose NOT_APPLICABLE 예외를 함께 적용해야 한다.

지원 소스는 Python/Java이며 각 두 최소 규칙만 적용한다.
JavaScript/TypeScript, Kotlin, Go, Ruby, C/C++, C#, Rust, PHP, Scala, Swift, 셸 등은 미지원이다.
알 수 없는 소스는 unknown으로 REVIEW한다. 정확한 확장자/파일명 분류는 `source_targets.py`에 있다.
정적 템플릿·설정·문서·명시된 빌드 스크립트/런처는 Secret 검사만 수행한다.
Java의 Spring 인증/인가, SQL injection, XSS, 역직렬화, 파일 간 추적, 컴파일·실행 검증은 범위 밖이다.
JAR 검증은 형식 검증이며 JAR 내부의 Secret 부재나 공급망 신뢰를 보증하지 않는다.
Gitleaks는 파일별 검사 완료 목록을 제공하지 않아 제출 개수와 정상 종료를 기준으로 보고한다.

## 일반 PowerShell 재검증 명령

추가 설치나 네트워크 없이 이 작업 디렉터리에서 실행한다. 모든 산출물은 패키지 내부 `.tmp`에 둔다.
기존 권한이 있는 일반 사용자 PowerShell에서 확인해야 하며 관리자 권한이나 보안 설정 변경은 요구하지 않는다.

```powershell
Set-Location D:\workspaces\orca-workspace\shakedown-security-stage\apps\security-gate
.\.venv\Scripts\python.exe -m pytest -q -rs --basetemp=.tmp/pytest-user-java -o cache_dir=.tmp/pytest-cache -o junit_family=xunit1 --junitxml=.tmp/java-user-results.xml
```

전체 통과 여부와 실제 Java 정상·위험 fixture, 게시판 호환성 결과를 확인한 후에만 완료 판정할 수 있다.
