"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/components/i18n";
import { API, MOCK, type ImagePlan as Plan, type ImageBuild as Build } from "@/lib/api";

const STATUS_KEY = { queued: "img.stQueued", building: "img.stBuilding", built: "img.stBuilt", failed: "img.stFailed" } as const;

export function ImageBuilder({projectId}:{projectId:string}) {
  const t=useT();
  const [runtime,setRuntime]=useState("");
  const [entrypoint,setEntrypoint]=useState("");
  const [plan,setPlan]=useState<Plan|null>(null);
  const [build,setBuild]=useState<Build|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const running=build?.status==="queued" || build?.status==="building";
  useEffect(()=>{
    if (!running || !build) return;
    const timer=setInterval(()=>{
      fetch(API+`/api/image-builds/${build.id}`,{cache:"no-store"}).then(async r=>{
        if (!r.ok) throw new Error(t("img.statusFail"));
        setBuild(await r.json());
      }).catch(e=>{setError(e.message);clearInterval(timer);});
    },1000);
    return ()=>clearInterval(timer);
  },[running,build?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function generate() {
    setBusy(true);setError("");setPlan(null);setBuild(null);
    try {
      const r=await fetch(API+`/api/projects/${projectId}/image-plans`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...(runtime?{runtime}:{}),...(entrypoint?{entrypoint}:{})})});
      const result=await r.json();if(!r.ok)throw new Error(result.detail??t("img.planFail"));setPlan(result);
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  async function startBuild() {
    if(!plan)return;setBusy(true);setError("");
    try{
      const r=await fetch(API+`/api/projects/${projectId}/image-plans/${plan.id}/build`,{method:"POST"});
      const result=await r.json();if(!r.ok)throw new Error(result.detail??t("img.buildFail"));setBuild(result);
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  if(MOCK)return null;
  const how=plan?t(plan.source==="existing"?"img.srcExisting":plan.source==="ai-fallback"?"img.srcAi":"img.srcRule"):"";
  return <section id="image-builder" className="panel panel-body space-y-4 scroll-mt-20">
    <div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold">{t("img.title")}</h2><Link href="/settings" className="text-sm text-accent hover:underline">{t("ui.aiSettings")}</Link></div>
    <p className="text-sm text-muted">{t("img.lead")}</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">{t("img.runtime")}<input value={runtime} onChange={e=>setRuntime(e.target.value)} placeholder={t("img.runtimePh")} className="mt-1 w-full rounded border border-line bg-bg p-2" /></label>
      <label className="text-sm">{t("img.entry")}<input value={entrypoint} onChange={e=>setEntrypoint(e.target.value)} placeholder={t("img.entryPh")} className="mt-1 w-full rounded border border-line bg-bg p-2" /></label>
    </div>
    <p className="text-xs text-muted">{t("img.note")}</p>
    <button disabled={busy||running} onClick={()=>void generate()} className="button secondary">{busy&&!plan?t("img.generating"):t("img.generate")}</button>
    {plan && <div className="space-y-3 border-t border-line pt-4">
      <p className="text-sm">{t("img.source",{how})}{plan.runtime?` / ${t("img.runtimeOf",{rt:plan.runtime})}`:""}</p>
      {plan.fallback_reason && <p className="text-xs text-muted">{t("img.fallback",{why:plan.fallback_reason})}</p>}
      <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-soft p-4 text-xs leading-relaxed"><code>{plan.dockerfile}</code></pre>
      <ul className="space-y-1 text-xs text-muted">{plan.warnings.map(w=><li key={w}>{w}</li>)}</ul>
      <button disabled={busy||!!build} onClick={()=>void startBuild()} className="button primary">{t("img.build")}</button>
    </div>}
    {build && <div role="status" className="border-t border-line pt-3 text-sm"><strong>{t(STATUS_KEY[build.status])}</strong><p className="mt-1 break-all font-mono text-xs">{build.image}</p>{build.error&&<p className="mt-2 text-bad">{build.error}</p>}</div>}
    {error&&<p role="alert" className="text-sm text-bad">{error}</p>}
  </section>;
}
