import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFileContent } from "../../lib/ipc";
import type { AppError } from "../../lib/ipc";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useFileContent } from "./useFileContent";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getFileContent: vi.fn(),
}));

const buffer = new Uint8Array([1, 2, 3]).buffer;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getFileContent).mockResolvedValue(buffer);
});

// Contract: the query only runs when enabled.
describe("useFileContent enablement", () => {
  it("should not call getFileContent when disabled", () => {
    renderHookWithProviders(() => useFileContent(1, "a.png", "unstaged", "new", false));
    expect(getFileContent).not.toHaveBeenCalled();
  });
  it("should not report loading when disabled", () => {
    const { result } = renderHookWithProviders(() =>
      useFileContent(1, "a.png", "unstaged", "new", false),
    );
    expect(result.current.loading).toBe(false);
  });
});

// Contract: an enabled hook fetches one side's bytes.
describe("useFileContent success", () => {
  it("should call getFileContent once with the request", async () => {
    renderHookWithProviders(() => useFileContent(1, "a.png", "staged", "old", true));
    await waitFor(() => expect(getFileContent).toHaveBeenCalled());
    expect(getFileContent).toHaveBeenCalledExactlyOnceWith(1, "a.png", "staged", "old");
  });
  it("should expose the resolved bytes", async () => {
    const { result } = renderHookWithProviders(() =>
      useFileContent(1, "a.png", "unstaged", "new", true),
    );
    await waitFor(() => expect(result.current.bytes).toBe(buffer));
    expect(result.current.error).toBeNull();
  });
  it("should report loading until the bytes arrive", async () => {
    const { result } = renderHookWithProviders(() =>
      useFileContent(1, "a.png", "unstaged", "new", true),
    );
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});

// Contract: failures are mapped to AppError and never retried.
describe("useFileContent errors", () => {
  it("should expose a tooLarge error", async () => {
    const err: AppError = { kind: "tooLarge", message: "big" };
    vi.mocked(getFileContent).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() =>
      useFileContent(1, "a.png", "unstaged", "new", true),
    );
    await waitFor(() => expect(result.current.error?.kind).toBe("tooLarge"));
    expect(result.current.bytes).toBeUndefined();
  });
  it("should not retry a failing request", async () => {
    vi.mocked(getFileContent).mockRejectedValue({ kind: "tooLarge", message: "big" });
    const { result } = renderHookWithProviders(() =>
      useFileContent(1, "a.png", "unstaged", "new", true),
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(getFileContent).toHaveBeenCalledTimes(1);
  });
  it("should map a non-AppError rejection to an io error", async () => {
    vi.mocked(getFileContent).mockRejectedValue(new Error("x"));
    const { result } = renderHookWithProviders(() =>
      useFileContent(1, "a.png", "unstaged", "new", true),
    );
    await waitFor(() => expect(result.current.error?.kind).toBe("io"));
  });
});
