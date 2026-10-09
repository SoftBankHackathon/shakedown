# 선택 설계 → AWS 배포 연결 검증

기존 실측 후 발견된 제품 연결 누락을 보완했다. 엔진은 architecture_plan_id로
최신 선택·프로젝트 소유권·분석 근거·지원 스택을 재검증하고 카탈로그 스냅샷을 배포 기록에 남긴다.
클라이언트가 임의 CPU/메모리/최대 태스크 수를 지정할 수 없다.

웹의 선택 구성 배포 버튼과 AWS를 포함한 Action에서 ID를 전달한다. 어댑터는 small/medium/large에
대응하는 CPU·메모리·태스크·앱 AZ·DB MultiAZ·CPU 자동 확장 정책을 적용한다. 앱 준비 전 게이트는
닫히고, 실제 태스크의 AZ 배치와 건강 상태를 확인한다. 배포 준비와 중지 시 기존 자동 확장
등록을 제거한다. DB 변경은 실패 시에도 자동 복구하지 않으며 DB·기반 자원은 유지된다.

## 검증 구분

- 엔진 자동 테스트: 실제 FastAPI 등록→설계 생성→선택→배포 요청→AWS 어댑터 경계까지 검증.
- AWS SDK 대역 테스트: 세 규모별 task definition·ECS subnet/desiredCount·RDS MultiAZ 변경·스키마 초기화·확장 정책·중지 순서 검증.
- 거절 검증: 다른 프로젝트/미선택/오래된 계획, 직접 replica override, 알 수 없는 자원 필드, 부족한 AZ.
- 웹 lint·TypeScript·production build 검증.
- **이 새 제품 경로로 유료 AWS 재실험은 하지 않았다.** 이전 Provider 직접 호출 실측과 구분한다.
- 이전 보고서의 자동 축소 미확인 결과는 그대로 유효하다. 정책 생성 코드가 있다는 것이 실측 성공은 아니다.

## 운영 전제

기반 스택을 준비하는 기존 provision 절차는 유지한다. 빈 AWS 계정 온보딩이나 모든 프로젝트의
자동 인프라 생성은 이 변경의 범위가 아니다. 갱신된 foundation.yaml과 출력 기반 설정의
DbInstanceId·세 AZ 서브넷 및 새 권한이 필요하다(기존 두 AZ는 small/medium만 지원).
현재 실제 앱 실행 범위는 Spring/PostgreSQL 샘플이다. 프리셋은 처리량 보장이 아니다.
