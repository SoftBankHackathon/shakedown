# shakedown (담당: 김태현)

AI 시운전. 배포된 두 환경(기준 baseline, 비교 candidate)에서 같은 사용자 흐름을 HTTP로 실행하고, 단계별로 비교해 판정합니다.

- 방식: 시나리오(사용자 흐름)를 HTTP 요청으로 실행. kty-board는 회원가입 → 로그인 → 글쓰기 → 글 열기 → 댓글, 게시판이 아닌 앱은 기준 환경을 둘러보고 고른 시나리오(아래 "시나리오 고르기"). 쿠키는 환경마다 따로, 리다이렉트는 직접 따라가며 기록
- 판정: 규칙이 정함 (PASS / WARN / BLOCKED). 원인 보고서는 규칙으로 먼저 만들고, AI(Claude)가 켜져 있으면 AI가 다시 씀
- 출력 형식: `packages/contracts`의 `Scenario`, `StepDiff`, `Verdict`, `Report`
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

CLI도 API와 같은 순서로 시나리오를 고릅니다(알려진 시나리오 → 규칙 둘러보기). AI는 부르지 않습니다. 기준 환경에서 열리는 페이지가 없으면 이유를 출력하고 코드 1로 끝납니다.

## 엔진용 API

엔진(김도경)이 부르는 HTTP API입니다. 형식은 `packages/contracts/openapi/shakedown.yaml`을 그대로 따릅니다.

```bash
npm start -w @shakedown/shakedown        # 기본 127.0.0.1:9201
HOST=0.0.0.0 PORT=9201 npm start -w @shakedown/shakedown   # 엔진이 다른 PC에 있을 때
```

| 요청 | 응답 |
|---|---|
| `POST /shakedowns` | 202 `{shakedown_id, status: "running", steps: [], ai_cost}` 후 뒤에서 실행. 요청에 시나리오가 있으면 `scenario`, `scenario_source: "saved"`도 바로 담김 |
| `GET /shakedowns/{id}` | 200 현재 상태. 실행 중에는 두 환경이 모두 끝낸 단계까지 `steps`가 채워짐. 모르는 id는 404 |

- 요청에 `scenario`가 없거나 null이면 기준 환경을 보고 고릅니다(아래 "시나리오 고르기")
- 비교 대상(`candidates`)은 지금 1개만 받습니다. 2개 이상이면 422
- 잘못된 요청은 400 `{error, detail}` (target.yaml과 같은 모양)
- 시작 전에 두 주소가 응답하는지 최대 20초 다시 시도합니다(터널 주소가 늦게 잡히는 경우). 앱이 낸 응답은 500이어도 닿은 것으로 봅니다. Cloudflare 엣지가 낸 530(`server: cloudflare`, 터널 미준비 1033·1016)은 앱 응답이 아니라서 계속 기다립니다
- 접속 확인 뒤 실행 중에도 Cloudflare 엣지 530을 받으면 같은 요청을 1초 간격으로 다시 보냅니다. 기다리는 시간은 단계 하나(리다이렉트 포함)에 모두 합쳐 최대 10초입니다. 엣지가 앱에 넘기기 전에 만든 응답이라 POST도 다시 보냅니다. 10초가 지나도 530이면 그 단계는 `HTTP 530`으로 실패합니다
- 기준 환경이 닿지 않거나 기준 환경에서 시나리오가 실패하면 비교할 수 없으므로 `status: "failed"`와 `error`
- 비교 환경만 실패하면 `status: "done"`과 `verdict: BLOCKED`
- 전체 실행은 150초 안에 끝냅니다. 넘으면 `status: "failed"`, `error: "timed out after 150s"` (엔진은 3분이 지나면 실패로 봅니다)
- 기록은 메모리에만 있어서 서버를 다시 켜면 사라집니다(GET이 404)

## 시나리오 고르기

요청에 `scenario`가 없거나 null이면 시운전이 기준 환경을 보고 고릅니다. 기준 환경에서 먼저 통과한 것만 씁니다. 고르는 시간도 150초 마감 안에 듭니다. 고른 시나리오는 단계를 돌리기 전에 `scenario`·`scenario_source`에 채웁니다(202 응답과 그 직후 조회에는 없음. 엔진은 폴링할 때마다 복사함).

