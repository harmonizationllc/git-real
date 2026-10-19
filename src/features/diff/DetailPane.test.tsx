import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyHunk, getFileContent, getFileDiff } from "../../lib/ipc";
import type { AppError, FileDiff } from "../../lib/ipc";
import { useDiffPrefs } from "../../lib/store/diffPrefs";
import { useWorkspace } from "../../lib/store/workspace";
import { fileDiff, hunk, L } from "../../test/diffFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { DetailPane } from "./DetailPane";
import { FULL_DIFF_LINES } from "./model/limits";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getFileDiff: vi.fn(),
  getFileContent: vi.fn(),
  applyHunk: vi.fn(),
}));
vi.mock("@tanstack/react-virtual", () => import("../../test/mockVirtualizer"));
// Highlighting loads CodeMirror grammars asynchronously; it has its own tests.
vi.mock("./useHighlight", () => ({ useHighlight: () => null }));

// Lines: 0 context, 1 deletion, 2 addition, 3 addition (an uneven hunk in split mode).
const lines = () => [
  L("context", "keep", 1, 1),
  L("deletion", "alpha", 2, null),
  L("addition", "beta", null, 2),
  L("addition", "gamma", null, 3),
];
const textDiff = (extra: Partial<FileDiff> = {}) => fileDiff([hunk(lines())], extra);

const REPO = 1;
const select = (path = "a.ts", scope: "staged" | "unstaged" = "unstaged") =>
  act(() => useWorkspace.getState().select(REPO, { path, scope }));

function setup(path = "a.ts", scope: "staged" | "unstaged" = "unstaged") {
  useWorkspace.getState().select(REPO, { path, scope });
  return renderWithProviders(<DetailPane repoId={REPO} />);
}

const gitError: AppError = { kind: "git", message: "boom" };
const diffRegion = () => screen.findByRole("region", { name: "Diff" });

const createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:1");
const revokeObjectURL = vi.fn<(url: string) => void>();

beforeEach(() => {
  vi.resetAllMocks();
  createObjectURL.mockImplementation(() => "blob:1");
  Object.defineProperty(URL, "createObjectURL", {
    value: createObjectURL,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: revokeObjectURL,
    configurable: true,
    writable: true,
  });
  useWorkspace.setState({ selected: {} });
  useDiffPrefs.setState({ mode: "split", ignoreWhitespace: false });
  vi.mocked(getFileDiff).mockImplementation((_id, path) => Promise.resolve(textDiff({ path })));
  vi.mocked(getFileContent).mockResolvedValue(new ArrayBuffer(2));
  vi.mocked(applyHunk).mockResolvedValue(undefined);
});

