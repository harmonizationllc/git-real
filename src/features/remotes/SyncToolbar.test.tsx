import { screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/renderWithProviders";
import { SyncToolbar } from "./SyncToolbar";
import type { NetworkMessage } from "./networkMessage";
import { CHECK_OUT_A_BRANCH, NETWORK_BUSY, NO_REMOTES, NO_UPSTREAM } from "./syncCopy";
import type { SyncActions } from "./useSyncActions";

const enabled = { fetch: null, pull: null, push: null, forcePush: null };

function fakeSync(over: Partial<SyncActions> = {}): SyncActions {
  return {
    gates: enabled,
    upstream: { text: "→ origin/main", ahead: 0, behind: 0 },
    upstreamRemote: "origin",
    running: null,
    fetch: vi.fn(),
    pull: vi.fn(),
    push: vi.fn(),
    requestForcePush: vi.fn(),
    message: null,
    dismissMessage: vi.fn(),
    prompt: null,
    setUpstream: null,
    publish: vi.fn(),
    cancelSetUpstream: vi.fn(),
    forcePush: null,
    confirmForcePush: vi.fn(),
    cancelForcePush: vi.fn(),
    ...over,
  };
}

function renderToolbar(over: Partial<SyncActions> = {}, withCreatePr = false) {
  const sync = fakeSync(over);
  const onOpenRemotes = vi.fn();
  const onCreatePullRequest = withCreatePr ? vi.fn() : null;
  const view = renderWithProviders(
    <SyncToolbar
      sync={sync}
      onOpenRemotes={onOpenRemotes}
      onCreatePullRequest={onCreatePullRequest}
    />,
  );
  return { sync, onOpenRemotes, onCreatePullRequest, ...view };
}

const button = (name: string) => screen.getByRole("button", { name });
const message = (over: Partial<NetworkMessage> = {}): NetworkMessage => ({
  title: "Could not reach the remote",
  hint: null,
  action: null,
  details: null,
  ...over,
});

// Contract: the toolbar landmark and the upstream text with ahead/behind counts.
describe("SyncToolbar upstream text", () => {
  it("should be a group labelled Sync", () => {
    renderToolbar();
    expect(screen.getByRole("group", { name: "Sync" })).toBeInTheDocument();
  });

  it("should show → origin/main with ↑2 and ↓3 labelled 2 ahead and 3 behind", () => {
    renderToolbar({ upstream: { text: "→ origin/main", ahead: 2, behind: 3 } });
    const toolbar = screen.getByRole("group", { name: "Sync" });
    expect(within(toolbar).getByText("→ origin/main")).toBeInTheDocument();
    expect(within(toolbar).getByRole("img", { name: "2 ahead" })).toHaveTextContent("↑2");
    expect(within(toolbar).getByRole("img", { name: "3 behind" })).toHaveTextContent("↓3");
  });

  it("should hide a zero count", () => {
    renderToolbar({ upstream: { text: "→ origin/main", ahead: 0, behind: 3 } });
    expect(screen.queryByRole("img", { name: "0 ahead" })).toBeNull();
    expect(screen.getByRole("img", { name: "3 behind" })).toBeInTheDocument();
  });

  it("should show → origin/main (upstream gone)", () => {
    renderToolbar({ upstream: { text: "→ origin/main (upstream gone)", ahead: 0, behind: 0 } });
    expect(screen.getByText("→ origin/main (upstream gone)")).toBeInTheDocument();
  });

  it("should show no upstream", () => {
    renderToolbar({ upstream: { text: "no upstream", ahead: 0, behind: 0 } });
    expect(screen.getByText("no upstream")).toBeInTheDocument();
  });

  it("should show no upstream text for a detached HEAD", () => {
    renderToolbar({ upstream: null });
    expect(screen.queryByText(/→|no upstream/)).toBeNull();
  });
});

// Contract: each button shows its gate as the title when disabled, and the busy label while running.
describe("SyncToolbar buttons", () => {
  it("should disable Fetch, Pull and Push with their gate as the title", () => {
    renderToolbar({
      gates: { fetch: NO_REMOTES, pull: NO_UPSTREAM, push: CHECK_OUT_A_BRANCH, forcePush: null },
    });
    expect(button("Fetch")).toBeDisabled();
    expect(button("Fetch")).toHaveAttribute("title", "No remotes configured");
    expect(button("Pull")).toBeDisabled();
    expect(button("Pull")).toHaveAttribute("title", "This branch has no upstream");
    expect(button("Push")).toBeDisabled();
    expect(button("Push")).toHaveAttribute("title", "Check out a branch to pull or push.");
  });

  it("should enable the buttons without a title when nothing gates them", () => {
    renderToolbar();
    for (const name of ["Fetch", "Pull", "Push"]) {
      expect(button(name)).toBeEnabled();
      expect(button(name)).not.toHaveAttribute("title");
    }
  });

  it.each([
    ["fetch", "Fetching…"],
    ["pull", "Pulling…"],
    ["push", "Pushing…"],
  ] as const)("should label the running verb's button when %s runs", (running, label) => {
    renderToolbar({
      running,
      gates: {
        fetch: NETWORK_BUSY,
        pull: NETWORK_BUSY,
        push: NETWORK_BUSY,
        forcePush: NETWORK_BUSY,
      },
    });
    expect(button(label)).toBeInTheDocument();
  });

  it("should leave the other buttons' labels alone while one verb runs", () => {
    renderToolbar({ running: "fetch" });
    expect(button("Pull")).toBeInTheDocument();
    expect(button("Push")).toBeInTheDocument();
  });

  it("should call the sync actions when Fetch, Pull and Push are pressed", async () => {
    const { user, sync } = renderToolbar();
    await user.click(button("Fetch"));
    await user.click(button("Pull"));
    await user.click(button("Push"));
    expect(sync.fetch).toHaveBeenCalledOnce();
    expect(sync.pull).toHaveBeenCalledExactlyOnceWith();
    expect(sync.push).toHaveBeenCalledOnce();
  });

  it("should not call a gated action when its disabled button is pressed", async () => {
    const { user, sync } = renderToolbar({
      gates: { fetch: NO_REMOTES, pull: NO_REMOTES, push: NO_REMOTES, forcePush: NO_REMOTES },
    });
    await user.click(button("Fetch"));
    expect(sync.fetch).not.toHaveBeenCalled();
  });

  it("should open the remotes list when Remotes… is pressed", async () => {
    const { user, onOpenRemotes } = renderToolbar();
    await user.click(button("Remotes…"));
    expect(onOpenRemotes).toHaveBeenCalledExactlyOnceWith({ mode: "list" });
  });
});

// Contract: the Pull and Push split buttons open menus with the mode and force variants.
describe("SyncToolbar menus", () => {
  it("should mark the option buttons as menu openers", () => {
    renderToolbar();
    expect(button("Pull options")).toHaveAttribute("aria-haspopup", "menu");
    expect(button("Push options")).toHaveAttribute("aria-haspopup", "menu");
  });

  it("should list Pull (merge) and Pull (rebase) under Pull options", async () => {
    const { user } = renderToolbar();
    await user.click(button("Pull options"));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Pull (merge)",
      "Pull (rebase)",
    ]);
  });

  it.each([
    ["Pull (merge)", "merge"],
    ["Pull (rebase)", "rebase"],
  ] as const)("should pull in that mode when %s is chosen", async (label, mode) => {
    const { user, sync } = renderToolbar();
    await user.click(button("Pull options"));
    await user.click(screen.getByRole("menuitem", { name: label }));
    expect(sync.pull).toHaveBeenCalledExactlyOnceWith(mode);
  });

  it("should list Force push (with lease)… under Push options and request a force push", async () => {
    const { user, sync } = renderToolbar();
    await user.click(button("Push options"));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Force push (with lease)…",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Force push (with lease)…" }));
    expect(sync.requestForcePush).toHaveBeenCalledOnce();
  });

  it("should disable Force push (with lease)… with the force-push gate as its title", async () => {
    const { user, sync } = renderToolbar({
      gates: { ...enabled, forcePush: NO_UPSTREAM },
    });
    await user.click(button("Push options"));
    const item = screen.getByRole("menuitem", { name: "Force push (with lease)…" });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", "This branch has no upstream");
    expect(sync.requestForcePush).not.toHaveBeenCalled();
  });
});

