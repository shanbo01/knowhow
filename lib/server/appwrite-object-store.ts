import "server-only";

import { AppwriteException, type Storage } from "node-appwrite";
import { InputFile } from "node-appwrite/file";
import { APPWRITE_RESOURCES } from "./appwrite-resources";
import type {
  PrivateObject,
  PrivateObjectStore,
  PutPrivateObject,
} from "./private-object-store";

function isNotFound(error: unknown) {
  return error instanceof AppwriteException && error.code === 404;
}

export class AppwritePrivateObjectStore implements PrivateObjectStore {
  constructor(
    private readonly storage: Storage,
    private readonly bucketId: string = APPWRITE_RESOURCES.privateMediaBucket,
  ) {}

  async put(input: PutPrivateObject) {
    await this.storage.createFile({
      bucketId: this.bucketId,
      fileId: input.id,
      file: InputFile.fromBuffer(input.bytes, input.filename),
      permissions: [],
    });
  }

  async get(id: string): Promise<PrivateObject | null> {
    try {
      const [metadata, download] = await Promise.all([
        this.storage.getFile({ bucketId: this.bucketId, fileId: id }),
        this.storage.getFileDownload({ bucketId: this.bucketId, fileId: id }),
      ]);
      return {
        bytes: new Uint8Array(download),
        filename: metadata.name,
        contentType: metadata.mimeType,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(id: string) {
    try {
      await this.storage.deleteFile({ bucketId: this.bucketId, fileId: id });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async clone(sourceId: string, targetId: string, filename?: string) {
    const source = await this.get(sourceId);
    if (!source) throw new Error(`Private object ${sourceId} does not exist.`);
    const result = { ...source, filename: filename ?? source.filename };
    await this.put({ id: targetId, ...result });
    return result;
  }
}
