import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostingConnect, openExternal } from "../../lib/ipc";
import { hostingAccount, hostingError } from "../../test/hostingFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { ConnectAccountDialog } from "./ConnectAccountDialog";
import { SCOPE_HINT } from "./hostingCopy";
import type { HostingAccount } from "../../lib/ipc";
import type { AccountsPreset } from "./AccountsDialog";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingConnect: vi.fn(),
  openExternal: vi.fn(),
}));

const onDone = vi.fn();
const onCancel = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hostingConnect).mockResolvedValue(hostingAccount());
  vi.mocked(openExternal).mockResolvedValue(undefined);
});

function renderDialog(over: { preset?: AccountsPreset; accounts?: HostingAccount[] } = {}) {
  return renderWithProviders(
    <ConnectAccountDialog accounts={[]} onDone={onDone} onCancel={onCancel} {...over} />,
  );
}

const radio = (name: string) => screen.getByRole("radio", { name });
const host = () => screen.getByLabelText("Host");
const token = () => screen.getByLabelText("Token");
const connect = () => screen.getByRole("button", { name: "Connect" });

// Contract: a modal form with a Provider radio group, a Host field (not for Bitbucket) and a token.
describe("ConnectAccountDialog form", () => {
  it("is a modal dialog titled Connect account", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Connect account" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
  });

  it("groups the three providers under Provider with GitHub checked", () => {
    renderDialog();
    expect(screen.getByRole("group", { name: "Provider" })).toBeInTheDocument();
    expect([radio("GitHub"), radio("GitLab"), radio("Bitbucket")].map((r) => r.checked)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("starts on the preset's provider and host", () => {
    renderDialog({ preset: { provider: "gitlab", host: "git.corp" } });
    expect(radio("GitLab")).toBeChecked();
    expect(host()).toHaveValue("git.corp");
  });

  it("shows the default host as the placeholder with its hint", () => {
    renderDialog();
    expect(host()).toHaveAttribute("placeholder", "github.com");
    expect(screen.getByText("Leave empty for github.com.")).toBeInTheDocument();
  });

  it("switches the placeholder and hint when GitLab is chosen", async () => {
    const { user } = renderDialog();
    await user.click(radio("GitLab"));
    expect(host()).toHaveAttribute("placeholder", "gitlab.com");
    expect(screen.getByText("Leave empty for gitlab.com.")).toBeInTheDocument();
  });

  it("hides Host and its hint for Bitbucket", async () => {
    const { user } = renderDialog();
    await user.click(radio("Bitbucket"));
    expect(screen.queryByLabelText("Host")).toBeNull();
    expect(screen.queryByText(/^Leave empty for/)).toBeNull();
  });

  it.each([
    ["GitHub", "github"],
    ["GitLab", "gitlab"],
    ["Bitbucket", "bitbucket"],
  ] as const)("shows the %s scope hint", async (label, provider) => {
    const { user } = renderDialog();
    await user.click(radio(label));
    expect(screen.getByText(SCOPE_HINT[provider])).toBeInTheDocument();
  });

  it("has a password token field with autocomplete off", () => {
    renderDialog();
    expect(token()).toHaveAttribute("type", "password");
    expect(token()).toHaveAttribute("autocomplete", "off");
  });

  it("disables Connect until the token is non-empty", async () => {
    const { user } = renderDialog();
    expect(connect()).toBeDisabled();
    await user.type(token(), "t");
    expect(connect()).toBeEnabled();
  });
});

// Contract: submitting sends the trimmed host, empties the token field at once and reports the account.
describe("ConnectAccountDialog submit", () => {
  it("calls hostingConnect with a null host when Host is empty", async () => {
    const { user } = renderDialog();
    await user.type(token(), "ghp_x");
    await user.click(connect());
    expect(hostingConnect).toHaveBeenCalledExactlyOnceWith("github", null, "ghp_x");
  });

  it("trims the host and sends the chosen provider", async () => {
    const { user } = renderDialog();
    await user.click(radio("GitLab"));
    await user.type(host(), "  git.corp ");
    await user.type(token(), "glpat-x");
    await user.click(connect());
    expect(hostingConnect).toHaveBeenCalledExactlyOnceWith("gitlab", "git.corp", "glpat-x");
  });

  it("sends a null host for Bitbucket", async () => {
    const { user } = renderDialog();
    await user.click(radio("Bitbucket"));
    await user.type(token(), "bb");
    await user.click(connect());
    expect(hostingConnect).toHaveBeenCalledExactlyOnceWith("bitbucket", null, "bb");
  });

  it("treats a whitespace-only host as empty", async () => {
    const { user } = renderDialog();
    await user.type(host(), "   ");
    await user.type(token(), "t");
    await user.click(connect());
    expect(hostingConnect).toHaveBeenCalledExactlyOnceWith("github", null, "t");
  });

  it("shows Connecting… and empties the token before the call resolves", async () => {
    vi.mocked(hostingConnect).mockReturnValue(new Promise(() => undefined));
    const { user } = renderDialog();
    await user.type(token(), "secret");
    await user.click(connect());
    expect(await screen.findByRole("button", { name: "Connecting…" })).toBeDisabled();
    expect(token()).toHaveValue("");
  });

  it("calls onDone with the connected account", async () => {
    const { user } = renderDialog();
    await user.type(token(), "t");
    await user.click(connect());
    await waitFor(() => expect(onDone).toHaveBeenCalledExactlyOnceWith(hostingAccount()));
  });

  it("does not call onCancel on success", async () => {
    const { user } = renderDialog();
    await user.type(token(), "t");
    await user.click(connect());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// Contract: only one account per host; replacing asks first and keeps the form on Cancel.
describe("ConnectAccountDialog replace", () => {
  const existing = () => [hostingAccount()];

  it("asks Replace octo on github.com? before submitting over the same provider and host", async () => {
    const { user } = renderDialog({ accounts: existing() });
    await user.type(token(), "t");
    await user.click(connect());
    const dialog = await screen.findByRole("dialog", { name: "Replace octo on github.com?" });
    expect(dialog).toHaveTextContent(
      "Only one account per host is supported. The old token is removed from the system keychain.",
    );
    expect(hostingConnect).not.toHaveBeenCalled();
  });

  it("Cancel keeps the form with the token and calls nothing", async () => {
    const { user } = renderDialog({ accounts: existing() });
    await user.type(token(), "t");
    await user.click(connect());
    const confirm = await screen.findByRole("dialog", { name: "Replace octo on github.com?" });
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Replace octo on github.com?" })).toBeNull();
    expect(token()).toHaveValue("t");
    expect(hostingConnect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Replace submits", async () => {
    const { user } = renderDialog({ accounts: existing() });
    await user.type(token(), "t");
    await user.click(connect());
    await user.click(await screen.findByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect(hostingConnect).toHaveBeenCalledExactlyOnceWith("github", null, "t"),
    );
  });

  it("Escape in the replace confirm leaves the connect dialog open", async () => {
    const { user } = renderDialog({ accounts: existing() });
    await user.type(token(), "t");
    await user.click(connect());
    await screen.findByRole("dialog", { name: "Replace octo on github.com?" });
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Connect account" })).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("does not ask for an account on another host of the same provider", async () => {
    const { user } = renderDialog({ accounts: [hostingAccount({ host: "ghe.corp" })] });
    await user.type(token(), "t");
    await user.click(connect());
    await waitFor(() => expect(hostingConnect).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: /^Replace/ })).toBeNull();
  });

  it("does not ask for an account of another provider", async () => {
    const { user } = renderDialog({
      accounts: [hostingAccount({ provider: "gitlab", host: "gitlab.com" })],
    });
    await user.type(token(), "t");
    await user.click(connect());
    await waitFor(() => expect(hostingConnect).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: /^Replace/ })).toBeNull();
  });

  it("matches the typed host against the account's host", async () => {
    const { user } = renderDialog({
      accounts: [hostingAccount({ provider: "gitlab", host: "git.corp", username: "me" })],
    });
    await user.click(radio("GitLab"));
    await user.type(host(), "git.corp");
    await user.type(token(), "t");
    await user.click(connect());
    expect(
      await screen.findByRole("dialog", { name: "Replace me on git.corp?" }),
    ).toBeInTheDocument();
  });
});

// Contract: a failed connect shows its text and leaves the token empty.
describe("ConnectAccountDialog failure", () => {
  it.each([
    [
      "hostingAuth",
      "GitHub rejected the token. Check that it is current and has the scopes it needs.",
    ],
    ["invalidHostingHost", "Enter a host name such as github.example.com, optionally with :port."],
    [
      "keychainUnavailable",
      "No system keychain is available, so Git Real can't store the token safely.",
    ],
    ["invalidToken", "Paste the token exactly as GitHub showed it."],
  ] as const)("shows the %s text in an alert", async (kind, text) => {
    vi.mocked(hostingConnect).mockRejectedValue(hostingError(kind));
    const { user } = renderDialog();
    await user.type(token(), "t");
    await user.click(connect());
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("leaves the token empty and does not call onDone", async () => {
    vi.mocked(hostingConnect).mockRejectedValue(hostingError("hostingAuth"));
    const { user } = renderDialog();
    await user.type(token(), "t");
    await user.click(connect());
    await screen.findByRole("alert");
    expect(token()).toHaveValue("");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("names the chosen provider in the error", async () => {
    vi.mocked(hostingConnect).mockRejectedValue(hostingError("hostingAuth"));
    const { user } = renderDialog();
    await user.click(radio("Bitbucket"));
    await user.type(token(), "t");
    await user.click(connect());
    expect(await screen.findByRole("alert")).toHaveTextContent("Bitbucket rejected the token.");
  });

  it("lets the user try again after a failure", async () => {
    vi.mocked(hostingConnect).mockRejectedValueOnce(hostingError("hostingAuth"));
    const { user } = renderDialog();
    await user.type(token(), "bad");
    await user.click(connect());
    await screen.findByRole("alert");
    await user.type(token(), "good");
    await user.click(connect());
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(hostingConnect).toHaveBeenLastCalledWith("github", null, "good");
  });
});

// Contract: Create a token opens the provider's token page for the chosen host.
describe("ConnectAccountDialog create a token", () => {
  it("opens the GitHub page for the default host", async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Create a token" }));
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://github.com/settings/personal-access-tokens/new",
    );
  });

  it("opens a self-hosted GitLab page for the typed host", async () => {
    const { user } = renderDialog();
    await user.click(radio("GitLab"));
    await user.type(host(), "git.corp");
    await user.click(screen.getByRole("button", { name: "Create a token" }));
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://git.corp/-/user_settings/personal_access_tokens",
    );
  });

  it("opens the Atlassian page for Bitbucket", async () => {
    const { user } = renderDialog();
    await user.click(radio("Bitbucket"));
    await user.click(screen.getByRole("button", { name: "Create a token" }));
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://id.atlassian.com/manage-profile/security/api-tokens",
    );
  });

  it("shows the message when the link cannot be opened", async () => {
    vi.mocked(openExternal).mockRejectedValue(new Error("Only https links can be opened"));
    const { user } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Create a token" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only https links can be opened");
  });
});

// Contract: Cancel and Escape leave without connecting.
describe("ConnectAccountDialog cancel", () => {
  it("Cancel calls onCancel", async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("Escape calls onCancel", async () => {
    const { user } = renderDialog();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("calls hostingConnect for neither", async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(hostingConnect).not.toHaveBeenCalled();
  });
});
