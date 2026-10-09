"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { API, MOCK, type ImagePlan as Plan, type ImageBuild as Build } from "@/lib/api";

export function ImageBuilder({projectId}:{projectId:string}) {
  const [ai,setAi]=useState(false);
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
        if (!r.ok) throw new Error("빌드 상태를 가져오지 못했습니다. 엔진을 재시작했다면 계획을 다시 생성하세요.");
        setBuild(await r.json());
      }).catch(e=>{setError(e.message);clearInterval(timer);});
    },1000);
    return ()=>clearInterval(timer);
  },[running,build?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function generate() {
    setBusy(true);setError("");setPlan(null);setBuild(null);
    try {
      const r=await fetch(API+`/api/projects/${projectId}/image-plans`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({use_ai:ai,...(runtime?{runtime}:{}),...(entrypoint?{entrypoint}:{})})});
      const result=await r.json();if(!r.ok)throw new Error(result.detail??"계획 생성 실패");setPlan(result);
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  async function startBuild() {
    if(!plan)return;setBusy(true);setError("");
    try{
      const r=await fetch(API+`/api/projects/${projectId}/image-plans/${plan.id}/build`,{method:"POST"});
      const result=await r.json();if(!r.ok)throw new Error(result.detail??"빌드 시작 실패");setBuild(result);
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  if(MOCK)return null;
  return <section id="image-builder" className="card p-5 space-y-4 scroll-mt-20">
    <div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold">Docker 이미지 만들기</h2><Link href="/settings" className="text-sm text-accent hover:underline">AI API 설정</Link></div>
    <p className="text-sm text-muted">기존 Dockerfile을 사용하거나 지원하는 스택에 맞춰 생성합니다. 원본 저장소를 수정하지 않으며, 이 작업은 배포 없이 이미지까지만 만듭니다.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">런타임 버전 (선택)<input value={runtime} onChange={e=>setRuntime(e.target.value)} placeholder="자동 감지 · 예: 21, 22, 3.12" className="mt-1 w-full rounded border border-line bg-bg p-2" /></label>
      <label className="text-sm">FastAPI 실행 대상 (선택)<input value={entrypoint} onChange={e=>setEntrypoint(e.target.value)} placeholder="예: main:app" className="mt-1 w-full rounded border border-line bg-bg p-2" /></label>
    </div>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={ai} onChange={e=>setAi(e.target.checked)} />Claude로 런타임·템플릿 선택 보조</label>
    {ai && <p className="text-xs text-muted">감지한 프레임워크·런타임·포트·FastAPI 실행 대상 이름만 Claude에 전송합니다. 원본 소스·README·환경변수 값은 보내지 않습니다. API 요금이 발생할 수 있습니다.</p>}
    <button disabled={busy||running} onClick={()=>void generate()} className="rounded-lg border border-accent px-4 py-2 text-accent disabled:opacity-50">{busy&&!plan?"계획 생성 중…":"빌드 계획 생성"}</button>
    {plan && <div className="space-y-3 border-t border-line pt-4">
      <p className="text-sm">생성 방식: {plan.source==="existing"?"기존 Dockerfile":plan.source==="ai-assisted"?"AI 보조 + 검증된 템플릿":"규칙 기반 템플릿"}{plan.runtime?` / 런타임 ${plan.runtime}`:""}</p>
      <pre className="max-h-80 overflow-auto rounded-lg bg-bg p-4 text-xs leading-relaxed"><code>{plan.dockerfile}</code></pre>
      <ul className="space-y-1 text-xs text-muted">{plan.warnings.map(w=><li key={w}>{w}</li>)}</ul>
      <button disabled={busy||!!build} onClick={()=>void startBuild()} className="rounded-lg bg-accent px-4 py-2 text-white disabled:opacity-50">확인한 계획으로 이미지 빌드</button>
    </div>}
    {build && <div role="status" className="border-t border-line pt-3 text-sm"><strong>{({queued:"대기 중",building:"이미지 빌드 중",built:"이미지 빌드 완료 · 앱 실행 미검증",failed:"이미지 빌드 실패"} as Record<string,string>)[build.status]}</strong><p className="mt-1 break-all font-mono text-xs">{build.image}</p>{build.error&&<p className="mt-2 text-bad">{build.error}</p>}</div>}
    {error&&<p role="alert" className="text-sm text-bad">{error}</p>}
  </section>;
}
