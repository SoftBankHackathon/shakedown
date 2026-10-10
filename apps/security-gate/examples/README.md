> Packaging note: output paths use `<SECURITY_GATE_ROOT>` for portability. Reports retain their original lab-test provenance; they are not live approval results for this checkout. Run the request example from the package directory.

# JSON 3.0 입력·출력 예시

`request-v3.json`은 기존 `security_gate.gate3.scan_full_repository(**request)`의 키워드 인자를 나타냅니다. CLI에서는 같은 경로와 옵션을 인자로 전달합니다.

출력 파일은 `.tmp/final-validation.xml`에 기록한 정규화 보고서를 추출해 기존 JSON 3.0 스키마로 검증했습니다. 테스트 Secret 값은 포함하지 않습니다.

| 파일 | 출처 | Docker / Semgrep / Gitleaks 근거 수 | 최종 판정 |
| --- | --- | --- | --- |
| normal-v3.json | 실제 Scanner 통합 테스트 | 0 / 0 / 0 | ALLOW |
| docker-risk-v3.json | 실제 Scanner 통합 테스트 | 1 / 0 / 0 | DENY |
| semgrep-risk-v3.json | 실제 Scanner 통합 테스트 | 0 / 2 / 0 | DENY |
| secret-risk-v3.json | 실제 Scanner 통합 테스트 | 0 / 0 / 1 | DENY |
| combined-risk-v3.json | 실제 Scanner 통합 테스트 | 1 / 2 / 1 | DENY |
| cleanup-failure-v3.json | 정리 실패를 주입한 모의 테스트 | 1 / 2 / 1 | SCAN_FAILED |

실제 검증 버전은 Semgrep 1.180.0, Gitleaks 8.30.0입니다. 모의 정리 실패를 실제 OS 오류로 해석하지 마세요.
출력은 특정 시점의 로컬 fixture 검사 예시이며 임의의 다른 코드나 Repository를 승인하는 결과가 아닙니다. 파일 경로는 원본 검증의 위치 메타데이터이며 개인 절대 경로 접두사를 `<SECURITY_GATE_ROOT>`로 익명화했습니다.
`cleanup-failure-v3.json`은 `gitleaks.findings`를 보존하면서 `scan_status: FAILED`, `decision: SCAN_FAILED`, `errors: ["GITLEAKS_CLEANUP_FAILED"]`를 표시합니다.
