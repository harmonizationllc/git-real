import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyText, hostingCheckoutPullRequest, openExternal } from "../../lib/ipc";
import { pullRequest } from "../../test/hostingFixtures";
import { authError, networkError } from "../../test/remoteFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { usePrActions } from "./usePrActions";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingCheckoutPullRequest: vi.fn(),
  openExternal: vi.fn(),
  copyText: vi.fn(),
}));

const pr7 = () => pullRequest(7);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hostingCheckoutPullRequest).mockResolvedValue({
    kind: "checkedOut",
    branch: "feature-7",
  });
  vi.mocked(openExternal).mockResolvedValue(undefined);
  vi.mocked(copyText).mockResolvedValue(undefined);
});

// Contract: checkout runs through the network gate and reports the branch it landed on.
describe("usePrActions checkout", () => {
  it("should start idle with nothing to show", () => {
    const { result } = renderHookWithProviders(() => usePrActions(1));
    expect([
      result.current.status,
      result.current.error,
      result.current.resetRequest,
      result.current.pending,
      result.current.prompt,
    ]).toEqual([null, null, null, false, null]);
  });

  it("should call hostingCheckoutPullRequest without reset or credentials", async () => {
    const { result } = renderHookWithProviders(() => usePrActions(1));
    await act(() => result.current.checkout(pr7()));
    expect(hostingCheckoutPullRequest).toHaveBeenCalledExactlyOnceWith(1, 7, false, null);
  });

  it("should set the status from the outcome's branch", async () => {
    const { result } = renderHookWithProviders(() => usePrActions(1));
    await act(() => result.current.checkout(pr7()));
    expect(result.current.status).toBe("Checked out feature-7.");
  });

  it("should report pr/7 for a fork pull request, not its source branch", async () => {
    vi.mocked(hostingCheckoutPullRequest).mockResolvedValue({ kind: "checkedOut", branch: "pr/7" });
    const { result } = renderHookWithProviders(() => usePrActions(1));
    await act(() => result.current.checkout(pullRequest(7, { fromFork: true, sourceBranch: "x" })));
    expect(result.current.status).toBe("Checked out pr/7.");
  });

  it("should invalidate the pull request list through the network gate", async () => {
    const { result, queryClient } = renderHookWithProviders(() => usePrActions(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.checkout(pr7()));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["hosting", "pullRequests", 1] });
  });

  it("should clear the previous status when the next checkout starts", async () => {
    const { result } = renderHookWithProviders(() => usePrActions(1));
    await act(() => result.current.checkout(pr7()));
    vi.mocked(hostingCheckoutPullRequest).mockReturnValue(new Promise(() => undefined));
    act(() => {
      void result.current.checkout(pr7());
    });
    await waitFor(() => expect(result.current.status).toBeNull());
  });
});

// Contract: a needsReset answer asks for confirmation; confirming retries with reset true.
describe("usePrActions reset", () => {
  beforeEach(() => {
    vi.mocked(hostingCheckoutPullRequest).mockResolvedValueOnce({
      kind: "needsReset",
      branch: "pr/7",
    });
  });

  it("should set resetRequest with the pull request and branch and no status", async () => {
    const { result } = renderHookWithProviders(() => usePrActions(1));
    await act(() => result.current.checkout(pr7()));
    expect(result.current.resetRequest).toEqual({ pr: pr7(), branch: "pr/7" });
    expect(result.current.status).toBeNull();
  });

  it("should send reset true on the confirmed call and clear the request", async () => {
    const { result } = renderHookWithProviders(() => usePrActions(1));
    await act(() => result.current.checkout(pr7()));
    await act(() => result.current.checkout(pr7(), true));
    expect(hostingCheckoutPullRequest).toHaveBeenLastCalledWith(1, 7, true, null);
    expect(result.current.resetRequest).toBeNull();
    expect(result.current.status).toBe("Checked out feature-7.");
  });

  it("should clear the request when clearResetRequest is called", async () => {
    const { result } = renderHookWithProviders(() => usePrActions(1));
    await act(() => result.current.checkout(pr7()));
    act(() => result.current.clearResetRequest());
    expect(result.current.resetRequest).toBeNull();
  });
});

