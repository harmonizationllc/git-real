import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCommitConfig } from "../../lib/ipc";
import type { AppError, CommitConfig } from "../../lib/ipc";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useCommitConfig } from "./useCommitConfig";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getCommitConfig: vi.fn(),
}));

const cfg: CommitConfig = { name: "A", email: "a@b.c", signing: "ssh" };

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useCommitConfig", () => {
  it("exposes the config from getCommitConfig", async () => {
    vi.mocked(getCommitConfig).mockResolvedValue(cfg);
    const { result } = renderHookWithProviders(() => useCommitConfig(1));
    expect(result.current.config).toBeUndefined();
    await waitFor(() => expect(result.current.config).toEqual(cfg));
    expect(getCommitConfig).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("exposes a rejected AppError and no config", async () => {
    const err: AppError = { kind: "git", message: "bad config" };
    vi.mocked(getCommitConfig).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useCommitConfig(1));
    await waitFor(() => expect(result.current.error).toEqual(err));
    expect(result.current.config).toBeUndefined();
  });

  it("wraps a non-AppError rejection as io", async () => {
    vi.mocked(getCommitConfig).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useCommitConfig(1));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });
});
