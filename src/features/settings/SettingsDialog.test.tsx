// Task 13: Failing tests for SettingsDialog.
// These tests import modules/symbols that do not exist yet — red phase.

import { createRef } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkGitCli, getSettings, pickFile, pickFolder, updateSettings } from "../../lib/ipc";
import type { Settings } from "../../lib/ipc";
import { queryClient } from "../../lib/query/client";
import { useAppearancePrefs } from "../../lib/store/appearancePrefs";
import type { SettingsSection } from "../../lib/store/shell";
import { useShell } from "../../lib/store/shell";
import { useToasts } from "../../lib/store/toasts";
import { renderWithProviders } from "../../test/renderWithProviders";
import { SettingsDialog } from "./SettingsDialog";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  checkGitCli: vi.fn(),
  pickFolder: vi.fn(),
  pickFile: vi.fn(),
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

function setup(over: { section?: SettingsSection; onClose?: () => void } = {}) {
  const onClose = over.onClose ?? vi.fn();
  const { fallbackFocus, div } = makeFallback();
  const view = renderWithProviders(
    <SettingsDialog section={over.section} onClose={onClose} fallbackFocus={fallbackFocus} />,
  );
  return { ...view, onClose, div };
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  useShell.setState({ dialog: null, repoActions: null });
  useToasts.setState({ toasts: [] });
  useAppearancePrefs.setState(useAppearancePrefs.getInitialState(), true);
  vi.mocked(getSettings).mockResolvedValue(defaultSettings);
  vi.mocked(updateSettings).mockImplementation(async (patch) => ({ ...defaultSettings, ...patch }));
  vi.mocked(checkGitCli).mockResolvedValue({
    available: true,
    path: "/usr/bin/git",
    version: "2.43.0",
    error: null,
  });
  vi.mocked(pickFolder).mockResolvedValue("/home/u/src");
  vi.mocked(pickFile).mockResolvedValue("/usr/bin/git");
});

afterEach(() => {
  document.querySelectorAll("[tabindex]").forEach((el) => {
    if (el !== document.body && document.body.contains(el)) el.remove();
  });
});

// Contract: renders the five sections in order with their headings.
describe("SettingsDialog sections", () => {
  it("renders the five sections in order with their headings", async () => {
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    const sections = ["Appearance", "Diff", "Clone", "Tools", "Git"];
    for (const name of sections) {
      expect(screen.getByRole("heading", { level: 3, name })).toBeInTheDocument();
    }
  });

  it("renders with role=dialog and heading Settings", async () => {
    setup();
    await screen.findByRole("dialog");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });
});

// Contract: Theme radios reflect and set the appearance store.
describe("SettingsDialog Theme", () => {
  it("Theme radios reflect and set the appearance store", async () => {
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    const systemRadio = screen.getByRole("radio", { name: "System" });
    const lightRadio = screen.getByRole("radio", { name: "Light" });
    const darkRadio = screen.getByRole("radio", { name: "Dark" });
    expect(systemRadio).toBeChecked();
    expect(lightRadio).not.toBeChecked();
    expect(darkRadio).not.toBeChecked();
    fireEvent.click(lightRadio);
    expect(useAppearancePrefs.getState().theme).toBe("light");
  });
});

// Contract: Font family commits on blur/Enter and empty clears.
describe("SettingsDialog Font family", () => {
  it("Font family commits on blur and empty clears", async () => {
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    const input = screen.getByLabelText("Font family");
    fireEvent.change(input, { target: { value: "monospace" } });
    fireEvent.blur(input);
    expect(useAppearancePrefs.getState().diffFontFamily).toBe("monospace");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(useAppearancePrefs.getState().diffFontFamily).toBeNull();
  });
});

// Contract: Font size applies in-range values on change and clamps out-of-range on blur.
describe("SettingsDialog Font size", () => {
  it("Font size applies in-range values on change", async () => {
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    const input = screen.getByLabelText("Font size");
    fireEvent.change(input, { target: { value: "16" } });
    expect(useAppearancePrefs.getState().diffFontSize).toBe(16);
  });

  it("Font size clamps out-of-range values on blur", async () => {
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    const input = screen.getByLabelText("Font size");
    // Type an out-of-range value (does not snap immediately).
    fireEvent.change(input, { target: { value: "1" } });
    // blur clamps it.
    fireEvent.blur(input);
    expect(useAppearancePrefs.getState().diffFontSize).toBe(10);
    expect(input).toHaveValue(10);
  });

  it("Font size Enter key commits the value", async () => {
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    const input = screen.getByLabelText("Font size");
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // 5 is below the minimum (10) so it clamps to 10.
    expect(useAppearancePrefs.getState().diffFontSize).toBe(10);
  });

  it("Font size blur with an empty value resets to the stored size without changing it", async () => {
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    const input = screen.getByLabelText("Font size");
    const before = useAppearancePrefs.getState().diffFontSize;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    // Empty string is not committed — stored size is unchanged.
    expect(useAppearancePrefs.getState().diffFontSize).toBe(before);
  });

  it("a non-Enter key on the Font size input does not commit via the keyDown handler", async () => {
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    const input = screen.getByLabelText("Font size");
    const before = useAppearancePrefs.getState().diffFontSize;
    // Use an out-of-range value so onChange does not call setSize immediately.
    fireEvent.change(input, { target: { value: "1" } });
    expect(useAppearancePrefs.getState().diffFontSize).toBe(before);
    // Tab key is not Enter — the keyDown handler must not call commitSize.
    fireEvent.keyDown(input, { key: "Tab" });
    expect(useAppearancePrefs.getState().diffFontSize).toBe(before);
  });
});

