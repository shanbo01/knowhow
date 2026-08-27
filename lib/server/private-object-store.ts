export type PrivateObject = {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
};

export type PutPrivateObject = PrivateObject & {
  id: string;
};

export interface PrivateObjectStore {
  put(input: PutPrivateObject): Promise<void>;
  get(id: string): Promise<PrivateObject | null>;
  delete(id: string): Promise<void>;
  clone(sourceId: string, targetId: string, filename?: string): Promise<PrivateObject>;
}
