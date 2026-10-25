import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloneRepo, initRepo, openRepo } from "../../lib/ipc";
import type { AppError, OpenedRepo } from "../../lib/ipc";
import { useRepoTabs } from "../../lib/store/repoTabs";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useOpenRepo } from "./useOpenRepo";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  openRepo: vi.fn(),
  initRepo: vi.fn(),
  cloneRepo: vi.fn(),
  listRecent: vi.fn(),
  removeRecent: vi.fn(),
  pickFolder: vi.fn(),
}));

const opened = (path: string, id = 1): OpenedRepo => ({
  id,
  summary: { path, name: path.split("/").pop()!, headBranch: "main", isBare: false },
});
const notARepo: AppError = { kind: "notARepository", message: "m" };

beforeEach(() => {
  vi.resetAllMocks();
  useRepoTabs.setState(useRepoTabs.getInitialState(), true);
});

// Contract: open/init call the seam, open a tab on success, and surface failures as state.
describe("useOpenRepo open success", () => {
  it("should open a tab and leave error null when open succeeds", async () => {
    vi.mocked(openRepo).mockResolvedValue(opened("/r"));
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.open("/r"));
    expect(useRepoTabs.getState().tabs).toEqual([{ id: 1, summary: opened("/r").summary }]);
    expect(result.current.error).toBeNull();
  });

  it("should call openRepo with exactly the path when open succeeds", async () => {
    vi.mocked(openRepo).mockResolvedValue(opened("/r"));
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.open("/r"));
    expect(openRepo).toHaveBeenCalledExactlyOnceWith("/r");
  });

  it("should invalidate the recent query when open succeeds", async () => {
    vi.mocked(openRepo).mockResolvedValue(opened("/r"));
    const { result, queryClient } = renderHookWithProviders(() => useOpenRepo());
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.open("/r"));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["recent"] });
  });
});

describe("useOpenRepo open failure", () => {
  it("should set error and errorPath when open rejects with an AppError", async () => {
    vi.mocked(openRepo).mockRejectedValue(notARepo);
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.open("/r"));
    expect(result.current.error).toEqual(notARepo);
    expect(result.current.errorPath).toBe("/r");
  });

  it("should not open a tab when open rejects", async () => {
    vi.mocked(openRepo).mockRejectedValue(notARepo);
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.open("/r"));
    expect(useRepoTabs.getState().tabs).toEqual([]);
  });

  it("should resolve to undefined when open rejects", async () => {
    vi.mocked(openRepo).mockRejectedValue(notARepo);
    const { result } = renderHookWithProviders(() => useOpenRepo());
    let outcome: Promise<void> | undefined;
    await act(async () => {
      outcome = result.current.open("/r");
      await outcome;
    });
    await expect(outcome).resolves.toBeUndefined();
  });

  it("should map a plain Error rejection to an io error with its message", async () => {
    vi.mocked(openRepo).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.open("/r"));
    expect(result.current.error).toEqual({ kind: "io", message: "boom" });
  });

  it("should map a non-Error rejection to an io error with its string form", async () => {
    vi.mocked(openRepo).mockRejectedValue("x");
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.open("/r"));
    expect(result.current.error).toEqual({ kind: "io", message: "x" });
  });
});

describe("useOpenRepo init", () => {
  it("should open a tab via initRepo when init succeeds", async () => {
    vi.mocked(initRepo).mockResolvedValue(opened("/r"));
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.init("/r"));
    expect(initRepo).toHaveBeenCalledExactlyOnceWith("/r");
    expect(useRepoTabs.getState().tabs).toHaveLength(1);
  });

  it("should not call openRepo when init is used", async () => {
    vi.mocked(initRepo).mockResolvedValue(opened("/r"));
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.init("/r"));
    expect(openRepo).not.toHaveBeenCalled();
  });

  it("should set error and errorPath when init rejects", async () => {
    const err: AppError = { kind: "io", message: "denied" };
    vi.mocked(initRepo).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.init("/r"));
    expect(result.current.error).toEqual(err);
    expect(result.current.errorPath).toBe("/r");
  });
});

