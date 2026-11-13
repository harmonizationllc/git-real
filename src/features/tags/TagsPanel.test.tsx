import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyText,
  createTag,
  deleteRemoteTag,
  deleteTag,
  listBranches,
  listTags,
  pushTag,
  updateSettings,
} from "../../lib/ipc";
import type { BranchList, TagList } from "../../lib/ipc";
import { useSettings } from "../../lib/store/settings";
import { useMessages } from "../../lib/store/messages";
import { useToasts } from "../../lib/store/toasts";
import { resetSettings, seedSettings } from "../../test/settingsStore";
import { useWorkspace } from "../../lib/store/workspace";
import { oidOf, shortOf } from "../../test/graphFixtures";
import { authError, networkError } from "../../test/remoteFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { tagEntry, tagList } from "../../test/tagFixtures";
import { TagsPanel } from "./TagsPanel";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  updateSettings: vi.fn(),
  listTags: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  pushTag: vi.fn(),
  deleteRemoteTag: vi.fn(),
  listBranches: vi.fn(),
  copyText: vi.fn(),
}));

const threeTags = (over: Partial<TagList> = {}): TagList =>
  tagList({
    tags: [
      tagEntry("v2", { target: oidOf(2) }),
      tagEntry("v1", { annotated: true, subject: "Release 1", target: oidOf(1) }),
      tagEntry("beta"),
    ],
    ...over,
  });

const onMain = (): BranchList => ({
  head: { kind: "branch", name: "main" },
  local: [{ name: "main", oid: oidOf(0), isHead: true, tracking: null, worktree: null }],
  remotes: [],
});

beforeEach(async () => {
  vi.resetAllMocks();
  useToasts.setState({ toasts: [] });
  useMessages.setState({ messages: [], unread: false });
  await resetSettings();
  localStorage.clear();
  useWorkspace.setState({ refsFilter: {}, selectedCommit: {}, selectedStash: {} });
  await seedSettings({ layout: { tagsCollapsed: true } });
  vi.mocked(listTags).mockResolvedValue(threeTags());
  vi.mocked(listBranches).mockResolvedValue(onMain());
  vi.mocked(createTag).mockResolvedValue(undefined);
  vi.mocked(deleteTag).mockResolvedValue(undefined);
  vi.mocked(pushTag).mockResolvedValue(undefined);
  vi.mocked(deleteRemoteTag).mockResolvedValue(undefined);
  vi.mocked(copyText).mockResolvedValue(undefined);
});

/** Renders the panel; `expanded` sets the stored preference first and waits for the list. */
async function renderPanel(expanded = true) {
  if (expanded) await seedSettings({ layout: { tagsCollapsed: false } });
  const view = renderWithProviders(<TagsPanel repoId={1} />);
  if (expanded) await screen.findByRole("list", { name: "Tag list" });
  return view;
}

const toasts = () => useToasts.getState().toasts;
const toggle = () => screen.getByRole("button", { name: /^Tags/ });
const plus = () => screen.getByRole("button", { name: "Create tag…" });
const row = (name: string) => screen.getByText(name).closest("button") as HTMLButtonElement;
const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 10, clientY: 20 });
const menuItem = (name: string) => screen.getByRole("menuitem", { name });
const waitForBranches = () => waitFor(() => expect(plus()).toBeEnabled());

