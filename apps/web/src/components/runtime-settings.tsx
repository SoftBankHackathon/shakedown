"use client";
import {useState} from "react";
import {API,MOCK,type Project} from "@/lib/api";
import type {HttpRuntime} from "@shakedown/contracts";

const field="mt-1 w-full rounded border border-line bg-bg p-2";
export function RuntimeSettings({project,onSaved}:{project:Project;onSaved:(p:Project)=>void}) {
  const initial=project.runtime;
  const [port,setPort]=useState(initial?.port??project.analysis.port);
  const [health,setHealth]=useState(initial?.health_path??project.analysis.health_path);
  const [mode,setMode]=useState<HttpRuntime['database']['mode']>(initial?.database.mode??'none');
  const [name,setName]=useState(initial?.database.name??'app');
  const [env,setEnv]=useState(JSON.stringify(initial?.env??{},null,2));
  const [refs,setRefs]=useState(JSON.stringify(initial?.secret_refs??{},null,2));
  const [bindings,setBindings]=useState(JSON.stringify(initial?.database.bindings??{PGHOST:'host',PGPORT:'port',PGDATABASE:'name',PGUSER:'username',PGPASSWORD:'password'},null,2));
  const [command,setCommand]=useState(JSON.stringify(initial?.init_command??[]));
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  if(MOCK)return null;
  async function save(){
    setBusy(true);setMessage('');
    try{
      const runtime:HttpRuntime={version:'http-runtime.v1',port,health_path:health,env:JSON.parse(env),secret_refs:JSON.parse(refs),database:{mode,name,bindings:['postgres','mysql','mongodb'].includes(mode)?JSON.parse(bindings):{}},init_command:mode==='none'?[]:JSON.parse(command)};
      const r=await fetch(`${API}/api/projects/${project.id}/runtime`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(runtime)});
      const data=await r.json();if(!r.ok)throw new Error(data.detail??'실행 설정을 확인하세요.');
      onSaved(data);setMessage('저장했어요. 아키텍처 설계는 새 설정으로 다시 판단하세요.');
    }catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  return <section className="card p-5 space-y-4"><h2 className="font-semibold text-lg">HTTP 앱 실행 설정</h2>
    <p className="text-sm text-muted">언어와 관계없이 단일 HTTP 컨테이너를 실행합니다. 앱은 0.0.0.0에서 연결을 받고 헬스체크에 200을 반환해야 합니다. 저장 전에는 기존 샘플 배포 설정을 사용합니다.</p>
    <fieldset disabled={busy} className="space-y-3"><legend className="sr-only">실행 설정</legend><div className="grid sm:grid-cols-3 gap-3">
      <label>앱 포트<input className={field} type="number" min={1} max={65535} value={port} onChange={e=>setPort(Number(e.target.value))}/></label>
      <label>헬스체크 경로<input className={field} value={health} onChange={e=>setHealth(e.target.value)}/></label>
      <label>데이터베이스<select className={field} value={mode} onChange={e=>{const next=e.target.value as HttpRuntime['database']['mode'];setMode(next);if(['postgres','mysql','mongodb'].includes(next))setBindings(JSON.stringify({DATABASE_URL:next+'_url'},null,2));}}><option value="none">DB 없음</option><option value="postgres">관리형 PostgreSQL</option><option value="mysql">관리형 MySQL</option><option value="mongodb">MongoDB (AWS: 3 AZ replica set)</option><option value="external">기존 외부 DB 연결</option></select></label>
    </div>
    {['postgres','mysql','mongodb'].includes(mode)&&<><label className="block">DB 이름<input className={field} value={name} onChange={e=>setName(e.target.value)}/></label><label className="block">앱의 DB 환경변수 연결 (JSON)<textarea className={field+' font-mono text-sm'} rows={7} value={bindings} onChange={e=>setBindings(e.target.value)}/></label><p className="text-xs text-muted">환경변수 이름을 앱에 맞게 바꾸세요. 값은 host, port, name, username, password, jdbc_url, postgres_url, mysql_url, mongodb_url 중 선택합니다. 선택한 DB에 맞는 URL 바인딩을 사용하세요. PostgreSQL 예: {`{"DATABASE_URL":"postgres_url"}`}로 설정하세요. AWS에서는 준비된 DB 엔진·이름과 일치해야 합니다. AWS MongoDB는 3 AZ TLS replica set으로 구성됩니다.</p></>}
    <details><summary className="cursor-pointer">환경변수·비밀값 참조·DB 초기화</summary><div className="space-y-3 mt-3">
      <label className="block">일반 환경변수 (JSON)<textarea className={field+' font-mono text-sm'} rows={3} value={env} onChange={e=>setEnv(e.target.value)}/></label>
      <label className="block">비밀값 참조 (JSON)<textarea className={field+' font-mono text-sm'} rows={3} value={refs} onChange={e=>setRefs(e.target.value)}/></label>
      <p className="text-xs text-muted">비밀값 자체를 입력하지 마세요. 예: {`{"DATABASE_URL":"app_database_url"}`} — 해당 이름을 로컬 Secret 파일 또는 AWS 어댑터의 Secrets Manager 매핑에 먼저 등록하세요. 외부 DB는 연결만 하며 생성·변경하지 않습니다.</p>
      {mode!=='none'&&<label className="block">DB 초기화 명령 (JSON 배열, 생략 시 [])<input className={field+' font-mono text-sm'} value={command} onChange={e=>setCommand(e.target.value)}/><span className="text-xs text-muted">예: [&quot;python&quot;,&quot;migrate.py&quot;]. 같은 이미지에서 배포마다 1회 실행하고 성공해야 앱을 시작합니다. 반복 실행해도 안전한 명령을 사용하세요.</span></label>}
    </div></details><button onClick={()=>void save()} className="rounded bg-accent text-white px-4 py-2 disabled:opacity-50">{busy?'저장 중…':'실행 설정 저장'}</button></fieldset>
    {message&&<p role="status" className="text-sm">{message}</p>}
  </section>;
}