describe("useOpenRepo error lifecycle", () => {
  it("should clear error and errorPath when the next call succeeds", async () => {
    vi.mocked(openRepo).mockRejectedValue(notARepo);
    vi.mocked(initRepo).mockResolvedValue(opened("/r"));
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.open("/r"));
    await act(() => result.current.init("/r"));
    expect(result.current.error).toBeNull();
    expect(result.current.errorPath).toBeNull();
  });

  it("should reset error and errorPath when clearError is called", async () => {
    vi.mocked(openRepo).mockRejectedValue(notARepo);
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.open("/r"));
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
    expect(result.current.errorPath).toBeNull();
  });

  it("should start with error and errorPath null when nothing has been called", () => {
    const { result } = renderHookWithProviders(() => useOpenRepo());
    expect(result.current.error).toBeNull();
    expect(result.current.errorPath).toBeNull();
  });
});

describe("useOpenRepo sequences", () => {
  it("should open two tabs when open is called twice with different paths", async () => {
    vi.mocked(openRepo)
      .mockResolvedValueOnce(opened("/a", 1))
      .mockResolvedValueOnce(opened("/b", 2));
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.open("/a"));
    await act(() => result.current.open("/b"));
    expect(useRepoTabs.getState().tabs.map((t) => t.summary.path)).toEqual(["/a", "/b"]);
    expect(result.current.error).toBeNull();
  });

  it("should offer the failed path as errorPath so init can be retried on it", async () => {
    vi.mocked(openRepo).mockRejectedValue(notARepo);
    vi.mocked(initRepo).mockResolvedValue(opened("/r"));
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.open("/r"));
    const failedPath = result.current.errorPath!;
    await act(() => result.current.init(failedPath));
    expect(initRepo).toHaveBeenCalledExactlyOnceWith("/r");
    expect(result.current.error).toBeNull();
    expect(useRepoTabs.getState().tabs).toHaveLength(1);
  });

  it("should replace the previous error with the new one when a second open fails", async () => {
    vi.mocked(openRepo)
      .mockRejectedValueOnce({ kind: "pathNotFound", message: "first" })
      .mockRejectedValueOnce({ kind: "io", message: "second" });
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.open("/a"));
    await act(() => result.current.open("/b"));
    expect(result.current.error).toEqual({ kind: "io", message: "second" });
    expect(result.current.errorPath).toBe("/b");
  });

  it("should map a non-Error rejection from init to an io error and not open a tab", async () => {
    vi.mocked(initRepo).mockRejectedValue("boom");
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.init("/r"));
    expect(result.current.error).toEqual({ kind: "io", message: "boom" });
    expect(result.current.errorPath).toBe("/r");
    expect(useRepoTabs.getState().tabs).toHaveLength(0);
  });

  it("should invalidate the recent query when init succeeds", async () => {
    vi.mocked(initRepo).mockResolvedValue(opened("/r"));
    const { result, queryClient } = renderHookWithProviders(() => useOpenRepo());
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.init("/r"));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["recent"] });
  });

  it("should not invalidate the recent query when open fails", async () => {
    vi.mocked(openRepo).mockRejectedValue(notARepo);
    const { result, queryClient } = renderHookWithProviders(() => useOpenRepo());
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.open("/r"));
    expect(spy).not.toHaveBeenCalled();
  });
});

// Contract: only the latest call may set or clear error state; a stale earlier rejection is ignored.
describe("useOpenRepo overlapping calls", () => {
  it("should not show a stale error from a slower earlier open once a later call has succeeded", async () => {
    let rejectFirst!: (e: unknown) => void;
    vi.mocked(openRepo)
      .mockReturnValueOnce(new Promise((_, rej) => (rejectFirst = rej)))
      .mockResolvedValueOnce(opened("/b", 2));
    const { result } = renderHookWithProviders(() => useOpenRepo());
    let first!: Promise<void>;
    act(() => {
      first = result.current.open("/a");
    });
    await act(() => result.current.open("/b"));
    await act(async () => {
      rejectFirst(notARepo);
      await first;
    });
    expect(useRepoTabs.getState().tabs.map((t) => t.summary.path)).toEqual(["/b"]);
    expect(result.current.error).toBeNull();
  });
});

