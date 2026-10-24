import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyText, openExternal } from "../../lib/ipc";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useLinkActions } from "./useLinkActions";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  openExternal: vi.fn(),
  copyText: vi.fn(),
}));

const URL = "https://github.com/gorlox/test-repo/issues/7";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(openExternal).mockResolvedValue(undefined);
  vi.mocked(copyText).mockResolvedValue(undefined);
});

// Contract: open and copy act on any provider URL; a failure lands in error until cleared.
describe("useLinkActions", () => {
  it("should start with no error", () => {
    const { result } = renderHookWithProviders(() => useLinkActions());
    expect(result.current.error).toBeNull();
  });

  it("should open the url in the browser", async () => {
    const { result } = renderHookWithProviders(() => useLinkActions());
    await act(async () => result.current.open(URL));
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(URL);
  });

  it("should not copy when opening", async () => {
    const { result } = renderHookWithProviders(() => useLinkActions());
    await act(async () => result.current.open(URL));
    expect(copyText).not.toHaveBeenCalled();
  });

  it("should copy the url to the clipboard", async () => {
    const { result } = renderHookWithProviders(() => useLinkActions());
    await act(async () => result.current.copyLink(URL));
    expect(copyText).toHaveBeenCalledExactlyOnceWith(URL);
  });

  it("should not open when copying", async () => {
    const { result } = renderHookWithProviders(() => useLinkActions());
    await act(async () => result.current.copyLink(URL));
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("should leave error null after a successful open and copy", async () => {
    const { result } = renderHookWithProviders(() => useLinkActions());
    await act(async () => {
      result.current.open(URL);
      result.current.copyLink(URL);
    });
    expect(result.current.error).toBeNull();
  });

  it("should set error when opening is rejected with an app error", async () => {
    vi.mocked(openExternal).mockRejectedValue({ kind: "io", message: "no browser" });
    const { result } = renderHookWithProviders(() => useLinkActions());
    await act(async () => result.current.open(URL));
    expect(result.current.error).toEqual({ kind: "io", message: "no browser" });
  });

  it("should set error when copying is rejected", async () => {
    vi.mocked(copyText).mockRejectedValue(new Error("clipboard denied"));
    const { result } = renderHookWithProviders(() => useLinkActions());
    await act(async () => result.current.copyLink(URL));
    expect(result.current.error).toEqual({ kind: "io", message: "clipboard denied" });
  });

  it("should clear the error with clearError", async () => {
    vi.mocked(copyText).mockRejectedValue(new Error("clipboard denied"));
    const { result } = renderHookWithProviders(() => useLinkActions());
    await act(async () => result.current.copyLink(URL));
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});

// Contract (fix wave 2, round 2): with an onError callback a failure goes to it and the hook's
// own error stays null; without one the error is set as before.
describe("useLinkActions onError", () => {
  it("should call onError once with the mapped error when opening is rejected", async () => {
    vi.mocked(openExternal).mockRejectedValue(new Error("no browser"));
    const onError = vi.fn();
    const { result } = renderHookWithProviders(() => useLinkActions(onError));
    await act(async () => result.current.open(URL));
    expect(onError).toHaveBeenCalledExactlyOnceWith({ kind: "io", message: "no browser" });
  });

  it("should leave error null when opening is rejected and onError is given", async () => {
    vi.mocked(openExternal).mockRejectedValue(new Error("no browser"));
    const { result } = renderHookWithProviders(() => useLinkActions(vi.fn()));
    await act(async () => result.current.open(URL));
    expect(result.current.error).toBeNull();
  });

  it("should call onError once with the mapped error when copying is rejected", async () => {
    vi.mocked(copyText).mockRejectedValue(new Error("clipboard denied"));
    const onError = vi.fn();
    const { result } = renderHookWithProviders(() => useLinkActions(onError));
    await act(async () => result.current.copyLink(URL));
    expect(onError).toHaveBeenCalledExactlyOnceWith({ kind: "io", message: "clipboard denied" });
  });

  it("should leave error null when copying is rejected and onError is given", async () => {
    vi.mocked(copyText).mockRejectedValue(new Error("clipboard denied"));
    const { result } = renderHookWithProviders(() => useLinkActions(vi.fn()));
    await act(async () => result.current.copyLink(URL));
    expect(result.current.error).toBeNull();
  });

  it("should not call onError after a successful open and copy", async () => {
    const onError = vi.fn();
    const { result } = renderHookWithProviders(() => useLinkActions(onError));
    await act(async () => {
      result.current.open(URL);
      result.current.copyLink(URL);
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("should set error without onError, as before", async () => {
    vi.mocked(openExternal).mockRejectedValue(new Error("no browser"));
    const { result } = renderHookWithProviders(() => useLinkActions());
    await act(async () => result.current.open(URL));
    expect(result.current.error).toEqual({ kind: "io", message: "no browser" });
  });
});