// Contract: nothing selected, nothing rendered or fetched; RepoPane decides what shows instead.
describe("DetailPane without a selection", () => {
  it("should render nothing", () => {
    const { container } = renderWithProviders(<DetailPane repoId={REPO} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("should not show the old select-a-file placeholder", () => {
    renderWithProviders(<DetailPane repoId={REPO} />);
    expect(screen.queryByText("Select a file to view its diff")).toBeNull();
  });

  it("should not fetch a diff", () => {
    renderWithProviders(<DetailPane repoId={REPO} />);
    expect(getFileDiff).not.toHaveBeenCalled();
  });

  it("should render nothing for the selection of another repository", () => {
    useWorkspace.getState().select(2, { path: "a.ts", scope: "unstaged" });
    const { container } = renderWithProviders(<DetailPane repoId={REPO} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("should render nothing after the selection is cleared with null", () => {
    useWorkspace.getState().select(REPO, null);
    const { container } = renderWithProviders(<DetailPane repoId={REPO} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// Contract: loading, then the toolbar and the viewer.
describe("DetailPane loading and success", () => {
  it("should show a loading status while the diff is fetched", () => {
    vi.mocked(getFileDiff).mockReturnValue(new Promise(() => undefined));
    setup();
    expect(screen.getByRole("status")).toHaveTextContent("Loading diff…");
  });

  it("should fetch the selected file with the current preferences", async () => {
    setup("a.ts", "staged");
    await diffRegion();
    expect(getFileDiff).toHaveBeenCalledWith(REPO, "a.ts", "staged", false, undefined);
  });

  it("should render the viewer region after loading", async () => {
    setup();
    expect(await diffRegion()).toBeInTheDocument();
  });

  it("should render the toolbar after loading", async () => {
    setup();
    await diffRegion();
    expect(screen.getByRole("radiogroup", { name: "View mode" })).toBeInTheDocument();
  });

  it("should drop the loading status once the diff is shown", async () => {
    setup();
    await diffRegion();
    expect(screen.queryByText("Loading diff…")).toBeNull();
  });
});

// Contract: noChanges is a state whose wording follows the scope.
describe("DetailPane no changes", () => {
  const noChanges: AppError = { kind: "noChanges", message: "no changes" };

  it("should say there are no unstaged changes in the file", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(noChanges);
    setup("a.ts", "unstaged");
    expect(await screen.findByText("No unstaged changes in a.ts")).toBeInTheDocument();
  });

  it("should say there are no staged changes when the scope is staged", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(noChanges);
    setup("a.ts", "staged");
    expect(await screen.findByText("No staged changes in a.ts")).toBeInTheDocument();
  });

  it("should offer to turn off whitespace hiding when it is on", async () => {
    useDiffPrefs.setState({ ignoreWhitespace: true });
    vi.mocked(getFileDiff).mockRejectedValue(noChanges);
    setup();
    await screen.findByText("No unstaged changes in a.ts");
    expect(screen.getByRole("checkbox", { name: "Hide whitespace changes" })).toBeChecked();
  });

  it("should turn whitespace hiding off from the empty state", async () => {
    useDiffPrefs.setState({ ignoreWhitespace: true });
    vi.mocked(getFileDiff).mockRejectedValue(noChanges);
    setup();
    await screen.findByText("No unstaged changes in a.ts");
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide whitespace changes" }));
    expect(useDiffPrefs.getState().ignoreWhitespace).toBe(false);
  });

  it("should refetch without ignoreWhitespace after turning it off from the empty state", async () => {
    useDiffPrefs.setState({ ignoreWhitespace: true });
    vi.mocked(getFileDiff).mockRejectedValue(noChanges);
    setup();
    await screen.findByText("No unstaged changes in a.ts");
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide whitespace changes" }));
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenLastCalledWith(REPO, "a.ts", "unstaged", false, undefined),
    );
  });

  it("should render no whitespace control in the plain empty state", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(noChanges);
    setup();
    await screen.findByText("No unstaged changes in a.ts");
    expect(screen.queryByRole("checkbox", { name: "Hide whitespace changes" })).toBeNull();
  });

  it("should not show an alert for noChanges", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(noChanges);
    setup();
    await screen.findByText("No unstaged changes in a.ts");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract: a load error offers Retry and Dismiss; Dismiss returns to the empty state.
describe("DetailPane load errors", () => {
  it("should show the message in an alert", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("should refetch when Retry is clicked", async () => {
    vi.mocked(getFileDiff).mockRejectedValueOnce(gitError);
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledTimes(2));
  });

  it("should show the diff when Retry succeeds", async () => {
    vi.mocked(getFileDiff).mockRejectedValueOnce(gitError);
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await diffRegion()).toBeInTheDocument();
  });

  it("should drop the alert when Dismiss is clicked", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should clear the workspace selection when Dismiss is clicked", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(useWorkspace.getState().selected[REPO]).toBeNull();
  });

  it("should not refetch when Dismiss is clicked", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(getFileDiff).toHaveBeenCalledTimes(1);
  });

  it("should not show a viewer next to a load error", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    setup();
    await screen.findByRole("alert");
    expect(screen.queryByRole("region", { name: "Diff" })).toBeNull();
  });

  it("should show the next file's diff after a load error on the previous file", async () => {
    vi.mocked(getFileDiff).mockRejectedValueOnce(gitError);
    setup("a.ts");
    await screen.findByRole("alert");
    select("b.ts");
    expect(await diffRegion()).toBeInTheDocument();
  });
});

// Contract: binary files preview as images or show a placeholder.
describe("DetailPane binary files", () => {
  it("should preview a binary image path with the image diff", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([], { path: "logo.png", isBinary: true, change: "added" }),
    );
    setup("logo.png");
    expect(await screen.findByAltText("New image")).toBeInTheDocument();
  });

  it("should show the placeholder for a binary file that is not an image", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([], { path: "blob.bin", isBinary: true, change: "modified" }),
    );
    setup("blob.bin");
    expect(await screen.findByText("Binary file — no preview available")).toBeInTheDocument();
  });

  it("should not render the viewer for a binary file", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([], { path: "blob.bin", isBinary: true, change: "modified" }),
    );
    setup("blob.bin");
    await screen.findByText("Binary file — no preview available");
    expect(screen.queryByRole("region", { name: "Diff" })).toBeNull();
  });
});

