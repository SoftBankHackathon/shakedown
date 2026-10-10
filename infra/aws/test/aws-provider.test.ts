import YAML from 'yaml';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AwsProvider } from '../src/aws-provider.js';
import { configSchema } from '../src/config.js';
import { requestSchema } from '../src/model.js';

const config = configSchema.parse(JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')));
const image = config.repositoryUri + '@sha256:' + 'a'.repeat(64);
const request = requestSchema.parse({ deployment_id: 'dep_test', project_id: config.projectId, image, port: 8080, health_path: '/', options: { replicas: 2 }, env: { SPRING_PROFILES_ACTIVE: 'demo,session-jdbc' } });
function setup() {
  const provider = new AwsProvider({...config,secrets:{...config.secrets}});
  provider.secretManager.send=(async()=>{assert.fail('No secret reads without postgres_url');}) as typeof provider.secretManager.send;
  let route = 403; let servicePresent = false;
  const foundation = YAML.parse(readFileSync(new URL('../cloudformation/foundation.yaml', import.meta.url), 'utf8'));
  let attached = foundation.Resources.Listener.Properties.DefaultActions.some((a: { Type: string }) => a.Type === 'forward');
  const actions: string[] = [];
  const definitions: unknown[] = [];
  const tasks = ['10.42.0.10', '10.42.1.10'].map(ip => ({ lastStatus: 'RUNNING', taskDefinitionArn: 'definition', containers: [{ name: 'app', imageDigest: image.split('@')[1] }], attachments: [{ details: [{ name: 'privateIPv4Address', value: ip }] }] }));
  provider.sts.send = (async () => ({ Account: config.accountId })) as typeof provider.sts.send;
  provider.ecr.send = (async () => ({ imageDetails: [{ imageManifestMediaType: 'application/vnd.oci.image.manifest.v1+json' }] })) as typeof provider.ecr.send;
  provider.ecs.send = (async (command: { constructor: { name: string }; input: unknown }) => {
    const name = command.constructor.name; actions.push(name);
    switch (name) {
      case 'RegisterTaskDefinitionCommand': definitions.push(command.input); return { taskDefinition: { taskDefinitionArn: 'definition' } };
      case 'DescribeServicesCommand': return { services: servicePresent ? [{ status: 'ACTIVE', pendingCount: 0, deployments: [{ taskDefinition: 'definition', rolloutState: 'COMPLETED' }] }] : [] };
      case 'CreateServiceCommand':
        assert.equal((command.input as { healthCheckGracePeriodSeconds: number }).healthCheckGracePeriodSeconds, 120, 'Allow the measured 41-second Spring cold start plus healthy probes');
        assert.ok(attached, 'ECS requires a target group associated with an ALB');
        assert.equal(route, 403, 'Traffic must remain blocked during service creation');
        servicePresent = true; return {};
      case 'ListTasksCommand': return { taskArns: servicePresent ? ['task1', 'task2'] : [] };
      case 'DescribeTasksCommand': return { tasks };
      case 'DescribeTaskDefinitionCommand': return { taskDefinition: { containerDefinitions: [{ name: 'app', environment: [{ name: 'TZ', value: 'UTC' }, { name: 'SPRING_PROFILES_ACTIVE', value: 'demo,session-jdbc' }] }] } };
      case 'DeleteServiceCommand': servicePresent = false; return {};
      default: return {};
    }
  }) as typeof provider.ecs.send;
  provider.elb.send = (async (command: { constructor: { name: string }; input: { DefaultActions?: { Type: string }[]; Actions?: { Type: string }[]; RuleArn?: string } }) => {
    const name = command.constructor.name;
    actions.push(name);
    if (name === 'ModifyListenerCommand') attached = command.input.DefaultActions?.[0].Type === 'forward';
    if (name === 'ModifyRuleCommand') {
      assert.equal(command.input.RuleArn, config.gateRuleArn);
      route = command.input.Actions?.[0].Type === 'forward' ? 200 : 403;
    }
    if (name === 'DescribeTargetHealthCommand') return { TargetHealthDescriptions: tasks.map(t => ({ Target: { Id: t.attachments[0].details[0].value }, TargetHealth: { State: 'healthy' } })) };
    return {};
  }) as typeof provider.elb.send;
  return { provider, actions, definitions, tasks, get route() { return route; } };
}

test('AWS SDK flow exposes only matching healthy tasks, uses secret references and reads actual settings', async t => {
  const fake = setup();
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    assert.equal(options.redirect, 'manual'); assert.ok(!('Cookie' in (options.headers ?? {})));
    return new Response('', { status: fake.route });
  });
  const result = await fake.provider.deploy(request, AbortSignal.timeout(2000), () => {});
  assert.equal(result.instances, 2); assert.equal(result.info.session, 'jdbc'); assert.equal(result.info.image_digest, image.split('@')[1]);
  const definition = fake.definitions[0] as { containerDefinitions: { secrets: { valueFrom: string }[]; environment: { name: string; value: string }[] }[] };
  assert.equal(definition.containerDefinitions[0].secrets[0].valueFrom, config.dbPasswordSecretArn + ':password::');
  assert.ok(!definition.containerDefinitions[0].environment.some(e => e.name.includes('PASSWORD')));
  assert.equal(definition.containerDefinitions[0].environment.find(e => e.name === 'SPRING_DATASOURCE_URL')?.value, `jdbc:postgresql://${config.dbHost}:5432/${config.dbName}?sslmode=require`);
  assert.ok(fake.actions.lastIndexOf('ModifyRuleCommand') > fake.actions.indexOf('DescribeTargetHealthCommand'));
  await fake.provider.stop(() => {});
  assert.equal(fake.route, 403);
  assert.ok(fake.actions.lastIndexOf('ModifyRuleCommand') < fake.actions.indexOf('DeleteServiceCommand'));
});

