import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostingListAccounts, hostingListMyRepos } from "../../lib/ipc";
import { useLayoutPrefs } from "../../lib/store/layoutPrefs";
import {
  hostedRepo,
  hostedRepoPage,
  hostedRepos,
  hostingAccount,
  hostingError,
} from "../../test/hostingFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { fullDate } from "../graph/model/relativeTime";
import { RepoBrowser } from "./RepoBrowser";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingListAccounts: vi.fn(),
  hostingListMyRepos: vi.fn(),
}));

const OCTO = "github:github.com:octo";
const LAB = "gitlab:gitlab.example.com:octo2";

// The clock advances by itself so react-query and waitFor still settle; the debounce is driven
// with advanceTimersByTimeAsync. user-event hangs under fake timers, so events are fired directly.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.resetAllMocks();
  localStorage.clear();
  useLayoutPrefs.setState({ cloneUrlForm: "https" });
  vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount()]);
  vi.mocked(hostingListMyRepos).mockImplementation((_id, query) =>
    Promise.resolve(
      hostedRepoPage(
        query === ""
          ? [hostedRepo(), hostedRepo({ fullName: "octo/other", name: "other", private: true })]
          : [hostedRepo({ fullName: "octo/found", name: "found" })],
      ),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

// RepoBrowser is controlled (fix 5): the parent owns the selected account. The harness is that
// parent, keeping the choice in state the way CloneDialog does.
function Harness(props: {
  initial: string | null;
  onSelectAccount: (id: string) => void;
  onPick: () => void;
  onManageAccounts: () => void;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState(props.initial);
  return (
    <RepoBrowser
      selectedAccountId={selected}
      onSelectAccount={(id) => {
        props.onSelectAccount(id);
        setSelected(id);
      }}
      onPick={props.onPick}
      onManageAccounts={props.onManageAccounts}
      disabled={props.disabled}
    />
  );
}

async function renderBrowser(
  over: { disabled?: boolean; selectedAccountId?: string | null } = {},
  settle = true,
) {
  const onPick = vi.fn();
  const onManageAccounts = vi.fn();
  const onSelectAccount = vi.fn();
  const view = renderWithProviders(
    <Harness
      initial={over.selectedAccountId ?? null}
      onSelectAccount={onSelectAccount}
      onPick={onPick}
      onManageAccounts={onManageAccounts}
      disabled={over.disabled ?? false}
    />,
  );
  if (settle) await screen.findByRole("button", { name: "Use octo/git-real" });
  return { onPick, onManageAccounts, onSelectAccount, ...view };
}

const search = () => screen.getByLabelText("Search repositories");
const type = (value: string) => fireEvent.change(search(), { target: { value } });
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
// Freezes the clock after the browser has settled: nothing advances unless a test advances it, so
// the debounce edges (299 ms / 300 ms) cannot drift under machine load.
const freezeClock = () => {
  vi.useRealTimers();
  vi.useFakeTimers();
};
const use = (fullName: string) => screen.getByRole("button", { name: `Use ${fullName}` });
const radio = (name: "HTTPS" | "SSH") => screen.getByRole("radio", { name });

// Contract: without a connected account the browser offers to connect one and calls nothing.
describe("RepoBrowser without an account", () => {
  beforeEach(() => {
    vi.mocked(hostingListAccounts).mockResolvedValue([]);
  });

  it("shows the connect notice", async () => {
    await renderBrowser({}, false);
    expect(
      await screen.findByText("Connect a hosting account to browse your repositories"),
    ).toBeInTheDocument();
  });

  it("asks the parent to open the accounts dialog from Hosting accounts…", async () => {
    const { onManageAccounts } = await renderBrowser({}, false);
    fireEvent.click(await screen.findByRole("button", { name: "Hosting accounts…" }));
    expect(onManageAccounts).toHaveBeenCalledTimes(1);
  });

  it("does not render the accounts dialog itself", async () => {
    await renderBrowser({}, false);
    fireEvent.click(await screen.findByRole("button", { name: "Hosting accounts…" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not request repositories", async () => {
    await renderBrowser({}, false);
    await screen.findByText("Connect a hosting account to browse your repositories");
    expect(hostingListMyRepos).not.toHaveBeenCalled();
  });

  it("does not show the connect notice while the accounts load", async () => {
    vi.mocked(hostingListAccounts).mockReturnValue(new Promise(() => undefined));
    await renderBrowser({}, false);
    expect(
      screen.queryByText("Connect a hosting account to browse your repositories"),
    ).not.toBeInTheDocument();
  });

  it("does not offer the search field", async () => {
    await renderBrowser({}, false);
    await screen.findByText("Connect a hosting account to browse your repositories");
    expect(screen.queryByLabelText("Search repositories")).not.toBeInTheDocument();
  });
});

// Contract: while the accounts load the browser says so; if they fail it shows the error and
// Dismiss asks again. It never sits blank.
describe("RepoBrowser while the accounts load", () => {
  it("shows Loading… as a status while the accounts query is pending", async () => {
    vi.mocked(hostingListAccounts).mockReturnValue(new Promise(() => undefined));
    await renderBrowser({}, false);
    expect(await screen.findByRole("status")).toHaveTextContent("Loading…");
    expect(screen.queryByLabelText("Search repositories")).not.toBeInTheDocument();
    expect(hostingListMyRepos).not.toHaveBeenCalled();
  });

  it("shows the error's text in an alert when the accounts query fails", async () => {
    vi.mocked(hostingListAccounts).mockRejectedValue({ kind: "io", message: "keychain locked" });
    await renderBrowser({}, false);
    expect(await screen.findByRole("alert")).toHaveTextContent("keychain locked");
    expect(screen.queryByText("Connect a hosting account to browse your repositories")).toBeNull();
    expect(hostingListMyRepos).not.toHaveBeenCalled();
  });

  it("refetches the accounts on Dismiss and then lists the repositories", async () => {
    vi.mocked(hostingListAccounts).mockRejectedValueOnce({
      kind: "io",
      message: "keychain locked",
    });
    await renderBrowser({}, false);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByRole("button", { name: "Use octo/git-real" })).toBeInTheDocument();
    expect(hostingListAccounts).toHaveBeenCalledTimes(2);
  });
});

// Contract: one account lists its repositories with no account picker.
describe("RepoBrowser with one account", () => {
  it("does not show an Account picker", async () => {
    await renderBrowser();
    expect(screen.queryByLabelText("Account")).not.toBeInTheDocument();
  });

  it("requests page 1 of the account's repositories with an empty query", async () => {
    await renderBrowser();
    expect(hostingListMyRepos).toHaveBeenCalledExactlyOnceWith(OCTO, "", 1);
  });

  it("shows Loading repositories… before the list arrives", async () => {
    vi.mocked(hostingListMyRepos).mockReturnValue(new Promise(() => undefined));
    await renderBrowser({}, false);
    expect(await screen.findByText("Loading repositories…")).toBeInTheDocument();
  });

  it("labels the search field Search repositories with the placeholder Type to search", async () => {
    await renderBrowser();
    expect(search()).toHaveAttribute("placeholder", "Type to search");
  });

  it("lists one row per repository in order", async () => {
    await renderBrowser();
    expect(
      screen.getAllByRole("button", { name: /^Use / }).map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Use octo/git-real", "Use octo/other"]);
  });

  it("shows the name, owner and description of a repository", async () => {
    await renderBrowser();
    const [first] = screen.getAllByRole("listitem");
    const row = within(first as HTMLElement);
    expect(row.getByText("git-real")).toBeInTheDocument();
    expect(row.getByText("octo")).toBeInTheDocument();
    expect(row.getByText("A lightweight Git client")).toBeInTheDocument();
  });

  it("shows a Private badge only on private repositories", async () => {
    await renderBrowser();
    const [first, second] = screen.getAllByRole("listitem");
    expect(within(first as HTMLElement).queryByText("Private")).not.toBeInTheDocument();
    expect(within(second as HTMLElement).getByText("Private")).toBeInTheDocument();
  });

  it("shows no description text for a repository without one", async () => {
    vi.mocked(hostingListMyRepos).mockResolvedValue(
      hostedRepoPage([hostedRepo({ description: null })]),
    );
    await renderBrowser();
    expect(screen.queryByText("null")).not.toBeInTheDocument();
    expect(screen.queryByText("A lightweight Git client")).not.toBeInTheDocument();
  });

  it("renders the description as text, not markup", async () => {
    vi.mocked(hostingListMyRepos).mockResolvedValue(
      hostedRepoPage([hostedRepo({ description: "<b>bold</b>" })]),
    );
    await renderBrowser();
    expect(screen.getByText("<b>bold</b>")).toBeInTheDocument();
  });

  // Review Focus 5 / R7: the relative time uses the shared helper and the full date is the title.
  it("shows Updated with a relative time", async () => {
    const threeHoursAgo = Math.floor(Date.now() / 1000) - 3 * 3600;
    vi.mocked(hostingListMyRepos).mockResolvedValue(
      hostedRepoPage([hostedRepo({ updatedAt: threeHoursAgo })]),
    );
    await renderBrowser();
    expect(screen.getByText("Updated 3 hours ago")).toBeInTheDocument();
  });

  it("puts the full date in the title of the updated time", async () => {
    await renderBrowser();
    expect(screen.getAllByTitle(fullDate(1792497600)).length).toBeGreaterThan(0);
  });

  it("shows No repositories for an empty list and a blank query", async () => {
    vi.mocked(hostingListMyRepos).mockResolvedValue(hostedRepoPage([]));
    await renderBrowser({}, false);
    expect(await screen.findByText("No repositories")).toBeInTheDocument();
  });

  it("shows No repositories match for an empty list and a typed query", async () => {
    await renderBrowser();
    vi.mocked(hostingListMyRepos).mockResolvedValue(hostedRepoPage([]));
    type("zzz");
    await wait(300);
    expect(await screen.findByText("No repositories match")).toBeInTheDocument();
  });
});

// Contract: two or more accounts add an Account picker; the first is selected, switching re-queries.
describe("RepoBrowser with two accounts", () => {
  beforeEach(() => {
    vi.mocked(hostingListAccounts).mockResolvedValue([
      hostingAccount(),
      hostingAccount({
        id: LAB,
        provider: "gitlab",
        host: "gitlab.example.com",
        username: "octo2",
      }),
    ]);
  });

  it("shows an Account picker with username on host options", async () => {
    await renderBrowser();
    const picker = screen.getByLabelText("Account");
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["octo on github.com", "octo2 on gitlab.example.com"]);
  });

  it("selects the first account and queries it", async () => {
    await renderBrowser();
    expect(screen.getByLabelText("Account")).toHaveValue(OCTO);
    expect(hostingListMyRepos).toHaveBeenCalledExactlyOnceWith(OCTO, "", 1);
  });

  it("queries the other account when it is chosen", async () => {
    await renderBrowser();
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: LAB } });
    await waitFor(() => expect(hostingListMyRepos).toHaveBeenLastCalledWith(LAB, "", 1));
  });

  it("falls back to the first account when the selected one disappears", async () => {
    const { queryClient } = await renderBrowser();
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: LAB } });
    await waitFor(() => expect(hostingListMyRepos).toHaveBeenLastCalledWith(LAB, "", 1));
    vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount()]);
    await act(() => queryClient.invalidateQueries({ queryKey: ["hosting"] }));
    await waitFor(() => expect(hostingListMyRepos).toHaveBeenLastCalledWith(OCTO, "", 1));
    expect(screen.queryByLabelText("Account")).not.toBeInTheDocument();
  });
});

