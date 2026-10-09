"""Disposable real selected-plan -> engine -> AWS adapter integration verification."""
import sys
import argparse, asyncio, ipaddress, json, os, shlex, shutil, subprocess, tempfile, threading, time, uuid
from pathlib import Path
from urllib.parse import urlsplit
from datetime import datetime, timezone
import httpx

p=argparse.ArgumentParser()
p.add_argument('--profile',required=True);p.add_argument('--account',required=True)
p.add_argument('--stack',required=True);p.add_argument('--output',type=Path,required=True)
p.add_argument('--resume',action='store_true',help='Resume this tagged experiment during foundation creation')
a=p.parse_args()
if not a.stack.startswith('shakedown-full-exp-'):raise SystemExit('Fresh experiment stack required')
root=Path(__file__).resolve().parents[3];a.output.mkdir(parents=True,exist_ok=True)
start=time.monotonic();deadline=start+3600
created=False;outputs={};service=False;scalable=False;stop_load=threading.Event();load_thread=None
adapter=None; profile_dir=None
result={'scope':'real engine API selected medium plan -> real AWS adapter -> real AWS resources','checks':{},'cleanup_errors':[]}

def emit(event,**data):print(json.dumps({'event':event,**data},ensure_ascii=False),flush=True)
def save(): (a.output/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
def cmd(args,timeout=120,env=None,input=None):
 r=subprocess.run(args,capture_output=True,text=True,timeout=timeout,env=env,input=input)
 if r.returncode:
  # No credentials are put in argv; retain diagnostic stderr only for non-auth commands.
  if args[0] in ('aws','node'): (a.output/('last-'+args[0]+'-error.txt')).write_text(r.stderr)
  raise RuntimeError(f'{args[0]} {args[1]} failed ({r.returncode})')
 return r.stdout.strip()
def aws(s,op,body=None,cleanup=False):
 if not cleanup and time.monotonic()>deadline:raise TimeoutError('Experiment deadline')
 args=['aws','--profile',a.profile,'--region','ap-northeast-2',s,op,'--output','json']
 if body is not None:args+=['--cli-input-json',json.dumps(body)]
 text=cmd(args);return json.loads(text) if text else {}
def wait(fn,label,seconds,cleanup=False):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if not cleanup and time.monotonic()>deadline:raise TimeoutError('Experiment deadline')
  value=fn()
  if value:return value
  time.sleep(5)
 raise TimeoutError(label)
def stack_state():
 s=aws('cloudformation','describe-stacks',{'StackName':a.stack})['Stacks'][0]
 if 'FAILED' in s['StackStatus'] or 'ROLLBACK' in s['StackStatus']:
  raise RuntimeError(s['StackStatus'])
 return s if s['StackStatus']=='CREATE_COMPLETE' else None
def task_state():
 listed=aws('ecs','list-tasks',{'cluster':outputs['ClusterArn'],'serviceName':a.stack,'desiredStatus':'RUNNING'})
 if not listed['taskArns']:return []
 return aws('ecs','describe-tasks',{'cluster':outputs['ClusterArn'],'tasks':listed['taskArns']})['tasks']
def healthy_tasks():
 tasks=task_state()
 healthy=aws('elbv2','describe-target-health',{'TargetGroupArn':outputs['TargetGroupArn']})['TargetHealthDescriptions']
 count=sum(t['lastStatus']=='RUNNING' for t in tasks)
 return count,tasks,sum(t['TargetHealth']['State']=='healthy' for t in healthy)
def db_state():
 return aws('rds','describe-db-instances',{'DBInstanceIdentifier':db_id})['DBInstances'][0]
def load(url):
 async def work():
  async with httpx.AsyncClient(timeout=5,trust_env=False) as c:
   async def worker():
    while not stop_load.is_set():
     try:await c.get(url+'/api/posts')
     except httpx.HTTPError:pass
     await asyncio.sleep(.1)
   await asyncio.gather(*(worker() for _ in range(8)))
 asyncio.run(work())

try:
 if aws('sts','get-caller-identity')['Account']!=a.account:raise RuntimeError('Account mismatch')
 if a.resume:
  existing=aws('cloudformation','describe-stacks',{'StackName':a.stack})['Stacks'][0]
  tags={t['Key']:t['Value'] for t in existing.get('Tags',[])}
  if tags.get('Purpose')!='shakedown-disposable-verification':raise RuntimeError('Cannot adopt a non-experiment stack')
  if existing['StackStatus'] not in ('CREATE_IN_PROGRESS','CREATE_COMPLETE'):raise RuntimeError('Cannot resume this stack state')
  created=True
  elapsed=(datetime.now(timezone.utc)-datetime.fromisoformat(existing['CreationTime'].replace('Z','+00:00'))).total_seconds()
  deadline=start+max(0,3600-elapsed)
 elif any(s['StackName']==a.stack for s in aws('cloudformation','list-stacks')['StackSummaries']):raise RuntimeError('Stack name already used')
 ip=str(ipaddress.IPv4Address(cmd(['curl','-fsS','--max-time','10','https://checkip.amazonaws.com'])))
 template=json.loads(cmd(['node','--input-type=module','-e',"import fs from 'node:fs';import YAML from 'yaml';console.log(JSON.stringify(YAML.parse(fs.readFileSync('infra/aws/cloudformation/foundation.yaml','utf8'))))"]))
 resources=template['Resources']
 for name in ('Database','DbSecret','Repository','Logs'):
  resources[name]['DeletionPolicy']='Delete';resources[name]['UpdateReplacePolicy']='Delete'
 resources['Repository']['Properties']['EmptyOnDelete']=True
 resources['Repository']['Properties']['ImageScanningConfiguration']={'ScanOnPush':False}
 resources['Database']['Properties'].update(MultiAZ=False,BackupRetentionPeriod=0,DeleteAutomatedBackups=True,DeletionProtection=False)
 resources['AlbSg']['Properties']['SecurityGroupIngress'][0]['CidrIp']=ip+'/32'
 # No managed policies are attached to the user's principal by the experiment.
 template['Outputs']['DbId']={'Value':{'Ref':'Database'}}
 (a.output/'template.json').write_text(json.dumps(template))
 aws('cloudformation','validate-template',{'TemplateBody':json.dumps(template)})

 if not a.resume:
  aws('cloudformation','create-stack',{'StackName':a.stack,'TemplateBody':json.dumps(template),'Capabilities':['CAPABILITY_IAM'],'TimeoutInMinutes':30,
   'Parameters':[{'ParameterKey':'Name','ParameterValue':a.stack},{'ParameterKey':'PostgresVersion','ParameterValue':'17.6'}],
   'Tags':[{'Key':'Purpose','Value':'shakedown-disposable-verification'}]})
  created=True;emit('stack_creating')
 stack=wait(stack_state,'stack create',1800)
 outputs={v['OutputKey']:v['OutputValue'] for v in stack['Outputs']};db_id=outputs['DbId']
 result['stack_created_at']=stack['CreationTime'];emit('stack_ready');save()
 (a.output/'stack-resources.json').write_text(json.dumps(aws('cloudformation','list-stack-resources',{'StackName':a.stack})))
 result['checks']['initial_db_multi_az']=db_state()['MultiAZ']
 if result['checks']['initial_db_multi_az']:raise RuntimeError('Test must begin with Single-AZ DB')
 sys.path.insert(0,str(root/'apps/engine'))
 from engine.api import create_app
 from engine.projects import ProjectStore
 from engine.deployments import DeploymentStore
 from fastapi.testclient import TestClient
 store=ProjectStore(a.output/'engine-projects.sqlite3')
 from engine.models import CreateProjectRequest
 project=store.create(CreateProjectRequest(repo=str(root/'samples/kty-board'),targets=['aws']))
 config={k[0].lower()+k[1:]:v for k,v in outputs.items() if k not in ('SubnetIds','DbId','AdapterPolicyArn','ImagePublisherPolicyArn')}
 config.update(profile='shakedown-experiment',accountId=a.account,projectId=project.id,region='ap-northeast-2',port=8080,subnetIds=outputs['SubnetIds'].split(','))
 (a.output/'config.json').write_text(json.dumps(config))
 profile_dir=tempfile.TemporaryDirectory(prefix='shakedown-plan-profile-')
 profile=Path(profile_dir.name)/'config'
 original=os.environ.get('AWS_CONFIG_FILE',str(Path.home()/'.aws/config'))
 process=shlex.join(['env','AWS_CONFIG_FILE='+original,shutil.which('aws'),'--profile',a.profile,'configure','export-credentials','--format','process'])
 profile.write_text('[profile shakedown-experiment]\nregion = ap-northeast-2\ncredential_process = '+process+'\n')
 env=dict(os.environ,AWS_CONFIG_FILE=str(profile),AWS_ADAPTER_CONFIG=str(a.output/'config.json'),AWS_ADAPTER_DB=str(a.output/'adapter.sqlite3'))
 log=open(a.output/'adapter.log','w')
 adapter=subprocess.Popen(['node','--import','tsx','infra/aws/src/server.ts'],env=env,stdout=log,stderr=log)
 def ready():
  if adapter.poll() is not None:raise RuntimeError('Adapter startup failed')
  try:return httpx.get('http://127.0.0.1:9102/health',timeout=2).status_code==200
  except httpx.HTTPError:return False
 wait(ready,'adapter start',30)
 os.environ.update({k:env[k] for k in ('AWS_CONFIG_FILE','AWS_ADAPTER_CONFIG')})
 os.environ['HACKATHON_PUBLISH_PROFILE']='shakedown-experiment'
 # AWS helper continues using original default credentials; named alias only for product processes.
 # Default CLI profile resolution still uses the normal shared credentials file.
 ds=DeploymentStore(a.output/'engine-deployments.sqlite3',poll_seconds=2)
 service=True;scalable=True
 resource_id='service/'+outputs['ClusterArn'].split('/')[-1]+'/'+a.stack
 with TestClient(create_app(store,ds)) as api:
  base='/api/projects/'+project.id
  plan_response=api.post(base+'/architecture-plans',json={'peak_rps':50,'availability':'high','traffic':'steady','use_ai':False})
  plan_response.raise_for_status();plan=plan_response.json()
  selected=api.post(base+'/architecture-plans/'+plan['id']+'/select',json={'template_id':'medium'})
  selected.raise_for_status();result['plan']=selected.json();save()
  dep=api.post(base+'/deployments',json={'targets':['aws'],'architecture_plan_id':plan['id']})
  dep.raise_for_status();dep_id=dep.json()['id'];emit('engine_deployment_started',deployment_id=dep_id)
  last=None
  while True:
   state=api.get('/api/deployments/'+dep_id).json()
   if state['status']!=last:emit('engine_status',status=state['status']);last=state['status']
   (a.output/'deployment.json').write_text(json.dumps(state,indent=2))
   if state['status'] in ('deployed','failed','blocked','warned','promoted'):break
   if time.monotonic()>deadline:raise TimeoutError('Engine experiment deadline')
   time.sleep(5)
  if state['status']!='deployed':raise RuntimeError('Engine deployment failed: '+state.get('error','unknown'))
  result['checks']['engine_deployment']={'status':state['status'],'architecture':state['architecture']['id'],'plan_id':state['architecture_plan_id']}
  emit('engine_deployed');save()
 count,tasks,healthy=healthy_tasks()
 definition=aws('ecs','describe-task-definition',{'taskDefinition':tasks[0]['taskDefinitionArn']})['taskDefinition']
 target=aws('application-autoscaling','describe-scalable-targets',{'ServiceNamespace':'ecs','ResourceIds':[resource_id]})['ScalableTargets'][0]
 policies=aws('application-autoscaling','describe-scaling-policies',{'ServiceNamespace':'ecs','ResourceId':resource_id})['ScalingPolicies']
 result['checks']['applied_resources']={'cpu':definition['cpu'],'memory':definition['memory'],'tasks':count,'healthy':healthy,'zones':sorted({t['availabilityZone'] for t in tasks}),'db_multi_az':db_state()['MultiAZ'],'scaling_min':target['MinCapacity'],'scaling_max':target['MaxCapacity'],'cpu_target':policies[0]['TargetTrackingScalingPolicyConfiguration']['TargetValue']}
 check=result['checks']['applied_resources']
 if not (check['cpu']=='1024' and check['memory']=='2048' and count==2 and healthy==2 and len(check['zones'])==2 and check['db_multi_az'] and check['scaling_min']==2 and check['scaling_max']==4 and check['cpu_target']==60):raise RuntimeError('Actual resources differ from medium plan')
 emit('medium_resources_verified');save()
 url=outputs['PublicUrl'];count,tasks,healthy=healthy_tasks()
 zones=sorted({t['availabilityZone'] for t in tasks})
 if count!=2 or healthy!=2 or len(zones)!=2:raise RuntimeError('Two healthy app AZs not confirmed')
 result['checks']['app_multi_az']={'tasks':count,'healthy_targets':healthy,'zones':zones}
 client=httpx.Client(base_url=url,trust_env=False,timeout=10,follow_redirects=False)
 email='smoke-'+uuid.uuid4().hex+'@example.invalid';password=uuid.uuid4().hex
 title='AWS persistence '+uuid.uuid4().hex
 if client.post('/join',data={'email':email,'nickname':'smoke','password':password}).status_code!=302:raise RuntimeError('join failed')
 login=client.post('/login',data={'email':email,'password':password})
 if login.status_code!=302 or urlsplit(login.headers.get('location','')).path!='/board':raise RuntimeError('login failed')
 instances=set()
 for _ in range(30):
  r=client.get('/board')
  if r.status_code!=200:raise RuntimeError('Session did not survive across targets')
  if r.headers.get('x-instance-id'):instances.add(r.headers['x-instance-id'])
  if len(instances)>=2:break
 if len(instances)<2:raise RuntimeError('Cross-instance session evidence missing')
 write=client.post('/api/posts/write',data={'title':title,'content':'Disposable AWS verification'})
 if write.status_code!=302 or urlsplit(write.headers.get('location','')).path!='/board':raise RuntimeError('Write failed')
 if not any(post['title']==title for post in client.get('/api/posts').json()):raise RuntimeError('Read-back failed')
 result['checks']['rds_session_and_data']={'instance_count':len(instances),'write_read':True};save();emit('cross_az_session_and_data_passed')
 result['completed']=True;save();emit('checks_finished')
except Exception as e:
 result['completed']=False;result['error']=str(e);emit('check_failed',error=str(e));save()
finally:
 if adapter and adapter.poll() is None and 'dep_id' in globals():
  try:
   response=httpx.delete('http://127.0.0.1:9102/deployments/'+dep_id,timeout=630)
   result['checks']['adapter_delete_status']=response.status_code
   if response.status_code==204:scalable=False
   else:result['cleanup_errors'].append('adapter DELETE: HTTP '+str(response.status_code))
  except Exception as exc:result['cleanup_errors'].append('adapter DELETE: '+str(exc))
 if adapter:
  adapter.terminate()
  try:adapter.wait(timeout=15)
  except subprocess.TimeoutExpired:adapter.kill();adapter.wait()
 if profile_dir:profile_dir.cleanup()
 os.environ.pop('AWS_CONFIG_FILE',None)
 stop_load.set()
 if load_thread:load_thread.join(timeout=15)
 def cleanup(label,fn):
  try:fn()
  except Exception as e:result['cleanup_errors'].append(label+': '+str(e))
 if scalable:
  cleanup('scaling_policy',lambda:aws('application-autoscaling','delete-scaling-policy',{'ServiceNamespace':'ecs','ResourceId':resource_id,'ScalableDimension':'ecs:service:DesiredCount','PolicyName':'shakedown-cpu'},cleanup=True))
  cleanup('scaling_target',lambda:aws('application-autoscaling','deregister-scalable-target',{'ServiceNamespace':'ecs','ResourceId':resource_id,'ScalableDimension':'ecs:service:DesiredCount'},cleanup=True))
 if outputs:
  if service:
   cleanup('close_route',lambda:aws('elbv2','modify-rule',{'RuleArn':outputs['GateRuleArn'],'Actions':[{'Type':'fixed-response','FixedResponseConfig':{'StatusCode':'403','ContentType':'text/plain','MessageBody':'Experiment finished'}}]},cleanup=True))
   def delete_service():
    current=aws('ecs','describe-services',{'cluster':outputs['ClusterArn'],'services':[a.stack]},cleanup=True)
    if any(s.get('status')=='ACTIVE' for s in current.get('services',[])):
     aws('ecs','delete-service',{'cluster':outputs['ClusterArn'],'service':a.stack,'force':True},cleanup=True)
   cleanup('delete_service',delete_service)
  def stop_all():
   for desired in ('RUNNING','PENDING'):
    tasks=aws('ecs','list-tasks',{'cluster':outputs['ClusterArn'],'desiredStatus':desired},cleanup=True)['taskArns']
    for task in tasks:aws('ecs','stop-task',{'cluster':outputs['ClusterArn'],'task':task,'reason':'Disposable experiment cleanup'},cleanup=True)
  cleanup('stop_tasks',stop_all)
  def remove_definitions():
   for arn in aws('ecs','list-task-definitions',{'familyPrefix':a.stack},cleanup=True)['taskDefinitionArns']:
    aws('ecs','deregister-task-definition',{'taskDefinition':arn},cleanup=True)
    aws('ecs','delete-task-definitions',{'taskDefinitions':[arn]},cleanup=True)
  cleanup('definitions',remove_definitions)
 if created:
  emit('cleanup_stack')
  cleanup('delete_stack',lambda:aws('cloudformation','delete-stack',{'StackName':a.stack},cleanup=True))
  def deleted():
   rows=aws('cloudformation','list-stacks',cleanup=True)['StackSummaries']
   row=next((s for s in rows if s['StackName']==a.stack),None)
   if row and row['StackStatus']=='DELETE_FAILED':raise RuntimeError('Stack deletion failed; inspect exact experiment resources')
   return row and row['StackStatus']=='DELETE_COMPLETE'
  cleanup('confirm_deletion',lambda:wait(deleted,'stack cleanup',1800,cleanup=True))
 result['elapsed_seconds']=round(time.monotonic()-start,2);save();emit('finished',**result)