// Contract: diffs without hunks explain themselves and keep the toolbar.
describe("DetailPane zero-hunk diffs", () => {
  it("should say only the encoding changed for a decoded diff without hunks", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([], { oldEncoding: "utf16Le", newEncoding: "utf8" }),
    );
    setup();
    expect(await screen.findByText("Only the encoding changed")).toBeInTheDocument();
  });

  it("should show the encoding notice in the toolbar for a decoded diff without hunks", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([], { oldEncoding: "utf16Le", newEncoding: "utf16Le" }),
    );
    setup();
    expect(await screen.findByTestId("encoding-notice")).toBeInTheDocument();
  });

  it("should offer no hunk buttons for a decoded diff without hunks", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([], { oldEncoding: "utf16Le", newEncoding: "utf8" }),
    );
    setup();
    await screen.findByText("Only the encoding changed");
    expect(screen.queryByRole("button", { name: /hunk/ })).toBeNull();
  });

  it("should say there are no line changes for an ordinary diff without hunks", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(fileDiff([]));
    setup();
    expect(await screen.findByText("No line changes in this file")).toBeInTheDocument();
  });

  it("should keep the toolbar for an ordinary diff without hunks", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(fileDiff([]));
    setup();
    await screen.findByText("No line changes in this file");
    expect(screen.getByRole("radiogroup", { name: "View mode" })).toBeInTheDocument();
  });

  it("should not say only the encoding changed for an ordinary diff without hunks", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(fileDiff([]));
    setup();
    await screen.findByText("No line changes in this file");
    expect(screen.queryByText("Only the encoding changed")).toBeNull();
  });
});

// Contract: hunk actions are disabled, with a reason, when the diff cannot be applied safely.
describe("DetailPane disabled hunk actions", () => {
  it("should disable every hunk button with the UTF-16 reason for a decoded diff", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      textDiff({ oldEncoding: "utf16Le", newEncoding: "utf16Le" }),
    );
    setup();
    await diffRegion();
    const buttons = screen.getAllByRole("button", { name: /hunk/ });
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b).toBeDisabled();
      expect(b.getAttribute("title")).toMatch(/UTF-16/);
    }
  });

  it("should disable every hunk button with the whitespace reason when whitespace is hidden", async () => {
    useDiffPrefs.setState({ ignoreWhitespace: true });
    setup();
    await diffRegion();
    const buttons = screen.getAllByRole("button", { name: /hunk/ });
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b).toBeDisabled();
      expect(b.getAttribute("title")).toMatch(/Hide whitespace changes/);
    }
  });

  it("should fetch with ignoreWhitespace true when the whitespace preference is on", async () => {
    useDiffPrefs.setState({ ignoreWhitespace: true });
    setup();
    await diffRegion();
    expect(getFileDiff).toHaveBeenCalledWith(REPO, "a.ts", "unstaged", true, undefined);
  });

  it("should refetch with ignoreWhitespace true when the checkbox is ticked", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide whitespace changes" }));
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenLastCalledWith(REPO, "a.ts", "unstaged", true, undefined),
    );
  });

  it("should enable the hunk buttons for an ordinary diff", async () => {
    setup();
    await diffRegion();
    expect(screen.getByRole("button", { name: "Stage hunk" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard hunk…" })).toBeEnabled();
  });

  it("should disable every hunk button while an action is pending", async () => {
    vi.mocked(applyHunk).mockReturnValue(new Promise(() => undefined));
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stage hunk" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Discard hunk…" })).toBeDisabled();
  });

  it("should apply a repeated hunk click only once while the action is pending", async () => {
    vi.mocked(applyHunk).mockReturnValue(new Promise(() => undefined));
    setup();
    await diffRegion();
    const stage = screen.getByRole("button", { name: "Stage hunk" });
    fireEvent.click(stage);
    await waitFor(() => expect(stage).toBeDisabled());
    fireEvent.click(stage);
    expect(applyHunk).toHaveBeenCalledTimes(1);
  });
});

