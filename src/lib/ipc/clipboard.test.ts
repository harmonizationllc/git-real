import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";
import * as ipc from "./index";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

beforeEach(() => {
  vi.mocked(writeText).mockReset();
});

// Contract: copyText is the seam over the clipboard plugin's writeText.
describe("copyText", () => {
  it("should write the text to the clipboard plugin", async () => {
    vi.mocked(writeText).mockResolvedValue(undefined);
    await copyText("abc");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("abc");
  });

  it("should resolve to undefined when the plugin succeeds", async () => {
    vi.mocked(writeText).mockResolvedValue(undefined);
    await expect(copyText("abc")).resolves.toBeUndefined();
  });

  it("should pass an empty string through unchanged", async () => {
    vi.mocked(writeText).mockResolvedValue(undefined);
    await copyText("");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("");
  });

  it("should reject with the plugin's error when the write fails", async () => {
    const err = new Error("clipboard unavailable");
    vi.mocked(writeText).mockRejectedValue(err);
    await expect(copyText("abc")).rejects.toBe(err);
  });
});

// Contract: the seam index re-exports copyText so features never import the plugin.
describe("ipc index", () => {
  it("should re-export copyText", () => {
    expect(ipc.copyText).toBe(copyText);
  });
});
