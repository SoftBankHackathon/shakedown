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
      if (!r.ok) throw new Error(t("ai.loadError"));
      const s = await r.json(); setStatus(s); setError("");
      if (s.model) {
        setModel(s.model);
        setCustomModel(!MODELS.some((option) => option.id === s.model));
      }
    }).catch((e) => setError(e.message));
  }, [t]);
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
      if (!r.ok) throw new Error(result.detail ?? t("ai.connectError"));
      setStatus(result); setKey("");
      setMessage(t(disconnect ? "ai.disconnected" : "ai.connected"));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const aiState = t(status?.verified ? "ai.stateVerified" : status?.configured ? "ai.stateConfigured" : "ai.stateNone");
  const engineState = MOCK ? t("conn.mock") : online ? t("settings.on") : online === false ? t("settings.off") : t("settings.checking");
  return (
    <>
      <Breadcrumb parent={t("nav.newAction")} parentHref="/" current={t("settings.title")} />
      <PageHeading title={t("settings.title")} lead={t("settings.lead")}>
        {!MOCK && <button type="button" className="button secondary" onClick={load} disabled={busy}><BsArrowRepeat />{t("settings.refresh")}</button>}
      </PageHeading>
      {MOCK && <Alert>{t("settings.mock")}</Alert>}
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
            <p>{t("settings.aiDesc")}{status?.configured && <> {t("ai.current")} <span className="mono">{status.model}</span></>}</p>
          </div>
        </section>
      </div>
      <section className="panel settings-options">
        <h3>{t("ai.title")}</h3>
        <p className="hint">{t("ai.lead")}</p>
        <form className="modal-fields" onSubmit={(e) => { e.preventDefault(); void update(); }}>
          <label>{t("ai.model")}
            <select disabled={busy || MOCK} value={customModel ? "custom" : model} onChange={(e) => {
              const custom = e.target.value === "custom";
              setCustomModel(custom); setModel(custom ? "" : e.target.value);
              setMessage(""); setError("");
            }}>
              {MODELS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              <option value="custom">{t("ai.custom")}</option>
            </select>
          </label>
          {customModel && <label>{t("ai.modelId")}<input required disabled={busy || MOCK} value={model} onChange={(e) => setModel(e.target.value.trim())} placeholder={t("ai.modelIdPh")} /></label>}
          <label>{t("ai.key")}<input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t(status?.configured ? "ai.keyKeep" : "ai.keyPh")} /></label>
          <p className="hint">{t("ai.keyNote")}</p>
          <div className="actions">
            <button className="button primary" disabled={MOCK || busy || !model || (!key && !status?.configured)}>{t(busy ? "ai.connecting" : "ai.connect")}</button>
            <button type="button" className="button secondary" onClick={() => void update(true)} disabled={MOCK || busy || !status?.configured}>{t("ai.disconnect")}</button>
          </div>
        </form>
        {message && <p role="status" className="hint" style={{ color: "var(--ok)", marginTop: 14 }}>{message}</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
      </section>
      <p className="settings-footnote">{t("settings.footnote")}</p>
    </>
  );
}
