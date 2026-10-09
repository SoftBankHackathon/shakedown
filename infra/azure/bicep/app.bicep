// main.bicep이 만든 기반 위에 Container App과 스키마 초기화 작업을 만든다.
// 처음에는 공개 샘플 이미지와 복제본 0으로 만들어 두고, 실제 이미지·복제본은 어댑터가 배포 때 바꾼다.
targetScope = 'resourceGroup'

param location string = resourceGroup().location
param environmentName string
param identityName string
param registryServer string
param dbHost string
param dbName string
param dbUsername string
param dbPasswordSecretUri string
param port int = 8080

var placeholderImage = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
// 앱과 스키마 초기화 작업이 같이 쓰는 값
var appIdentity = { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
var secrets = [ { name: 'db-password', keyVaultUrl: dbPasswordSecretUri, identity: identity.id } ]
var registries = [ { server: registryServer, identity: identity.id } ]
var resources = { cpu: json('0.5'), memory: '1Gi' }

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'sd-app'
  location: location
  identity: appIdentity
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: port
        transport: 'auto'
        allowInsecure: false
        traffic: [ { latestRevision: true, weight: 100 } ]
      }
      registries: registries
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: 'app'
          image: placeholderImage
          resources: resources
        }
      ]
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
}

resource schemaInit 'Microsoft.App/jobs@2024-03-01' = {
  name: 'sd-schema-init'
  location: location
  identity: appIdentity
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: registries
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: 'init'
          image: placeholderImage
          resources: resources
          // 어댑터(azure-provider.ts desired)가 앱에 넣는 DB 값과 같다. 초기화만 ddl update + schema-init 프로필.
          env: [
            { name: 'SPRING_DATASOURCE_URL', value: 'jdbc:postgresql://${dbHost}:5432/${dbName}?sslmode=require' }
            { name: 'SPRING_DATASOURCE_USERNAME', value: dbUsername }
            { name: 'SPRING_DATASOURCE_PASSWORD', secretRef: 'db-password' }
            { name: 'SPRING_PROFILES_ACTIVE', value: 'schema-init' }
            { name: 'SPRING_JPA_HIBERNATE_DDL_AUTO', value: 'update' }
          ]
        }
      ]
    }
  }
}

output containerApp string = app.name
output publicUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output schemaInitJob string = schemaInit.name