test('an old image digest never becomes ready or opens traffic', async t => {
  const fake = setup(); fake.tasks[0].containers[0].imageDigest = 'sha256:old';
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: fake.route }));
  await assert.rejects(fake.provider.deploy(request, AbortSignal.timeout(25), () => {}));
  assert.equal(fake.route, 403);
});

test('HTTP redirects are not treated as a successful health check', async t => {
  const fake = setup();
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: fake.route === 200 ? 302 : 403 }));
  await assert.rejects(fake.provider.deploy(request, AbortSignal.timeout(25), () => {}));
});

test('wrong account stops before every resource mutation', async () => {
  const fake = setup();
  fake.provider.sts.send = (async () => ({ Account: '000000000000' })) as typeof fake.provider.sts.send;
  await assert.rejects(fake.provider.deploy(request, AbortSignal.timeout(100), () => {}), /계정 ID/);
  assert.equal(fake.actions.length, 0);
});

test('CloudWatch collection returns newest 50 lines across instance streams', async () => {
  const fake = setup();
  fake.provider.logs.send = (async (command: { constructor: { name: string }; input: { startFromHead?: boolean; logStreamName?: string } }) => {
    if (command.constructor.name === 'DescribeLogStreamsCommand') return { logStreams: [{ logStreamName: 'first' }, { logStreamName: 'second' }] };
    assert.equal(command.input.startFromHead, false);
    const offset = command.input.logStreamName === 'first' ? 0 : 100;
    return { events: Array.from({ length: 50 }, (_, i) => ({ timestamp: offset + i, message: `line-${offset + i}` })) };
  }) as typeof fake.provider.logs.send;
  const logs = await fake.provider.appLogs('dep_test');
  assert.equal(logs.length, 50); assert.equal(logs[0].line, 'line-100'); assert.equal(logs[49].line, 'line-149');
});

test('foundation blocks all clients while retaining the ECS target group association', () => {
  const r = YAML.parse(readFileSync(new URL('../cloudformation/foundation.yaml', import.meta.url), 'utf8')).Resources;
  assert.deepEqual(r.Listener.Properties.DefaultActions, [{ Type: 'forward', TargetGroupArn: { Ref: 'TargetGroup' } }]);
  assert.deepEqual(r.TrafficGate.Properties.ListenerArn, { Ref: 'Listener' });
  assert.deepEqual(r.TrafficGate.Properties.Conditions, [{ Field: 'source-ip', SourceIpConfig: { Values: ['0.0.0.0/0', '::/0'] } }]);
  assert.equal(r.TrafficGate.Properties.Actions[0].FixedResponseConfig.StatusCode, '403');
});

