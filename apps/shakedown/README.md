# shakedown (담당: 김태현)

AI 시운전. 배포된 두 환경(기준 baseline, 비교 candidate)에서 같은 사용자 흐름을 HTTP로 실행하고, 단계별로 비교해 판정합니다.

- 방식: HTTP 요청으로 회원가입 → 로그인 → 글쓰기 → 글 열기 → 댓글. 쿠키는 환경마다 따로, 리다이렉트는 직접 따라가며 기록
- 판정: 규칙이 정함 (PASS / WARN / BLOCKED). AI는 원인 보고서만 담당(예정)
- 출력 형식: `packages/contracts`의 `Scenario`, `StepDiff`, `Verdict`
- 화면 검사(Playwright)는 여유가 있을 때 추가

## 실행

Node 22.18 이상(23은 23.6 이상). 빌드 없이 TypeScript를 바로 실행합니다.

```bash
npm run shakedown -w @shakedown/shakedown -- --baseline http://localhost:18080 --candidate https://xxxx.awsapprunner.com
```

| 옵션 | 기본값 | 뜻 |
|---|---|---|
| `--baseline` | (필수) | 기준 환경 주소. 보통 Local |
| `--candidate` | (필수) | 비교 환경 주소. 보통 AWS |
| `--baseline-name` | `local` | 결과에 쓰는 기준 환경 이름 |
| `--candidate-name` | `aws` | 결과에 쓰는 비교 환경 이름 |
| `--timeout-ms` | `10000` | 요청 하나의 시간 제한 |

결과 JSON: `{ scenario, scenario_source, steps: StepDiff[], verdict }`

## 테스트

```bash
npm test -w @shakedown/shakedown
```

테스트는 가짜 게시판 서버(`test/fake-board.ts`)를 띄워서 돌립니다. `instances: 2`로 띄우면 세션이 서버마다 따로라 로그인이 풀리는 상황이 재현됩니다.

## 일정

- 10/8: 주소 2개를 넣으면 PASS / BLOCKED 결과 JSON (이 README의 CLI)
- 10/9: 엔진용 API(`POST /shakedowns`, 포트 9201), 원인 보고서가 대시보드에 표시됨
