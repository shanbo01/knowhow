import assert from "node:assert/strict";
import test from "node:test";
import { flattenScreenshot, needsFlattening } from "./screenshot-flatten";
import type { EditorBlock } from "./knowhow-types";

function assertAlmostEqual(actual: number, expected: number, delta = 1e-5) {
  assert.ok(
    Math.abs(actual - expected) < delta,
    `Expected ${actual} to be close to ${expected} (delta: ${delta})`,
  );
}

test("needsFlattening correctly identifies when flattening is required", () => {
  const baseBlock: EditorBlock = {
    id: "b1",
    kind: "action",
    title: "Action Step",
    description: "Step description",
  };

  // 1. Default block without crop or redactions -> false
  assert.equal(needsFlattening(baseBlock), false);

  // 2. Full crop framing -> false
  assert.equal(
    needsFlattening({
      ...baseBlock,
      crop: { x: 0, y: 0, width: 1, height: 1 },
    }),
    false,
  );

  // 3. Trimmed crop framing -> true
  assert.equal(
    needsFlattening({
      ...baseBlock,
      crop: { x: 0, y: 0, width: 0.8, height: 1 },
    }),
    true,
  );

  // 4. Shifted crop framing -> true
  assert.equal(
    needsFlattening({
      ...baseBlock,
      crop: { x: 0.05, y: 0, width: 0.95, height: 1 },
    }),
    true,
  );

  // 5. Unapplied redaction present -> true
  assert.equal(
    needsFlattening({
      ...baseBlock,
      redactions: [
        { id: "r1", x: 0.1, y: 0.1, width: 0.2, height: 0.2, applied: false },
      ],
    }),
    true,
  );

  // 6. Only applied redaction present -> false
  assert.equal(
    needsFlattening({
      ...baseBlock,
      redactions: [
        { id: "r1", x: 0.1, y: 0.1, width: 0.2, height: 0.2, applied: true },
      ],
    }),
    false,
  );
});

// Helper to set up mock DOM / Canvas environment for flattenScreenshot tests
function setupMockEnvironment(options: {
  bitmapWidth?: number;
  bitmapHeight?: number;
  getContextReturnsNull?: boolean;
  toBlobFails?: boolean;
} = {}) {
  const bitmapWidth = options.bitmapWidth ?? 1000;
  const bitmapHeight = options.bitmapHeight ?? 800;
  let bitmapClosed = false;

  const mockDrawImageCalls: Array<unknown[]> = [];
  const mockContext = {
    drawImage: (...args: unknown[]) => {
      mockDrawImageCalls.push(args);
    },
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    rect: () => {},
    clip: () => {},
    clearRect: () => {},
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "high",
    filter: "none",
    globalAlpha: 1,
  };

  const originalFetch = globalThis.fetch;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;

  const mockBlob = new Blob(["test-image"], { type: "image/jpeg" });

  globalThis.fetch = (async () => {
    return {
      blob: async () => mockBlob,
    } as Response;
  }) as typeof fetch;

  globalThis.createImageBitmap = (async () => {
    return {
      width: bitmapWidth,
      height: bitmapHeight,
      close: () => {
        bitmapClosed = true;
      },
    } as unknown as ImageBitmap;
  }) as typeof createImageBitmap;

  const createdCanvases: Array<{
    width: number;
    height: number;
    getContext: (type: string) => unknown;
    toBlob: (cb: (blob: Blob | null) => void) => void;
  }> = [];

  globalThis.document = {
    createElement: (tag: string) => {
      if (tag === "canvas") {
        const canvasIndex = createdCanvases.length;
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => {
            if (options.getContextReturnsNull && canvasIndex === 0) {
              return null;
            }
            return mockContext;
          },
          toBlob: (cb: (blob: Blob | null) => void) => {
            if (options.toBlobFails) {
              cb(null);
            } else {
              cb(new Blob(["flattened"], { type: "image/jpeg" }));
            }
          },
        };
        createdCanvases.push(canvas);
        return canvas as unknown as HTMLCanvasElement;
      }
      throw new Error(`Unexpected tag in test: ${tag}`);
    },
  } as unknown as Document;

  return {
    cleanup: () => {
      globalThis.fetch = originalFetch;
      globalThis.createImageBitmap = originalCreateImageBitmap;
      globalThis.document = originalDocument;
    },
    isBitmapClosed: () => bitmapClosed,
    mockDrawImageCalls,
    createdCanvases,
  };
}

