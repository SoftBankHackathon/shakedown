"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/components/i18n";
import { AiTag, Badge, Chip, Mono, RuleTag, Section } from "@/components/ui";
import { DeployReport } from "@/components/deploy-report";
import { StepTable } from "@/components/step-table";
import { api, DONE, errorMessage, formatSeconds, type Deployment, type Fix, type Report } from "@/lib/api";
import { orderTargets, targetLabel } from "@/lib/targets";

const STAGES = ["building", "deploying", "shakedown", "analyzing", "fixing"] as const;

export default function DeploymentPage() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const t = useT();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dep, setDep] = useState<Deployment | null>(null);
  const [logs, setLogs] = useState<{ source: string; line: string }[]>([]);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<number | null>(search.get("attempt") ? Number(search.get("attempt")) : null);
  const refetch = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }, [id]);

  if (!dep) return <p className="text-muted">{loadError ?? t("loading")}</p>;
  const attempt = dep.attempts.find((a) => a.n === tab) ?? dep.attempts.at(-1);
  const previous = attempt && dep.attempts.find((a) => a.n === attempt.n - 1);
  const done = DONE.has(dep.status);
  const names = orderTargets(Object.keys(dep.targets));
  // Prefer the target names the shakedown reports; fall back to catalog order.
  const firstDiff = attempt?.steps?.[0];
  const baseline = firstDiff?.baseline ?? names[0];
  const candidate = firstDiff?.candidate ?? names.find((n) => n !== baseline) ?? "";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href={`/projects/${dep.project_id}`} className="text-xs text-muted hover:underline">{t("dep.back")}</Link>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-3">
            {t("dep.title")} <span className="font-mono text-lg text-muted">{dep.id}</span>
          </h1>
          <p className="text-sm text-muted mt-1">{done ? statusLine(dep, t) : message || t("dep.working")}</p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Metric label={t("dep.total")} value={seconds(dep.timings.total_s)} />
          {dep.mode !== "comparison" && <><Metric label={t("dep.build")} value={seconds(dep.timings.build_s)} /><Metric label={t("dep.deploy")} value={seconds(dep.timings.deploy_s)} /></>}
          <Metric label={t("dep.aiCost")} value={`₩${dep.ai_cost.krw}`} hint={t("dep.calls", { n: dep.ai_cost.calls })} />
          <Badge status={dep.status} />
        </div>
      </div>

      <Pipeline dep={dep} t={t} />
      <DeployReport dep={dep} />
      {dep.traffic_blocked === false && dep.status === "blocked" && <p className="text-sm text-warn">{t("dep.gateOnly")}</p>}
      {dep.error && <pre className="card p-4 text-xs text-bad whitespace-pre-wrap">{dep.error}</pre>}

      <div className="grid gap-4 md:grid-cols-2">
        {names.map((name) => {
          const s = dep.targets[name];
          const o = dep.options[name];
          return (
            <div key={name} className="card p-4">
              <div className="flex items-center justify-between">
                <div className="font-medium">{targetLabel(name)}</div>
                <Badge status={s.status} />
              </div>
              <div className="text-xs text-muted mt-0.5">{s.label}</div>
              {s.url && s.status !== "stopped" && (
                <a href={s.url} target="_blank" className="mt-3 block font-mono text-sm text-accent hover:underline">{s.url} ↗</a>
              )}
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {o && <Chip>{t("dep.instances", { n: o.replicas })}</Chip>}
                {o && name !== baseline && <Chip>{t("dep.affinity", { v: t(o?.sticky_sessions ? "on" : "off") })}</Chip>}
                {o && <Chip>TZ {o.tz}</Chip>}
              </div>
              {s.error && <pre className="mt-3 text-xs text-bad whitespace-pre-wrap max-h-40 overflow-auto">{s.error}</pre>}
            </div>
          );
        })}
      </div>

      {dep.shakedown && (
        <Section
          title={t("dep.shakedown")}
          right={
            dep.attempts.length > 1 && (
              <div className="flex gap-1">
                {dep.attempts.map((a) => (
                  <button key={a.n} onClick={() => setTab(a.n)}
                    className={`rounded-md px-2.5 py-1 text-xs border ${a.n === attempt?.n ? "border-accent text-accent" : "border-line text-muted"}`}>
                    #{a.n} {a.verdict?.status ?? t("dep.running")}
                  </button>
                ))}
              </div>
            )
          }
        >
          {dep.scenario ? (
            <>
              <div className="mb-4 flex items-start gap-2 text-sm">
                {dep.scenario_source === "ai" ? <AiTag>{t("dep.aiJourney")}</AiTag>
                  : dep.scenario_source === "saved" ? <RuleTag>{t("dep.savedJourney")}</RuleTag>
                  : <RuleTag>{t("dep.ruleJourney")}</RuleTag>}
                {dep.scenario_source !== "fallback" && <span className="text-muted">{dep.scenario.app_understanding}</span>}
              </div>
              {previous?.applied_fix && (
                <p className="mb-3 text-xs text-muted">
                  {t("dep.retry", { n: previous.n, fix: fixLabel(previous.applied_fix) })}
                </p>
              )}
              {attempt?.verdict && <VerdictBanner v={attempt.verdict} t={t} />}
              {attempt?.applied_fix && (
                <p className="mb-3 text-xs text-muted">
                  {t("dep.appliedAfter", { target: targetLabel(attempt.applied_fix.target), fix: fixLabel(attempt.applied_fix) })}
                </p>
              )}
              <StepTable baseline={targetLabel(baseline)} candidate={targetLabel(candidate)} steps={dep.scenario.steps} diffs={attempt?.steps ?? []} running={!done && !attempt?.verdict} />
            </>
          ) : (
            <p className="text-sm text-muted">{done ? t("dep.notRun") : t("dep.waiting")}</p>
          )}
        </Section>
      )}

      {attempt?.report && <ReportCard report={attempt.report} applied={!!attempt.applied_fix} t={t} />}

      <details className="card p-4" open={!done && !dep.scenario}>
        <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-muted">{t("dep.log")}</summary>
        <pre className="mt-3 max-h-80 overflow-auto text-[11px] leading-relaxed font-mono text-muted">
          {logs.map((l, i) => <div key={i}><span className="text-accent">[{l.source}]</span> {l.line}</div>)}
        </pre>
      </details>
    </div>
  );
}

