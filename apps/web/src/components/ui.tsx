"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BsChevronRight, BsInfoCircle, BsX } from "react-icons/bs";
import { formatSeconds, MOCK } from "@/lib/api";
import { useEngineOnline } from "@/lib/engine";
import { useT } from "@/components/i18n";

// Engine / shakedown status values → prototype badge classes (passed · blocked · failed · running · difference).
const BADGE_CLASS: Record<string, string> = {
  promoted: "passed", PASS: "passed", passed: "passed", ready: "passed", deployed: "passed",
  blocked: "blocked", BLOCKED: "blocked", failed: "failed",
  warned: "difference", WARN: "difference", review: "difference",
  building: "running", deploying: "running", shakedown: "running", analyzing: "running", fixing: "running",
  queued: "", pending: "", stopped: "", external: "", skipped: "",
};

export function Badge({ status, children }: { status: string; children?: ReactNode }) {
  const t = useT();
  const cls = BADGE_CLASS[status] ?? "running";
  return (
    <span className={`badge ${cls}`}>
      <i />
      {children ?? t.maybe(`status.${status}`, status)}
    </span>
  );
}

/** Marks anything the AI produced, so people can tell it from rule output. */
export function AiTag({ children = "AI" }: { children?: ReactNode }) {
  return <span className="tag ai">✦ {children}</span>;
}

export function RuleTag({ children = "Rule" }: { children?: ReactNode }) {
  return <span className="tag">{children}</span>;
}

/** A framed panel with a heading row. `flush` drops the body padding for tables and definition lists. */
export function Section({ title, right, icon, id, className, flush, children }: {
  title: string; right?: ReactNode; icon?: ReactNode; id?: string; className?: string; flush?: boolean; children: ReactNode;
}) {
  return (
    <section id={id} className={`panel ${className ?? ""}`}>
      <div className="panel-heading">
        {icon}
        <h3>{title}</h3>
        {right && <span className="panel-right">{right}</span>}
      </div>
      {flush ? children : <div className="panel-body">{children}</div>}
    </section>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[13px]">{children}</code>;
}

/** Running clock. Only this element re-renders every tick, not the whole page. */
export function Elapsed({ created }: { created: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  return <>{formatSeconds(Math.max(0, now / 1000 - created))}</>;
}

export function Toggle({ label, checked, onChange, disabled = false }: {
  label: string; checked: boolean; onChange: () => void; disabled?: boolean;
}) {
  return (
    <button type="button" className={`switch ${checked ? "on" : ""}`} role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={onChange}>
      <span />
    </button>
  );
}

/** Native dialog: keyboard accessible, restores focus to the opener on close. */
export function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog ref={ref} className="modal" aria-label={title} onCancel={close} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal-heading">
        <h2>{title}</h2>
        <button type="button" className="icon-button" aria-label={t("ui.close")} onClick={close}><BsX size={23} /></button>
      </div>
      {children}
    </dialog>
  );
}

export function PageHeading({ title, lead, id, children }: { title: string; lead?: string; id?: string; children?: ReactNode }) {
  return (
    <div className="page-heading" id={id}>
      <div>
        <h2>{title}</h2>
        {lead && <p>{lead}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

export function Alert({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  const t = useT();
  return (
    <div className="alert" role="alert">
      <BsInfoCircle />
      <span>{children}</span>
      {onClose && <button type="button" className="icon-button" aria-label={t("ui.close")} onClick={onClose}><BsX size={20} /></button>}
    </div>
  );
}

export function Breadcrumb({ parent, parentHref, current }: { parent: string; parentHref?: string; current: string }) {
  return (
    <div className="breadcrumb">
      {parentHref ? <Link href={parentHref}>{parent}</Link> : <span className="muted">{parent}</span>}
      <BsChevronRight size={12} />
      <h1>{current}</h1>
    </div>
  );
}

/** Green dot when the engine answers; the prototype showed the same strip for its local runner. */
export function ConnectionStrip() {
  const t = useT();
  const online = useEngineOnline();
  const text = MOCK ? t("conn.mock") : online ? t("conn.on") : online === false ? t("conn.off") : t("conn.checking");
  return (
    <div className="connection-strip">
      <i className={`connection-dot ${online ? "connected" : ""}`} />
      {text}
    </div>
  );
}
