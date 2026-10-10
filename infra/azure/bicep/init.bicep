// runtime.init_command(마이그레이션 등)를 실행하는 Container Apps 작업. 어댑터가 배포 때 이미지·명령·환경변수를 채우고 한 번 실행한다.
// app.bicep과 나눈 이유: 이미 운영 중인 스택에도 앱을 다시 만들지 않고 이 작업만 추가할 수 있게.
targetScope = 'resourceGroup'

param location string = resourceGroup().location
param environmentName string
param identityName string
param registryServer string
param dbPasswordSecretUri string

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource init 'Microsoft.App/jobs@2024-03-01' = {
  name: 'sd-init'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [ { server: registryServer, identity: identity.id } ]
      secrets: [ { name: 'db-password', keyVaultUrl: dbPasswordSecretUri, identity: identity.id } ]
    }
    template: {
      containers: [ { name: 'init', image: 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest', resources: { cpu: json('0.5'), memory: '1Gi' } } ]
    }
  }
}

output initJob string = init.name
