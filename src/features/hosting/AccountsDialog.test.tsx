import { screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostingConnect, hostingDisconnect, hostingListAccounts } from "../../lib/ipc";
import type { HostingAccount } from "../../lib/ipc";
import { hostingAccount, hostingError } from "../../test/hostingFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { AccountsDialog } from "./AccountsDialog";
import type { AccountsPreset } from "./AccountsDialog";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingListAccounts: vi.fn(),
  hostingConnect: vi.fn(),
  hostingDisconnect: vi.fn(),
  openExternal: vi.fn(),
}));

let accounts: HostingAccount[] = [];
const onClose = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  accounts = [hostingAccount()];
  vi.mocked(hostingListAccounts).mockImplementation(() => Promise.resolve(accounts));
  vi.mocked(hostingDisconnect).mockResolvedValue(undefined);
  vi.mocked(hostingConnect).mockResolvedValue(hostingAccount({ username: "new" }));
});

function renderDialog(over: { open?: boolean; preset?: AccountsPreset } = {}) {
  return renderWithProviders(<AccountsDialog open onClose={onClose} {...over} />);
}

const button = (name: string) => screen.getByRole("button", { name });

async function renderList() {
  const view = renderDialog();
  await screen.findByText("Octo Cat");
  return view;
}

// Contract: closed renders nothing; open is a modal Hosting accounts dialog listing each account.
describe("AccountsDialog list", () => {
  it("renders nothing when closed", () => {
    renderDialog({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a modal dialog titled Hosting accounts", async () => {
    await renderList();
    expect(screen.getByRole("dialog", { name: "Hosting accounts" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
  });

  it("shows No accounts connected when there are none", async () => {
    accounts = [];
    renderDialog();
    expect(await screen.findByText("No accounts connected")).toBeInTheDocument();
  });

  it("shows the initial, the display name and username on host, and no image", async () => {
    await renderList();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("O")).toBeInTheDocument();
    expect(within(dialog).getByText("Octo Cat")).toBeInTheDocument();
    expect(within(dialog).getByText("octo on github.com")).toBeInTheDocument();
    expect(dialog.querySelector("img")).toBeNull();
  });

  it("falls back to the username when there is no display name", async () => {
    accounts = [hostingAccount({ displayName: null, username: "zed" })];
    renderDialog();
    expect(await screen.findByText("zed")).toBeInTheDocument();
    expect(screen.getByText("Z")).toBeInTheDocument();
  });

  it("does not render an avatar image even when the account has an avatarUrl", async () => {
    accounts = [hostingAccount({ avatarUrl: "https://avatars.example/octo.png" })];
    renderDialog();
    await screen.findByText("Octo Cat");
    expect(screen.getByRole("dialog").querySelector("img")).toBeNull();
  });

  it("shows no reconnect line for a healthy account", async () => {
    await renderList();
    expect(screen.queryByText("Token expired or revoked — reconnect")).toBeNull();
  });

  it("shows the load error when the accounts cannot be read", async () => {
    vi.mocked(hostingListAccounts).mockRejectedValue({ kind: "io", message: "store broke" });
    renderDialog();
    expect(await screen.findByRole("alert")).toHaveTextContent("store broke");
  });
});

// Contract: an account whose token the provider rejected offers Reconnect with the form preset.
describe("AccountsDialog reconnect", () => {
  beforeEach(() => {
    accounts = [
      hostingAccount({
        id: "gitlab:git.corp:me",
        provider: "gitlab",
        host: "git.corp",
        username: "me",
        displayName: null,
        needsReconnect: true,
      }),
    ];
  });

  it("shows the reconnect line and a labelled Reconnect button", async () => {
    renderDialog();
    expect(await screen.findByText("Token expired or revoked — reconnect")).toBeInTheDocument();
    expect(button("Reconnect me on git.corp")).toBeInTheDocument();
  });

  it("opens the connect form preset to that provider and host", async () => {
    const { user } = renderDialog();
    await user.click(await screen.findByRole("button", { name: "Reconnect me on git.corp" }));
    expect(await screen.findByRole("dialog", { name: "Connect account" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "GitLab" })).toBeChecked();
    expect(screen.getByLabelText("Host")).toHaveValue("git.corp");
  });
});

// Contract: Disconnect confirms, removes the account and reports a failure.
describe("AccountsDialog disconnect", () => {
  it("asks Disconnect octo from github.com? with the keychain note", async () => {
    const { user } = await renderList();
    await user.click(button("Disconnect octo on github.com"));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect octo from github.com?" });
    expect(dialog).toHaveTextContent("The token is removed from the system keychain.");
  });

  it("confirming calls hostingDisconnect with the account id", async () => {
    const { user } = await renderList();
    await user.click(button("Disconnect octo on github.com"));
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(hostingDisconnect).toHaveBeenCalledExactlyOnceWith("github:github.com:octo"),
    );
  });

  it("refreshes the list after disconnecting", async () => {
    const { user } = await renderList();
    await user.click(button("Disconnect octo on github.com"));
    accounts = [];
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("No accounts connected")).toBeInTheDocument();
  });

  it("Cancel closes the confirm without disconnecting", async () => {
    const { user } = await renderList();
    await user.click(button("Disconnect octo on github.com"));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: /^Disconnect/ })).toBeNull();
    expect(hostingDisconnect).not.toHaveBeenCalled();
  });

  it("Escape in the confirm leaves the accounts dialog open", async () => {
    const { user } = await renderList();
    await user.click(button("Disconnect octo on github.com"));
    await screen.findByRole("dialog", { name: /^Disconnect/ });
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Hosting accounts" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the hostingErrorText when disconnecting fails", async () => {
    vi.mocked(hostingDisconnect).mockRejectedValue(hostingError("keychainUnavailable"));
    const { user } = await renderList();
    await user.click(button("Disconnect octo on github.com"));
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(
      await screen.findByText(
        "No system keychain is available, so Git Real can't store the token safely.",
      ),
    ).toBeInTheDocument();
  });
});