// Contract: a collapsible Tags section; collapsed by default, the preference is stored.
describe("TagsPanel collapse", () => {
  it("puts the heading row on the accent band", async () => {
    renderWithProviders(<TagsPanel repoId={1} />);
    await waitFor(() => expect(toggle()).toHaveTextContent("Tags (3)"));
    expect(
      screen.getByRole("heading", { name: /^Tags/ }).closest(".gr-section-header"),
    ).not.toBeNull();
  });

  it("should render a collapsed Tags (n) toggle with aria-expanded false and no list", async () => {
    renderWithProviders(<TagsPanel repoId={1} />);
    await waitFor(() => expect(toggle()).toHaveTextContent("Tags (3)"));
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Tag list" })).toBeNull();
  });

  it("clicking the toggle expands the list and stores tagsCollapsed false", async () => {
    const { user } = await renderPanel(false);
    await user.click(toggle());
    expect(await screen.findByRole("list", { name: "Tag list" })).toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(useSettings.getState().settings.layout.tagsCollapsed).toBe(false);
  });

  it("clicking again collapses and stores true", async () => {
    const { user } = await renderPanel();
    await user.click(toggle());
    expect(screen.queryByRole("list", { name: "Tag list" })).toBeNull();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(useSettings.getState().settings.layout.tagsCollapsed).toBe(true);
  });

  it("sends the tagsCollapsed change to the backend once the save delay passes", async () => {
    await renderPanel(false);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(toggle());
      vi.advanceTimersByTime(300);
    } finally {
      vi.useRealTimers();
    }
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ layout: { tagsCollapsed: false } });
  });

  it("should start expanded when the stored preference is expanded", async () => {
    await renderPanel();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("should label the region by the heading", async () => {
    await renderPanel();
    expect(screen.getByRole("region", { name: "Tags (3)" })).toBeInTheDocument();
  });

  it("should not be busy when idle", async () => {
    await renderPanel();
    expect(screen.getByRole("region")).not.toHaveAttribute("aria-busy");
  });

  it("the heading is a programmatic focus target", async () => {
    await renderPanel();
    const heading = screen.getByRole("heading", { name: /^Tags/ });
    expect(heading).toHaveAttribute("data-focus-target");
    expect(heading).toHaveAttribute("tabindex", "-1");
  });
});

// Contract: loading, error, empty and populated states of the expanded list.
describe("TagsPanel list", () => {
  it("should show Loading tags… while expanded and loading", async () => {
    vi.mocked(listTags).mockReturnValue(new Promise(() => undefined));
    await renderPanel(false);
    await seedSettings({ layout: { tagsCollapsed: false } });
    expect(await screen.findByText("Loading tags…")).toBeInTheDocument();
  });

  it("should not show Loading tags… while collapsed", async () => {
    vi.mocked(listTags).mockReturnValue(new Promise(() => undefined));
    await renderPanel(false);
    expect(screen.queryByText("Loading tags…")).toBeNull();
  });

  it("shows the placeholder and a Retry toast on load failure", async () => {
    vi.mocked(listTags).mockRejectedValueOnce({ kind: "io", message: "list broke" });
    renderWithProviders(<TagsPanel repoId={1} />);
    await seedSettings({ layout: { tagsCollapsed: false } });
    expect(await screen.findByText("Couldn't load tags")).toBeInTheDocument();
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0].text).toBe("Couldn't load tags: list broke");
    expect(toasts()[0].action?.label).toBe("Retry");
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => toasts()[0].action?.run());
    expect(await screen.findByRole("list", { name: "Tag list" })).toBeInTheDocument();
  });

  it("neither toasts nor replaces the list when a refetch fails while a list shows", async () => {
    const { queryClient } = await renderPanel();
    vi.mocked(listTags).mockRejectedValue({ kind: "io", message: "later" });
    await act(() => queryClient.refetchQueries({ queryKey: ["repo", 1, "tags"] }));
    expect(screen.getByRole("list", { name: "Tag list" })).toBeInTheDocument();
    expect(toasts()).toEqual([]);
  });

  it("should show one row per tag in list order", async () => {
    await renderPanel();
    const items = within(screen.getByRole("list", { name: "Tag list" })).getAllByRole("listitem");
    expect(items.map((i) => within(i).getByRole("button").textContent)).toEqual([
      expect.stringMatching(/^v2/),
      expect.stringMatching(/^v1/),
      expect.stringMatching(/^beta/),
    ]);
  });

  it("should show No tags for an empty list", async () => {
    vi.mocked(listTags).mockResolvedValue(tagList());
    renderWithProviders(<TagsPanel repoId={1} />);
    await seedSettings({ layout: { tagsCollapsed: false } });
    expect(await screen.findByText("No tags")).toBeInTheDocument();
    expect(toggle()).toHaveTextContent("Tags (0)");
  });

  it("clicking a row selects its target commit and clears the selected stash", async () => {
    useWorkspace.setState({ selectedStash: { 1: "s".repeat(40) } });
    const { user } = await renderPanel();
    await user.click(row("v1"));
    expect(useWorkspace.getState().selectedCommit[1]).toBe(oidOf(1));
    expect(useWorkspace.getState().selectedStash[1]).toBeNull();
  });
});

