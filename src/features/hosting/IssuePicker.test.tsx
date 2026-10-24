import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostingListIssues, hostingRepoInfo } from "../../lib/ipc";
import type { HostingProvider } from "../../lib/ipc";
import { hostingError, issue, repoInfo } from "../../test/hostingFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { ISSUES_OFF_TEXT } from "./hostingCopy";
import { IssuePicker } from "./IssuePicker";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingRepoInfo: vi.fn(),
  hostingListIssues: vi.fn(),
}));

// The clock advances by itself so react-query and waitFor still settle; the debounce is driven
// with advanceTimersByTimeAsync. user-event hangs under fake timers, so events are fired directly.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.resetAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(hostingRepoInfo).mockResolvedValue(repoInfo());
  vi.mocked(hostingListIssues).mockImplementation((_id, query) =>
    Promise.resolve(query === "" ? [issue(7), issue(8), issue(9)] : [issue(3, { title: query })]),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderPicker(over: { provider?: HostingProvider } = {}, settle = true) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const view = renderWithProviders(
    <IssuePicker
      repoId={1}
      provider={over.provider ?? "github"}
      onPick={onPick}
      onClose={onClose}
    />,
  );
  if (settle) await screen.findAllByRole("option");
  return { onPick, onClose, ...view };
}

const input = () => screen.getByLabelText("Search issues");
const options = () => screen.getAllByRole("option").map((o) => o.textContent);
const press = (key: string) => fireEvent.keyDown(input(), { key });
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const activeOption = () =>
  document.getElementById(input().getAttribute("aria-activedescendant") ?? "missing");

// Contract: a non-modal popover dialog named Link issue with a focused search field and a listbox.
describe("IssuePicker rendering", () => {
  it("renders a dialog named Link issue", async () => {
    await renderPicker();
    expect(screen.getByRole("dialog", { name: "Link issue" })).toBeInTheDocument();
  });

  it("is not modal", async () => {
    await renderPicker();
    expect(screen.getByRole("dialog", { name: "Link issue" })).not.toHaveAttribute("aria-modal");
  });

  it("puts focus in the search field on open", async () => {
    await renderPicker({}, false);
    expect(input()).toHaveFocus();
  });

  it("labels the search field Search issues with the placeholder Type to search", async () => {
    await renderPicker({}, false);
    expect(input()).toHaveAttribute("placeholder", "Type to search");
  });

  it("lists the open issues as #n title options", async () => {
    await renderPicker();
    expect(options()).toEqual(["#7 Issue 7", "#8 Issue 8", "#9 Issue 9"]);
  });

  it("renders a listbox of the options", async () => {
    await renderPicker();
    const listbox = screen.getByRole("listbox");
    expect(listbox).toContainElement(screen.getAllByRole("option")[0] as HTMLElement);
  });

  it("renders the title as text, not markup", async () => {
    vi.mocked(hostingListIssues).mockResolvedValue([issue(1, { title: "<b>bold</b>" })]);
    await renderPicker();
    expect(screen.getByRole("option").querySelector("b")).toBeNull();
  });

  it("offers no Show more, even after a full first page", async () => {
    vi.mocked(hostingListIssues).mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => issue(100 - i)),
    );
    await renderPicker();
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });
});

// Contract (Review Focus 5): the first request is the plain list at open; typing waits for the debounce.
describe("IssuePicker requests", () => {
  it("requests the plain first page when it opens", async () => {
    await renderPicker();
    expect(hostingListIssues).toHaveBeenCalledExactlyOnceWith(1, "", 1);
  });

  it("does not request issues until the repository info answers", async () => {
    vi.mocked(hostingRepoInfo).mockReturnValue(new Promise(() => undefined));
    await renderPicker({}, false);
    await wait(500);
    expect(hostingListIssues).not.toHaveBeenCalled();
  });

  it("shows Searching… while the repository info loads", async () => {
    vi.mocked(hostingRepoInfo).mockReturnValue(new Promise(() => undefined));
    await renderPicker({}, false);
    expect(screen.getByText("Searching…")).toBeInTheDocument();
  });

  it("still asks for the issues when the repository info fails", async () => {
    vi.mocked(hostingRepoInfo).mockRejectedValue(hostingError("hostingNotFound"));
    await renderPicker();
    expect(hostingListIssues).toHaveBeenCalledWith(1, "", 1);
  });

  it("requests once after the debounce", async () => {
    await renderPicker();
    vi.mocked(hostingListIssues).mockClear();
    type("cra");
    await wait(100);
    type("cras");
    await wait(100);
    type("crash");
    await wait(299);
    expect(hostingListIssues).not.toHaveBeenCalled();
    await wait(1);
    await waitFor(() => expect(hostingListIssues).toHaveBeenCalledExactlyOnceWith(1, "crash", 1));
  });

  it("does not request on a keystroke before the debounce elapses", async () => {
    await renderPicker();
    vi.mocked(hostingListIssues).mockClear();
    type("c");
    await wait(250);
    expect(hostingListIssues).not.toHaveBeenCalled();
  });

  it("trims the query before asking", async () => {
    await renderPicker();
    vi.mocked(hostingListIssues).mockClear();
    type("  crash  ");
    await wait(300);
    await waitFor(() => expect(hostingListIssues).toHaveBeenCalledExactlyOnceWith(1, "crash", 1));
  });

  it("lists the matches once the debounced query answers", async () => {
    await renderPicker();
    type("crash");
    await wait(300);
    await waitFor(() => expect(options()).toEqual(["#3 crash"]));
  });

  it("keeps the previous list during the debounce window", async () => {
    await renderPicker();
    type("crash");
    await wait(100);
    expect(options()).toEqual(["#7 Issue 7", "#8 Issue 8", "#9 Issue 9"]);
  });
});

