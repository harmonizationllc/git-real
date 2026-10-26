import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRepoTabs } from "../lib/store/repoTabs";
import { useShell } from "../lib/store/shell";
import type { ShellActions } from "../lib/store/shell";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useGlobalShortcuts } from "./useGlobalShortcuts";

function makeActions(overrides: Partial<ShellActions> = {}): ShellActions {
  return {
    openRepo: vi.fn(),
    cloneRepo: vi.fn(),
    openPath: vi.fn(),
    ...overrides,
  };
}

function setup(actions: ShellActions = makeActions()) {
  const view = renderHookWithProviders(() => useGlobalShortcuts(actions));
  return { view, actions };
}

beforeEach(() => {
  useRepoTabs.setState(useRepoTabs.getInitialState(), true);
  useShell.setState(useShell.getInitialState(), true);
  vi.clearAllMocks();
});

// Contract: Mod+K, Mod+/, Mod+, open the palette/shortcuts/settings dialogs via the shell store.
describe("useGlobalShortcuts dialog shortcuts", () => {
  it("Mod+K opens the palette dialog", () => {
    setup();
    fireEvent.keyDown(window, { ctrlKey: true, key: "k", code: "KeyK" });
    expect(useShell.getState().dialog).toEqual({ kind: "palette" });
  });

  it("Mod+/ opens the shortcuts dialog", () => {
    setup();
    fireEvent.keyDown(window, { ctrlKey: true, key: "/", code: "Slash" });
    expect(useShell.getState().dialog).toEqual({ kind: "shortcuts" });
  });

  it("Mod+, opens the settings dialog", () => {
    setup();
    fireEvent.keyDown(window, { ctrlKey: true, key: ",", code: "Comma" });
    expect(useShell.getState().dialog).toMatchObject({ kind: "settings" });
  });
});

// Contract: Mod+O and Mod+Shift+O call openRepo and cloneRepo.
describe("useGlobalShortcuts open/clone", () => {
  it("Mod+O calls actions.openRepo", () => {
    const actions = makeActions();
    setup(actions);
    fireEvent.keyDown(window, { ctrlKey: true, key: "o", code: "KeyO" });
    expect(actions.openRepo).toHaveBeenCalledOnce();
  });

  it("Mod+Shift+O calls actions.cloneRepo", () => {
    const actions = makeActions();
    setup(actions);
    fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, key: "O", code: "KeyO" });
    expect(actions.cloneRepo).toHaveBeenCalledOnce();
  });
});

// Contract: Mod+W closes the active tab.
describe("useGlobalShortcuts close tab", () => {
  it("Mod+W closes the active tab (closeRepo called)", () => {
    useRepoTabs.setState({
      tabs: [{ id: 1, summary: { path: "/r", name: "r", headBranch: "main", isBare: false } }],
      activeId: 1,
    });
    setup();
    fireEvent.keyDown(window, { ctrlKey: true, key: "w", code: "KeyW" });
    // The closeRepo action should have been triggered; tab should be gone or action fired.
    // We verify the store has changed (tab removed).
    expect(useRepoTabs.getState().activeId).not.toBe(1);
  });

  it("Mod+W does nothing without an active tab", () => {
    setup();
    expect(() => {
      fireEvent.keyDown(window, { ctrlKey: true, key: "w", code: "KeyW" });
    }).not.toThrow();
  });
});

// Contract: Mod+PageDown and Mod+PageUp cycle tabs; wrapping.
describe("useGlobalShortcuts tab cycling", () => {
  beforeEach(() => {
    useRepoTabs.setState({
      tabs: [
        { id: 1, summary: { path: "/a", name: "a", headBranch: "main", isBare: false } },
        { id: 2, summary: { path: "/b", name: "b", headBranch: "main", isBare: false } },
        { id: 3, summary: { path: "/c", name: "c", headBranch: "main", isBare: false } },
      ],
      activeId: 1,
    });
  });

  it("Mod+PageDown moves to next tab", () => {
    setup();
    fireEvent.keyDown(window, { ctrlKey: true, key: "PageDown", code: "PageDown" });
    expect(useRepoTabs.getState().activeId).toBe(2);
  });

  it("Mod+PageUp moves to previous tab", () => {
    useRepoTabs.setState((s) => ({ ...s, activeId: 2 }));
    setup();
    fireEvent.keyDown(window, { ctrlKey: true, key: "PageUp", code: "PageUp" });
    expect(useRepoTabs.getState().activeId).toBe(1);
  });

  it("Mod+PageDown wraps from last to first", () => {
    useRepoTabs.setState((s) => ({ ...s, activeId: 3 }));
    setup();
    fireEvent.keyDown(window, { ctrlKey: true, key: "PageDown", code: "PageDown" });
    expect(useRepoTabs.getState().activeId).toBe(1);
  });

  it("Mod+PageUp wraps from first to last", () => {
    setup();
    fireEvent.keyDown(window, { ctrlKey: true, key: "PageUp", code: "PageUp" });
    expect(useRepoTabs.getState().activeId).toBe(3);
  });

  it("tab shortcuts do nothing without an active tab", () => {
    useRepoTabs.setState((s) => ({ ...s, activeId: null }));
    setup();
    expect(() => {
      fireEvent.keyDown(window, { ctrlKey: true, key: "PageDown", code: "PageDown" });
    }).not.toThrow();
  });
});

// Contract: dialog suppression rule (R14).
describe("useGlobalShortcuts dialog suppression", () => {
  it("does nothing while a [role=dialog] is mounted", () => {
    setup();
    // Render a dialog into the document.
    const div = document.createElement("div");
    div.setAttribute("role", "dialog");
    document.body.appendChild(div);
    try {
      fireEvent.keyDown(window, { ctrlKey: true, key: "k", code: "KeyK" });
      expect(useShell.getState().dialog).toBeNull();
    } finally {
      document.body.removeChild(div);
    }
  });
});

// Contract: calls preventDefault only when it acts.
describe("useGlobalShortcuts preventDefault", () => {
  it("calls preventDefault when acting on Mod+K", () => {
    setup();
    const event = new KeyboardEvent("keydown", { ctrlKey: true, key: "k", bubbles: true });
    const spy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);
    expect(spy).toHaveBeenCalled();
  });

  it("does not call preventDefault on an unhandled key", () => {
    setup();
    const event = new KeyboardEvent("keydown", { ctrlKey: true, key: "z", bubbles: true });
    const spy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);
    expect(spy).not.toHaveBeenCalled();
  });
});

// Contract: listener is removed on unmount.
describe("useGlobalShortcuts cleanup", () => {
  it("removes the listener on unmount", () => {
    const { view } = setup();
    view.unmount();
    // After unmount, dispatching a handled key must not update the shell.
    fireEvent.keyDown(window, { ctrlKey: true, key: "k", code: "KeyK" });
    expect(useShell.getState().dialog).toBeNull();
  });
});
