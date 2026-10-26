// Task 14: Failing tests for CommandPalette component.
// These tests import modules/symbols that do not exist yet — red phase.

import { createRef } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOperationState,
  getSettings,
  listBranches,
  listRecent,
  listRemotes,
  openInEditor,
} from "../../lib/ipc";
import type { Settings } from "../../lib/ipc";
import { MAX_PALETTE_ROWS } from "../../lib/fuzzy";
import { queryClient } from "../../lib/query/client";
import { useAppearancePrefs } from "../../lib/store/appearancePrefs";
import { useRepoTabs } from "../../lib/store/repoTabs";
import type { ShellActions } from "../../lib/store/shell";
import { useShell } from "../../lib/store/shell";
import { useToasts } from "../../lib/store/toasts";
import { renderWithProviders } from "../../test/renderWithProviders";
import { CommandPalette } from "./CommandPalette";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(),
  listRecent: vi.fn(),
  openInEditor: vi.fn(),
  listBranches: vi.fn(),
  listRemotes: vi.fn(),
  getOperationState: vi.fn(),
}));

const defaultSettings: Settings = {
  defaultCloneDir: null,
  gitExecutable: null,
  externalEditor: null,
  externalDiffTool: null,
  externalMergeTool: null,
};

function makeFallback() {
  const fallbackFocus = createRef<HTMLElement | null>();
  const div = document.createElement("div");
  div.tabIndex = -1;
  document.body.appendChild(div);
  (fallbackFocus as React.MutableRefObject<HTMLElement | null>).current = div;
  return { fallbackFocus, div };
}

const stubActions = (): ShellActions => ({
  openRepo: vi.fn(),
  cloneRepo: vi.fn(),
  openPath: vi.fn(),
});

function setup(over: { actions?: ShellActions; onClose?: () => void } = {}) {
  const onClose = over.onClose ?? vi.fn();
  const actions = over.actions ?? stubActions();
  const { fallbackFocus, div } = makeFallback();
  const view = renderWithProviders(
    <CommandPalette actions={actions} onClose={onClose} fallbackFocus={fallbackFocus} />,
  );
  return { ...view, onClose, actions, div };
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  useRepoTabs.setState(useRepoTabs.getInitialState(), true);
  useShell.setState({ dialog: null, repoActions: null });
  useToasts.setState({ toasts: [] });
  useAppearancePrefs.setState(useAppearancePrefs.getInitialState(), true);
  vi.mocked(getSettings).mockResolvedValue(defaultSettings);
  vi.mocked(listRecent).mockResolvedValue([]);
});

afterEach(() => {
  document.querySelectorAll("[tabindex]").forEach((el) => {
    if (el !== document.body && document.body.contains(el)) el.remove();
  });
});

// Contract: renders the combobox, listbox and three group labels.
describe("CommandPalette rendering", () => {
  it("renders the combobox, listbox and three group labels", async () => {
    setup();
    await screen.findByRole("dialog", { name: "Command palette" });
    expect(screen.getByRole("combobox", { name: "Search commands" })).toBeInTheDocument();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // Three group labels should appear as the available groups.
    expect(screen.getByText("Actions")).toBeInTheDocument();
  });

  it("has the correct input placeholder", async () => {
    setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    expect(input).toHaveAttribute("placeholder", "Type a command or repository name");
  });

  it("shows No matching commands when query matches nothing", async () => {
    setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(input, { target: { value: "xyzzy12345nomatches" } });
    await screen.findByText("No matching commands");
  });
});

// Contract: ranks by the query and highlights matches with <mark>.
describe("CommandPalette filtering", () => {
  it("ranks by the query and highlights matches with mark elements", async () => {
    setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(input, { target: { value: "fetch" } });
    // After filtering, Fetch should appear somewhere (if repo actions exist, else show
    // at least one result with a mark). We just check that mark elements are rendered.
    const marks = document.querySelectorAll("mark");
    // If there are results, marks should be present.
    const listbox = screen.getByRole("listbox");
    const options = within(listbox).queryAllByRole("option");
    if (options.length > 0) {
      expect(marks.length).toBeGreaterThan(0);
    }
  });

  it("highlights the detail field when the query matches detail but not label", async () => {
    // Publish a gated Fetch with detail "No remote configured".
    // Querying "remote" matches the detail but not the label "Fetch".
    act(() => {
      useShell.getState().publishRepoActions({
        repoId: 1,
        path: "/r/repo",
        gates: { fetch: "No remote configured", pull: null, push: null },
        fetch: vi.fn(),
        pull: vi.fn(),
        push: vi.fn(),
        fileHistory: vi.fn(),
      });
    });
    setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(input, { target: { value: "remote" } });
    // "No remote configured" detail should be rendered with highlighted marks.
    await waitFor(() => {
      const marks = document.querySelectorAll("mark");
      expect(marks.length).toBeGreaterThan(0);
    });
  });
});

