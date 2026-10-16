import { open } from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickFolder } from "./dialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

beforeEach(() => {
  vi.mocked(open).mockReset();
});

// Contract: pickFolder opens a single-directory picker and yields a path or null.
describe("pickFolder", () => {
  it("pickFolder opens a single-directory picker with the title", async () => {
    vi.mocked(open).mockResolvedValue("/p");
    const result = await pickFolder("Pick");
    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false, title: "Pick" });
    expect(result).toBe("/p");
  });

  it("pickFolder without title", async () => {
    vi.mocked(open).mockResolvedValue("/p");
    await pickFolder();
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, multiple: false }),
    );
  });

  it("pickFolder returns null on cancel", async () => {
    vi.mocked(open).mockResolvedValue(null);
    await expect(pickFolder()).resolves.toBeNull();
  });

  it("pickFolder rejects when the dialog plugin rejects", async () => {
    const err = new Error("dialog failed");
    vi.mocked(open).mockRejectedValue(err);
    await expect(pickFolder()).rejects.toBe(err);
  });
});
