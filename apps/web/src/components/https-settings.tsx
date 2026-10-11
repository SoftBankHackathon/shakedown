"use client";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/components/i18n";
import { Section } from "./ui";
import { API, MOCK, ApiError } from "@/lib/api";
import type { HttpsBinding, HttpsTarget } from "@shakedown/contracts";

export function HttpsSettings({ projectId }: { projectId: string }) {
  const t = useT();
  // Error text only; a ref keeps language switches from restarting the status poll.
  const tRef = useRef(t); useEffect(() => { tRef.current = t; }, [t]);
  const [target, setTarget] = useState<HttpsTarget>("aws");
  const [mode, setMode] = useState("tunnel");
  const [domain, setDomain] = useState("");
  const [binding, setBinding] = useState<HttpsBinding | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const path = "/api/projects/" + encodeURIComponent(projectId) + "/targets/" + target + "/https";
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
            if (alive) { setBinding(null); setStatusError(""); }
            return;
          }
          const e = await r.json();
          throw new Error(e.detail ?? tRef.current("https.statusError"));
        }
        const b: HttpsBinding = await r.json();
        if (alive) { setBinding(b); setDomain(b.domain); setStatusError(""); }
      } catch (e) {
        if (alive) setStatusError(e instanceof Error ? e.message : tRef.current("https.connError"));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [path]);
  async function submit(recheck: boolean) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(API + path + (recheck ? "/recheck" : ""), {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(recheck ? {} : { body: JSON.stringify({ domain, ...(target === "local" ? { local_mode: mode } : {}) }) }),
      });
      const body = await r.json();
      if (!r.ok) throw new ApiError(body.detail ?? t("https.requestError"), r.status);
      setBinding(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("https.connError"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title={t("https.title")}>
      <div className="space-y-4 text-sm">
        <p className="text-muted">{t("https.lead")}</p>
        {MOCK ? (
          <p className="rounded-lg border border-line p-3">{t("https.mock")}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1">
                {t("https.target")}
                <select aria-label={t("https.target")} value={target} disabled={busy} onChange={(e) => { setTarget(e.target.value as HttpsTarget); setDomain(""); }} className="block rounded border border-line bg-bg p-2">
                  <option value="aws">AWS ALB</option>
                  <option value="azure">Azure</option>
                  <option value="gcp">{t("https.tGcp")}</option>
                  <option value="local">{t("https.tLocal")}</option>
                </select>
              </label>
              {target === "local" && (
                <label className="space-y-1">
                  {t("https.mode")}
                  <select value={mode} disabled={!!binding || busy} onChange={(e) => setMode(e.target.value)} className="block rounded border border-line bg-bg p-2">
                    <option value="tunnel">Cloudflare Named Tunnel</option>
                    <option value="caddy">{t("https.mCaddy")}</option>
                  </select>
                </label>
              )}
              <form className="flex flex-1 flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void submit(false); }}>
                <label className="min-w-48 flex-1 space-y-1">
                  {t("https.domain")}
                  <input name="domain" autoComplete="off" spellCheck={false} required value={domain} disabled={!!binding || busy || loading} onChange={(e) => setDomain(e.target.value)} placeholder="app.example.com" className="block w-full rounded border border-line bg-bg p-2" />
                </label>
                {!binding && (
                  <button disabled={busy || loading || !domain.trim()} className="button primary">{busy ? t("https.connecting") : t("https.connect")}</button>
                )}
              </form>
            </div>
            {loading && <p role="status" className="text-muted">{t("https.loading")}</p>}
            {(error || statusError) && <p role="alert" className="text-bad">{error || statusError}</p>}
            {binding && (
              <div className="space-y-3 rounded-lg border border-line p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p role="status" className="font-semibold">{binding.traffic_blocked ? t("https.blockedReady") : t(`https.s.${binding.status}`)}</p>
                  <button onClick={() => void submit(true)} disabled={busy} className="button secondary">{busy ? t("https.rechecking") : t("https.recheck")}</button>
                </div>
                {binding.error && <p role="alert" className="text-bad">{binding.error.message}</p>}
                {binding.dns_records.length > 0 && (
                  <div className="overflow-x-auto">
                    <p className="mb-2 text-muted">{t("https.dnsLead")}</p>
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-line"><th className="p-2">{t("https.dnsType")}</th><th className="p-2">{t("https.dnsName")}</th><th className="p-2">{t("https.dnsValue")}</th></tr>
                      </thead>
                      <tbody>
                        {binding.dns_records.map((r) => (
                          <tr key={r.type + r.name} className="border-b border-line">
                            <td className="p-2">{r.type}</td>
                            <td className="p-2 font-mono break-all select-all">{r.name}</td>
                            <td className="p-2"><code className="break-all select-all">{r.value}</code>{r.note && <p className="mt-1 text-muted">{r.note}</p>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {binding.status === "ready" && !binding.traffic_blocked && binding.https_url && (
                  <p>{t("https.url")} <a href={binding.https_url} target="_blank" rel="noreferrer" className="break-all text-accent underline">{binding.https_url}</a></p>
                )}
                {binding.certificate?.expires_at && (
                  <p className="text-xs text-muted">{t("https.cert", { date: new Date(binding.certificate.expires_at).toLocaleString(t.locale) })}</p>
                )}
                <ul className="space-y-1 text-xs">
                  {binding.checks.map((c) => <li key={c.name}>{c.ok ? "✓" : "○"} {c.name}: {c.detail}</li>)}
                </ul>
                <p className="text-xs text-muted">{t("https.internal", { v: binding.internal_transport === "unverified" ? t("https.unverified") : binding.internal_transport.toUpperCase() })}</p>
              </div>
            )}
          </>
        )}
      </div>
    </Section>
  );
}
