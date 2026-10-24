import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostingCreatePullRequest, openExternal } from "../../lib/ipc";
import type { Tracking } from "../../lib/ipc";
import { useToasts } from "../../lib/store/toasts";
import { hostingError, pullRequest } from "../../test/hostingFixtures";
import { authError } from "../../test/remoteFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useCreatePullRequest } from "./useCreatePullRequest";
import type { CreatePrInput } from "./useCreatePullRequest";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingCreatePullRequest: vi.fn(),
  openExternal: vi.fn(),
}));

const created = () => pullRequest(124, { sourceBranch: "feat", targetBranch: "main" });
const input = (over: Partial<CreatePrInput> = {}): CreatePrInput => ({
  title: "Add login",
  body: "Why",
  target: "main",
  pushFirst: true,
  ...over,
});
const upstream = (name: string, ahead: number | null, behind: number | null = 0): Tracking => ({
  upstream: name,
  ahead,
  behind,
});

beforeEach(() => {
  vi.resetAllMocks();
  useToasts.setState({ toasts: [] });
  vi.mocked(hostingCreatePullRequest).mockResolvedValue(created());
  vi.mocked(openExternal).mockResolvedValue(undefined);
});

/** Renders the hook for local branch `feat` on repo 1 with origin as the only remote. */
const render = (tracking: Tracking | null, remotes = ["origin"]) =>
  renderHookWithProviders(() => useCreatePullRequest(1, "feat", tracking, remotes));

// Contract: the push plan comes from the tracking and remotes.
describe("useCreatePullRequest plan", () => {
  it("should plan to publish a branch without an upstream", () => {
    const { result } = render(null);
    expect(result.current.plan).toEqual({ kind: "publish" });
  });

  it("should plan to push the commits an origin upstream is ahead by", () => {
    const { result } = render(upstream("origin/feat", 2));
    expect(result.current.plan).toEqual({ kind: "push", ahead: 2 });
  });

  it("should start idle with nothing to show", () => {
    const { result } = render(null);
    expect([result.current.pending, result.current.error, result.current.prompt]).toEqual([
      false,
      null,
      null,
    ]);
  });
});

// Contract: submit sends one request that pushes (when asked) and then opens the pull request.
describe("useCreatePullRequest submit request", () => {
  it("should publish and open the pull request when the branch has no upstream", async () => {
    const { result } = render(null);
    await act(() => result.current.submit(input()));
    expect(hostingCreatePullRequest).toHaveBeenCalledExactlyOnceWith(
      1,
      {
        branch: "feat",
        push: { kind: "setUpstream", remote: "origin", branch: "feat" },
        pr: { title: "Add login", body: "Why", sourceBranch: "feat", targetBranch: "main" },
      },
      null,
    );
  });

  it("should push to the upstream and name the head after it when push-first is on", async () => {
    const { result } = render(upstream("origin/renamed", 2));
    await act(() => result.current.submit(input({ pushFirst: true })));
    expect(hostingCreatePullRequest).toHaveBeenCalledExactlyOnceWith(
      1,
      {
        branch: "feat",
        push: { kind: "upstream" },
        pr: { title: "Add login", body: "Why", sourceBranch: "renamed", targetBranch: "main" },
      },
      null,
    );
  });

  it("should not push when push-first is off", async () => {
    const { result } = render(upstream("origin/feat", 2));
    await act(() => result.current.submit(input({ pushFirst: false })));
    expect(vi.mocked(hostingCreatePullRequest).mock.calls[0]?.[1].push).toBeNull();
  });

  it("should not push when the upstream is level", async () => {
    const { result } = render(upstream("origin/feat", 0));
    await act(() => result.current.submit(input({ pushFirst: true })));
    expect(vi.mocked(hostingCreatePullRequest).mock.calls[0]?.[1].push).toBeNull();
  });

  it("should send the chosen target branch", async () => {
    const { result } = render(upstream("origin/feat", 0));
    await act(() => result.current.submit(input({ target: "develop" })));
    expect(vi.mocked(hostingCreatePullRequest).mock.calls[0]?.[1].pr.targetBranch).toBe("develop");
  });

  it("should trim the title and leave the body as typed", async () => {
    const { result } = render(upstream("origin/feat", 0));
    await act(() => result.current.submit(input({ title: "  Add login \n", body: " Why\n\n" })));
    expect(vi.mocked(hostingCreatePullRequest).mock.calls[0]?.[1].pr).toMatchObject({
      title: "Add login",
      body: " Why\n\n",
    });
  });

  it("should publish when the upstream is on another remote", async () => {
    const { result } = render(upstream("fork/feat", 0), ["origin", "fork"]);
    await act(() => result.current.submit(input({ pushFirst: false })));
    expect(vi.mocked(hostingCreatePullRequest).mock.calls[0]?.[1].push).toEqual({
      kind: "setUpstream",
      remote: "origin",
      branch: "feat",
    });
  });
});

