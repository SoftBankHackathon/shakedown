// 한 프로젝트 전용 Azure 기반 인프라. 앱(Container App, 스키마 초기화 작업)은 app.bicep, 범용 초기화 작업은 init.bicep에서 만든다.
// DB 엔진은 스택마다 하나다 (AWS와 같은 원칙): PostgreSQL·MySQL Flexible은 위임 서브넷, Cosmos DB for MongoDB vCore는 private endpoint.
// 두 단계로 나눈 이유: 관리 ID의 Key Vault·ACR 권한이 반영된 뒤에 앱을 만들어야 비밀값과 이미지를 읽을 수 있다.
targetScope = 'resourceGroup'

param location string = resourceGroup().location
@description('DB 관리자 비밀번호. provision.sh가 만들어 넘기고 Key Vault에만 저장된다.')
@secure()
param dbPassword string
@allowed([ 'postgres', 'mysql', 'mongodb' ])
param databaseEngine string = 'postgres'
param dbName string = 'board_db'
param dbUsername string = 'app'

var suffix = uniqueString(resourceGroup().id)
var isPostgres = databaseEngine == 'postgres'
var isMysql = databaseEngine == 'mysql'
var isMongo = databaseEngine == 'mongodb'
// 서버 이름과 접속 호스트. FQDN은 서비스 규칙대로 정해지므로 조건부 리소스를 참조하지 않고 만든다.
var dbServer = { postgres: 'sd-pg-${suffix}', mysql: 'sd-my-${suffix}', mongodb: 'sd-mongo-${suffix}' }[databaseEngine]
var dbHost = {
  postgres: '${dbServer}.postgres.database.azure.com'
  mysql: '${dbServer}.mysql.database.azure.com'
  mongodb: '${dbServer}.global.mongocluster.cosmos.azure.com'
}[databaseEngine]
// 비밀번호가 든 접속 URL (packages/contracts databaseUrl과 같은 모양). Key Vault db-url에만 저장한다.
// Cosmos vCore는 SRV 주소·SCRAM·retrywrites=false가 필요하고 관리자는 admin DB에서 인증한다.
var credentials = '${uriComponent(dbUsername)}:${uriComponent(dbPassword)}'
var dbUrl = {
  postgres: 'postgresql://${credentials}@${dbHost}:5432/${dbName}?sslmode=require'
  mysql: 'mysql://${credentials}@${dbHost}:3306/${dbName}?ssl=${uriComponent('{"rejectUnauthorized":true,"verifyIdentity":true}')}'
  mongodb: 'mongodb+srv://${credentials}@${dbHost}/${dbName}?tls=true&authMechanism=SCRAM-SHA-256&authSource=admin&retrywrites=false&maxIdleTimeMS=120000'
}[databaseEngine]
var dbDnsZone = {
  postgres: 'sd-${suffix}.private.postgres.database.azure.com'
  mysql: 'sd-${suffix}.private.mysql.database.azure.com'
  mongodb: 'privatelink.mongocluster.cosmos.azure.com'
}[databaseEngine]
// private endpoint 서브넷은 위임하지 않는다
var dbDelegations = {
  postgres: [ { name: 'db', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } } ]
  mysql: [ { name: 'db', properties: { serviceName: 'Microsoft.DBforMySQL/flexibleServers' } } ]
  mongodb: []
}[databaseEngine]
var roles = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'sd-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30 // 최소값, 추가 비용 없음
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'sd-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: [ '10.40.0.0/16' ] }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: '10.40.0.0/23'
          delegations: [ { name: 'apps', properties: { serviceName: 'Microsoft.App/environments' } } ]
        }
      }
      {
        name: 'db'
        properties: {
          addressPrefix: '10.40.2.0/24'
          delegations: dbDelegations
        }
      }
    ]
  }
}

resource dbDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: dbDnsZone
  location: 'global'
}

resource dbDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: dbDns
  name: 'sd-vnet'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnet.id }
    registrationEnabled: false
  }
}

