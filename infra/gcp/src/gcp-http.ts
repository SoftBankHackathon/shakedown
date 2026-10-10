import { GoogleAuth } from 'google-auth-library';

export type HttpRequest = { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; body?: unknown; signal?: AbortSignal };
export type HttpResponse = { status: number; data: unknown };
// GCP REST 호출은 전부 이 함수 모양 하나로 지나간다. 테스트는 여기에 가짜를 넣어 실제 GCP 없이 돈다.
export type Http = (request: HttpRequest) => Promise<HttpResponse>;

export function googleHttp(quotaProject: string): Http {
  // gcloud ADC(사용자 로그인)를 쓴다. 키 파일을 디스크에 두지 않기 위해서다.
  const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  return async ({ method, url, body, signal }) => {
    const response = await auth.request({
      url, method, data: body as object | undefined, signal,
      // 호출 하나가 멈춰도 15초 뒤 끊어, 배포 전체 제한(420초) 안에서 다음 폴링으로 넘어가게 한다.
      timeout: 15_000,
      // 재시도는 부르는 쪽 폴링 루프가 정한다. 라이브러리가 몰래 재시도하면 시간 예산이 어긋난다.
      retry: false,
      // 4xx·5xx도 예외 대신 상태 코드로 받는다. 404를 "없음"으로 읽어야 하는 곳이 있다.
      validateStatus: () => true,
      // 사용자 계정 ADC는 요금·한도를 매길 프로젝트를 이 헤더로 알려야 한다.
      headers: { 'x-goog-user-project': quotaProject },
    });
    return { status: response.status, data: response.data };
  };
}

export class GcpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function ok<T>(response: HttpResponse, what: string): T {
  if (response.status >= 200 && response.status < 300) return response.data as T;
  // GCP는 실패 이유를 본문 error.message에 적는다. 배포 로그에서 바로 원인을 보도록 붙이되, 너무 길면 자른다.
  const reason = (response.data as { error?: { message?: unknown } } | undefined)?.error?.message;
  throw new GcpError(response.status, `${what} failed: HTTP ${response.status}${typeof reason === 'string' && reason ? `: ${reason.slice(0, 300)}` : ''}`);
}
