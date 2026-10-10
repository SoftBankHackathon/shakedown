"use client";

import { useEffect, useState } from "react";
import { API, MOCK } from "./api";

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