// Contract (W1): the toolbar never renders the network error itself; SyncMessage does, in its
// own row below the toolbar row.
describe("SyncToolbar message", () => {
  it("should render no alert even when sync carries a message", () => {
    renderToolbar({ message: message({ hint: "Check the URL." }) });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract: the credential prompt, the set-upstream dialog and the force-push confirmation
// render from sync state.
describe("SyncToolbar dialogs", () => {
  it("should render no dialog while the sync state has none", () => {
    renderToolbar();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should render the credential dialog for a prompt", () => {
    renderToolbar({
      prompt: {
        origin: "https://github.com",
        host: "github.com",
        rejected: false,
        submit: vi.fn(),
        cancel: vi.fn(),
      },
    });
    expect(screen.getByRole("dialog", { name: "Sign in to github.com" })).toBeInTheDocument();
  });

  const setUpstream = { remotes: ["origin"], branch: "main", error: null };

  it("should render the set-upstream dialog and publish through it", async () => {
    const { user, sync } = renderToolbar({ setUpstream });
    expect(screen.getByRole("dialog", { name: "Publish main" })).toBeInTheDocument();
    await user.click(button("Publish"));
    expect(sync.publish).toHaveBeenCalledExactlyOnceWith("origin", "main");
  });

  it("should cancel the set-upstream dialog through Cancel", async () => {
    const { user, sync } = renderToolbar({ setUpstream });
    await user.click(button("Cancel"));
    expect(sync.cancelSetUpstream).toHaveBeenCalledOnce();
  });

  it("should show the set-upstream dialog's error", () => {
    renderToolbar({
      setUpstream: { ...setUpstream, error: { kind: "invalidBranchName", message: "bad" } },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("main is not a valid branch name.");
  });

  it("should mark the set-upstream dialog pending while a push runs", () => {
    renderToolbar({ setUpstream, running: "push" });
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
  });

  const forcePush = { local: "main", remote: "origin", upstream: "origin/main" };

  it("should render the force-push confirmation with its verbatim copy", () => {
    renderToolbar({ forcePush });
    const dialog = screen.getByRole("dialog", { name: "Force push main to origin?" });
    expect(dialog).toHaveTextContent(
      "This replaces origin/main with your local branch. It fails safely if someone else pushed since your last fetch.",
    );
  });

  it("should confirm the force push with Force push", async () => {
    const { user, sync } = renderToolbar({ forcePush });
    await user.click(button("Force push"));
    expect(sync.confirmForcePush).toHaveBeenCalledOnce();
  });

  it("should cancel the force push with Cancel", async () => {
    const { user, sync } = renderToolbar({ forcePush });
    await user.click(button("Cancel"));
    expect(sync.cancelForcePush).toHaveBeenCalledOnce();
    expect(sync.confirmForcePush).not.toHaveBeenCalled();
  });

  it("should mark the force-push confirmation pending while a push runs", () => {
    renderToolbar({ forcePush, running: "push" });
    expect(screen.getByRole("dialog", { name: "Force push main to origin?" })).toHaveTextContent(
      "Working…",
    );
  });
});

// Contract: the option buttons are gated like the main buttons.
describe("SyncToolbar option buttons gating", () => {
  it("should disable Pull options with the pull gate as its title", () => {
    renderToolbar({ gates: { ...enabled, pull: NO_UPSTREAM } });
    expect(button("Pull options")).toBeDisabled();
    expect(button("Pull options")).toHaveAttribute("title", "This branch has no upstream");
  });

  it("should disable Push options with the push gate as its title", () => {
    renderToolbar({ gates: { ...enabled, push: CHECK_OUT_A_BRANCH } });
    expect(button("Push options")).toBeDisabled();
    expect(button("Push options")).toHaveAttribute("title", "Check out a branch to pull or push.");
  });

  it("should disable Pull options and Push options with the finish-or-abort title during an operation", () => {
    const gate = "Finish or abort the rebase first";
    renderToolbar({ gates: { fetch: null, pull: gate, push: gate, forcePush: gate } });
    expect(
      [button("Pull options"), button("Push options")].map((b) => b.getAttribute("title")),
    ).toEqual([gate, gate]);
    expect(button("Pull options")).toBeDisabled();
    expect(button("Push options")).toBeDisabled();
  });

  it("should keep Fetch and Remotes… enabled during an operation", () => {
    const gate = "Finish or abort the merge first";
    renderToolbar({ gates: { fetch: null, pull: gate, push: gate, forcePush: gate } });
    expect(button("Fetch")).toBeEnabled();
    expect(button("Remotes…")).toBeEnabled();
  });

  it("should enable both option buttons when nothing gates them", () => {
    renderToolbar();
    expect(button("Pull options")).toBeEnabled();
    expect(button("Push options")).toBeEnabled();
  });
});

// Contract: dialog stacking and focus return for the three toolbar dialogs.
describe("SyncToolbar dialog order and focus", () => {
  const prompt = {
    origin: "https://github.com",
    host: "github.com",
    rejected: false,
    submit: vi.fn(),
    cancel: vi.fn(),
  };

  it("should render the sign-in dialog last when it opens over the set-upstream dialog", () => {
    renderToolbar({
      setUpstream: { remotes: ["origin"], branch: "main", error: null },
      prompt,
    });
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs.at(-1)).toHaveAccessibleName("Sign in to github.com");
  });

  it("should render the sign-in dialog last when it opens over the force-push confirmation", () => {
    renderToolbar({
      forcePush: { local: "main", remote: "origin", upstream: "origin/main" },
      prompt,
    });
    expect(screen.getAllByRole("dialog").at(-1)).toHaveAccessibleName("Sign in to github.com");
  });

  it("should make the toolbar root a programmatic focus target", () => {
    renderToolbar();
    const root = screen.getByRole("group", { name: "Sync" });
    expect(root).toHaveAttribute("tabindex", "-1");
    expect(root).toHaveAttribute("data-focus-target");
  });

  function Harness() {
    const [sync, setSync] = useState(
      fakeSync({ setUpstream: { remotes: ["origin"], branch: "main", error: null } }),
    );
    return (
      <SyncToolbar
        sync={{
          ...sync,
          cancelSetUpstream: () =>
            setSync({
              ...fakeSync({ gates: { fetch: "b", pull: "b", push: "b", forcePush: "b" } }),
            }),
        }}
        onOpenRemotes={vi.fn()}
        onCreatePullRequest={null}
      />
    );
  }

  it("should land focus on the toolbar root when a dialog closes while Push is disabled", async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("group", { name: "Sync" })).toHaveFocus();
  });
});

// Contract: Push options leads with Create pull request… when the pane allows it; null hides it.
describe("SyncToolbar Create pull request menu item", () => {
  it("should list Create pull request… first under Push options when the prop is set", async () => {
    const { user } = renderToolbar({}, true);
    await user.click(button("Push options"));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Create pull request…",
      "Force push (with lease)…",
    ]);
  });

  it("should omit Create pull request… when the prop is null", async () => {
    const { user } = renderToolbar();
    await user.click(button("Push options"));
    expect(screen.queryByRole("menuitem", { name: "Create pull request…" })).toBeNull();
  });

  it("should call the prop once when Create pull request… is selected", async () => {
    const { user, onCreatePullRequest } = renderToolbar({}, true);
    await user.click(button("Push options"));
    await user.click(screen.getByRole("menuitem", { name: "Create pull request…" }));
    expect(onCreatePullRequest).toHaveBeenCalledOnce();
  });

  it("should not list Create pull request… under Pull options", async () => {
    const { user } = renderToolbar({}, true);
    await user.click(button("Pull options"));
    expect(screen.queryByRole("menuitem", { name: "Create pull request…" })).toBeNull();
  });

  it("should not call the prop when another Push options item is selected", async () => {
    const { user, onCreatePullRequest, sync } = renderToolbar({}, true);
    await user.click(button("Push options"));
    await user.click(screen.getByRole("menuitem", { name: "Force push (with lease)…" }));
    expect(onCreatePullRequest).not.toHaveBeenCalled();
    expect(sync.requestForcePush).toHaveBeenCalledOnce();
  });
});
