import type { Context, Provider, DnsRecord } from "../model.js";
import { HttpsError } from "../model.js";
import { isDeepStrictEqual } from "node:util";
import { aws, type IO } from "../io.js";
export class AwsProvider implements Provider {
  constructor(private io: IO) {}
  call(c: Context, s: string, a: string, args: string[] = []) {
    return aws(this.io, c.job.config, s, a, args);
  }
  async prepare(c: Context) {
    const cfg = c.job.config as any,
      d = c.job.data,
      name = c.job.result.domain;
    const identity = await this.call(c, "sts", "get-caller-identity");
    if (identity.Account !== cfg.accountId)
      throw new HttpsError(
        "ACCOUNT_MISMATCH",
        "AWS 전용 계정이 일치하지 않습니다.",
      );
    for (const arn of [
      cfg.loadBalancerArn,
      cfg.listenerArn,
      cfg.targetGroupArn,
      cfg.gateRuleArn,
    ].filter(Boolean))
      if (
        arn.split(":")[4] !== cfg.accountId ||
        arn.split(":")[3] !== cfg.region
      )
        throw new HttpsError(
          "RESOURCE_MISMATCH",
          "AWS 리소스 계정·리전 불일치",
        );
    const lb = (
      await this.call(c, "elbv2", "describe-load-balancers", [
        "--load-balancer-arns",
        cfg.loadBalancerArn,
      ])
    ).LoadBalancers[0];
    if (
      !lb ||
      lb.Scheme !== "internet-facing" ||
      !lb.SecurityGroups.includes(cfg.securityGroupId)
    )
      throw new HttpsError(
        "RESOURCE_REQUIRED",
        "등록된 공개 ALB와 보안그룹을 확인하세요.",
        422,
      );
    const listeners = (
      await this.call(c, "elbv2", "describe-listeners", [
        "--load-balancer-arn",
        cfg.loadBalancerArn,
      ])
    ).Listeners;
    const http = listeners.find(
      (x: any) =>
        x.ListenerArn === cfg.listenerArn &&
        x.Port === 80 &&
        x.Protocol === "HTTP",
    );
    if (!http)
      throw new HttpsError(
        "RESOURCE_REQUIRED",
        "기존 HTTP 80 리스너가 필요합니다.",
        422,
      );
    const https = listeners.find((x: any) => x.Port === 443);
    if (https && https.ListenerArn !== d.httpsListener) {
      const tags = (
        await this.call(c, "elbv2", "describe-tags", [
          "--resource-arns",
          https.ListenerArn,
        ])
      ).TagDescriptions[0].Tags;
      if (
        !d.listenerIntent ||
        !tags.some(
          (t: any) =>
            t.Key === "ShakedownHttps" && t.Value === c.job.result.binding_id,
        )
      )
        throw new HttpsError(
          "RESOURCE_CONFLICT",
          "기존 443 리스너를 덮어쓰지 않습니다.",
          409,
        );
      d.httpsListener = https.ListenerArn;
      c.save();
    }
    const rules = (
      await this.call(c, "elbv2", "describe-rules", [
        "--listener-arn",
        cfg.listenerArn,
      ])
    ).Rules;
    if (rules.some((r: any) => !r.IsDefault && r.RuleArn !== cfg.gateRuleArn))
      throw new HttpsError(
        "RESOURCE_CONFLICT",
        "프로젝트 전용 HTTP 리스너만 지원합니다.",
        409,
      );
    if (
      cfg.gateRuleArn &&
      !rules.some((r: any) => r.RuleArn === cfg.gateRuleArn)
    )
      throw new HttpsError(
        "RESOURCE_MISMATCH",
        "GateRuleArn이 등록된 리스너에 없습니다.",
      );
    if (cfg.gateRuleArn) {
      const gate = rules.find((r: any) => r.RuleArn === cfg.gateRuleArn);
      const conditions = gate.Conditions ?? [];
      const ips = conditions[0]?.SourceIpConfig?.Values ?? [];
      // The default forward keeps ECS associated with the ALB. It is safe only
      // behind a rule matching every IPv4 and IPv6 client, before all defaults.
      if (gate.IsDefault || String(gate.Priority) !== "1" ||
          conditions.length !== 1 || conditions[0].Field !== "source-ip" ||
          ips.length !== 2 || !ips.includes("0.0.0.0/0") || !ips.includes("::/0") ||
          http.DefaultActions.length !== 1 || http.DefaultActions[0].Type !== "forward" ||
          (http.DefaultActions[0].TargetGroupArn !== cfg.targetGroupArn &&
           !(http.DefaultActions[0].ForwardConfig?.TargetGroups?.length === 1 &&
             http.DefaultActions[0].ForwardConfig.TargetGroups[0].TargetGroupArn === cfg.targetGroupArn)))
        throw new HttpsError("RESOURCE_CONFLICT", "전체 IPv4/IPv6를 제어하는 우선순위 1 게이트와 기존 대상 그룹 연결이 필요합니다.", 409);
    }
    if (!d.httpActions) {
      d.httpActions = http.DefaultActions;
      d.gateActions = cfg.gateRuleArn
        ? (
            await this.call(c, "elbv2", "describe-rules", [
              "--rule-arns",
              cfg.gateRuleArn,
            ])
          ).Rules[0].Actions
        : http.DefaultActions;
      if (
        !d.gateActions.every(
          (a: any) =>
            a.Type === "fixed-response" ||
            (a.Type === "forward" &&
              (a.TargetGroupArn === cfg.targetGroupArn ||
                (a.ForwardConfig?.TargetGroups?.length === 1 &&
                  a.ForwardConfig.TargetGroups[0].TargetGroupArn ===
                    cfg.targetGroupArn))),
        )
      )
        throw new HttpsError(
          "RESOURCE_CONFLICT",
          "지원하지 않는 기존 리스너 동작입니다.",
          409,
        );
      if (new URL(cfg.originUrl).hostname !== lb.DNSName)
        throw new HttpsError(
          "RESOURCE_MISMATCH",
          "ALB 원본 주소가 설정과 다릅니다.",
        );
      d.lbDns = lb.DNSName;
      c.save();
    }
    if (!d.certificateArn) {
      const r = await this.call(c, "acm", "request-certificate", [
        "--domain-name",
        name,
        "--validation-method",
        "DNS",
        "--idempotency-token",
        c.job.result.binding_id.slice(4, 36),
        "--tags",
        "Key=ShakedownHttps,Value=" + c.job.result.binding_id,
      ]);
      d.certificateArn = r.CertificateArn;
      c.save();
    }
    const cert = (
      await this.call(c, "acm", "describe-certificate", [
        "--certificate-arn",
        d.certificateArn,
      ])
    ).Certificate;
    if (
      ["FAILED", "REVOKED", "EXPIRED", "VALIDATION_TIMED_OUT"].includes(
        cert.Status,
      )
    )
      throw new HttpsError(
        "CERTIFICATE_FAILED",
        "ACM 인증서 상태: " + cert.Status,
        422,
      );
    const dns: DnsRecord[] = [
      { type: "CNAME", name, value: d.lbDns, purpose: "routing" },
    ];
    for (const v of cert.DomainValidationOptions ?? [])
      if (v.ResourceRecord)
        dns.push({
          type: "CNAME",
          name: v.ResourceRecord.Name,
          value: v.ResourceRecord.Value,
          purpose: "ownership",
          note: "자동 갱신을 위해 유지하세요.",
        });
    // ACM may take a few seconds to return validation records.
    if (dns.length < 2)
      throw new HttpsError(
        "CERTIFICATE_PREPARING",
        "ACM DNS 검증 레코드를 준비하고 있습니다.",
        202,
      );
    return dns;
  }
  async certificateReady(c: Context) {
    const status = (
      await this.call(c, "acm", "describe-certificate", [
        "--certificate-arn",
        c.job.data.certificateArn,
      ])
    ).Certificate.Status;
    if (
      ["FAILED", "REVOKED", "EXPIRED", "VALIDATION_TIMED_OUT"].includes(status)
    )
      throw new HttpsError(
        "CERTIFICATE_FAILED",
        "ACM 인증서 발급 실패 또는 만료",
        422,
      );
    return status === "ISSUED";
  }
  async apply(c: Context) {
    const cfg = c.job.config as any,
      d = c.job.data;
    if (!d.sgRuleId) {
      const sg = (
        await this.call(c, "ec2", "describe-security-group-rules", [
          "--filters",
          "Name=group-id,Values=" + cfg.securityGroupId,
        ])
      ).SecurityGroupRules;
      const permits = sg.some(
        (r: any) =>
          !r.IsEgress &&
          r.CidrIpv4 === "0.0.0.0/0" &&
          (r.IpProtocol === "-1" ||
            (r.IpProtocol === "tcp" && r.FromPort <= 443 && r.ToPort >= 443)),
      );
      const owned = sg.find(
        (r: any) => r.Description === c.job.result.binding_id,
      );
      if (d.sgIntent && owned) {
        d.sgRuleId = owned.SecurityGroupRuleId;
        c.save();
      } else if (!permits) {
        // Persist intent first; recovery discovers this uniquely tagged rule.
        d.sgIntent = true;
        c.save();
        const r = owned
          ? { SecurityGroupRules: [owned] }
          : await this.call(c, "ec2", "authorize-security-group-ingress", [
              "--group-id",
              cfg.securityGroupId,
              "--ip-permissions",
              JSON.stringify([
                {
                  IpProtocol: "tcp",
                  FromPort: 443,
                  ToPort: 443,
                  IpRanges: [
                    {
                      CidrIp: "0.0.0.0/0",
                      Description: c.job.result.binding_id,
                    },
                  ],
                },
              ]),
            ]);
        d.sgRuleId = r.SecurityGroupRules[0].SecurityGroupRuleId;
        c.save();
      }
    }
    if (!d.httpsListener) {
      d.listenerIntent = true;
      c.save();
      const all = (
        await this.call(c, "elbv2", "describe-listeners", [
          "--load-balancer-arn",
          cfg.loadBalancerArn,
        ])
      ).Listeners;
      let listener = all.find((x: any) => x.Port === 443);
      if (listener) {
        const tags = (
          await this.call(c, "elbv2", "describe-tags", [
            "--resource-arns",
            listener.ListenerArn,
          ])
        ).TagDescriptions[0].Tags;
        if (
          !tags.some(
            (t: any) =>
              t.Key === "ShakedownHttps" && t.Value === c.job.result.binding_id,
          )
        )
          throw new HttpsError(
            "RESOURCE_CONFLICT",
            "다른 443 리스너와 충돌합니다.",
            409,
          );
      } else {
        const current = cfg.gateRuleArn
          ? (
              await this.call(c, "elbv2", "describe-rules", [
                "--rule-arns",
                cfg.gateRuleArn,
              ])
            ).Rules[0].Actions
          : (
              await this.call(c, "elbv2", "describe-listeners", [
                "--listener-arns",
                cfg.listenerArn,
              ])
            ).Listeners[0].DefaultActions;
        if (current.some((a: any) => a.Type !== "forward"))
          throw new HttpsError(
            "TARGET_NOT_READY",
            "기존 배포 게이트가 열려야 HTTPS 설정을 진행할 수 있습니다.",
            202,
          );
        listener = (
          await this.call(c, "elbv2", "create-listener", [
            "--load-balancer-arn",
            cfg.loadBalancerArn,
            "--port",
            "443",
            "--protocol",
            "HTTPS",
            "--ssl-policy",
            "ELBSecurityPolicy-TLS13-1-2-2021-06",
            "--certificates",
            "CertificateArn=" + d.certificateArn,
            "--default-actions",
            JSON.stringify(current),
            "--tags",
            "Key=ShakedownHttps,Value=" + c.job.result.binding_id,
          ])
        ).Listeners[0];
      }
      d.httpsListener = listener.ListenerArn;
      c.save();
    }
  }
  async redirect(c: Context) {
    const cfg = c.job.config as any;
    // The HTTP listener is project-dedicated. Existing gate rules must be changed too.
    c.job.data.redirectIntent = true;
    c.save();
    const actions = [
      {
        Type: "redirect",
        RedirectConfig: {
          Protocol: "HTTPS",
          Port: "443",
          Host: c.job.result.domain,
          Path: "/#{path}",
          Query: "#{query}",
          StatusCode: "HTTP_301",
        },
      },
    ];
    c.job.data.redirectActions = actions;
    c.save();
    if (cfg.gateRuleArn)
      await this.call(c, "elbv2", "modify-rule", [
        "--rule-arn",
        cfg.gateRuleArn,
        "--actions",
        JSON.stringify(actions),
      ]);
    if (!cfg.gateRuleArn) await this.call(c, "elbv2", "modify-listener", [
      "--listener-arn",
      cfg.listenerArn,
      "--default-actions",
      JSON.stringify(actions),
    ]);
  }
  async gate(c: Context, open: boolean) {
    const cfg = c.job.config as any,
      d = c.job.data;
    if (!d.httpsListener)
      throw new HttpsError(
        "HTTPS_NOT_READY",
        "HTTPS 리스너가 아직 준비되지 않았습니다.",
        409,
      );
    const actions = open
      ? [{ Type: "forward", TargetGroupArn: cfg.targetGroupArn }]
      : [
          {
            Type: "fixed-response",
            FixedResponseConfig: {
              StatusCode: "403",
              ContentType: "text/plain",
              MessageBody: "Shakedown: deployment unavailable",
            },
          },
        ];
    await this.call(c, "elbv2", "modify-listener", [
      "--listener-arn",
      d.httpsListener,
      "--default-actions",
      JSON.stringify(actions),
    ]);
    if (open) await this.redirect(c);
    else {
      if (cfg.gateRuleArn)
        await this.call(c, "elbv2", "modify-rule", [
          "--rule-arn",
          cfg.gateRuleArn,
          "--actions",
          JSON.stringify(actions),
        ]);
      if (!cfg.gateRuleArn) await this.call(c, "elbv2", "modify-listener", [
        "--listener-arn",
        cfg.listenerArn,
        "--default-actions",
        JSON.stringify(actions),
      ]);
    }
    d.gateClosed = !open;
    c.save();
  }
  async rollback(c: Context) {
    const cfg = c.job.config as any,
      d = c.job.data;
    if (d.redirectIntent) {
      const current = (
        await this.call(c, "elbv2", "describe-listeners", [
          "--listener-arns",
          cfg.listenerArn,
        ])
      ).Listeners[0].DefaultActions;
      const own =
        current.length === 1 &&
        current[0].Type === "redirect" &&
        isDeepStrictEqual(
          current[0].RedirectConfig,
          d.redirectActions?.[0].RedirectConfig,
        );
      if (!own && !isDeepStrictEqual(current, d.httpActions))
        throw new HttpsError(
          "ROLLBACK_CONFLICT",
          "HTTP 리스너가 외부에서 변경되어 자동 복원을 중단합니다.",
          409,
        );
      if (cfg.gateRuleArn) {
        const ruleActions = (
          await this.call(c, "elbv2", "describe-rules", [
            "--rule-arns",
            cfg.gateRuleArn,
          ])
        ).Rules[0].Actions;
        const ownRule =
          ruleActions.length === 1 &&
          ruleActions[0].Type === "redirect" &&
          isDeepStrictEqual(
            ruleActions[0].RedirectConfig,
            d.redirectActions?.[0].RedirectConfig,
          );
        if (!ownRule && !isDeepStrictEqual(ruleActions, d.gateActions))
          throw new HttpsError(
            "ROLLBACK_CONFLICT",
            "게이트 규칙이 외부에서 변경되어 자동 복원을 중단합니다.",
            409,
          );
        await this.call(c, "elbv2", "modify-rule", [
          "--rule-arn",
          cfg.gateRuleArn,
          "--actions",
          JSON.stringify(d.gateActions),
        ]);
      }
      if (!cfg.gateRuleArn) await this.call(c, "elbv2", "modify-listener", [
        "--listener-arn",
        cfg.listenerArn,
        "--default-actions",
        JSON.stringify(d.httpActions),
      ]);
      d.redirectIntent = false;
      c.save();
    }
    if (d.listenerIntent) {
      const all = (
        await this.call(c, "elbv2", "describe-listeners", [
          "--load-balancer-arn",
          cfg.loadBalancerArn,
        ])
      ).Listeners;
      const listener = all.find((x: any) => x.Port === 443);
      if (listener) {
        const tags = (
          await this.call(c, "elbv2", "describe-tags", [
            "--resource-arns",
            listener.ListenerArn,
          ])
        ).TagDescriptions[0].Tags;
        if (
          !tags.some(
            (t: any) =>
              t.Key === "ShakedownHttps" && t.Value === c.job.result.binding_id,
          )
        )
          throw new HttpsError(
            "ROLLBACK_CONFLICT",
            "443 소유권이 변경됐습니다.",
            409,
          );
        await this.call(c, "elbv2", "delete-listener", [
          "--listener-arn",
          listener.ListenerArn,
        ]);
      }
      delete d.httpsListener;
      d.listenerIntent = false;
      c.save();
    }
    if (d.sgIntent) {
      const rules = (
        await this.call(c, "ec2", "describe-security-group-rules", [
          "--filters",
          "Name=group-id,Values=" + cfg.securityGroupId,
        ])
      ).SecurityGroupRules;
      const owned = rules.find(
        (x: any) => x.Description === c.job.result.binding_id,
      );
      if (owned)
        await this.call(c, "ec2", "revoke-security-group-ingress", [
          "--group-id",
          cfg.securityGroupId,
          "--security-group-rule-ids",
          owned.SecurityGroupRuleId,
        ]);
      delete d.sgRuleId;
      d.sgIntent = false;
      c.save();
    }
    // Keep the requested certificate and DNS authorization for retry/renewal; never delete existing certificates.
  }
}
