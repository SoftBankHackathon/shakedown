import type { TargetName, TargetOptions } from "@shakedown/contracts";

export type TargetInfo = {
  id: TargetName;
  /** Short name shown on toggles and cards (same in every language). */
  label: string;
  /** Implemented by the engine for this hackathon. Flip to true when a target ships. */
  available: boolean;
  /** Selected by default on import. */
  default: boolean;
  /** The engine accepts sticky sessions for this target (Azure: Container Apps ingress affinity). */
  sticky?: boolean;
};

// Order matters: the first selected target is the baseline the others are compared against.
export const TARGETS: TargetInfo[] = [
  { id: "local", label: "Local", available: true, default: true },
  { id: "aws", label: "AWS", available: true, default: true },
  { id: "onprem", label: "On-prem", available: false, default: false },
  { id: "gcp", label: "GCP", available: true, default: false, sticky: true },
  { id: "azure", label: "Azure", available: true, default: false, sticky: true },
];

export const DEFAULT_TARGETS = TARGETS.filter((t) => t.default).map((t) => t.id);

/** Live selection with `id` turned on, kept in catalog order. Any clouds can go together: the engine builds once and copies the same digest to the others. */
export function pickTarget(current: TargetName[], id: TargetName): TargetName[] {
  return TARGETS.filter((t) => t.id === id || current.includes(t.id)).map((t) => t.id);
}

/** Starting options for a compared target: two instances in UTC, the setup that exposes environment differences. */
export const DEFAULT_TARGET_OPTIONS: TargetOptions = { replicas: 2, sticky_sessions: false, tz: "UTC" };
export const TIMEZONES = ["UTC", "Asia/Seoul"] as const;

export function targetLabel(id: string): string {
  if (id === "candidate") return "Candidate";
  return TARGETS.find((t) => t.id === id)?.label ?? id;
}

/** Targets of a deployment in catalog order (unknown names from older engines go last). */
export function orderTargets(ids: string[]): string[] {
  const rank = (id: string) => {
    const i = TARGETS.findIndex((t) => t.id === id);
    return i < 0 ? TARGETS.length : i;
  };
  return [...ids].sort((a, b) => rank(a) - rank(b));
}
