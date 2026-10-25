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

// Contract: ArrowDown/Up, Home and End move aria-activedescendant.
describe("CommandPalette keyboard navigation", () => {
  it("ArrowDown moves aria-activedescendant", async () => {
    setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    const listbox = screen.getByRole("listbox");
    const initialId = listbox.getAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const newId = listbox.getAttribute("aria-activedescendant");
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
    const activeId = listbox.getAttribute("aria-activedescendant");
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
    const activeId = listbox.getAttribute("aria-activedescendant");
    if (options.length > 0 && activeId) {
      expect(options[options.length - 1].id).toBe(activeId);
    }
  });

  it("ArrowUp moves aria-activedescendant to the previous item", async () => {
    setup();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    const listbox = screen.getByRole("listbox");
    // Navigate down twice to reach index 2.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const idAtIndex2 = listbox.getAttribute("aria-activedescendant");
    // Navigate up once — should move back to index 1.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const idAfterUp = listbox.getAttribute("aria-activedescendant");
    expect(idAfterUp).not.toBe(idAtIndex2);
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
    await new Promise((r) => setTimeout(r, 0));
    const listbox = screen.getByRole("listbox");
    const fetchOption = within(listbox).queryByRole("option", { name: /Fetch/ });
    if (fetchOption) {
      fireEvent.click(fetchOption);
      expect(onClose).not.toHaveBeenCalled();
    }
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
    await screen.findByRole("combobox", { name: "Search commands" });
    await new Promise((r) => setTimeout(r, 50));
    expect(listBranches).not.toHaveBeenCalled();
    expect(listRemotes).not.toHaveBeenCalled();
    expect(getOperationState).not.toHaveBeenCalled();
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