// Contract: the shared filter narrows the list, forces it open and leaves the preference alone.
describe("TagsPanel filtering", () => {
  it("should show the matching tags while filtering even when collapsed, without changing the preference", async () => {
    useWorkspace.getState().setRefsFilter(1, "v1");
    renderWithProviders(<TagsPanel repoId={1} />);
    await screen.findByRole("list", { name: "Tag list" });
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(toggle()).toHaveTextContent("Tags (1 of 3)");
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(1);
    expect(useSettings.getState().settings.layout.tagsCollapsed).toBe(true);
  });

  it("should flip the stored preference when toggled while filtering", async () => {
    useWorkspace.getState().setRefsFilter(1, "v1");
    const { user } = renderWithProviders(<TagsPanel repoId={1} />);
    await screen.findByRole("list", { name: "Tag list" });
    await user.click(toggle());
    expect(useSettings.getState().settings.layout.tagsCollapsed).toBe(false);
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("should apply the flipped preference once the filter is cleared", async () => {
    useWorkspace.getState().setRefsFilter(1, "v1");
    const { user } = renderWithProviders(<TagsPanel repoId={1} />);
    await screen.findByRole("list", { name: "Tag list" });
    await user.click(toggle());
    await user.click(toggle());
    expect(useSettings.getState().settings.layout.tagsCollapsed).toBe(true);
    useWorkspace.getState().setRefsFilter(1, "");
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-expanded", "false"));
  });

  it("should show No matches when the filter hits nothing", async () => {
    useWorkspace.getState().setRefsFilter(1, "zzz");
    renderWithProviders(<TagsPanel repoId={1} />);
    expect(await screen.findByText("No matches")).toBeInTheDocument();
    expect(toggle()).toHaveTextContent("Tags (0 of 3)");
  });

  it("should not treat a whitespace-only filter as filtering", async () => {
    useWorkspace.getState().setRefsFilter(1, "   ");
    renderWithProviders(<TagsPanel repoId={1} />);
    await waitFor(() => expect(toggle()).toHaveTextContent("Tags (3)"));
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Tag list" })).toBeNull();
  });

  it("should use the filter text of its own repo only", async () => {
    useWorkspace.getState().setRefsFilter(2, "v1");
    renderWithProviders(<TagsPanel repoId={1} />);
    await waitFor(() => expect(toggle()).toHaveTextContent("Tags (3)"));
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });
});

// Contract: the + button creates a tag on HEAD's commit, gated by what is known about HEAD.
describe("TagsPanel + button", () => {
  it("is named Create tag… and opens the dialog for HEAD's commit", async () => {
    const { user } = await renderPanel();
    await waitForBranches();
    await user.click(plus());
    expect(
      await screen.findByRole("dialog", { name: `Create tag on ${shortOf(oidOf(0))}` }),
    ).toBeInTheDocument();
  });

  it("shows the label + and the title Create tag…", async () => {
    await renderPanel();
    await waitForBranches();
    expect(plus()).toHaveTextContent("+");
    expect(plus()).toHaveAttribute("title", "Create tag…");
  });

  it("tags a detached HEAD's oid", async () => {
    vi.mocked(listBranches).mockResolvedValue({
      head: { kind: "detached", oid: oidOf(7) },
      local: [],
      remotes: [],
    });
    const { user } = await renderPanel();
    await waitForBranches();
    await user.click(plus());
    expect(
      await screen.findByRole("dialog", { name: `Create tag on ${shortOf(oidOf(7))}` }),
    ).toBeInTheDocument();
  });

  it("is disabled with Make a commit first on an unborn HEAD", async () => {
    vi.mocked(listBranches).mockResolvedValue({
      head: { kind: "unborn", name: "main" },
      local: [],
      remotes: [],
    });
    await renderPanel();
    await waitFor(() => expect(plus()).toHaveAttribute("title", "Make a commit first"));
    expect(plus()).toBeDisabled();
  });

  it("is disabled without a title while the branches load", async () => {
    vi.mocked(listBranches).mockReturnValue(new Promise(() => undefined));
    await renderPanel();
    expect(plus()).toBeDisabled();
    expect(plus()).not.toHaveAttribute("title");
  });

  it("is disabled while a tag action runs", async () => {
    vi.mocked(pushTag).mockReturnValue(new Promise(() => undefined));
    const { user } = await renderPanel();
    await waitForBranches();
    rightClick(row("v1"));
    await user.click(menuItem("Push to origin"));
    await waitFor(() => expect(plus()).toBeDisabled());
  });

  it("closes the dialog on Cancel and returns focus to the heading when the opener is disabled", async () => {
    const { user } = await renderPanel();
    await waitForBranches();
    await user.click(plus());
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("creates the tag through the dialog and refreshes the list", async () => {
    const { user } = await renderPanel();
    await waitForBranches();
    await user.click(plus());
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "v9");
    await user.click(screen.getByRole("checkbox", { name: "Annotated" }));
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(createTag).toHaveBeenCalledExactlyOnceWith(1, "v9", oidOf(0), null);
    await waitFor(() => expect(listTags).toHaveBeenCalledTimes(2));
  });
});

// Contract: the row menu offers Copy name, per-remote push and remote delete, then Delete tag….
describe("TagsPanel context menu", () => {
  it("lists Copy name, Push to and Delete from per remote, then Delete tag…", async () => {
    vi.mocked(listTags).mockResolvedValue(threeTags({ remotes: ["origin", "upstream"] }));
    await renderPanel();
    rightClick(row("v1"));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Copy name",
      "Push to origin",
      "Push to upstream",
      "Delete from origin…",
      "Delete from upstream…",
      "Delete tag…",
    ]);
  });

  it("with no remotes shows the remote items once, disabled with No remotes configured", async () => {
    vi.mocked(listTags).mockResolvedValue(threeTags({ remotes: [] }));
    await renderPanel();
    rightClick(row("v1"));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Copy name",
      "Push to remote",
      "Delete from remote…",
      "Delete tag…",
    ]);
    for (const name of ["Push to remote", "Delete from remote…"]) {
      expect(menuItem(name)).toBeDisabled();
      expect(menuItem(name)).toHaveAttribute("title", "No remotes configured");
    }
  });

  it("opens with Shift+F10 and returns focus to the row on Escape", async () => {
    const { user } = await renderPanel();
    row("v1").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(row("v1")).toHaveFocus();
  });

  it("acts on the right-clicked tag", async () => {
    const { user } = await renderPanel();
    rightClick(row("beta"));
    await user.click(menuItem("Push to origin"));
    expect(pushTag).toHaveBeenCalledExactlyOnceWith(1, "origin", "beta", null);
  });

  it("disables the remote and delete items while an action runs but not Copy name", async () => {
    vi.mocked(pushTag).mockReturnValue(new Promise(() => undefined));
    const { user } = await renderPanel();
    rightClick(row("v1"));
    await user.click(menuItem("Push to origin"));
    await waitFor(() => expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "true"));
    rightClick(row("v2"));
    expect(menuItem("Push to origin")).toBeDisabled();
    expect(menuItem("Delete from origin…")).toBeDisabled();
    expect(menuItem("Delete tag…")).toBeDisabled();
    expect(menuItem("Copy name")).toBeEnabled();
  });
});

