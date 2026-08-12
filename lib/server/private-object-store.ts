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

function copy(value: PrivateObject): PrivateObject {
  return {
    bytes: new Uint8Array(value.bytes),
    filename: value.filename,
    contentType: value.contentType,
  };
}

export class InMemoryPrivateObjectStore implements PrivateObjectStore {
  private readonly objects = new Map<string, PrivateObject>();

  async put(input: PutPrivateObject) {
    if (this.objects.has(input.id)) throw new Error(`Private object ${input.id} already exists.`);
    this.objects.set(input.id, copy(input));
  }

  async get(id: string) {
    const value = this.objects.get(id);
    return value ? copy(value) : null;
  }

  async delete(id: string) {
    this.objects.delete(id);
  }

  async clone(sourceId: string, targetId: string, filename?: string) {
    const source = this.objects.get(sourceId);
    if (!source) throw new Error(`Private object ${sourceId} does not exist.`);
    const result = copy({ ...source, filename: filename ?? source.filename });
    await this.put({ id: targetId, ...result });
    return result;
  }
}