| 순서 | 시나리오 | 고르는 조건 | `scenario_source` |
|---|---|---|---|
| 1 | 알려진 시나리오(kty-board 기본 8단계) | 첫 쓰기 앞의 visit 단계(`GET /join`)가 통과하고, 그 화면에 다음 단계의 폼(`/join`)이 있고 그 단계가 보낼 칸(email·nickname·password)이 폼에 다 있음. GET만 보냄 | `fallback` |
| 2 | AI 시나리오 | AI가 켜져 있고 시간이 남을 때. 둘러본 결과로 Claude가 작성(최대 8단계) → 검사 → 기준 환경에서만 한 번 미리 돌려 모든 단계 통과 | `ai` |
| 3 | 규칙 둘러보기 | 둘러본 페이지 중 기준 환경에서 HTTP 400 미만이었던 것을 하나씩 `visit` | `fallback` |

- 둘러보기: 기준 환경의 `/`(와 `hints.health_path`)부터 같은 출처 링크를 따라 최대 6페이지(+health)를 GET으로만 엽니다(전체 15초 안). 로그아웃·삭제류 주소, 관리자·결제 주소, 정적 파일(.css .js .png 등), 다른 출처, mailto, 데이터 주소(번호·24자 hex·UUID 경로 칸, 쿼리가 붙은 링크. 환경마다 DB가 따로라 `/posts/6`·`?id=6`이 비교 환경에 없을 수 있음)는 건너뜁니다. slug 주소(`/posts/my-first-post`)는 모양으로 알 수 없어 걸러지지 않습니다. 페이지마다 경로, 최종 경로, 상태, 제목, 화면 글자 앞부분, 링크, 폼(action·method·입력칸 이름과 종류)을 모읍니다
- 규칙 둘러보기 단계는 `Open /path`이고, 기준 환경에서 다른 화면으로 넘어갔으면 그 경로를 `expect.path_startswith`로 기대합니다(넘어간 곳이 데이터 주소면 기대하지 않음). `app_understanding`은 `Rule-based crawl of N pages (AI unavailable)`
- 기준 환경에서 열리는 페이지가 하나도 없으면 비교할 것이 없으므로 `status: "failed"`, `error: "baseline local has no page to compare: / HTTP 503, /healthz HTTP 503"`
- AI 시나리오 검사: 계약의 Scenario 모양, 8단계 이하, 자리표시자는 `{{email}} {{nickname}} {{password}} {{title}} {{content}} {{comment}}`만, 입력값마다 자리표시자(고정값은 둘러본 폼에서 select·radio·checkbox·숫자·날짜 칸으로 본 칸만. 미리 돌리기와 본 실행이 같은 값을 쓰면 가입 등이 겹침), `visit` 경로는 둘러보기가 여는 주소와 같은 규칙(같은 출처, 쿼리·데이터 주소·정적 파일 아님. 기대 경로도 데이터 주소 아님), 로그아웃·삭제·관리자·결제 단계 없음. 하나라도 어기거나, 형식이 틀리거나, 거절되거나, 시간 안에 답이 없으면 버리고 규칙 둘러보기로 갑니다(재시도 없음)
- AI 시나리오는 마감까지 남은 시간에서 45초(AI 보고서 22초 + 미리 돌려 보기·본 실행 23초 몫)를 뺀 만큼, 최대 25초 기다립니다. 그 시간이 5초가 안 되면 부르지 않습니다. 미리 돌려 보기는 AI 보고서 몫을 뺀 남은 시간의 3분의 1까지만 합니다(본 실행은 같은 시나리오를 두 환경에서 다시 돌아 느린 쪽에 맞춰지므로 3분의 2를 남김). 넘으면 끊고 규칙 둘러보기로 갑니다
- 미리 돌려 보기는 기준 환경에 쓰기(가입 등)를 남길 수 있습니다. 본 실행과 다른 값을 써서 겹치지 않습니다
- 같은 배포(`deployment_id`)·같은 기준 환경이면 처음 고른 시나리오와 출처를 다시 씁니다(기준 환경이 끝까지 통과한 시나리오만). 엔진은 비교 대상마다, 수정 적용 뒤 2회차마다 시운전을 따로 부르는데 회차끼리 같은 시나리오여야 맞댈 수 있기 때문입니다(2회차가 더 약한 둘러보기로 바뀌면 고쳐지지 않은 버그도 PASS가 됨). 다시 쓴 시운전의 `ai_cost`는 0입니다. 기록처럼 메모리에만 있어 서버를 다시 켜면 새로 고릅니다
- 저장된 시나리오(요청의 `scenario`)는 고르지 않고 바로 씁니다(`saved`)
- 어떤 시나리오든 실행 중에 고른 링크의 주소나 폼의 action이 삭제·로그아웃·관리자·결제(낱말 `delete` `remove` `destroy` `logout` `signout` `admin…` `checkout` `payment(s)` `billing` `purchase(s)`. 앞뒤가 글자면 낱말이 아님)이거나 숨은 `_method`가 delete면 보내지 않고 그 단계를 실패로 둡니다. 링크는 글자 일부만 맞아도 첫 링크를 고르기 때문입니다. 시운전은 실제 배포 환경(공유 DB)에서 돌므로 이런 단계는 저장된 시나리오에도 넣지 않습니다