// Contract (fix 5): the selected account is a prop; the picker only reports a choice.
describe("RepoBrowser controlled account", () => {
  beforeEach(() => {
    vi.mocked(hostingListAccounts).mockResolvedValue([
      hostingAccount(),
      hostingAccount({
        id: LAB,
        provider: "gitlab",
        host: "gitlab.example.com",
        username: "octo2",
      }),
    ]);
  });

  it("selects and queries the account named by selectedAccountId", async () => {
    await renderBrowser({ selectedAccountId: LAB });
    expect(screen.getByLabelText("Account")).toHaveValue(LAB);
    expect(hostingListMyRepos).toHaveBeenCalledExactlyOnceWith(LAB, "", 1);
  });

  it("falls back to the first account when selectedAccountId is null", async () => {
    await renderBrowser({ selectedAccountId: null });
    expect(screen.getByLabelText("Account")).toHaveValue(OCTO);
  });

  it("falls back to the first account when selectedAccountId matches no account", async () => {
    await renderBrowser({ selectedAccountId: "gitlab:gone.example.com:nobody" });
    expect(screen.getByLabelText("Account")).toHaveValue(OCTO);
    expect(hostingListMyRepos).toHaveBeenCalledExactlyOnceWith(OCTO, "", 1);
  });

  it("calls onSelectAccount with the chosen account id", async () => {
    const { onSelectAccount } = await renderBrowser();
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: LAB } });
    expect(onSelectAccount).toHaveBeenCalledExactlyOnceWith(LAB);
  });

  it("does not call onSelectAccount on mount or when nothing is chosen", async () => {
    const { onSelectAccount } = await renderBrowser();
    expect(onSelectAccount).not.toHaveBeenCalled();
  });

  it("keeps showing the prop's account until the parent changes it", async () => {
    const onSelectAccount = vi.fn();
    renderWithProviders(
      <RepoBrowser
        selectedAccountId={OCTO}
        onSelectAccount={onSelectAccount}
        onPick={vi.fn()}
        onManageAccounts={vi.fn()}
        disabled={false}
      />,
    );
    await screen.findByRole("button", { name: "Use octo/git-real" });
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: LAB } });
    expect(onSelectAccount).toHaveBeenCalledExactlyOnceWith(LAB);
    expect(screen.getByLabelText("Account")).toHaveValue(OCTO);
    expect(requestedAccounts()).not.toContain(LAB);
  });
});