// Contract: stage and unstage send the hunk or the selected lines.
describe("DetailPane staging", () => {
  it("should stage the whole hunk", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    await waitFor(() =>
      expect(applyHunk).toHaveBeenCalledWith(REPO, "a.ts", "stage", { hunkIndex: 0, lines: null }),
    );
  });

  it("should unstage the whole hunk of a staged file", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(textDiff({ scope: "staged" }));
    setup("a.ts", "staged");
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Unstage hunk" }));
    await waitFor(() =>
      expect(applyHunk).toHaveBeenCalledWith(REPO, "a.ts", "unstage", {
        hunkIndex: 0,
        lines: null,
      }),
    );
  });

  it("should stage the two selected lines", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Select removed line 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Select added line 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage 2 lines" }));
    await waitFor(() =>
      expect(applyHunk).toHaveBeenCalledWith(REPO, "a.ts", "stage", {
        hunkIndex: 0,
        lines: [1, 2],
      }),
    );
  });
});

// Contract: discard asks first, and the copy follows the selection.
describe("DetailPane discard", () => {
  const dialog = () => screen.getByRole("dialog", { name: "Discard changes" });

  it("should open the confirm dialog with the hunk copy", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Discard hunk…" }));
    expect(dialog()).toHaveTextContent("Discard this hunk in a.ts? This cannot be undone.");
  });

  it("should not apply anything until the user confirms", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Discard hunk…" }));
    expect(applyHunk).not.toHaveBeenCalled();
  });

  it("should call nothing and close the dialog when Cancel is clicked", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Discard hunk…" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(applyHunk).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should discard the whole hunk when Discard is confirmed", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Discard hunk…" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(applyHunk).toHaveBeenCalledWith(REPO, "a.ts", "discard", {
        hunkIndex: 0,
        lines: null,
      }),
    );
  });

  it("should close the dialog once Discard is confirmed", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Discard hunk…" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should use the selected-lines copy for two selected lines", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Select removed line 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Select added line 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard 2 lines…" }));
    expect(dialog()).toHaveTextContent("Discard 2 selected lines in a.ts? This cannot be undone.");
  });

  it("should use the singular copy for one selected line", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Select removed line 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard 1 line…" }));
    expect(dialog()).toHaveTextContent("Discard 1 selected line in a.ts? This cannot be undone.");
  });

  it("should discard the selected lines when confirmed", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Select removed line 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Select added line 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard 2 lines…" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(applyHunk).toHaveBeenCalledWith(REPO, "a.ts", "discard", {
        hunkIndex: 0,
        lines: [1, 2],
      }),
    );
  });
});

