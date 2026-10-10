"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BsArrowRight, BsBoxSeam, BsChevronDown, BsChevronRight, BsGithub, BsInfoCircle, BsShieldCheck } from "react-icons/bs";
import { useLang, useT } from "@/components/i18n";
import { ProviderIcon } from "@/components/provider-icon";
import { Alert, Badge, Breadcrumb, ConnectionStrip, Elapsed, PageHeading, Stat, Toggle } from "@/components/ui";
import { api, ApiError, DONE, errorMessage, formatSeconds, MOCK, type Deployment, type Project, type TargetName } from "@/lib/api";
import { DEFAULT_TARGETS, orderTargets, pickTarget, TARGETS, targetLabel } from "@/lib/targets";

/** Cheap change check for one poll: did anything the table shows move? */
const progressKey = (d: Deployment) =>
  `${d.status}|${Object.values(d.targets).map((x) => x.status).join(",")}|${d.attempts.map((a) => a.steps?.length ?? 0).join(",")}`;

export default function Home() {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const [comparisonUrl, setComparisonUrl] = useState("");
  const [repo, setRepo] = useState("");
  const [targets, setTargets] = useState<TargetName[]>(MOCK ? DEFAULT_TARGETS : ["local"]);
  // Both lists come from the engine (GET /api/projects, GET /api/deployments), so every tab sees the same history.
  const [projects, setProjects] = useState<Project[]>([]);
  const [actions, setActions] = useState<Deployment[]>([]);
  const [pending, setPending] = useState(0);
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // Merge a fresh list into the current one; rows that did not move keep their identity so finished rows don't re-render.
  const mergeActions = (fresh: Deployment[]) =>
    setActions((cur) => {
      const byId = new Map(cur.map((d) => [d.id, d]));
      return fresh.map((d) => {
        const old = byId.get(d.id);
        return old && progressKey(old) === progressKey(d) ? old : d;
      });
    });

  useEffect(() => {
    let alive = true;
    api.projects().then((list) => { if (alive) setProjects(list); }).catch(() => {});
    api.allDeployments().then((list) => { if (alive) mergeActions(list); }).catch(() => {});
    // Engine-side history: refresh every few seconds while anything is still running, else every 15 s.
    const timer = setInterval(() => {
      const running = actionsRef.current.some((d) => !DONE.has(d.status));
      if (!running && Date.now() % 15000 > 3000) return;
      api.allDeployments().then((list) => { if (alive) mergeActions(list); }).catch(() => {});
    }, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const names = new Map(projects.map((p) => [p.id, p.name]));

  async function prepareImage() {
    if (!repo.trim()) { setError(t("home.needRepo")); return; }
    setPending((n) => n + 1); setError(null);
    try {
      const project = await api.createProject({ repo: repo.trim(), image_only: true, targets: targets.length ? targets : ["local"] });
      router.push(`/projects/${project.id}#image-builder`);
    } catch (e) { setError(errorMessage(e)); }
    finally { setPending((n) => n - 1); }
  }

  // One Action: register (or reuse) the repo and start the deployment in a single click.
  async function runAction(e: React.FormEvent) {
    e.preventDefault();
    if (targets.length < (MOCK ? 2 : 1)) {
      setError(t(MOCK ? "home.needTwo" : "live.needLocal"));
      return;
    }
    setError(null);
    setPending((n) => n + 1);
    setFlash(true);
    setTimeout(() => setFlash(false), 900);
    let name = repo;
    try {
      const project = await api.createProject({ repo: repo.trim(), targets });
      name = project.name;
      setProjects((cur) => (cur.some((p) => p.id === project.id) ? cur : [project, ...cur]));
      const deployment = await api.deploy(project.id, { shakedown: MOCK || targets.length >= 2 || !!comparisonUrl.trim(), autofix: MOCK, options: {}, targets, comparison: !MOCK && targets.length === 1 && comparisonUrl.trim() ? { name: "candidate", url: comparisonUrl.trim() } : undefined, lang });
      setActions((cur) => [deployment, ...cur.filter((d) => d.id !== deployment.id)]);
    } catch (err) {
      // The engine owns the "one running deployment per project" rule and answers 409.
      setError(err instanceof ApiError && err.status === 409 ? t("home.busy", { name }) : errorMessage(err));
    } finally {
      setPending((n) => n - 1);
    }
  }

  const shakedownOn = MOCK || targets.length >= 2 || !!comparisonUrl.trim();
  const counts = {
    passed: actions.filter((d) => d.status === "promoted").length,
    blocked: actions.filter((d) => d.status === "blocked").length,
    running: actions.filter((d) => !DONE.has(d.status)).length,
  };

  return (
    <>
      <Breadcrumb parent={t("nav.newAction")} current={t("bc.config")} />
      {MOCK && <Alert>{t("mock")}</Alert>}
      {error && <Alert onClose={() => setError(null)}>{error}</Alert>}

      <form onSubmit={runAction} className="configure-grid">
        <label className="repository-strip">
          <BsGithub size={29} />
          <input className="strip-input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={t("home.placeholder")} aria-label={t("home.placeholder")} required />
        </label>
        <ConnectionStrip />

        <section className="configuration-card" aria-label={t("bc.config")}>
          <div className="project-fields">
            <div className="field-row framework-row">
              <label htmlFor="home-stack">{t("cfg.stack")}</label>
              <div>
                <div className="read-only-select"><input id="home-stack" value={t("cfg.autoDetect")} readOnly /><BsChevronDown size={12} /></div>
                <p className="hint">{t(MOCK ? "home.lead" : "live.lead")}</p>
              </div>
            </div>
            {!MOCK && targets.length === 1 && (
              <div className="field-row framework-row">
                <label htmlFor="home-comparison">{t("live.candidate")}</label>
                <div>
                  <input id="home-comparison" type="url" value={comparisonUrl} onChange={(e) => setComparisonUrl(e.target.value)} placeholder="https://comparison.example.com" />
                  <p className="hint">{t("live.compareHint")} {t("live.externalHint")}</p>
                </div>
              </div>
            )}
            <div className="field-row">
              <label htmlFor="home-shakedown">{t("est.shakedown")}</label>
              <div className="command-field">
                <input id="home-shakedown" readOnly value={shakedownOn ? t("est.steps") : t("est.deployOnly")} />
                <span className="automatic"><BsShieldCheck size={13} />{t("cfg.detected")}</span>
              </div>
            </div>
          </div>

          <div className="config-section targets-section">
            <h2>{t("home.targets")}</h2>
            <div className="targets">
              {TARGETS.map((tg) => {
                const on = targets.includes(tg.id);
                return (
                  <label key={tg.id} className={`target-row ${tg.available ? "" : "unavailable"}`}>
                    <input
                      type="checkbox"
                      disabled={!tg.available}
                      checked={on}
                      onChange={() =>
                        setTargets((cur) =>
                          on ? cur.filter((x) => x !== tg.id)
                            : MOCK ? TARGETS.map((x) => x.id).filter((id) => id === tg.id || cur.includes(id)) : pickTarget(cur, tg.id),
                        )
                      }
                    />
                    <ProviderIcon id={tg.id} />
                    <span>{tg.label}{on && tg.id === targets[0] && <span className="tag row-tag">{t("cfg.baseline")}</span>}</span>
                    <span className="target-state">
                      <i className={`connection-dot ${tg.available ? "connected" : ""}`} />
                      {tg.available ? t("cfg.available") : t("home.soon")}
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="inline-note"><BsInfoCircle /><span>{MOCK ? t("home.targetsHint") : t("live.scope")}</span></div>
          </div>

          <div className="shakedown-footer">
            <Toggle label={t("cfg.autoRun")} checked={shakedownOn} disabled onChange={() => {}} />
            <strong>{t("cfg.autoRun")}</strong>
            <span>{t("cfg.autoRunMeta")}</span>
            {!MOCK && (
              <button type="button" className="text-link" disabled={pending > 0} onClick={() => void prepareImage()}>
                {t("cfg.imageOnly")}<BsChevronRight size={12} />
              </button>
            )}
          </div>
        </section>

        <aside className="estimate-column">
          <section className="estimate-card">
            <h2>{t("est.title")}</h2>
            <dl>
              <div><dt>{t("est.env")}</dt><dd>{targets.length ? orderTargets(targets).map(targetLabel).join(" + ") : "—"}</dd></div>
              <div><dt>{t("est.shakedown")}</dt><dd>{shakedownOn ? t("est.steps") : t("est.deployOnly")}</dd></div>
              <div><dt>{t("est.ai")}</dt><dd>{t("est.aiNone")}<br /><span className="muted">{t("est.aiHint")}</span></dd></div>
            </dl>
            <div className="estimate-note"><BsInfoCircle size={15} /><p>{t("est.note")}</p></div>
            <div className="estimate-bottom">
              <span><BsShieldCheck size={15} />{t("est.gate")}</span>
              <p>{t("est.gateDesc")}</p>
            </div>
          </section>
          <button className="button primary deploy-button" disabled={pending > 0}>
            {pending > 0 ? <><span className="spinner" />{t("project.starting")}</> : flash ? `✓ ${t("home.accepted")}` : <>{t("action")}<BsArrowRight size={17} /></>}
          </button>
        </aside>
      </form>

      <PageHeading id="projects" title={t("proj.title")} lead={t("proj.lead")} />
      <ProjectTable rows={projects} />

      <PageHeading id="actions" title={t("home.actions")} lead={t("hist.lead")} />
      <div className="stats">
        <Stat label={t("stat.total")} value={actions.length} />
        <Stat label={t("stat.passed")} value={counts.passed} />
        <Stat label={t("stat.blocked")} value={counts.blocked} />
        <Stat label={t("stat.running")} value={counts.running} />
      </div>
      <ActionTable rows={actions} names={names} />
    </>
  );
}

function ProjectTable({ rows }: { rows: Project[] }) {
  const t = useT();
  return (
    <div className="table-wrap">
      <table className="run-table deploy-table">
        <thead>
          <tr>
            <th>{t("proj.name")}</th>
            <th>{t("hist.targets")}</th>
            <th>{t("proj.last")}</th>
            <th>{t("proj.added")}</th>
            <th><span className="sr-only">{t("proj.open")}</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const last = p.last_deployment;
            return (
              <tr key={p.id}>
                <td>
                  <Link className="table-link" href={`/projects/${p.id}`}>
                    <BsGithub size={19} />
                    <span><strong>{p.name}</strong><small className="mono">{p.repo.replace(/^https:\/\/github\.com\//, "")}</small></span>
                  </Link>
                </td>
                <td>{orderTargets(p.targets ?? ["local"]).map(targetLabel).join(" + ")}<small>{p.analysis.stack}{p.analysis.database ? ` · ${p.analysis.database}` : ""}</small></td>
                <td>{last ? <><Badge status={last.status} /><small className="mono">{last.id}</small></> : <span className="muted">—</span>}</td>
                <td>{t.ago(p.created)}<small className="mono">{p.id}</small></td>
                <td><Link className="icon-button" href={`/projects/${p.id}`} aria-label={t("proj.open")}><BsChevronRight /></Link></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && <div className="table-empty">{t("proj.none")}</div>}
    </div>
  );
}

function ActionTable({ rows, names }: { rows: Deployment[]; names: Map<string, string> }) {
  const t = useT();
  return (
    <div className="table-wrap">
      <table className="run-table deploy-table">
        <thead>
          <tr>
            <th>{t("hist.project")}</th>
            <th>{t("hist.targets")}</th>
            <th>{t("hist.result")}</th>
            <th>{t("hist.ai")}</th>
            <th>{t("hist.time")}</th>
            <th><span className="sr-only">{t("hist.detail")}</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const done = DONE.has(d.status);
            const targetNames = orderTargets(Object.keys(d.targets));
            const verdict = d.attempts.at(-1)?.verdict;
            return (
              <tr key={d.id}>
                <td>
                  <Link className="table-link" href={`/deployments/${d.id}`}>
                    <BsBoxSeam size={19} />
                    <span><strong>{names.get(d.project_id) ?? d.project_id}</strong><small className="mono">{d.id}</small></span>
                  </Link>
                </td>
                <td>{targetNames.map(targetLabel).join(" + ")}<small>{d.shakedown ? t("est.steps") : t("est.deployOnly")}</small></td>
                <td><Badge status={d.status} /><small>{done ? verdict?.summary ?? "" : t.maybe(`stage.${d.status}`, "")}</small></td>
                <td>{t("dep.calls", { n: d.ai_cost.calls })}<small>₩{d.ai_cost.krw}</small></td>
                <td className="mono">
                  {done && d.timings.total_s != null ? formatSeconds(d.timings.total_s) : <Elapsed created={d.created} />}
                  <small>{t.ago(d.created)}</small>
                </td>
                <td><Link className="icon-button" href={`/deployments/${d.id}`} aria-label={t("hist.detail")}><BsChevronRight /></Link></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && <div className="table-empty">{t("home.noActions")}</div>}
    </div>
  );
}