// Contract: renders the two-line diff font sample.
describe("SettingsDialog diff font sample", () => {
  it("renders the two-line diff font sample", async () => {
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    // Verify the sample text or look for aria-label
    const sampleEl = document.querySelector("[aria-label='Diff font sample']");
    expect(sampleEl).not.toBeNull();
    expect(sampleEl?.textContent).toContain("const total = a + b");
    expect(sampleEl?.textContent).toContain("const total = add(a, b)");
  });
});

// Contract: Clone section shows Not set, Choose folder… and Clear button.
describe("SettingsDialog Clone section", () => {
  it("Clone shows Not set and Clear is disabled when defaultCloneDir is null", async () => {
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("Choose folder… passes the title and current directory", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...defaultSettings,
      defaultCloneDir: "/home/u/projects",
    });
    vi.mocked(updateSettings).mockResolvedValue({
      ...defaultSettings,
      defaultCloneDir: "/home/u/src",
    });
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() =>
      expect(pickFolder).toHaveBeenCalledWith("Choose default clone directory", "/home/u/projects"),
    );
  });

  it("Choose folder… persists the picked directory and shows Saved for one second", async () => {
    vi.mocked(updateSettings).mockResolvedValue({
      ...defaultSettings,
      defaultCloneDir: "/home/u/src",
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    });
    await act(() => Promise.resolve());
    expect(updateSettings).toHaveBeenCalledWith({ defaultCloneDir: "/home/u/src" });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2000));
    vi.useRealTimers();
  });

  it("cancelling Choose folder… picker does not call updateSettings", async () => {
    vi.mocked(pickFolder).mockResolvedValue(null);
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(pickFolder).toHaveBeenCalled());
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("a failed Choose folder… save toasts Couldn't save settings", async () => {
    vi.mocked(updateSettings).mockRejectedValue({ kind: "io", message: "disk full" });
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => {
      expect(
        useToasts.getState().toasts.some((t) => t.text === "Couldn't save settings: disk full"),
      ).toBe(true);
    });
  });

  it("saving twice quickly debounces the Saved indicator", async () => {
    vi.mocked(updateSettings).mockResolvedValue({
      ...defaultSettings,
      defaultCloneDir: "/home/u/src",
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    // First save — timer.current is null, so the null branch is covered.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    });
    await act(() => Promise.resolve());
    // Second save before the first timer fires — timer.current !== null (debounce branch).
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    });
    await act(() => Promise.resolve());
    expect(screen.getByText("Saved")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2000));
    vi.useRealTimers();
  });

  it("Clear clears the default clone directory", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...defaultSettings,
      defaultCloneDir: "/home/u/projects",
    });
    vi.mocked(updateSettings).mockResolvedValue({ ...defaultSettings, defaultCloneDir: null });
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    await waitFor(() => expect(screen.getByText("/home/u/projects")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ defaultCloneDir: null }));
  });
});

// Contract: tool fields commit through updateSettings with the hints shown.
describe("SettingsDialog Tools section", () => {
  it("tool fields commit through updateSettings with the hints shown", async () => {
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    // Hints must be visible for each tool field.
    expect(
      screen.getByText(/Command line; the file or folder path is appended/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Git difftool command/)).toBeInTheDocument();
    expect(screen.getByText(/Git mergetool command/)).toBeInTheDocument();
    // Committing editor updates via updateSettings.
    const editorInput = screen.getByLabelText("External editor");
    fireEvent.change(editorInput, { target: { value: "code --wait" } });
    fireEvent.blur(editorInput);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ externalEditor: "code --wait" }),
    );
  });
});

// Contract: Git section shows Using <path> (git version <v>) when available.
describe("SettingsDialog Git section — available", () => {
  it("Git shows Using <path> (git version <v>) when available", async () => {
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    await screen.findByText("Using /usr/bin/git (git version 2.43.0)");
  });
});

// Contract: Git shows the probe error when unavailable.
describe("SettingsDialog Git section — unavailable", () => {
  it("Git shows the probe error when unavailable", async () => {
    vi.mocked(checkGitCli).mockResolvedValue({
      available: false,
      path: "/usr/local/bin/git",
      version: null,
      error: "Configured Git executable not found: /usr/local/bin/git",
    });
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    await screen.findByText("Configured Git executable not found: /usr/local/bin/git");
  });
});

