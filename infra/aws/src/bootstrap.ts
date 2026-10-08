import { loadConfig } from './config.js';
import { AwsProvider } from './aws-provider.js';
import { requestSchema } from './model.js';

const [path, image] = process.argv.slice(2);
if (!path || !image) throw new Error('사용법: npm run bootstrap -w @shakedown/aws -- <config.json> <ECR image@sha256:digest>');
const config = loadConfig(path);
const provider = new AwsProvider(config);
const request = requestSchema.parse({ deployment_id: `dep_init${Date.now()}`, project_id: config.projectId, image, port: config.port, health_path: '/' });
provider.validate(request);
await provider.initialize(request, console.log);
