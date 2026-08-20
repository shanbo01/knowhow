import { DesktopAuthService } from "./desktop-auth-service";
import { ExtensionCaptureService } from "./extension-capture-service";
import type { PrivateObjectStore } from "./private-object-store";
import type { RecordStore } from "./record-store";

/**
 * Desktop capture intentionally reuses the browser ingest implementation.
 * The credential adapter and fixed source/kind keep tenant, source, and
 * privacy-review semantics server-derived rather than client-selectable.
 */
export class DesktopCaptureService extends ExtensionCaptureService {
  constructor(store: RecordStore, objects: PrivateObjectStore) {
    super(store, objects, {
      source: "desktop-capture",
      kind: "desktop",
      auth: new DesktopAuthService(store),
    });
  }
}
