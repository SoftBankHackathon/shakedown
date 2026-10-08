# infra/aws (담당: 김재환)

AWS 배포

- App Runner(앱 실행) + RDS(DB), AWS 계정·권한 세팅
- 10/8: AWS에 게시판이 뜨고 "글 사라짐" 재현
- 10/9: RDS를 연결하면 해결됨

엔진에 돌려줄 형식: `packages/contracts`의 `TargetState` (url, status)
