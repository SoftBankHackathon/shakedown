"""Explicit live experiment on a dedicated stack; stops then restarts its primary EC2."""
import json, os, pathlib, subprocess, sys, time, urllib.request
config_path, result_path = sys.argv[1:]
c = json.loads(pathlib.Path(config_path).read_text())
if os.environ.get('HACKATHON_MONGO_FAILOVER') != '1' or c['dbEngine'] != 'mongodb' or 'mongo-tls' not in c['serviceName']:
    raise SystemExit('Use HACKATHON_MONGO_FAILOVER=1 and a dedicated mongo-tls experiment stack')
def probe():
    with urllib.request.urlopen(c['publicUrl']+'/probe', timeout=7) as r:
        return json.load(r)
def aws(*args):
    return subprocess.run(['aws','--profile',c['profile'],'--region',c['region'],*args], check=True, capture_output=True, text=True).stdout
fault=os.environ.get('HACKATHON_MONGO_FAULT','ec2-stop')
if fault not in ('ec2-stop','process-kill'): raise SystemExit('Unsupported experiment fault')
def remote(command):
    result=json.loads(aws('ssm','send-command','--instance-ids',instance,'--document-name','AWS-RunShellScript','--parameters',json.dumps({'commands':[command]})))
    command_id=result['Command']['CommandId']
    for _ in range(60):
        time.sleep(1)
        try:
            output=json.loads(aws('ssm','get-command-invocation','--command-id',command_id,'--instance-id',instance))
        except subprocess.CalledProcessError as e:
            if 'InvocationDoesNotExist' in e.stderr: continue
            raise
        if output['Status']=='Success': return
        if output['Status'] not in ('Pending','InProgress','Delayed'): raise RuntimeError('Remote fault command failed')
    raise RuntimeError('Remote fault command timed out')
before = probe(); old = before['primary'].split(':')[0]
instance = c['dbInstanceIds'][c['dbHosts'].index(old)]
trace=[]; started=time.monotonic(); recovered=None
try:
    if fault=='process-kill': remote('docker update --restart=no shakedown-mongo >/dev/null && docker kill --signal KILL shakedown-mongo >/dev/null')
    else: aws('ec2','stop-instances','--instance-ids',instance)
    while time.monotonic()-started < 120:
        elapsed=round(time.monotonic()-started,2)
        try:
            body=probe(); trace.append({'seconds':elapsed,'ok':True,'primary':body['primary'],'count':body['count']})
            if body['primary']!=before['primary']:
                recovered={'seconds':round(time.monotonic()-started,2),'primary':body['primary'],'count':body['count']}; break
        except Exception as e:
            trace.append({'seconds':elapsed,'ok':False,'error_type':type(e).__name__})
        time.sleep(1)
finally:
    if fault=='process-kill':
        remote('docker update --restart=unless-stopped shakedown-mongo >/dev/null && docker start shakedown-mongo >/dev/null')
    else:
        # Stop must complete before a restart request is valid.
        for _ in range(90):
            state=json.loads(aws('ec2','describe-instances','--instance-ids',instance))['Reservations'][0]['Instances'][0]['State']['Name']
            if state=='stopped': break
            time.sleep(2)
        aws('ec2','start-instances','--instance-ids',instance)
    result={'fault':fault,'before':before,'stopped_instance':instance,'recovery':recovered,'trace':trace,'restart_requested':True}
    pathlib.Path(result_path).write_text(json.dumps(result,indent=2))
if recovered is None: raise SystemExit('No new primary/write recovery within 120 seconds')
print(json.dumps({'new_primary':recovered['primary'],'write_recovery_seconds':recovered['seconds'],'failed_probes':sum(not x['ok'] for x in trace),'restart_requested':True}))
