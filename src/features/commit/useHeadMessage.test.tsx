import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHeadMessage } from "../../lib/ipc";
import type { AppError } from "../../lib/ipc";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useHeadMessage } from "./useHeadMessage";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getHeadMessage: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useHeadMessage", () => {
  it("is undefined while loading, then the message", async () => {
    vi.mocked(getHeadMessage).mockResolvedValue({ subject: "S", body: "B" });
    const { result } = renderHookWithProviders(() => useHeadMessage(1));
    expect(result.current.head).toBeUndefined();
    await waitFor(() => expect(result.current.head).toEqual({ subject: "S", body: "B" }));
  });

  it("distinguishes null (unborn HEAD) from undefined (loading)", async () => {
    vi.mocked(getHeadMessage).mockResolvedValue(null);
    const { result } = renderHookWithProviders(() => useHeadMessage(1));
    await waitFor(() => expect(result.current.head).toBeNull());
  });

  it("exposes a rejected AppError", async () => {
    const err: AppError = { kind: "unknownRepo", message: "gone" };
    vi.mocked(getHeadMessage).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useHeadMessage(1));
    await waitFor(() => expect(result.current.error).toEqual(err));
  });
});
