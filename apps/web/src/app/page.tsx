"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLang, useT } from "@/components/i18n";
import { ActionCard } from "@/components/action-card";
import { api, ApiError, DONE, errorMessage, MOCK, type Deployment, type TargetName } from "@/lib/api";
import { DEFAULT_TARGETS, pickTarget, TARGETS } from "@/lib/targets";

type ActionRow = { deployment: Deployment; projectName: string };
type SavedRow = { id: string; projectName: string };

/** Cheap change check for one poll: did anything the card shows move? */
const progressKey = (d: Deployment) =>
  `${d.status}|${Object.values(d.targets).map((x) => x.status).join(",")}|${d.attempts.map((a) => a.steps?.length ?? 0).join(",")}`;

export default function Home() {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const [comparisonUrl, setComparisonUrl] = useState("");
  const [repo, setRepo] = useState("");
  const [targets, setTargets] = useState<TargetName[]>(MOCK ? DEFAULT_TARGETS : ["local"]);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [pending, setPending] = useState(0);
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // Keep the list across page changes in this tab: only ids are stored, the engine has the rest.
  useEffect(() => {
    let saved: SavedRow[] = [];
    try {
      saved = JSON.parse(sessionStorage.getItem("actions") ?? "[]");
    } catch {}
    if (!saved.length) return;
    Promise.all(saved.map((r) => api.deployment(r.id).then((deployment) => ({ deployment, projectName: r.projectName }))
      .catch(() => null)))
      .then((rows) => setActions(rows.filter((r): r is ActionRow => r !== null)));
  }, []);
  const savedKey = actions.map((a) => a.deployment.id).join(",");
  useEffect(() => {
    try {
      const rows: SavedRow[] = actionsRef.current.slice(0, 30).map((a) => ({ id: a.deployment.id, projectName: a.projectName }));
      sessionStorage.setItem("actions", JSON.stringify(rows));
    } catch {}
  }, [savedKey]);

  // Refresh actions that haven't reached a verdict yet; untouched rows keep their identity,
  // so finished cards don't re-render.
  useEffect(() => {
    const timer = setInterval(async () => {
      const running = actionsRef.current.filter((a) => !DONE.has(a.deployment.status));
      if (running.length === 0) return;
      const fresh = await Promise.all(running.map((a) => api.deployment(a.deployment.id).catch(() => a.deployment)));
      const byId = new Map(fresh.map((d) => [d.id, d]));
      setActions((cur) => cur.map((a) => {
        const next = byId.get(a.deployment.id);
        return next && progressKey(next) !== progressKey(a.deployment) ? { ...a, deployment: next } : a;
      }));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  async function prepareImage() {
    if (!repo.trim()) { setError("레포 URL 또는 로컬 앱 경로를 입력하세요."); return; }
    setPending((n) => n + 1); setError(null);
    try {
      const project = await api.createProject({repo: repo.trim(), image_only: true, targets: targets.length ? targets : ["local"]});
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
      const deployment = await api.deploy(project.id, { shakedown: MOCK || targets.length >= 2 || !!comparisonUrl.trim(), autofix: MOCK, options: {}, targets, comparison: !MOCK && targets.length === 1 && comparisonUrl.trim() ? {name:"candidate", url:comparisonUrl.trim()} : undefined, lang });
      setActions((cur) => [{ deployment, projectName: project.name }, ...cur]);
    } catch (err) {
      // The engine owns the "one running deployment per project" rule and answers 409.
      setError(err instanceof ApiError && err.status === 409 ? t("home.busy", { name }) : errorMessage(err));
    } finally {
      setPending((n) => n - 1);
    }
  }

  return (
    <div className="space-y-8">
      <section className="pt-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-ai">{t("home.eyebrow")}</p>
        <h1 className="mt-2 text-4xl font-bold tracking-tight">{t("home.title")}</h1>
        <p className="mt-4 text-base text-muted max-w-3xl leading-relaxed">{t(MOCK ? "home.lead" : "live.lead")}</p>
        {MOCK && <p className="mt-3 text-xs text-warn">● {t("mock")}</p>}
        {MOCK && <ol className="mt-8 grid gap-3 sm:grid-cols-4">
          {([1, 2, 3, 4] as const).map((n) => (
            <li key={n} className="card p-4 relative">
              <span className={`flex size-7 items-center justify-center rounded-full text-sm font-bold ${
                n === 3 ? "bg-ai/20 text-ai" : n === 4 ? "bg-ok/15 text-ok" : "bg-accent/15 text-accent"}`}>
                {n}
              </span>
              <span className="mt-3 block font-semibold">{t(`home.step${n}`)}</span>
              <span className="mt-1 block text-xs text-muted">{t(`home.step${n}d`)}</span>
              {n < 4 && (
                <span className="hidden sm:block absolute -right-2.5 top-1/2 -translate-y-1/2 z-10 text-muted">›</span>
              )}
            </li>
          ))}
        </ol>}
      </section>

      <form onSubmit={runAction} className="card p-5 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder={t("home.placeholder")}
            className="flex-1 rounded-lg border border-line bg-bg px-3 py-3 font-mono text-sm outline-none focus:border-accent"
            required
          />
          <button
            className={`relative rounded-lg px-8 py-3 text-base font-bold tracking-wide text-white transition-all active:scale-95 ${
              flash ? "bg-ok" : "bg-accent hover:brightness-110"}`}
          >
            {flash ? `✓ ${t("home.accepted")}` : t("action")}
            {pending > 0 && (
              <span className="absolute -right-2 -top-2 flex size-5 items-center justify-center rounded-full bg-ai text-[11px] text-bg">
                {pending}
              </span>
            )}
          </button>
        </div>
        {!MOCK && <button type="button" disabled={pending > 0} onClick={() => void prepareImage()} className="rounded-lg border border-accent px-4 py-2 text-sm text-accent disabled:opacity-50">배포 없이 이미지 먼저 만들기</button>}
        {!MOCK && targets.length === 1 && <label className="block text-sm">{t("live.candidate")}<input type="url" value={comparisonUrl} onChange={(e) => setComparisonUrl(e.target.value)} placeholder="https://comparison.example.com" className="mt-2 w-full rounded-lg border border-line bg-bg p-3" /><span className="text-xs text-muted">{t("live.compareHint")} {t("live.externalHint")}</span></label>}
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-wide text-muted">{t("home.targets")}</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {TARGETS.map((tg) => {
              const on = targets.includes(tg.id);
              return (
                <button
                  key={tg.id}
                  type="button"
                  disabled={!tg.available}
                  aria-pressed={on}
                  onClick={() =>
                    setTargets((cur) =>
                      on ? cur.filter((x) => x !== tg.id)
                        : pickTarget(cur, tg.id),
                    )
                  }
                  className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
                    !tg.available ? "border-line text-muted/60 cursor-not-allowed"
                      : on ? "border-accent bg-accent/15 text-accent" : "border-line text-muted hover:text-text"}`}
                >
                  <span className={`size-2 rounded-full ${on ? "bg-accent" : "bg-line"}`} />
                  {tg.label}
                  {!tg.available && <span className="text-[10px] uppercase">{t("home.soon")}</span>}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted">{MOCK ? t("home.targetsHint") : t("live.scope")}</p>
        </fieldset>
      </form>
      {error && <p className="text-sm text-bad">{error}</p>}

      <div className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{t("home.actions")}</h2>
        {actions.length === 0 && <p className="text-muted text-sm">{t("home.noActions")}</p>}
        <div className="space-y-3">
          {actions.map(({ deployment, projectName }) => (
            <ActionCard key={deployment.id} deployment={deployment} projectName={projectName} />
          ))}
        </div>
      </div>
    </div>
  );
}
