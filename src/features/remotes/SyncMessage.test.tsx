import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/renderWithProviders";
import type { NetworkMessage } from "./networkMessage";
import { SyncMessage } from "./SyncMessage";
import type { SyncActions } from "./useSyncActions";

function fakeSync(over: Partial<SyncActions> = {}): SyncActions {
  return {
    gates: { fetch: null, pull: null, push: null, forcePush: null },
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

function renderMessage(over: Partial<SyncActions> = {}) {
  const sync = fakeSync(over);
  const onOpenRemotes = vi.fn();
  const view = renderWithProviders(<SyncMessage sync={sync} onOpenRemotes={onOpenRemotes} />);
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

// Contract: a failure renders as a NetworkError whose actions drive the sync actions (moved out of
// SyncToolbar by W1 so it can sit in its own full-width row).
describe("SyncMessage", () => {
  it("should render nothing alert-like without a message", () => {
    renderMessage();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should render the message as a NetworkError", () => {
    renderMessage({ message: message({ hint: "Check the URL." }) });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not reach the remote");
    expect(screen.getByRole("alert")).toHaveTextContent("Check the URL.");
  });

  it("should run pull from the message's Pull action", async () => {
    const { user, sync } = renderMessage({
      message: message({ action: { kind: "pull", label: "Pull" } }),
    });
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "Pull" }));
    expect(sync.pull).toHaveBeenCalledExactlyOnceWith();
  });

  it("should run fetch from the message's Fetch action", async () => {
    const { user, sync } = renderMessage({
      message: message({ action: { kind: "fetch", label: "Fetch" } }),
    });
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "Fetch" }));
    expect(sync.fetch).toHaveBeenCalledOnce();
  });

  it("should open the upstream's remote for Edit remote…", async () => {
    const { user, onOpenRemotes } = renderMessage({
      upstreamRemote: "origin",
      message: message({ action: { kind: "editRemote", label: "Edit remote…" } }),
    });
    await user.click(button("Edit remote…"));
    expect(onOpenRemotes).toHaveBeenCalledExactlyOnceWith({ mode: "edit", name: "origin" });
  });

  it("should open the remotes list for Edit remote… without an upstream remote", async () => {
    const { user, onOpenRemotes } = renderMessage({
      upstreamRemote: null,
      message: message({ action: { kind: "editRemote", label: "Edit remote…" } }),
    });
    await user.click(button("Edit remote…"));
    expect(onOpenRemotes).toHaveBeenCalledExactlyOnceWith({ mode: "list" });
  });

  it("should open the add form for Add remote…", async () => {
    const { user, onOpenRemotes } = renderMessage({
      message: message({ action: { kind: "addRemote", label: "Add remote…" } }),
    });
    await user.click(button("Add remote…"));
    expect(onOpenRemotes).toHaveBeenCalledExactlyOnceWith({ mode: "add" });
  });

  it("should clear the message on Dismiss", async () => {
    const { user, sync } = renderMessage({ message: message() });
    await user.click(button("Dismiss"));
    expect(sync.dismissMessage).toHaveBeenCalledOnce();
  });
});
