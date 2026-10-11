# Engine 재배포 시간 측정 및 Windows 테스트 개선 — 검증 보고서

- **작성일:** 2026-10-11
- **관련 PR:** [#47 — 재배포 시간 측정 안정화 및 Windows 테스트 개선](https://github.com/SoftBankHackathon/shakedown/pull/47)
- **작업 브랜치:** `fix/engine-redeploy-timing-windows`
- **PR 최초 기준 커밋:** `80c89bbe6d7a85e49eb2dac43553aaea4e48bc10`
- **검증 대상:** Engine의 GCP 수정 적용 후 재배포 시간 누적 계산, 회귀 테스트, Windows 심볼릭 링크 테스트
- **검증 환경:** Windows / PowerShell / Python 가상환경 / pytest
- **상태:** PR 브랜치의 최종 테스트 결과 기입 후 제출

## 1. 배경 및 목적

Engine에서 차단 판정 후 수정안을 적용하여 GCP에 재배포하는 과정의 경과 시간은 `timings.deploy_s`에 누적됩니다. 짧은 실행 구간에서 경과 시간과 기존 누적값을 한 식으로 연산하던 구현 및 운영체제별 테스트 실행 차이를 점검하기 위해 PR #47을 작성했습니다.

이 개선은 **시간 측정 및 테스트의 안정화**를 목적으로 하며, 배포 정책이나 보안 게이트 승인 기준을 변경하지 않습니다.

## 2. 변경 파일과 검증 포인트

| 파일 | 변경 사항 | 검증 포인트 |
| --- | --- | --- |
| `apps/engine/engine/deployments.py` | 수정 적용 후 재배포 구간 측정에 `time.perf_counter()`를 사용하고 `elapsed`를 먼저 계산한 뒤 기존 `deploy_s`에 누적 | 경과 시간 누적 연산 및 재배포 흐름 유지 |
| `apps/engine/tests/test_fixes.py` | 재배포 시간 회귀 테스트에서 `monotonic` 값을 고정하고 실제 `perf_counter`를 사용하는 테스트 조건 추가 | 짧은 재배포 구간에서 `deploy_s` 증가, 최초 빌드 시간 유지, 사용자 대기 시간 제외 |
| `apps/engine/tests/test_image_builder.py` | Windows 심볼릭 링크 생성 시 `WinError 1314`(권한 없음)인 경우에만 테스트를 건너뜀 | 지원되지 않는 Windows 권한 환경에서 불필요한 실패 방지, 다른 오류는 예외 유지 |

### 주요 시간 측정 변경

변경 전:

```python
d['timings']['deploy_s'] = d['timings'].get('deploy_s', 0) + time.monotonic() - deploying
```

변경 후:

```python
deploying = time.perf_counter()
# 수정 적용 재배포 ...
elapsed = time.perf_counter() - deploying
d['timings']['deploy_s'] = d['timings'].get('deploy_s', 0) + elapsed
```

**주의:** `perf_counter()`가 모든 Windows 환경에서 `monotonic()`보다 정밀하다고 단정하는 것은 아닙니다. 이 PR은 측정 구간에 일관된 시계를 사용하고, 경과 시간을 먼저 계산한 뒤 누적하도록 계산 순서를 명확히 합니다. 실제 클라우드 배포 시간의 정밀도가 향상됐다는 실측 결과를 제공하는 것은 아닙니다.

## 3. 테스트 실행 방법

PR 브랜치의 독립 작업 폴더에서 실행합니다. 실제 Docker/클라우드 배포를 수행하는 명령이 아닙니다.

```powershell
$PR = "D:\workspaces\shakedown-engine-timing-pr-20261011"
$Py = "D:\workspaces\shakedown-review-20261010\apps\engine\.venv\Scripts\python.exe"

Set-Location $PR
$env:PYTHONUTF8 = "1"
$env:PYTHONPATH = "$PR\apps\engine"

# 수정 범위에 해당하는 테스트
& $Py -X utf8 -m pytest -q --tb=short `
  .\apps\engine\tests\test_fixes.py `
  .\apps\engine\tests\test_image_builder.py
Write-Host "Targeted Test Exit Code: $LASTEXITCODE"

# Engine 전체 회귀 테스트
& $Py -X utf8 -m pytest -q --tb=short .\apps\engine\tests
Write-Host "Full Test Exit Code: $LASTEXITCODE"
```

## 4. 실행 결과

### 4.1 기존 독립 로컬 검증 결과 (PR 작성 이전)

| 항목 | 관찰 결과 |
| --- | --- |
| 실행 대상 | 기존 독립 검증 복사본 (`shakedown-review-20261010`)의 Engine 테스트 |
| 반복 횟수 | 3회 |
| 회차별 결과 | **449 passed / 20 skipped / 0 failed** |
| 특징 | 로컬 Windows 회귀 테스트에서 오류 없이 반복 완료 |

> 이 수치는 **PR 작성 이전의 별도 로컬 복사본**에서 얻은 기록입니다. 최신 `main` 기반 PR 브랜치의 결과로 간주하지 않습니다. 20개의 건너뜀에는 Windows에서 수행할 수 없는 POSIX 관련 테스트와 심볼릭 링크 권한 테스트가 포함됩니다.

### 4.2 PR #47 브랜치의 최종 검증 결과 — 작성자가 입력

| 항목 | 결과 |
| --- | --- |
| 브랜치 | `fix/engine-redeploy-timing-windows` |
| 기준 커밋 | `80c89bbe` (PR 작성 시점 기준) |
| 변경 파일 테스트 (`test_fixes.py`, `test_image_builder.py`) | **[passed] passed / [skipped] skipped / [failed] failed** |
| 변경 파일 테스트 종료 코드 | **[0 또는 실제 종료 코드]** |
| Engine 전체 테스트 | **[passed] passed / [skipped] skipped / [failed] failed** |
| Engine 전체 테스트 종료 코드 | **[0 또는 실제 종료 코드]** |
| 테스트 실행 일시 | **[YYYY-MM-DD HH:MM KST]** |
| 테스트 로그·스크린샷 링크 (선택) | **[링크 또는 없음]** |

**완료 기준:** 두 테스트 명령이 모두 종료 코드 `0`으로 끝나고, 변경에 의한 예상 외 테스트 실패가 없어야 합니다. `skipped`는 테스트를 실행하지 않은 항목이므로 통과로 간주하지 않습니다.

### 4.3 추가 정적 검증

다음 명령을 사용해 변경 파일 범위 및 패치 공백 오류를 확인했습니다.

```powershell
git status --short
git diff --stat
git diff --check
```

PR에 제출한 코드 변경 범위는 `deployments.py`, `test_fixes.py`, `test_image_builder.py`의 세 파일이며, 확인 시점의 변경 통계는 **13 insertions / 4 deletions**였습니다. 기존 샘플 앱, Security Gate 정책, 다른 팀원 변경 파일은 이 PR에 포함하지 않았습니다.

## 5. 주요 검증 시나리오

| 시나리오 | 확인 사항 | 관련 테스트 |
| --- | --- | --- |
| 수정 적용 후 GCP 재배포 | `deploy_s`에 재배포 경과 시간이 추가됨 | `test_fix_timings_add_the_redeploy_but_not_the_wait_before_the_click` |
| 수정 전 사용자 대기 | 차단 판정 후 버튼 클릭까지의 대기 시간이 최종 `total_s`에 포함되지 않음 | 동일 테스트 |
| 재빌드 방지 | 수정 적용 과정에서 기존 `build_s`가 유지됨 | 동일 테스트 |
| 심볼릭 링크 제외 | 소스의 심볼릭 링크가 복사된 스냅샷에 포함되지 않음 | `test_snapshot_skips_symlinks` |
| Windows 권한 제한 | `WinError 1314`에서만 심볼릭 링크 테스트를 건너뜀 | `test_snapshot_skips_symlinks` |
| Engine의 기타 동작 영향 | 기존 Engine 테스트 전체 회귀 여부 확인 | `apps/engine/tests` 전체 |

## 6. 검증 범위와 제한 사항

- 이 보고서는 **로컬 pytest 기반 회귀 테스트**를 다룹니다. 실제 GCP 리소스 생성·재배포, 클라우드 과금, Local Docker 배포 실측은 수행하지 않았습니다.
- 테스트의 GCP·Local 동작은 프로젝트 테스트 더블을 사용합니다. 실제 네트워크 지연이나 모든 운영체제의 시계 동작을 재현하는 것은 아닙니다.
- Windows에서 심볼릭 링크 생성 권한이 없는 경우 해당 테스트는 **SKIP**됩니다. 심볼릭 링크를 실제 생성할 수 있는 환경에서 수행한 통과 결과와 구분해야 합니다.
- 기존 독립 검증 결과와 최신 PR 브랜치의 결과를 구분했습니다. **4.2절을 실제 결과로 채운 후 리뷰 요청**하는 것을 권장합니다.
- PR 생성은 자동 병합을 의미하지 않으며, 팀의 코드 리뷰 후 병합 여부를 결정합니다.

## 7. 리뷰 요청 사항

1. `elapsed`를 먼저 계산하여 `deploy_s`에 누적하는 수정이 기존 시간 지표 계약에 부합하는지 검토 부탁드립니다.
2. 재배포 시간 테스트의 고정 시계 조건이 회귀 검증에 적절한지 검토 부탁드립니다.
3. Windows `WinError 1314`에 한정된 `pytest.skip` 처리가 팀 테스트 정책에 맞는지 검토 부탁드립니다.