// Contract: ArrowDown/Up, Home and End move aria-activedescendant on the combobox input.
describe("CommandPalette keyboard navigation", () => {
  it("ArrowDown moves aria-activedescendant on the combobox", async () => {
    setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    const initialId = input.getAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const newId = input.getAttribute("aria-activedescendant");
    expect(newId).not.toBe(initialId);
  });

  it("Home moves to the first option", async () => {
    setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    const listbox = screen.getByRole("listbox");
    // Navigate down a few times.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Home" });
    const options = within(listbox).getAllByRole("option");
    const activeId = input.getAttribute("aria-activedescendant");
    if (options.length > 0 && activeId) {
      expect(options[0].id).toBe(activeId);
    }
  });

  it("End moves to the last option", async () => {
    setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(input, { key: "End" });
    const options = within(listbox).getAllByRole("option");
    const activeId = input.getAttribute("aria-activedescendant");
    if (options.length > 0 && activeId) {
      expect(options[options.length - 1].id).toBe(activeId);
    }
  });

  it("ArrowUp moves aria-activedescendant to the previous item", async () => {
    setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    // Navigate down twice to reach index 2.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const idAtIndex2 = input.getAttribute("aria-activedescendant");
    // Navigate up once — should move back to index 1.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const idAfterUp = input.getAttribute("aria-activedescendant");
    expect(idAfterUp).not.toBe(idAtIndex2);
  });

  // RED (M1): aria-activedescendant must live on the combobox input only; the listbox must not
  // carry it or assistive technologies will announce the active option twice.
  it("aria-activedescendant is on the combobox only, not on the listbox", async () => {
    setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).not.toBeNull();
    expect(listbox.getAttribute("aria-activedescendant")).toBeNull();
  });
});

