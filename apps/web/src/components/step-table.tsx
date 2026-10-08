"use client";

import { Fragment, useState } from "react";
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
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted">
            <th className="py-2 w-8">#</th>
            <th className="py-2">{t("step.step")}</th>
            <th className="py-2">{baseline}</th>
            <th className="py-2">{candidate}</th>
            <th className="py-2 text-right">{t("step.result")}</th>
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
                <tr
                  onClick={() => d && setOpen(isOpen ? -1 : idx)}
                  className={`border-t border-line ${d ? "cursor-pointer" : ""} ${rowTone}`}
                >
                  <td className="py-2.5 text-muted tabular-nums">{idx}</td>
                  <td className="py-2.5">
                    <div className="font-medium">{s.title}</div>
                    <div className="text-xs text-muted font-mono">{describe(s)}</div>
                  </td>
                  <td className="py-2.5"><Cell r={d?.local} pending={isNext} /></td>
                  <td className="py-2.5"><Cell r={d?.cloud} pending={isNext} /></td>
                  <td className="py-2.5 text-right"><Outcome d={d} /></td>
                </tr>
                {d && isOpen && d.kind !== "same" && d.kind !== "skipped" && (
                  <tr className="bg-bg/60">
                    <td />
                    <td colSpan={4} className="py-3 pr-2">
                      <ul className="mb-3 space-y-0.5 text-xs">
                        {d.reasons.map((r) => <li key={r}>• {r}</li>)}
                      </ul>
                      <div className="grid gap-3 md:grid-cols-2">
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
    </div>
  );
}

function Cell({ r, pending }: { r?: StepResult; pending: boolean }) {
  const t = useT();
  if (!r) return <span className="text-xs text-muted">{pending ? t("step.running") : ""}</span>;
  return (
    <div>
      <span className={`font-semibold ${TONE[r.status]}`}>{ICON[r.status]}</span>{" "}
      <Mono>{r.final_path ?? "—"}</Mono>
      {r.status !== "skipped" && <span className="ml-2 text-xs text-muted tabular-nums">{r.elapsed_ms}ms</span>}
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
    <div className="rounded-lg border border-line p-3">
      <div className="mb-2 text-xs font-semibold text-muted">{title} · {t("step.hops")}</div>
      {hops.length === 0 && <div className="text-xs text-muted">{t("step.notExecuted")}</div>}
      <ol className="space-y-1 text-xs font-mono">
        {hops.map((h, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="text-muted w-10">{h.method}</span>
            <span className="flex-1 truncate">{h.path}</span>
            <span className={h.status >= 400 ? "text-bad" : h.status >= 300 ? "text-muted" : "text-ok"}>{h.status}</span>
            {h.instance && (() => {
              const k = ids.indexOf(h.instance);
              return (
                <span className={`rounded px-1.5 ${INSTANCE_TONES[k % INSTANCE_TONES.length]}`}>
                  {t("step.server", { n: k + 1 })}
                </span>
              );
            })()}
          </li>
        ))}
      </ol>
    </div>
  );
}
