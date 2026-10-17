import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { onCloneProgress, onRepoChanged } from "./events";
import type { CloneProgressPayload, Progress, RepoChangedPayload } from "./types";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

type Listener = (e: Event<CloneProgressPayload>) => void;

const progress: Progress = { phase: "receiving", percent: 42, message: "Receiving objects" };

let captured: Listener | undefined;
let unlisten: UnlistenFn;

function emit(payload: CloneProgressPayload): void {
  if (!captured) throw new Error("listen was never called");
  captured({ event: "clone-progress", id: 1, payload });
}

beforeEach(() => {
  captured = undefined;
  unlisten = vi.fn();
  vi.mocked(listen).mockReset();
  vi.mocked(listen).mockImplementation(async (_name, handler) => {
    captured = handler as unknown as Listener;
    return unlisten;
  });
});

// Contract: onCloneProgress wraps the clone-progress event and filters by cloneId.
describe("onCloneProgress", () => {
  it("subscribes to the clone-progress event", async () => {
    await onCloneProgress(7, vi.fn());
    expect(vi.mocked(listen).mock.calls[0]?.[0]).toBe("clone-progress");
  });

  it("invokes handler for matching cloneId", async () => {
    const handler = vi.fn();
    await onCloneProgress(7, handler);
    emit({ cloneId: 7, progress });
    expect(handler).toHaveBeenCalledExactlyOnceWith(progress);
  });

  it("onCloneProgress ignores other cloneIds", async () => {
    const handler = vi.fn();
    await onCloneProgress(7, handler);
    emit({ cloneId: 8, progress });
    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers only matching events when several clones report", async () => {
    const handler = vi.fn();
    await onCloneProgress(7, handler);
    const other: Progress = { phase: "counting", percent: null, message: "x" };
    emit({ cloneId: 8, progress: other });
    emit({ cloneId: 7, progress });
    expect(handler.mock.calls).toEqual([[progress]]);
  });

  it("delivers a matching progress whose percent is null unchanged", async () => {
    const handler = vi.fn();
    await onCloneProgress(7, handler);
    const indeterminate: Progress = { phase: "counting", percent: null, message: "Counting" };
    emit({ cloneId: 7, progress: indeterminate });
    expect(handler).toHaveBeenCalledExactlyOnceWith(indeterminate);
  });

  it("the returned unlisten function is the one the listener produced and can be called", async () => {
    const stop = await onCloneProgress(7, vi.fn());
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("returns the unlisten function", async () => {
    await expect(onCloneProgress(7, vi.fn())).resolves.toBe(unlisten);
  });

  it("rejects when listen rejects", async () => {
    const err = new Error("no bridge");
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockRejectedValue(err);
    await expect(onCloneProgress(7, vi.fn())).rejects.toBe(err);
  });
});

// Contract: onRepoChanged wraps the repo-changed event and filters by repoId.
describe("onRepoChanged", () => {
  function emitChanged(payload: RepoChangedPayload): void {
    if (!captured) throw new Error("listen was never called");
    (captured as unknown as (e: Event<RepoChangedPayload>) => void)({
      event: "repo-changed",
      id: 1,
      payload,
    });
  }

  it("subscribes to the repo-changed event", async () => {
    await onRepoChanged(1, vi.fn());
    expect(vi.mocked(listen).mock.calls[0]?.[0]).toBe("repo-changed");
  });

  it("invokes handler for a matching repoId", async () => {
    const handler = vi.fn();
    await onRepoChanged(1, handler);
    emitChanged({ repoId: 1 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("ignores events for other repoIds", async () => {
    const handler = vi.fn();
    await onRepoChanged(1, handler);
    emitChanged({ repoId: 2 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers only matching events when several repos change", async () => {
    const handler = vi.fn();
    await onRepoChanged(1, handler);
    emitChanged({ repoId: 2 });
    emitChanged({ repoId: 1 });
    emitChanged({ repoId: 3 });
    emitChanged({ repoId: 1 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("returns the unlisten function", async () => {
    await expect(onRepoChanged(1, vi.fn())).resolves.toBe(unlisten);
  });

  it("rejects when listen rejects", async () => {
    const err = new Error("no bridge");
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockRejectedValue(err);
    await expect(onRepoChanged(1, vi.fn())).rejects.toBe(err);
  });
});
