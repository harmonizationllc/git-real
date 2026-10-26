import { createRef } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appVersion,
  checkGitCli,
  checkSettingsHealth,
  pickFile,
  pickFolder,
  revealSettingsFile,
  settingsFilePath,
  updateSettings,
} from "../../lib/ipc";
import { useSettings } from "../../lib/store/settings";
import type { SettingsSection } from "../../lib/store/shell";
import { useShell } from "../../lib/store/shell";
import { useToasts } from "../../lib/store/toasts";
import { renderWithProviders } from "../../test/renderWithProviders";
import { resetSettings, seedSettings } from "../../test/settingsStore";
import { SettingsDialog } from "./SettingsDialog";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  appVersion: vi.fn(),
  updateSettings: vi.fn(),
  checkGitCli: vi.fn(),
  checkSettingsHealth: vi.fn(),
  revealSettingsFile: vi.fn(),
  settingsFilePath: vi.fn(),
  pickFolder: vi.fn(),
  pickFile: vi.fn(),
}));

const SETTINGS_PATH = "/home/u/.config/git-real/settings.json";

const prefs = () => useSettings.getState().settings;

function makeFallback() {
  const fallbackFocus = createRef<HTMLElement | null>();
  const div = document.createElement("div");
  div.tabIndex = -1;
  document.body.appendChild(div);
  (fallbackFocus as React.MutableRefObject<HTMLElement | null>).current = div;
  return { fallbackFocus, div };
}

async function setup(over: { section?: SettingsSection; onClose?: () => void } = {}) {
  const onClose = over.onClose ?? vi.fn();
  const { fallbackFocus, div } = makeFallback();
  const view = renderWithProviders(
    <SettingsDialog section={over.section} onClose={onClose} fallbackFocus={fallbackFocus} />,
  );
  // Let the dialog's queries (Git probe, health, file path, version) settle inside act.
  await screen.findByText(SETTINGS_PATH);
  return { ...view, onClose, div };
}

beforeEach(async () => {
  vi.resetAllMocks();
  await resetSettings();
  useShell.setState({ dialog: null, repoActions: null });
  useToasts.setState({ toasts: [] });
  vi.mocked(appVersion).mockResolvedValue("0.1.0");
  vi.mocked(checkGitCli).mockResolvedValue({
    available: true,
    path: "/usr/bin/git",
    version: "2.43.0",
    error: null,
  });
  vi.mocked(checkSettingsHealth).mockResolvedValue({ defaultCloneDirMissing: false });
  vi.mocked(settingsFilePath).mockResolvedValue(SETTINGS_PATH);
  vi.mocked(revealSettingsFile).mockResolvedValue(undefined);
  vi.mocked(pickFolder).mockResolvedValue("/home/u/src");
  vi.mocked(pickFile).mockResolvedValue("/usr/bin/git");
});

afterEach(() => {
  vi.useRealTimers();
  document.querySelectorAll("[tabindex]").forEach((el) => {
    if (el !== document.body && document.body.contains(el)) el.remove();
  });
});

const hasToast = (text: string) => useToasts.getState().toasts.some((t) => t.text === text);

// Contract: renders the sections in order with their headings, File before About.
describe("SettingsDialog sections", () => {
  it("renders the sections in order with their headings", async () => {
    await setup();
    const names = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(names).toEqual(["Appearance", "Diff", "Clone", "Tools", "Git", "File", "About"]);
  });

  it("renders with role=dialog and heading Settings", async () => {
    await setup();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });
});

// Contract: Theme radios reflect the store and save through setTheme after the pause.
describe("SettingsDialog Theme", () => {
  it("Theme radios reflect the store", async () => {
    await seedSettings({ appearance: { theme: "light" } });
    await setup();
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "System" })).not.toBeChecked();
  });

  it("clicking Dark applies at once and saves the theme after 300 ms", async () => {
    await setup();
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(updateSettings).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    vi.useRealTimers();
    expect(updateSettings).toHaveBeenCalledWith({ appearance: { theme: "dark" } });
    await act(() => useSettings.getState().flush());
  });
});

// Contract: Font family commits on blur and empty clears.
describe("SettingsDialog Font family", () => {
  it("Font family commits on blur and empty clears", async () => {
    await setup();
    const input = screen.getByLabelText("Font family");
    fireEvent.change(input, { target: { value: "monospace" } });
    fireEvent.blur(input);
    await waitFor(() => expect(prefs().appearance.diffFontFamily).toBe("monospace"));
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    await waitFor(() => expect(prefs().appearance.diffFontFamily).toBeNull());
  });
});

