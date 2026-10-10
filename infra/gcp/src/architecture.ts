// 서버가 가진 실행 카탈로그. 엔진은 버전과 등급 이름만 보내고 CPU·메모리·대수는 여기서만 정한다
// (infra/aws/src/architecture.ts와 같은 원칙: 클라이언트가 자원 양을 직접 보내지 못하게).
export const GCP_ARCHITECTURE_VERSION = 'gcp-architecture.v1';

// 해커톤 범위는 compute(CPU·메모리·대수·자동 확장)만 적용한다(infra/azure README 12절과 같은 방식).
// DB 고가용성(REGIONAL·전용 코어)은 계획에만 적는다. Cloud SQL 전환은 재시작을 동반하고 최대 1시간 걸리며 비용과 승인이 필요하다.
// - small은 1 vCPU다. Cloud Run은 1 vCPU 미만이면 동시 요청 1개를 강제해 Local과의 비교가 틀어진다.
// - small은 지금 계획 없는 경로와 같은 수동 1대라 내리기 동작도 같다. 수동 모드에서는 리비전 min/max가 무시된다.
// - large 최대 8대: 서울 리전 쿼터가 20 vCPU·40 GiB라 2 vCPU 서비스는 10대가 상한이고, schema Job(1 vCPU)과 롤아웃 중 새 인스턴스
//   1대 몫을 남겼다(8 × 2 + 1 + 2 = 19). 최대 대수로 늘어난 채 다시 배포하면 새 리비전 min 3대가 다 들어가지 못하므로,
//   계획 배포 전에는 이전 배포를 DELETE한다(README 데모 체크리스트).
// - pool: 앱 인스턴스당 DB 연결 풀(Hikari maximumPoolSize, 기본 10). 지금 Cloud SQL(db-f1-micro)은 max_connections가 25이고
//   관리용 예약 몇 개를 빼면 앱 몫은 약 22개다. 최대 대수까지 늘어도 넘치지 않게 "최대 대수 × 풀"을 20 이하로 둔다.
//   medium 4대 × 5 = 20, large 8대 × 2 = 16. small은 1대라 앱 기본값(10)을 그대로 둔다.
//   schema Job(기본 풀 10, 앱 갱신 전에 끝남)과 롤아웃 중 이전 리비전의 연결은 이 예산 밖이다. 이전 배포가 떠 있으면 넘칠 수 있어
//   위와 같이 계획 배포 전에 이전 배포를 DELETE한다. 겹침까지 예산에 넣으면 large 풀이 1이 되어 인스턴스마다 DB 작업이 한 번에 하나씩만 돌고 요청이 줄을 선다.
export const architectures = {
  small: { cpu: '1', memory: '1Gi', min: 1, max: 1, scaling: 'MANUAL', pool: undefined },
  medium: { cpu: '1', memory: '2Gi', min: 2, max: 4, scaling: 'AUTOMATIC', pool: 5 },
  large: { cpu: '2', memory: '4Gi', min: 3, max: 8, scaling: 'AUTOMATIC', pool: 2 },
} as const;
export type Tier = keyof typeof architectures;
