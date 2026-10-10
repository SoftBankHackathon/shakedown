"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BsArrowRight, BsBoxSeam, BsChevronDown, BsChevronRight, BsGithub, BsInfoCircle, BsShieldCheck } from "react-icons/bs";
import { ArchitecturePlanner } from "@/components/architecture-planner";
import { HttpsSettings } from "@/components/https-settings";
import { useLang, useT } from "@/components/i18n";
import { ImageBuilder } from "@/components/image-builder";
import { ProviderIcon } from "@/components/provider-icon";
import { RuntimeSettings } from "@/components/runtime-settings";
import { AiTag, Alert, Badge, Breadcrumb, ConnectionStrip, Section, Toggle } from "@/components/ui";
import { api, API, ApiError, errorMessage, formatSeconds, MOCK, type Deployment, type Project, type TargetName, type TargetOptions } from "@/lib/api";
import { DEFAULT_TARGET_OPTIONS, DEFAULT_TARGETS, orderTargets, pickTarget, TARGETS, targetLabel, TIMEZONES } from "@/lib/targets";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const t = useT();
  const lang = useLang();
  const [project, setProject] = useState<Project | null>(null);
  const [deps, setDeps] = useState<Deployment[]>([]);
  const [shakedown, setShakedown] = useState(MOCK);
  // Options per non-baseline target, keyed by target name.
  const [opts, setOpts] = useState<Record<string, TargetOptions>>({});
  const [liveTargets, setLiveTargets] = useState<TargetName[]>(["local"]);
  const [comparisonUrl, setComparisonUrl] = useState("");
  const [baselineUrl, setBaselineUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.project(id).then((p) => { setProject(p); const supported = (p.targets ?? ["local"]).filter((x) => TARGETS.some((t) => t.id === x && t.available)); setLiveTargets(supported.length ? supported : ["local"]); }).catch((e) => setError(e.message));
    api.deployments(id).then(setDeps).catch(() => {});
  }, [id]);

  async function deploy() {
    setBusy(true);
    setError(null);
    try {
      let architectureId: string | undefined;
      if (!MOCK && liveTargets.includes("aws")) {
        const response = await fetch(`${API}/api/projects/${id}/architecture-plans/latest`, { cache: "no-store" });
        if (!response.ok) throw new Error(t("project.planCheckError"));
        const plan = await response.json();
        if (plan?.selected_template) architectureId = plan.id;
      }
      const deploymentOptions = Object.fromEntries(Object.entries(opts).filter(([name]) => liveTargets.includes(name as TargetName)).map(([name, value]) => [name, name === "aws" && architectureId ? { sticky_sessions: false, tz: value.tz } : value]));
      const d = await api.deploy(id, { architecture_plan_id: architectureId, shakedown: MOCK ? shakedown : liveTargets.length >= 2 || !!comparisonUrl.trim(), autofix: false, options: MOCK ? opts : deploymentOptions, targets: MOCK ? undefined : liveTargets, comparison: !MOCK && liveTargets.length === 1 && comparisonUrl.trim() ? { name: "candidate", url: comparisonUrl.trim() } : undefined, lang });
      router.push(`/deployments/${d.id}`);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? t("home.busy", { name: project?.name ?? id }) : errorMessage(e));
      setBusy(false);
    }
  }

  async function compareExisting() {
    setBusy(true); setError(null);
    try {
      const d = await api.compare(id, { baseline: { name: "local", url: baselineUrl.trim() }, candidate: { name: "candidate", url: comparisonUrl.trim() }, lang });
      router.push(`/deployments/${d.id}`);
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }

  if (!project) return <p className="muted">{error ?? t("loading")}</p>;
  const a = project.analysis;
  const targets = MOCK ? project.targets ?? DEFAULT_TARGETS : liveTargets;
  const baseline = targets[0];
  const optsFor = (name: string): TargetOptions => opts[name] ?? DEFAULT_TARGET_OPTIONS;
  const setOpt = (name: string, patchOpt: Partial<TargetOptions>) =>
    setOpts((cur) => ({ ...cur, [name]: { ...optsFor(name), ...patchOpt } }));
  const shakedownOn = MOCK ? shakedown : liveTargets.length >= 2 || !!comparisonUrl.trim();
  const repoShort = project.repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");

  return (
    <>
      <Breadcrumb parent={t("nav.newAction")} parentHref="/" current={project.name} />
      {error && <Alert onClose={() => setError(null)}>{error}</Alert>}

      <div className="configure-grid">
        <div className="repository-strip">
          <BsGithub size={29} />
          <strong>{project.name}</strong>
          <span className="branch"><BsBoxSeam size={15} />{repoShort}</span>
        </div>
        <ConnectionStrip />

        <section className="configuration-card" aria-label={t("bc.config")}>
          <div className="project-fields">
            <div className="field-row"><label htmlFor="p-name">{t("cfg.name")}</label><input id="p-name" value={project.name} readOnly /></div>
            <div className="field-row framework-row">
              <label htmlFor="p-stack">{t("cfg.stack")}</label>
              <div>
                <div className="read-only-select"><input id="p-stack" value={[a.stack, a.database].filter(Boolean).join(" · ") || "—"} readOnly /><BsChevronDown size={12} /></div>
                {a.summary && <p className="hint"><AiTag /> {a.summary}</p>}
              </div>
            </div>
            <div className="field-row">
              <label htmlFor="p-port">{t("cfg.port")}</label>
              <div className="command-field">
                <input id="p-port" className="mono" value={String(project.runtime?.port ?? a.port)} readOnly />
                <span className="automatic"><BsShieldCheck size={13} />{t("cfg.detected")}</span>
              </div>
            </div>
            <div className="field-row"><label htmlFor="p-health">{t("cfg.health")}</label><input id="p-health" className="mono" value={project.runtime?.health_path ?? a.health_path} readOnly /></div>
            {!MOCK && liveTargets.length === 1 && (
              <div className="field-row framework-row">
                <label htmlFor="p-comparison">{t("live.candidate")}</label>
                <div>
                  <input id="p-comparison" type="url" value={comparisonUrl} onChange={(e) => setComparisonUrl(e.target.value)} placeholder="https://comparison.example.com" />
                  <p className="hint">{t("live.compareHint")}</p>
                </div>
              </div>
            )}
          </div>

          <div className="config-section targets-section">
            <h2>{t("project.targets")}</h2>
            <div className="targets">
              {TARGETS.map((tg) => {
                const on = targets.includes(tg.id);
                const isBaseline = on && tg.id === baseline;
                const o = optsFor(tg.id);
                return (
                  <div key={tg.id}>
                    <label className={`target-row ${tg.available ? "" : "unavailable"}`}>
                      <input
                        type="checkbox"
                        disabled={MOCK || !tg.available}
                        checked={on}
                        onChange={(e) => {
                          setLiveTargets((current) => e.target.checked ? pickTarget(current, tg.id) : current.filter((x) => x !== tg.id));
                          setOpts({});
                        }}
                      />
                      <ProviderIcon id={tg.id} />
                      <span>
                        {tg.label}
                        {isBaseline && <span className="tag row-tag">{t("cfg.baseline")}</span>}
                        {project.ports?.[tg.id] ? <span className="row-meta">{t("project.port")} {project.ports[tg.id]}</span> : null}
                      </span>
                      <span className="target-state">
                        <i className={`connection-dot ${tg.available ? "connected" : ""}`} />
                        {tg.available ? t("cfg.available") : t("home.soon")}
                      </span>
                    </label>
                    {on && !isBaseline && (
                      <div className="target-options">
                        <div>
                          <span>{t("project.instances")}</span>
                          <select value={o.replicas} onChange={(e) => setOpt(tg.id, { replicas: Number(e.target.value) })}>
                            {(MOCK ? [1, 2, 3] : [1, 2]).map((n) => <option key={n}>{n}</option>)}
                          </select>
                        </div>
                        <div>
                          <span>{t("project.affinity")}</span>
                          <Toggle label={t("project.affinity")} checked={o.sticky_sessions} disabled={!MOCK && !tg.sticky} onChange={() => setOpt(tg.id, { sticky_sessions: !o.sticky_sessions })} />
                        </div>
                        <div>
                          <span>{t("project.timezone")}</span>
                          <select value={o.tz} onChange={(e) => setOpt(tg.id, { tz: e.target.value })}>
                            {TIMEZONES.map((tz) => <option key={tz}>{tz}</option>)}
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="inline-note"><BsInfoCircle /><span>{MOCK ? t("home.targetsHint") : t("live.scope")}</span></div>
          </div>

          <details className="config-section environment-section" open>
            <summary>
              <BsChevronDown size={14} />
              <h2>{t("project.detected")}</h2>
              <span className="tag">{t("project.hiddenFromAi")}</span>
            </summary>
            <div className="environment-table">
              <div className="environment-head"><span>{t("cfg.key")}</span><span>{t("cfg.value")}</span></div>
              {/* Route rows live in the routes list below; identical field/value pairs from several files show once. */}
              {a.evidence.filter((e, i, all) => e.field !== "routes" && all.findIndex((x) => x.field === e.field && x.value === e.value) === i).map((e) => (
                <div className="environment-row" key={`${e.field}|${e.value}`}>
                  <code>{e.field}</code>
                  <div className="environment-value">
                    <span title={e.file ?? undefined}>{e.value}</span>
                    {e.source === "ai" ? <AiTag /> : <span className="tag">{t(e.source === "default" ? "tag.default" : "tag.rule")}</span>}
                  </div>
                </div>
              ))}
              {project.secrets.map((s) => (
                <div className="environment-row" key={s.name}>
                  <code>{s.name}</code>
                  <div className="environment-value"><span className="mono">{s.value}</span><span className="tag">{t("project.hiddenFromAi")}</span></div>
                </div>
              ))}
              {a.warnings.map((w) => <p className="hint" key={w}>⚠ {w}</p>)}
            </div>
            <details className="routes">
              <summary className="text-link"><BsInfoCircle size={13} />{t("project.routes", { n: a.routes.length })}</summary>
              <ul className="route-list">
                {a.routes.map((r) => (
                  <li key={r.method + r.path}><span>{r.method}</span>{r.path}{r.params.length > 0 && <span className="muted"> ({r.params.join(", ")})</span>}</li>
                ))}
              </ul>
            </details>
          </details>

          <div className="shakedown-footer">
            <Toggle label={t("project.shakedown")} checked={shakedownOn} disabled={!MOCK} onChange={() => setShakedown((s) => !s)} />
            <strong>{t("project.shakedown")}</strong>
            <span>{t("project.shakedownDesc")}</span>
            <Link href="#deployments" className="text-link">{t("project.deployments")}<BsChevronRight size={12} /></Link>
          </div>
        </section>

        <aside className="estimate-column">
          <section className="estimate-card">
            <h2>{t("est.title")}</h2>
            <dl>
              <div><dt>{t("est.env")}</dt><dd>{orderTargets(targets).map(targetLabel).join(" + ") || "—"}</dd></div>
              <div><dt>{t("est.shakedown")}</dt><dd>{shakedownOn ? t("est.steps") : t("est.deployOnly")}</dd></div>
              <div><dt>{t("est.ai")}</dt><dd>{t("est.aiNone")}<br /><span className="muted">{t("est.analysisCost", { krw: project.analysis_cost.krw, n: project.analysis_cost.calls })}</span></dd></div>
            </dl>
            <div className="estimate-note"><BsInfoCircle size={15} /><p>{t("est.note")}</p></div>
            <div className="estimate-bottom">
              <span><BsShieldCheck size={15} />{t("project.autofix")}</span>
              <p>{t("project.autofixDesc")}</p>
            </div>
          </section>
          <button type="button" className="button primary deploy-button" onClick={deploy} disabled={busy || (!MOCK && liveTargets.length === 0)}>
            {busy ? <><span className="spinner" />{t("project.starting")}</> : <>{t("action")}<BsArrowRight size={17} /></>}
          </button>
        </aside>
      </div>

      <div className="stack">
        {!MOCK && (
          <Section title={t("live.compareTitle")}>
            <div className="project-fields compact">
              <div className="field-row"><label htmlFor="c-baseline">{t("live.baseline")}</label><input id="c-baseline" type="url" value={baselineUrl} onChange={(e) => setBaselineUrl(e.target.value)} placeholder="http://127.0.0.1:18080" /></div>
              <div className="field-row"><label htmlFor="c-candidate">{t("live.candidate")}</label><input id="c-candidate" type="url" value={comparisonUrl} onChange={(e) => setComparisonUrl(e.target.value)} placeholder="https://comparison.example.com" /></div>
            </div>
            <p className="hint" style={{ marginBottom: 14 }}>{t("live.externalHint")}</p>
            <button type="button" className="button primary" disabled={busy || !baselineUrl.trim() || !comparisonUrl.trim()} onClick={compareExisting}>{t("live.compareNow")}</button>
          </Section>
        )}
        <RuntimeSettings key={id} project={project} onSaved={setProject} />
        <p className="hint">{t("project.awsPlanNote")}</p>
        <ArchitecturePlanner key={id + JSON.stringify(project.runtime)} projectId={id} />
        <ImageBuilder projectId={id} />
        <HttpsSettings projectId={id} />

        <Section id="deployments" title={t("project.deployments")} flush>
          <div className="table-scroll">
          <table className="deploy-table">
            <thead>
              <tr><th>{t("hist.project")}</th><th>{t("hist.targets")}</th><th>{t("hist.result")}</th><th>{t("hist.ai")}</th><th>{t("hist.time")}</th><th><span className="sr-only">{t("hist.detail")}</span></th></tr>
            </thead>
            <tbody>
              {deps.map((d) => {
                const fixed = d.attempts.find((x) => x.applied_fix);
                return (
                  <tr key={d.id}>
                    <td>
                      <Link href={`/deployments/${d.id}`} className="table-link">
                        <BsBoxSeam size={19} />
                        <span><strong className="mono">{d.id}</strong><small>{t("project.shakedowns", { n: d.attempts.length })}{fixed?.applied_fix && ` · ${t("project.autofixed", { x: fixed.applied_fix.option })}`}</small></span>
                      </Link>
                    </td>
                    <td>{orderTargets(Object.keys(d.targets)).map(targetLabel).join(" + ")}</td>
                    <td><Badge status={d.status} /></td>
                    <td>AI ₩{d.ai_cost.krw}</td>
                    <td className="mono">{d.timings.total_s != null ? formatSeconds(d.timings.total_s) : "—"}<small>{t.ago(d.created)}</small></td>
                    <td><Link className="icon-button" href={`/deployments/${d.id}`} aria-label={t("hist.detail")}><BsChevronRight /></Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          {deps.length === 0 && <div className="table-empty">{t("project.noDeployments")}</div>}
        </Section>
      </div>
    </>
  );
}