// Contract: click, Arrow keys and Enter pick; the active option is announced through the input.
describe("IssuePicker choosing", () => {
  it("calls onPick with the number of the clicked option", async () => {
    const { onPick } = await renderPicker();
    fireEvent.click(screen.getByRole("option", { name: /^#7/ }));
    expect(onPick).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("picks the first option on Enter", async () => {
    const { onPick } = await renderPicker();
    press("Enter");
    expect(onPick).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("picks the second option after ArrowDown and Enter", async () => {
    const { onPick } = await renderPicker();
    press("ArrowDown");
    press("Enter");
    expect(onPick).toHaveBeenCalledExactlyOnceWith(8);
  });

  it("moves back up with ArrowUp", async () => {
    const { onPick } = await renderPicker();
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowUp");
    press("Enter");
    expect(onPick).toHaveBeenCalledExactlyOnceWith(8);
  });

  it("stops at the last option without wrapping", async () => {
    const { onPick } = await renderPicker();
    for (let i = 0; i < 5; i++) press("ArrowDown");
    press("Enter");
    expect(onPick).toHaveBeenCalledExactlyOnceWith(9);
  });

  it("stops at the first option without wrapping", async () => {
    const { onPick } = await renderPicker();
    press("ArrowUp");
    press("Enter");
    expect(onPick).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("points aria-activedescendant at the first option initially", async () => {
    await renderPicker();
    expect(activeOption()).toBe(screen.getAllByRole("option")[0]);
  });

  it("moves aria-activedescendant with the arrows", async () => {
    await renderPicker();
    press("ArrowDown");
    expect(activeOption()).toBe(screen.getAllByRole("option")[1]);
  });

  it("marks only the active option selected", async () => {
    await renderPicker();
    press("ArrowDown");
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);
  });

  it("prevents the default of the navigation keys so the caret stays put", async () => {
    await renderPicker();
    expect(fireEvent.keyDown(input(), { key: "ArrowDown" })).toBe(false);
  });

  it("picks nothing on Enter when there are no options", async () => {
    vi.mocked(hostingListIssues).mockResolvedValue([]);
    const { onPick } = await renderPicker({}, false);
    await screen.findByText("No open issues match");
    press("Enter");
    expect(onPick).not.toHaveBeenCalled();
  });
});

// Contract: the popover must not linger (it would disable every RepoPane shortcut).
describe("IssuePicker closing", () => {
  it("calls onClose on Escape", async () => {
    const { onClose } = await renderPicker();
    press("Escape");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose on another key", async () => {
    const { onClose } = await renderPicker();
    press("a");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on a pointerdown outside the popover", async () => {
    const { onClose } = await renderPicker();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose on a pointerdown inside the popover", async () => {
    const { onClose } = await renderPicker();
    fireEvent.pointerDown(screen.getAllByRole("option")[0] as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when focus moves to an element outside the popover", async () => {
    const { onClose } = await renderPicker();
    const outside = document.body.appendChild(document.createElement("button"));
    fireEvent.focusOut(input(), { relatedTarget: outside });
    expect(onClose).toHaveBeenCalledOnce();
    outside.remove();
  });

  it("ignores a focusout without a related target, as when an option is clicked", async () => {
    const { onClose } = await renderPicker();
    fireEvent.focusOut(input(), { relatedTarget: null });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores focus moving to another element inside the popover", async () => {
    const { onClose } = await renderPicker();
    fireEvent.focusOut(input(), { relatedTarget: screen.getAllByRole("option")[0] });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stops listening for outside pointerdowns once unmounted", async () => {
    const { onClose, unmount } = await renderPicker();
    unmount();
    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns focus to the opener when it closes", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Opener
          </button>
          {open && (
            <IssuePicker
              repoId={1}
              provider="github"
              onPick={vi.fn()}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }
    renderWithProviders(<Harness />);
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("dialog", { name: "Link issue" });
    expect(input()).toHaveFocus();
    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });
});

// Contract: searching, empty, issues-off and error states.
describe("IssuePicker states", () => {
  it("shows Searching… while the issues load", async () => {
    vi.mocked(hostingListIssues).mockReturnValue(new Promise(() => undefined));
    await renderPicker({}, false);
    expect(await screen.findByText("Searching…")).toBeInTheDocument();
  });

  it("shows No open issues match for an empty answer", async () => {
    vi.mocked(hostingListIssues).mockResolvedValue([]);
    await renderPicker({}, false);
    expect(await screen.findByText("No open issues match")).toBeInTheDocument();
  });

  it("shows no options for an empty answer", async () => {
    vi.mocked(hostingListIssues).mockResolvedValue([]);
    await renderPicker({}, false);
    await screen.findByText("No open issues match");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("shows that issues are turned off when the repository has them disabled", async () => {
    vi.mocked(hostingRepoInfo).mockResolvedValue(repoInfo({ issuesEnabled: false }));
    await renderPicker({}, false);
    expect(await screen.findByText(ISSUES_OFF_TEXT)).toBeInTheDocument();
  });

  it("does not request issues when they are turned off", async () => {
    vi.mocked(hostingRepoInfo).mockResolvedValue(repoInfo({ issuesEnabled: false }));
    await renderPicker({}, false);
    await screen.findByText(ISSUES_OFF_TEXT);
    type("crash");
    await wait(500);
    expect(hostingListIssues).not.toHaveBeenCalled();
  });

  it("shows a hosting error in its provider copy", async () => {
    vi.mocked(hostingListIssues).mockRejectedValue(hostingError("hostingNotFound"));
    await renderPicker({}, false);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This repository isn't visible to your GitHub account.",
    );
  });

  it("names the repository's provider in the error copy", async () => {
    vi.mocked(hostingListIssues).mockRejectedValue(hostingError("hostingUnreachable"));
    await renderPicker({ provider: "gitlab" }, false);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't reach GitLab. Check your connection.",
    );
  });

  it("shows no options while an error is displayed", async () => {
    vi.mocked(hostingListIssues).mockRejectedValue(hostingError("hostingNotFound"));
    await renderPicker({}, false);
    await screen.findByRole("alert");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

// Contract: keyboard handling at the edges, a fresh search restarting at the top, error retry.
describe("IssuePicker edge behaviour", () => {
  it("scrolls the newly active option into view on ArrowDown", async () => {
    await renderPicker();
    vi.mocked(Element.prototype.scrollIntoView).mockClear();
    press("ArrowDown");
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
    expect(scroll.mock.contexts[0]).toBe(screen.getAllByRole("option")[1]);
  });

  it("prevents the default of ArrowUp and ArrowDown even with no options, without picking", async () => {
    vi.mocked(hostingListIssues).mockResolvedValue([]);
    const { onPick } = await renderPicker({}, false);
    await screen.findByText("No open issues match");
    expect(fireEvent.keyDown(input(), { key: "ArrowDown" })).toBe(false);
    expect(fireEvent.keyDown(input(), { key: "ArrowUp" })).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("points aria-activedescendant nowhere when there are no options", async () => {
    vi.mocked(hostingListIssues).mockResolvedValue([]);
    await renderPicker({}, false);
    await screen.findByText("No open issues match");
    expect(input()).not.toHaveAttribute("aria-activedescendant");
  });

  it("points the search field at the listbox it controls", async () => {
    await renderPicker();
    expect(input().getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
  });

  it("starts at the first option again after a new search settles", async () => {
    vi.mocked(hostingListIssues).mockImplementation((_id, query) =>
      Promise.resolve(query === "" ? [issue(7), issue(8), issue(9)] : [issue(3), issue(4)]),
    );
    const { onPick } = await renderPicker();
    press("ArrowDown");
    press("ArrowDown");
    type("x");
    await wait(300);
    await waitFor(() => expect(options()).toEqual(["#3 Issue 3", "#4 Issue 4"]));
    press("Enter");
    expect(onPick).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("keeps Enter from picking when only Enter is pressed on an issues-off repository", async () => {
    vi.mocked(hostingRepoInfo).mockResolvedValue(repoInfo({ issuesEnabled: false }));
    const { onPick } = await renderPicker({}, false);
    await screen.findByText(ISSUES_OFF_TEXT);
    press("Enter");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("does not pick on Escape or an unrelated key", async () => {
    const { onPick } = await renderPicker();
    press("Escape");
    press("a");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("calls the latest onClose on an outside pointerdown after a re-render", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const props = { repoId: 1, provider: "github", onPick: vi.fn() } as const;
    const view = renderWithProviders(<IssuePicker {...props} onClose={first} />);
    await screen.findAllByRole("option");
    view.rerender(<IssuePicker {...props} onClose={second} />);
    fireEvent.pointerDown(document.body);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("retries the search when the error is dismissed", async () => {
    vi.mocked(hostingListIssues).mockRejectedValueOnce(hostingError("hostingNotFound"));
    await renderPicker({}, false);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(options()).toEqual(["#7 Issue 7", "#8 Issue 8", "#9 Issue 9"]));
    expect(hostingListIssues).toHaveBeenCalledTimes(2);
  });
});