resource db 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = if (isPostgres) {
  name: dbServer
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '17'
    administratorLogin: dbUsername
    administratorLoginPassword: dbPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: {
      delegatedSubnetResourceId: vnet.properties.subnets[1].id
      privateDnsZoneArmResourceId: dbDns.id
      publicNetworkAccess: 'Disabled'
    }
  }
  dependsOn: [ dbDnsLink ]
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = if (isPostgres) {
  parent: db
  name: dbName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// MySQL 8.0 (안정 API 2024-12-30이 받는 최신. 8.4는 preview API에만 있다). TLS 필수가 기본값이다.
resource mysql 'Microsoft.DBforMySQL/flexibleServers@2024-12-30' = if (isMysql) {
  name: dbServer
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '8.0.21'
    administratorLogin: dbUsername
    administratorLoginPassword: dbPassword
    storage: { storageSizeGB: 20, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: {
      delegatedSubnetResourceId: vnet.properties.subnets[1].id
      privateDnsZoneResourceId: dbDns.id
      publicNetworkAccess: 'Disabled'
    }
  }
  dependsOn: [ dbDnsLink ]
}

resource mysqlDatabase 'Microsoft.DBforMySQL/flexibleServers/databases@2024-12-30' = if (isMysql) {
  parent: mysql
  name: dbName
  properties: { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }
}

// Cosmos DB for MongoDB vCore: 가장 작은 유료 등급(M10, 버스터블), 샤드 1개, 공개 접근 없이 private endpoint로만.
// 데이터베이스는 앱이 처음 쓸 때 만들어진다 (MongoDB 동작).
resource mongo 'Microsoft.DocumentDB/mongoClusters@2025-09-01' = if (isMongo) {
  name: dbServer
  location: location
  properties: {
    administrator: { userName: dbUsername, password: dbPassword }
    serverVersion: '8.0'
    compute: { tier: 'M10' }
    storage: { sizeGb: 32 }
    sharding: { shardCount: 1 }
    highAvailability: { targetMode: 'Disabled' }
    publicNetworkAccess: 'Disabled'
  }
}

resource mongoEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (isMongo) {
  name: 'sd-mongo-pe'
  location: location
  properties: {
    subnet: { id: vnet.properties.subnets[1].id }
    privateLinkServiceConnections: [ { name: 'mongo', properties: { privateLinkServiceId: mongo.id, groupIds: [ 'MongoCluster' ] } } ]
  }
}

resource mongoDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (isMongo) {
  parent: mongoEndpoint
  name: 'mongo'
  properties: { privateDnsZoneConfigs: [ { name: 'mongocluster', properties: { privateDnsZoneId: dbDns.id } } ] }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'sd-app-id'
  location: location
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'sd-kv-${take(suffix, 10)}'
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

resource dbPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'db-password'
  properties: { value: dbPassword }
}

// *_url 바인딩용. 어댑터는 이 비밀의 주소만 알고 값은 Container App이 관리 ID로 읽는다.
resource dbUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'db-url'
  properties: { value: dbUrl }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'sdacr${suffix}'
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource vaultAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, identity.id, roles.keyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource registryAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, identity.id, roles.acrPull)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'sd-env'
  location: location
  properties: {
    workloadProfiles: [ { name: 'Consumption', workloadProfileType: 'Consumption' } ]
    vnetConfiguration: {
      infrastructureSubnetId: vnet.properties.subnets[0].id
      internal: false
    }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

output environmentName string = environment.name
output identityName string = identity.name
output registryServer string = registry.properties.loginServer
output dbHost string = dbHost
output dbName string = dbName
output dbUsername string = dbUsername
// 비밀값이 아니라 Key Vault 비밀의 주소다. 값은 Container App만 관리 ID로 읽는다.
#disable-next-line outputs-should-not-contain-secrets
output dbPasswordSecretUri string = '${vault.properties.vaultUri}secrets/${dbPasswordSecret.name}'
#disable-next-line outputs-should-not-contain-secrets
output dbUrlSecretUri string = '${vault.properties.vaultUri}secrets/${dbUrlSecret.name}'
output vaultName string = vault.name
