"use client";

import { Fragment, useState } from "react";
import { BsTerminal } from "react-icons/bs";
import { useT } from "@/components/i18n";
import { AiTag, Mono } from "@/components/ui";
import type { Hop, Step, StepDiff, StepResult } from "@/lib/api";

const ROW_TONE: Record<StepDiff["severity"], string> = { critical: "bg-bad/5", warn: "bg-warn/5", ignore: "", none: "" };
const ICON: Record<StepResult["status"], string> = { passed: "✓", failed: "✕", skipped: "–" };
const TONE: Record<StepResult["status"], string> = { passed: "text-ok", failed: "text-bad", skipped: "text-muted" };

function describe(s: Step) {
  if (s.action === "visit") return `visit ${s.path}`;
  if (s.action === "submit_form") return `submit ${s.form_action}`;
  return `click "${s.link_text}"`;
}

/** Same journey, two environments, side by side. Diverging rows open to show every HTTP hop. */
export function StepTable({ baseline, candidate, steps, diffs, running }: {
  baseline: string; candidate: string; steps: Step[]; diffs: StepDiff[]; running: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const t = useT();
  const firstBad = diffs.find((d) => d.severity === "critical" || d.severity === "warn")?.index ?? null;

  return (
    <div className="table-wrap">
      <table className="comparison-table">
        <thead>
          <tr>
            <th className="w-10">#</th>
            <th>{t("step.step")}</th>
            <th>{baseline}</th>
            <th>{candidate}</th>
            <th className="text-right">{t("step.result")}</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => {
            const d = diffs[i];
            const idx = i + 1;
            const isOpen = open === idx || (open === null && idx === firstBad);
            const rowTone = d ? ROW_TONE[d.severity] : "";
            const isNext = running && !d && i === diffs.length;
            return (
              <Fragment key={idx}>
                <tr onClick={() => d && setOpen(isOpen ? -1 : idx)} className={`${d ? "cursor-pointer" : ""} ${rowTone}`}>
                  <td className="mono muted tabular-nums">{String(idx).padStart(2, "0")}</td>
                  <td>
                    <div className="font-medium">{s.title}</div>
                    <small className="mono">{describe(s)}</small>
                  </td>
                  <td><Cell r={d?.local} pending={isNext} /></td>
                  <td><Cell r={d?.cloud} pending={isNext} /></td>
                  <td className="text-right"><Outcome d={d} /></td>
                </tr>
                {d && isOpen && d.kind !== "same" && d.kind !== "skipped" && (
                  <tr className="selected">
                    <td />
                    <td colSpan={4}>
                      <ul className="space-y-0.5 text-xs">
                        {d.reasons.map((r) => <li key={r}>• {r}</li>)}
                      </ul>
                      <div className="trace-grid">
                        <Hops title={baseline} hops={d.local.hops} />
                        <Hops title={candidate} hops={d.cloud.hops} />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {!steps.length && <div className="table-empty">{t("dep.waiting")}</div>}
    </div>
  );
}

function Cell({ r, pending }: { r?: StepResult; pending: boolean }) {
  const t = useT();
  if (!r) return <span className="text-xs muted">{pending ? t("step.running") : ""}</span>;
  return (
    <div>
      <span className={`font-semibold ${TONE[r.status]}`}>{ICON[r.status]}</span>{" "}
      <Mono>{r.final_path ?? "—"}</Mono>
      {r.status !== "skipped" && <span className="ml-2 text-xs muted tabular-nums">{r.elapsed_ms}ms</span>}
    </div>
  );
}

function Outcome({ d }: { d?: StepDiff }) {
  const t = useT();
  if (!d) return null;
  const map: Record<StepDiff["kind"], [string, string]> = {
    same: [t("kind.same"), "text-ok"],
    env_diff: [t(d.local.status === "skipped" || d.cloud.status === "skipped" ? "kind.notReached" : "kind.differs"), "text-bad"],
    path_diff: [t("kind.path_diff"), "text-bad"],
    both_failed: [t("kind.both_failed"), "text-bad"],
    text_diff: [t(d.severity === "ignore" ? "kind.ignorable" : "kind.text_diff"), d.severity === "critical" ? "text-bad" : d.severity === "ignore" ? "text-muted" : "text-warn"],
    skipped: [t("kind.skipped"), "text-muted"],
  };
  const [label, tone] = map[d.kind];
  return (
    <span className={`text-xs font-medium ${tone} inline-flex items-center gap-1.5`}>
      {d.classified_by === "ai" && <AiTag>{t("step.classified")}</AiTag>}
      {label}
    </span>
  );
}

// One color per serving instance, so "two servers answered one user" is visible at a glance.
const INSTANCE_TONES = ["bg-accent/15 text-accent", "bg-ai/20 text-ai", "bg-ok/15 text-ok"];

function Hops({ title, hops }: { title: string; hops: Hop[] }) {
  const t = useT();
  const ids = [...new Set(hops.map((h) => h.instance).filter(Boolean))] as string[];
  return (
    <section className="trace-panel">
      <h3><BsTerminal />{title} · {t("step.hops")}</h3>
      {hops.length === 0 && <p className="muted">{t("step.notExecuted")}</p>}
      {hops.map((h, i) => {
        const k = h.instance ? ids.indexOf(h.instance) : -1;
        return (
          <div className="trace-row" key={i}>
            <b>{h.method}</b>
            <code>{h.path}</code>
            <span className={h.status >= 400 ? "red-text" : h.status >= 300 ? "muted" : "text-ok"}>{h.status}</span>
            <small>{h.instance && <span className={`rounded px-1.5 ${INSTANCE_TONES[k % INSTANCE_TONES.length]}`}>{t("step.server", { n: k + 1 })}</span>}</small>
          </div>
        );
      })}
    </section>
  );
}
