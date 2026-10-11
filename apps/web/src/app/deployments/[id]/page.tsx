"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BsArrowRepeat, BsArrowUpRight, BsClock, BsFileEarmarkText, BsShieldCheck, BsTerminal } from "react-icons/bs";
import { DeployReport } from "@/components/deploy-report";
import { useT } from "@/components/i18n";
import { ProviderIcon } from "@/components/provider-icon";
import { StepTable } from "@/components/step-table";
import { AiTag, Alert, Badge, Breadcrumb, Elapsed, Mono, RuleTag, Section, Stat } from "@/components/ui";
import { api, DONE, errorMessage, formatSeconds, type Deployment, type Fix, type Report } from "@/lib/api";
import { byCandidate } from "@/lib/steps";
import { orderTargets, targetLabel } from "@/lib/targets";

const STAGES = ["building", "deploying", "shakedown", "analyzing", "fixing"] as const;
type View = "live" | "report" | "logs";
const TAB_KEY = { live: "run.tabLive", report: "run.tabReport", logs: "run.tabLogs" } as const;
type T = ReturnType<typeof useT>;

export default function DeploymentPage() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const t = useT();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dep, setDep] = useState<Deployment | null>(null);
  const [logs, setLogs] = useState<{ source: string; line: string }[]>([]);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<number | null>(search.get("attempt") ? Number(search.get("attempt")) : null);
  const [view, setView] = useState<View | null>(null);
  const refetch = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 이벤트 스트림은 blocked에서 done을 받고 닫힌다. 수정을 적용하면 이 값을 올려 다시 구독한다.
  const [stream, setStream] = useState(0);

  // The top bar's 시운전 tab returns to the run that was open last.
  useEffect(() => {
    try { sessionStorage.setItem("lastDeployment", id); } catch {}
  }, [id]);

  useEffect(() => {
    api.deployment(id).then(setDep).catch((e) => setLoadError(errorMessage(e)));
    // Build logs can arrive many lines per second: buffer them and repaint at most 5 times a second.
    let buffer: { source: string; line: string }[] = [];
    const flush = setInterval(() => {
      if (!buffer.length) return;
      const lines = buffer;
      buffer = [];
      setLogs((l) => [...l, ...lines].slice(-400));
    }, 200);
    const unsubscribe = api.subscribe(id, (ev) => {
      if (ev.kind === "log") {
        buffer.push({ source: String(ev.source), line: String(ev.line) });
        return;
      }
      if (ev.kind === "stage") setMessage(String(ev.message ?? ""));
      if (refetch.current) clearTimeout(refetch.current);
      refetch.current = setTimeout(() => api.deployment(id).then(setDep).catch((e) => setLoadError(errorMessage(e))), 120);
    });
    return () => {
      clearInterval(flush);
      if (refetch.current) clearTimeout(refetch.current);
      unsubscribe();
    };
  }, [id, stream]);

  // SSE through a dev proxy can arrive in one burst at the end, so also poll until the deployment is done.
  const finished = dep != null && DONE.has(dep.status);
  useEffect(() => {
    if (finished) return;
    const timer = setInterval(() => api.deployment(id).then(setDep).catch(() => {}), 2500);
    return () => clearInterval(timer);
  }, [id, finished]);

  if (!dep) return <p className="muted">{loadError ?? t("loading")}</p>;
  const attempt = dep.attempts.find((a) => a.n === tab) ?? dep.attempts.at(-1);
  const previous = attempt && dep.attempts.find((a) => a.n === attempt.n - 1);
  const done = DONE.has(dep.status);
  const names = orderTargets(Object.keys(dep.targets));
  // Prefer the target names the shakedown reports; fall back to catalog order.
  const baseline = attempt?.steps?.[0]?.baseline ?? names[0];
  const comparisons = byCandidate(attempt?.steps ?? [], names, baseline);
  // Before the first row arrives, show the table for the first compared target.
  if (!comparisons.length) comparisons.push([names.find((n) => n !== baseline) ?? "", []]);
  const current: View = view ?? (done ? "report" : "live");
  const last = dep.attempts.at(-1);
  // After a fix the final attempt has no report of its own; the blocked attempt's cause analysis still explains the run.
  const reported = attempt?.report ? attempt : dep.attempts.find((a) => a.report);
  const gate = dep.status === "promoted" ? "" : dep.status === "blocked" ? "blocked" : "neutral";

  return (
    <>
      <Breadcrumb parent={t("run.project")} parentHref={`/projects/${dep.project_id}`} current={t("bc.run")} />
      <div className="page-heading run-heading">
        <div>
          <div className="run-title">
            <h2>{t("dep.title")}<span className="muted mono">{dep.id}</span></h2>
            <Badge status={dep.status} />
          </div>
          <p className="run-meta">
            <span><BsClock />{done || dep.timings.total_s != null ? seconds(dep.timings.total_s) : <Elapsed created={dep.created} />}</span>
            {dep.mode !== "comparison" && <><span>{t("dep.build")} {seconds(dep.timings.build_s)}</span><span>{t("dep.deploy")} {seconds(dep.timings.deploy_s)}</span></>}
            <span>{t("dep.aiCost")} ₩{dep.ai_cost.krw} · {t("dep.calls", { n: dep.ai_cost.calls })}</span>
            <span>{done ? statusLine(dep, t) : message || t("dep.working")}</span>
          </p>
        </div>
        <div className="actions">
          <Link href={`/projects/${dep.project_id}`} className="button secondary">{t("run.project")}</Link>
          <button type="button" className="button secondary" onClick={() => setView(current === "logs" ? "live" : "logs")}>
            <BsTerminal />{current === "logs" ? t("run.tabLive") : t("run.tabLogs")}
          </button>
        </div>
      </div>
      {dep.error && <Alert>{dep.error}</Alert>}
      {dep.traffic_blocked === false && dep.status === "blocked" && <p className="hint" style={{ marginBottom: 14 }}>{t("dep.gateOnly")}</p>}

      <div className="run-tabs" role="tablist" aria-label={t("bc.run")}>
        {(Object.keys(TAB_KEY) as View[]).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={current === v} className={current === v ? "active" : ""} onClick={() => setView(v)}>
            {t(TAB_KEY[v])}
            {v === "logs" && logs.length > 0 && <span className="count">{logs.length}</span>}
          </button>
        ))}
      </div>

      {current === "live" && (
        <>
          <Pipeline dep={dep} t={t} />
          <div className="environments">
            {names.map((name) => {
              const s = dep.targets[name];
              const o = dep.options[name];
              const facts = [
                o && t("dep.instances", { n: o.replicas }),
                o && name !== baseline && t("dep.affinity", { v: t(o.sticky_sessions ? "on" : "off") }),
                o && `TZ ${o.tz}`,
                // GCP 어댑터가 알려 주는 세션 저장 위치. 수정 적용 뒤 memory → jdbc로 바뀐다.
                s.info?.session && t("dep.session", { v: s.info.session }),
              ].filter(Boolean).join(" · ");
              const open = s.url && s.status !== "stopped";
              return (
                <div key={name}>
                  <ProviderIcon id={name} size={23} />
                  <div className="env-card-body">
                    <strong>{targetLabel(name)}<Badge status={s.status} /></strong>
                    <p>{s.label}{facts && ` · ${facts}`}</p>
                    {open && <p className="mono">{s.url}</p>}
                    {s.error && <pre>{s.error}</pre>}
                  </div>
                  {open && <a href={s.url} target="_blank" rel="noreferrer" className="icon-button" aria-label={t("run.open")}><BsArrowUpRight /></a>}
                </div>
              );
            })}
          </div>

          {dep.shakedown && (
            <Section
              title={t("dep.shakedown")}
              right={dep.attempts.length > 1 && (
                <div className="tab-group">
                  {dep.attempts.map((a) => (
                    <button key={a.n} type="button" className={a.n === attempt?.n ? "active" : ""} onClick={() => setTab(a.n)}>
                      #{a.n} {a.verdict?.status ?? t("dep.running")}
                    </button>
                  ))}
                </div>
              )}
            >
              {dep.scenario ? (
                <>
                  <div className="journey-line">
                    {journeyTag(dep, t)}
                    {dep.scenario_source !== "fallback" && <span>{dep.scenario.app_understanding}</span>}
                  </div>
                  {previous?.applied_fix && <p className="hint" style={{ marginBottom: 12 }}>{t("dep.retry", { n: previous.n, fix: fixLabel(previous.applied_fix) })}</p>}
                  {attempt?.verdict && <VerdictLine v={attempt.verdict} t={t} />}
                  {attempt?.applied_fix && <p className="hint" style={{ marginBottom: 12 }}>{t("dep.appliedAfter", { target: targetLabel(attempt.applied_fix.target), fix: fixLabel(attempt.applied_fix) })}</p>}
                  <div className="space-y-6">
                    {comparisons.map(([candidate, rows]) => (
                      <StepTable key={candidate} baseline={targetLabel(baseline)} candidate={targetLabel(candidate)} steps={dep.scenario!.steps} diffs={rows}
                        running={!done && rows.length < dep.scenario!.steps.length} />
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm muted">{done ? t("dep.notRun") : t("dep.waiting")}</p>
              )}
            </Section>
          )}
        </>
      )}

      {current === "report" && (
        <>
          {done && gate !== "neutral" ? (
            <div className={`gate-banner ${gate}`}>
              <BsShieldCheck size={32} />
              <div>
                <h2>{t(dep.status === "promoted" ? "gate.passed" : "gate.blocked")}</h2>
                <p>{last?.verdict?.summary ?? statusLine(dep, t)}</p>
              </div>
              <Badge status={dep.status} />
            </div>
          ) : (
            <div className="gate-banner neutral">
              {done ? <BsShieldCheck size={32} /> : <span className="spinner" />}
              <div>
                <h2>{done ? statusLine(dep, t) : t("gate.pending")}</h2>
                <p>{done ? dep.error ?? "" : t("gate.pendingDesc")}</p>
              </div>
              <Badge status={dep.status} />
            </div>
          )}
          <div className="report-grid">
            <DeployReport dep={dep} />
            {reported?.report ? (
              <ReportCard
                report={reported.report}
                applied={dep.attempts.some((a) => a.applied_fix)}
                // 엔진은 차단된 1회차에서만 수정을 한 번 받는다. 최신 배포인지 등 나머지는 엔진이 409/400으로 알려 준다.
                canApply={dep.status === "blocked" && dep.mode !== "comparison" && dep.attempts.length === 1}
                onApply={async () => {
                  setDep(await api.applyFix(dep.id));
                  setTab(null);
                  setView("live");
                  setStream((n) => n + 1);
                }}
                t={t}
              />
            ) : (
              <Section title={t("report.title")} icon={<BsFileEarmarkText />}><p className="text-sm muted">{t("report.noReport")}</p></Section>
            )}
          </div>
          <div className="stats usage">
            <Stat label={t("usage.calls")} value={t("dep.calls", { n: dep.ai_cost.calls })} />
            <Stat label={t("usage.tokens")} value={`${dep.ai_cost.input_tokens} / ${dep.ai_cost.output_tokens}`} />
            <Stat label={t("usage.cost")} value={`₩${dep.ai_cost.krw}`} />
            <Stat label={t("usage.time")} value={seconds(dep.timings.total_s)} />
          </div>
          <p className="hint">{t("usage.note")}</p>
        </>
      )}

      {current === "logs" && (
        <section className="logs-panel">
          <div className="logs-heading">
            <span><BsTerminal />{t("run.logs")}</span>
            <span>{done ? t("run.logsDone") : t("run.logsLive")} · {logs.length}</span>
          </div>
          <div className="log-lines">
            {logs.length ? logs.map((l, i) => <div className="log-row src" key={i}><time>{l.source}</time><p>{l.line}</p></div>) : <p>{t("run.logsEmpty")}</p>}
          </div>
        </section>
      )}
    </>
  );
}

function statusLine(d: Deployment, t: T) {
  if (d.status === "warned") return t("dep.warned");
  if (d.status === "deployed") return t("dep.deployed");
  if (d.status === "promoted") return t("dep.promoted");
  if (d.status === "blocked") return t("dep.blocked");
  return t("dep.failed");
}

const seconds = (s?: number) => (s != null ? formatSeconds(s) : "…");
const fixLabel = (f: Fix) => `${f.option}=${f.value}`;

function journeyTag(dep: Deployment, t: T) {
  if (dep.scenario_source === "ai") return <AiTag>{t("dep.aiJourney")}</AiTag>;
  if (dep.scenario_source === "saved") return <RuleTag>{t("dep.savedJourney")}</RuleTag>;
  return <RuleTag>{t("dep.ruleJourney")}</RuleTag>;
}

function Pipeline({ dep, t }: { dep: Deployment; t: T }) {
  const reached = new Set<string>(["building"]);
  if (dep.timings.build_s) reached.add("deploying");
  if (dep.scenario || dep.attempts.length) reached.add("shakedown");
  if (dep.attempts.some((a) => a.report)) reached.add("analyzing");
  if (dep.attempts.some((a) => a.applied_fix)) reached.add("fixing");
  const shown = STAGES.filter((s) => dep.mode === "comparison" ? s === "shakedown" || reached.has(s) && s !== "building" && s !== "deploying" : reached.has(s) || s === "shakedown" || s === "deploying");
  return (
    <ol className="pipeline">
      {shown.map((s, i) => {
        const current = dep.status === s;
        const passed = reached.has(s) && !current;
        return (
          <li key={s} className="flex items-center gap-2">
            <span className={`badge ${current ? "running" : passed ? "passed" : ""}`}><i />{t(`stage.${s}`)}</span>
            {i < shown.length - 1 && <span>→</span>}
          </li>
        );
      })}
      <span>→</span>
      {DONE.has(dep.status) ? <Badge status={dep.status} /> : <Badge status="pending">{t("stage.verdict")}</Badge>}
    </ol>
  );
}

function VerdictLine({ v, t }: { v: NonNullable<Deployment["attempts"][number]["verdict"]>; t: T }) {
  const cls = v.status === "BLOCKED" ? "blocked" : v.status === "WARN" ? "warn" : "passed";
  return (
    <div className={`verdict-line ${cls}`}>
      <strong>{t(`verdict.${v.status}`)}</strong>
      <span>{v.summary}</span>
      <small>{t("verdict.byRules")}</small>
    </div>
  );
}

function ReportCard({ report, applied, canApply, onApply, t }: {
  report: Report; applied: boolean; canApply: boolean; onApply: () => Promise<void>; t: T;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function apply() {
    setBusy(true);
    setError(null);
    try {
      await onApply();
    } catch (e) {
      // 409(최신 배포가 아님·이미 수정 중)와 400(자동 적용 불가)의 이유를 엔진 문장 그대로 보여 준다.
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title={t("report.title")} icon={<BsFileEarmarkText />} className="analysis"
      right={report.by === "ai" ? <AiTag>{t("report.ai")}</AiTag> : <RuleTag>{t("report.rule")}</RuleTag>}>
      <h4>{t("report.cause")}</h4>
      <p><strong>{report.headline}</strong><br />{report.cause}</p>
      {report.fix && (
        <>
          <h4>{t("report.recommend")}</h4>
          <p>
            {report.fix.description}<br />
            <Mono>{report.fix.target}: {report.fix.option} = {report.fix.value}</Mono>
            {report.fix.native && <> · <span className="muted">{report.fix.native}</span></>}<br />
            {report.fix.auto_applicable
              ? <Badge status={applied ? "passed" : "pending"}>{applied ? t("report.applied") : t("report.applicable")}</Badge>
              : <Badge status="WARN">{t("report.suggestion")}</Badge>}
          </p>
          {report.fix.auto_applicable && !applied && canApply && (
            <div className="actions" style={{ marginBottom: 22 }}>
              <button type="button" className="button primary" onClick={apply} disabled={busy}>
                <BsArrowRepeat />{busy ? t("report.applying") : t("report.applyFix")}
              </button>
              {error && <span className="red-text text-xs">{error}</span>}
            </div>
          )}
        </>
      )}
      {report.evidence.length > 0 && (
        <div className="report-evidence" style={{ marginTop: 0 }}>
          <h3>{t("report.evidence")}</h3>
          {report.evidence.map((e, i) => <div key={e}><span className="muted mono">{String(i + 1).padStart(2, "0")}</span><code>{e}</code></div>)}
        </div>
      )}
      <p className="hint" style={{ marginTop: 16, marginBottom: 0 }}>{t("report.footer", { c: report.confidence })}</p>
    </Section>
  );
}