// Contract: Connect account… opens the form; finishing returns to a refreshed list; a preset opens it directly.
describe("AccountsDialog connect", () => {
  it("opens the connect form from Connect account…", async () => {
    const { user } = await renderList();
    await user.click(button("Connect account…"));
    expect(await screen.findByRole("dialog", { name: "Connect account" })).toBeInTheDocument();
  });

  it("returns to the list and refetches the accounts after connecting", async () => {
    accounts = [];
    const { user } = renderDialog();
    await user.click(await screen.findByRole("button", { name: "Connect account…" }));
    accounts = [hostingAccount({ username: "new", displayName: "New One" })];
    await user.type(screen.getByLabelText("Token"), "t");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("New One")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Connect account" })).toBeNull();
  });

  it("Cancel in the form returns to the list", async () => {
    const { user } = await renderList();
    await user.click(button("Connect account…"));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Connect account" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Hosting accounts" })).toBeInTheDocument();
  });

  it("Escape in the form closes only the form", async () => {
    const { user } = await renderList();
    await user.click(button("Connect account…"));
    await screen.findByRole("dialog", { name: "Connect account" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Connect account" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens straight into the connect form when given a preset", async () => {
    renderDialog({ preset: { provider: "gitlab", host: "gitlab.com" } });
    expect(await screen.findByRole("dialog", { name: "Connect account" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "GitLab" })).toBeChecked();
  });

  it("keeps the accounts box mounted but inert under the form", async () => {
    const { user } = await renderList();
    await user.click(button("Connect account…"));
    await screen.findByRole("dialog", { name: "Connect account" });
    const box = screen.getByRole("dialog", { name: "Hosting accounts", hidden: true });
    expect(box).toHaveAttribute("inert");
  });

  it("renders the connect form as a sibling after the accounts box, not inside it", async () => {
    const { user } = await renderList();
    await user.click(button("Connect account…"));
    const form = await screen.findByRole("dialog", { name: "Connect account" });
    const box = screen.getByRole("dialog", { name: "Hosting accounts", hidden: true });
    expect(box).not.toContainElement(form);
    expect(box.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// Contract: Escape and Close dismiss the dialog.
describe("AccountsDialog closing", () => {
  it("Close calls onClose", async () => {
    const { user } = await renderList();
    await user.click(button("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape calls onClose", async () => {
    const { user } = await renderList();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// Contract: on close, focus returns to the opener unless it is gone; then to the fallback.
describe("AccountsDialog focus on close", () => {
  function Harness({ openerDisabled = false }: { openerDisabled?: boolean }) {
    const [open, setOpen] = useState(false);
    const fallback = useRef<HTMLDivElement>(null);
    return (
      <>
        <div ref={fallback} tabIndex={-1} data-testid="fallback" />
        <button type="button" disabled={openerDisabled} onClick={() => setOpen(true)}>
          Opener
        </button>
        <AccountsDialog open={open} onClose={() => setOpen(false)} fallbackFocus={fallback} />
      </>
    );
  }

  it("returns focus to the opener when it closes", async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Opener" }));
    await user.click(await screen.findByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus();
  });

  it("returns focus to the fallback when the opener is gone", async () => {
    const { user, rerender } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Opener" }));
    await screen.findByRole("dialog", { name: "Hosting accounts" });
    rerender(<Harness openerDisabled />);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("fallback")).toHaveFocus();
  });
});
