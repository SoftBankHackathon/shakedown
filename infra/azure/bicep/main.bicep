// 한 프로젝트 전용 Azure 기반 인프라. 앱(Container App, 스키마 초기화 작업)은 app.bicep에서 만든다.
// 두 단계로 나눈 이유: 관리 ID의 Key Vault·ACR 권한이 반영된 뒤에 앱을 만들어야 비밀값과 이미지를 읽을 수 있다.
targetScope = 'resourceGroup'

param location string = resourceGroup().location
@description('PostgreSQL 관리자 비밀번호. provision.sh가 만들어 넘기고 Key Vault에만 저장된다.')
@secure()
param dbPassword string
param dbName string = 'board_db'
param dbUsername string = 'app'

var suffix = uniqueString(resourceGroup().id)
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
          delegations: [ { name: 'db', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } } ]
        }
      }
    ]
  }
}

resource dbDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'sd-${suffix}.private.postgres.database.azure.com'
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

resource db 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'sd-pg-${suffix}'
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

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: db
  name: dbName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
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
output dbHost string = db.properties.fullyQualifiedDomainName
output dbName string = database.name
output dbUsername string = dbUsername
// 비밀값이 아니라 Key Vault 비밀의 주소다. 값은 Container App만 관리 ID로 읽는다.
#disable-next-line outputs-should-not-contain-secrets
output dbPasswordSecretUri string = '${vault.properties.vaultUri}secrets/${dbPasswordSecret.name}'
output vaultName string = vault.name
