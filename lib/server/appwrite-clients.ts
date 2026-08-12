import "server-only";

import {
  Account,
  Client,
  Functions,
  Messaging,
  Storage,
  TablesDB,
  Users,
} from "node-appwrite";
import { getAppwriteServerConfig } from "./appwrite-config";

function baseClient() {
  const config = getAppwriteServerConfig();
  return new Client().setEndpoint(config.endpoint).setProject(config.projectId);
}

export function createAdminAppwrite() {
  const config = getAppwriteServerConfig();
  const client = baseClient().setKey(config.apiKey);
  return {
    config,
    client,
    account: new Account(client),
    users: new Users(client),
    tables: new TablesDB(client),
    storage: new Storage(client),
    messaging: new Messaging(client),
    functions: new Functions(client),
  };
}

export function createSessionAppwrite(sessionSecret: string) {
  if (!sessionSecret) throw new Error("An Appwrite session secret is required.");
  const config = getAppwriteServerConfig();
  const client = baseClient().setSession(sessionSecret);
  return {
    config,
    client,
    account: new Account(client),
  };
}

