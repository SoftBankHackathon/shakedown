"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BsBoxSeam, BsCheck2, BsChevronDown, BsGear, BsLightningCharge, BsPlus } from "react-icons/bs";
import { LangSwitcher, useT } from "@/components/i18n";
import { Modal } from "@/components/ui";
import { api, type Project } from "@/lib/api";

/** Top bar from the prototype: brand, project switcher, main tabs, guide + language + avatar. */
export function TopBar() {
  const t = useT();
  const pathname = usePathname() ?? "/";
  const [menu, setMenu] = useState(false);
  const [help, setHelp] = useState(false);
  const [lastDeployment, setLastDeployment] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);

  // The deployment page remembers the last run, so the 시운전 tab can return to it.
  useEffect(() => {
    try { setLastDeployment(sessionStorage.getItem("lastDeployment")); } catch {}
    setMenu(false);
  }, [pathname]);

  // Registered projects feed the switcher; refreshed on every navigation so a new Action shows up.
  useEffect(() => {
    let alive = true;
    api.projects().then((list) => { if (alive) setProjects(list); }).catch(() => { if (alive) setProjects([]); });
    return () => { alive = false; };
  }, [pathname]);

  const onProject = pathname.startsWith("/projects/");
  const onRun = pathname.startsWith("/deployments/");
  const currentId = onProject ? pathname.split("/")[2] : null;
  const current = projects.find((p) => p.id === currentId);
  const nav = [
    { id: "overview", label: t("nav.overview"), href: "/", active: pathname === "/" || onProject },
    { id: "live", label: t("nav.live"), href: lastDeployment ? `/deployments/${lastDeployment}` : "/#actions", active: onRun },
    { id: "settings", label: t("nav.settings"), href: "/settings", active: pathname.startsWith("/settings") },
  ];

  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand" aria-label="Shakedown"><Image src="/brand/shakedown-symbol.png" alt="" width={34} height={34} priority />shakedown</Link>
        <span className="header-divider" />
        <div className="workspace-picker">
          <button type="button" aria-expanded={menu} onClick={() => setMenu((m) => !m)} className="workspace-button">
            <span>{t("nav.projects")} <span className="slash">/</span> <strong>{current?.name ?? t("nav.pick")}</strong></span>
            <BsChevronDown size={12} />
          </button>
          {menu && (
            <>
              <button type="button" className="menu-dismiss" aria-label={t("ui.close")} onClick={() => setMenu(false)} />
              <div className="workspace-menu">
                <span>{t("proj.title")}</span>
                {projects.slice(0, 8).map((p) => (
                  <Link key={p.id} href={`/projects/${p.id}`}>{p.id === currentId ? <BsCheck2 /> : <BsBoxSeam />}{p.name}</Link>
                ))}
                {projects.length === 0 && <span>{t("proj.none")}</span>}
                <Link href="/"><BsPlus />{t("nav.newAction")}</Link>
                <Link href="/settings"><BsGear />{t("nav.api")}</Link>
              </div>
            </>
          )}
        </div>
        <nav className="main-nav" aria-label={t("nav.main")}>
          {nav.map((n) => (
            <Link key={n.id} href={n.href} className={n.active ? "active" : ""} aria-current={n.active ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="header-tools">
          <button type="button" onClick={() => setHelp(true)}>{t("nav.guide")}</button>
          <LangSwitcher />
          <Link href="/settings" className="avatar" aria-label={t("nav.api")}>JH</Link>
        </div>
      </header>
      {help && (
        <Modal title={t("guide.title")} close={() => setHelp(false)}>
          <div className="guide">
            <Image src="/brand/shakedown-logo.png" alt="Shakedown — One Action, Infinity Clouds" width={240} height={80} className="guide-logo" />
            <p>{t("guide.intro")}</p>
            <ol>
              {([1, 2, 3, 4] as const).map((n) => (
                <li key={n}>
                  <strong>{t(`home.step${n}`)}</strong>
                  <p>{t(`home.step${n}d`)}</p>
                </li>
              ))}
            </ol>
            <p className="guide-note"><BsLightningCharge size={12} /> {t("guide.note")}</p>
          </div>
          <div className="modal-actions">
            <button type="button" className="button primary" onClick={() => setHelp(false)}>{t("guide.ok")}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Accessibility skip link in the current language (the layout itself is a server component). */
export function SkipLink() {
  const t = useT();
  return <a className="skip-link" href="#main">{t("ui.skip")}</a>;
}
