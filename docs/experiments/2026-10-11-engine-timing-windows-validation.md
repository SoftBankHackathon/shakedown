# Engine 재배포 시간 측정 및 Windows 테스트 개선 — 검증 보고서

> **PR:** [#47 — 재배포 시간 측정 안정화 및 Windows 테스트 개선](https://github.com/SoftBankHackathon/shakedown/pull/47)
> **작성·검증일:** 2026-10-11 (KST)
> **작업 브랜치:** `fix/engine-redeploy-timing-windows`
> **PR 코드 변경 커밋:** [`5ef697d`](https://github.com/SoftBankHackathon/shakedown/commit/5ef697db36c676faebed0de4e371ec0cb5f628c0)
> **최초 기준 main 커밋:** `80c89bbe`
> **검증 환경:** Windows / PowerShell / Python 가상환경 / pytest

## 1. 검증 결과 요약

| 항목 | 실제 관찰 결과 |
| --- | --- |
| 테스트 범위 | PR 코드가 반영된 로컬 작업 브랜치의 `apps/engine/tests` 전체 |
| **통과** | **448 passed** |
| **건너뜀** | **20 skipped** |
| **실패** | **0 failed** |
| 경고 | 1 warning — `StarletteDeprecationWarning` |
| pytest 소요 시간 | **17.01초** |
| 종료 코드 | **0 (PASS)** |
| 실행 일자 | 2026-10-11 (정확한 시각은 별도로 기록하지 않음) |
| 근거 | 작성자가 공유한 Windows PowerShell `pytest` 실행 결과 화면 |

**결론:** PR #47의 Engine 코드와 테스트 수정은 해당 Windows 로컬 환경에서 Engine 전체 회귀 테스트를 실패 없이 통과했다. 다만 이 결과는 **기능·테스트 안정성 검증**이지 **GCP 재배포 실행 속도 개선이나 배포 시간 단축의 실측 증거가 아니다**.

### SKIP 20건의 구성

| 구분 | 건수 | 확인된 이유 |
| --- | ---: | --- |
| Windows 심볼릭 링크 테스트 | 1 | 심볼릭 링크를 생성할 권한이 없어 `WinError 1314`에 한정해 SKIP |
| 실제 Security Gate 스캐너 연동 | 19 | POSIX 환경 및 프로젝트 로컬 Semgrep·Gitleaks CLI 필요 |
| **합계** | **20** | 미실행 항목이며 통과로 계산하지 않음 |

경고 1건은 FastAPI/Starlette `TestClient`에서 사용하는 `httpx` 관련 사용 중단 예정 안내로, 이번 PR 테스트의 실패는 아니었다. 테스트 수행을 위해 패키지 버전을 변경하거나 경고를 숨기지 않았다.

## 2. 변경 목적과 실제 수정 범위

차단 판정 후 수정 적용을 선택하면 Engine은 기존 이미지를 다시 빌드하지 않고, GCP에 수정된 환경변수를 전달해 재배포한다. 이때 2회차 재배포의 경과 시간을 `timings.deploy_s`에 누적해야 한다. PR #47은 이 **시간 누적 계산의 표현과 회귀 테스트 조건**, 그리고 Windows에서의 심볼릭 링크 테스트 처리만 변경한다.

| 변경 파일 | 실제 변경 사항 | 의도 및 검증 관점 |
| --- | --- | --- |
| `apps/engine/engine/deployments.py` | 재배포 측정 시작·종료에 `time.perf_counter()`를 사용하고, `elapsed`를 별도로 계산한 뒤 `deploy_s`에 누적 | 경과 시간 차이를 먼저 계산해 누적 연산 순서를 명확히 함 |
| `apps/engine/tests/test_fixes.py` | `monkeypatch`로 모듈의 `monotonic` 값을 고정하고 `perf_counter`는 실제 시계를 사용하도록 시간 측정 테스트 조건 추가 | 기존 총시간·배포시간 회귀 검증을 유지하면서 수정된 시간 측정 경로를 확인 |
| `apps/engine/tests/test_image_builder.py` | Windows 심볼릭 링크 생성이 `WinError 1314`로 실패한 경우에만 `pytest.skip` 처리 | 권한 부족에 한한 환경 의존적 테스트 실패 방지. 다른 `OSError`는 계속 발생 |

PR의 **코드 수정 파일은 3개(13줄 추가, 4줄 삭제)**이며, 이 보고서는 별도의 문서 파일이다. Security Gate의 정책, Docker/GCP 어댑터 배포 절차, 기존 팀원 코드, 샘플 앱은 수정하지 않았다.

### 2.1 재배포 시간 계산 코드 비교

**수정 전**

```python
deploying = time.monotonic()
self.submit(d, cloud, request)
self.wait_ready(d, cloud)
d['timings']['deploy_s'] = d['timings'].get('deploy_s', 0) + time.monotonic() - deploying
```

**수정 후**

```python
deploying = time.perf_counter()
self.submit(d, cloud, request)
self.wait_ready(d, cloud)
elapsed = time.perf_counter() - deploying
d['timings']['deploy_s'] = d['timings'].get('deploy_s', 0) + elapsed
```

이 코드는 변경 지점을 발췌한 것으로, 실제 `self.submit()` 호출 인자 등은 전체 소스와 다를 수 있다. 검토 시에는 [PR #47의 실제 Diff](https://github.com/SoftBankHackathon/shakedown/pull/47/files)를 기준으로 한다.

**해석:** 기존에는 `기존 누적값 + 종료 시각 - 시작 시각` 순서였고, 수정 후에는 `종료 시각 - 시작 시각`을 먼저 계산한다. 부동소수점 계산에서 연산 순서는 영향을 줄 수 있으므로, 수정 목적은 **경과 시간 계산의 명시성과 누적 계산 안정화**이다. `perf_counter()`가 Windows에서 `monotonic()`보다 무조건 정밀하다는 의미는 아니다. 실제 배포 작업을 수행하는 `submit()`·`wait_ready()`의 동작 자체는 단축하지 않았다.

## 3. 실제 테스트 재현 방법

아래 명령은 **로컬 pytest 검증**이며, Docker 이미지 빌드·클라우드 배포·비용 발생 작업을 실행하지 않는다.

```powershell
$PR = "D:\workspaces\shakedown-engine-timing-pr-20261011"
$Py = "D:\workspaces\shakedown-review-20261010\apps\engine\.venv\Scripts\python.exe"

Set-Location $PR
$env:PYTHONUTF8 = "1"
$env:PYTHONPATH = "$PR\apps\engine"

# 변경 관련 테스트 파일만 실행
& $Py -X utf8 -m pytest -q --tb=short `
  .\apps\engine\tests\test_fixes.py `
  .\apps\engine\tests\test_image_builder.py
Write-Host "Targeted Test Exit Code: $LASTEXITCODE"

# Engine 전체 회귀 테스트
& $Py -X utf8 -m pytest -q --tb=short .\apps\engine\tests
Write-Host "Full Test Exit Code: $LASTEXITCODE"
```

작성자는 위 변경 파일 테스트와 전체 회귀 테스트를 실행했다. **변경 파일 단독 테스트의 별도 통과 개수 및 종료 코드 화면은 확보하지 못했으므로 이 문서에는 임의의 수치를 넣지 않는다.** 전체 회귀 테스트 결과는 아래와 같이 확인했다.

```text
SKIPPED [1] apps\engine\tests\test_image_builder.py:76: Windows symlink privilege is unavailable
SKIPPED [12] apps\engine\tests\test_security_real.py:17: Requires real project-local Semgrep and Gitleaks CLIs (POSIX)
SKIPPED [1] apps\engine\tests\test_security_real.py:30: Requires real project-local Semgrep and Gitleaks CLIs (POSIX)
SKIPPED [1] apps\engine\tests\test_security_real.py:43: Requires real project-local Semgrep and Gitleaks CLIs (POSIX)
SKIPPED [1] apps\engine\tests\test_security_real.py:60: Requires real project-local Semgrep and Gitleaks CLIs (POSIX)
SKIPPED [4] apps\engine\tests\test_security_real.py:73: Requires real project-local Semgrep and Gitleaks CLIs (POSIX)
448 passed, 20 skipped, 1 warning in 17.01s
Test Exit Code: 0
```

위 내용은 화면에 표시된 pytest 결과를 문서화한 것이다. 원본 로그 파일이나 GitHub Actions CI 산출물이 자동으로 생성되었다고 주장하지 않는다.

### 3.1 PR 제출 전 Git 변경 점검

Windows PowerShell에서 아래 결과도 확인했다.

```powershell
git status --short
git diff --check
git diff --stat
```

- 변경 코드 3개 파일 확인: `deployments.py`, `test_fixes.py`, `test_image_builder.py`
- 코드 패치의 변경 통계: **13 insertions, 4 deletions**
- `git diff --check`: 공백 오류 출력 없음
- 독립 PR 브랜치에서 작업하여 팀 `main`과 기존 로컬 수정본 보존

## 4. 주요 회귀 검증 시나리오

| 검증 시나리오 | 테스트가 확인하는 내용 | 관련 테스트 |
| --- | --- | --- |
| 재배포 시간 누적 | 수정 적용으로 발생한 2회차 배포 시간이 `deploy_s`에 더해짐 | `test_fix_timings_add_the_redeploy_but_not_the_wait_before_the_click` |
| 수정 버튼 클릭 전 대기 | 사용자 대기 시간 0.5초가 작업 총시간에 부당하게 포함되지 않음 | 동일 테스트 |
| 재빌드 방지 | 수정 적용 후에도 최초 `build_s`가 유지됨 | 동일 테스트 |
| 수정된 시간 측정 경로 | 테스트에서 `monotonic`을 고정하고 `perf_counter` 기반 계산의 회귀 여부를 확인 | 동일 테스트 |
| 심볼릭 링크 제외 | 심볼릭 링크를 생성할 수 있으면 스냅샷에 복사되지 않는지 검사 | `test_snapshot_skips_symlinks` |
| Windows 권한 제한 | 생성 권한이 없는 경우 해당 테스트가 실패 대신 SKIP됨 | 동일 테스트 |
| 다른 Engine 기능 영향 | 전체 Engine pytest 회귀 테스트 통과 | `apps/engine/tests` 전체 |

심볼릭 링크 제외 동작은 이 Windows 테스트 실행에서는 권한 부족으로 **직접 통과 검증되지 않았다**. 또한 이 테스트는 실제 GCP 배포가 아닌 테스트용 객체 및 가짜 어댑터를 활용한다.

## 5. 기존 로컬 실행 기록과의 구분

PR 생성 이전에 별도 검증 폴더(`shakedown-review-20261010`)에서 다음 결과를 공유했다.

| 구분 | 테스트 집계 | 반복 |
| --- | --- | --- |
| 이전 독립 로컬 검증 | 449 passed / 20 skipped / 0 failed | 3회 |
| **PR #47 브랜치 최종 검증** | **448 passed / 20 skipped / 0 failed** | 현재 공유된 전체 테스트 화면 1회 |

이 둘은 **서로 다른 코드 기준과 테스트 구성**의 결과이다. `449 → 448`은 실행 시간이 줄었다는 뜻도, 테스트가 1개 퇴행했다는 증거도 아니다. 이전 3회 실행의 원본 터미널 로그는 이 PR에 첨부하지 않았으며, 수치는 이전 로컬 검증 기록으로만 남긴다.

## 6. 성능 향상 주장에 대한 범위 구분

| 주장 | 현재 검증 여부 | 설명 |
| --- | --- | --- |
| Engine 테스트가 최신 PR 브랜치에서 통과했다 | **확인됨** | 448 passed, 20 skipped, 0 failed, 종료 코드 0 |
| 재배포 시간 계산 흐름을 변경했다 | **확인됨** | 실제 코드 Diff와 관련 회귀 테스트 존재 |
| Windows 권한 부족에 따른 테스트 실패를 방지했다 | **확인됨(대상 환경)** | 해당 테스트가 권한 문제로 SKIP된 기록 확인 |
| 경과 시간 측정 오차가 몇 % 감소했다 | **미측정** | 변경 전후 같은 기준의 오차 데이터 없음 |
| 실제 GCP 배포가 몇 초 빨라졌다 | **미측정** | 실제 동일 조건의 전·후 클라우드 배포 벤치마크 없음 |
| pytest가 이전 버전보다 빨라졌다 | **미측정** | 구버전 동일 환경·동일 테스트 목록의 실행 시간 비교값 없음 |

**17.01초는 pytest가 Engine 전체 테스트를 수행한 시간**이며, GCP 재배포에 걸린 `deploy_s`가 아니다. PR #47에서는 `submit()`이나 `wait_ready()`의 실행 절차를 최적화하지 않았다. 따라서 문서와 PR 설명에서는 **시간 측정 계산 안정화와 테스트 호환성 향상**만 검증된 개선으로 기술한다.

실제 성능 개선 또는 측정 오차 감소를 수치로 비교하려면 동일한 실행 조건에서 **변경 전·후 재배포 시간과 외부 기준 시계의 측정값**을 여러 차례 수집해야 한다. 본 PR에서는 그 비교 작업을 하지 않았다.

## 7. 검증 한계 및 후속 점검

1. Windows 단일 로컬 환경의 pytest 결과다. 실제 GCP 인프라 호출, 배포 지연, 프로덕션 성능은 직접 측정하지 않았다.
2. 실제 스캐너 검증이 필요한 19개 테스트는 POSIX 제약으로 건너뛰었다. Security Gate 실동작 전체 통과를 이 결과로 주장하지 않는다.
3. Windows 심볼릭 링크 테스트 1개는 권한 문제로 SKIP됐다. 링크가 생성 가능한 환경에서는 별도 확인이 필요하다.
4. 경고 1건은 외부 라이브러리의 사용 중단 예정 API 경고로, 이번 PR 기능 실패와 구분했다.
5. 재배포 시간 누적의 정확도 개선 폭은 정량화되지 않았다. 보다 엄격한 비교가 필요하면 별도 결정론적 시간 테스트 및 실제 시계 오차 검증을 추가한다.

## 8. 리뷰 요청 사항

- `deploy_s`에 재배포 경과 시간을 누적하는 변경의 계약 및 계산 순서가 적절한지 검토 부탁드립니다.
- `monotonic` 고정과 실제 `perf_counter`를 함께 사용하는 테스트 방식이 회귀 검증에 적합한지 확인 부탁드립니다.
- Windows `WinError 1314`에 한정해 테스트를 SKIP하는 처리가 팀 테스트 정책에 부합하는지 확인 부탁드립니다.
- 이 PR의 목적은 **배포 속도 향상**이 아닌 **시간 기록 계산과 Windows 회귀 테스트의 안정화**임을 명시합니다.
