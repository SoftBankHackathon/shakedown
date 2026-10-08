# Shakedown

로컬과 클라우드의 동작 차이를 HTTP 시운전으로 확인하는 해커톤 프로젝트입니다.

현재 통합 경로: 대시보드 Action → Docker/PostgreSQL 로컬 배포 → 선택적 기존 URL 비교 → 단계별 증거·PASS/WARN/BLOCKED·원인 보고서. 기존 두 URL만 비교하는 모드도 지원합니다. AWS 자동 배포 연결, 자동수정, 운영 보안은 아직 완료되지 않았습니다.

- [실행과 API](apps/engine/README.md)
- [HTTP 시운전·AI 보고서](apps/shakedown/README.md)
- [로컬 Target](infra/local/README.md), [AWS Target](infra/aws/README.md)
- [공통 계약](packages/contracts/README.md)
- [2026-10-08 통합 점검·남은 작업](docs/integration-audit-2026-10-08.md)
