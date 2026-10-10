// 서버가 가진 실행 카탈로그. 엔진은 버전과 등급 이름만 보내고 CPU·메모리·대수는 여기서만 정한다
// (infra/aws·infra/gcp의 architecture.ts와 같은 원칙: 클라이언트가 자원 양을 직접 보내지 못하게).
export const AZURE_ARCHITECTURE_VERSION = 'azure-architecture.v1';

// - CPU·메모리는 Consumption 프로필이 받는 조합(vCPU : GiB = 1 : 2)만 쓴다.
// - small은 지금 계획 없는 경로와 같은 고정 1대다(MANUAL). 수동이면 최소=최대로 묶어 0으로 줄지 않는다.
// - large 최대 6대: PostgreSQL B1ms의 연결 한도가 50(관리 예약 10 제외 40)이라,
//   6대 × 풀 3개 × 롤아웃 중 두 리비전(36)이 40 안에 들게 했다. test/architecture.test.ts가 이 계산을 지킨다.
// - 영역 중복·DB HA는 적용하지 않는다(환경 재생성과 General Purpose DB가 필요, README 12절). info는 실제 서버 값을 보여 준다.
export const architectures = {
  small: { cpu: 0.5, memory: '1Gi', min: 1, max: 1, scaling: 'MANUAL' },
  medium: { cpu: 1, memory: '2Gi', min: 2, max: 4, scaling: 'AUTOMATIC' },
  large: { cpu: 2, memory: '4Gi', min: 3, max: 6, scaling: 'AUTOMATIC' },
} as const;
export type Tier = keyof typeof architectures;
export type Shape = { cpu: number; memory: string; min: number; max: number; scaling: 'MANUAL' | 'AUTOMATIC' };

// 계획 배포 앱의 인스턴스당 DB 연결 풀(기본 10). 위 연결 한도 계산과 같은 값이다.
export const PLANNED_POOL_SIZE = '3';
// 자동 확장 기준: 인스턴스당 동시 HTTP 요청. 풀이 3개라 DB를 기다리는 요청까지 세면 30은 너무 늦게 느는 값이다.
export const HTTP_CONCURRENCY = '10';

// 이번 배포가 실제로 뜰 모양. 계획이 없으면 small과 같은 자원에 요청한 대수로 고정한다(Bicep이 처음 만든 앱과 같다).
export function shapeOf(request: { architecture?: { template_id: Tier }; options: { replicas: number } }): Shape {
  if (request.architecture) return architectures[request.architecture.template_id];
  const { cpu, memory } = architectures.small;
  return { cpu, memory, min: request.options.replicas, max: request.options.replicas, scaling: 'MANUAL' };
}
