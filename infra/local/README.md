# infra/local (담당: 김태윤)

로컬 배포

- Docker로 게시판 실행, Cloudflare Tunnel로 외부 공개
- 10/8: 내 PC 게시판이 외부 주소로 열림
- 10/9: 엔진이 부르면 자동 배포됨

엔진에 돌려줄 형식: `packages/contracts`의 `TargetState` (url, status)