## 원인 보고서

`verdict`가 BLOCKED일 때만 `report`를 채웁니다(PASS·WARN이면 null). 판정은 규칙이 하고, 보고서는 그 판정의 이유를 설명합니다.

규칙 보고서는 아래 순서로 원인을 찾습니다. 시연할 버그가 아직 하나로 정해지지 않아서 네 가지를 모두 잡습니다.

| 순서 | 원인 | 이렇게 보이면 | 수정안(fix) |
|---|---|---|---|
| 1 | 접속 불가 | 비교 환경 첫 실패가 연결 오류 | 없음 |
| 2 | 로그인 풀림 | 기준 환경은 로그인 뒤 페이지, 비교 환경은 로그인 화면(`/`, `/login…`, 마지막 칸이 `login`·`signin`·`sign_in`으로 끝나는 주소)으로 되돌아감. 비교 환경에서 그 hop이나 그 앞(앞 단계 포함)에 로그인 POST(로그인 화면 주소, 마지막 칸이 `auth`·`session(s)`·`j_spring_security_check`인 주소)가 있을 때만 | `env SPRING_PROFILES_ACTIVE=demo,session-jdbc` (세션을 공유 DB에) |
| 3 | 데이터 유실 | 방금 쓴 글이 비교 환경에서만 안 보임 | `code_change` (모든 인스턴스를 env로 공유 관리형 DB(Cloud SQL·RDS·Azure)에 연결) |
| 4 | 서버 오류 | 비교 환경만 500대 응답 | `code_change` (DB 주소를 환경변수로) |
| 5 | 그 밖 | 처음 달라진 단계 기준 일반 설명 | 없음 |

- `auto_applicable`은 로그인 풀림 수정안만, 엔진이 요청에 `hints.can_apply_env: true`를 보냈을 때 true입니다(엔진이 env를 바꿔 같은 이미지로 다시 배포할 수 있는 대상, 지금은 엔진이 관리하는 GCP). 나머지는 모두 false(사람이 확인 후 적용)
- `hop.instance`는 응답의 `X-Instance-Id`를 기록하며 헤더가 없으면 null입니다. 규칙 보고서의 세션 원인은 휴리스틱 추정이므로 hop 증거와 실제 인프라 설정을 함께 확인해야 합니다.
- 로그인 풀림 보고서는 로그인을 받은 hop(`POST /login`, 앞 단계에서 끝났으면 그 단계에서 찾음)과 로그인 화면으로 튕긴 hop의 `instance`가 둘 다 있고 서로 다르면 근거 한 줄을 더합니다. 예: `POST /login was handled by instance i-aaaa1111, GET /board by instance i-bbbb2222: 2 different instances served one user's requests.` 둘 중 하나가 없거나 같으면 더하지 않고 confidence도 그대로입니다.
- `X-Instance-Id`는 샘플 앱(`samples/kty-board`)의 `demo` 프로필이 켜졌을 때만 나옵니다. 값은 `HOSTNAME`(Docker 컨테이너 ID 등), 없으면 서버 프로세스마다 무작위 `i-xxxxxxxx`(Cloud Run)입니다. 실제 범위는 이렇습니다.
  - 어느 소스가 빌드되나: 엔진은 프로젝트로 등록한 `repo`를 빌드합니다(로컬 경로면 그 폴더, GitHub 주소면 clone한 저장소). 위 값은 이 저장소의 `samples/kty-board`를 경로로 등록했을 때 얘기입니다. 대시보드 입력 예시의 `https://github.com/xodbs1021/kty-board-project`처럼 다른 저장소를 등록하면 그 저장소의 필터가 들어갑니다. 그 저장소에 이 변경이 없으면 Cloud Run에서는 서버를 구별할 ID가 나오지 않아(옛 필터면 두 대 모두 `local`, 필터가 없으면 헤더 없음) 근거 줄이 생기지 않습니다.
  - AWS·GCP 어댑터: env가 없으면 `demo,session-memory`로 띄우므로 헤더가 나옵니다. 근거 줄은 이 비교 환경 hop에서만 만듭니다.
  - 엔진이 띄우는 Local: 엔진이 Local에 env를 넘기지 않아(`apps/engine/engine/deployments.py`의 배포 요청 본문에 `env` 없음) 앱 기본 프로필(`session-memory`)만 켜집니다. `demo`가 꺼져 있으니 헤더가 없고 Local hop의 `instance`는 늘 null입니다. Local은 기준 환경이고 1대라서 근거 줄에는 영향이 없습니다.

