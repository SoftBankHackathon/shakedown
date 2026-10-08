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
  const provider = new AwsProvider(config);
  let route = 403; let servicePresent = false;
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
      case 'CreateServiceCommand': servicePresent = true; return {};
      case 'ListTasksCommand': return { taskArns: servicePresent ? ['task1', 'task2'] : [] };
      case 'DescribeTasksCommand': return { tasks };
      case 'DescribeTaskDefinitionCommand': return { taskDefinition: { containerDefinitions: [{ name: 'app', environment: [{ name: 'TZ', value: 'UTC' }, { name: 'SPRING_PROFILES_ACTIVE', value: 'demo,session-jdbc' }] }] } };
      case 'DeleteServiceCommand': servicePresent = false; return {};
      default: return {};
    }
  }) as typeof provider.ecs.send;
  provider.elb.send = (async (command: { constructor: { name: string }; input: { DefaultActions?: { Type: string }[] } }) => {
    const name = command.constructor.name;
    actions.push(name);
    if (name === 'ModifyListenerCommand') route = command.input.DefaultActions?.[0].Type === 'forward' ? 200 : 403;
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
  assert.ok(fake.actions.lastIndexOf('ModifyListenerCommand') > fake.actions.indexOf('DescribeTargetHealthCommand'));
  await fake.provider.stop(() => {});
  assert.equal(fake.route, 403);
  assert.ok(fake.actions.lastIndexOf('ModifyListenerCommand') < fake.actions.indexOf('DeleteServiceCommand'));
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
