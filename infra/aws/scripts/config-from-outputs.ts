import { readFileSync } from 'node:fs';
const [outputPath, profile, accountId, projectId] = process.argv.slice(2);
if (!outputPath || !profile || !/^\d{12}$/.test(accountId ?? '') || !projectId) throw new Error('Usage: config-from-outputs.ts outputs.json hackathon-profile account-id project-id');
const outputs = Object.fromEntries(JSON.parse(readFileSync(outputPath, 'utf8')).map((v: { OutputKey: string; OutputValue: string }) => [v.OutputKey, v.OutputValue]));
const keys = ['ClusterArn','Repository','RepositoryUri','ServiceName','ListenerArn','GateRuleArn','TargetGroupArn','PublicUrl','SecurityGroupId','ExecutionRoleArn','TaskRoleArn','LogGroup','DbInstanceId','DbHost','DbName','DbUsername','DbPasswordSecretArn'];
const config: Record<string, unknown> = { profile, accountId, projectId, region: 'ap-northeast-2', port: 8080 };
for (const key of keys) { if (!outputs[key]) throw new Error(`Missing output ${key}`); config[key[0].toLowerCase() + key.slice(1)] = outputs[key]; }
config.subnetIds = outputs.SubnetIds.split(',');
console.log(JSON.stringify(config, null, 2));
