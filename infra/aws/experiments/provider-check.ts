import { loadConfig } from '../src/config.js';
import { AwsProvider } from '../src/aws-provider.js';
import { requestSchema } from '../src/model.js';

const [configPath, image, action] = process.argv.slice(2);
const provider = new AwsProvider(loadConfig(configPath));
const request = requestSchema.parse({
  deployment_id: 'dep_full' + Date.now(),
  project_id: provider.config.projectId, image, port: 8080, health_path: '/',
  env: {SPRING_PROFILES_ACTIVE: 'demo,session-jdbc'},
  options: {replicas: 2, sticky_sessions: false, tz: 'UTC'}
});
if (action === 'initialize') await provider.initialize(request, console.log);
else if (action === 'deploy') console.log(JSON.stringify(await provider.deploy(request, AbortSignal.timeout(600_000), console.log)));
else throw new Error('Expected initialize or deploy');
