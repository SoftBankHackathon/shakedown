"""Explicit disposable verification of the EXISTING AWS provider and AWS primitives.
Not a product architecture-plan deployment implementation. See experiment README.
"""
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
result={'scope':'existing provider plus experimental ALB/MultiAZ/RDS/scaling; selected-plan product connection absent','checks':{},'cleanup_errors':[]}

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
 resources['Database']['Properties'].update(MultiAZ=True,BackupRetentionPeriod=0,DeleteAutomatedBackups=True,DeletionProtection=False)
 resources['AlbSg']['Properties']['SecurityGroupIngress'][0]['CidrIp']=ip+'/32'
 # No managed policies are attached to the user's principal by the experiment.
 template['Outputs']['DbId']={'Value':{'Ref':'Database'}}
 (a.output/'template.json').write_text(json.dumps(template))
 aws('cloudformation','validate-template',{'TemplateBody':json.dumps(template)})
 local='shakedown/experiment:'+a.stack
 if not a.resume:
  emit('building_sample')
  cmd(['docker','buildx','build','--platform','linux/amd64','--provenance=false','--sbom=false','--load','-t',local,str(root/'samples/kty-board')],timeout=600)
  aws('cloudformation','create-stack',{'StackName':a.stack,'TemplateBody':json.dumps(template),'Capabilities':['CAPABILITY_IAM'],'TimeoutInMinutes':30,
   'Parameters':[{'ParameterKey':'Name','ParameterValue':a.stack},{'ParameterKey':'PostgresVersion','ParameterValue':'17.6'}],
   'Tags':[{'Key':'Purpose','Value':'shakedown-disposable-verification'}]})
  created=True;emit('stack_creating')
 stack=wait(stack_state,'stack create',1800)
 outputs={v['OutputKey']:v['OutputValue'] for v in stack['Outputs']};db_id=outputs['DbId']
 result['stack_created_at']=stack['CreationTime']
 emit('stack_ready')
 result['checks']['rds_configuration']={k:db_state().get(k) for k in ('DBInstanceStatus','MultiAZ','PubliclyAccessible','StorageEncrypted','AvailabilityZone','SecondaryAvailabilityZone','EngineVersion')}
 if not result['checks']['rds_configuration']['MultiAZ']:raise RuntimeError('RDS MultiAZ not applied')
 save()
 image=outputs['RepositoryUri']+':smoke'
 with tempfile.TemporaryDirectory(prefix='shakedown-full-ecr-') as auth:
  env=dict(os.environ,DOCKER_CONFIG=auth,DOCKER_HOST=cmd(['docker','context','inspect','--format','{{.Endpoints.docker.Host}}']))
  env.pop('DOCKER_CONTEXT',None)
  token=cmd(['aws','--profile',a.profile,'--region','ap-northeast-2','ecr','get-login-password'])
  cmd(['docker','login','--username','AWS','--password-stdin',image.split('/')[0]],input=token,env=env);token=None
  cmd(['docker','tag',local,image]);cmd(['docker','push',image],timeout=600,env=env)
 digest=aws('ecr','describe-images',{'repositoryName':a.stack,'imageIds':[{'imageTag':'smoke'}]})['imageDetails'][0]['imageDigest']
 image=outputs['RepositoryUri']+'@'+digest;result['image_digest']=digest
 config={k[0].lower()+k[1:]:v for k,v in outputs.items() if k not in ('SubnetIds','DbId','AdapterPolicyArn','ImagePublisherPolicyArn')}
 config.update(profile='shakedown-experiment',accountId=a.account,projectId='prj_full_experiment',region='ap-northeast-2',port=8080,subnetIds=outputs['SubnetIds'].split(','))
 (a.output/'config.json').write_text(json.dumps(config))
 with tempfile.TemporaryDirectory(prefix='shakedown-profile-') as profile_dir:
  profile=Path(profile_dir)/'config'
  original=os.environ.get('AWS_CONFIG_FILE',str(Path.home()/'.aws/config'))
  process=shlex.join(['env','AWS_CONFIG_FILE='+original,shutil.which('aws'),'--profile',a.profile,'configure','export-credentials','--format','process'])
  profile.write_text('[profile shakedown-experiment]\nregion = ap-northeast-2\ncredential_process = '+process+'\n')
  env=dict(os.environ,AWS_CONFIG_FILE=str(profile))
  for phase in ('initialize','deploy'):
   emit('provider_'+phase)
   if phase=='deploy':service=True
   output=cmd(['node','--import','tsx','infra/aws/experiments/provider-check.ts',str(a.output/'config.json'),image,phase],timeout=660,env=env)
   (a.output/('provider-'+phase+'.log')).write_text(output)
   result['checks']['provider_'+phase]='passed';save()
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
 cluster=outputs['ClusterArn'].split('/')[-1];resource_id='service/'+cluster+'/'+a.stack
 aws('application-autoscaling','register-scalable-target',{'ServiceNamespace':'ecs','ResourceId':resource_id,'ScalableDimension':'ecs:service:DesiredCount','MinCapacity':2,'MaxCapacity':4})
 scalable=True
 policy={'ServiceNamespace':'ecs','ResourceId':resource_id,'ScalableDimension':'ecs:service:DesiredCount','PolicyName':'experiment-cpu','PolicyType':'TargetTrackingScaling',
   'TargetTrackingScalingPolicyConfiguration':{'TargetValue':1.0,'PredefinedMetricSpecification':{'PredefinedMetricType':'ECSServiceAverageCPUUtilization'},'ScaleOutCooldown':30,'ScaleInCooldown':30}}
 aws('application-autoscaling','put-scaling-policy',policy);emit('cpu_scaling_load_started')
 load_thread=threading.Thread(target=load,args=(url,),daemon=True);load_thread.start()
 scale_start=time.monotonic()
 def scaled_out():
  c,t,h=healthy_tasks()
  current=aws('ecs','describe-services',{'cluster':outputs['ClusterArn'],'services':[a.stack]})['services'][0]
  if current['desiredCount']<3 or len(current.get('deployments',[]))!=1:return None
  return {'desired_tasks':current['desiredCount'],'tasks':c,'healthy_targets':h,'zones':sorted({v['availabilityZone'] for v in t}),'seconds':round(time.monotonic()-scale_start,2)} if c>=3 and h>=3 else None
 try:result['checks']['scale_out']=wait(scaled_out,'real CPU target tracking scale-out',540)
 finally:stop_load.set();load_thread.join(timeout=15)
 emit('scaled_out',**result['checks']['scale_out']);save()
 # Raise the target to verify scale-in without prolonged artificial CPU pressure.
 policy['TargetTrackingScalingPolicyConfiguration']['TargetValue']=50.0
 aws('application-autoscaling','put-scaling-policy',policy)
 scale_in_start=time.monotonic()
 before=db_state()['AvailabilityZone'];failover_start=time.monotonic()
 aws('rds','reboot-db-instance',{'DBInstanceIdentifier':db_id,'ForceFailover':True})
 emit('rds_failover_started')
 failures=0
 def recovered():
  global failures
  db=db_state()
  try:
   response=client.get('/api/posts')
   ok=response.status_code==200 and any(post['title']==title for post in response.json())
  except (httpx.HTTPError,ValueError):ok=False
  if not ok:failures+=1
  return db if db['DBInstanceStatus']=='available' and db['AvailabilityZone']!=before and ok else None
 after=wait(recovered,'RDS failover + data recovery',600)
 post=client.post('/api/posts/write',data={'title':title+' after failover','content':'same JDBC session'})
 if post.status_code!=302 or urlsplit(post.headers.get('location','')).path!='/board':raise RuntimeError('Session/write after failover failed')
 result['checks']['rds_failover']={'from_az':before,'to_az':after['AvailabilityZone'],'recovery_seconds':round(time.monotonic()-failover_start,2),'failed_polls':failures,'data_preserved':True,'session_write_preserved':True}
 save();emit('rds_failover_passed',**result['checks']['rds_failover'])
 def scaled_in():
  c,t,h=healthy_tasks()
  current=aws('ecs','describe-services',{'cluster':outputs['ClusterArn'],'services':[a.stack]})['services'][0]
  if current['desiredCount']!=2 or current['pendingCount']!=0 or len(current.get('deployments',[]))!=1:return None
  return {'tasks':c,'healthy_targets':h,'seconds':round(time.monotonic()-scale_in_start,2),'cpu_target':50} if c==2 and h==2 else None
 try:
  result['checks']['scale_in']=wait(scaled_in,'target tracking scale-in',1200)
 except TimeoutError:
  result['checks']['scale_in']={'verified':False,'reason':'Not observed within bounded window'}
 activities=aws('application-autoscaling','describe-scaling-activities',{'ServiceNamespace':'ecs','ResourceId':resource_id,'ScalableDimension':'ecs:service:DesiredCount'})
 (a.output/'scaling-activities.json').write_text(json.dumps(activities,indent=2))
 result['completed']=True;save();emit('checks_finished')
except Exception as e:
 result['completed']=False;result['error']=str(e);emit('check_failed',error=str(e));save()
finally:
 stop_load.set()
 if load_thread:load_thread.join(timeout=15)
 def cleanup(label,fn):
  try:fn()
  except Exception as e:result['cleanup_errors'].append(label+': '+str(e))
 if scalable:
  cleanup('scaling_policy',lambda:aws('application-autoscaling','delete-scaling-policy',{'ServiceNamespace':'ecs','ResourceId':resource_id,'ScalableDimension':'ecs:service:DesiredCount','PolicyName':'experiment-cpu'},cleanup=True))
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