// Contract: typing is debounced 300 ms and requests the trimmed query.
describe("RepoBrowser search", () => {
  it("does not request at 299 ms and requests exactly once at 300 ms", async () => {
    await renderBrowser();
    freezeClock();
    type("git");
    await wait(299);
    expect(hostingListMyRepos).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(hostingListMyRepos).toHaveBeenCalledTimes(2);
    expect(hostingListMyRepos).toHaveBeenLastCalledWith(OCTO, "git", 1);
  });

  it("requests once after the debounce with the trimmed query", async () => {
    await renderBrowser();
    freezeClock();
    type("  git  ");
    await wait(300);
    expect(hostingListMyRepos).toHaveBeenLastCalledWith(OCTO, "git", 1);
    expect(hostingListMyRepos).toHaveBeenCalledTimes(2);
  });

  it("requests once for rapid typing, 300 ms after the last keystroke", async () => {
    await renderBrowser();
    freezeClock();
    type("g");
    await wait(100);
    type("gi");
    await wait(100);
    type("git");
    await wait(299);
    expect(hostingListMyRepos).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(hostingListMyRepos).toHaveBeenLastCalledWith(OCTO, "git", 1);
    expect(hostingListMyRepos).toHaveBeenCalledTimes(2);
  });

  it("does not request again for a whitespace-only query", async () => {
    await renderBrowser();
    type("   ");
    await wait(300);
    expect(hostingListMyRepos).toHaveBeenCalledTimes(1);
  });

  it("shows the matching repositories after the debounce", async () => {
    await renderBrowser();
    type("found");
    await wait(300);
    expect(await screen.findByRole("button", { name: "Use octo/found" })).toBeInTheDocument();
  });

  it("returns to the full list when the query is cleared", async () => {
    await renderBrowser();
    type("found");
    await wait(300);
    await screen.findByRole("button", { name: "Use octo/found" });
    type("");
    await wait(300);
    expect(await screen.findByRole("button", { name: "Use octo/git-real" })).toBeInTheDocument();
  });

  // R6: the browser sits inside the clone form, so Enter must not submit it.
  it("prevents the default of Enter in the search field", async () => {
    await renderBrowser();
    expect(fireEvent.keyDown(search(), { key: "Enter" })).toBe(false);
  });

  it("leaves other keys in the search field alone", async () => {
    await renderBrowser();
    expect(fireEvent.keyDown(search(), { key: "a" })).toBe(true);
  });

  it("makes every button a non-submit button", async () => {
    vi.mocked(hostingListMyRepos).mockResolvedValue(hostedRepoPage(hostedRepos(50)));
    await renderBrowser({}, false);
    await screen.findByRole("button", { name: "Show more" });
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(1);
    expect(buttons.map((b) => b.getAttribute("type"))).toEqual(buttons.map(() => "button"));
  });
});