test("flattenScreenshot bakes full uncropped image correctly", async () => {
  const env = setupMockEnvironment({ bitmapWidth: 1000, bitmapHeight: 800 });
  try {
    const block: EditorBlock = {
      id: "b1",
      kind: "action",
      title: "Step 1",
      description: "Description",
    };

    const result = await flattenScreenshot("https://example.com/test.jpg", block);

    assert.equal(result.width, 1000);
    assert.equal(result.height, 800);
    assert.equal(result.patch.crop, undefined);
    assert.deepEqual(result.patch.annotations, []);
    assert.deepEqual(result.patch.redactions, []);
    assert.ok(result.blob instanceof Blob);
    assert.equal(env.isBitmapClosed(), true);
  } finally {
    env.cleanup();
  }
});

test("flattenScreenshot crops raster and remaps annotations correctly", async () => {
  const env = setupMockEnvironment({ bitmapWidth: 1000, bitmapHeight: 800 });
  try {
    const block: EditorBlock = {
      id: "b1",
      kind: "action",
      title: "Step 1",
      description: "Description",
      crop: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 }, // 500x400 cropped region at (200, 160)
      annotations: [
        {
          id: "a1",
          kind: "box",
          x: 0.3,
          y: 0.3,
          width: 0.1,
          height: 0.1,
        },
        {
          id: "a2",
          kind: "click",
          x: 0.45,
          y: 0.45,
        },
        {
          id: "a3",
          kind: "arrow",
          x: 0.3,
          y: 0.3,
          x2: 0.5,
          y2: 0.5,
          text: "Arrow text",
          color: "#ff0000",
        },
        {
          id: "a4_outside",
          kind: "box",
          x: 0.85, // Outside crop (remapped x = (0.85 - 0.2)/0.5 = 1.3 > 1.005)
          y: 0.3,
          width: 0.1,
          height: 0.1,
        },
        {
          id: "a5_boundary",
          kind: "box",
          x: 0.198, // Slightly left of crop -> remapped x = -0.004 -> clamped to 0
          y: 0.2,
          width: 0.1,
          height: 0.1,
        },
      ],
    };

    const result = await flattenScreenshot("https://example.com/test.jpg", block);

    assert.equal(result.width, 500);
    assert.equal(result.height, 400);

    // Initial canvas draw call should draw crop region from source bitmap
    assert.equal(env.mockDrawImageCalls[0][1], 200); // cropX
    assert.equal(env.mockDrawImageCalls[0][2], 160); // cropY
    assert.equal(env.mockDrawImageCalls[0][3], 500); // cropWidth
    assert.equal(env.mockDrawImageCalls[0][4], 400); // cropHeight

    // Annotations
    const annotations = result.patch.annotations!;
    assert.equal(annotations.length, 4); // a4_outside is filtered out

    const a1 = annotations.find((a) => a.id === "a1")!;
    assertAlmostEqual(a1.x, 0.2); // (0.3 - 0.2) / 0.5
    assertAlmostEqual(a1.y, 0.2); // (0.3 - 0.2) / 0.5
    assertAlmostEqual(a1.width!, 0.2); // 0.1 / 0.5
    assertAlmostEqual(a1.height!, 0.2); // 0.1 / 0.5

    const a2 = annotations.find((a) => a.id === "a2")!;
    assertAlmostEqual(a2.x, 0.5); // (0.45 - 0.2) / 0.5
    assertAlmostEqual(a2.y, 0.5);
    assert.equal(a2.width, undefined);
    assert.equal(a2.height, undefined);

    const a3 = annotations.find((a) => a.id === "a3")!;
    assertAlmostEqual(a3.x, 0.2);
    assertAlmostEqual(a3.y, 0.2);
    assert.equal(a3.x2, 0.5);
    assert.equal(a3.y2, 0.5);
    assert.equal(a3.text, "Arrow text");
    assert.equal(a3.color, "#ff0000");

    const a5 = annotations.find((a) => a.id === "a5_boundary")!;
    assert.equal(a5.x, 0); // Clamped from -0.004 to 0

    assert.equal(env.isBitmapClosed(), true);
  } finally {
    env.cleanup();
  }
});

