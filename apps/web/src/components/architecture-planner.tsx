"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/components/i18n";
import { API, MOCK, type ArchitecturePlan, type ArchitectureRequest, type ArchitectureTier } from "@/lib/api";

const defaults: ArchitectureRequest = {workload:"auto",peak_rps:null,availability:"unknown",traffic:"unknown",priority:"balanced",use_ai:true};
const inputClass="mt-1 w-full rounded border border-line bg-bg p-2 focus-visible:outline-2 focus-visible:outline-accent";

export function ArchitecturePlanner({projectId}:{projectId:string}) {
  const router=useRouter();
  const t=useT();
  // Error text only; kept in a ref so switching language does not refetch and discard the draft.
  const tRef=useRef(t);useEffect(()=>{tRef.current=t;},[t]);
  const [form,setForm]=useState<ArchitectureRequest>(defaults);
  const [plan,setPlan]=useState<ArchitecturePlan|null>(null);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [dirty,setDirty]=useState(false);
  useEffect(()=>{
    if(MOCK)return;
    let active=true;setLoading(true);setPlan(null);
    fetch(API+`/api/projects/${projectId}/architecture-plans/latest`,{cache:"no-store"}).then(async r=>{
      if(!r.ok)throw new Error(tRef.current("arch.loadError"));
      const data: ArchitecturePlan|null=await r.json();
      if(active && data){setPlan(data);setForm(data.requirements);setDirty(false);}
    }).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[projectId]);
  function change(patch:Partial<ArchitectureRequest>){setForm(p=>({...p,...patch}));setDirty(true);}
  async function request(tier?:ArchitectureTier){
    setBusy(true);setError("");
    try{
      const suffix=tier&&plan?`/${plan.id}/select`:"";
      const r=await fetch(API+`/api/projects/${projectId}/architecture-plans`+suffix,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(tier?{template_id:tier}:form)});
      const data=await r.json();if(!r.ok)throw new Error(data.detail??t("arch.failed"));
      setPlan(data);setDirty(false);
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  async function deploySelected(){
    if(!plan)return;
    setBusy(true);setError("");
    try{
      const r=await fetch(API+`/api/projects/${projectId}/deployments`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({targets:["aws"],architecture_plan_id:plan.id})});
      const data=await r.json();if(!r.ok)throw new Error(data.detail??t("arch.deployFailed"));
      router.push(`/deployments/${data.id}`);
    }catch(e){setError(e instanceof Error?e.message:String(e));setBusy(false);}
  }
  if(MOCK)return null;
  const name=(id:ArchitectureTier|null)=>plan?.templates.find(x=>x.id===id)?.name??"";
  return <section id="architecture-planner" className="panel panel-body space-y-5 scroll-mt-20">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold text-lg">{t("arch.title")}</h2><Link href="/settings" className="text-sm text-accent hover:underline">{t("ui.aiSettings")}</Link></div>
    <p className="max-w-3xl text-sm text-muted">{t("arch.lead")}</p>
    <fieldset disabled={busy||loading} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 disabled:opacity-60">
      <legend className="sr-only">{t("arch.title")}</legend>
      <label className="text-sm">{t("arch.workload")}<select className={inputClass} value={form.workload} onChange={e=>change({workload:e.target.value as ArchitectureRequest['workload']})}>
        <option value="auto">{t("arch.wAuto")}</option><option value="http">{t("arch.wHttp")}</option><option value="worker">{t("arch.wWorker")}</option><option value="batch">{t("arch.wBatch")}</option><option value="static">{t("arch.wStatic")}</option>
      </select></label>
      <label className="text-sm">{t("arch.rps")}<input type="number" min={0} max={10000000} step={1} className={inputClass} value={form.peak_rps??""} placeholder={t("arch.rpsPh")} onChange={e=>change({peak_rps:e.target.value===""?null:Number(e.target.value)})} /></label>
      <label className="text-sm">{t("arch.avail")}<select className={inputClass} value={form.availability} onChange={e=>change({availability:e.target.value as ArchitectureRequest['availability']})}>
        <option value="unknown">{t("arch.unknown")}</option><option value="best_effort">{t("arch.aBest")}</option><option value="high">{t("arch.aHigh")}</option>
      </select></label>
      <label className="text-sm">{t("arch.traffic")}<select className={inputClass} value={form.traffic} onChange={e=>change({traffic:e.target.value as ArchitectureRequest['traffic']})}>
        <option value="unknown">{t("arch.unknown")}</option><option value="steady">{t("arch.tSteady")}</option><option value="bursty">{t("arch.tBursty")}</option>
      </select></label>
      <label className="text-sm">{t("arch.priority")}<select className={inputClass} value={form.priority} onChange={e=>change({priority:e.target.value as ArchitectureRequest['priority']})}>
        <option value="balanced">{t("arch.pBalanced")}</option><option value="cost">{t("arch.pCost")}</option><option value="availability">{t("arch.pAvail")}</option>
      </select></label>
      <label className="flex items-center gap-2 text-sm self-end pb-2"><input type="checkbox" checked={form.use_ai} onChange={e=>change({use_ai:e.target.checked})}/>{t("arch.useAi")}</label>
    </fieldset>
    <div className="space-y-2"><button disabled={busy||loading} onClick={()=>void request()} className="button primary">{busy?t("arch.busy"):t("arch.run")}</button>
      <p className="text-xs text-muted">{t("arch.costNote")}</p></div>
    {error&&<p role="alert" className="text-sm text-bad">{error}</p>}
    {plan&&<div className="space-y-4 border-t border-line pt-4">
      <div role="status" className="flex flex-wrap justify-between gap-2 text-sm"><strong>{plan.selected_template?t("arch.saved",{name:name(plan.selected_template)}):plan.recommended_template?t("arch.recommended",{name:name(plan.recommended_template)}):t("arch.needsMore")}</strong><span className="text-muted">{t(plan.source==="ai"?"arch.byAi":"arch.byRule")} · {new Date(plan.created*1000).toLocaleString(t.locale)}</span></div>
      {dirty&&<p className="text-sm text-warn">{t("arch.dirty")}</p>}
      <ul className="text-sm space-y-1">{plan.reasons.map((r,i)=><li key={i}>{r}</li>)}</ul>
      {plan.assessment.missing_inputs.length>0&&<div className="border-l-2 border-warn pl-3 text-sm"><strong>{t("arch.missing")}</strong><ul>{plan.assessment.missing_inputs.map(x=><li key={x}>{x}</li>)}</ul></div>}
      {plan.assessment.blockers.length>0&&<div className="border-l-2 border-bad pl-3 text-sm"><strong>{t("arch.blockers")}</strong><ul>{plan.assessment.blockers.map(x=><li key={x}>{x}</li>)}</ul></div>}
      <div className="overflow-x-auto"><table className="w-full min-w-[660px] text-sm text-left"><caption className="text-left text-xs text-muted pb-2">{t("arch.caption")}</caption><thead><tr className="border-b border-line"><th className="p-2">{t("arch.col")}</th>{plan.templates.map(x=><th className="p-2" key={x.id}>{x.name}{plan.recommended_template===x.id&&<span className="ml-2 text-accent">{t("arch.tag")}</span>}</th>)}</tr></thead>
        <tbody>
          <tr className="border-b border-line"><th className="p-2 font-normal text-muted">{t("arch.rowRes")}</th>{plan.templates.map(x=><td className="p-2" key={x.id}>{x.cpu/1024} vCPU / {x.memory_mib/1024} GiB</td>)}</tr>
          <tr className="border-b border-line"><th className="p-2 font-normal text-muted">{t("arch.rowTasks")}</th>{plan.templates.map(x=><td className="p-2" key={x.id}>{t("arch.tasksVal",{min:x.min_tasks,max:x.max_tasks,az:x.availability_zones})}</td>)}</tr>
          <tr className="border-b border-line"><th className="p-2 font-normal text-muted">{t("arch.rowScale")}</th>{plan.templates.map(x=><td className="p-2" key={x.id}>{t(x.autoscaling?"arch.autoscale":"arch.fixed")}</td>)}</tr>
          <tr className="border-b border-line"><th className="p-2 font-normal text-muted">{t("arch.rowData")}</th>{plan.templates.map(x=><td className="p-2 align-top" key={x.id}>{x.database}</td>)}</tr>
          <tr className="border-b border-line"><th className="p-2 font-normal text-muted">{t("arch.rowReview")}</th>{plan.templates.map(x=><td className="p-2 align-top text-xs text-muted max-w-64" key={x.id}>{x.tradeoff}</td>)}</tr>
          <tr><th className="p-2 font-normal text-muted">{t("arch.rowSelect")}</th>{plan.templates.map(x=><td className="p-2" key={x.id}><button disabled={busy||loading||dirty||!!plan.assessment.blockers.length||!!plan.assessment.missing_inputs.length||!plan.assessment.eligible_templates.includes(x.id)} onClick={()=>void request(x.id)} className="button secondary">{plan.selected_template===x.id?t("arch.chosen"):t("arch.choose")}</button></td>)}</tr>
        </tbody></table></div>
      <p className="text-sm text-muted">{plan.deployment.reason}</p>
      {plan.selected_template&&<div className="space-y-2"><button disabled={busy||dirty||!plan.deployment.ready} onClick={()=>void deploySelected()} className="button primary">{busy?t("arch.deploying"):t("arch.deploy",{tier:plan.selected_template})}</button><p className="text-xs text-muted">{t("arch.deployNote")}</p></div>}
      <details className="text-xs text-muted"><summary className="cursor-pointer">{t("arch.details")}</summary><ul className="mt-2 space-y-1">{plan.assessment.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul><p className="mt-2">{t("arch.facts",{stack:plan.facts.stack,workload:plan.facts.workload})}</p><ul className="mt-2 space-y-1">{plan.facts.evidence.map(e=><li key={e.id}>{e.id}: {JSON.stringify(e.value)} ({e.source})</li>)}</ul></details>
    </div>}
  </section>;
}
