"use client";
import { useEffect, useState } from "react";
import { Section } from "./ui";
import { API, MOCK, ApiError } from "@/lib/api";
import type { HttpsBinding, HttpsTarget } from "@shakedown/contracts";

const labels: Record<HttpsBinding["status"], string> = {
  preflight: "연결 확인 중",
  dns_pending: "DNS 설정 대기",
  certificate_pending: "인증서 발급 중",
  applying: "HTTPS 연결 중",
  verifying: "접속 검증 중",
  ready: "사용 가능",
  needs_action: "확인 필요",
  failed: "설정 실패",
};
export function HttpsSettings({ projectId }: { projectId: string }) {
  const [target, setTarget] = useState<HttpsTarget>("aws");
  const [mode, setMode] = useState("tunnel");
  const [domain, setDomain] = useState("");
  const [binding, setBinding] = useState<HttpsBinding | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const path =
    "/api/projects/" +
    encodeURIComponent(projectId) +
    "/targets/" +
    target +
    "/https";
  useEffect(() => {
    if (MOCK) return;
    let alive = true;
    setBinding(null);
    setError("");
    setStatusError("");
    setLoading(true);
    const refresh = async () => {
      try {
        const r = await fetch(API + path, { cache: "no-store" });
        if (!r.ok) {
          if (r.status === 404) {
            if (alive) {
              setBinding(null);
              setStatusError("");
            }
            return;
          }
          const e = await r.json();
          throw new Error(e.detail ?? "연결 상태를 확인할 수 없습니다.");
        }
        const b: HttpsBinding = await r.json();
        if (alive) {
          setBinding(b);
          setDomain(b.domain);
          setStatusError("");
        }
      } catch (e) {
        if (alive) setStatusError(e instanceof Error ? e.message : "연결 오류");
      } finally {
        if (alive) setLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path]);
  async function submit(recheck: boolean) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(API + path + (recheck ? "/recheck" : ""), {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(recheck
          ? {}
          : {
              body: JSON.stringify({
                domain,
                ...(target === "local" ? { local_mode: mode } : {}),
              }),
            }),
      });
      const body = await r.json();
      if (!r.ok)
        throw new ApiError(
          body.detail ?? "요청을 처리하지 못했습니다.",
          r.status,
        );
      setBinding(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "연결 오류");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="사용자 도메인 · HTTPS">
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          배포한 앱에 도메인을 연결합니다. 안내된 DNS 레코드를 등록하면 인증서와
          실제 접속을 확인합니다.
        </p>
        {MOCK ? (
          <p className="rounded-lg border border-line p-3">
            미리보기 모드입니다. 실제 HTTPS 설정은 엔진을 연결한 후 사용할 수
            있습니다.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1">
                배포 대상
                <select
                  aria-label="HTTPS 배포 대상"
                  value={target}
                  disabled={busy}
                  onChange={(e) => {
                    setTarget(e.target.value as HttpsTarget);
                    setDomain("");
                  }}
                  className="block rounded border border-line bg-bg p-2"
                >
                  <option value="aws">AWS ALB</option>
                  <option value="azure">Azure</option>
                  <option value="gcp">GCP 로드밸런서</option>
                  <option value="local">로컬</option>
                </select>
              </label>
              {target === "local" && (
                <label className="space-y-1">
                  연결 방식
                  <select
                    value={mode}
                    disabled={!!binding || busy}
                    onChange={(e) => setMode(e.target.value)}
                    className="block rounded border border-line bg-bg p-2"
                  >
                    <option value="tunnel">Cloudflare Named Tunnel</option>
                    <option value="caddy">Caddy 직접 연결</option>
                  </select>
                </label>
              )}
              <form
                className="flex flex-1 flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit(false);
                }}
              >
                <label className="min-w-48 flex-1 space-y-1">
                  서브도메인
                  <input
                    name="domain"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    value={domain}
                    disabled={!!binding || busy || loading}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="app.example.com"
                    className="block w-full rounded border border-line bg-bg p-2"
                  />
                </label>
                {!binding && (
                  <button
                    disabled={busy || loading || !domain.trim()}
                    className="rounded bg-accent px-4 py-2 text-white disabled:opacity-50"
                  >
                    {busy ? "설정 요청 중…" : "HTTPS 연결"}
                  </button>
                )}
              </form>
            </div>
            {loading && (
              <p role="status" className="text-muted">
                연결 상태를 불러오고 있습니다…
              </p>
            )}
            {(error || statusError) && (
              <p role="alert" className="text-bad">
                {error || statusError}
              </p>
            )}
            {binding && (
              <div className="space-y-3 rounded-lg border border-line p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p role="status" className="font-semibold">
                    {binding.traffic_blocked
                      ? "HTTPS 구성 완료 · 배포 경로 차단됨"
                      : labels[binding.status]}
                  </p>
                  <button
                    onClick={() => void submit(true)}
                    disabled={busy}
                    className="rounded border border-line px-3 py-1.5 disabled:opacity-50"
                  >
                    {busy ? "확인 요청 중…" : "DNS·접속 다시 확인"}
                  </button>
                </div>
                {binding.error && (
                  <p role="alert" className="text-bad">
                    {binding.error.message}
                  </p>
                )}
                {binding.dns_records.length > 0 && (
                  <div className="overflow-x-auto">
                    <p className="mb-2 text-muted">
                      도메인 관리 화면에서 다음 레코드를 직접 등록하세요. 인증서
                      검증 레코드는 갱신을 위해 유지합니다.
                    </p>
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-line">
                          <th className="p-2">유형</th>
                          <th className="p-2">이름</th>
                          <th className="p-2">값</th>
                        </tr>
                      </thead>
                      <tbody>
                        {binding.dns_records.map((r) => (
                          <tr
                            key={r.type + r.name}
                            className="border-b border-line"
                          >
                            <td className="p-2">{r.type}</td>
                            <td className="p-2 font-mono break-all select-all">
                              {r.name}
                            </td>
                            <td className="p-2">
                              <code className="break-all select-all">
                                {r.value}
                              </code>
                              {r.note && (
                                <p className="mt-1 text-muted">{r.note}</p>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {binding.status === "ready" &&
                  !binding.traffic_blocked &&
                  binding.https_url && (
                    <p>
                      접속 주소:{" "}
                      <a
                        href={binding.https_url}
                        target="_blank"
                        rel="noreferrer"
                        className="break-all text-accent underline"
                      >
                        {binding.https_url}
                      </a>
                    </p>
                  )}
                {binding.certificate?.expires_at && (
                  <p className="text-xs text-muted">
                    인증서 만료:{" "}
                    {new Date(binding.certificate.expires_at).toLocaleString(
                      "ko-KR",
                    )}{" "}
                    · 자동 갱신
                  </p>
                )}
                <ul className="space-y-1 text-xs">
                  {binding.checks.map((c) => (
                    <li key={c.name}>
                      {c.ok ? "✓" : "○"} {c.name}: {c.detail}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted">
                  공개 진입점 이후 연결:{" "}
                  {binding.internal_transport === "unverified"
                    ? "미확인"
                    : binding.internal_transport.toUpperCase()}
                  . HTTPS 준비 완료와 앱 기능 검사 통과는 별도로 판정합니다.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </Section>
  );
}
