// Optional, fixed loopback bridge. Once enabled, an unavailable HTTPS service is a hard failure.
export class HttpsControl {
  constructor(
    private base: string | undefined,
    private project: string,
  ) {}
  async gate(open: boolean, signal: AbortSignal): Promise<string | undefined> {
    if (!this.base) return;
    const response = await fetch(
      this.base +
        "/projects/" +
        encodeURIComponent(this.project) +
        "/targets/aws/https/gate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ open }),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      },
    );
    if (!response.ok)
      throw new Error("HTTPS gate could not be verified; deployment stopped.");
    const result = (await response.json()) as {
      configured?: boolean;
      url?: string;
      blocked?: boolean;
    };
    if (!result.configured) return;
    const u = new URL(result.url ?? "");
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      u.pathname !== "/" ||
      u.search ||
      u.hash ||
      result.blocked === open
    )
      throw new Error("Invalid HTTPS gate response.");
    return u.origin;
  }
}