type T = ReturnType<typeof useT>;

function statusLine(d: Deployment, t: T) {
  if (d.status === "warned") return t("dep.warned");
  if (d.status === "deployed") return t("dep.deployed");
  if (d.status === "promoted") return t("dep.promoted");
  if (d.status === "blocked") return t("dep.blocked");
  return t("dep.failed");
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="text-right">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="font-semibold tabular-nums" title={hint}>{value}</div>
    </div>
  );
}

const seconds = (s?: number) => (s != null ? formatSeconds(s) : "…");
const fixLabel = (f: Fix) => `${f.option}=${f.value}`;

function Pipeline({ dep, t }: { dep: Deployment; t: T }) {
  const reached = new Set<string>(["building"]);
  if (dep.timings.build_s) reached.add("deploying");
  if (dep.scenario || dep.attempts.length) reached.add("shakedown");
  if (dep.attempts.some((a) => a.report)) reached.add("analyzing");
  if (dep.attempts.some((a) => a.applied_fix)) reached.add("fixing");
  const shown = STAGES.filter((s) => dep.mode === "comparison" ? s === "shakedown" || reached.has(s) && s !== "building" && s !== "deploying" : reached.has(s) || s === "shakedown" || s === "deploying");
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {shown.map((s, i) => {
        const current = dep.status === s;
        const passed = reached.has(s) && !current;
        return (
          <li key={s} className="flex items-center gap-2">
            <span className={`rounded-full px-3 py-1 border ${current ? "border-accent text-accent" : passed ? "border-ok/40 text-ok" : "border-line text-muted"}`}>
              {current && <span className="mr-1.5 inline-block size-1.5 rounded-full bg-accent animate-pulse" />}
              {t(`stage.${s}`)}
            </span>
            {i < shown.length - 1 && <span className="text-muted">→</span>}
          </li>
        );
      })}
      <span className="text-muted">→</span>
      {DONE.has(dep.status) ? <Badge status={dep.status} /> : <Badge status="pending">{t("stage.verdict")}</Badge>}
    </ol>
  );
}

function VerdictBanner({ v, t }: { v: NonNullable<Deployment["attempts"][number]["verdict"]>; t: T }) {
  const style = v.status === "BLOCKED" ? "border-bad/40 bg-bad/10 text-bad"
    : v.status === "WARN" ? "border-warn/40 bg-warn/10 text-warn" : "border-ok/40 bg-ok/10 text-ok";
  return (
    <div className={`mb-4 rounded-lg border px-4 py-3 text-sm ${style}`}>
      <span className="font-semibold mr-2">{t(`verdict.${v.status}`)}</span>
      <span className="opacity-90">{v.summary}</span>
      <span className="ml-2 opacity-70 text-xs">{t("verdict.byRules")}</span>
    </div>
  );
}

function ReportCard({ report, applied, t }: { report: Report; applied: boolean; t: T }) {
  return (
    <Section title={t("report.title")} right={report.by === "ai" ? <AiTag>{t("report.ai")}</AiTag> : <RuleTag>{t("report.rule")}</RuleTag>}>
      <h3 className="text-lg font-semibold">{report.headline}</h3>
      <p className="mt-2 text-sm">{report.cause}</p>
      <ul className="mt-3 space-y-1 text-xs text-muted list-disc pl-5">
        {report.evidence.map((e) => <li key={e} className="font-mono">{e}</li>)}
      </ul>
      {report.fix && (
        <div className="mt-4 rounded-lg border border-line p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium">{t("report.fix")}: {report.fix.description}</span>
            {report.fix.auto_applicable
              ? <Badge status={applied ? "passed" : "pending"}>{applied ? t("report.applied") : t("report.applicable")}</Badge>
              : <Badge status="WARN">{t("report.suggestion")}</Badge>}
          </div>
          <div className="mt-1 text-xs text-muted">
            <Mono>{report.fix.target}: {report.fix.option} = {report.fix.value}</Mono>
            {report.fix.native && <> · {report.fix.native}</>}
          </div>
        </div>
      )}
      <p className="mt-3 text-[11px] text-muted">{t("report.footer", { c: report.confidence })}</p>
    </Section>
  );
}