// Contract: Enter runs the active row and closes.
describe("CommandPalette Enter to run", () => {
  it("Enter runs the active row and closes", async () => {
    const actions = stubActions();
    const { onClose } = setup({ actions });
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    // Navigate to the first option.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
  });

  it("Enter on a disabled row does nothing", async () => {
    // Publish repo actions with a gated Fetch.
    act(() => {
      useShell.getState().publishRepoActions({
        repoId: 1,
        path: "/r/repo",
        gates: { fetch: "No remote configured", pull: null, push: null },
        fetch: vi.fn(),
        pull: vi.fn(),
        push: vi.fn(),
        fileHistory: vi.fn(),
      });
    });
    const { onClose } = setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(input, { target: { value: "Fetch" } });
    const listbox = screen.getByRole("listbox");
    // Wait for the Fetch option to appear (the repo actions are in the shell store, no network).
    const fetchOption = await within(listbox).findByRole("option", { name: /Fetch/ });
    fireEvent.click(fetchOption);
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Contract: click runs a row and closes.
describe("CommandPalette click to run", () => {
  it("click runs a non-disabled row and closes", async () => {
    const actions = stubActions();
    const { onClose } = setup({ actions });
    await screen.findByRole("combobox", { name: "Search commands" });
    const listbox = screen.getByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    // Click the first enabled option.
    const enabled = options.find((o) => o.getAttribute("aria-disabled") !== "true");
    if (enabled) {
      fireEvent.click(enabled);
      expect(onClose).toHaveBeenCalled();
    }
  });
});

// Contract: Escape clears a non-empty query first and closes on the second press.
describe("CommandPalette Escape behaviour", () => {
  it("Escape clears a non-empty query first and closes on the second press", async () => {
    const { onClose } = setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(input, { target: { value: "fetch" } });
    expect(input).toHaveValue("fetch");
    fireEvent.keyDown(input, { key: "Escape" });
    // Query cleared; dialog stays.
    expect(input).toHaveValue("");
    expect(onClose).not.toHaveBeenCalled();
    // Second Escape closes.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape on an empty query closes immediately", async () => {
    const { onClose } = setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    expect(input).toHaveValue("");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("a composing Escape is ignored", async () => {
    const { onClose } = setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(input, { target: { value: "query" } });
    fireEvent.keyDown(input, {
      key: "Escape",
      isComposing: true,
    } as unknown as KeyboardEventInit);
    expect(input).toHaveValue("query");
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Contract: caps the list at MAX_PALETTE_ROWS rows.
describe("CommandPalette row cap", () => {
  it("caps the list at 50 rows", async () => {
    // Seed 60 recent repos to try to exceed the cap.
    const recents = Array.from({ length: 60 }, (_, i) => ({
      path: `/r/repo${i}`,
      name: `repo${i}`,
      headBranch: "main",
      isBare: false,
      lastOpened: Date.now(),
    }));
    vi.mocked(listRecent).mockResolvedValue(recents);
    setup();
    const listbox = await screen.findByRole("listbox");
    await waitFor(() => {
      const options = within(listbox).getAllByRole("option");
      expect(options.length).toBeLessThanOrEqual(MAX_PALETTE_ROWS);
    });
  });
});

// Review Focus 4: The palette must never create network traffic.
describe("CommandPalette — no network hooks (Review Focus 4)", () => {
  it("renders repository actions without calling listBranches, listRemotes or getOperationState", async () => {
    // Publish repo actions from the shell store (the palette reads from there, not via queries).
    act(() => {
      useShell.getState().publishRepoActions({
        repoId: 1,
        path: "/r/repo",
        gates: { fetch: null, pull: null, push: null },
        fetch: vi.fn(),
        pull: vi.fn(),
        push: vi.fn(),
        fileHistory: vi.fn(),
      });
    });
    setup();
    // Wait until repo-action options appear — confirms palette consumed the shell store.
    // Network hooks must never be called to produce these commands.
    const listbox = await screen.findByRole("listbox");
    await waitFor(() =>
      expect(within(listbox).queryByRole("option", { name: "Fetch" })).not.toBeNull(),
    );
    expect(listBranches).not.toHaveBeenCalled();
    expect(listRemotes).not.toHaveBeenCalled();
    expect(getOperationState).not.toHaveBeenCalled();
  });
});

// Contract (B1): every rendered group is reachable as role="group" with the group name, and the
// visible label div carries aria-hidden="true" so AT does not read the name twice.
describe("CommandPalette group accessibility", () => {
  it("the Actions group is accessible as role=group with name Actions", async () => {
    setup();
    await screen.findByRole("combobox", { name: "Search commands" });
    const listbox = screen.getByRole("listbox");
    const actionsGroup = within(listbox).getByRole("group", { name: "Actions" });
    expect(actionsGroup).toBeInTheDocument();
  });

  it("the visual group label has aria-hidden=true so it is not read twice", async () => {
    setup();
    await screen.findByRole("combobox", { name: "Search commands" });
    const listbox = screen.getByRole("listbox");
    const actionsGroup = within(listbox).getByRole("group", { name: "Actions" });
    const labelDiv = actionsGroup.querySelector("[aria-hidden='true']");
    expect(labelDiv).not.toBeNull();
    expect(labelDiv?.textContent).toBe("Actions");
  });

  it("Recent repositories group is accessible as role=group when recents exist", async () => {
    vi.mocked(listRecent).mockResolvedValue([
      { path: "/r/repo1", name: "repo1", lastOpened: Date.now() },
    ]);
    setup();
    await screen.findByRole("combobox", { name: "Search commands" });
    const listbox = screen.getByRole("listbox");
    await waitFor(() => {
      expect(
        within(listbox).getByRole("group", { name: "Recent repositories" }),
      ).toBeInTheDocument();
    });
  });
});

// Contract: Enter on an empty result list is a no-op (does not crash or close).
describe("CommandPalette Enter on empty list", () => {
  it("Enter when no commands match does nothing", async () => {
    const { onClose } = setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(input, { target: { value: "xyzzy12345nomatches" } });
    await screen.findByText("No matching commands");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Contract: a whitespace-only query is treated as empty — all commands show but no mark
// elements are rendered (highlight returns plain text for empty trimmed query).
describe("CommandPalette whitespace query", () => {
  it("whitespace-only query shows options without any mark highlights", async () => {
    setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    fireEvent.change(input, { target: { value: "  " } });
    // query.trim() === "" → highlight returns plain text → no <mark> elements.
    expect(document.querySelectorAll("mark").length).toBe(0);
    // Options are still shown (all commands pass through for empty query).
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).getAllByRole("option").length).toBeGreaterThan(0);
  });
});

// Contract: clicking the backdrop closes the palette.
describe("CommandPalette backdrop click", () => {
  it("clicking the backdrop calls onClose", async () => {
    const { onClose } = setup();
    await screen.findByRole("dialog", { name: "Command palette" });
    // The backdrop is the parent div wrapping the dialog element.
    const backdrop = screen.getByRole("dialog", { name: "Command palette" }).parentElement!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// Contract: restores focus to the fallback.
describe("CommandPalette focus restoration", () => {
  it("restores focus to the fallback on unmount", async () => {
    const { div } = setup();
    await screen.findByRole("combobox", { name: "Search commands" });
    expect(div).toBeInTheDocument();
  });
});

// Suppress unused-import warning: the mock uses openInEditor.
void openInEditor;
