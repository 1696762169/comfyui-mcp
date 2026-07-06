import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Mock config so the CivitAI toggle is controllable per test.
vi.mock("../../config.js", () => {
  const config = { civitaiApiToken: undefined as string | undefined, civitaiEnabled: true as boolean };
  return {
    config,
    isCivitaiEnabled: () => config.civitaiEnabled,
  };
});

import { config } from "../../config.js";
import { lookupByHash, batchLookup } from "../../services/civitai-lookup.js";
import type { FileHasher } from "../../services/file-hasher.js";

const fetchMock = vi.fn();

function makeHasher(): FileHasher {
  return {
    updateCivitaiInfo: vi.fn(),
    getCached: vi.fn(() => null),
    needsCivitaiCheck: vi.fn(() => true),
  } as unknown as FileHasher;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  config.civitaiApiToken = undefined;
  config.civitaiEnabled = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lookupByHash", () => {
  it("returns null without fetching when CivitAI is disabled", async () => {
    config.civitaiEnabled = false;
    const hasher = makeHasher();

    const result = await lookupByHash(hasher, "model.safetensors", "ABC123");

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns CivitAI metadata when enabled and found", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 12345,
        modelId: 67890,
        name: "v1.0",
        model: { name: "Cool Model", type: "Checkpoint" },
      }),
    });
    const hasher = makeHasher();

    const result = await lookupByHash(hasher, "model.safetensors", "ABC123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      id: 12345,
      modelId: 67890,
      name: "v1.0",
      model: { name: "Cool Model", type: "Checkpoint" },
    });
  });
});

describe("batchLookup", () => {
  it("returns all-null results without fetching when CivitAI is disabled", async () => {
    config.civitaiEnabled = false;
    const hasher = makeHasher();
    const files = [
      { filename: "a.safetensors", autov2: "A" },
      { filename: "b.safetensors", autov2: "B" },
    ];

    const results = await batchLookup(hasher, files);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(results.get("a.safetensors")).toBeNull();
    expect(results.get("b.safetensors")).toBeNull();
  });
});