// Contract: a discard confirmation never applies to a diff other than the one it was opened on.
describe("DetailPane stale discard", () => {
  const changed = fileDiff([
    hunk([L("deletion", "other", 2, null), L("addition", "else", null, 2)]),
  ]);

  async function openDialog() {
    const view = setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Discard hunk…" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    return view;
  }

  it("should close the dialog when the diff changes underneath it", async () => {
    const { queryClient } = await openDialog();
    vi.mocked(getFileDiff).mockResolvedValue(changed);
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("should not apply anything after the diff changed under an open dialog", async () => {
    const { queryClient } = await openDialog();
    vi.mocked(getFileDiff).mockResolvedValue(changed);
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(applyHunk).not.toHaveBeenCalled();
  });

  it("should keep the dialog open when a refetch returns an identical diff", async () => {
    const { queryClient } = await openDialog();
    vi.mocked(getFileDiff).mockResolvedValue(textDiff());
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("should close the dialog when another file is selected", async () => {
    await openDialog();
    select("b.ts");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

// Contract: an action failure shows above the viewer and can be dismissed.
describe("DetailPane action errors", () => {
  const badSelection: AppError = { kind: "badSelection", message: "The diff changed" };

  it("should show the failure in an alert", async () => {
    vi.mocked(applyHunk).mockRejectedValue(badSelection);
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The diff changed");
  });

  it("should keep the viewer visible next to the alert", async () => {
    vi.mocked(applyHunk).mockRejectedValue(badSelection);
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("region", { name: "Diff" })).toBeInTheDocument();
  });

  it("should place the alert above the viewer", async () => {
    vi.mocked(applyHunk).mockRejectedValue(badSelection);
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    const alert = await screen.findByRole("alert");
    const region = screen.getByRole("region", { name: "Diff" });
    expect(alert.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("should remove the alert when Dismiss is clicked", async () => {
    vi.mocked(applyHunk).mockRejectedValue(badSelection);
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    fireEvent.click(
      await within(await screen.findByRole("alert")).findByRole("button", { name: "Dismiss" }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("should keep the viewer after the alert is dismissed", async () => {
    vi.mocked(applyHunk).mockRejectedValue(badSelection);
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    fireEvent.click(
      await within(await screen.findByRole("alert")).findByRole("button", { name: "Dismiss" }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("region", { name: "Diff" })).toBeInTheDocument();
  });

  it("should clear the action error when another file is selected", async () => {
    vi.mocked(applyHunk).mockRejectedValue(badSelection);
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    await screen.findByRole("alert");
    select("b.ts");
    await diffRegion();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

// Contract: "Load full diff" lifts the line cap for this file only.
describe("DetailPane truncated diffs", () => {
  it("should offer Load full diff for a truncated diff", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(textDiff({ truncated: true }));
    setup();
    expect(await screen.findByRole("button", { name: "Load full diff" })).toBeInTheDocument();
  });

  it("should refetch with the full line limit when Load full diff is clicked", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(textDiff({ truncated: true }));
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Load full diff" }));
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenLastCalledWith(
        REPO,
        "a.ts",
        "unstaged",
        false,
        FULL_DIFF_LINES,
      ),
    );
  });

  it("should not fetch the next file with the full line limit", async () => {
    vi.mocked(getFileDiff).mockImplementation((_id, path) =>
      Promise.resolve(textDiff({ path, truncated: true })),
    );
    setup("a.ts");
    fireEvent.click(await screen.findByRole("button", { name: "Load full diff" }));
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenLastCalledWith(
        REPO,
        "a.ts",
        "unstaged",
        false,
        FULL_DIFF_LINES,
      ),
    );
    select("b.ts");
    await screen.findByText("b.ts");
    const forB = vi.mocked(getFileDiff).mock.calls.filter((c) => c[1] === "b.ts");
    expect(forB.length).toBeGreaterThan(0);
    for (const call of forB) expect(call[4]).toBeUndefined();
  });
});

// Contract: line selection belongs to one diff and never carries to another file.
describe("DetailPane selection reset", () => {
  it("should press the gutter that was clicked", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Select added line 2" }));
    expect(screen.getByRole("button", { name: "Select added line 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("should not press the same gutter after another file is selected", async () => {
    setup("a.ts");
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Select added line 2" }));
    select("b.ts");
    await screen.findByText("b.ts");
    expect(await screen.findByRole("button", { name: "Select added line 2" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

// Contract: the mode radios switch the row layout and persist the preference.
describe("DetailPane view mode", () => {
  const count = (container: HTMLElement, kind: string) =>
    container.querySelectorAll(`[data-kind="${kind}"]`).length;

  it("should render side by side cells by default, including an empty cell for an uneven hunk", async () => {
    const { container } = setup();
    await diffRegion();
    expect(count(container, "empty")).toBeGreaterThan(0);
  });

  it("should render no empty cells after switching to unified", async () => {
    const { container } = setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("radio", { name: "Unified" }));
    await waitFor(() => expect(count(container, "empty")).toBe(0));
  });

  it("should render empty cells again after switching back to side by side", async () => {
    useDiffPrefs.setState({ mode: "unified" });
    const { container } = setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("radio", { name: "Side by side" }));
    await waitFor(() => expect(count(container, "empty")).toBeGreaterThan(0));
  });

  it("should keep the number of hunk headers when the mode changes", async () => {
    const { container } = setup();
    await diffRegion();
    const before = count(container, "header");
    fireEvent.click(screen.getByRole("radio", { name: "Unified" }));
    await waitFor(() => expect(count(container, "empty")).toBe(0));
    expect(count(container, "header")).toBe(before);
  });

  it("should store the chosen mode in the preferences", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("radio", { name: "Unified" }));
    expect(useDiffPrefs.getState().mode).toBe("unified");
  });

  it("should not refetch the diff when the mode changes", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("radio", { name: "Unified" }));
    expect(getFileDiff).toHaveBeenCalledTimes(1);
  });
});

// Contract: the disabled-reason text is exact, follows the preference live and wins in order.
describe("DetailPane disabled reason text", () => {
  const WHITESPACE = "Turn off “Hide whitespace changes” to stage, unstage or discard hunks";
  const DECODED =
    "Hunk actions are unavailable for files decoded from UTF-16 or UTF-32; stage or discard the whole file from the Changes panel";

  it("should give every hunk button the exact whitespace reason", async () => {
    useDiffPrefs.setState({ ignoreWhitespace: true });
    setup();
    await diffRegion();
    for (const b of screen.getAllByRole("button", { name: /hunk/ })) {
      expect(b).toHaveAttribute("title", WHITESPACE);
    }
  });

  it("should give every hunk button the exact decoded reason", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      textDiff({ oldEncoding: "utf32Be", newEncoding: "utf32Be" }),
    );
    setup();
    await diffRegion();
    for (const b of screen.getAllByRole("button", { name: /hunk/ })) {
      expect(b).toHaveAttribute("title", DECODED);
    }
  });

  it("should prefer the whitespace reason over the decoded reason", async () => {
    useDiffPrefs.setState({ ignoreWhitespace: true });
    vi.mocked(getFileDiff).mockResolvedValue(
      textDiff({ oldEncoding: "utf16Le", newEncoding: "utf16Le" }),
    );
    setup();
    await diffRegion();
    for (const b of screen.getAllByRole("button", { name: /hunk/ })) {
      expect(b).toHaveAttribute("title", WHITESPACE);
    }
  });

  it("should disable the hunk buttons with the whitespace reason once the box is ticked", async () => {
    setup();
    await diffRegion();
    expect(screen.getByRole("button", { name: "Stage hunk" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide whitespace changes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stage hunk" })).toBeDisabled());
    for (const b of screen.getAllByRole("button", { name: /hunk/ })) {
      expect(b).toHaveAttribute("title", WHITESPACE);
    }
    expect(getFileDiff).toHaveBeenLastCalledWith(REPO, "a.ts", "unstaged", true, undefined);
  });

  it("should re-enable the hunk buttons when the box is unticked again", async () => {
    useDiffPrefs.setState({ ignoreWhitespace: true });
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide whitespace changes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stage hunk" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Stage hunk" })).not.toHaveAttribute("title");
  });

  it("should show the pending reason while an action runs", async () => {
    vi.mocked(applyHunk).mockReturnValue(new Promise(() => undefined));
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stage hunk" })).toHaveAttribute(
        "title",
        "Applying changes…",
      ),
    );
  });

  it("should not apply an action through a button disabled for whitespace", async () => {
    useDiffPrefs.setState({ ignoreWhitespace: true });
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard hunk…" }));
    expect(applyHunk).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// Contract: dialogs and action errors belong to one file and do not follow the user away.
describe("DetailPane per-file transient state", () => {
  const dialog = () => screen.queryByRole("dialog", { name: "Discard changes" });

  it("should not reopen a discard dialog when returning to the file it was opened on", async () => {
    setup("a.ts");
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Discard hunk…" }));
    expect(dialog()).not.toBeNull();
    select("b.ts");
    await screen.findByText("b.ts");
    select("a.ts");
    await screen.findByText("a.ts");
    expect(dialog()).toBeNull();
    expect(applyHunk).not.toHaveBeenCalled();
  });

  it("should discard nothing when the file is switched while the dialog is open", async () => {
    setup("a.ts");
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Discard hunk…" }));
    select("b.ts");
    await waitFor(() => expect(dialog()).toBeNull());
    expect(applyHunk).not.toHaveBeenCalled();
  });

  it("should leave no alert after a failed action is dismissed and the next action succeeds", async () => {
    vi.mocked(applyHunk).mockRejectedValueOnce({
      kind: "badSelection",
      message: "The diff changed",
    });
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    fireEvent.click(
      await within(await screen.findByRole("alert")).findByRole("button", { name: "Dismiss" }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    await waitFor(() => expect(applyHunk).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should clear a stale action error when a later action succeeds", async () => {
    vi.mocked(applyHunk).mockRejectedValueOnce({
      kind: "badSelection",
      message: "The diff changed",
    });
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    await waitFor(() => expect(applyHunk).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("should show only the action error, with no Retry, above the viewer", async () => {
    vi.mocked(applyHunk).mockRejectedValue({ kind: "badSelection", message: "The diff changed" });
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

// Contract: "Only the encoding changed" needs two different encodings; otherwise nothing changed in lines.
describe("DetailPane decoded zero-hunk copy", () => {
  it.each<[string, Partial<FileDiff>]>([
    ["equal encodings", { oldEncoding: "utf16Le", newEncoding: "utf16Le" }],
    ["only the old side decoded", { oldEncoding: "utf16Le", newEncoding: null }],
    ["only the new side decoded", { oldEncoding: null, newEncoding: "utf16Be" }],
  ])("should say no line changes when %s", async (_name, extra) => {
    vi.mocked(getFileDiff).mockResolvedValue(fileDiff([], extra));
    setup();
    expect(await screen.findByText("No line changes in this file")).toBeInTheDocument();
    expect(screen.queryByText("Only the encoding changed")).toBeNull();
  });

  it("should say the encoding changed when both sides differ", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([], { oldEncoding: "utf16Le", newEncoding: "utf32Le" }),
    );
    setup();
    expect(await screen.findByText("Only the encoding changed")).toBeInTheDocument();
  });
});

// Contract: the last hunk of a truncated diff is partial, so its whole-hunk buttons are off until the full diff loads.
describe("DetailPane truncated last hunk", () => {
  const LOAD = "Load the full diff to stage, unstage or discard this hunk";
  const twoHunks = (truncated: boolean) =>
    fileDiff(
      [
        hunk([L("deletion", "a1", 1, null), L("addition", "a2", null, 1)], "@@ -1 +1 @@"),
        hunk([L("deletion", "b1", 9, null), L("addition", "b2", null, 9)], "@@ -9 +9 @@"),
      ],
      { truncated },
    );

  it("should disable the last hunk's buttons until the full diff is loaded, then enable them", async () => {
    vi.mocked(getFileDiff).mockImplementation((_id, _p, _s, _w, max) =>
      Promise.resolve(twoHunks(max === undefined)),
    );
    setup();
    await diffRegion();
    const stage = screen.getAllByRole("button", { name: "Stage hunk" });
    expect(stage[0]).toBeEnabled();
    expect(stage[1]).toBeDisabled();
    expect(stage[1]).toHaveAttribute("title", LOAD);
    fireEvent.click(screen.getByRole("button", { name: "Load full diff" }));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Stage hunk" })[1]).toBeEnabled(),
    );
  });
});

// Contract: every state of the pane offers Close diff, which clears the file selection.
describe("DetailPane Close diff", () => {
  const closeButton = () => screen.findByRole("button", { name: "Close diff" });
  const expectClosed = () => expect(useWorkspace.getState().selected[REPO]).toBeNull();

  it("should offer Close diff while the diff is loading", async () => {
    vi.mocked(getFileDiff).mockReturnValue(new Promise(() => undefined));
    setup();
    fireEvent.click(await closeButton());
    expectClosed();
  });

  it("should offer Close diff when there are no changes", async () => {
    vi.mocked(getFileDiff).mockRejectedValue({ kind: "noChanges", message: "no changes" });
    setup();
    await screen.findByText("No unstaged changes in a.ts");
    fireEvent.click(await closeButton());
    expectClosed();
  });

  it("should offer Close diff for a binary file without a preview", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([], { path: "blob.bin", isBinary: true, change: "modified" }),
    );
    setup("blob.bin");
    await screen.findByText("Binary file — no preview available");
    fireEvent.click(await closeButton());
    expectClosed();
  });

  it("should offer Close diff when the diff has no line changes", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(fileDiff([]));
    setup();
    await screen.findByText("No line changes in this file");
    fireEvent.click(await closeButton());
    expectClosed();
  });

  it("should offer Close diff in the toolbar of a loaded diff", async () => {
    setup();
    await diffRegion();
    fireEvent.click(await closeButton());
    expectClosed();
  });

  it("should offer Close diff for a binary image preview", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([], { path: "logo.png", isBinary: true, change: "added" }),
    );
    setup("logo.png");
    await screen.findByAltText("New image");
    fireEvent.click(await closeButton());
    expectClosed();
  });

  it("should offer exactly one Close diff for the empty-hunks state", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(fileDiff([]));
    setup();
    await screen.findByText("No line changes in this file");
    expect(screen.getByRole("button", { name: "Close diff" })).toBeInTheDocument();
  });

  it("should keep the loading Close diff button outside the status region", async () => {
    vi.mocked(getFileDiff).mockReturnValue(new Promise(() => undefined));
    setup();
    const button = await closeButton();
    expect(screen.getByRole("status")).not.toContainElement(button);
  });

  it("should offer Close diff alongside Dismiss on a load error", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    setup();
    await screen.findByRole("alert");
    fireEvent.click(await closeButton());
    expectClosed();
  });

  it("should offer Dismiss on a load error and clear the selection", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expectClosed();
  });

  it("should render nothing once Close diff has cleared the selection", async () => {
    setup();
    await diffRegion();
    fireEvent.click(await closeButton());
    expect(screen.queryByRole("region", { name: "Diff" })).toBeNull();
  });

  it("should offer exactly one Close diff button in the loaded state", async () => {
    setup();
    await diffRegion();
    expect(screen.getAllByRole("button", { name: "Close diff" })).toHaveLength(1);
  });

  it("should not clear another repository's selection", async () => {
    useWorkspace.getState().select(2, { path: "z.ts", scope: "staged" });
    vi.mocked(getFileDiff).mockResolvedValue(fileDiff([]));
    setup();
    await screen.findByText("No line changes in this file");
    fireEvent.click(await closeButton());
    expect(useWorkspace.getState().selected[2]).toEqual({ path: "z.ts", scope: "staged" });
  });

  it("should not offer Close diff when nothing is selected", () => {
    renderWithProviders(<DetailPane repoId={REPO} />);
    expect(screen.queryByRole("button", { name: "Close diff" })).toBeNull();
  });
});
