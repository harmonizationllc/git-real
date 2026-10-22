import { openUrl } from "@tauri-apps/plugin-opener";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openExternal } from "./opener";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

beforeEach(() => {
  vi.mocked(openUrl).mockReset();
  vi.mocked(openUrl).mockResolvedValue(undefined);
});

// Contract: openExternal opens https links in the system browser and nothing else.
describe("openExternal", () => {
  it("openExternal opens an https url through the opener plugin", async () => {
    await openExternal("https://github.com/o/r/pull/1");
    expect(openUrl).toHaveBeenCalledWith("https://github.com/o/r/pull/1");
  });

  it("openExternal resolves after the plugin opens the url", async () => {
    await expect(openExternal("https://github.com/o/r/pull/1")).resolves.toBeUndefined();
  });

  it("openExternal accepts an uppercase https scheme", async () => {
    await openExternal("HTTPS://github.com/x");
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it.each(["http://x", "javascript:alert(1)", "file:///etc/passwd", "ftp://x/y", "mailto:a@b.c"])(
    "openExternal rejects %s with the https-only message",
    async (url) => {
      await expect(openExternal(url)).rejects.toThrow("Only https links can be opened");
    },
  );

  it.each(["http://x", "javascript:alert(1)", "file:///etc/passwd", "not a url", ""])(
    "openExternal never calls the plugin for %j",
    async (url) => {
      await openExternal(url).catch(() => undefined);
      expect(openUrl).not.toHaveBeenCalled();
    },
  );

  it("openExternal rejects a string that is not a url with the https-only message", async () => {
    await expect(openExternal("not a url")).rejects.toThrow("Only https links can be opened");
  });

  it("openExternal rejects with an Error instance", async () => {
    await expect(openExternal("http://x")).rejects.toBeInstanceOf(Error);
  });

  it("openExternal propagates a failure of the plugin", async () => {
    vi.mocked(openUrl).mockRejectedValue(new Error("no handler"));
    await expect(openExternal("https://github.com/x")).rejects.toThrow("no handler");
  });
});
