"use client";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { BsArrowRepeat, BsHddNetwork } from "react-icons/bs";
import { useT } from "@/components/i18n";
import { Alert, Breadcrumb, PageHeading } from "@/components/ui";
import { API, MOCK, type LlmConnectionStatus as Connection } from "@/lib/api";
import { useEngineOnline } from "@/lib/engine";

const MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];
const DEFAULT_MODEL = MODELS[0].id;

export default function Settings() {
  const t = useT();
  const online = useEngineOnline();
  const [status, setStatus] = useState<Connection | null>(null);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [customModel, setCustomModel] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => {
    fetch(API + "/api/settings/llm", { cache: "no-store" }).then(async (r) => {
      if (!r.ok) throw new Error("설정을 불러오지 못했습니다. 엔진 연결을 확인하세요.");
      const s = await r.json(); setStatus(s); setError("");
      if (s.model) {
        setModel(s.model);
        setCustomModel(!MODELS.some((option) => option.id === s.model));
      }
    }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (MOCK) return;
    load();
  }, [load]);
  async function update(disconnect = false) {
    setBusy(true); setError(""); setMessage("");
    try {
      const r = await fetch(API + `/api/settings/llm/${disconnect ? "disconnect" : "connect"}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: disconnect ? undefined : JSON.stringify({ model, ...(key ? { api_key: key } : {}) }),
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.detail ?? "연결에 실패했습니다.");
      setStatus(result); setKey("");
      setMessage(disconnect ? "현재 엔진의 API 연결을 해제했습니다." : "Claude 응답을 확인했습니다. 규칙으로 생성할 수 없을 때 자동으로 호출합니다.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const aiState = status?.verified ? "연결 확인됨" : status?.configured ? "설정됨 · 테스트 필요" : "미연결";
  const engineState = MOCK ? t("conn.mock") : online ? t("settings.on") : online === false ? t("settings.off") : t("settings.checking");
  return (
    <>
      <Breadcrumb parent={t("nav.newAction")} parentHref="/" current={t("settings.title")} />
      <PageHeading title={t("settings.title")} lead={t("settings.lead")}>
        {!MOCK && <button type="button" className="button secondary" onClick={load} disabled={busy}><BsArrowRepeat />{t("settings.refresh")}</button>}
      </PageHeading>
      {MOCK && <Alert>데모 모드입니다. 실제 엔진을 연결하면 설정할 수 있습니다.</Alert>}
      <div className="settings-grid">
        <section className="panel connection-card">
          <span className="connection-icon"><BsHddNetwork /></span>
          <div>
            <div className="connection-title"><h3>{t("settings.engine")}</h3><span className="tag">{engineState}</span></div>
            <p>{t("settings.engineDesc")}</p>
          </div>
        </section>
        <section className="panel connection-card">
          <span className="connection-icon"><Image src="/providers/claude.svg" alt="Claude" width={24} height={24} /></span>
          <div>
            <div className="connection-title"><h3>Anthropic Claude</h3><span className="tag">{aiState}</span></div>
            <p>{t("settings.aiDesc")}{status?.configured && <> 현재 설정: <span className="mono">{status.model}</span></>}</p>
          </div>
        </section>
      </div>
      <section className="panel settings-options">
        <h3>AI API 연결</h3>
        <p className="hint">규칙으로 Dockerfile을 생성할 수 없을 때 사용할 Claude 모델을 연결하세요. 모델을 선택한 뒤 연결 테스트 후 적용을 눌러주세요. 계정별 모델 사용 가능 여부도 함께 확인합니다.</p>
        <form className="modal-fields" onSubmit={(e) => { e.preventDefault(); void update(); }}>
          <label>모델 선택
            <select disabled={busy || MOCK} value={customModel ? "custom" : model} onChange={(e) => {
              const custom = e.target.value === "custom";
              setCustomModel(custom); setModel(custom ? "" : e.target.value);
              setMessage(""); setError("");
            }}>
              {MODELS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              <option value="custom">다른 모델 직접 입력</option>
            </select>
          </label>
          {customModel && <label>모델 ID<input required disabled={busy || MOCK} value={model} onChange={(e) => setModel(e.target.value.trim())} placeholder="사용할 Claude 모델 ID" /></label>}
          <label>API 키<input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={status?.configured ? "비워두면 현재 키 사용" : "Anthropic API 키"} /></label>
          <p className="hint">입력한 키는 엔진 메모리에만 보관하며 재시작하면 사라집니다. 연결 테스트는 짧은 API 요청을 보내므로 사용 요금이 발생할 수 있습니다. 이 설정은 이미지 계획용이며 기존 시운전 보고서 설정과 별개입니다.</p>
          <div className="actions">
            <button className="button primary" disabled={MOCK || busy || !model || (!key && !status?.configured)}>{busy ? "연결 중…" : "연결 테스트 후 적용"}</button>
            <button type="button" className="button secondary" onClick={() => void update(true)} disabled={MOCK || busy || !status?.configured}>연결 해제</button>
          </div>
        </form>
        {message && <p role="status" className="hint" style={{ color: "var(--ok)", marginTop: 14 }}>{message}</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
      </section>
      <p className="settings-footnote">엔진·Target·Shakedown 서비스는 loopback에서만 동작하는 개발용 구성입니다. 공개 멀티유저 서비스용 인증과 사용자별 키 격리는 범위에 없습니다.</p>
    </>
  );
}
