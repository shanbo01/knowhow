const AZURE_QATAR_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.qatarcentral\.cloudapp\.azure\.com$/;

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
  const qatar =
    normalizedResidency === "azure-qatar-central" &&
    AZURE_QATAR_HOST.test(url.hostname);
  return cloud || qatar ? url.toString().replace(/\/$/, "") : null;
}

export function controlledEndpointOrigin(raw, residency = "") {
  const endpoint = exactControlledAppwriteEndpoint(raw, residency);
  return endpoint ? new URL(endpoint).origin : null;
}
