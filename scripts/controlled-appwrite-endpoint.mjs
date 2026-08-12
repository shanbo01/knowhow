const AZURE_REGION = /^[a-z0-9]{2,32}$/;

function approvedAzureRegion(residency) {
  const prefix = "azure-self-hosted:";
  if (!residency.startsWith(prefix)) return null;
  const region = residency.slice(prefix.length);
  return AZURE_REGION.test(region) ? region : null;
}

export function exactControlledAppwriteEndpoint(raw, residency = "") {
  if (typeof raw !== "string" || raw !== raw.trim()) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const exactRaw =
    raw === `https://${url.hostname}/v1` ||
    raw === `https://${url.hostname}/v1/`;
  const exactShape =
    exactRaw &&
    url.protocol === "https:" &&
    url.pathname.replace(/\/$/, "") === "/v1" &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash;
  if (!exactShape) return null;
  const normalizedResidency = residency?.trim?.() ?? "";
  const cloud =
    url.hostname === "fra.cloud.appwrite.io" &&
    (!normalizedResidency || normalizedResidency === "appwrite-cloud-frankfurt");
  const azureRegion = approvedAzureRegion(normalizedResidency);
  const azure =
    azureRegion !== null &&
    url.hostname.endsWith(`.${azureRegion}.cloudapp.azure.com`) &&
    url.hostname !== `${azureRegion}.cloudapp.azure.com`;
  return cloud || azure ? url.toString().replace(/\/$/, "") : null;
}

export function controlledEndpointOrigin(raw, residency = "") {
  const endpoint = exactControlledAppwriteEndpoint(raw, residency);
  return endpoint ? new URL(endpoint).origin : null;
}
