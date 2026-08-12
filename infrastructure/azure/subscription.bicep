targetScope = 'subscription'

@description('Azure region selected at deployment time. Changing this value must not require application code changes.')
param location string

@minLength(3)
@maxLength(24)
@description('Lowercase prefix used for Azure resource names.')
param namePrefix string = 'knowhowbeta'

@description('Object ID of the human deployment operator.')
param deployerObjectId string

@description('Email that receives infrastructure alerts and is allowed to create the Appwrite root console account.')
param operatorEmail string

@description('SSH public key for the disabled-by-default emergency administration account.')
param sshPublicKey string

@description('Emergency local VM account. Inbound SSH remains blocked by the NSG.')
param adminUsername string = 'knowhowops'

@description('Available VM SKU with at least 2 vCPU and 4 GiB RAM.')
param vmSize string

@description('Pinned Appwrite server release.')
param appwriteVersion string = '1.9.6'

var resourceGroupName = '${namePrefix}-${location}-rg'

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-11-01' = {
  name: resourceGroupName
  location: location
  tags: {
    application: 'KnowHow'
    environment: 'private-beta'
    dataResidency: location
    managedBy: 'Bicep'
  }
}

module platform 'main.bicep' = {
  name: 'knowhow-private-beta-platform'
  scope: resourceGroup
  params: {
    location: location
    namePrefix: namePrefix
    deployerObjectId: deployerObjectId
    operatorEmail: operatorEmail
    sshPublicKey: sshPublicKey
    adminUsername: adminUsername
    vmSize: vmSize
    appwriteVersion: appwriteVersion
  }
}

output resourceGroupName string = resourceGroup.name
output vmName string = platform.outputs.vmName
output apiFqdn string = platform.outputs.apiFqdn
output publicIpAddress string = platform.outputs.publicIpAddress
output productionSiteFqdn string = platform.outputs.productionSiteFqdn
output stagingSiteFqdn string = platform.outputs.stagingSiteFqdn
output keyVaultName string = platform.outputs.keyVaultName
output backupStorageAccountName string = platform.outputs.backupStorageAccountName
output backupContainerName string = platform.outputs.backupContainerName
output logAnalyticsWorkspaceName string = platform.outputs.logAnalyticsWorkspaceName
output recoveryServicesVaultName string = platform.outputs.recoveryServicesVaultName