for (const mode of ['none','postgres','external'] as const) {
  test(`generic ${mode} runtime uses ECS env/secret mappings without Spring injection`,async t=>{
    const fake=setup();
    if(mode!=='postgres') {
      fake.provider.config={...config,dbHost:undefined,dbName:undefined,dbUsername:undefined,dbPasswordSecretArn:undefined};
      fake.provider.scaling.send=(async()=>({})) as typeof fake.provider.scaling.send;
    }
    fake.provider.config.secrets={external_url:`arn:aws:secretsmanager:ap-northeast-2:${config.accountId}:secret:external`};
    fake.provider.rds.send=(async()=>{throw new Error('DB must not be mutated without architecture selection');}) as typeof fake.provider.rds.send;
    t.mock.method(globalThis,'fetch',async()=>new Response('',{status:fake.route}));
    const runtime={version:'http-runtime.v1',port:8080,health_path:'/health',env:{NODE_ENV:'production'},secret_refs:mode==='external'?{DATABASE_URL:'external_url'}:{},database:{mode,name:config.dbName!,bindings:mode==='postgres'?{PGHOST:'host',PGUSER:'username',PGPASSWORD:'password'}:{}},init_command:[]};
    const r=requestSchema.parse({...request,env:{},runtime,health_path:'/health'});
    const result=await fake.provider.deploy(r,AbortSignal.timeout(2000),()=>{});
    assert.equal(result.info.session,'app-managed');
    const app=(fake.definitions[0] as any).containerDefinitions[0];
    assert.ok(!app.environment.some((e:any)=>e.name.startsWith('SPRING')));
    assert.equal(app.environment.find((e:any)=>e.name==='PORT').value,'8080');
    assert.equal(app.secrets.length,mode==='none'?0:1);
    if(mode==='postgres') {
      assert.equal(app.secrets[0].name,'PGPASSWORD');
      assert.equal(app.environment.find((e:any)=>e.name==='PGHOST').value,config.dbHost);
    }
    assert.ok(!fake.actions.includes('RunTaskCommand'));
  });
}

test('generic initialization overrides image entrypoint and a failing migration stops rollout',async()=>{
  const fake=setup();let definition:any;
  fake.provider.ecs.send=(async(c:any)=>{
    if(c.constructor.name==='RegisterTaskDefinitionCommand'){definition=c.input;return {taskDefinition:{taskDefinitionArn:'migration'}};}
    if(c.constructor.name==='RunTaskCommand')return {tasks:[{taskArn:'migration-task'}]};
    if(c.constructor.name==='DescribeTasksCommand')return {tasks:[{lastStatus:'STOPPED',containers:[{name:'app',exitCode:1}]}]};
    return {};
  }) as typeof fake.provider.ecs.send;
  const runtime={version:'http-runtime.v1',port:8080,health_path:'/',env:{},secret_refs:{},database:{mode:'postgres',name:config.dbName!,bindings:{DB_PASSWORD:'password'}},init_command:['python','migrate.py']};
  await assert.rejects(fake.provider.initialize(requestSchema.parse({...request,env:{},runtime}),()=>{}),/initialization failed/);
  assert.deepEqual(definition.containerDefinitions[0].entryPoint,['python']);
  assert.deepEqual(definition.containerDefinitions[0].command,['migrate.py']);
});

test('DB-free foundation makes RDS resources/secret grants conditional and parameterizes app port',()=>{
  const f=YAML.parse(readFileSync(new URL('../cloudformation/foundation.yaml',import.meta.url),'utf8'));
  for(const name of ['Database','DbSecret','DbSg','DbSubnets'])assert.equal(f.Resources[name].Condition,'WithDatabase');
  assert.deepEqual(f.Resources.TargetGroup.Properties.Port,{Ref:'AppPort'});
  assert.equal(f.Outputs.DbHost.Condition,'WithDatabase');
});

