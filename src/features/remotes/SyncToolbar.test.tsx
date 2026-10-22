import { screen, within } from "@testing-library/react";
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

function renderToolbar(over: Partial<SyncActions> = {}) {
  const sync = fakeSync(over);
  const onOpenRemotes = vi.fn();
  const view = renderWithProviders(<SyncToolbar sync={sync} onOpenRemotes={onOpenRemotes} />);
  return { sync, onOpenRemotes, ...view };
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
  it("should be a toolbar labelled Sync", () => {
    renderToolbar();
    expect(screen.getByRole("toolbar", { name: "Sync" })).toBeInTheDocument();
  });

  it("should show → origin/main with ↑2 and ↓3 labelled 2 ahead and 3 behind", () => {
    renderToolbar({ upstream: { text: "→ origin/main", ahead: 2, behind: 3 } });
    const toolbar = screen.getByRole("toolbar", { name: "Sync" });
    expect(within(toolbar).getByText("→ origin/main")).toBeInTheDocument();
    expect(within(toolbar).getByLabelText("2 ahead")).toHaveTextContent("↑2");
    expect(within(toolbar).getByLabelText("3 behind")).toHaveTextContent("↓3");
  });

  it("should hide a zero count", () => {
    renderToolbar({ upstream: { text: "→ origin/main", ahead: 0, behind: 3 } });
    expect(screen.queryByLabelText("0 ahead")).toBeNull();
    expect(screen.getByLabelText("3 behind")).toBeInTheDocument();
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

// Contract: a failure renders as a NetworkError whose actions drive the toolbar.
describe("SyncToolbar message", () => {
  it("should render nothing alert-like without a message", () => {
    renderToolbar();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should render the message as a NetworkError", () => {
    renderToolbar({ message: message({ hint: "Check the URL." }) });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not reach the remote");
    expect(screen.getByRole("alert")).toHaveTextContent("Check the URL.");
  });

  it("should run pull from the message's Pull action", async () => {
    const { user, sync } = renderToolbar({
      message: message({ action: { kind: "pull", label: "Pull" } }),
    });
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "Pull" }));
    expect(sync.pull).toHaveBeenCalledExactlyOnceWith();
  });

  it("should run fetch from the message's Fetch action", async () => {
    const { user, sync } = renderToolbar({
      message: message({ action: { kind: "fetch", label: "Fetch" } }),
    });
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "Fetch" }));
    expect(sync.fetch).toHaveBeenCalledOnce();
  });

  it("should open the upstream's remote for Edit remote…", async () => {
    const { user, onOpenRemotes } = renderToolbar({
      upstreamRemote: "origin",
      message: message({ action: { kind: "editRemote", label: "Edit remote…" } }),
    });
    await user.click(button("Edit remote…"));
    expect(onOpenRemotes).toHaveBeenCalledExactlyOnceWith({ mode: "edit", name: "origin" });
  });

  it("should open the remotes list for Edit remote… without an upstream remote", async () => {
    const { user, onOpenRemotes } = renderToolbar({
      upstreamRemote: null,
      message: message({ action: { kind: "editRemote", label: "Edit remote…" } }),
    });
    await user.click(button("Edit remote…"));
    expect(onOpenRemotes).toHaveBeenCalledExactlyOnceWith({ mode: "list" });
  });

  it("should open the add form for Add remote…", async () => {
    const { user, onOpenRemotes } = renderToolbar({
      message: message({ action: { kind: "addRemote", label: "Add remote…" } }),
    });
    await user.click(button("Add remote…"));
    expect(onOpenRemotes).toHaveBeenCalledExactlyOnceWith({ mode: "add" });
  });

  it("should clear the message on Dismiss", async () => {
    const { user, sync } = renderToolbar({ message: message() });
    await user.click(button("Dismiss"));
    expect(sync.dismissMessage).toHaveBeenCalledOnce();
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