// Contract: Font size applies in-range values on change and clamps out-of-range on blur.
describe("SettingsDialog Font size", () => {
  it("shows the stored size", async () => {
    await seedSettings({ appearance: { diffFontSize: 18 } });
    await setup();
    expect(screen.getByLabelText("Font size")).toHaveValue(18);
  });

  it("Font size applies in-range values on change", async () => {
    await setup();
    const input = screen.getByLabelText("Font size");
    fireEvent.change(input, { target: { value: "16" } });
    expect(prefs().appearance.diffFontSize).toBe(16);
  });

  it("Font size clamps out-of-range values on blur", async () => {
    await setup();
    const input = screen.getByLabelText("Font size");
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.blur(input);
    expect(prefs().appearance.diffFontSize).toBe(10);
    expect(input).toHaveValue(10);
  });

  it("Font size Enter key commits the value", async () => {
    await setup();
    const input = screen.getByLabelText("Font size");
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(prefs().appearance.diffFontSize).toBe(10);
  });

  it("Font size blur with an empty value resets to the stored size without changing it", async () => {
    await setup();
    const input = screen.getByLabelText("Font size");
    const before = prefs().appearance.diffFontSize;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(prefs().appearance.diffFontSize).toBe(before);
    expect(input).toHaveValue(before);
  });

  it("a non-Enter key on the Font size input does not commit via the keyDown handler", async () => {
    await setup();
    const input = screen.getByLabelText("Font size");
    const before = prefs().appearance.diffFontSize;
    fireEvent.change(input, { target: { value: "1" } });
    expect(prefs().appearance.diffFontSize).toBe(before);
    fireEvent.keyDown(input, { key: "Tab" });
    expect(prefs().appearance.diffFontSize).toBe(before);
  });
});

// Contract: renders the two-line diff font sample.
describe("SettingsDialog diff font sample", () => {
  it("renders the two-line diff font sample", async () => {
    await setup();
    const sampleEl = screen.getByLabelText("Diff font sample");
    expect(sampleEl.textContent).toContain("const total = a + b");
    expect(sampleEl.textContent).toContain("const total = add(a, b)");
  });
});

