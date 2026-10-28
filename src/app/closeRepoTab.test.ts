import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeRepo } from "../lib/ipc";
import type { AppError, OpenedRepo } from "../lib/ipc";
import { useRepoTabs } from "../lib/store/repoTabs";
import { closeRepoTab } from "./closeRepoTab";

vi.mock(import("../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  closeRepo: vi.fn(),
}));

const repo = (id: number, path: string): OpenedRepo => ({
  id,
  summary: { path, name: path.split("/").at(-1) as string, headBranch: "main", isBare: false },
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tabIds = () => useRepoTabs.getState().tabs.map((t) => t.id);

beforeEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  useRepoTabs.setState({ tabs: [], activeId: null });
  useRepoTabs.getState().openTab(repo(1, "/repos/app"));
  useRepoTabs.getState().openTab(repo(2, "/repos/other"));
});

// Contract: the store clears at once; the returned promise settles after close_repo does.
describe("closeRepoTab", () => {
  it("should clear the tab first and resolve only after closeRepo settles", async () => {
    const gate = deferred();
    vi.mocked(closeRepo).mockReturnValue(gate.promise);
    let settled = false;
    const done = closeRepoTab(2).then(() => {
      settled = true;
    });
    expect(tabIds()).toEqual([1]);
    expect(closeRepo).toHaveBeenCalledExactlyOnceWith(2);
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await done;
    expect(settled).toBe(true);
  });

  it("should resolve without logging when closeRepo rejects with unknownRepo", async () => {
    const unknown: AppError = { kind: "unknownRepo", message: "unknown repo 2" };
    vi.mocked(closeRepo).mockRejectedValue(unknown);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(closeRepoTab(2)).resolves.toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });

  it("should log any other closeRepo failure and still resolve", async () => {
    const failed: AppError = { kind: "io", message: "boom" };
    vi.mocked(closeRepo).mockRejectedValue(failed);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(closeRepoTab(2)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledExactlyOnceWith("close_repo failed", failed);
  });
});
