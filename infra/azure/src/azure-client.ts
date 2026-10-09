import { AzureCliCredential } from '@azure/identity';
import { ContainerAppsAPIClient, type ContainerApp, type Revision } from '@azure/arm-appcontainers';
import { ContainerRegistryClient, KnownContainerRegistryAudience } from '@azure/container-registry';
import { LogsQueryClient, LogsQueryResultStatus } from '@azure/monitor-query-logs';
import type { Config } from './config.js';
import { registryServer, repositoryName } from './config.js';

export type Manifest = { architecture?: string; operatingSystem?: string; multiArch: boolean };
export type LogRow = { ts: string; source: string; line: string };
export type Identity = { tenantId: string; subscriptionId: string; subscriptionTenantId: string; state: string };

// azure-provider가 쓰는 Azure 호출만 모은 얇은 계층. 테스트에서는 가짜로 바꾼다.
export interface AzureApi {
  identity(signal: AbortSignal): Promise<Identity>;
  databaseState(signal: AbortSignal): Promise<string>;
  getApp(signal: AbortSignal): Promise<ContainerApp>;
  putApp(app: ContainerApp, signal: AbortSignal): Promise<ContainerApp>;
  getRevision(name: string, signal: AbortSignal): Promise<Revision | undefined>;
  deactivateRevision(name: string, signal: AbortSignal): Promise<void>;
  manifest(digest: string, signal: AbortSignal): Promise<Manifest | undefined>;
  // 최근 로그: Container Apps 로그 스트림 (거의 실시간)
  streamLogs(revision: string, signal: AbortSignal): Promise<LogRow[]>;
  // 이전 로그: Log Analytics (반영이 수 분 늦음)
  queryLogs(query: string, since: Date | undefined, signal: AbortSignal): Promise<LogRow[]>;
}

const ARM = 'https://management.azure.com';
const notFound = (error: unknown) => (error as { statusCode?: number }).statusCode === 404;

