"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { API, MOCK, type ArchitecturePlan, type ArchitectureRequest, type ArchitectureTier } from "@/lib/api";

const defaults: ArchitectureRequest = {workload:"auto",peak_rps:null,availability:"unknown",traffic:"unknown",priority:"balanced",use_ai:true};
const inputClass="mt-1 w-full rounded border border-line bg-bg p-2 focus-visible:outline-2 focus-visible:outline-accent";

export function ArchitecturePlanner({projectId}:{projectId:string}) {
  const router=useRouter();
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
      if(!r.ok)throw new Error("저장된 설계안을 가져오지 못했습니다.");
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
      const data=await r.json();if(!r.ok)throw new Error(data.detail??"아키텍처 판단 실패");
      setPlan(data);setDirty(false);
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  async function deploySelected(){
    if(!plan)return;
    setBusy(true);setError("");
    try{
      const r=await fetch(API+`/api/projects/${projectId}/deployments`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({targets:["aws"],architecture_plan_id:plan.id})});
      const data=await r.json();if(!r.ok)throw new Error(data.detail??"배포 시작 실패");
      router.push(`/deployments/${data.id}`);
    }catch(e){setError(e instanceof Error?e.message:String(e));setBusy(false);}
  }
  if(MOCK)return null;
  return <section id="architecture-planner" className="card p-5 space-y-5 scroll-mt-20">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold text-lg">AWS 아키텍처 판단</h2><Link href="/settings" className="text-sm text-accent hover:underline">AI API 설정</Link></div>
    <p className="max-w-3xl text-sm text-muted">저장소의 구조와 운영 요구를 함께 보고 소·중·대 설계안을 비교합니다. 현재는 HTTP 컨테이너 서비스용 설계 판단을 지원하며, 선택을 저장한 뒤 아래 배포 버튼으로 해당 구성을 AWS에 적용할 수 있습니다. 선택 저장만으로는 과금 자원을 변경하지 않습니다.</p>
    <fieldset disabled={busy||loading} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 disabled:opacity-60">
      <legend className="sr-only">운영 요구</legend>
      <label className="text-sm">서비스 형태<select className={inputClass} value={form.workload} onChange={e=>change({workload:e.target.value as ArchitectureRequest['workload']})}>
        <option value="auto">코드에서 감지</option><option value="http">HTTP 앱 / API</option><option value="worker">백그라운드 워커</option><option value="batch">배치 작업</option><option value="static">정적 사이트</option>
      </select></label>
      <label className="text-sm">예상 피크 요청 수 (RPS)<input type="number" min={0} max={10000000} step={1} className={inputClass} value={form.peak_rps??""} placeholder="모르면 비워 두세요" onChange={e=>change({peak_rps:e.target.value===""?null:Number(e.target.value)})} /></label>
      <label className="text-sm">가용성 요구<select className={inputClass} value={form.availability} onChange={e=>change({availability:e.target.value as ArchitectureRequest['availability']})}>
        <option value="unknown">미정</option><option value="best_effort">일시 중단 허용 / 데모</option><option value="high">다중 AZ 필요</option>
      </select></label>
      <label className="text-sm">트래픽 변화<select className={inputClass} value={form.traffic} onChange={e=>change({traffic:e.target.value as ArchitectureRequest['traffic']})}>
        <option value="unknown">미정</option><option value="steady">비교적 일정</option><option value="bursty">급증 가능</option>
      </select></label>
      <label className="text-sm">우선순위<select className={inputClass} value={form.priority} onChange={e=>change({priority:e.target.value as ArchitectureRequest['priority']})}>
        <option value="balanced">균형</option><option value="cost">비용</option><option value="availability">가용성</option>
      </select></label>
      <label className="flex items-center gap-2 text-sm self-end pb-2"><input type="checkbox" checked={form.use_ai} onChange={e=>change({use_ai:e.target.checked})}/>연결된 Claude로 판단</label>
    </fieldset>
    <div className="space-y-2"><button disabled={busy||loading} onClick={()=>void request()} className="rounded-lg bg-accent text-white px-4 py-2 text-sm disabled:opacity-50">{busy?"처리 중…":"아키텍처 판단하기"}</button>
      <p className="text-xs text-muted">AI 연결 시 요청당 1회 호출하며 요금이 발생할 수 있습니다. 운영 입력과 스택·DB·의존성·README 키워드 등 추출 정보만 전송합니다. 미연결 시 규칙 판단을 사용합니다.</p></div>
    {error&&<p role="alert" className="text-sm text-bad">{error}</p>}
    {plan&&<div className="space-y-4 border-t border-line pt-4">
      <div role="status" className="flex flex-wrap justify-between gap-2 text-sm"><strong>{plan.selected_template?`저장한 설계: ${plan.templates.find(t=>t.id===plan.selected_template)?.name}`:plan.recommended_template?`추천: ${plan.templates.find(t=>t.id===plan.recommended_template)?.name}`:"추가 설계가 필요합니다"}</strong><span className="text-muted">{plan.source==="ai"?"Claude 판단":"규칙 판단"} · {new Date(plan.created*1000).toLocaleString("ko-KR")}</span></div>
      {dirty&&<p className="text-sm text-warn">운영 입력이 바뀌었습니다. 아래 결과는 이전 입력 기준이며, 다시 판단해야 선택할 수 있습니다.</p>}
      <ul className="text-sm space-y-1">{plan.reasons.map((r,i)=><li key={i}>{r}</li>)}</ul>
      {plan.assessment.missing_inputs.length>0&&<div className="border-l-2 border-warn pl-3 text-sm"><strong>확인할 운영 요구</strong><ul>{plan.assessment.missing_inputs.map(x=><li key={x}>{x}</li>)}</ul></div>}
      {plan.assessment.blockers.length>0&&<div className="border-l-2 border-bad pl-3 text-sm"><strong>현재 설계 적용을 막는 항목</strong><ul>{plan.assessment.blockers.map(x=><li key={x}>{x}</li>)}</ul></div>}
      <div className="overflow-x-auto"><table className="w-full min-w-[660px] text-sm text-left"><caption className="text-left text-xs text-muted pb-2">ALB와 ECS Fargate 기반 초기 설계안 · CPU/메모리/확장 수치는 부하 테스트 전 가정</caption><thead><tr className="border-b border-line"><th className="p-2">구성</th>{plan.templates.map(t=><th className="p-2" key={t.id}>{t.name}{plan.recommended_template===t.id&&<span className="ml-2 text-accent">추천</span>}</th>)}</tr></thead>
        <tbody>
          <tr className="border-b border-line"><th className="p-2 font-normal text-muted">태스크당 자원</th>{plan.templates.map(t=><td className="p-2" key={t.id}>{t.cpu/1024} vCPU / {t.memory_mib/1024} GiB</td>)}</tr>
          <tr className="border-b border-line"><th className="p-2 font-normal text-muted">태스크 / AZ</th>{plan.templates.map(t=><td className="p-2" key={t.id}>{t.min_tasks}–{t.max_tasks}개 / {t.availability_zones} AZ</td>)}</tr>
          <tr className="border-b border-line"><th className="p-2 font-normal text-muted">확장</th>{plan.templates.map(t=><td className="p-2" key={t.id}>{t.autoscaling?"CPU 목표 추적 자동 확장":"고정 용량"}</td>)}</tr>
          <tr className="border-b border-line"><th className="p-2 font-normal text-muted">데이터 계층</th>{plan.templates.map(t=><td className="p-2 align-top" key={t.id}>{t.database}</td>)}</tr>
          <tr className="border-b border-line"><th className="p-2 font-normal text-muted">검토 사항</th>{plan.templates.map(t=><td className="p-2 align-top text-xs text-muted max-w-64" key={t.id}>{t.tradeoff}</td>)}</tr>
          <tr><th className="p-2 font-normal text-muted">설계안 저장</th>{plan.templates.map(t=><td className="p-2" key={t.id}><button disabled={busy||loading||dirty||!!plan.assessment.blockers.length||!!plan.assessment.missing_inputs.length||!plan.assessment.eligible_templates.includes(t.id)} onClick={()=>void request(t.id)} className="rounded border border-accent px-3 py-2 text-accent disabled:opacity-40">{plan.selected_template===t.id?"선택됨":"이 설계 선택"}</button></td>)}</tr>
        </tbody></table></div>
      <p className="text-sm text-muted">{plan.deployment.reason}</p>
      {plan.selected_template&&<div className="space-y-2"><button disabled={busy||dirty||!plan.deployment.ready} onClick={()=>void deploySelected()} className="rounded-lg bg-accent px-4 py-2 text-sm text-white disabled:opacity-40">{busy?"배포 준비 중…":`${plan.selected_template} 구성으로 AWS 배포`}</button><p className="text-xs text-muted">기존 앱 배포를 교체합니다. 관리형 PostgreSQL을 사용하는 경우 RDS 가용성도 변경합니다. 배포 준비 중 접근이 중단되며 AWS 요금이 발생합니다. 배포 중지는 앱을 멈추지만 DB와 기반 스택은 유지합니다.</p></div>}
      <details className="text-xs text-muted"><summary className="cursor-pointer">분석 근거와 주의사항</summary><ul className="mt-2 space-y-1">{plan.assessment.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul><p className="mt-2">감지 스택: {plan.facts.stack} / 서비스 형태: {plan.facts.workload}</p><ul className="mt-2 space-y-1">{plan.facts.evidence.map(e=><li key={e.id}>{e.id}: {JSON.stringify(e.value)} ({e.source})</li>)}</ul></details>
    </div>}
  </section>;
}
