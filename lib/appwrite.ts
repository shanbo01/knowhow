import {
  Account,
  AppwriteException,
  Client,
  Databases,
  ID,
  Permission,
  Query,
  Realtime,
  Role,
  Teams,
} from "appwrite";

export const APPWRITE_ENDPOINT = "https://sgp.cloud.appwrite.io/v1";
export const APPWRITE_PROJECT_ID = "6a6a53ac002ca43c7ea4";
export const DATABASE_ID = "rivet";
export const RECORDS_COLLECTION_ID = "records";

const client = new Client()
  .setEndpoint(APPWRITE_ENDPOINT)
  .setProject(APPWRITE_PROJECT_ID);

const account = new Account(client);
const databases = new Databases(client);
const teams = new Teams(client);
const realtime = new Realtime(client);

export {
  account,
  AppwriteException,
  client,
  databases,
  ID,
  Permission,
  Query,
  realtime,
  Role,
  teams,
};