export class AzureClient implements AzureApi {
  // 키나 비밀번호를 파일에 두지 않고 az login 정보만 사용한다.
  credential: AzureCliCredential;
  apps: ContainerAppsAPIClient; registry: ContainerRegistryClient; logs: LogsQueryClient;
  private workspace?: string;
  constructor(private config: Config) {
    this.credential = new AzureCliCredential({ tenantId: config.tenantId });
    this.apps = new ContainerAppsAPIClient(this.credential, config.subscriptionId);
    this.registry = new ContainerRegistryClient(`https://${registryServer(config)}`, this.credential, { audience: KnownContainerRegistryAudience.AzureResourceManagerPublicCloud });
    this.logs = new LogsQueryClient(this.credential);
  }
  private async token(signal: AbortSignal) { return (await this.credential.getToken(`${ARM}/.default`, { abortSignal: signal })).token; }
  private async arm<T>(path: string, apiVersion: string, signal: AbortSignal): Promise<T> {
    const response = await fetch(`${ARM}${path}?api-version=${apiVersion}`, { headers: { Authorization: `Bearer ${await this.token(signal)}` }, signal });
    if (!response.ok) throw new Error(`Azure 리소스를 조회할 수 없습니다 (HTTP ${response.status}): ${path.split('/').at(-1)}`);
    return response.json() as Promise<T>;
  }
  async identity(signal: AbortSignal): Promise<Identity> {
    const token = await this.token(signal);
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { tid?: string };
    const subscription = await this.arm<{ subscriptionId: string; tenantId: string; state: string }>(`/subscriptions/${this.config.subscriptionId}`, '2022-12-01', signal);
    return { tenantId: claims.tid ?? '', subscriptionId: subscription.subscriptionId, subscriptionTenantId: subscription.tenantId, state: subscription.state };
  }
  async databaseState(signal: AbortSignal) {
    const c = this.config, server = c.dbHost.split('.')[0];
    const result = await this.arm<{ properties?: { state?: string } }>(`/subscriptions/${c.subscriptionId}/resourceGroups/${c.resourceGroup}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${server}`, '2024-08-01', signal);
    return result.properties?.state ?? 'Unknown';
  }
  getApp(signal: AbortSignal) { return this.apps.containerApps.get(this.config.resourceGroup, this.config.containerApp, { abortSignal: signal }); }
  putApp(app: ContainerApp, signal: AbortSignal) { return this.apps.containerApps.beginCreateOrUpdateAndWait(this.config.resourceGroup, this.config.containerApp, app, { abortSignal: signal }); }
  async getRevision(name: string, signal: AbortSignal) {
    try { return await this.apps.containerAppsRevisions.getRevision(this.config.resourceGroup, this.config.containerApp, name, { abortSignal: signal }); }
    catch (error) { if (notFound(error)) return undefined; throw error; }
  }
  async deactivateRevision(name: string, signal: AbortSignal) { await this.apps.containerAppsRevisions.deactivateRevision(this.config.resourceGroup, this.config.containerApp, name, { abortSignal: signal }); }
  async manifest(digest: string, signal: AbortSignal) {
    try {
      const properties = await this.registry.getArtifact(repositoryName(this.config), digest).getManifestProperties({ abortSignal: signal });
      return { architecture: properties.architecture, operatingSystem: properties.operatingSystem, multiArch: properties.relatedArtifacts.length > 0 };
    } catch (error) { if (notFound(error)) return undefined; throw error; }
  }
  async streamLogs(revision: string, signal: AbortSignal) {
    const c = this.config;
    const [app, auth, replicas] = await Promise.all([
      this.getApp(signal),
      this.apps.containerApps.getAuthToken(c.resourceGroup, c.containerApp, { abortSignal: signal }),
      this.apps.containerAppsRevisionReplicas.listReplicas(c.resourceGroup, c.containerApp, revision, { abortSignal: signal }),
    ]);
    if (!app.eventStreamEndpoint || !auth.token) return [];
    // az containerapp logs show와 같은 주소 (확인 필요: 실제 Azure에서 응답 형식 실측)
    const base = app.eventStreamEndpoint.slice(0, app.eventStreamEndpoint.indexOf('/subscriptions/'));
    const lines = await Promise.all(replicas.value.map(async replica => {
      const url = `${base}/subscriptions/${c.subscriptionId}/resourceGroups/${c.resourceGroup}/containerApps/${c.containerApp}/revisions/${revision}/replicas/${replica.name}/containers/app/logstream?tailLines=50&follow=false&output=json`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${auth.token}` }, signal });
      if (!response.ok) throw new Error(`로그 스트림 HTTP ${response.status}`);
      return (await response.text()).split('\n').filter(Boolean).map(text => {
        try { const v = JSON.parse(text) as { TimeStamp?: string; Log?: string }; return { ts: new Date(v.TimeStamp ?? Date.now()).toISOString(), source: 'app', line: v.Log ?? text }; }
        catch { return { ts: new Date().toISOString(), source: 'app', line: text }; }
      });
    }));
    return lines.flat();
  }
  private async workspaceId(signal: AbortSignal) {
    if (this.workspace) return this.workspace;
    const app = await this.getApp(signal);
    const environment = (app.environmentId ?? app.managedEnvironmentId ?? '').split('/').at(-1)!;
    const env = await this.apps.managedEnvironments.get(this.config.resourceGroup, environment, { abortSignal: signal });
    const id = env.appLogsConfiguration?.logAnalyticsConfiguration?.customerId;
    if (!id) throw new Error('Container Apps 환경에 Log Analytics가 연결되어 있지 않습니다.');
    return this.workspace = id;
  }
  async queryLogs(query: string, since: Date | undefined, signal: AbortSignal) {
    const timespan = since ? { startTime: since, endTime: new Date() } : { duration: 'P1D' };
    const result = await this.logs.queryWorkspace(await this.workspaceId(signal), query, timespan, { abortSignal: signal });
    if (result.status !== LogsQueryResultStatus.Success) throw new Error('Log Analytics 조회가 일부 실패했습니다.');
    const table = result.tables[0];
    if (!table) return [];
    const index = (name: string) => table.columnDescriptors.findIndex(c => c.name === name);
    const [ts, source, line] = [index('ts'), index('source'), index('line')];
    return table.rows.map(row => ({ ts: new Date(row[ts] as string | Date).toISOString(), source: String(row[source]), line: String(row[line] ?? '') }));
  }
}
