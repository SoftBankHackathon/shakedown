# engine (담당: 김도경)

배포 엔진 + AI 설정 자동 입력

- 레포 분석 → 설정(포트, DB, 환경변수) 자동 채우기
- 배포 → 검사 순서 제어, 실패 시 중단
- 10/8: 레포 링크를 넣으면 설정값이 나옴
- 10/9: 버튼 한 번에 로컬·AWS 배포 → 검사까지 실행

출력 형식: `packages/contracts`의 `Project`, `Deployment`, `TargetState`