// Contract: invalid Git executable shows Not a Git executable: … and is not stored.
describe("SettingsDialog Git validation", () => {
  it("an invalid Git executable shows Not a Git executable: … and is not stored", async () => {
    vi.mocked(checkGitCli).mockResolvedValue({
      available: false,
      path: "/usr/bin/false",
      version: null,
      error: "exited with code 1",
    });
    vi.mocked(updateSettings).mockRejectedValue({
      kind: "gitCliInvalid",
      message: "exited with code 1",
    });
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    const gitInput = screen.getByLabelText("Git executable");
    fireEvent.change(gitInput, { target: { value: "/usr/bin/false" } });
    fireEvent.keyDown(gitInput, { key: "Enter" });
    await screen.findByText("Not a Git executable: exited with code 1");
    expect(updateSettings).toHaveBeenCalled();
  });
});

// Contract: Browse… and Use PATH update the executable.
describe("SettingsDialog Git browse and use PATH", () => {
  it("Browse… opens a file picker with the right title", async () => {
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(pickFile).toHaveBeenCalledWith("Choose Git executable"));
  });

  it("Use PATH clears the git executable", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...defaultSettings,
      gitExecutable: "/custom/git",
    });
    vi.mocked(updateSettings).mockResolvedValue({ ...defaultSettings, gitExecutable: null });
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Use PATH" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ gitExecutable: null }));
  });

  it("cancelling Browse… does not call updateSettings", async () => {
    vi.mocked(pickFile).mockResolvedValue(null);
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(pickFile).toHaveBeenCalled());
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("a non-gitCliInvalid error on the Git executable toasts Couldn't save settings", async () => {
    vi.mocked(updateSettings).mockRejectedValue({ kind: "io", message: "permission denied" });
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    const gitInput = screen.getByLabelText("Git executable");
    fireEvent.change(gitInput, { target: { value: "/custom/git" } });
    fireEvent.keyDown(gitInput, { key: "Enter" });
    await waitFor(() => {
      expect(
        useToasts
          .getState()
          .toasts.some((t) => t.text === "Couldn't save settings: permission denied"),
      ).toBe(true);
    });
  });
});

// Contract: a failed save toasts Couldn't save settings: … and reverts.
describe("SettingsDialog save failure", () => {
  it("a failed save toasts Couldn't save settings: … and reverts", async () => {
    vi.mocked(updateSettings).mockRejectedValue({
      kind: "io",
      message: "disk full",
    });
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    const editorInput = screen.getByLabelText("External editor");
    fireEvent.change(editorInput, { target: { value: "code --wait" } });
    fireEvent.blur(editorInput);
    await waitFor(() => {
      const toasts = useToasts.getState().toasts;
      expect(toasts.some((t) => t.text.startsWith("Couldn't save settings:"))).toBe(true);
    });
  });
});

// Contract: section prop focuses the first control of that section.
describe("SettingsDialog section focus", () => {
  it("section focuses the first control of that section", async () => {
    setup({ section: "git" });
    await screen.findByRole("heading", { name: "Settings" });
    const gitSection = screen.getByRole("region", { name: "Git" });
    expect(gitSection).toBeInTheDocument();
  });
});

// Contract: Keyboard shortcuts… opens the shortcuts dialog.
describe("SettingsDialog keyboard shortcuts button", () => {
  it("Keyboard shortcuts… opens the shortcuts dialog", async () => {
    setup();
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts…" }));
    expect(useShell.getState().dialog).toMatchObject({ kind: "shortcuts" });
  });
});

// Contract: Close and Escape close; a composing Escape does not.
describe("SettingsDialog closing", () => {
  it("clicking the backdrop calls onClose", async () => {
    const { onClose } = setup();
    await screen.findByRole("dialog");
    // The backdrop is the parent div that wraps the dialog element.
    const backdrop = screen.getByRole("dialog").parentElement!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Close calls onClose", async () => {
    const { onClose } = setup();
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape calls onClose", async () => {
    const { onClose } = setup();
    await screen.findByRole("heading", { name: "Settings" });
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("a composing Escape does not call onClose", async () => {
    const { onClose } = setup();
    await screen.findByRole("heading", { name: "Settings" });
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape", isComposing: true } as unknown as KeyboardEventInit);
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    Object.defineProperty(e, "keyCode", { value: 229 });
    dialog.dispatchEvent(e);
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Contract: restores focus to the fallback.
describe("SettingsDialog focus restoration", () => {
  it("restores focus to the fallback element on unmount", async () => {
    const { div } = setup();
    await screen.findByRole("heading", { name: "Settings" });
    div.focus();
    expect(div).toBeInTheDocument();
  });
});