test('DB-free medium architecture applies compute and scaling without any RDS call',async t=>{
  const fake=setup();
  fake.provider.config={...config,dbHost:undefined,dbName:undefined,dbUsername:undefined,dbPasswordSecretArn:undefined};
  fake.tasks.forEach((task,i)=>Object.assign(task,{availabilityZone:`az${i}`}));
  fake.provider.ec2.send=(async()=>({Subnets:[{AvailabilityZone:'az0',VpcId:'v'},{AvailabilityZone:'az1',VpcId:'v'}]})) as typeof fake.provider.ec2.send;
  const scale:string[]=[];
  fake.provider.scaling.send=(async(c:any)=>{scale.push(c.constructor.name);return {};}) as typeof fake.provider.scaling.send;
  fake.provider.rds.send=(async()=>{assert.fail('DB-free architecture must not call RDS');}) as typeof fake.provider.rds.send;
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status:fake.route}));
  const runtime={version:'http-runtime.v1',port:8080,health_path:'/',env:{},secret_refs:{},database:{mode:'none',name:'app',bindings:{}},init_command:[]};
  const r=requestSchema.parse({...request,env:{},runtime,architecture:{version:'aws-architecture.v1',template_id:'medium'}});
  const result=await fake.provider.deploy(r,AbortSignal.timeout(2000),()=>{});
  assert.equal(result.info.database,'none');
  assert.equal((fake.definitions[0] as any).cpu,'1024');
  assert.ok(scale.includes('RegisterScalableTargetCommand'));
  assert.ok(!fake.actions.includes('RunTaskCommand'));
});


test('managed URL reaches ECS only as a versioned secret and missing config fails before mutation',async t=>{
  const fake=setup();
  const runtime={version:'http-runtime.v1',port:8080,health_path:'/',env:{},secret_refs:{},database:{mode:'postgres',name:config.dbName!,bindings:{DATABASE_URL:'postgres_url',PGPASSWORD:'password'}},init_command:[]};
  const r=requestSchema.parse({...request,env:{},runtime});
  await assert.rejects(fake.provider.deploy(r,AbortSignal.timeout(2000),()=>{}),/dedicated PostgreSQL URL secret/);
  assert.equal(fake.actions.length,0);
  const arn=`arn:aws:secretsmanager:ap-northeast-2:${config.accountId}:secret:url-abcdef`;
  fake.provider.config={...fake.provider.config,dbUrlSecretArn:arn};
  fake.provider.secretManager.send=(async(c:any)=>{
    if(c.constructor.name==='PutSecretValueCommand')return {VersionId:'url-version'};
    return c.input.SecretId===arn?{SecretString:'{}',VersionId:'empty'}:{SecretString:JSON.stringify({password:'private@%value'}),VersionId:'password-version'};
  }) as typeof fake.provider.secretManager.send;
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status:fake.route}));
  await fake.provider.deploy(r,AbortSignal.timeout(2000),()=>{});
  const app=(fake.definitions[0] as any).containerDefinitions[0];
  assert.deepEqual(app.secrets.find((v:any)=>v.name==='DATABASE_URL'),{name:'DATABASE_URL',valueFrom:`${arn}:::url-version`});
  assert.equal(app.secrets.find((v:any)=>v.name==='PGPASSWORD').valueFrom,`${config.dbPasswordSecretArn}:password::password-version`);
  assert.ok(!app.environment.some((v:any)=>v.name==='DATABASE_URL'||v.name==='PGPASSWORD'));
  assert.ok(!JSON.stringify(fake.definitions).includes('private'));
});

test('foundation grants secret writes only to dedicated URL and external reads to supplied ARNs',()=>{
  const f=YAML.parse(readFileSync(new URL('../cloudformation/foundation.yaml',import.meta.url),'utf8'));
  assert.equal(f.Resources.DbUrlSecret.Condition,'WithDatabase');
  const statements=f.Resources.AdapterPolicy.Properties.PolicyDocument.Statement;
  const write=statements.map((s:any)=>s['Fn::If']?.[1]).find((s:any)=>s?.Action==='secretsmanager:PutSecretValue');
  assert.deepEqual(write.Resource,{Ref:'DbUrlSecret'});
  const execution=f.Resources.ExecutionRole.Properties.Policies[0].PolicyDocument.Statement;
  const external=execution.find((s:any)=>s['Fn::If']?.[0]==='WithAdditionalSecrets');
  assert.deepEqual(external['Fn::If'][1].Resource,{Ref:'AdditionalSecretArns'});
  const kms=execution.find((s:any)=>s['Fn::If']?.[0]==='WithAdditionalKmsKeys');
  assert.equal(kms['Fn::If'][1].Action,'kms:Decrypt');
  assert.ok(kms['Fn::If'][1].Condition.StringEquals['kms:ViaService']);
});
