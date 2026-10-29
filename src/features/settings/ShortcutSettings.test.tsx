import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateSettings } from "../../lib/ipc";
import type { ShortcutBindings } from "../../lib/ipc";
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

async function seed(bindings: ShortcutBindings) {
  await seedSettings({ shortcuts: { bindings } });
}

/** Renders the section; fake timers hold the 300 ms save so a test can check nothing was sent. */
function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return renderWithProviders(<ShortcutSettings />);
}

/** Runs the 300 ms save timer and returns the stored overrides. */
async function bindings(): Promise<ShortcutBindings> {
  act(() => vi.advanceTimersByTime(300));
  await act(() => useSettings.getState().flush());
  return useSettings.getState().settings.shortcuts.bindings;
}

const chordButton = (label: string) =>
  screen.getByRole("button", { name: `Change shortcut for ${label}` });

const kbdParts = (el: HTMLElement) => [...el.querySelectorAll("kbd")].map((k) => k.textContent);

/** Focuses and clicks the row's chord button, as a real click does, to start listening. */
function listen(label: string): HTMLElement {
  const button = chordButton(label);
  act(() => button.focus());
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

  it("the hint uses platform words", () => {
    setup();
    expect(
      screen.getByText(
        "Press a key combination with Ctrl or Alt, or a function key. Changes apply at once.",
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
    expect(await bindings()).toEqual({ fetch: "Mod+Alt+F" });
    expect(kbdParts(chordButton("Fetch"))).toEqual(["Ctrl", "Alt", "F"]);
    expect(screen.getByRole("button", { name: "Reset Fetch to default" })).toBeInTheDocument();
  });

  it("pressing the default again deletes the override", async () => {
    await seed({ fetch: "Mod+Alt+F" });
    setup();
    const button = listen("Fetch");
    fireEvent.keyDown(button, { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true });
    expect(await bindings()).toEqual({});
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
    expect(await bindings()).toEqual({ pull: "Mod+K", palette: null });
    expect(chordButton("Command palette")).toHaveTextContent(/^Unbound$/);
    expect(screen.queryByText("Already used by Command palette")).toBeNull();
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
    expect(await bindings()).toEqual({ palette: null });
  });

  it("Reset all to defaults sends an empty map and is disabled when nothing is overridden", async () => {
    const view = setup();
    expect(screen.getByRole("button", { name: "Reset all to defaults" })).toBeDisabled();
    view.unmount();
    vi.useRealTimers();
    await seed({ fetch: "Mod+Alt+F", palette: null });
    setup();
    const all = screen.getByRole("button", { name: "Reset all to defaults" });
    expect(all).toBeEnabled();
    fireEvent.click(all);
    expect(await bindings()).toEqual({});
    const application = screen.getByRole("table", { name: "Application" });
    expect(within(application).queryByText("Unbound")).toBeNull();
  });
});
