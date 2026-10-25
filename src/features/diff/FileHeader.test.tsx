import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings, openExternalDiff, openInEditor } from "../../lib/ipc";
import type { DiffScope, Settings } from "../../lib/ipc";
import { queryClient } from "../../lib/query/client";
import { queryKeys } from "../../lib/query/keys";
import { useShell } from "../../lib/store/shell";
import { useToasts } from "../../lib/store/toasts";
import type { CentreView } from "../../lib/store/workspace";
import { renderWithProviders } from "../../test/renderWithProviders";
import { CloseDiffButton, FileHeader } from "./FileHeader";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(),
  openInEditor: vi.fn(),
  openExternalDiff: vi.fn(),
}));

const defaultSettings: Settings = {
  defaultCloneDir: null,
  gitExecutable: null,
  externalEditor: null,
  externalDiffTool: null,
  externalMergeTool: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  useShell.setState({ dialog: null, repoActions: null });
  useToasts.setState({ toasts: [] });
  vi.mocked(getSettings).mockResolvedValue(defaultSettings);
  vi.mocked(openInEditor).mockResolvedValue(undefined);
  vi.mocked(openExternalDiff).mockResolvedValue(undefined);
});

function setup(
  over: {
    path?: string;
    oldPath?: string | null;
    view?: CentreView;
    blameDisabledReason?: string;
    repoId?: number;
    scope?: DiffScope;
    isStash?: boolean;
  } = {},
) {
  const props = { onViewChange: vi.fn(), onHistory: vi.fn(), onClose: vi.fn() };
  const view = renderWithProviders(
    <FileHeader
      path={over.path ?? "src/a.ts"}
      oldPath={over.oldPath}
      view={over.view ?? "diff"}
      blameDisabledReason={over.blameDisabledReason}
      repoId={over.repoId ?? 1}
      scope={over.scope ?? "unstaged"}
      isStash={over.isStash ?? false}
      {...props}
    />,
  );
  return { ...view, ...props };
}

// Contract: the header names the file, or old → new for a rename.
describe("FileHeader path", () => {
  it("should show the path", () => {
    setup();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
  });

  it("should show old → new as one text for a rename", () => {
    setup({ path: "new.ts", oldPath: "old.ts" });
    expect(screen.getByText("old.ts → new.ts")).toBeInTheDocument();
  });

  it("should show no arrow when oldPath is null", () => {
    const { container } = setup({ oldPath: null });
    expect(container.textContent).not.toContain("→");
  });

  it("should show no arrow when oldPath is omitted", () => {
    const { container } = setup();
    expect(container.textContent).not.toContain("→");
  });
});

