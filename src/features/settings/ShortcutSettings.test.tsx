import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateSettings } from "../../lib/ipc";
import type { Settings, ShortcutBindings, ShortcutKeycaps } from "../../lib/ipc";
import { SHORTCUT_GROUPS } from "../../lib/shortcuts";
import { useSettings } from "../../lib/store/settings";
import { renderWithProviders } from "../../test/renderWithProviders";
import { resetSettings, seedSettings } from "../../test/settingsStore";
import { ShortcutSettings } from "./ShortcutSettings";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

const LISTENING = "Listening for a shortcut. Press Escape to cancel.";

beforeEach(async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  await resetSettings();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function seed(bindings: ShortcutBindings, keycaps: ShortcutKeycaps = {}) {
  await seedSettings({ shortcuts: { bindings, keycaps } });
}

/** Renders the section; fake timers hold the 300 ms save so a test can check nothing was sent. */
function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return renderWithProviders(<ShortcutSettings />);
}

/** Runs the 300 ms save timer and returns the stored shortcuts section (bindings and keycaps). */
async function shortcuts(): Promise<Settings["shortcuts"]> {
  act(() => vi.advanceTimersByTime(300));
  await act(() => useSettings.getState().flush());
  return useSettings.getState().settings.shortcuts;
}

/** Dispatches an AltGr keydown: happy-dom's AltGraph is shimmed off, so the instance overrides it. */
function altGraphKeyDown(target: HTMLElement, init: KeyboardEventInit) {
  const e = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
  Object.defineProperty(e, "getModifierState", { value: (k: string) => k === "AltGraph" });
  act(() => {
    target.dispatchEvent(e);
  });
}

const chordButton = (label: string) =>
  screen.getByRole("button", { name: `Change shortcut for ${label}` });

const kbdParts = (el: HTMLElement) => [...el.querySelectorAll("kbd")].map((k) => k.textContent);

/** Clicks the row's chord button to start listening; the click itself focuses the button. */
function listen(label: string): HTMLElement {
  const button = chordButton(label);
  fireEvent.click(button);
  return button;
}

function expectNoSave() {
  act(() => vi.advanceTimersByTime(300));
  expect(updateSettings).not.toHaveBeenCalled();
}

// Contract (spec §6 layout): one table per group, every registry row, no static rows.
describe("ShortcutSettings layout", () => {
  it("renders one table per group with every registry row and no static rows", () => {
    setup();
    for (const group of SHORTCUT_GROUPS) {
      expect(screen.getByRole("table", { name: group })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("table")).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: /^Change shortcut for / })).toHaveLength(14);
    expect(screen.queryByText("Close dialog or menu")).toBeNull();
  });

  it("a default row has no Reset button; an overridden row has one with the default in its title", async () => {
    await seed({ fetch: "Mod+Alt+F" });
    setup();
    const reset = screen.getByRole("button", { name: "Reset Fetch to default" });
    expect(reset).toHaveAttribute("title", "Reset to Ctrl+Shift+F");
    expect(screen.queryByRole("button", { name: "Reset Pull to default" })).toBeNull();
  });

  it("each table has Action, Shortcut and a visually hidden Actions column header", () => {
    setup();
    const table = screen.getByRole("table", { name: "Repository" });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual(["Action", "Shortcut", "Actions"]);
    expect(headers[2]).toHaveAttribute("scope", "col");
  });

  it("the Reset title shows the default with learned keycaps", async () => {
    await seed({ fetch: "Mod+Alt+F" }, { F: "U" });
    setup();
    const reset = screen.getByRole("button", { name: "Reset Fetch to default" });
    expect(reset).toHaveAttribute("title", "Reset to Ctrl+Shift+U");
  });

  it("the chord button describes the current chord or Unbound", async () => {
    await seed({ palette: null });
    setup();
    expect(chordButton("Fetch")).toHaveAccessibleDescription("Ctrl+Shift+F");
    expect(chordButton("Command palette")).toHaveAccessibleDescription("Unbound");
  });

  it("the hint names the cross-platform rule", () => {
    const view = setup();
    expect(
      screen.getByText(
        "Press a key combination with Ctrl or Alt, or a function key. Changes apply at once. The same settings file works on every platform: Ctrl here is ⌘ on a Mac.",
      ),
    ).toBeInTheDocument();
    view.unmount();
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    setup();
    expect(
      screen.getByText(
        "Press a key combination with ⌘ or ⌥, or a function key. Changes apply at once. The same settings file works on every platform: ⌘ here is Ctrl on Linux and Windows.",
      ),
    ).toBeInTheDocument();
  });
});

