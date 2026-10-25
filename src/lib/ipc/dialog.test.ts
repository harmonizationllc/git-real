import { open } from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickFile, pickFolder } from "./dialog";

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

// GR-14 additions: pickFolder defaultPath and pickFile.
describe("pickFolder with defaultPath (GR-14)", () => {
  it("pickFolder passes defaultPath when given", async () => {
    vi.mocked(open).mockResolvedValue("/chosen");
    await pickFolder("Choose dir", "/default/path");
    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Choose dir",
      defaultPath: "/default/path",
    });
  });

  it("pickFolder omits defaultPath when not given", async () => {
    vi.mocked(open).mockResolvedValue("/p");
    await pickFolder("No default");
    expect(open).toHaveBeenCalledWith(
      expect.not.objectContaining({ defaultPath: expect.anything() }),
    );
  });
});

describe("pickFile (GR-14)", () => {
  it("pickFile opens a single-file picker with the title", async () => {
    vi.mocked(open).mockResolvedValue("/usr/bin/git");
    const result = await pickFile("Choose Git executable");
    expect(open).toHaveBeenCalledWith({
      directory: false,
      multiple: false,
      title: "Choose Git executable",
    });
    expect(result).toBe("/usr/bin/git");
  });

  it("pickFile returns null on cancel", async () => {
    vi.mocked(open).mockResolvedValue(null);
    await expect(pickFile()).resolves.toBeNull();
  });

  it("pickFile rejects when the dialog plugin rejects", async () => {
    const err = new Error("dialog failed");
    vi.mocked(open).mockRejectedValue(err);
    await expect(pickFile()).rejects.toBe(err);
  });
});