// Contract (fix 6): Escape in a non-empty search field clears it and goes no further, so a dialog
// around the browser stays open; in an empty field it bubbles on as before.
describe("RepoBrowser search Escape", () => {
  const renderInsideParent = async () => {
    const parentKey = vi.fn();
    renderWithProviders(
      <div onKeyDown={parentKey}>
        <RepoBrowser
          selectedAccountId={null}
          onSelectAccount={vi.fn()}
          onPick={vi.fn()}
          onManageAccounts={vi.fn()}
          disabled={false}
        />
      </div>,
    );
    await screen.findByRole("button", { name: "Use octo/git-real" });
    return parentKey;
  };

  it("empties the field on Escape", async () => {
    await renderBrowser();
    type("found");
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(search()).toHaveValue("");
  });

  it("does not let Escape reach the parent while the field has text", async () => {
    const parentKey = await renderInsideParent();
    type("found");
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(parentKey).not.toHaveBeenCalled();
  });

  it("lets Escape reach the parent when the field is empty", async () => {
    const parentKey = await renderInsideParent();
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(parentKey).toHaveBeenCalledTimes(1);
  });

  it("lets a second Escape reach the parent after the first cleared the field", async () => {
    const parentKey = await renderInsideParent();
    type("found");
    fireEvent.keyDown(search(), { key: "Escape" });
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(parentKey).toHaveBeenCalledTimes(1);
  });

  it("does not stop other keys while the field has text", async () => {
    const parentKey = await renderInsideParent();
    type("found");
    fireEvent.keyDown(search(), { key: "a" });
    expect(parentKey).toHaveBeenCalledTimes(1);
  });

  it("returns to the full list after Escape clears a debounced search", async () => {
    await renderBrowser();
    type("found");
    await wait(300);
    await screen.findByRole("button", { name: "Use octo/found" });
    fireEvent.keyDown(search(), { key: "Escape" });
    await wait(300);
    expect(await screen.findByRole("button", { name: "Use octo/git-real" })).toBeInTheDocument();
    expect(hostingListMyRepos).toHaveBeenLastCalledWith(OCTO, "", 1);
  });

  it("treats a whitespace-only field as text and clears it", async () => {
    const parentKey = await renderInsideParent();
    type("   ");
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(search()).toHaveValue("");
    expect(parentKey).not.toHaveBeenCalled();
  });

  // An Escape that cancels an IME composition belongs to the composition: it must not clear the
  // field, and it is not stopped here.
  it("keeps the text on an Escape that cancels an IME composition", async () => {
    const parentKey = await renderInsideParent();
    type("found");
    fireEvent.keyDown(search(), { key: "Escape", isComposing: true });
    expect(search()).toHaveValue("found");
    expect(parentKey).toHaveBeenCalledTimes(1);
  });

  it("keeps the text on an Escape with keyCode 229 (WebKit after a composition)", async () => {
    const parentKey = await renderInsideParent();
    type("found");
    fireEvent.keyDown(search(), { key: "Escape", keyCode: 229 });
    expect(search()).toHaveValue("found");
    expect(parentKey).toHaveBeenCalledTimes(1);
  });

  it("still prevents Enter during an IME composition so the clone form is not submitted", async () => {
    await renderBrowser();
    type("found");
    expect(fireEvent.keyDown(search(), { key: "Enter", isComposing: true })).toBe(false);
  });
});