// Contract (spec §6 capture flow, steps 1, 2, 4 and 5).
describe("ShortcutSettings capture", () => {
  it("clicking the chord button starts listening", () => {
    setup();
    const button = listen("Fetch");
    expect(button).toHaveTextContent("Press keys…");
    expect(button).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(LISTENING);
  });

  it("a click focuses the chord button even when the webview does not", () => {
    setup();
    const button = chordButton("Fetch");
    fireEvent.click(button);
    expect(button).toHaveFocus();
    expect(button).toHaveTextContent("Press keys…");
  });

  it("Escape cancels without saving", () => {
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { key: "Escape", code: "Escape" });
    expect(kbdParts(button)).toEqual(["Ctrl", "Shift", "F"]);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expectNoSave();
  });

  it("a modifier alone keeps listening", () => {
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(button).toHaveTextContent("Press keys…");
  });

  it("an unbindable chord shows the error and keeps listening", () => {
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { key: "a", code: "KeyA" });
    expect(screen.getByRole("alert")).toHaveTextContent("Add Ctrl or Alt, or use a function key.");
    expect(button).toHaveTextContent("Press keys…");
    expectNoSave();
  });

  it("the current chord cancels", () => {
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true });
    expect(kbdParts(button)).toEqual(["Ctrl", "Shift", "F"]);
    expectNoSave();
  });

  it("a free chord is saved as an override", async () => {
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { key: "f", code: "KeyF", ctrlKey: true, altKey: true });
    expect(await shortcuts()).toEqual({ bindings: { fetch: "Mod+Alt+F" }, keycaps: {} });
    expect(kbdParts(chordButton("Fetch"))).toEqual(["Ctrl", "Alt", "F"]);
    expect(screen.getByRole("button", { name: "Reset Fetch to default" })).toBeInTheDocument();
  });

  it("pressing the default again deletes the override", async () => {
    await seed({ fetch: "Mod+Alt+F" });
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true });
    expect(await shortcuts()).toEqual({ bindings: {}, keycaps: {} });
  });

  it("blur while listening cancels", () => {
    setup();
    const button = listen("Fetch");
    fireEvent.blur(button);
    expect(kbdParts(button)).toEqual(["Ctrl", "Shift", "F"]);
    expectNoSave();
  });

  it("Tab while listening is not captured and leaves through blur", () => {
    setup();
    const button = listen("Fetch");
    const e = new KeyboardEvent("keydown", {
      key: "Tab",
      code: "Tab",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      button.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
    fireEvent.blur(button);
    expect(kbdParts(button)).toEqual(["Ctrl", "Shift", "F"]);
    expectNoSave();
  });

  it("starting a second row stops the first", () => {
    setup();
    listen("Fetch");
    listen("Pull");
    expect(chordButton("Fetch")).not.toHaveTextContent("Press keys…");
    expect(chordButton("Pull")).toHaveTextContent("Press keys…");
  });

  it("keydown while listening does not reach the window listener", () => {
    setup();
    const spy = vi.fn();
    window.addEventListener("keydown", spy);
    try {
      const button = listen("Pull");
      const e = new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        button.dispatchEvent(e);
      });
      expect(spy).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener("keydown", spy);
    }
  });
});