// Contract: Clone section reads clone.defaultDir, saves through the store, flags a missing dir.
describe("SettingsDialog Clone section", () => {
  it("Clone shows Not set and Clear is disabled when the default dir is null", async () => {
    await setup();
    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("Choose folder… passes the title and current directory", async () => {
    await seedSettings({ clone: { defaultDir: "/home/u/projects" } });
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() =>
      expect(pickFolder).toHaveBeenCalledWith("Choose default clone directory", "/home/u/projects"),
    );
  });

  it("Choose folder… with no default passes no directory", async () => {
    vi.mocked(pickFolder).mockResolvedValue(null);
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() =>
      expect(pickFolder).toHaveBeenCalledWith("Choose default clone directory", undefined),
    );
  });

  it("Choose folder… persists the picked directory, shows Saved and re-checks health", async () => {
    await setup();
    expect(checkSettingsHealth).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await screen.findByText("Saved");
    expect(updateSettings).toHaveBeenCalledWith({ clone: { defaultDir: "/home/u/src" } });
    expect(screen.getByText("/home/u/src")).toBeInTheDocument();
    await waitFor(() => expect(checkSettingsHealth).toHaveBeenCalledTimes(2));
  });

  it("the Saved indicator clears after one second, restarting on a second save", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await setup();
    const choose = screen.getByRole("button", { name: "Choose folder…" });
    await act(async () => fireEvent.click(choose));
    await screen.findByText("Saved");
    act(() => vi.advanceTimersByTime(600));
    await act(async () => fireEvent.click(choose));
    act(() => vi.advanceTimersByTime(600));
    expect(screen.getByText("Saved")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("cancelling Choose folder… does not save", async () => {
    vi.mocked(pickFolder).mockResolvedValue(null);
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(pickFolder).toHaveBeenCalled());
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("a failed Choose folder… save toasts Couldn't save settings and keeps the old value", async () => {
    vi.mocked(updateSettings).mockRejectedValue({ kind: "io", message: "disk full" });
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(hasToast("Couldn't save settings: disk full")).toBe(true));
    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("Clear clears the default clone directory", async () => {
    await seedSettings({ clone: { defaultDir: "/home/u/projects" } });
    await setup();
    expect(screen.getByText("/home/u/projects")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ clone: { defaultDir: null } }),
    );
    await screen.findByText("Not set");
  });

  it("shows Directory not found under the clone field when health says missing", async () => {
    vi.mocked(checkSettingsHealth).mockResolvedValue({ defaultCloneDirMissing: true });
    await seedSettings({ clone: { defaultDir: "/home/u/gone" } });
    await setup();
    const clone = screen.getByRole("region", { name: "Clone" });
    const alert = await within(clone).findByRole("alert");
    expect(alert).toHaveTextContent("Directory not found: /home/u/gone");
  });

  it.each([
    { missing: false, alert: false },
    { missing: true, alert: true },
  ])(
    "hides the alert while health is re-checked, then follows the answer (missing: $missing)",
    async ({ missing, alert }) => {
      vi.mocked(checkSettingsHealth).mockResolvedValue({ defaultCloneDirMissing: true });
      await seedSettings({ clone: { defaultDir: "/home/u/gone" } });
      await setup();
      const clone = screen.getByRole("region", { name: "Clone" });
      expect(await within(clone).findByRole("alert")).toBeInTheDocument();

      let answer!: (h: { defaultCloneDirMissing: boolean }) => void;
      vi.mocked(checkSettingsHealth).mockReturnValue(
        new Promise((res) => {
          answer = res;
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
      await screen.findByText("Saved");
      await waitFor(() => expect(checkSettingsHealth).toHaveBeenCalledTimes(2));
      expect(within(clone).queryByRole("alert")).toBeNull();

      await act(async () => answer({ defaultCloneDirMissing: missing }));
      if (alert) {
        expect(await within(clone).findByRole("alert")).toHaveTextContent(
          "Directory not found: /home/u/src",
        );
      } else {
        expect(within(clone).queryByRole("alert")).toBeNull();
      }
    },
  );

  it("re-checks health when a reconciled settings change swaps the clone directory", async () => {
    await setup();
    expect(checkSettingsHealth).toHaveBeenCalledTimes(1);
    await act(async () => {
      await seedSettings({ clone: { defaultDir: "/home/u/elsewhere" } });
    });
    await waitFor(() => expect(checkSettingsHealth).toHaveBeenCalledTimes(2));
  });

  it("shows no Directory not found alert when the dir is not set", async () => {
    vi.mocked(checkSettingsHealth).mockResolvedValue({ defaultCloneDirMissing: true });
    await setup();
    const clone = screen.getByRole("region", { name: "Clone" });
    expect(within(clone).queryByRole("alert")).toBeNull();
  });

  it("shows no Directory not found alert when health says present", async () => {
    await seedSettings({ clone: { defaultDir: "/home/u/projects" } });
    await setup();
    const clone = screen.getByRole("region", { name: "Clone" });
    expect(within(clone).queryByRole("alert")).toBeNull();
  });
});

// Contract: tool fields commit through the store's validated save, with the hints shown.
describe("SettingsDialog Tools section", () => {
  it("tool fields commit through updateSettings with the hints shown", async () => {
    await setup();
    expect(
      screen.getByText(/Command line; the file or folder path is appended/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Git difftool command/)).toBeInTheDocument();
    expect(screen.getByText(/Git mergetool command/)).toBeInTheDocument();
    const fields: [string, string][] = [
      ["External editor", "editor"],
      ["External diff tool", "diffTool"],
      ["External merge tool", "mergeTool"],
    ];
    for (const [label, key] of fields) {
      const input = screen.getByLabelText(label);
      fireEvent.change(input, { target: { value: "meld" } });
      fireEvent.blur(input);
      await waitFor(() =>
        expect(updateSettings).toHaveBeenCalledWith({ tools: { [key]: "meld" } }),
      );
    }
    await waitFor(() =>
      expect(prefs().tools).toEqual({ editor: "meld", diffTool: "meld", mergeTool: "meld" }),
    );
  });

  it("shows the stored tool commands", async () => {
    await seedSettings({ tools: { editor: "code --wait" } });
    await setup();
    expect(screen.getByLabelText("External editor")).toHaveValue("code --wait");
  });

  it("a failed save toasts Couldn't save settings: … and reverts", async () => {
    vi.mocked(updateSettings).mockRejectedValue({ kind: "io", message: "disk full" });
    await setup();
    const editorInput = screen.getByLabelText("External editor");
    fireEvent.change(editorInput, { target: { value: "code --wait" } });
    fireEvent.blur(editorInput);
    await waitFor(() => expect(hasToast("Couldn't save settings: disk full")).toBe(true));
    expect(editorInput).toHaveValue("");
    expect(prefs().tools.editor).toBeNull();
  });
});

// Contract: Git section shows the located CLI, and the probe's error whenever it has one.
describe("SettingsDialog Git section — probe", () => {
  it("Git shows Using <path> (git version <v>) when available", async () => {
    await setup();
    await screen.findByText("Using /usr/bin/git (git version 2.43.0)");
    const git = screen.getByRole("region", { name: "Git" });
    expect(within(git).queryByRole("alert")).toBeNull();
  });

  it("shows the fallback notice while available", async () => {
    const notice = "Configured Git executable not found: /x; using /usr/bin/git";
    vi.mocked(checkGitCli).mockResolvedValue({
      available: true,
      path: "/usr/bin/git",
      version: "2.43.0",
      error: notice,
    });
    await setup();
    const git = screen.getByRole("region", { name: "Git" });
    expect(await within(git).findByRole("alert")).toHaveTextContent(notice);
    expect(screen.getByText("Using /usr/bin/git (git version 2.43.0)")).toBeInTheDocument();
  });

  it("the probe error uses role=alert when unavailable", async () => {
    vi.mocked(checkGitCli).mockResolvedValue({
      available: false,
      path: null,
      version: null,
      error: "Git was not found on PATH",
    });
    await setup();
    const git = screen.getByRole("region", { name: "Git" });
    expect(await within(git).findByRole("alert")).toHaveTextContent("Git was not found on PATH");
    expect(screen.queryByText(/^Using /)).toBeNull();
  });
});

// Contract: the Git executable saves through the store and re-probes the CLI.
describe("SettingsDialog Git executable", () => {
  it("saving the field stores git.executable and re-queries checkGitCli", async () => {
    await setup();
    await waitFor(() => expect(checkGitCli).toHaveBeenCalledTimes(1));
    const gitInput = screen.getByLabelText("Git executable");
    fireEvent.change(gitInput, { target: { value: "/usr/bin/git" } });
    fireEvent.keyDown(gitInput, { key: "Enter" });
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ git: { executable: "/usr/bin/git" } }),
    );
    await waitFor(() => expect(checkGitCli).toHaveBeenCalledTimes(2));
    expect(prefs().git.executable).toBe("/usr/bin/git");
  });

  it("an invalid Git executable shows Not a Git executable: … and is not stored", async () => {
    vi.mocked(updateSettings).mockRejectedValue({
      kind: "gitCliInvalid",
      message: "exited with code 1",
    });
    await setup();
    const gitInput = screen.getByLabelText("Git executable");
    fireEvent.change(gitInput, { target: { value: "/usr/bin/false" } });
    fireEvent.keyDown(gitInput, { key: "Enter" });
    await screen.findByText("Not a Git executable: exited with code 1");
    expect(prefs().git.executable).toBeNull();
    expect(checkGitCli).toHaveBeenCalledTimes(1);
  });

  it("a non-gitCliInvalid error on the Git executable toasts Couldn't save settings", async () => {
    vi.mocked(updateSettings).mockRejectedValue({ kind: "io", message: "permission denied" });
    await setup();
    const gitInput = screen.getByLabelText("Git executable");
    fireEvent.change(gitInput, { target: { value: "/custom/git" } });
    fireEvent.keyDown(gitInput, { key: "Enter" });
    await waitFor(() => expect(hasToast("Couldn't save settings: permission denied")).toBe(true));
  });

  it("Browse… opens a file picker and saves the pick", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(pickFile).toHaveBeenCalledWith("Choose Git executable"));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ git: { executable: "/usr/bin/git" } }),
    );
  });

  it("cancelling Browse… does not save", async () => {
    vi.mocked(pickFile).mockResolvedValue(null);
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(pickFile).toHaveBeenCalled());
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("Use PATH clears the git executable", async () => {
    await seedSettings({ git: { executable: "/custom/git" } });
    await setup();
    expect(screen.getByLabelText("Git executable")).toHaveValue("/custom/git");
    fireEvent.click(screen.getByRole("button", { name: "Use PATH" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ git: { executable: null } }));
    await waitFor(() => expect(screen.getByLabelText("Git executable")).toHaveValue(""));
  });
});

