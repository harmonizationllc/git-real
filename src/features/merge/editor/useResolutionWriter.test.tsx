import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeResolution } from "../../../lib/ipc";
import type { AppError } from "../../../lib/ipc";
import { queryKeys } from "../../../lib/query/keys";
import { renderHookWithProviders } from "../../../test/renderWithProviders";
import { SAVE_DELAY_MS, WRITTEN_MEMORY, useResolutionWriter } from "./useResolutionWriter";

vi.mock(import("../../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  writeResolution: vi.fn(),
}));

const REPO = 7;
const PATH = "src/a.txt";
const unresolved: AppError = { kind: "unresolvedConflicts", message: "still conflicted" };

function setup(crlf = false) {
  return renderHookWithProviders(() => useResolutionWriter(REPO, PATH, crlf));
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.mocked(writeResolution).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// Contract: scheduleSave debounces by SAVE_DELAY_MS and sends only the latest text, unstaged.
describe("useResolutionWriter scheduleSave", () => {
  it("scheduleSave writes once after the delay with the latest text", async () => {
    const { result } = setup();
    act(() => result.current.scheduleSave("first"));
    await advance(200);
    act(() => result.current.scheduleSave("second"));
    await advance(SAVE_DELAY_MS);
    expect(writeResolution).toHaveBeenCalledExactlyOnceWith(REPO, PATH, "second", false);
  });

  it("scheduleSave writes nothing before the delay has passed", async () => {
    const { result } = setup();
    act(() => result.current.scheduleSave("text"));
    await advance(SAVE_DELAY_MS - 1);
    expect(writeResolution).not.toHaveBeenCalled();
  });

  it("scheduleSave restores CRLF line endings when the file used them", async () => {
    const { result } = setup(true);
    act(() => result.current.scheduleSave("a\nb\n"));
    await advance(SAVE_DELAY_MS);
    expect(writeResolution).toHaveBeenCalledExactlyOnceWith(REPO, PATH, "a\r\nb\r\n", false);
  });

  it("scheduleSave leaves LF text alone when the file did not use CRLF", async () => {
    const { result } = setup(false);
    act(() => result.current.scheduleSave("a\nb\n"));
    await advance(SAVE_DELAY_MS);
    expect(writeResolution).toHaveBeenCalledExactlyOnceWith(REPO, PATH, "a\nb\n", false);
  });

  it("a plain save invalidates no query", async () => {
    const { result, queryClient } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    act(() => result.current.scheduleSave("text"));
    await advance(SAVE_DELAY_MS);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

// Contract: flush sends a queued save now and resolves once everything in flight is done.
describe("useResolutionWriter flush", () => {
  it("flush sends a pending save immediately and resolves after it", async () => {
    const write = deferred();
    vi.mocked(writeResolution).mockReturnValue(write.promise);
    const { result } = setup();
    act(() => result.current.scheduleSave("text"));
    let settled = false;
    let flushing!: Promise<void>;
    act(() => {
      flushing = result.current.flush().then(() => {
        settled = true;
      });
    });
    await advance(0);
    expect(writeResolution).toHaveBeenCalledExactlyOnceWith(REPO, PATH, "text", false);
    expect(settled).toBe(false);
    write.resolve();
    await act(() => flushing);
    expect(settled).toBe(true);
  });

  it("flush cancels the timer so the text is not written twice", async () => {
    const { result } = setup();
    act(() => result.current.scheduleSave("text"));
    await act(() => result.current.flush());
    await advance(SAVE_DELAY_MS * 2);
    expect(writeResolution).toHaveBeenCalledOnce();
  });

  it("flush resolves without writing when nothing is queued", async () => {
    const { result } = setup();
    await act(() => result.current.flush());
    expect(writeResolution).not.toHaveBeenCalled();
  });

  it("flush waits for a write that is already in flight", async () => {
    const write = deferred();
    vi.mocked(writeResolution).mockReturnValue(write.promise);
    const { result } = setup();
    act(() => result.current.scheduleSave("text"));
    await advance(SAVE_DELAY_MS);
    let settled = false;
    let flushing!: Promise<void>;
    act(() => {
      flushing = result.current.flush().then(() => {
        settled = true;
      });
    });
    await advance(0);
    expect(settled).toBe(false);
    write.resolve();
    await act(() => flushing);
    expect(settled).toBe(true);
  });
});

// Contract: discardPending drops a queued, unsent save.
describe("useResolutionWriter discardPending", () => {
  it("discardPending drops a queued save", async () => {
    const { result } = setup();
    act(() => result.current.scheduleSave("text"));
    act(() => result.current.discardPending());
    await advance(SAVE_DELAY_MS * 2);
    expect(writeResolution).not.toHaveBeenCalled();
  });

  it("discardPending leaves a later flush with nothing to send", async () => {
    const { result } = setup();
    act(() => result.current.scheduleSave("text"));
    act(() => result.current.discardPending());
    await act(() => result.current.flush());
    expect(writeResolution).not.toHaveBeenCalled();
  });
});

// Contract: saves never overlap; each waits for the one before it.
describe("useResolutionWriter ordering", () => {
  it("writes are serialised", async () => {
    const first = deferred();
    vi.mocked(writeResolution).mockReturnValueOnce(first.promise);
    const { result } = setup();
    act(() => result.current.scheduleSave("one"));
    await advance(SAVE_DELAY_MS);
    act(() => result.current.scheduleSave("two"));
    await advance(SAVE_DELAY_MS);
    expect(writeResolution).toHaveBeenCalledOnce();
    first.resolve();
    await advance(0);
    expect(writeResolution).toHaveBeenLastCalledWith(REPO, PATH, "two", false);
  });

  it("a failed write does not block the next one", async () => {
    vi.mocked(writeResolution).mockRejectedValueOnce(unresolved);
    const { result } = setup();
    act(() => result.current.scheduleSave("one"));
    await advance(SAVE_DELAY_MS);
    act(() => result.current.scheduleSave("two"));
    await advance(SAVE_DELAY_MS);
    expect(writeResolution).toHaveBeenLastCalledWith(REPO, PATH, "two", false);
  });
});

// Contract: markResolved flushes the autosave, writes with stage true and refreshes the repo.
describe("useResolutionWriter markResolved", () => {
  it("markResolved flushes, writes with stage true, invalidates the repo prefix and resolves null", async () => {
    const { result, queryClient } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    act(() => result.current.scheduleSave("draft"));
    let outcome: AppError | null | undefined;
    await act(async () => {
      outcome = await result.current.markResolved("final");
    });
    expect(vi.mocked(writeResolution).mock.calls).toEqual([
      [REPO, PATH, "draft", false],
      [REPO, PATH, "final", true],
    ]);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: queryKeys.repo(REPO) });
    expect(outcome).toBeNull();
  });

  it("markResolved restores CRLF line endings when the file used them", async () => {
    const { result } = setup(true);
    await act(() => result.current.markResolved("a\nb\n"));
    expect(writeResolution).toHaveBeenCalledExactlyOnceWith(REPO, PATH, "a\r\nb\r\n", true);
  });

  it("markResolved resolves the AppError and sets error without invalidating", async () => {
    vi.mocked(writeResolution).mockRejectedValue(unresolved);
    const { result, queryClient } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    let outcome: AppError | null | undefined;
    await act(async () => {
      outcome = await result.current.markResolved("final");
    });
    expect(outcome).toEqual(unresolved);
    expect(result.current.error).toEqual(unresolved);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("markResolved wraps a non-AppError rejection into an AppError", async () => {
    vi.mocked(writeResolution).mockRejectedValue(new Error("disk gone"));
    const { result } = setup();
    let outcome: AppError | null | undefined;
    await act(async () => {
      outcome = await result.current.markResolved("final");
    });
    expect(outcome).toEqual({ kind: "io", message: "disk gone" });
  });
});

// Contract (architect R1): changing the line-ending mode must not flush or lose a queued save.
describe("useResolutionWriter crlf change", () => {
  it("a crlf change does not flush a queued save", async () => {
    let crlf = false;
    const { result, rerender } = renderHookWithProviders(() =>
      useResolutionWriter(REPO, PATH, crlf),
    );
    act(() => result.current.scheduleSave("a\n"));
    crlf = true;
    rerender();
    await advance(0);
    expect(writeResolution).not.toHaveBeenCalled();
    await advance(SAVE_DELAY_MS);
    expect(writeResolution).toHaveBeenCalledExactlyOnceWith(REPO, PATH, "a\r\n", false);
  });
});

// Contract (architect R4): markResolved settles with the staging write; invalidation is fire and forget.
describe("useResolutionWriter markResolved invalidation", () => {
  it("markResolved does not wait for the invalidation", async () => {
    const { result, queryClient } = setup();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockReturnValue(new Promise(() => undefined));
    let outcome: AppError | null | undefined;
    await act(async () => {
      outcome = await result.current.markResolved("final");
    });
    expect(outcome).toBeNull();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: queryKeys.repo(REPO) });
  });
});

// Contract: a failed autosave is reported through error until dismissed.
describe("useResolutionWriter errors", () => {
  it("a failed autosave sets error; clearError clears it", async () => {
    vi.mocked(writeResolution).mockRejectedValue(unresolved);
    const { result } = setup();
    expect(result.current.error).toBeNull();
    act(() => result.current.scheduleSave("text"));
    await advance(SAVE_DELAY_MS);
    expect(result.current.error).toEqual(unresolved);
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it("a successful autosave leaves error null", async () => {
    const { result } = setup();
    act(() => result.current.scheduleSave("text"));
    await advance(SAVE_DELAY_MS);
    expect(result.current.error).toBeNull();
  });
});

// Contract: wasWritten remembers the last WRITTEN_MEMORY texts sent, so watcher echoes can be told apart.
describe("useResolutionWriter wasWritten", () => {
  it("wasWritten remembers the last 32 texts only", async () => {
    const { result } = setup();
    for (let i = 0; i <= WRITTEN_MEMORY; i++) {
      act(() => result.current.scheduleSave(`text ${i}`));
      await advance(SAVE_DELAY_MS);
    }
    expect(WRITTEN_MEMORY).toBe(32);
    expect(result.current.wasWritten("text 0")).toBe(false);
    expect(result.current.wasWritten("text 1")).toBe(true);
    expect(result.current.wasWritten(`text ${WRITTEN_MEMORY}`)).toBe(true);
  });

  it("wasWritten is false for a text that was never sent", () => {
    const { result } = setup();
    expect(result.current.wasWritten("never")).toBe(false);
  });

  it("wasWritten is true for a text sent by markResolved", async () => {
    const { result } = setup();
    await act(() => result.current.markResolved("final"));
    expect(result.current.wasWritten("final")).toBe(true);
  });

  it("wasWritten compares the LF text, not the CRLF bytes on disk", async () => {
    const { result } = setup(true);
    act(() => result.current.scheduleSave("a\nb\n"));
    await advance(SAVE_DELAY_MS);
    expect(result.current.wasWritten("a\nb\n")).toBe(true);
  });

  it("wasWritten is false for a text that was discarded before sending", async () => {
    const { result } = setup();
    act(() => result.current.scheduleSave("dropped"));
    act(() => result.current.discardPending());
    await advance(SAVE_DELAY_MS);
    expect(result.current.wasWritten("dropped")).toBe(false);
  });
});

// Contract: pending is true while any write is in flight.
describe("useResolutionWriter pending", () => {
  it("pending is true while a write is in flight", async () => {
    const write = deferred();
    vi.mocked(writeResolution).mockReturnValue(write.promise);
    const { result } = setup();
    expect(result.current.pending).toBe(false);
    act(() => result.current.scheduleSave("text"));
    await advance(SAVE_DELAY_MS);
    expect(result.current.pending).toBe(true);
    write.resolve();
    await advance(0);
    expect(result.current.pending).toBe(false);
  });

  it("pending is false after a write fails", async () => {
    vi.mocked(writeResolution).mockRejectedValue(unresolved);
    const { result } = setup();
    act(() => result.current.scheduleSave("text"));
    await advance(SAVE_DELAY_MS);
    expect(result.current.pending).toBe(false);
  });
});

// Contract: unmounting sends a queued save so no typing is lost.
describe("useResolutionWriter unmount", () => {
  it("unmount flushes a queued save", async () => {
    const { result, unmount } = setup();
    act(() => result.current.scheduleSave("typed last"));
    unmount();
    await advance(0);
    expect(writeResolution).toHaveBeenCalledExactlyOnceWith(REPO, PATH, "typed last", false);
  });

  it("unmount writes nothing when no save is queued", async () => {
    const { unmount } = setup();
    unmount();
    await advance(0);
    expect(writeResolution).not.toHaveBeenCalled();
  });

  it("unmount does not write a save that was discarded", async () => {
    const { result, unmount } = setup();
    act(() => result.current.scheduleSave("typed"));
    act(() => result.current.discardPending());
    unmount();
    await advance(0);
    expect(writeResolution).not.toHaveBeenCalled();
  });
});
