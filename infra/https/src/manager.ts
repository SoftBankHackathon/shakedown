import {
  type Context,
  type Job,
  type Provider,
  type Settings,
  HttpsError,
  endpointFor,
  requestSchema,
} from "./model.js";
import { Store } from "./store.js";
import { dnsCheck, probe, verify, type Prober } from "./probe.js";
import { io as nativeIO, type IO } from "./io.js";
import { AwsProvider } from "./providers/aws.js";
import { AzureProvider } from "./providers/azure.js";
import { GcpProvider } from "./providers/gcp.js";
import { CloudflareProvider, CaddyProvider } from "./providers/local.js";

export function providerFor(job: Job, io: IO = nativeIO): Provider {
  switch (job.config.kind) {
    case "aws-alb":
      return new AwsProvider(io);
    case "azure-container-apps":
    case "azure-app-service":
      return new AzureProvider(io);
    case "gcp-alb":
      return new GcpProvider(io);
    case "cloudflare-tunnel":
      return new CloudflareProvider(io);
    case "caddy":
      return new CaddyProvider(io);
  }
}
export class Manager {
  private busy = new Set<string>();
  private timer?: NodeJS.Timeout;
  constructor(
    public settings: Settings,
    public store: Store,
    private provider: (j: Job) => Provider = providerFor,
    private dns: typeof dnsCheck = dnsCheck,
    private check: Prober = probe,
    private now = () => Date.now(),
  ) {}
  get(project: string, target: string) {
    return this.store.get(project, target)?.result;
  }
  create(project: string, target: string, body: unknown) {
    const request = requestSchema.parse(body),
      config = endpointFor(this.settings, project, target, request.local_mode);
    const job = this.store.create(config, request.domain, this.now());
    return job.result;
  }
  recheck(project: string, target: string) {
    const job = this.require(project, target);
    if (this.busy.has(job.result.binding_id))
      throw new HttpsError(
        "BUSY",
        "현재 검사 중입니다. 잠시 후 다시 확인하세요.",
        409,
      );
    if (job.rollbackPending)
      throw new HttpsError(
        "ROLLBACK_PENDING",
        "이전 변경을 복원하고 있습니다.",
        409,
      );
    // A ready binding is checked in place; an invalid renewed certificate must never turn HTTPS off.
    if (
      job.result.status === "failed" ||
      (job.result.status === "needs_action" && !job.data.everReady)
    ) {
      job.result.status = "preflight";
      delete job.result.error;
    }
    if (job.data.everReady) job.result.status = "ready";
    job.result.deadline = new Date(this.now() + 86_400_000).toISOString();
    job.result.next_check_at = new Date(this.now()).toISOString();
    this.store.save(job);
    return job.result;
  }
  private require(project: string, target: string) {
    const job = this.store.get(project, target);
    if (!job)
      throw new HttpsError("NOT_FOUND", "등록된 HTTPS 연결이 없습니다.", 404);
    return job;
  }
  private context(job: Job): Context {
    return {
      job,
      save: () => {
        job.result.updated_at = new Date(this.now()).toISOString();
        this.store.save(job);
      },
    };
  }
  async gate(project: string, open: boolean) {
    const job = this.store.get(project, "aws");
    if (!job) return { configured: false };
    if (
      !this.settings.endpoints.some(
        (e) => JSON.stringify(e) === JSON.stringify(job.config),
      )
    )
      throw new HttpsError(
        "CONFIG_CHANGED",
        "등록된 HTTPS 연결 설정이 변경됐습니다.",
        409,
      );
    const id = job.result.binding_id;
    if (this.busy.has(id))
      throw new HttpsError("BUSY", "HTTPS 설정 또는 검사 중입니다.", 409);
    if (!job.data.everReady) {
      if (open)
        throw new HttpsError(
          "HTTPS_NOT_READY",
          "HTTPS 설정을 완료한 뒤 배포를 재개하세요.",
          409,
        );
      // A stop during setup must also remove any partially created 443 route.
      // The AWS adapter closes its original HTTP route after this returns.
      this.busy.add(id);
      const ctx = this.context(job);
      job.result.status = "needs_action";
      job.result.error = {
        code: "SETUP_CANCELLED",
        message:
          "배포 중지로 HTTPS 설정을 복원했습니다. 앱 준비 후 다시 확인하세요.",
      };
      job.data.failureError = job.result.error;
      job.rollbackPending = true;
      ctx.save();
      try {
        await this.provider(job).rollback(ctx);
        job.rollbackPending = false;
        delete job.data.applied;
        delete job.data.redirected;
        delete job.data.verifyStarted;
        delete job.data.redirectStarted;
        ctx.save();
        return { configured: false };
      } catch (e) {
        job.result.error = {
          code: "ROLLBACK_PENDING",
          message: "부분 HTTPS 설정 복원이 필요합니다. 새 배포는 중단했습니다.",
        };
        job.result.next_check_at = new Date(this.now()).toISOString();
        ctx.save();
        throw e;
      } finally {
        this.busy.delete(id);
      }
    }
    this.busy.add(id);
    try {
      const p = this.provider(job),
        ctx = this.context(job);
      if (!p.gate)
        throw new HttpsError(
          "UNSUPPORTED",
          "이 대상은 게이트를 지원하지 않습니다.",
        );
      // Persist desired state before cloud mutation so retries recover an interrupted close.
      job.data.gateDesired = open;
      job.data.gatePending = true;
      job.result.traffic_blocked = null;
      ctx.save();
      await p.gate(ctx, open);
      for (const scheme of ["http", "https"]) {
        const r = await this.check(
          scheme +
            "://" +
            job.result.domain +
            (open ? job.config.healthPath : "/"),
        );
        if (
          open
            ? scheme === "https"
              ? r.status !== 200
              : ![301, 302, 307, 308].includes(r.status)
            : r.status !== 403
        )
          throw new HttpsError(
            "GATE_UNVERIFIED",
            "HTTP/HTTPS 게이트 적용을 확인하지 못했습니다.",
            502,
          );
      }
      job.data.gatePending = false;
      job.result.traffic_blocked = !open;
      ctx.save();
      return { configured: true, url: job.result.https_url, blocked: !open };
    } catch (e) {
      job.data.gateDesired = false;
      job.data.gatePending = true;
      this.store.save(job);
      throw e;
    } finally {
      this.busy.delete(id);
    }
  }
  async tick() {
    for (const job of this.store.all()) {
      if (
        this.busy.has(job.result.binding_id) ||
        Date.parse(job.result.next_check_at) > this.now()
      )
        continue;
      if (
        ["failed", "needs_action"].includes(job.result.status) &&
        !job.rollbackPending &&
        !job.data.gatePending
      )
        continue;
      await this.run(job.result.project_id, job.result.target);
    }
  }
  start() {
    this.timer = setInterval(() => void this.tick().catch(() => {}), 2000);
    this.timer.unref();
    void this.tick();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  async drain() {
    while (this.busy.size) await new Promise((r) => setTimeout(r, 50));
  }
  async run(project: string, target: string) {
    const job = this.require(project, target),
      id = job.result.binding_id;
    if (
      !this.settings.endpoints.some(
        (e) => JSON.stringify(e) === JSON.stringify(job.config),
      )
    ) {
      job.result.status = "needs_action";
      job.result.error = {
        code: "CONFIG_CHANGED",
        message:
          "등록된 리소스 설정이 변경됐습니다. 기존 설정과 연결 기록을 확인하세요.",
      };
      this.store.save(job);
      return;
    }
    if (this.busy.has(id)) return;
    this.busy.add(id);
    const ctx = this.context(job),
      r = job.result,
      p = this.provider(job);
    const wait = (status: typeof r.status, code?: string, message?: string) => {
      r.status = status;
      r.next_check_at = new Date(this.now() + 30_000).toISOString();
      if (code) r.error = { code, message: message ?? code };
      ctx.save();
    };
    const rollback = async () => {
      try {
        await p.rollback(ctx);
        job.rollbackPending = false;
        if (job.data.failureError) r.error = job.data.failureError;
        delete job.data.applied;
        delete job.data.redirected;
        delete job.data.verifyStarted;
        delete job.data.redirectStarted;
        ctx.save();
      } catch {
        job.rollbackPending = true;
        r.error = {
          code: "ROLLBACK_PENDING",
          message: "설정 복원을 재시도하고 있습니다. 새 변경은 잠겨 있습니다.",
        };
        r.next_check_at = new Date(this.now() + 30_000).toISOString();
        ctx.save();
      }
    };
    try {
      if (job.rollbackPending) {
        await rollback();
        return;
      }
      if (job.data.gatePending && p.gate) {
        job.data.gateDesired = false;
        ctx.save();
        await p.gate(ctx, false);
        const states = await Promise.all(
          ["http", "https"].map((s) => this.check(s + "://" + r.domain + "/")),
        );
        if (states.every((s) => s.status === 403)) {
          job.data.gatePending = false;
          r.traffic_blocked = true;
          ctx.save();
        }
        r.next_check_at = new Date(this.now() + 30_000).toISOString();
        ctx.save();
        return;
      }
      if (job.data.gateClosed) {
        r.next_check_at = new Date(this.now() + 60_000).toISOString();
        ctx.save();
        return;
      }
      if (job.data.everReady) {
        try {
          const v = await verify(r, job.config.healthPath, true, this.check);
          Object.assign(r, v, {
            status: "ready",
            checked_at: new Date(this.now()).toISOString(),
          });
          delete r.error;
        } catch {
          r.status = "needs_action";
          r.error = {
            code: "REVALIDATION_FAILED",
            message:
              "인증서·접속 재검증이 필요합니다. 기존 HTTPS 설정은 유지합니다.",
          };
        }
        r.next_check_at = new Date(this.now() + 3_600_000).toISOString();
        ctx.save();
        return;
      }
      if (this.now() > Date.parse(r.deadline)) {
        r.status = "needs_action";
        r.error = {
          code: "WAIT_EXPIRED",
          message:
            "24시간 내 완료되지 않았습니다. DNS·권한을 확인하고 다시 확인을 눌러주세요.",
        };
        job.data.failureError = r.error;
        job.rollbackPending = true;
        ctx.save();
        await rollback();
        return;
      }
      if (!job.data.prepared) {
        r.status = "preflight";
        ctx.save();
        r.dns_records = await p.prepare(ctx);
        job.data.prepared = true;
        ctx.save();
      }
      // Proxied Cloudflare CNAMEs are hidden from public DNS; the provider checks the exact zone record instead.
      const dns =
        job.config.kind === "cloudflare-tunnel"
          ? []
          : await this.dns(r.dns_records);
      r.checks = dns;
      if (dns.some((c) => !c.ok)) {
        wait("dns_pending");
        return;
      }
      r.status = "certificate_pending";
      ctx.save();
      if (!(await p.certificateReady(ctx))) {
        wait("certificate_pending");
        return;
      }
      if (!job.data.applied) {
        r.status = "applying";
        ctx.save();
        await p.apply(ctx);
        job.data.applied = true;
        ctx.save();
      }
      r.status = "verifying";
      ctx.save();
      try {
        const v = await verify(r, job.config.healthPath, false, this.check);
        Object.assign(r, {
          checks: [...dns, ...v.checks],
          certificate: v.certificate,
        });
      } catch (e) {
        // Caddy starts ACME after configuration. Other providers may need propagation after binding.
        job.data.verifyStarted ??= this.now();
        const allowance = job.config.kind === "caddy" ? 86_400_000 : 300_000;
        if (this.now() - job.data.verifyStarted < allowance) {
          wait(
            "certificate_pending",
            "HTTPS_PROPAGATING",
            "인증서·HTTPS 접속 준비를 기다리고 있습니다.",
          );
          return;
        }
        throw e;
      }
      if (!job.data.redirected) {
        await p.redirect(ctx);
        job.data.redirected = true;
        job.data.redirectStarted = this.now();
        ctx.save();
      }
      let v;
      try {
        v = await verify(r, job.config.healthPath, true, this.check);
      } catch (e) {
        if (this.now() - (job.data.redirectStarted ?? 0) < 120_000) {
          wait(
            "verifying",
            "REDIRECT_PROPAGATING",
            "리다이렉트 적용을 확인하고 있습니다.",
          );
          return;
        }
        throw e;
      }
      Object.assign(r, {
        status: "ready",
        https_url: "https://" + r.domain,
        checks: [...dns, ...v.checks],
        certificate: v.certificate,
        checked_at: new Date(this.now()).toISOString(),
        next_check_at: new Date(this.now() + 3_600_000).toISOString(),
      });
      delete r.error;
      job.data.everReady = true;
      ctx.save();
    } catch (e) {
      if (job.data.everReady) {
        r.status = "needs_action";
        r.error = {
          code: "GATE_RECOVERY_PENDING",
          message:
            "접근 차단 복구가 필요합니다. 게이트 재시도 중이며 기존 인증서는 유지합니다.",
        };
        r.next_check_at = new Date(this.now() + 30_000).toISOString();
        ctx.save();
        return;
      }
      if (e instanceof HttpsError && e.statusCode === 202) {
        wait(
          e.code === "DNS_PENDING" ? "dns_pending" : r.status,
          e.code,
          e.message,
        );
        return;
      }
      r.status = "failed";
      r.error =
        e instanceof HttpsError
          ? { code: e.code, message: e.message }
          : {
              code: "PROVIDER_FAILED",
              message:
                "설정에 실패했습니다. 전용 계정 권한과 리소스 연결을 확인하세요.",
            };
      job.data.failureError = r.error;
      job.rollbackPending = true;
      ctx.save();
      await rollback();
    } finally {
      this.busy.delete(id);
    }
  }
}