test("flattenScreenshot bakes unapplied redactions and updates patch", async () => {
  const env = setupMockEnvironment({ bitmapWidth: 1000, bitmapHeight: 800 });
  try {
    const block: EditorBlock = {
      id: "b1",
      kind: "action",
      title: "Step 1",
      description: "Description",
      crop: { x: 0, y: 0, width: 1, height: 1 },
      redactions: [
        {
          id: "r1_unapplied",
          x: 0.1,
          y: 0.1,
          width: 0.2,
          height: 0.2,
          applied: false,
        },
        {
          id: "r2_already_applied",
          x: 0.5,
          y: 0.5,
          width: 0.1,
          height: 0.1,
          applied: true,
        },
        {
          id: "r4_tiny",
          x: 0.2,
          y: 0.2,
          width: 0.001, // <= 0.002, should be filtered out from patch
          height: 0.001,
          applied: false,
        },
      ],
    };

    const initialDrawCallsCount = env.mockDrawImageCalls.length;
    const result = await flattenScreenshot("https://example.com/test.jpg", block);

    // More draw calls were made because r1_unapplied painted raster redaction
    assert.ok(env.mockDrawImageCalls.length > initialDrawCallsCount + 1);

    // Redactions patch check
    const redactions = result.patch.redactions!;
    assert.equal(redactions.length, 2);

    const r1 = redactions.find((r) => r.id === "r1_unapplied")!;
    assert.equal(r1.applied, true);
    assertAlmostEqual(r1.x, 0.1);
    assertAlmostEqual(r1.y, 0.1);
    assertAlmostEqual(r1.width, 0.2);
    assertAlmostEqual(r1.height, 0.2);

    const r2 = redactions.find((r) => r.id === "r2_already_applied")!;
    assert.equal(r2.applied, true);

    // r4_tiny is filtered out because width <= 0.002
    assert.equal(
      redactions.some((r) => r.id === "r4_tiny"),
      false,
    );

    assert.equal(env.isBitmapClosed(), true);
  } finally {
    env.cleanup();
  }
});

test("flattenScreenshot throws error when canvas context is unavailable and closes bitmap", async () => {
  const env = setupMockEnvironment({ getContextReturnsNull: true });
  try {
    const block: EditorBlock = {
      id: "b1",
      kind: "action",
      title: "Step 1",
      description: "Description",
    };

    await assert.rejects(
      async () => {
        await flattenScreenshot("https://example.com/test.jpg", block);
      },
      {
        name: "Error",
        message: "This browser could not prepare the screenshot.",
      },
    );

    assert.equal(env.isBitmapClosed(), true);
  } finally {
    env.cleanup();
  }
});

test("flattenScreenshot throws error when canvas encoding fails and closes bitmap", async () => {
  const env = setupMockEnvironment({ toBlobFails: true });
  try {
    const block: EditorBlock = {
      id: "b1",
      kind: "action",
      title: "Step 1",
      description: "Description",
    };

    await assert.rejects(
      async () => {
        await flattenScreenshot("https://example.com/test.jpg", block);
      },
      {
        name: "Error",
        message: "The screenshot could not be encoded.",
      },
    );

    assert.equal(env.isBitmapClosed(), true);
  } finally {
    env.cleanup();
  }
});
