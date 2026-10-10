"""Explicit, disposable single-task Fargate experiment; NOT architecture provisioning.

Requires AWS CLI, Docker and httpx. Uses only a freshly created named stack.
No RDS/ALB/NAT. Ingress is restricted to the caller's IPv4 /32. Runs one task
at a time, bounded to 30 minutes, and stops tasks/deletes the stack in finally.
"""
import argparse
import asyncio
import ipaddress
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--profile', required=True)
parser.add_argument('--account', required=True)
parser.add_argument('--stack', required=True)
parser.add_argument('--context', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--tiers', nargs='+', choices=['small','medium','large'], default=['small','medium','large'])
args = parser.parse_args()
if not args.stack.startswith('shakedown-exp-') or not args.account.isdigit() or len(args.account) != 12:
    raise SystemExit('Explicit experiment stack prefix and account required')
args.output.mkdir(parents=True, exist_ok=True)
region = 'ap-northeast-2'
started = time.monotonic()
deadline = started + 1800
tasks = []
definitions = []
outputs = {}
created = False
results = {'scope': 'single-task CPU/memory smoke, not full architecture deployment',
           'region': region, 'budget_usd': 3, 'stack': args.stack, 'measurements': []}


def save():
    (args.output/'aws-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))


def emit(event, **values):
    print(json.dumps({'event': event, **values}, ensure_ascii=False), flush=True)


def command(argv, *, timeout=120, env=None, input=None):
    p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env, input=input)
    if p.returncode:
        # Call sites never pass credentials in argv. Do not print provider bodies or auth input.
        raise RuntimeError(f'{argv[0]} {argv[1]} failed (exit {p.returncode})')
    return p.stdout.strip()


def aws(service, operation, payload=None, *, cleanup=False):
    if not cleanup and time.monotonic() >= deadline:
        raise TimeoutError('30-minute experiment deadline')
    argv = ['aws', '--profile', args.profile, '--region', region, service, operation, '--output', 'json']
    if payload is not None:
        argv += ['--cli-input-json', json.dumps(payload)]
    raw = command(argv)
    return json.loads(raw) if raw else {}


def wait_stack(deleting=False):
    limit = time.monotonic() + 600
    while time.monotonic() < limit:
        try:
            stack = aws('cloudformation', 'describe-stacks', {'StackName': args.stack}, cleanup=deleting)['Stacks'][0]
        except RuntimeError:
            if deleting:
                # Confirm disappearance using listing rather than assuming all errors mean deletion.
                listed = aws('cloudformation', 'list-stacks', cleanup=True)
                match = [s for s in listed['StackSummaries'] if s['StackName'] == args.stack]
                if match and match[0]['StackStatus'] == 'DELETE_COMPLETE':
                    return {}
            raise
        status = stack['StackStatus']
        if not deleting and status == 'CREATE_COMPLETE':
            return {v['OutputKey']: v['OutputValue'] for v in stack.get('Outputs', [])}
        if 'FAILED' in status or 'ROLLBACK' in status:
            raise RuntimeError('CloudFormation state: '+status)
        time.sleep(5)
    raise TimeoutError('CloudFormation timeout')


def stop(task):
    aws('ecs', 'stop-task', {'cluster': outputs['Cluster'], 'task': task, 'reason': 'Bounded experiment complete'}, cleanup=True)
    limit = time.monotonic() + 120
    while time.monotonic() < limit:
        rows = aws('ecs', 'describe-tasks', {'cluster': outputs['Cluster'], 'tasks': [task]}, cleanup=True)['tasks']
        if rows and rows[0]['lastStatus'] == 'STOPPED':
            return
        time.sleep(3)
    raise TimeoutError('Task stop not confirmed')


async def measure(url, rate):
    import httpx
    samples = []
    semaphore = asyncio.Semaphore(50)
    duration = 20
    begin = time.monotonic()
    async with httpx.AsyncClient(trust_env=False, timeout=5) as client:
        async def one(scheduled):
            await asyncio.sleep(max(0, scheduled-time.monotonic()))
            async with semaphore:
                t = time.monotonic()
                ok = False
                failure = None
                try:
                    r = await client.get(url)
                    ok = r.status_code == 200 and r.json().get('experiment') == 'docker-ai-fallback'
                    if not ok: failure='response_'+str(r.status_code)
                except (httpx.HTTPError, ValueError) as e:
                    failure=type(e).__name__
                samples.append({'latency_ms': (time.monotonic()-t)*1000, 'ok': ok,
                                'scheduling_lag_ms': (t-scheduled)*1000, 'failure': failure})
        await asyncio.gather(*(one(begin+i/rate) for i in range(rate*duration)))
    timings = sorted(s['latency_ms'] for s in samples)
    return {'offered_rps': rate, 'offered_seconds': duration, 'requests': len(samples),
            'errors': sum(not s['ok'] for s in samples),
            'failure_types': {kind:sum(s['failure']==kind for s in samples) for kind in sorted({s['failure'] for s in samples if s['failure']})},
            'elapsed_seconds': round(time.monotonic()-begin, 3),
            **{f'p{p}_ms': round(timings[math.ceil(len(timings)*p/100)-1], 2) for p in [50,95,99]},
            'max_scheduling_lag_ms': round(max(s['scheduling_lag_ms'] for s in samples), 2)}


try:
    identity = aws('sts', 'get-caller-identity')
    if identity['Account'] != args.account:
        raise RuntimeError('AWS account mismatch')
    existing = aws('cloudformation', 'list-stacks')['StackSummaries']
    if any(s['StackName'] == args.stack for s in existing):
        raise RuntimeError('Stack name must be fresh, including deleted history')
    ip = str(ipaddress.IPv4Address(command(['curl', '--fail', '--silent', '--show-error', '--max-time', '10', 'https://checkip.amazonaws.com'])))
    ref = lambda key: {'Ref': key}
    get = lambda key, attribute: {'Fn::GetAtt': [key, attribute]}
    resources = {}
    def resource(key, kind, properties, **extra):
        resources[key] = {'Type': 'AWS::'+kind, 'Properties': properties, **extra}
    resource('Vpc', 'EC2::VPC', dict(CidrBlock='10.89.0.0/16', EnableDnsSupport=True, EnableDnsHostnames=True))
    resource('Gateway', 'EC2::InternetGateway', {})
    resource('Attachment', 'EC2::VPCGatewayAttachment', dict(VpcId=ref('Vpc'), InternetGatewayId=ref('Gateway')))
    resource('Subnet', 'EC2::Subnet', dict(VpcId=ref('Vpc'), CidrBlock='10.89.1.0/24', AvailabilityZone='ap-northeast-2a'))
    resource('Routes', 'EC2::RouteTable', dict(VpcId=ref('Vpc')))
    resource('Route', 'EC2::Route', dict(RouteTableId=ref('Routes'), DestinationCidrBlock='0.0.0.0/0', GatewayId=ref('Gateway')), DependsOn='Attachment')
    resource('RouteAssociation', 'EC2::SubnetRouteTableAssociation', dict(RouteTableId=ref('Routes'), SubnetId=ref('Subnet')))
    resource('SecurityGroup', 'EC2::SecurityGroup', dict(GroupDescription='Temporary smoke caller IPv4 only', VpcId=ref('Vpc'),
             SecurityGroupIngress=[dict(IpProtocol='tcp', FromPort=5000, ToPort=5000, CidrIp=ip+'/32')]))
    resource('Repository', 'ECR::Repository', dict(RepositoryName=args.stack, EmptyOnDelete=True, ImageTagMutability='IMMUTABLE'))
    resource('Logs', 'Logs::LogGroup', dict(LogGroupName='/shakedown/'+args.stack, RetentionInDays=1))
    resource('Cluster', 'ECS::Cluster', dict(ClusterName=args.stack))
    resource('ExecutionRole', 'IAM::Role', dict(
        AssumeRolePolicyDocument={'Version': '2012-10-17', 'Statement': [{'Effect':'Allow','Principal':{'Service':'ecs-tasks.amazonaws.com'},'Action':'sts:AssumeRole'}]},
        Policies=[{'PolicyName':'experiment-image-logs','PolicyDocument':{'Version':'2012-10-17','Statement':[
            {'Effect':'Allow','Action':['ecr:GetAuthorizationToken'],'Resource':'*'},
            {'Effect':'Allow','Action':['ecr:BatchCheckLayerAvailability','ecr:GetDownloadUrlForLayer','ecr:BatchGetImage'],'Resource':get('Repository','Arn')},
            {'Effect':'Allow','Action':['logs:CreateLogStream','logs:PutLogEvents'],'Resource':get('Logs','Arn')}
        ]}}]))
    template = {'AWSTemplateFormatVersion':'2010-09-09', 'Resources':resources, 'Outputs': {
        **{k:{'Value':ref(k)} for k in ['Cluster','Subnet','SecurityGroup','Logs']},
        'Repository':{'Value':get('Repository','RepositoryUri')}, 'Role':{'Value':get('ExecutionRole','Arn')}}}
    # Template includes caller IP; keep it in ignored local evidence, not in Git.
    (args.output/'template.json').write_text(json.dumps(template))
    aws('cloudformation','validate-template',{'TemplateBody':json.dumps(template)})
    local_image='shakedown/experiment:'+args.stack
    command(['docker','buildx','build','--platform','linux/amd64','--provenance=false','--sbom=false','--load','-t',local_image,str(args.context)],timeout=600)
    emit('local_amd64_image_built')
    aws('cloudformation','create-stack',{'StackName':args.stack,'TemplateBody':json.dumps(template),
        'Capabilities':['CAPABILITY_IAM'],'TimeoutInMinutes':10,
        'Tags':[{'Key':'Purpose','Value':'shakedown-disposable-experiment'}]})
    created = True
    emit('stack_creating')
    outputs = wait_stack()
    emit('stack_ready')
    image = outputs['Repository']+':smoke'
    with tempfile.TemporaryDirectory(prefix='shakedown-ecr-auth-') as auth:
        env = dict(os.environ, DOCKER_CONFIG=auth)
        env['DOCKER_HOST'] = command(['docker','context','inspect','--format','{{.Endpoints.docker.Host}}'])
        env.pop('DOCKER_CONTEXT', None)
        # Credential material goes directly from captured stdout to stdin and is never saved in evidence.
        token = command(['aws','--profile',args.profile,'--region',region,'ecr','get-login-password'])
        command(['docker','login','--username','AWS','--password-stdin',image.split('/')[0]],input=token,env=env)
        token = None
        command(['docker','tag',local_image,image])
        command(['docker','push',image],timeout=600,env=env)
    digest = aws('ecr','describe-images',{'repositoryName':args.stack,'imageIds':[{'imageTag':'smoke'}]})['imageDetails'][0]['imageDigest']
    image = outputs['Repository']+'@'+digest
    results['image_digest'] = digest
    emit('image_published', digest=digest)
    for tier,cpu,memory,rate in [('small',512,1024,5),('medium',1024,2048,50),('large',2048,4096,150)]:
        if tier not in args.tiers: continue
        task_definition = aws('ecs','register-task-definition',dict(
            family=args.stack,networkMode='awsvpc',requiresCompatibilities=['FARGATE'],cpu=str(cpu),memory=str(memory),
            executionRoleArn=outputs['Role'],runtimePlatform={'cpuArchitecture':'X86_64','operatingSystemFamily':'LINUX'},
            containerDefinitions=[dict(name='app',image=image,essential=True,portMappings=[{'containerPort':5000}],
                logConfiguration={'logDriver':'awslogs','options':{'awslogs-group':outputs['Logs'],'awslogs-region':region,'awslogs-stream-prefix':tier}})]
        ))['taskDefinition']['taskDefinitionArn']
        definitions.append(task_definition)
        launch = time.monotonic()
        response = aws('ecs','run-task',dict(cluster=outputs['Cluster'],taskDefinition=task_definition,count=1,launchType='FARGATE',
            networkConfiguration={'awsvpcConfiguration':{'subnets':[outputs['Subnet']],'securityGroups':[outputs['SecurityGroup']],'assignPublicIp':'ENABLED'}}))
        tasks.extend(t['taskArn'] for t in response.get('tasks',[]))
        if response.get('failures') or not response.get('tasks'):
            raise RuntimeError('ECS RunTask rejected')
        task = response['tasks'][0]['taskArn']
        limit = min(deadline,time.monotonic()+300)
        while time.monotonic()<limit:
            info=aws('ecs','describe-tasks',{'cluster':outputs['Cluster'],'tasks':[task]})['tasks'][0]
            if info['lastStatus']=='STOPPED':
                results['stopped_reason']=info.get('stoppedReason')
                raise RuntimeError('Task stopped before readiness')
            if info['lastStatus']=='RUNNING':
                if not any(c.get('imageDigest')==digest for c in info.get('containers',[])):
                    raise RuntimeError('Running digest mismatch')
                eni=next(d['value'] for a in info['attachments'] for d in a['details'] if d['name']=='networkInterfaceId')
                nic=aws('ec2','describe-network-interfaces',{'NetworkInterfaceIds':[eni]})['NetworkInterfaces'][0]
                public_ip=nic.get('Association',{}).get('PublicIp')
                if public_ip:
                    url=f'http://{public_ip}:5000/'
                    try:
                        with urllib.request.urlopen(url,timeout=3) as r:
                            if json.load(r).get('experiment')=='docker-ai-fallback':
                                break
                    except (OSError,ValueError):
                        pass
            time.sleep(3)
        else:
            raise TimeoutError('Task readiness timeout')
        emit('task_ready',tier=tier,seconds=round(time.monotonic()-launch,2))
        measured=asyncio.run(measure(url,rate))
        measured.update(tier=tier,cpu=cpu,memory_mib=memory,task_count=1,ready_seconds=round(time.monotonic()-launch-measured['elapsed_seconds'],2))
        results['measurements'].append(measured);save();emit('measured',**measured)
        stop(task);tasks.remove(task)
    results['success']=True
except Exception as e:
    results['success']=False
    results['error']=str(e)
    emit('experiment_failed',error=str(e))
finally:
    errors=[]
    for task in tasks:
        try:stop(task)
        except Exception as e:errors.append(str(e))
    for definition in definitions:
        try:
            aws('ecs','deregister-task-definition',{'taskDefinition':definition},cleanup=True)
            aws('ecs','delete-task-definitions',{'taskDefinitions':[definition]},cleanup=True)
        except Exception as e:errors.append(str(e))
    if created:
        try:
            aws('cloudformation','delete-stack',{'StackName':args.stack},cleanup=True)
            wait_stack(deleting=True)
        except Exception as e:errors.append(str(e))
    results['cleanup_errors']=errors
    results['elapsed_seconds']=round(time.monotonic()-started,2)
    save();emit('finished',success=results.get('success'),cleanup_errors=errors,elapsed_seconds=results['elapsed_seconds'])
