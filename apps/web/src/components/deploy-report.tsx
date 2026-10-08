"use client";

import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { AiTag, Badge, Mono, RuleTag, Section } from "@/components/ui";
import { DONE, formatSeconds, type Deployment, type StepResult } from "@/lib/api";
import { orderTargets, targetLabel } from "@/lib/targets";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 py-2 border-t border-line first:border-0 text-sm">
      <div className="text-muted">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Steps one target passed in an attempt (baseline results sit in `local`, the compared target in `cloud`). */
function passedSteps(d: Deployment, attemptIndex: number, name: string, baseline: string) {
  const steps = d.attempts[attemptIndex]?.steps ?? [];
  const side = (row: (typeof steps)[number]): StepResult => ((row.baseline ?? baseline) === name ? row.local : row.cloud);
  return { passed: steps.filter((row) => side(row).status === "passed").length, total: d.scenario?.steps.length ?? steps.length };
}

/**
 * One-screen summary of a finished deployment: what happened, how long it took, what was
 * found and fixed, and what the AI cost. The tables further down are the evidence.
 */
export function DeployReport({ dep }: { dep: Deployment }) {
  const t = useT();
  if (!DONE.has(dep.status)) {
    return (
      <Section title={t("report.deployTitle")}>
        <p className="text-sm text-muted">{t("report.pending")}</p>
      </Section>
    );
  }

  if (dep.status === "warned" || dep.status === "failed") return <Section title={t("report.deployTitle")}><p>{dep.status === "warned" ? t("dep.warned") : t("dep.failed")}</p></Section>;
  if (dep.status === "deployed") return <Section title={t("report.deployTitle")}><p>{t("dep.deployed")}</p></Section>;

  const names = orderTargets(Object.keys(dep.targets));
  const baseline = dep.attempts.at(-1)?.steps?.[0]?.baseline ?? names[0];
  const last = dep.attempts.length - 1;
  const blocked = dep.attempts.find((a) => a.verdict?.status === "BLOCKED");
  const fix = dep.attempts.find((a) => a.applied_fix)?.applied_fix;
  const shakedownTime = dep.attempts.reduce((sum, a) => sum + (a.duration_s ?? 0), 0);
  const tone = dep.status === "promoted" ? "border-ok/40 bg-ok/10" : "border-bad/40 bg-bad/10";

  return (
    <Section title={t("report.deployTitle")} right={<Badge status={dep.status} />}>
      <div className={`rounded-lg border px-4 py-3 ${tone}`}>
        <div className="font-semibold">{t(dep.status === "promoted" ? "report.resultOk" : "report.resultBad")}</div>
        <div className="mt-1 text-sm opacity-90">{dep.attempts.at(-1)?.verdict?.summary ?? dep.error}</div>
      </div>

      <div className="mt-4">
        <Row label={t("report.time")}>
          <span className="font-mono">{dep.timings.total_s != null ? formatSeconds(dep.timings.total_s) : "—"}</span>
          <span className="ml-3 text-xs text-muted">
            {t("dep.build")} {dep.timings.build_s != null ? formatSeconds(dep.timings.build_s) : "—"}
            {" · "}{t("dep.deploy")} {dep.timings.deploy_s != null ? formatSeconds(dep.timings.deploy_s) : "—"}
            {shakedownTime > 0 && <>{" · "}{t("stage.shakedown")} {formatSeconds(shakedownTime)}</>}
          </span>
        </Row>

        <Row label={t("report.targets")}>
          <ul className="space-y-1.5">
            {names.map((name) => {
              const target = dep.targets[name];
              const o = dep.options[name];
              const first = passedSteps(dep, 0, name, baseline);
              const final = passedSteps(dep, last, name, baseline);
              return (
                <li key={name} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium w-20">{targetLabel(name)}</span>
                  {target.url && <a href={target.url} target="_blank" className="font-mono text-xs text-accent hover:underline">{target.url}</a>}
                  {o && <span className="text-xs text-muted">{t("dep.instances", { n: o.replicas })} · TZ {o.tz}</span>}
                  {final.total > 0 && (
                    <span className="text-xs">
                      {last > 0 && first.passed !== final.passed && <span className="text-muted">{first.passed}/{first.total} → </span>}
                      <span className={final.passed === final.total ? "text-ok" : "text-bad"}>
                        {t("pipe.steps", { passed: final.passed, total: final.total })}
                      </span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </Row>

        {blocked && (
          <Row label={t("report.found")}>
            <div className="font-medium">{blocked.report?.headline ?? blocked.verdict?.summary}</div>
            {blocked.report?.cause && <div className="mt-1 text-xs text-muted">{blocked.report.cause}</div>}
          </Row>
        )}

        {blocked && (
          <Row label={t("report.action")}>
            {fix ? (
              <>
                <Mono>{targetLabel(fix.target)}: {fix.option}={fix.value}</Mono>
                {fix.native && <span className="ml-2 text-xs text-muted">{fix.native}</span>}
                <div className="mt-1 text-xs text-muted">
                  {t(dep.status === "promoted" ? "report.fixWorked" : "report.fixFailed", { n: dep.attempts.length })}
                </div>
              </>
            ) : (
              <span className="text-muted">
                {blocked.report?.fix?.description ? t("report.manual", { what: blocked.report.fix.description }) : t("report.noFix")}
              </span>
            )}
          </Row>
        )}

        <Row label={t("report.aiUsage")}>
          <span className="inline-flex flex-wrap items-center gap-2">
            {dep.scenario_source === "ai" ? <AiTag>{t("dep.aiJourney")}</AiTag>
              : dep.scenario_source === "saved" ? <RuleTag>{t("dep.savedJourney")}</RuleTag>
              : <RuleTag>{t("dep.ruleJourney")}</RuleTag>}
            <span className="text-xs text-muted">
              {t("dep.calls", { n: dep.ai_cost.calls })} · ₩{dep.ai_cost.krw}
            </span>
          </span>
        </Row>
      </div>
    </Section>
  );
}