### AI 보고서 (Claude)

`ANTHROPIC_API_KEY`가 있으면 BLOCKED 보고서를 Claude(`claude-opus-5-5`)가 다시 씁니다. 규칙 보고서를 힌트로 함께 보냅니다.

```bash
cp apps/shakedown/.env.example apps/shakedown/.env   # 키를 직접 채운다. .env는 커밋되지 않음
npm start -w @shakedown/shakedown                     # .env를 자동으로 읽음
```

| 환경변수 | 뜻 |
|---|---|
| `ANTHROPIC_API_KEY` | 있으면 AI 보고서 켬. 없으면 규칙 보고서만 |
| `SHAKEDOWN_AI_REPORT=off` | 키가 있어도 AI 보고서를 끔 |
| `SHAKEDOWN_AI_SCENARIO=off` | 키가 있어도 AI 시나리오(위 "시나리오 고르기" 2번)만 끔. AI 보고서 스위치와 따로 |

- 구조화 출력(JSON 스키마)으로 받고 다시 검사합니다. 형식이 틀리거나, 거절되거나, 20초 안에 답이 없으면 규칙 보고서를 그대로 씁니다(재시도 없음)
- 거절 시 다른 모델이 대신 답하는 서버 측 fallbacks를 켜 두었습니다
- AI가 낸 수정안은 `auto_applicable: false`입니다. 사람이 확인한 뒤 적용합니다. 단 규칙 수정안이 자동 적용 가능이면 fix만 규칙 것을 그대로 둡니다(엔진이 적용할 값을 AI가 바꾸지 못하게). headline·cause·evidence·confidence는 AI 것입니다
- 프롬프트의 hop 문자열에는 응답 서버 ID를 붙입니다(예: `GET /board 302 [i-bbbb2222]`). 규칙 보고서에 서버 전환 근거 줄이 있으면, AI evidence에 그 줄이 그대로 없을 때 끝에 붙입니다. AI는 `rule_report`로 그 줄을 보지만 evidence를 다시 쓰면서 빠뜨릴 수 있기 때문입니다(로그인이 앞 단계에서 끝났으면 그 단계 hop은 `diverging_steps`에 없어서, 로그인 서버 ID는 이 규칙 문장으로만 보입니다). AI 글에서 ID를 찾아 이미 말했는지 가리지 않습니다. ID는 아무 문자열이라 `2`가 `302`에 걸리듯 엉뚱한 글과 겹치기 때문입니다. 그래서 AI가 같은 내용을 다른 말로 썼으면 비슷한 줄이 두 번 보일 수 있습니다
- 비용은 `ai_cost`(호출 수, 토큰, 원화)에 기록합니다. AI 시나리오를 불렀으면 그 비용과 합칩니다. 실측: 보고서 1건 약 7초, 입력 1,889·출력 435 토큰, 약 23원. AI 시나리오는 실측 전(TBD)

시운전 마감 시간에는 진행 중인 HTTP 요청과 접속 재시도를 취소합니다. 이미 서버가 접수한 쓰기를 되돌리지는 않으므로 테스트 전용 환경을 사용하세요.

## 테스트

```bash
npm test -w @shakedown/shakedown
```

테스트는 가짜 게시판 서버(`test/fake-board.ts`)를 띄워서 돌립니다. `instances: 2`로 띄우면 세션이 서버마다 따로라 로그인이 풀리는 상황이 재현됩니다. 게시판이 아닌 앱은 `test/fake-app.ts`(어느 경로든 JSON), Claude API는 `test/fake-claude.ts`(가짜 서버, 진짜 키를 쓰지 않음)로 흉내 냅니다.

## 일정

- 10/8: 주소 2개를 넣으면 PASS / BLOCKED 결과 JSON (이 README의 CLI)
- 10/9: 엔진용 API(`POST /shakedowns`, 포트 9201), 원인 보고서가 대시보드에 표시됨

### Quick Tunnel DNS

Local Target과 동일하게 HTTPS `*.trycloudflare.com`의 로컬 DNS miss에만 1.1.1.1/1.0.0.1 조회를 사용합니다. 정상 시스템 DNS와 다른 호스트는 그대로 사용합니다. 원래 hostname/SNI 및 TLS 인증서 검증을 유지하며 OS DNS 설정을 바꾸지 않습니다. DNS 조회는 연결 전에 끝나므로 이 DNS 우회 때문에 이미 전송한 POST가 다시 가는 일은 없습니다. POST를 다시 보내는 경우는 앱에 넘어가지 않은 Cloudflare 엣지 530(위 '실행 중 530' 항목) 하나뿐입니다.
