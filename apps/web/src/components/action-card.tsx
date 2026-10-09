"use client";

import Link from "next/link";
import { memo, useEffect, useState, type ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Badge, Spinner } from "@/components/ui";
import { DONE, formatSeconds, type Deployment } from "@/lib/api";
import { resultsFor } from "@/lib/steps";
import { orderTargets, targetLabel } from "@/lib/targets";

type State = "pending" | "running" | "passed" | "failed";

/** Running clock. Only this element re-renders every tick, not the whole card. */
function Elapsed({ created }: { created: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  return <>{formatSeconds(Math.max(0, now / 1000 - created))}</>;
}

const STATE_STYLE: Record<State, string> = {
  pending: "border-line text-muted",
  running: "border-accent/70 bg-accent/5",
  passed: "border-ok/50 bg-ok/5",
  failed: "border-bad/60 bg-bad/5",
};

function StateIcon({ state }: { state: State }) {
  if (state === "running") return <Spinner className="size-3.5 text-accent" />;
  if (state === "passed") return <span className="text-ok font-bold">✓</span>;
  if (state === "failed") return <span className="text-bad font-bold">✕</span>;
  return <span className="inline-block size-2.5 rounded-full border border-current opacity-60" />;
}

/** One action box inside a stage, like a CodePipeline action. */
function Box({ title, state, sub }: { title: string; state: State; sub?: ReactNode }) {
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${STATE_STYLE[state]}`}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <StateIcon state={state} />
        <span className="truncate">{title}</span>
      </div>
      {sub != null && <div className="mt-1 truncate text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function Stage({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{name}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

const Arrow = () => <div className="flex items-center self-stretch pt-6 text-muted" aria-hidden>→</div>;

/** Shakedown results for one target across the latest attempt. */
function targetShakedown(d: Deployment, names: string[], name: string, baseline: string): { state: State; passed: number; total: number } {
  const attempt = d.attempts.at(-1);
  const total = d.scenario?.steps.length ?? 0;
  if (!attempt?.steps?.length) {
    return { state: d.status === "shakedown" ? "running" : "pending", passed: 0, total };
  }
  const results = resultsFor(attempt.steps, names, baseline, name);
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.some((r) => r.status === "failed");
  // With several clouds, a target is done once all its rows are in, even before the overall verdict.
  const finished = attempt.verdict != null || (total > 0 && results.length >= total);
  return { state: failed ? "failed" : finished ? "passed" : "running", passed, total };
}

export const ActionCard = memo(function ActionCard({ deployment: d, projectName }: {
  deployment: Deployment; projectName: string;
}) {
  const t = useT();
  const done = DONE.has(d.status);
  const names = orderTargets(Object.keys(d.targets));
  const baseline = d.attempts.at(-1)?.steps?.[0]?.baseline ?? names[0];
  const built = d.timings.build_s != null;
  const verdict = done ? d.attempts.at(-1)?.verdict : undefined;
  const fixed = d.attempts.find((a) => a.applied_fix)?.applied_fix;

  const buildState: State = built ? "passed" : d.status === "building" ? "running" : d.status === "failed" ? "failed" : "pending";
  const verdictState: State = ["deployed", "warned"].includes(d.status) ? "pending" : done ? (d.status === "promoted" ? "passed" : "failed")
    : ["analyzing", "fixing"].includes(d.status) ? "running" : "pending";

  return (
    <Link href={`/deployments/${d.id}`} className="card block p-5 hover:border-accent transition-colors">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold truncate">{projectName}</div>
          <div className="text-xs text-muted font-mono">{d.id}</div>
        </div>
        <div className="flex items-center gap-4">
          <span className="rounded-md border border-line px-2.5 py-1 text-xs text-accent">{t("home.details")}</span>
          <Badge status={d.status} />
          <div className="text-right">
            <div className="font-mono text-lg font-semibold tabular-nums">
              {done && d.timings.total_s != null ? formatSeconds(d.timings.total_s) : <Elapsed created={d.created} />}
            </div>
            <div className="text-[11px] text-muted">{done ? t("home.total") : t("home.elapsed")}</div>
          </div>
        </div>
      </div>

      <div className="mt-5 overflow-x-auto">
        <div className="flex min-w-[760px] items-start gap-3">
          {d.mode !== "comparison" && <><Stage name={t("pipe.source")}>
            <Box title={projectName} state="passed" sub="GitHub" />
          </Stage>
          <Arrow />
          <Stage name={t("stage.building")}>
            <Box title={t("pipe.image")} state={buildState} sub={built ? formatSeconds(d.timings.build_s!) : undefined} />
          </Stage>
          <Arrow />
          </>}<Stage name={d.mode === "comparison" ? t("live.compareTitle") : t("stage.deploying")}>
            {names.map((name) => {
              const s = d.targets[name].status;
              const state: State = s === "ready" ? "passed" : s === "deploying" ? "running" : (s === "failed" || s === "stopped") ? "failed" : "pending";
              const url = d.targets[name].url;
              const sub = s === "deploying" && fixed?.target === name ? t("pipe.redeploy", { fix: fixed.option })
                : s === "stopped" ? t("status.stopped") : (s === "ready" || s === "external") && url ? url.replace(/^https?:\/\//, "") : undefined;
              return <Box key={name} title={targetLabel(name)} state={state} sub={sub} />;
            })}
          </Stage>
          <Arrow />
          <Stage name={t("stage.shakedown")}>
            {names.map((name) => {
              const r = targetShakedown(d, names, name, baseline);
              const sub = !d.shakedown ? t("dep.notRun") : r.total ? t("pipe.steps", { passed: r.passed, total: r.total }) : undefined;
              return <Box key={name} title={targetLabel(name)} state={r.state} sub={sub} />;
            })}
          </Stage>
          <Arrow />
          <Stage name={t("stage.verdict")}>
            <Box
              title={done ? t.maybe(`status.${d.status}`, d.status) : t("stage.verdict")}
              state={verdictState}
              sub={verdict?.summary ?? (fixed && !done ? t("pipe.autofix", { fix: fixed.option }) : undefined)}
            />
          </Stage>
        </div>
      </div>
    </Link>
  );
});
