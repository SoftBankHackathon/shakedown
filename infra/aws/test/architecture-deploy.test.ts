import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configSchema, validateRequest } from '../src/config.js';
import { requestSchema } from '../src/model.js';
import { AwsProvider } from '../src/aws-provider.js';
import { architectures } from '../src/architecture.js';
const config = configSchema.parse({ ...JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url),'utf8')), dbInstanceId:'test-db', subnetIds:['subnet-a','subnet-b','subnet-c'] });
const image=config.repositoryUri+'@sha256:'+'a'.repeat(64);
for (const engine of ['postgres','mysql'] as const) for (const tier of ['small','medium','large'] as const) {
  test(`${engine}/${tier}: actual adapter command flow applies resources, AZs, DB and scaling`, async t=>{
    const spec=architectures[tier];
    const request=requestSchema.parse({deployment_id:'dep_archtest',project_id:config.projectId,image,port:8080,health_path:'/',...(engine==='mysql'?{env:{},runtime:{version:'http-runtime.v1',port:8080,health_path:'/',env:{},secret_refs:{},database:{mode:'mysql',name:config.dbName,bindings:{DB_PASSWORD:'password'}},init_command:['node','migrate.mjs']}}:{env:{SPRING_PROFILES_ACTIVE:'demo,session-jdbc'}}),options:{replicas:spec.min},architecture:{version:'aws-architecture.v1',template_id:tier}});
    const provider=new AwsProvider({...config,dbEngine:engine}); const commands: {name:string,input:any}[]=[];
    let route=403, exists=false, multi=!spec.multiAZ, checks=0;
    // DB polling interval is skipped by returning desired state after the first read.
    const tasks=Array.from({length:spec.min},(_,i)=>({lastStatus:'RUNNING',availabilityZone:`az${i}`,taskDefinitionArn:'app-definition',containers:[{name:'app',imageDigest:image.split('@')[1]}],attachments:[{details:[{name:'privateIPv4Address',value:`10.0.${i}.10`}]}]}));
    provider.sts.send=(async()=>({Account:config.accountId})) as typeof provider.sts.send;
    provider.ecr.send=(async()=>({imageDetails:[{imageManifestMediaType:'application/vnd.oci.image.manifest.v1+json'}]})) as typeof provider.ecr.send;
    provider.ec2.send=(async()=>({Subnets:Array.from({length:spec.azs},(_,i)=>({AvailabilityZone:`az${i}`,VpcId:'vpc-test'}))})) as typeof provider.ec2.send;
    provider.rds.send=(async(c:any)=>{
      commands.push({name:c.constructor.name,input:c.input});
      if(c.constructor.name==='ModifyDBInstanceCommand'){multi=c.input.MultiAZ;return {};}
      checks++; return {DBInstances:[{Engine:engine,Endpoint:{Address:config.dbHost},DBSubnetGroup:{VpcId:'vpc-test'},DBInstanceStatus:'available',MultiAZ:multi,PendingModifiedValues:{}}]};
    }) as typeof provider.rds.send;
    provider.scaling.send=(async(c:any)=>{commands.push({name:c.constructor.name,input:c.input});return {ScalableTargets:[{}]};}) as typeof provider.scaling.send;
    provider.ecs.send=(async(c:any)=>{
      commands.push({name:c.constructor.name,input:c.input});
      switch(c.constructor.name){
        case 'RegisterTaskDefinitionCommand':return {taskDefinition:{taskDefinitionArn:(c.input.containerDefinitions[0].entryPoint || c.input.containerDefinitions[0].environment.find((e:any)=>e.name==='SPRING_PROFILES_ACTIVE')?.value==='schema-init')?'init-definition':'app-definition'}};
        case 'RunTaskCommand': return {tasks:[{taskArn:'init-task'}]};
        case 'DescribeServicesCommand': return {services:exists?[{status:'ACTIVE',pendingCount:0,deployments:[{taskDefinition:'app-definition',rolloutState:'COMPLETED'}]}]:[]};
        case 'CreateServiceCommand': exists=true;return {};
        case 'ListTasksCommand':return {taskArns:exists?tasks.map((_,i)=>`task${i}`):[]};
        case 'DescribeTasksCommand':return {tasks:c.input.tasks[0]==='init-task'?[{lastStatus:'STOPPED',containers:[{name:'app',exitCode:0}]}]:tasks};
        case 'DescribeTaskDefinitionCommand':return {taskDefinition:{containerDefinitions:[{name:'app',environment:[{name:'SPRING_PROFILES_ACTIVE',value:'demo,session-jdbc'}]}]}};
        case 'DeleteServiceCommand':exists=false;return {};
      }return {};
    }) as typeof provider.ecs.send;
    provider.elb.send=(async(c:any)=>{
      commands.push({name:c.constructor.name,input:c.input});
      if(c.constructor.name==='ModifyRuleCommand')route=c.input.Actions[0].Type==='forward'?200:403;
      if(c.constructor.name==='DescribeTargetHealthCommand')return {TargetHealthDescriptions:tasks.map(t=>({Target:{Id:t.attachments[0].details[0].value},TargetHealth:{State:'healthy'}}))};
      return {};
    }) as typeof provider.elb.send;
    t.mock.method(globalThis,'fetch',async()=>new Response('',{status:route}));
    const result=await provider.deploy(request,AbortSignal.timeout(10000),()=>{});
    assert.equal(result.info.architecture,tier);assert.equal(result.instances,spec.min);
    assert.ok(checks>=3);assert.equal(multi,spec.multiAZ);
    const defs=commands.filter(c=>c.name==='RegisterTaskDefinitionCommand');assert.equal(defs.length,2);
    for(const d of defs){assert.equal(d.input.cpu,spec.cpu);assert.equal(d.input.memory,spec.memory);}
    const service=commands.find(c=>c.name==='CreateServiceCommand')!.input;
    assert.equal(service.desiredCount,spec.min);assert.equal(service.networkConfiguration.awsvpcConfiguration.subnets.length,spec.azs);
    const scaling=commands.find(c=>c.name==='RegisterScalableTargetCommand');
    assert.equal(!!scaling,tier!=='small');if(scaling){assert.equal(scaling.input.MinCapacity,spec.min);assert.equal(scaling.input.MaxCapacity,spec.max);}
    await provider.stop(()=>{});assert.equal(route,403);
    assert.ok(commands.findLastIndex(c=>c.name==='DeregisterScalableTargetCommand')<commands.findLastIndex(c=>c.name==='DeleteServiceCommand'));
  });
}
test('cannot spoof resources, mix replica override or deploy large on two subnets',()=>{
  const body={deployment_id:'dep_test',project_id:config.projectId,image,port:8080,health_path:'/',env:{SPRING_PROFILES_ACTIVE:'demo,session-jdbc'},options:{replicas:3},architecture:{version:'aws-architecture.v1',template_id:'large'}};
  assert.throws(()=>requestSchema.parse({...body,architecture:{...body.architecture,cpu:9999}}));
  assert.throws(()=>validateRequest({...config,subnetIds:['subnet-a','subnet-b']},requestSchema.parse(body)),/스택/);
  assert.throws(()=>validateRequest(config,requestSchema.parse({...body,options:{replicas:1}})),/Replicas/);
  assert.throws(()=>validateRequest(config,requestSchema.parse({...body,architecture:undefined})),/Replicas/);
});

test('foundation mismatch fails before any resource mutation',async()=>{
  const provider=new AwsProvider(config);
  provider.sts.send=(async()=>({Account:config.accountId})) as typeof provider.sts.send;
  provider.ec2.send=(async()=>({Subnets:[{AvailabilityZone:'same',VpcId:'v'},{AvailabilityZone:'same',VpcId:'v'}]})) as typeof provider.ec2.send;
  let mutated=false;
  provider.elb.send=(async()=>{mutated=true;return {};}) as typeof provider.elb.send;
  const request=requestSchema.parse({deployment_id:'dep_test',project_id:config.projectId,image,port:8080,health_path:'/',env:{SPRING_PROFILES_ACTIVE:'demo,session-jdbc'},options:{replicas:2},architecture:{version:'aws-architecture.v1',template_id:'medium'}});
  await assert.rejects(provider.deploy(request,AbortSignal.timeout(100),()=>{}),/AZ/);
  assert.equal(mutated,false);
});