// Contract: failures surface as error; HTTPS auth failures raise the credential prompt.
describe("usePrActions failures", () => {
  it("should set error when the checkout fails", async () => {
    const error = networkError("hostUnreachable", { verb: "fetch" });
    vi.mocked(hostingCheckoutPullRequest).mockRejectedValue(error);
    const { result } = renderHookWithProviders(() => usePrActions(1));
    await act(() => result.current.checkout(pr7()));
    expect(result.current.error).toEqual(error);
    expect(result.current.status).toBeNull();
  });

  it("should clear the error when clearError is called", async () => {
    vi.mocked(hostingCheckoutPullRequest).mockRejectedValue(networkError("hostUnreachable"));
    const { result } = renderHookWithProviders(() => usePrActions(1));
    await act(() => result.current.checkout(pr7()));
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it("should clear the previous error when the next checkout starts", async () => {
    vi.mocked(hostingCheckoutPullRequest).mockRejectedValueOnce(networkError("hostUnreachable"));
    const { result } = renderHookWithProviders(() => usePrActions(1));
    await act(() => result.current.checkout(pr7()));
    await act(() => result.current.checkout(pr7()));
    expect(result.current.error).toBeNull();
  });

  it("should raise a credential prompt on an https auth failure with an origin", async () => {
    vi.mocked(hostingCheckoutPullRequest).mockRejectedValueOnce(authError());
    const { result } = renderHookWithProviders(() => usePrActions(1));
    act(() => {
      void result.current.checkout(pr7());
    });
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    expect(result.current.prompt?.origin).toBe("https://github.com");
    act(() => result.current.prompt?.cancel());
  });

  it("should retry with the typed credentials when the prompt is submitted", async () => {
    vi.mocked(hostingCheckoutPullRequest).mockRejectedValueOnce(authError());
    const { result } = renderHookWithProviders(() => usePrActions(1));
    let done!: Promise<void>;
    act(() => {
      done = result.current.checkout(pr7());
    });
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.submit("me", "tok"));
    await act(() => done);
    expect(hostingCheckoutPullRequest).toHaveBeenLastCalledWith(1, 7, false, {
      origin: "https://github.com",
      username: "me",
      token: "tok",
    });
    expect(result.current.status).toBe("Checked out feature-7.");
  });

  it("should set neither status nor error when the prompt is cancelled", async () => {
    vi.mocked(hostingCheckoutPullRequest).mockRejectedValueOnce(authError());
    const { result } = renderHookWithProviders(() => usePrActions(1));
    let done!: Promise<void>;
    act(() => {
      done = result.current.checkout(pr7());
    });
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.cancel());
    await act(() => done);
    expect([result.current.status, result.current.error]).toEqual([null, null]);
  });

  it("should be pending while a checkout runs", async () => {
    vi.mocked(hostingCheckoutPullRequest).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => usePrActions(1));
    act(() => {
      void result.current.checkout(pr7());
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
  });
});

// Contract: open and copyLink act on the pull request's web URL and report a failure as error.
describe("usePrActions open and copyLink", () => {
  it("open should call openExternal with the web URL", () => {
    const { result } = renderHookWithProviders(() => usePrActions(1));
    result.current.open(pr7());
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(pr7().webUrl);
  });

  it("open should turn a rejection into error", async () => {
    vi.mocked(openExternal).mockRejectedValue(new Error("blocked"));
    const { result } = renderHookWithProviders(() => usePrActions(1));
    act(() => result.current.open(pr7()));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "blocked" }));
  });

  it("copyLink should call copyText with the web URL", () => {
    const { result } = renderHookWithProviders(() => usePrActions(1));
    result.current.copyLink(pr7());
    expect(copyText).toHaveBeenCalledExactlyOnceWith(pr7().webUrl);
  });

  it("copyLink should turn a rejection into error", async () => {
    vi.mocked(copyText).mockRejectedValue(new Error("denied"));
    const { result } = renderHookWithProviders(() => usePrActions(1));
    act(() => result.current.copyLink(pr7()));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "denied" }));
  });

  it("open and copyLink should leave no error on success", async () => {
    const { result } = renderHookWithProviders(() => usePrActions(1));
    act(() => {
      result.current.open(pr7());
      result.current.copyLink(pr7());
    });
    await act(() => Promise.resolve());
    expect(result.current.error).toBeNull();
  });
});