// Contract: clone shares the open/init pipeline but resolves a boolean and has no retryable path.
describe("useOpenRepo clone", () => {
  it("should open a tab and resolve true when clone succeeds", async () => {
    vi.mocked(cloneRepo).mockResolvedValue(opened("/d"));
    const { result } = renderHookWithProviders(() => useOpenRepo());
    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.clone("u", "/d", 5);
    });
    expect(outcome).toBe(true);
    expect(useRepoTabs.getState().tabs).toHaveLength(1);
  });

  it("should call cloneRepo with exactly url, dest and cloneId when clone succeeds", async () => {
    vi.mocked(cloneRepo).mockResolvedValue(opened("/d"));
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.clone("u", "/d", 5));
    expect(cloneRepo).toHaveBeenCalledExactlyOnceWith("u", "/d", 5);
  });

  it("should invalidate the recent query when clone succeeds", async () => {
    vi.mocked(cloneRepo).mockResolvedValue(opened("/d"));
    const { result, queryClient } = renderHookWithProviders(() => useOpenRepo());
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.clone("u", "/d", 5));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["recent"] });
  });

  it("should resolve false and set the error when clone rejects with an AppError", async () => {
    const err: AppError = { kind: "cloneFailed", message: "nope" };
    vi.mocked(cloneRepo).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useOpenRepo());
    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.clone("u", "/d", 5);
    });
    expect(outcome).toBe(false);
    expect(result.current.error).toEqual(err);
  });

  it("should leave errorPath null and open no tab when clone fails", async () => {
    vi.mocked(cloneRepo).mockRejectedValue({ kind: "cloneFailed", message: "nope" });
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.clone("u", "/d", 5));
    expect(result.current.errorPath).toBeNull();
    expect(useRepoTabs.getState().tabs).toEqual([]);
  });

  it("should map a non-AppError clone rejection to an io error", async () => {
    vi.mocked(cloneRepo).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(() => result.current.clone("u", "/d", 5));
    expect(result.current.error).toEqual({ kind: "io", message: "boom" });
  });

  it("should not invalidate the recent query when clone fails", async () => {
    vi.mocked(cloneRepo).mockRejectedValue({ kind: "cloneFailed", message: "nope" });
    const { result, queryClient } = renderHookWithProviders(() => useOpenRepo());
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.clone("u", "/d", 5));
    expect(spy).not.toHaveBeenCalled();
  });
});

// Contract: a stale clone failure neither sets the error nor changes its own boolean outcome.
describe("useOpenRepo clone overlapping calls", () => {
  it("should resolve false without setting the error when an older clone fails after a newer open succeeded", async () => {
    let rejectClone!: (e: unknown) => void;
    vi.mocked(cloneRepo).mockReturnValueOnce(new Promise((_, rej) => (rejectClone = rej)));
    vi.mocked(openRepo).mockResolvedValueOnce(opened("/b", 2));
    const { result } = renderHookWithProviders(() => useOpenRepo());
    let first!: Promise<boolean>;
    act(() => {
      first = result.current.clone("u", "/d", 5);
    });
    await act(() => result.current.open("/b"));
    let outcome: boolean | undefined;
    await act(async () => {
      rejectClone({ kind: "cloneFailed", message: "late" });
      outcome = await first;
    });
    expect(outcome).toBe(false);
    expect(result.current.error).toBeNull();
    expect(useRepoTabs.getState().tabs.map((t) => t.summary.path)).toEqual(["/b"]);
  });
});

// Contract (GR-14): open and init resolve boolean; clone toasts Cloned <name>.
import { useToasts } from "../../lib/store/toasts";

describe("useOpenRepo boolean results (GR-14)", () => {
  beforeEach(() => {
    useToasts.setState({ toasts: [] });
  });

  it("open resolves true on success", async () => {
    vi.mocked(openRepo).mockResolvedValue(opened("/r"));
    const { result } = renderHookWithProviders(() => useOpenRepo());
    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.open("/r");
    });
    expect(outcome).toBe(true);
  });

  it("open resolves false on failure", async () => {
    vi.mocked(openRepo).mockRejectedValue(notARepo);
    const { result } = renderHookWithProviders(() => useOpenRepo());
    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.open("/r");
    });
    expect(outcome).toBe(false);
  });

  it("init resolves false on failure", async () => {
    vi.mocked(initRepo).mockRejectedValue(notARepo);
    const { result } = renderHookWithProviders(() => useOpenRepo());
    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.init("/r");
    });
    expect(outcome).toBe(false);
  });

  it("toasts Cloned <name> on clone success and not on open", async () => {
    const repo = opened("/home/u/my-repo");
    vi.mocked(cloneRepo).mockResolvedValue(repo);
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(async () => {
      await result.current.clone("u", "/home/u/my-repo", 5);
    });
    const texts = useToasts.getState().toasts.map((t) => t.text);
    expect(texts).toContain("Cloned my-repo");
  });

  it("does not toast on plain open success", async () => {
    vi.mocked(openRepo).mockResolvedValue(opened("/r"));
    const { result } = renderHookWithProviders(() => useOpenRepo());
    await act(async () => {
      await result.current.open("/r");
    });
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
