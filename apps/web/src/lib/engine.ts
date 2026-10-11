"use client";

import { useEffect, useState } from "react";
import { API, MOCK, type ServiceStatus, type TargetName } from "./api";

/** Whether the engine answers (null while the first check is in flight). Polls GET /api/health every 10 s. */
export function useEngineOnline(): boolean | null {
  const [online, setOnline] = useState<boolean | null>(MOCK ? true : null);
  useEffect(() => {
    if (MOCK) return;
    let alive = true;
    const check = () =>
      fetch(API + "/api/health", { cache: "no-store" })
        .then((r) => { if (alive) setOnline(r.ok); })
        .catch(() => { if (alive) setOnline(false); });
    void check();
    const timer = setInterval(() => void check(), 10_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return online;
}

/**
 * GET /api/services on load and every 15 s. null means unknown (first check in flight, engine down, or an older
 * engine without the endpoint): callers then keep the static target catalog and the rule-report estimate.
 */
export function useServices(): ServiceStatus | null {
  const [services, setServices] = useState<ServiceStatus | null>(null);
  useEffect(() => {
    if (MOCK) return;
    let alive = true;
    const check = () =>
      fetch(API + "/api/services", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<ServiceStatus>) : null))
        .then((s) => { if (alive) setServices(s); })
        .catch(() => { if (alive) setServices(null); });
    void check();
    const timer = setInterval(() => void check(), 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return services;
}

/** A target the engine reported as offline. Unknown (no report) counts as usable, as before /api/services existed. */
export const isOffline = (services: ServiceStatus | null, id: TargetName) => services?.targets[id]?.online === false;