describe("TagsPanel copy", () => {
  it("Copy name copies the tag name", async () => {
    const { user } = await renderPanel();
    rightClick(row("v1"));
    await user.click(menuItem("Copy name"));
    expect(copyText).toHaveBeenCalledExactlyOnceWith("v1");
  });

  it("a failed copy toasts its error", async () => {
    vi.mocked(copyText).mockRejectedValue(new Error("clipboard denied"));
    const { user } = await renderPanel();
    rightClick(row("v1"));
    await user.click(menuItem("Copy name"));
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({ text: "clipboard denied", variant: "error" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract: push and remote delete toast their success; both delete flavours confirm first.
describe("TagsPanel push and remote delete", () => {
  it("Push to origin calls pushTag and toasts Pushed v1 to origin.", async () => {
    const { user } = await renderPanel();
    rightClick(row("v1"));
    await user.click(menuItem("Push to origin"));
    expect(pushTag).toHaveBeenCalledExactlyOnceWith(1, "origin", "v1", null);
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({ text: "Pushed v1 to origin.", variant: "success" });
  });

  async function askRemoteDelete() {
    const view = await renderPanel();
    rightClick(row("v1"));
    await view.user.click(menuItem("Delete from origin…"));
    return view;
  }

  it("Delete from origin… confirms with the body text", async () => {
    await askRemoteDelete();
    const dialog = await screen.findByRole("dialog", { name: "Delete tag v1 from origin?" });
    expect(dialog).toHaveTextContent("Others who already fetched it keep their copy.");
  });

  it("confirming calls deleteRemoteTag and toasts Deleted v1 from origin.", async () => {
    const { user } = await askRemoteDelete();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(deleteRemoteTag).toHaveBeenCalledExactlyOnceWith(1, "origin", "v1", null);
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({ text: "Deleted v1 from origin.", variant: "success" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Cancel calls nothing", async () => {
    const { user } = await askRemoteDelete();
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(deleteRemoteTag).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("TagsPanel delete", () => {
  async function askDelete() {
    const view = await renderPanel();
    rightClick(row("v1"));
    await view.user.click(menuItem("Delete tag…"));
    return view;
  }

  it("Delete tag… confirms with Delete tag v1? and the local-only body", async () => {
    await askDelete();
    const dialog = await screen.findByRole("dialog", { name: "Delete tag v1?" });
    expect(dialog).toHaveTextContent("The tag is removed from this repository only.");
  });

  it("confirming calls deleteTag and refreshes the list", async () => {
    const { user } = await askDelete();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(deleteTag).toHaveBeenCalledExactlyOnceWith(1, "v1");
    await waitFor(() => expect(listTags).toHaveBeenCalledTimes(2));
  });

  it("closes the confirm as soon as Delete is pressed, before the call settles", async () => {
    vi.mocked(deleteTag).mockReturnValue(new Promise(() => undefined));
    const { user } = await askDelete();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "true"));
  });

  it("Cancel calls nothing and returns focus to the heading", async () => {
    const { user } = await askDelete();
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(deleteTag).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: /^Tags/ })).toHaveFocus();
  });
});

// Contract: a failed action toasts from the resolved result, with the mapped copy.
describe("TagsPanel errors", () => {
  async function pushFrom(name = "v1") {
    const view = await renderPanel();
    rightClick(row(name));
    await view.user.click(menuItem("Push to origin"));
    return view;
  }

  it("toasts a failed push with git's output under Details", async () => {
    vi.mocked(pushTag).mockRejectedValue(networkError("other", {}, "remote rejected"));
    await pushFrom();
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0].text).toContain("git push failed");
    expect(toasts()[0].variant).toBe("error");
    expect(toasts()[0].details).toContain("remote rejected");
  });

  it("toasts a failed remote delete with git's output under Details", async () => {
    vi.mocked(deleteRemoteTag).mockRejectedValue(networkError("other", {}, "remote: denied"));
    const { user } = await renderPanel();
    rightClick(row("v1"));
    await user.click(menuItem("Delete from origin…"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0].text).toContain("git push failed");
    expect(toasts()[0].details).toContain("remote: denied");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("toasts the classified copy for an unreachable host", async () => {
    vi.mocked(pushTag).mockRejectedValue(networkError("hostUnreachable"));
    await pushFrom();
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0].text).toContain("Could not reach the remote");
  });

  it("toasts no success after a failed push", async () => {
    vi.mocked(pushTag).mockRejectedValue(networkError("other", {}, "remote rejected"));
    await pushFrom();
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts().some((t) => t.variant === "success")).toBe(false);
  });

  it("toasts a failed delete with the tag's copy and refetches the list", async () => {
    vi.mocked(deleteTag).mockRejectedValue({ kind: "tagNotFound", message: "no tag named v1" });
    const { user } = await renderPanel();
    rightClick(row("v1"));
    await user.click(menuItem("Delete tag…"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0].text).toBe("Tag v1 no longer exists; the list has been refreshed.");
    await waitFor(() => expect(listTags).toHaveBeenCalledTimes(2));
  });

  it("toasts remoteNotFound with the error's own message", async () => {
    vi.mocked(pushTag).mockRejectedValue({ kind: "remoteNotFound", message: "no remote origin" });
    await pushFrom();
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0].text).toBe("no remote origin");
  });

  it("renders no alert in the panel", async () => {
    vi.mocked(pushTag).mockRejectedValue(networkError("other", {}, "remote rejected"));
    await pushFrom();
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract: a push that needs sign-in opens the credential dialog and retries with what is entered.
describe("TagsPanel sign-in", () => {
  it("opens the credential dialog when a push needs sign-in", async () => {
    vi.mocked(pushTag).mockRejectedValueOnce(authError());
    const { user } = await renderPanel();
    rightClick(row("v1"));
    await user.click(menuItem("Push to origin"));
    expect(
      await screen.findByRole("dialog", { name: "Sign in to github.com" }),
    ).toBeInTheDocument();
  });

  it("retries the push with the entered credentials and toasts the success", async () => {
    vi.mocked(pushTag).mockRejectedValueOnce(authError()).mockResolvedValueOnce(undefined);
    const { user } = await renderPanel();
    rightClick(row("v1"));
    await user.click(menuItem("Push to origin"));
    await user.type(await screen.findByRole("textbox", { name: "Username" }), "me");
    await user.type(screen.getByLabelText("Token or password"), "tok");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({ text: "Pushed v1 to origin.", variant: "success" });
    expect(pushTag).toHaveBeenLastCalledWith(1, "origin", "v1", {
      origin: "https://github.com",
      username: "me",
      token: "tok",
    });
  });

  it("toasts nothing when the sign-in is cancelled", async () => {
    vi.mocked(pushTag).mockRejectedValueOnce(authError());
    const { user } = await renderPanel();
    rightClick(row("v1"));
    await user.click(menuItem("Push to origin"));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toasts()).toEqual([]);
  });

  it("opens the credential dialog when a remote delete needs sign-in", async () => {
    vi.mocked(deleteRemoteTag).mockRejectedValueOnce(authError());
    const { user } = await renderPanel();
    rightClick(row("v1"));
    await user.click(menuItem("Delete from origin…"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(
      await screen.findByRole("dialog", { name: "Sign in to github.com" }),
    ).toBeInTheDocument();
  });
});

// Contract: tags are grouped into collapsible folders by slash path, every folder open by default.
describe("TagsPanel folders", () => {
  const folderTags = (): TagList =>
    tagList({
      tags: [
        tagEntry("v2", { target: oidOf(2) }),
        tagEntry("release/v1.0", { target: oidOf(3) }),
        tagEntry("nightly/2026-11-01", { target: oidOf(4) }),
        tagEntry("release/v0.9", { target: oidOf(5) }),
        tagEntry("release/rc/v1.0-rc1", { target: oidOf(6) }),
        tagEntry("release-notes", { target: oidOf(7) }),
      ],
    });

  beforeEach(() => {
    vi.mocked(listTags).mockResolvedValue(folderTags());
  });

  const tagListEl = () => screen.getByRole("list", { name: "Tag list" });
  const expandedFolder = (name: string) => screen.queryByRole("button", { name, expanded: true });
  const folderButton = (name: string) => screen.getByRole("button", { name });
  /** The first button of each direct child of a list, as "folder:<text>" or "row:<text>". */
  const itemsOf = (list: HTMLElement) =>
    [...list.children].map((li) => {
      const button = li.querySelector("button") as HTMLButtonElement;
      const text = (button.textContent ?? "").trim();
      return button.hasAttribute("aria-expanded") ? `folder:${text}` : `row:${text}`;
    });
  const rowNamed = (name: string) => screen.getByText(name).closest("button") as HTMLButtonElement;

  it("should nest tags in folders by slash path, folders first, in backend order", async () => {
    await renderPanel();
    expect(expandedFolder("release")).toBeInTheDocument();
    expect(itemsOf(tagListEl())).toEqual([
      "folder:release",
      "folder:nightly",
      expect.stringMatching(/^row:v2/),
      expect.stringMatching(/^row:release-notes/),
    ]);
    const release = within(tagListEl()).getByRole("list", { name: "release tags" });
    expect(itemsOf(release)).toEqual([
      "folder:rc",
      expect.stringMatching(/^row:v1\.0/),
      expect.stringMatching(/^row:v0\.9/),
    ]);
    const rc = within(release).getByRole("list", { name: "release/rc tags" });
    expect(itemsOf(rc)).toEqual([expect.stringMatching(/^row:v1\.0-rc1/)]);
  });

  it("should start every folder expanded", async () => {
    await renderPanel();
    for (const name of ["release", "nightly", "rc"]) {
      expect(folderButton(name)).toHaveAttribute("aria-expanded", "true");
    }
  });

  it("should collapse a folder without changing the count or saving a setting", async () => {
    const { user } = await renderPanel();
    expect(expandedFolder("release")).toBeInTheDocument();
    vi.mocked(updateSettings).mockClear();
    await user.click(folderButton("release"));
    expect(screen.queryByRole("list", { name: "release tags" })).toBeNull();
    expect(folderButton("release")).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveTextContent("Tags (6)");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("should keep a collapsed folder collapsed through filtering and clearing the filter", async () => {
    const { user } = await renderPanel();
    expect(expandedFolder("release")).toBeInTheDocument();
    await user.click(folderButton("release"));
    act(() => useWorkspace.getState().setRefsFilter(1, "v1.0"));
    expect(folderButton("release")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("v1.0")).toBeNull();
    act(() => useWorkspace.getState().setRefsFilter(1, ""));
    expect(folderButton("release")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("v1.0")).toBeNull();
  });

  it("should render only the matching folder and its row when filtering", async () => {
    useWorkspace.getState().setRefsFilter(1, "nightly");
    renderWithProviders(<TagsPanel repoId={1} />);
    await screen.findByRole("list", { name: "Tag list" });
    expect(expandedFolder("nightly")).toBeInTheDocument();
    expect(tagListEl().children).toHaveLength(1);
    const nightly = within(tagListEl()).getByRole("list", { name: "nightly tags" });
    expect(nightly.children).toHaveLength(1);
    expect(within(nightly).getByText("2026-11-01")).toBeInTheDocument();
  });

  it("should select the target commit when a nested row is clicked", async () => {
    const { user } = await renderPanel();
    expect(expandedFolder("release")).toBeInTheDocument();
    await user.click(rowNamed("v1.0"));
    expect(useWorkspace.getState().selectedCommit[1]).toBe(oidOf(3));
  });

  it("should copy the full tag name from a nested row's menu", async () => {
    const { user } = await renderPanel();
    expect(expandedFolder("release")).toBeInTheDocument();
    rightClick(rowNamed("v1.0"));
    await user.click(menuItem("Copy name"));
    expect(copyText).toHaveBeenCalledExactlyOnceWith("release/v1.0");
  });

  it("should drop an emptied folder after its last tag is deleted", async () => {
    const { user } = await renderPanel();
    expect(expandedFolder("nightly")).toBeInTheDocument();
    rightClick(rowNamed("2026-11-01"));
    await user.click(menuItem("Delete tag…"));
    vi.mocked(listTags).mockResolvedValue(
      tagList({ tags: folderTags().tags.filter((t) => t.name !== "nightly/2026-11-01") }),
    );
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(deleteTag).toHaveBeenCalledExactlyOnceWith(1, "nightly/2026-11-01");
    await waitFor(() => expect(screen.queryByRole("button", { name: "nightly" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