// Contract (spec §6 capture flow, step 3): a taken chord asks before replacing.
describe("ShortcutSettings conflict", () => {
  function conflictOnPull() {
    setup();
    const button = listen("Pull");
    fireEvent.keyDown(button, { key: "k", code: "KeyK", ctrlKey: true });
    return button;
  }

  it("a taken chord shows the conflict with Replace and Cancel", () => {
    const button = conflictOnPull();
    expect(screen.getByText("Already used by Command palette")).toBeInTheDocument();
    expect(kbdParts(button)).toEqual(["Ctrl", "K"]);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace" })).toHaveFocus();
    expectNoSave();
  });

  it("Replace rebinds and unbinds the other", async () => {
    conflictOnPull();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(await shortcuts()).toEqual({ bindings: { pull: "Mod+K", palette: null }, keycaps: {} });
    expect(chordButton("Command palette")).toHaveTextContent(/^Unbound$/);
    expect(screen.queryByText("Already used by Command palette")).toBeNull();
  });

  it("Replace learns the winner's keycap", async () => {
    setup();
    const button = listen("Pull");
    fireEvent.keyDown(button, { key: "t", code: "KeyK", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(await shortcuts()).toEqual({
      bindings: { pull: "Mod+K", palette: null },
      keycaps: { K: "T" },
    });
  });

  it("the conflict preview shows the just-pressed keycap on a fresh layout", () => {
    setup();
    const button = listen("Pull");
    fireEvent.keyDown(button, { code: "KeyK", key: "t", ctrlKey: true });
    expect(screen.getByText("Already used by Command palette")).toBeInTheDocument();
    expect(kbdParts(button)).toEqual(["Ctrl", "T"]);
  });

  it("Cancel in the conflict saves nothing", () => {
    const button = conflictOnPull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(kbdParts(button)).toEqual(["Ctrl", "Shift", "L"]);
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    expectNoSave();
  });

  it("Escape in the conflict cancels it without reaching the dialog", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const parentKeyDown = vi.fn();
    renderWithProviders(
      <div onKeyDown={parentKeyDown}>
        <ShortcutSettings />
      </div>,
    );
    const button = listen("Pull");
    fireEvent.keyDown(button, { key: "k", code: "KeyK", ctrlKey: true });
    const replace = screen.getByRole("button", { name: "Replace" });
    expect(replace).toHaveFocus();
    fireEvent.keyDown(replace, { key: "Escape", code: "Escape" });
    expect(screen.queryByText("Already used by Command palette")).toBeNull();
    expect(kbdParts(button)).toEqual(["Ctrl", "Shift", "L"]);
    expect(button).toHaveFocus();
    expect(parentKeyDown).not.toHaveBeenCalled();
    expectNoSave();
  });

  it("other keys in the conflict are left alone", () => {
    conflictOnPull();
    const replace = screen.getByRole("button", { name: "Replace" });
    fireEvent.keyDown(replace, { key: "ArrowRight", code: "ArrowRight" });
    expect(screen.getByText("Already used by Command palette")).toBeInTheDocument();
  });

  it("Replace and Cancel return focus to the chord button", () => {
    const button = conflictOnPull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(button).toHaveFocus();
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "k", code: "KeyK", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(button).toHaveFocus();
  });
});

// Contract (spec §6 saving): Reset deletes one entry; Reset all sends an empty map.
describe("ShortcutSettings reset", () => {
  it("Reset deletes the entry", async () => {
    await seed({ fetch: "Mod+Alt+F", palette: null });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Reset Fetch to default" }));
    expect(await shortcuts()).toEqual({ bindings: { palette: null }, keycaps: {} });
  });

  it("Reset leaves keycaps alone", async () => {
    await seed({ fetch: "Mod+Alt+Q" }, { Q: "A" });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Reset Fetch to default" }));
    expect(await shortcuts()).toEqual({ bindings: {}, keycaps: { Q: "A" } });
  });

  it("Reset moves focus to the row's chord button", async () => {
    await seed({ fetch: "Mod+Alt+F" });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Reset Fetch to default" }));
    expect(chordButton("Fetch")).toHaveFocus();
  });

  it("Reset all moves focus to the first chord button", async () => {
    await seed({ fetch: "Mod+Alt+F" });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Reset all to defaults" }));
    expect(chordButton("Command palette")).toHaveFocus();
  });

  it("Reset all sends both empty maps and is disabled when nothing is overridden", async () => {
    const view = setup();
    expect(screen.getByRole("button", { name: "Reset all to defaults" })).toBeDisabled();
    view.unmount();
    vi.useRealTimers();
    await seed({ fetch: "Mod+Alt+Q", palette: null }, { Q: "A" });
    setup();
    const all = screen.getByRole("button", { name: "Reset all to defaults" });
    expect(all).toBeEnabled();
    fireEvent.click(all);
    expect(await shortcuts()).toEqual({ bindings: {}, keycaps: {} });
    const application = screen.getByRole("table", { name: "Application" });
    expect(within(application).queryByText("Unbound")).toBeNull();
  });

  it("Reset all is enabled when only keycaps are stored and clears them", async () => {
    await seed({}, { Q: "A" });
    setup();
    const all = screen.getByRole("button", { name: "Reset all to defaults" });
    expect(all).toBeEnabled();
    fireEvent.click(all);
    expect(await shortcuts()).toEqual({ bindings: {}, keycaps: {} });
  });

  it("Reset on a row whose default another override took drops that override too", async () => {
    await seed({ pull: "Mod+K", palette: null });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Reset Command palette to default" }));
    expect(await shortcuts()).toEqual({ bindings: {}, keycaps: {} });
    expect(kbdParts(chordButton("Command palette"))).toEqual(["Ctrl", "K"]);
    expect(kbdParts(chordButton("Pull"))).toEqual(["Ctrl", "Shift", "L"]);
  });

  it("Reset leaves overrides on other chords alone", async () => {
    await seed({ fetch: "Mod+Alt+F", pull: "Mod+K", palette: null });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Reset Command palette to default" }));
    expect(await shortcuts()).toEqual({ bindings: { fetch: "Mod+Alt+F" }, keycaps: {} });
  });

  it("Reset drops every override that claims the default (hand-edited file)", async () => {
    await seed({ pull: "Mod+K", push: "Mod+K", palette: null });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Reset Command palette to default" }));
    expect(await shortcuts()).toEqual({ bindings: {}, keycaps: {} });
  });
});

// Contract (GR-18b spec §5 Unbind): a button and bare Backspace/Delete set a row to null.
describe("ShortcutSettings unbind", () => {
  it("Unbind is shown on bound rows including defaults and hidden on unbound rows", async () => {
    await seed({ fetch: "Mod+Alt+F", palette: null });
    setup();
    expect(screen.getByRole("button", { name: "Unbind Fetch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unbind Pull" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unbind Command palette" })).toBeNull();
  });

  it("Unbind sits before Reset in the third column", async () => {
    await seed({ fetch: "Mod+Alt+F" });
    setup();
    const cell = screen.getByRole("button", { name: "Unbind Fetch" }).closest("td") as HTMLElement;
    expect(
      within(cell)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Unbind", "Reset"]);
  });

  it("Unbind sets null, leaves keycaps alone, focuses the chord button and shows Reset", async () => {
    await seed({ fetch: "Mod+Alt+Q" }, { Q: "A" });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Unbind Fetch" }));
    expect(chordButton("Fetch")).toHaveFocus();
    expect(chordButton("Fetch")).toHaveTextContent(/^Unbound$/);
    expect(screen.queryByRole("button", { name: "Unbind Fetch" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reset Fetch to default" })).toBeInTheDocument();
    expect(await shortcuts()).toEqual({ bindings: { fetch: null }, keycaps: { Q: "A" } });
  });

  it("bare Backspace while listening unbinds", async () => {
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { key: "Backspace", code: "Backspace" });
    expect(button).toHaveTextContent(/^Unbound$/);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(await shortcuts()).toEqual({ bindings: { fetch: null }, keycaps: {} });
  });

  it("bare Delete while listening unbinds", async () => {
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { key: "Delete", code: "Delete" });
    expect(button).toHaveTextContent(/^Unbound$/);
    expect(await shortcuts()).toEqual({ bindings: { fetch: null }, keycaps: {} });
  });

  it("Shift+Backspace while listening is an unbindable chord, not an unbind", () => {
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { key: "Backspace", code: "Backspace", shiftKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent("Add Ctrl or Alt, or use a function key.");
    expectNoSave();
  });

  it("Mod+Backspace while listening binds the chord", async () => {
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { key: "Backspace", code: "Backspace", ctrlKey: true });
    expect((await shortcuts()).bindings.fetch).toBe("Mod+Backspace");
  });

  it("Meta+Delete and Alt+Delete while listening bind the chord", async () => {
    setup();
    fireEvent.keyDown(listen("Fetch"), { key: "Delete", code: "Delete", metaKey: true });
    fireEvent.keyDown(listen("Pull"), { key: "Delete", code: "Delete", altKey: true });
    expect((await shortcuts()).bindings).toEqual({ fetch: "Mod+Delete", pull: "Alt+Delete" });
  });

  it("an AltGraph keydown keeps listening without an error", () => {
    setup();
    const button = listen("Fetch");
    altGraphKeyDown(button, { key: "€", code: "KeyE", ctrlKey: true, altKey: true });
    altGraphKeyDown(button, { key: "Backspace", code: "Backspace" });
    expect(button).toHaveTextContent("Press keys…");
    expect(screen.queryByRole("alert")).toBeNull();
    expectNoSave();
  });
});

// Contract (GR-18b spec §5 keycap learning): captures record what the layout prints on the key.
describe("ShortcutSettings keycaps", () => {
  it("a Dvorak capture learns the keycap and shows it on every chord using that key", async () => {
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { code: "KeyQ", key: "a", ctrlKey: true, altKey: true });
    expect(await shortcuts()).toEqual({ bindings: { fetch: "Mod+Alt+Q" }, keycaps: { Q: "A" } });
    expect(kbdParts(chordButton("Fetch"))).toEqual(["Ctrl", "Alt", "A"]);
    expect(chordButton("Fetch")).toHaveAccessibleDescription("Ctrl+Alt+A");
    await act(() => seed({ fetch: "Mod+Alt+Q", pull: "Mod+Q" }, { Q: "A" }));
    expect(kbdParts(chordButton("Pull"))).toEqual(["Ctrl", "A"]);
  });

  it("the conflict preview shows the learned keycap", async () => {
    await seed({ fetch: "Mod+Alt+Q" }, { Q: "A" });
    setup();
    const button = listen("Pull");
    fireEvent.keyDown(button, { code: "KeyQ", key: "a", ctrlKey: true, altKey: true });
    expect(screen.getByText("Already used by Fetch")).toBeInTheDocument();
    expect(kbdParts(button)).toEqual(["Ctrl", "Alt", "A"]);
  });

  it("a QWERTY capture stores no keycap", async () => {
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { code: "KeyQ", key: "q", ctrlKey: true, altKey: true });
    expect(await shortcuts()).toEqual({ bindings: { fetch: "Mod+Alt+Q" }, keycaps: {} });
  });

  it("a capture without a usable character leaves the keycaps alone", async () => {
    await seed({}, { Q: "A" });
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { code: "F5", key: "F5" });
    expect(await shortcuts()).toEqual({ bindings: { fetch: "F5" }, keycaps: { Q: "A" } });
  });

  it("a QWERTY capture on a learned key removes its entry", async () => {
    await seed({}, { Q: "A" });
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { code: "KeyQ", key: "q", ctrlKey: true, altKey: true });
    expect(await shortcuts()).toEqual({ bindings: { fetch: "Mod+Alt+Q" }, keycaps: {} });
  });

  it("re-pressing the current chord on a new layout updates the keycap without changing the binding", async () => {
    await seed({ fetch: "Mod+Alt+Q" });
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { code: "KeyQ", key: "a", ctrlKey: true, altKey: true });
    expect(kbdParts(button)).toEqual(["Ctrl", "Alt", "A"]);
    expect(await shortcuts()).toEqual({ bindings: { fetch: "Mod+Alt+Q" }, keycaps: { Q: "A" } });
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it("re-pressing the current chord on the same layout saves nothing", async () => {
    await seed({ fetch: "Mod+Alt+Q" }, { Q: "A" });
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { code: "KeyQ", key: "a", ctrlKey: true, altKey: true });
    expect(kbdParts(button)).toEqual(["Ctrl", "Alt", "A"]);
    expectNoSave();
  });

  it("a save drops invalid keycap entries", async () => {
    await seed({}, { Q: "ab", K: "T" });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Unbind Fetch" }));
    expect(await shortcuts()).toEqual({ bindings: { fetch: null }, keycaps: { K: "T" } });
  });

  it("an invalid keycap entry is shown as its token", async () => {
    await seed({ fetch: "Mod+Alt+Q" }, { Q: "ab" });
    setup();
    expect(kbdParts(chordButton("Fetch"))).toEqual(["Ctrl", "Alt", "Q"]);
  });
});
