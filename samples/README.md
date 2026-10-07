# samples (담당: 김태윤)

- `kty-board/`: 시연용 게시판 (Spring Boot 4, Java 21, Gradle, MySQL)
  - 원본: https://github.com/xodbs1021/kty-board-project (커밋 `9839b13`)을 복사
  - 로그인을 서버 메모리 세션(HttpSession)에 저장 → 서버가 2대 이상이면 로그인이 풀림 (시운전이 잡아야 할 실제 환경 차이)