// Contract: 50 per page; Show more loads the next page and keeps the loaded ones.
describe("RepoBrowser paging", () => {
  it("shows Show more after a full page", async () => {
    vi.mocked(hostingListMyRepos).mockResolvedValue(hostedRepoPage(hostedRepos(50)));
    await renderBrowser({}, false);
    expect(await screen.findByRole("button", { name: "Show more" })).toBeInTheDocument();
  });

  // Fix 1: the wire page's hasMore, not the row count, decides whether Show more is offered.
  it("shows Show more after a short page whose wire hasMore is true", async () => {
    vi.mocked(hostingListMyRepos).mockResolvedValue(hostedRepoPage(hostedRepos(49), true));
    await renderBrowser({}, false);
    expect(await screen.findByRole("button", { name: "Show more" })).toBeInTheDocument();
  });

  it("shows no Show more after a page of 50 whose wire hasMore is false", async () => {
    vi.mocked(hostingListMyRepos).mockResolvedValue(hostedRepoPage(hostedRepos(50), false));
    await renderBrowser({}, false);
    await screen.findByRole("button", { name: "Use octo/repo-0" });
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("shows the empty text and Show more when page 1 is empty but the wire says hasMore", async () => {
    vi.mocked(hostingListMyRepos)
      .mockResolvedValueOnce(hostedRepoPage([], true))
      .mockResolvedValueOnce(hostedRepoPage(hostedRepos(1)));
    await renderBrowser({}, false);
    expect(await screen.findByText("No repositories")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(hostingListMyRepos).toHaveBeenLastCalledWith(OCTO, "", 2));
    expect(await screen.findByRole("button", { name: "Use octo/repo-0" })).toBeInTheDocument();
  });

  it("shows no Show more after a short page", async () => {
    await renderBrowser();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("loads page 2 on Show more and shows Loading… meanwhile", async () => {
    vi.mocked(hostingListMyRepos)
      .mockResolvedValueOnce(hostedRepoPage(hostedRepos(50)))
      .mockReturnValueOnce(new Promise(() => undefined));
    await renderBrowser({}, false);
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(hostingListMyRepos).toHaveBeenLastCalledWith(OCTO, "", 2);
    expect(await screen.findByRole("button", { name: "Loading…" })).toBeInTheDocument();
  });

  it("appends page 2 to the list", async () => {
    vi.mocked(hostingListMyRepos)
      .mockResolvedValueOnce(hostedRepoPage(hostedRepos(50)))
      .mockResolvedValueOnce(hostedRepoPage(hostedRepos(2, 50)));
    await renderBrowser({}, false);
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("button", { name: "Use octo/repo-51" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(52);
  });

  it("keeps the loaded list when Show more fails", async () => {
    vi.mocked(hostingListMyRepos)
      .mockResolvedValueOnce(hostedRepoPage(hostedRepos(50)))
      .mockRejectedValueOnce(hostingError("hostingUnreachable"));
    await renderBrowser({}, false);
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
  });
});

// Contract: a row picks its repository for the parent; HTTPS/SSH is a persisted preference.
describe("RepoBrowser picking", () => {
  it("calls onPick with the repository when a row is used", async () => {
    const { onPick } = await renderBrowser();
    fireEvent.click(use("octo/git-real"));
    expect(onPick).toHaveBeenCalledExactlyOnceWith(hostedRepo());
  });

  it("calls onPick with the repository that was clicked, not the first", async () => {
    const { onPick } = await renderBrowser();
    fireEvent.click(use("octo/other"));
    expect(onPick).toHaveBeenCalledExactlyOnceWith(
      hostedRepo({ fullName: "octo/other", name: "other", private: true }),
    );
  });

  it("does not call onPick before a row is used", async () => {
    const { onPick } = await renderBrowser();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("names the Clone with radiogroup and offers HTTPS and SSH", async () => {
    await renderBrowser();
    const group = screen.getByRole("radiogroup", { name: "Clone with" });
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    expect(within(group).getByRole("radio", { name: "HTTPS" })).toBeInTheDocument();
    expect(within(group).getByRole("radio", { name: "SSH" })).toBeInTheDocument();
  });

  it("selects HTTPS by default", async () => {
    await renderBrowser();
    expect(radio("HTTPS")).toBeChecked();
    expect(radio("SSH")).not.toBeChecked();
  });

  it("stores ssh in the preference when SSH is chosen", async () => {
    await renderBrowser();
    fireEvent.click(radio("SSH"));
    expect(useLayoutPrefs.getState().cloneUrlForm).toBe("ssh");
  });

  it("stores https again when HTTPS is chosen after SSH", async () => {
    await renderBrowser();
    fireEvent.click(radio("SSH"));
    fireEvent.click(radio("HTTPS"));
    expect(useLayoutPrefs.getState().cloneUrlForm).toBe("https");
  });

  it("shows SSH selected when the stored preference is ssh", async () => {
    useLayoutPrefs.setState({ cloneUrlForm: "ssh" });
    await renderBrowser();
    expect(radio("SSH")).toBeChecked();
  });

  it("does not call onPick when the radios change", async () => {
    const { onPick } = await renderBrowser();
    fireEvent.click(radio("SSH"));
    expect(onPick).not.toHaveBeenCalled();
  });
});

const requestedAccounts = () => vi.mocked(hostingListMyRepos).mock.calls.map((c) => c[0]);

// Review Focus 4: a reconnect-needing account makes no provider call and shows the notice.
describe("RepoBrowser reconnect", () => {
  it("shows the reconnect notice without requesting repositories", async () => {
    vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount({ needsReconnect: true })]);
    await renderBrowser({}, false);
    expect(await screen.findByText("Token expired or revoked — reconnect")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(hostingListMyRepos).not.toHaveBeenCalled();
  });

  it("asks the parent to open the accounts dialog preset to the account's provider and host", async () => {
    vi.mocked(hostingListAccounts).mockResolvedValue([
      hostingAccount({ provider: "gitlab", host: "gitlab.example.com", needsReconnect: true }),
    ]);
    const { onManageAccounts } = await renderBrowser({}, false);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    expect(onManageAccounts).toHaveBeenCalledExactlyOnceWith({
      provider: "gitlab",
      host: "gitlab.example.com",
    });
  });

  it("shows the reconnect notice when the list answers hostingAuth", async () => {
    vi.mocked(hostingListMyRepos).mockRejectedValue(hostingError("hostingAuth"));
    await renderBrowser({}, false);
    expect(await screen.findByText("Token expired or revoked — reconnect")).toBeInTheDocument();
  });

  it("does not show the reconnect notice for a healthy account", async () => {
    await renderBrowser();
    expect(screen.queryByText("Token expired or revoked — reconnect")).not.toBeInTheDocument();
  });

  it("makes no call for a second account that needs a reconnect", async () => {
    vi.mocked(hostingListAccounts).mockResolvedValue([
      hostingAccount(),
      hostingAccount({
        id: LAB,
        provider: "gitlab",
        host: "gitlab.example.com",
        username: "octo2",
        needsReconnect: true,
      }),
    ]);
    await renderBrowser();
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: LAB } });
    expect(await screen.findByText("Token expired or revoked — reconnect")).toBeInTheDocument();
    expect(requestedAccounts()).not.toContain(LAB);
  });
});

// Contract: provider failures show their hosting copy in an alert whose Dismiss retries.
describe("RepoBrowser errors", () => {
  it("shows the hosting copy for a rate limit", async () => {
    vi.mocked(hostingListMyRepos).mockRejectedValue(hostingError("hostingRateLimited"));
    await renderBrowser({}, false);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "GitHub rate limit reached. Try again in a few minutes.",
    );
  });

  it("names the selected account's provider in the copy", async () => {
    vi.mocked(hostingListAccounts).mockResolvedValue([
      hostingAccount({ id: LAB, provider: "gitlab", host: "gitlab.com", username: "octo2" }),
    ]);
    vi.mocked(hostingListMyRepos).mockRejectedValue(hostingError("hostingUnreachable"));
    await renderBrowser({}, false);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't reach GitLab. Check your connection.",
    );
  });

  it("refetches on Dismiss", async () => {
    vi.mocked(hostingListMyRepos).mockRejectedValueOnce(hostingError("hostingUnreachable"));
    await renderBrowser({}, false);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByRole("button", { name: "Use octo/git-real" })).toBeInTheDocument();
    expect(hostingListMyRepos).toHaveBeenCalledTimes(2);
  });

  it("shows no alert when the list loads", async () => {
    await renderBrowser();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

// Contract: disabled (while cloning) disables the search, the radios and every row button.
describe("RepoBrowser disabled", () => {
  it("disables the search, radios and row buttons", async () => {
    await renderBrowser({ disabled: true });
    expect(search()).toBeDisabled();
    expect(radio("HTTPS")).toBeDisabled();
    expect(radio("SSH")).toBeDisabled();
    expect(use("octo/git-real")).toBeDisabled();
    expect(use("octo/other")).toBeDisabled();
  });

  it("enables them when not disabled", async () => {
    await renderBrowser();
    expect(search()).toBeEnabled();
    expect(radio("SSH")).toBeEnabled();
    expect(use("octo/git-real")).toBeEnabled();
  });

  it("does not call onPick for a disabled row", async () => {
    const { onPick } = await renderBrowser({ disabled: true });
    fireEvent.click(use("octo/git-real"));
    expect(onPick).not.toHaveBeenCalled();
  });
});
