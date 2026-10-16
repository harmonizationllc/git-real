import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initRepo, openRepo } from "../../lib/ipc";
import type { AppError, OpenedRepo } from "../../lib/ipc";
import { useRepoTabs } from "../../lib/store/repoTabs";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useOpenRepo } from "./useOpenRepo";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  openRepo: vi.fn(),
  initRepo: vi.fn(),
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