// Contract: a radio group named View switches between Diff and Blame.
describe("FileHeader view toggle", () => {
  it("should expose a radiogroup named View with Diff and Blame", () => {
    setup();
    const group = screen.getByRole("radiogroup", { name: "View" });
    expect(group).toContainElement(screen.getByRole("radio", { name: "Diff" }));
    expect(group).toContainElement(screen.getByRole("radio", { name: "Blame" }));
  });

  it("should check Diff when the view is diff", () => {
    setup({ view: "diff" });
    expect(screen.getByRole("radio", { name: "Diff" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Blame" })).not.toBeChecked();
  });

  it("should check Blame when the view is blame", () => {
    setup({ view: "blame" });
    expect(screen.getByRole("radio", { name: "Blame" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Diff" })).not.toBeChecked();
  });

  it("should call onViewChange with blame when Blame is chosen", () => {
    const { onViewChange } = setup({ view: "diff" });
    fireEvent.click(screen.getByRole("radio", { name: "Blame" }));
    expect(onViewChange).toHaveBeenCalledExactlyOnceWith("blame");
  });

  it("should call onViewChange with diff when Diff is chosen", () => {
    const { onViewChange } = setup({ view: "blame" });
    fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
    expect(onViewChange).toHaveBeenCalledExactlyOnceWith("diff");
  });

  it("should not call onViewChange when the checked radio is clicked again", () => {
    const { onViewChange } = setup({ view: "diff" });
    fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
    expect(onViewChange).not.toHaveBeenCalled();
  });
});

// Contract (F17): a reason disables the Blame option and explains itself in its title.
describe("FileHeader blame availability", () => {
  it("should disable the Blame option and title it with the reason when blameDisabledReason is set", () => {
    setup({ blameDisabledReason: "No blame here" });
    expect(screen.getByRole("radio", { name: "Blame" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Blame" }).closest("label")).toHaveAttribute(
      "title",
      "No blame here",
    );
  });

  it("should keep the Diff option enabled when blameDisabledReason is set", () => {
    setup({ blameDisabledReason: "No blame here" });
    expect(screen.getByRole("radio", { name: "Diff" })).toBeEnabled();
  });

  it("should enable both options and set no title without a reason", () => {
    setup();
    expect(screen.getByRole("radio", { name: "Diff" })).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Blame" })).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Blame" }).closest("label")).not.toHaveAttribute(
      "title",
    );
  });
});

// Contract: History opens the file history; Close asks the owner to close the file view.
describe("FileHeader buttons", () => {
  it("should call onHistory once when Show file history is clicked", () => {
    const { onHistory } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Show file history" }));
    expect(onHistory).toHaveBeenCalledOnce();
  });

  it("should label the history button History", () => {
    setup();
    expect(screen.getByRole("button", { name: "Show file history" })).toHaveTextContent("History");
  });

  it("should call onClose once when Close diff is clicked", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Close diff" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should call no callback before any control is used", () => {
    const { onClose, onHistory, onViewChange } = setup();
    expect([onClose, onHistory, onViewChange].every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it("should not call onClose or onViewChange when History is clicked", () => {
    const { onClose, onViewChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Show file history" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onViewChange).not.toHaveBeenCalled();
  });
});

// Contract: CloseDiffButton moved here and keeps its label and click behaviour.
describe("CloseDiffButton", () => {
  it("should render a button named Close diff", () => {
    renderWithProviders(<CloseDiffButton onClick={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Close diff" })).toBeInTheDocument();
  });

  it("should call onClick once when clicked", () => {
    const onClick = vi.fn();
    renderWithProviders(<CloseDiffButton onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Close diff" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

// Task 15: external tool buttons in FileHeader.
describe("FileHeader external tool buttons (GR-14)", () => {
  it("shows Open in editor and External diff for unstaged scope", async () => {
    const { queryClient: qc } = setup({ scope: "unstaged" });
    await waitFor(() => expect(qc.getQueryData(queryKeys.settings)).toBeDefined());
    expect(screen.getByRole("button", { name: "Open in editor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "External diff" })).toBeInTheDocument();
  });

  it("shows Open in editor and External diff for staged scope", async () => {
    const { queryClient: qc } = setup({ scope: "staged" });
    await waitFor(() => expect(qc.getQueryData(queryKeys.settings)).toBeDefined());
    expect(screen.getByRole("button", { name: "Open in editor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "External diff" })).toBeInTheDocument();
  });

  it("hides Open in editor for a commit scope but shows External diff", async () => {
    const { queryClient: qc } = setup({ scope: { commit: "deadbeef" } });
    await waitFor(() => expect(qc.getQueryData(queryKeys.settings)).toBeDefined());
    expect(screen.queryByRole("button", { name: "Open in editor" })).toBeNull();
    expect(screen.getByRole("button", { name: "External diff" })).toBeInTheDocument();
  });

  it("hides both for a stash file", async () => {
    const { queryClient: qc } = setup({ isStash: true });
    await waitFor(() => expect(qc.getQueryData(queryKeys.settings)).toBeDefined());
    expect(screen.queryByRole("button", { name: "Open in editor" })).toBeNull();
    expect(screen.queryByRole("button", { name: "External diff" })).toBeNull();
  });

  it("Open in editor calls openInEditor with the path and repoId when a tool is configured", async () => {
    vi.mocked(getSettings).mockResolvedValue({ ...defaultSettings, externalEditor: "code" });
    const { queryClient: qc } = setup({ path: "src/a.ts", scope: "unstaged" });
    await waitFor(() => expect(qc.getQueryData(queryKeys.settings)).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
    await waitFor(() => expect(openInEditor).toHaveBeenCalledWith("src/a.ts", 1));
  });

  // R18: FileHeader receives repoId from DetailPane and passes it to openInEditor.
  it("Open in editor sends the repo id and the relative path", async () => {
    vi.mocked(getSettings).mockResolvedValue({ ...defaultSettings, externalEditor: "code" });
    const { queryClient: qc } = setup({ path: "src/b.ts", repoId: 5, scope: "unstaged" });
    await waitFor(() => expect(qc.getQueryData(queryKeys.settings)).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
    await waitFor(() => expect(openInEditor).toHaveBeenCalledWith("src/b.ts", 5));
  });

  it("External diff calls openExternalDiff with the external scope when a tool is configured", async () => {
    vi.mocked(getSettings).mockResolvedValue({ ...defaultSettings, externalDiffTool: "meld" });
    const { queryClient: qc } = setup({ repoId: 1, path: "src/a.ts", scope: "staged" });
    await waitFor(() => expect(qc.getQueryData(queryKeys.settings)).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "External diff" }));
    await waitFor(() =>
      expect(openExternalDiff).toHaveBeenCalledWith(1, "src/a.ts", { kind: "staged" }),
    );
  });

  it("an unset editor opens Settings at Tools without a backend call", async () => {
    const { queryClient: qc } = setup({ scope: "unstaged" });
    await waitFor(() => expect(qc.getQueryData(queryKeys.settings)).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
    await waitFor(() =>
      expect(useShell.getState().dialog).toMatchObject({ kind: "settings", section: "tools" }),
    );
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("a rejected diff tool call toasts Couldn't open diff tool: … with Settings…", async () => {
    vi.mocked(getSettings).mockResolvedValue({ ...defaultSettings, externalDiffTool: "meld" });
    vi.mocked(openExternalDiff).mockRejectedValue({
      kind: "externalToolFailed",
      message: "meld exited with code 1",
    });
    const { queryClient: qc } = setup({ scope: "unstaged" });
    await waitFor(() => expect(qc.getQueryData(queryKeys.settings)).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "External diff" }));
    await waitFor(() => {
      const toasts = useToasts.getState().toasts;
      expect(toasts.some((t) => t.text.startsWith("Couldn't open diff tool:"))).toBe(true);
    });
    const toast = useToasts
      .getState()
      .toasts.find((t) => t.text.startsWith("Couldn't open diff tool:"));
    expect(toast?.action?.label).toBe("Settings…");
  });
});