// Contract (fix wave 2, F8): a checkout failure and a failed open or copy share one error slot;
// the most recent failure wins, and clearing or restarting a checkout clears both.
describe("usePrActions shared error slot", () => {
  const failCheckout = () =>
    vi.mocked(hostingCheckoutPullRequest).mockRejectedValue(networkError("hostUnreachable"));

  // Changed deliberately (round 2): a checkout error no longer outranks a newer link failure.
  it("should show a link error that came after the checkout error", async () => {
    failCheckout();
    vi.mocked(openExternal).mockRejectedValue(new Error("blocked"));
    const { result } = renderHookWithProviders(() => usePrActions(1));
    await act(() => result.current.checkout(pr7()));
    act(() => result.current.open(pr7()));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "blocked" }));
  });

  it("should show the checkout error that came after a link error", async () => {
    failCheckout();
    vi.mocked(copyText).mockRejectedValue(new Error("denied"));
    const { result } = renderHookWithProviders(() => usePrActions(1));
    act(() => result.current.copyLink(pr7()));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "denied" }));
    await act(() => result.current.checkout(pr7()));
    expect(result.current.error).toEqual(networkError("hostUnreachable"));
  });

  it("should show the link error again once the checkout error is gone", async () => {
    vi.mocked(hostingCheckoutPullRequest)
      .mockRejectedValueOnce(networkError("hostUnreachable"))
      .mockResolvedValue({ kind: "checkedOut", branch: "feature-7" });
    vi.mocked(openExternal).mockRejectedValue(new Error("blocked"));
    const { result } = renderHookWithProviders(() => usePrActions(1));
    await act(() => result.current.checkout(pr7()));
    act(() => result.current.open(pr7()));
    await act(() => Promise.resolve());
    // A successful checkout clears both, so only a new link failure can show again.
    await act(() => result.current.checkout(pr7()));
    expect(result.current.error).toBeNull();
    act(() => result.current.open(pr7()));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "blocked" }));
  });

  it("should clear a link error when clearError is called", async () => {
    vi.mocked(openExternal).mockRejectedValue(new Error("blocked"));
    const { result } = renderHookWithProviders(() => usePrActions(1));
    act(() => result.current.open(pr7()));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it("should clear both errors with one clearError call", async () => {
    failCheckout();
    vi.mocked(openExternal).mockRejectedValue(new Error("blocked"));
    const { result } = renderHookWithProviders(() => usePrActions(1));
    await act(() => result.current.checkout(pr7()));
    act(() => result.current.open(pr7()));
    await act(() => Promise.resolve());
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it("should clear a link error when a checkout starts", async () => {
    vi.mocked(copyText).mockRejectedValue(new Error("denied"));
    const { result } = renderHookWithProviders(() => usePrActions(1));
    act(() => result.current.copyLink(pr7()));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    vi.mocked(hostingCheckoutPullRequest).mockReturnValue(new Promise(() => undefined));
    act(() => {
      void result.current.checkout(pr7());
    });
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("should clear a checkout error when a checkout starts", async () => {
    failCheckout();
    const { result } = renderHookWithProviders(() => usePrActions(1));
    await act(() => result.current.checkout(pr7()));
    vi.mocked(hostingCheckoutPullRequest).mockReturnValue(new Promise(() => undefined));
    act(() => {
      void result.current.checkout(pr7());
    });
    await waitFor(() => expect(result.current.error).toBeNull());
  });
});

// Contract (fix wave 2, round 2): the error slot shows the most recent failure, whichever kind.
describe("usePrActions newest error wins", () => {
  const checkoutErr = networkError("hostUnreachable");
  const copyErr = { kind: "io", message: "denied" };

  async function checkoutThenCopyFails() {
    vi.mocked(hostingCheckoutPullRequest).mockRejectedValue(checkoutErr);
    vi.mocked(copyText).mockRejectedValue(new Error("denied"));
    const view = renderHookWithProviders(() => usePrActions(1));
    await act(() => view.result.current.checkout(pr7()));
    expect(view.result.current.error).toEqual(checkoutErr);
    act(() => view.result.current.copyLink(pr7()));
    await waitFor(() => expect(view.result.current.error).toEqual(copyErr));
    return view;
  }

  it("should show a copy failure that follows a checkout failure", async () => {
    const { result } = await checkoutThenCopyFails();
    expect(result.current.error).toEqual(copyErr);
  });

  it("should show a checkout failure that follows an open failure", async () => {
    vi.mocked(openExternal).mockRejectedValue(new Error("blocked"));
    vi.mocked(hostingCheckoutPullRequest).mockRejectedValue(checkoutErr);
    const { result } = renderHookWithProviders(() => usePrActions(1));
    act(() => result.current.open(pr7()));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "blocked" }));
    await act(() => result.current.checkout(pr7()));
    expect(result.current.error).toEqual(checkoutErr);
  });

  it("should stay clear after clearError following both failures, even on rerender", async () => {
    const { result, rerender } = await checkoutThenCopyFails();
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
    rerender();
    expect(result.current.error).toBeNull();
  });

  it("should show no error while a new checkout is pending after both failures", async () => {
    const { result } = await checkoutThenCopyFails();
    vi.mocked(hostingCheckoutPullRequest).mockReturnValue(new Promise(() => undefined));
    act(() => {
      void result.current.checkout(pr7());
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    expect(result.current.error).toBeNull();
  });
});
