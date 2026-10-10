"use client";
import {useState} from "react";
import { useT } from "@/components/i18n";
import {API,MOCK,type Project} from "@/lib/api";
import type {HttpRuntime} from "@shakedown/contracts";

const field="mt-1 w-full rounded border border-line bg-bg p-2";
const MANAGED=['postgres','mysql','mongodb'];
export function RuntimeSettings({project,onSaved}:{project:Project;onSaved:(p:Project)=>void}) {
  const t=useT();
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
      const runtime:HttpRuntime={version:'http-runtime.v1',port,health_path:health,env:JSON.parse(env),secret_refs:JSON.parse(refs),database:{mode,name,bindings:MANAGED.includes(mode)?JSON.parse(bindings):{}},init_command:mode==='none'?[]:JSON.parse(command)};
      const r=await fetch(`${API}/api/projects/${project.id}/runtime`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(runtime)});
      const data=await r.json();if(!r.ok)throw new Error(data.detail??t("rt.invalid"));
      onSaved(data);setMessage(t("rt.saved"));
    }catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  return <section className="panel panel-body space-y-4"><h2 className="font-semibold text-lg">{t("rt.title")}</h2>
    <p className="text-sm text-muted">{t("rt.lead")}</p>
    <fieldset disabled={busy} className="space-y-3"><legend className="sr-only">{t("rt.legend")}</legend><div className="grid sm:grid-cols-3 gap-3">
      <label>{t("rt.port")}<input className={field} type="number" min={1} max={65535} value={port} onChange={e=>setPort(Number(e.target.value))}/></label>
      <label>{t("rt.health")}<input className={field} value={health} onChange={e=>setHealth(e.target.value)}/></label>
      <label>{t("rt.db")}<select className={field} value={mode} onChange={e=>{const next=e.target.value as HttpRuntime['database']['mode'];setMode(next);if(MANAGED.includes(next))setBindings(JSON.stringify({DATABASE_URL:next+'_url'},null,2));}}><option value="none">{t("rt.dbNone")}</option><option value="postgres">{t("rt.dbPostgres")}</option><option value="mysql">{t("rt.dbMysql")}</option><option value="mongodb">{t("rt.dbMongo")}</option><option value="external">{t("rt.dbExternal")}</option></select></label>
    </div>
    {MANAGED.includes(mode)&&<><label className="block">{t("rt.dbName")}<input className={field} value={name} onChange={e=>setName(e.target.value)}/></label><label className="block">{t("rt.bindings")}<textarea className={field+' font-mono text-sm'} rows={7} value={bindings} onChange={e=>setBindings(e.target.value)}/></label><p className="text-xs text-muted">{t("rt.bindingsNote",{example:'{"DATABASE_URL":"postgres_url"}'})}</p></>}
    <details><summary className="cursor-pointer">{t("rt.more")}</summary><div className="space-y-3 mt-3">
      <label className="block">{t("rt.env")}<textarea className={field+' font-mono text-sm'} rows={3} value={env} onChange={e=>setEnv(e.target.value)}/></label>
      <label className="block">{t("rt.refs")}<textarea className={field+' font-mono text-sm'} rows={3} value={refs} onChange={e=>setRefs(e.target.value)}/></label>
      <p className="text-xs text-muted">{t("rt.refsNote",{example:'{"DATABASE_URL":"app_database_url"}'})}</p>
      {mode!=='none'&&<label className="block">{t("rt.init")}<input className={field+' font-mono text-sm'} value={command} onChange={e=>setCommand(e.target.value)}/><span className="text-xs text-muted">{t("rt.initNote")}</span></label>}
    </div></details><button onClick={()=>void save()} className="button primary">{busy?t("rt.saving"):t("rt.save")}</button></fieldset>
    {message&&<p role="status" className="text-sm">{message}</p>}
  </section>;
}
