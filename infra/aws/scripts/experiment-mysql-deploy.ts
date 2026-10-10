// Explicit opt-in experiment: caller supplies a dedicated config and immutable image.
import {writeFileSync} from 'node:fs';
import {loadConfig} from '../src/config.js';
import {AwsProvider} from '../src/aws-provider.js';
import {requestSchema} from '../src/model.js';
const [configPath,image,resultPath]=process.argv.slice(2);
if(!configPath||!image||!resultPath)throw Error('Usage: config image-digest evidence-path');
const config=loadConfig(configPath);
if(config.dbEngine!=='mysql')throw Error('MySQL experiment only');
const provider=new AwsProvider(config);
const runtime={version:'http-runtime.v1',port:config.port,health_path:'/',env:{},secret_refs:{},database:{mode:'mysql',name:config.dbName,bindings:{DATABASE_URL:'mysql_url'}},init_command:[]};
const request=requestSchema.parse({deployment_id:'dep_mysqllive',project_id:config.projectId,image,port:config.port,health_path:'/',runtime,architecture:{version:'aws-architecture.v1',template_id:'small'},options:{replicas:1}});
const result=await provider.deploy(request,AbortSignal.timeout(900000),console.log);
writeFileSync(resultPath,JSON.stringify(result,null,2));
console.log('TLS-backed ECS application ready');
