"use client";

import Link from "next/link";
import { HttpsSettings } from "@/components/https-settings";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useT } from "@/components/i18n";
import { AiTag, Badge, Mono, RuleTag, Section } from "@/components/ui";
import { api, MOCK, ApiError, errorMessage, formatSeconds, type Deployment, type Project, type TargetName, type TargetOptions } from "@/lib/api";
import { DEFAULT_TARGET_OPTIONS, DEFAULT_TARGETS, TARGETS, targetLabel, TIMEZONES } from "@/lib/targets";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const t = useT();
  const [project, setProject] = useState<Project | null>(null);
  const [deps, setDeps] = useState<Deployment[]>([]);
  const [shakedown, setShakedown] = useState(MOCK);
  const [autofix, setAutofix] = useState(MOCK);
  // Options per non-baseline target, keyed by target name.
  const [opts, setOpts] = useState<Record<string, TargetOptions>>({});
  const [liveTargets, setLiveTargets] = useState<TargetName[]>(["local"]);
  const [comparisonUrl, setComparisonUrl] = useState("");
  const [baselineUrl, setBaselineUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.project(id).then((p) => { setProject(p); const supported = (p.targets ?? ["local"]).filter((x) => x === "local" || x === "aws"); setLiveTargets(supported.length ? supported : ["local"]); }).catch((e) => setError(e.message));
    api.deployments(id).then(setDeps).catch(() => {});
  }, [id]);

  async function deploy() {
    setBusy(true);
    setError(null);
    try {
      const d = await api.deploy(id, { shakedown: MOCK ? shakedown : liveTargets.length === 2 || !!comparisonUrl.trim(), autofix, options: MOCK ? opts : Object.fromEntries(Object.entries(opts).filter(([name]) => liveTargets.includes(name as TargetName))), targets: MOCK ? undefined : liveTargets, comparison: !MOCK && liveTargets.length === 1 && comparisonUrl.trim() ? {name:"candidate", url:comparisonUrl.trim()} : undefined });
      router.push(`/deployments/${d.id}`);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? t("home.busy", { name: project?.name ?? id }) : errorMessage(e));
      setBusy(false);
    }
  }

  async function compareExisting() {
    setBusy(true); setError(null);
    try {
      const d = await api.compare(id, { baseline: {name:"local", url:baselineUrl.trim()}, candidate:{name:"candidate", url:comparisonUrl.trim()} });
      router.push(`/deployments/${d.id}`);
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }

  if (!project) return <p className="text-muted">{error ?? t("loading")}</p>;
  const a = project.analysis;
  const targets = MOCK ? project.targets ?? DEFAULT_TARGETS : liveTargets;
  const [baseline, ...candidates] = targets;
  const optsFor = (name: string): TargetOptions => opts[name] ?? DEFAULT_TARGET_OPTIONS;
  const setOpt = (name: string, patchOpt: Partial<TargetOptions>) =>
    setOpts((cur) => ({ ...cur, [name]: { ...optsFor(name), ...patchOpt } }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/" className="text-xs text-muted hover:underline">{t("project.back")}</Link>
          <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
          <div className="text-xs text-muted font-mono">{project.repo}</div>
          {a.summary && (
            <p className="mt-2 text-sm flex items-center gap-2"><AiTag />{a.summary}</p>
          )}
        </div>
        <button
          onClick={deploy}
          disabled={busy || (!MOCK && liveTargets.length === 0)}
          className="rounded-xl bg-accent px-6 py-3 text-base font-semibold text-white shadow-sm disabled:opacity-60"
        >
          {busy ? t("project.starting") : t("action")}
        </button>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}

      {!MOCK && <Section title={t("live.compareTitle")}>
        <div className="space-y-3 text-sm">
          <label className="block">{t("live.candidate")}<input type="url" value={comparisonUrl} onChange={(e) => setComparisonUrl(e.target.value)} placeholder="https://comparison.example.com" className="mt-1 w-full rounded border border-line bg-bg p-2" /></label>
          <p className="text-xs text-muted">{t("live.compareHint")}</p>
          <label className="block">{t("live.baseline")}<input type="url" value={baselineUrl} onChange={(e) => setBaselineUrl(e.target.value)} placeholder="http://127.0.0.1:18080" className="mt-1 w-full rounded border border-line bg-bg p-2" /></label>
          <button disabled={busy || !baselineUrl.trim() || !comparisonUrl.trim()} onClick={compareExisting} className="rounded bg-accent px-4 py-2 text-white disabled:opacity-50">{t("live.compareNow")}</button>
          <p className="text-xs text-muted">{t("live.externalHint")}</p>
        </div>
      </Section>}
      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <Section title={t("project.detected")}>
          <table className="w-full text-sm">
            <tbody>
              {a.evidence.map((e) => (
                <tr key={e.field + e.value} className="border-t border-line first:border-0">
                  <td className="py-2 pr-3 text-muted w-32">{e.field}</td>
                  <td className="py-2 pr-3">{e.value}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {e.source === "ai" ? <AiTag /> : e.source === "default" ? <RuleTag>{t("tag.default")}</RuleTag> : <RuleTag>{t("tag.rule")}</RuleTag>}
                    {e.file && <div className="text-[11px] text-muted font-mono">{e.file}</div>}
                  </td>
                </tr>
              ))}
              {project.secrets.map((s) => (
                <tr key={s.name} className="border-t border-line">
                  <td className="py-2 pr-3 text-muted">secret</td>
                  <td className="py-2 pr-3"><Mono>{s.name} = {s.value}</Mono></td>
                  <td className="py-2 text-right text-[11px] text-muted">{t("project.hiddenFromAi")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {a.warnings.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-warn">
              {a.warnings.map((w) => <li key={w}>⚠ {w}</li>)}
            </ul>
          )}
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-muted">{t("project.routes", { n: a.routes.length })}</summary>
            <ul className="mt-2 space-y-0.5 font-mono text-xs">
              {a.routes.map((r) => (
                <li key={r.method + r.path}>
                  <span className="text-muted w-14 inline-block">{r.method}</span>{r.path}
                  {r.params.length > 0 && <span className="text-muted"> ({r.params.join(", ")})</span>}
                </li>
              ))}
            </ul>
          </details>
        </Section>

        <div className="space-y-6">
          <Section title={t("project.targets")}>
            {!MOCK && (
              <div className="mb-3 flex gap-3">
                {TARGETS.filter((x) => x.available).map((target) => (
                  <label key={target.id} className="text-sm">
                    <input type="checkbox" checked={liveTargets.includes(target.id)} onChange={(e) => {
                      setLiveTargets((current) => TARGETS.filter((x) => x.available &&
                        (x.id === target.id ? e.target.checked : current.includes(x.id))).map((x) => x.id));
                      setOpts({});
                    }} /> {target.label}
                  </label>
                ))}
              </div>
            )}
            <div className="space-y-3 text-sm">
              <div className="rounded-lg border border-line p-3">
                <div className="font-medium">
                  {targetLabel(baseline)}
                </div>
                <div className="text-xs text-muted">
                  {baseline === "local" && t("project.localDesc")}
                  {project.ports?.[baseline] ? ` · ${t("project.port")} ${project.ports[baseline]}` : ""}
                </div>
              </div>
              {candidates.map((name) => {
                const o = optsFor(name);
                return (
                  <div key={name} className="rounded-lg border border-line p-3 space-y-2">
                    <div className="font-medium">{targetLabel(name)}</div>
                    <label className="flex items-center justify-between text-xs">
                      {t("project.instances")}
                      <select value={o.replicas} onChange={(e) => setOpt(name, { replicas: Number(e.target.value) })}
                        className="rounded border border-line bg-bg px-2 py-1">
                        {(MOCK ? [1, 2, 3] : [1, 2]).map((n) => <option key={n}>{n}</option>)}
                      </select>
                    </label>
                    <label className="flex items-center justify-between text-xs">
                      {t("project.affinity")}
                      <input type="checkbox" disabled={!MOCK} checked={o.sticky_sessions}
                        onChange={(e) => setOpt(name, { sticky_sessions: e.target.checked })} />
                    </label>
                    <label className="flex items-center justify-between text-xs">
                      {t("project.timezone")}
                      <select value={o.tz} onChange={(e) => setOpt(name, { tz: e.target.value })}
                        className="rounded border border-line bg-bg px-2 py-1">
                        {TIMEZONES.map((tz) => <option key={tz}>{tz}</option>)}
                      </select>
                    </label>
                    {project.ports?.[name] && <div className="text-xs text-muted">{t("project.port")} {project.ports[name]}</div>}
                  </div>
                );
              })}
            </div>
          </Section>

          <Section title={t("project.after")}>
            {!MOCK && <p className="mb-3 text-sm text-muted">{t("live.scope")}</p>}
            <label className="flex items-start gap-3 text-sm mb-3">
              <input type="checkbox" disabled={!MOCK} checked={MOCK ? shakedown : liveTargets.length === 2 || !!comparisonUrl.trim()} onChange={(e) => setShakedown(e.target.checked)} className="mt-1" />
              <span>
                <span className="font-medium">{t("project.shakedown")}</span>
                <span className="block text-xs text-muted">{t("project.shakedownDesc")}</span>
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" disabled={!MOCK} checked={autofix} onChange={(e) => setAutofix(e.target.checked)} className="mt-1" />
              <span>
                <span className="font-medium">{t("project.autofix")}</span>
                <span className="block text-xs text-muted">{t("project.autofixDesc")}</span>
              </span>
            </label>
          </Section>
        </div>
      </div>

      <HttpsSettings projectId={id} />
      <Section title={t("project.deployments")}>
        {deps.length === 0 && <p className="text-sm text-muted">{t("project.noDeployments")}</p>}
        <ul className="divide-y divide-line">
          {deps.map((d) => {
            const fixed = d.attempts.find((x) => x.applied_fix);
            return (
              <li key={d.id}>
                <Link href={`/deployments/${d.id}`} className="flex items-center justify-between py-3 text-sm hover:text-accent">
                  <span className="font-mono">{d.id}</span>
                  <span className="flex items-center gap-4 text-xs text-muted">
                    <span>{t("project.shakedowns", { n: d.attempts.length })}</span>
                    {fixed?.applied_fix && <span>{t("project.autofixed", { x: fixed.applied_fix.option })}</span>}
                    <span>AI ₩{d.ai_cost.krw}</span>
                    {d.timings.total_s != null && <span>{formatSeconds(d.timings.total_s)}</span>}
                    <span>{t.ago(d.created)}</span>
                    <Badge status={d.status} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}
