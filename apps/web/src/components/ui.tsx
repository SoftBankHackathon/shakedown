"use client";

import type { ReactNode } from "react";
import { useT } from "@/components/i18n";

const STATUS_STYLE: Record<string, string> = {
  stopped: "bg-line text-muted",
  external: "bg-line text-muted",
  warned: "bg-warn/15 text-warn",
  deployed: "bg-accent/15 text-accent",
  promoted: "bg-ok/15 text-ok",
  PASS: "bg-ok/15 text-ok",
  ready: "bg-ok/15 text-ok",
  passed: "bg-ok/15 text-ok",
  blocked: "bg-bad/15 text-bad",
  BLOCKED: "bg-bad/15 text-bad",
  failed: "bg-bad/15 text-bad",
  WARN: "bg-warn/15 text-warn",
  skipped: "bg-line text-muted",
  pending: "bg-line text-muted",
};

export function Badge({ status, children }: { status: string; children?: ReactNode }) {
  const t = useT();
  const style = STATUS_STYLE[status] ?? "bg-accent/15 text-accent";
  const live = !(status in STATUS_STYLE);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>
      {live && <span className="size-1.5 rounded-full bg-current animate-pulse" />}
      {children ?? t.maybe(`status.${status}`, status)}
    </span>
  );
}

/** Marks anything the AI produced, so people can tell it from rule output. */
export function AiTag({ children = "AI" }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold bg-ai/20 text-ai">
      ✦ {children}
    </span>
  );
}

export function RuleTag({ children = "Rule" }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold bg-line text-muted">
      {children}
    </span>
  );
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[13px]">{children}</code>;
}

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`inline-block size-3.5 rounded-full border-2 border-current border-t-transparent animate-spin ${className}`} />;
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-xs text-muted">{children}</span>;
}
