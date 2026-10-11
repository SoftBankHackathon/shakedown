"use client";

import { BsShieldCheck } from "react-icons/bs";
import { useT } from "@/components/i18n";
import { AiTag, Badge, Mono, RuleTag, Section } from "@/components/ui";
import { DONE, formatSeconds, type Deployment } from "@/lib/api";
import { resultsFor } from "@/lib/steps";
import { orderTargets, targetLabel } from "@/lib/targets";

/** Steps one target passed in an attempt. */
function passedSteps(d: Deployment, attemptIndex: number, names: string[], name: string, baseline: string) {
  const results = resultsFor(d.attempts[attemptIndex]?.steps ?? [], names, baseline, name);
  return { passed: results.filter((r) => r.status === "passed").length, total: d.scenario?.steps.length ?? results.length };
}

const fmt = (s?: number) => (s != null ? formatSeconds(s) : "—");

/**
 * Release decision panel: what happened, how long it took, what was found and fixed, and what the AI cost.
 * The step tables on the live tab are the evidence.
 */
export function DeployReport({ dep }: { dep: Deployment }) {
  const t = useT();
  const icon = <BsShieldCheck />;
  if (!DONE.has(dep.status)) {
    return <Section title={t("report.decision")} icon={icon}><p className="text-sm muted">{t("report.pending")}</p></Section>;
  }
  const simple = dep.status === "warned" ? t("dep.warned") : dep.status === "failed" ? t("dep.failed") : dep.status === "deployed" ? t("dep.deployed") : null;
  if (simple) {
    return (
      <Section title={t("report.decision")} icon={icon} right={<Badge status={dep.status} />}>
        <p className="text-sm">{simple}</p>
        {dep.error && <p className="hint">{dep.error}</p>}
      </Section>
    );
  }

  const names = orderTargets(Object.keys(dep.targets));
  const baseline = dep.attempts.at(-1)?.steps?.[0]?.baseline ?? names[0];
  const last = dep.attempts.length - 1;
  const blocked = dep.attempts.find((a) => a.verdict?.status === "BLOCKED");
  const fix = dep.attempts.find((a) => a.applied_fix)?.applied_fix;
  const shakedownTime = dep.attempts.reduce((sum, a) => sum + (a.duration_s ?? 0), 0);
  const journey = dep.scenario_source === "ai" ? <AiTag>{t("dep.aiJourney")}</AiTag>
    : dep.scenario_source === "saved" ? <RuleTag>{t("dep.savedJourney")}</RuleTag>
    : <RuleTag>{t("dep.ruleJourney")}</RuleTag>;

  return (
    <Section title={t("report.decision")} icon={icon} right={<Badge status={dep.status} />} flush>
      <dl className="decision-list">
        <div><dt>{t("report.result")}</dt><dd><Badge status={dep.status} /></dd></div>
        <div>
          <dt>{t("report.time")}</dt>
          <dd>
            <span className="mono">{fmt(dep.timings.total_s)}</span>
            <small className="block muted">
              {t("dep.build")} {fmt(dep.timings.build_s)} · {t("dep.deploy")} {fmt(dep.timings.deploy_s)}
              {shakedownTime > 0 && <> · {t("stage.shakedown")} {formatSeconds(shakedownTime)}</>}
            </small>
          </dd>
        </div>
        <div><dt>{t("report.attempts")}</dt><dd>{dep.attempts.length}</dd></div>
        <div>
          <dt>{t("report.aiUsage")}</dt>
          <dd>{journey}<small className="block muted">{t("dep.calls", { n: dep.ai_cost.calls })} · ₩{dep.ai_cost.krw}</small></dd>
        </div>
      </dl>

      <div className="panel-section">
        <h4>{t("report.targets")}</h4>
        <ul className="target-list">
          {names.map((name) => {
            const target = dep.targets[name];
            const o = dep.options[name];
            const first = passedSteps(dep, 0, names, name, baseline);
            const final = passedSteps(dep, last, names, name, baseline);
            return (
              <li key={name}>
                <span className="name">{targetLabel(name)}</span>
                {target.url && <a href={target.url} target="_blank" rel="noreferrer">{target.url}</a>}
                {o && <span className="muted">{t("dep.instances", { n: o.replicas })} · TZ {o.tz}</span>}
                {final.total > 0 && (
                  <span>
                    {last > 0 && first.passed !== final.passed && <span className="muted">{first.passed}/{first.total} → </span>}
                    <span className={final.passed === final.total ? "text-ok" : "text-bad"}>{t("pipe.steps", { passed: final.passed, total: final.total })}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {blocked && (
        <div className="panel-section">
          <h4>{t("report.found")}</h4>
          <div>{blocked.report?.headline ?? blocked.verdict?.summary}</div>
          {blocked.report?.cause && <div className="muted">{blocked.report.cause}</div>}
        </div>
      )}

      {blocked && (
        <div className="panel-section">
          <h4>{t("report.action")}</h4>
          {fix ? (
            <>
              <Mono>{targetLabel(fix.target)}: {fix.option}={fix.value}</Mono>
              {fix.native && <span className="muted"> · {fix.native}</span>}
              <div className="muted">{t(dep.status === "promoted" ? "report.fixWorked" : "report.fixFailed", { n: dep.attempts.length })}</div>
            </>
          ) : (
            <span className="muted">
              {/* 엔진이 적용할 수 있는 수정안이면 아직 적용 전이라는 뜻이므로 버튼을 가리킨다. */}
              {blocked.report?.fix?.description
                ? t(blocked.report.fix.auto_applicable ? "report.fixReady" : "report.manual", { what: blocked.report.fix.description })
                : t("report.noFix")}
            </span>
          )}
        </div>
      )}

      <p className="panel-note">{t("report.note")}</p>
    </Section>
  );
}