// Contract: success resolves the pull request and shows a toast that opens it.
describe("useCreatePullRequest success", () => {
  it("should resolve the created pull request", async () => {
    const { result } = render(null);
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.submit(input());
    });
    expect(outcome).toEqual(created());
  });

  it("should show an Opened #n toast", async () => {
    const { result } = render(null);
    await act(() => result.current.submit(input()));
    expect(useToasts.getState().toasts).toHaveLength(1);
    expect(useToasts.getState().toasts[0]?.text).toBe("Opened #124");
  });

  it("should give the toast an action that opens the pull request in the browser", async () => {
    const { result } = render(null);
    await act(() => result.current.submit(input()));
    const action = useToasts.getState().toasts[0]?.action;
    expect(action?.label).toBe("Open in browser");
    action?.run();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(created().webUrl);
  });

  it("should leave no error behind", async () => {
    const { result } = render(null);
    await act(() => result.current.submit(input()));
    expect(result.current.error).toBeNull();
  });
});

// Contract: a failure resolves null with the error set and no toast; the next submit clears it.
describe("useCreatePullRequest failure", () => {
  it("should resolve null with the AppError when the provider rejects", async () => {
    const error = hostingError("hostingRejected", "A pull request already exists");
    vi.mocked(hostingCreatePullRequest).mockRejectedValue(error);
    const { result } = render(null);
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.submit(input());
    });
    expect(outcome).toBeNull();
    expect(result.current.error?.kind).toBe("hostingRejected");
  });

  it("should show no toast when the call fails", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValue(hostingError("hostingRejected"));
    const { result } = render(null);
    await act(() => result.current.submit(input()));
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it("should clear the error when clearError is called", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValue(hostingError("hostingRejected"));
    const { result } = render(null);
    await act(() => result.current.submit(input()));
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it("should clear the previous error when the next submit succeeds", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValueOnce(hostingError("hostingRejected"));
    const { result } = render(null);
    await act(() => result.current.submit(input()));
    await act(() => result.current.submit(input()));
    expect(result.current.error).toBeNull();
  });

  it("should clear the previous error as soon as the next submit starts", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValueOnce(hostingError("hostingRejected"));
    const { result } = render(null);
    await act(() => result.current.submit(input()));
    vi.mocked(hostingCreatePullRequest).mockReturnValue(new Promise(() => undefined));
    act(() => {
      void result.current.submit(input());
    });
    await waitFor(() => expect(result.current.error).toBeNull());
  });
});

// Contract: an HTTPS auth failure of the push asks for sign-in; cancelling is not an error.
describe("useCreatePullRequest sign-in", () => {
  it("should raise a credential prompt on an https auth failure", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValueOnce(authError());
    const { result } = render(null);
    act(() => {
      void result.current.submit(input());
    });
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    expect(result.current.prompt?.origin).toBe("https://github.com");
    act(() => result.current.prompt?.cancel());
  });

  it("should resolve null with no error and no toast when the prompt is cancelled", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValueOnce(authError());
    const { result } = render(null);
    let done!: Promise<unknown>;
    act(() => {
      done = result.current.submit(input());
    });
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.cancel());
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await done;
    });
    expect([outcome, result.current.error, useToasts.getState().toasts]).toEqual([null, null, []]);
  });

  it("should retry the same request with the typed credentials and resolve the pull request", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValueOnce(authError());
    const { result } = render(null);
    let done!: Promise<unknown>;
    act(() => {
      done = result.current.submit(input());
    });
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.submit("me", "tok"));
    let outcome: unknown;
    await act(async () => {
      outcome = await done;
    });
    expect(outcome).toEqual(created());
    expect(hostingCreatePullRequest).toHaveBeenCalledTimes(2);
    expect(hostingCreatePullRequest).toHaveBeenLastCalledWith(1, expect.anything(), {
      origin: "https://github.com",
      username: "me",
      token: "tok",
    });
  });
});

// Contract: pending covers the whole call.
describe("useCreatePullRequest pending", () => {
  it("should be pending while the call is in flight", async () => {
    vi.mocked(hostingCreatePullRequest).mockReturnValue(new Promise(() => undefined));
    const { result } = render(null);
    act(() => {
      void result.current.submit(input());
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
  });

  it("should stop being pending once the call settles", async () => {
    const { result } = render(null);
    await act(() => result.current.submit(input()));
    expect(result.current.pending).toBe(false);
  });
});
