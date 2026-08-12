export function resourceId(prefix: string) {
  const cleanPrefix = prefix.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  const random = crypto.randomUUID().replaceAll("-", "");
  return `${cleanPrefix}_${random.slice(0, 35 - cleanPrefix.length)}`;
}

export async function deterministicResourceId(prefix: string, value: string) {
  const cleanPrefix = prefix.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${cleanPrefix}_${hash.slice(0, 35 - cleanPrefix.length)}`;
}