// Contract: the File section shows the settings path, reveals it, and explains outside edits.
describe("SettingsDialog File section", () => {
  it("File section shows the path and Show in folder reveals", async () => {
    await setup();
    const file = screen.getByRole("region", { name: "File" });
    expect(within(file).getByText(SETTINGS_PATH)).toBeInTheDocument();
    expect(
      within(file).getByText("Edits made outside the app apply the next time it starts."),
    ).toBeInTheDocument();
    fireEvent.click(within(file).getByRole("button", { name: "Show in folder" }));
    await waitFor(() => expect(revealSettingsFile).toHaveBeenCalledOnce());
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("the path shows Locating… while pending, Unavailable on failure, the path on success", async () => {
    let resolve!: (path: string) => void;
    vi.mocked(settingsFilePath).mockReturnValue(
      new Promise<string>((res) => {
        resolve = res;
      }),
    );
    const { fallbackFocus } = makeFallback();
    renderWithProviders(<SettingsDialog onClose={vi.fn()} fallbackFocus={fallbackFocus} />);
    const file = screen.getByRole("region", { name: "File" });
    expect(within(file).getByText("Locating…")).toBeInTheDocument();
    await act(async () => resolve(SETTINGS_PATH));
    expect(await within(file).findByText(SETTINGS_PATH)).toBeInTheDocument();
    expect(within(file).queryByText("Locating…")).toBeNull();
  });

  it("the path shows Unavailable when the lookup fails", async () => {
    vi.mocked(settingsFilePath).mockRejectedValue({ kind: "io", message: "no home" });
    const { fallbackFocus } = makeFallback();
    renderWithProviders(<SettingsDialog onClose={vi.fn()} fallbackFocus={fallbackFocus} />);
    const file = screen.getByRole("region", { name: "File" });
    expect(await within(file).findByText("Unavailable")).toBeInTheDocument();
    expect(within(file).queryByText("Locating…")).toBeNull();
  });

  it("a failed Show in folder toasts Couldn't open folder", async () => {
    vi.mocked(revealSettingsFile).mockRejectedValue({ kind: "io", message: "no file manager" });
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    await waitFor(() => expect(hasToast("Couldn't open folder: no file manager")).toBe(true));
    expect(useToasts.getState().toasts[0].variant).toBe("error");
  });
});

// Contract: the section prop focuses the first control of that section.
describe("SettingsDialog section focus", () => {
  it("section git focuses the first control of the Git section", async () => {
    await setup({ section: "git" });
    expect(screen.getByLabelText("Git executable")).toHaveFocus();
  });

  it('section="file" focuses the File section', async () => {
    await setup({ section: "file" });
    expect(screen.getByRole("button", { name: "Show in folder" })).toHaveFocus();
  });

  it("focuses About for section about", async () => {
    await setup({ section: "about" });
    const about = screen.getByRole("region", { name: "About" });
    expect(about.contains(document.activeElement)).toBe(true);
  });

  it("without a section focuses the dialog's first control", async () => {
    await setup();
    expect(screen.getByRole("radio", { name: "System" })).toHaveFocus();
  });
});

// Contract: Keyboard shortcuts… opens the shortcuts dialog.
describe("SettingsDialog keyboard shortcuts button", () => {
  it("Keyboard shortcuts… opens the shortcuts dialog", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts…" }));
    expect(useShell.getState().dialog).toMatchObject({ kind: "shortcuts" });
  });
});

// Contract: Close, the backdrop and Escape close; a composing Escape does not.
describe("SettingsDialog closing", () => {
  it("clicking the backdrop calls onClose", async () => {
    const { onClose } = await setup();
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clicking inside the dialog does not call onClose", async () => {
    const { onClose } = await setup();
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Close calls onClose", async () => {
    const { onClose } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape calls onClose", async () => {
    const { onClose } = await setup();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("a composing Escape does not call onClose", async () => {
    const { onClose } = await setup();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape", isComposing: true } as unknown as KeyboardEventInit);
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    Object.defineProperty(e, "keyCode", { value: 229 });
    dialog.dispatchEvent(e);
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Contract: restores focus to the fallback on unmount.
describe("SettingsDialog focus restoration", () => {
  it("restores focus to the fallback element on unmount", async () => {
    const { div, unmount } = await setup();
    unmount();
    expect(div).toHaveFocus();
  });
});
