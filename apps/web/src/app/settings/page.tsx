"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { API, MOCK, type LlmConnectionStatus as Connection } from "@/lib/api";

export default function Settings() {
  const [status, setStatus] = useState<Connection | null>(null);
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (MOCK) return;
    fetch(API+"/api/settings/llm", {cache:"no-store"}).then(async (r) => {
      if (!r.ok) throw new Error("설정을 불러오지 못했습니다. 엔진 연결을 확인하세요.");
      const s = await r.json(); setStatus(s); setModel(s.model);
    }).catch((e) => setError(e.message));
  }, []);
  async function update(disconnect = false) {
    setBusy(true); setError(""); setMessage("");
    try {
      const r = await fetch(API+`/api/settings/llm/${disconnect ? "disconnect" : "connect"}`, {
        method:"POST", headers:{"content-type":"application/json"},
        body:disconnect ? undefined : JSON.stringify({model, ...(key ? {api_key:key} : {})})
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.detail ?? "연결에 실패했습니다.");
      setStatus(result); setKey("");
      setMessage(disconnect ? "현재 엔진의 API 연결을 해제했습니다." : "Claude 응답을 확인했습니다. 이미지 계획에서 AI 보조를 사용할 수 있습니다.");
    } catch(e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="max-w-2xl space-y-6">
    <Link href="/" className="text-sm text-muted hover:underline">대시보드로</Link>
    <div><h1 className="text-2xl font-semibold">AI API 연결</h1><p className="mt-2 text-muted">Docker 이미지 계획을 검토할 Claude 모델을 연결하세요.</p></div>
    {MOCK && <p role="status" className="text-warn">데모 모드입니다. 실제 엔진을 연결하면 설정할 수 있습니다.</p>}
    <div className="border-y border-line py-4 flex justify-between gap-4"><span>Anthropic Claude</span><strong className={status?.verified ? "text-ok" : "text-muted"}>{status?.verified ? "연결 확인됨" : status?.configured ? "설정됨 · 테스트 필요" : "미연결"}</strong></div>
    <form className="space-y-5" onSubmit={(e) => {e.preventDefault(); void update();}}>
      <label className="block text-sm">모델 ID<input required value={model} onChange={(e) => setModel(e.target.value)} placeholder="사용할 Claude 모델 ID" className="mt-2 w-full rounded-lg border border-line bg-panel p-3 focus:outline-accent" /></label>
      <label className="block text-sm">API 키<input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={status?.configured ? "비워두면 현재 키 사용" : "Anthropic API 키"} className="mt-2 w-full rounded-lg border border-line bg-panel p-3 focus:outline-accent" /></label>
      <p className="text-sm text-muted leading-relaxed">입력한 키는 엔진 메모리에만 보관하며 재시작하면 사라집니다. 연결 테스트는 짧은 API 요청을 보내므로 사용 요금이 발생할 수 있습니다. 이 설정은 이미지 계획용이며 기존 시운전 보고서 설정과 별개입니다.</p>
      <div className="flex gap-3"><button disabled={MOCK || busy || !model || (!key && !status?.configured)} className="rounded-lg bg-accent px-5 py-2.5 text-white disabled:opacity-50">{busy ? "연결 중…" : "연결 테스트 후 적용"}</button><button type="button" onClick={() => void update(true)} disabled={MOCK || busy || !status?.configured} className="rounded-lg border border-line px-4 py-2 disabled:opacity-50">연결 해제</button></div>
    </form>
    {message && <p role="status" className="text-ok">{message}</p>}
    {error && <p role="alert" className="text-bad">{error}</p>}
  </div>;
}
