# Explicit opt-in disposable /opt/shakedown Linux host experiment.
# Requires shakedown/direct:test image, the direct-mode systemd target, and /opt/evidence.
# prepare creates deployments; verify only observes after reboot; stop deletes them.
import json,time,pathlib,urllib.request,urllib.error,subprocess,sys
p=pathlib.Path('/opt/evidence');base='http://127.0.0.1:9101';phase=sys.argv[1]
def call(method,path,body=None):
 req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body else None,method=method,headers={'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=15) as r:return r.status,json.loads(r.read() or 'null')
 except urllib.error.HTTPError as e:return e.code,json.loads(e.read() or 'null')
def ready(id):
 for _ in range(180):
  status,d=call('GET','/deployments/'+id)
  if status==200 and d['status']=='ready':return d
  if status==200 and d['status']=='failed':raise RuntimeError(d)
  time.sleep(2)
 raise RuntimeError('readiness timed out')
def request(id,mode):
 return {'deployment_id':id,'project_id':'onprem','image':'shakedown/direct:test','port':3000,'health_path':'/','runtime':{'version':'http-runtime.v1','port':3000,'health_path':'/','env':{},'secret_refs':{},'database':{'mode':mode,'name':'app','bindings':{'DATABASE_URL':'postgres_url'} if mode=='postgres' else {}},'init_command':['node','app.mjs','--init'] if mode=='postgres' else []}}
def probe(url):
 with urllib.request.urlopen(url,timeout=5) as r:return json.loads(r.read())
if phase=='prepare':
 r=request('dep_directnone','none');assert call('POST','/deployments',r)[0]==202
 d=ready(r['deployment_id']);assert probe(d['url'])['database'] is False
 assert call('POST','/deployments',r)[0]==202
 assert call('POST','/deployments',request('dep_conflict','none'))[0]==409
 assert call('DELETE','/deployments/dep_directnone')[0]==204
 r=request('dep_directpg','postgres');assert call('POST','/deployments',r)[0]==202
 d=ready(r['deployment_id']);assert probe(d['url'])['count']==1
 f='/var/lib/shakedown-local/dep_directpg/compose.json'
 subprocess.run(['docker','compose','-p','sd-dep-directpg','-f',f,'exec','-T','db','psql','-U','app','-d','app','-c','INSERT INTO runtime_probe VALUES (2)'],check=True,capture_output=True)
 assert probe(d['url'])['count']==2
 spec=json.loads(pathlib.Path(f).read_text());assert 'tunnel' not in spec['services'];assert 'ports' not in spec['services']['db'];assert all(s['restart']=='unless-stopped' for s in spec['services'].values())
 assert call('GET','/deployments/dep_directpg/logs')[0]==200
 result={'api_deploy_none':True,'api_deploy_postgres':True,'idempotent_post':True,'competing_deployment_409':True,'delete_none_204':True,'logs_without_tunnel':True,'count':2,'no_tunnel':True,'restart_policies':True,'boot_id':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
elif phase=='verify':
 old=json.loads((p/'prepare.json').read_text());new=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip();assert old['boot_id']!=new
 # No compose up, docker start or API POST allowed in this phase.
 for _ in range(120):
  try:
   _,d=call('GET','/deployments/dep_directpg');b=probe(d['url'])
   if b['count']==2:break
  except Exception:pass
  time.sleep(2)
 else:raise RuntimeError('Automatic recovery failed')
 assert subprocess.check_output(['systemctl','is-active','shakedown-local'],text=True).strip()=='active'
 active=subprocess.check_output(['docker','ps','--format','{{.Names}}'],text=True).splitlines()
 assert sorted(active)==['sd-dep-directpg-app-1','sd-dep-directpg-db-1'],active
 assert call('POST','/deployments',request('dep_conflict','none'))[0]==409
 result={'actual_host_reboot':True,'automatic_api_recovery':True,'automatic_app_db_recovery':True,'count':2,'running_containers':active,'reservation_survives_reboot':True}
elif phase=='stop':
 assert call('DELETE','/deployments/dep_directpg')[0]==204
 assert call('DELETE','/deployments/dep_directpg')[0]==204
 assert call('GET','/deployments/dep_directpg')[0]==404
 assert subprocess.check_output(['docker','ps','-aq'],text=True).strip()==''
 result={'delete_204':True,'repeat_delete_204':True,'get_404':True,'containers':0,'retained_volumes':subprocess.check_output(['docker','volume','ls','-q'],text=True).splitlines(),'boot_id':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
elif phase=='verify-stop':
 old=json.loads((p/'stop.json').read_text());assert old['boot_id']!=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
 assert call('GET','/deployments/dep_directpg')[0]==404
 assert subprocess.check_output(['docker','ps','-aq'],text=True).strip()==''
 result={'second_host_reboot':True,'deleted_containers_not_resurrected':True,'tombstone_preserved':True}
(p/(phase+'.json')).write_text(json.dumps(result));print(json.dumps(result))
