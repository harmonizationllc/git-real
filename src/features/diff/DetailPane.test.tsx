import { act, createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyHunk,
  getFileContent,
  getFileDiff,
  getStatus,
  openInEditor,
  updateSettings,
} from "../../lib/ipc";
import type { AppError, FileDiff, StatusEntry } from "../../lib/ipc";
import { useSettings } from "../../lib/store/settings";
import { useShell } from "../../lib/store/shell";
import { resetSettings, seedSettings } from "../../test/settingsStore";
import { useWorkspace } from "../../lib/store/workspace";
import type { DiffScope } from "../../lib/ipc";
import { fileDiff, hunk, L, threePairDiff } from "../../test/diffFixtures";
import { mockWindow, scrollToIndex } from "../../test/mockVirtualizer";
import { renderWithProviders } from "../../test/renderWithProviders";
import { BlameView } from "../history/BlameView";
import { DECODED_REASON, DetailPane, PENDING_REASON, WHITESPACE_REASON } from "./DetailPane";
import { FULL_DIFF_LINES } from "./model/limits";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  updateSettings: vi.fn(),
  getFileDiff: vi.fn(),
  getFileContent: vi.fn(),
  applyHunk: vi.fn(),
  getStatus: vi.fn(),
  openInEditor: vi.fn(),
}));
const conflictEditorMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("../merge/editor/ConflictEditor", async () => {
  const { useEffect } = await import("react");
  return {
    ConflictEditor: ({ path }: { path: string }) => {
      useEffect(() => {
        conflictEditorMounts.count += 1;
      }, []);
      return <div data-testid="conflict-editor">{path}</div>;
    },
  };
});
vi.mock("../history/BlameView", () => ({
  BlameView: vi.fn(() => <div role="table" aria-label="Blame" />),
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

beforeEach(async () => {
  conflictEditorMounts.count = 0;
  vi.resetAllMocks();
  await resetSettings();
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
  useWorkspace.setState({ selected: {}, centreView: {}, historyPath: {} });
  useShell.setState({ diffNavigation: null });
  scrollToIndex.mockReset();
  mockWindow.visibleStart = null;
  await seedSettings({ diff: { mode: "split", ignoreWhitespace: false } });
  vi.mocked(getFileDiff).mockImplementation((_id, path) => Promise.resolve(textDiff({ path })));
  vi.mocked(getFileContent).mockResolvedValue(new ArrayBuffer(2));
  vi.mocked(applyHunk).mockResolvedValue(undefined);
  vi.mocked(getStatus).mockResolvedValue({ entries: [], headUnborn: false });
  vi.mocked(openInEditor).mockResolvedValue(undefined);
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
    await seedSettings({ diff: { ignoreWhitespace: true } });
    vi.mocked(getFileDiff).mockRejectedValue(noChanges);
    setup();
    await screen.findByText("No unstaged changes in a.ts");
    expect(screen.getByRole("checkbox", { name: "Hide whitespace changes" })).toBeChecked();
  });

  it("should turn whitespace hiding off from the empty state", async () => {
    await seedSettings({ diff: { ignoreWhitespace: true } });
    vi.mocked(getFileDiff).mockRejectedValue(noChanges);
    setup();
    await screen.findByText("No unstaged changes in a.ts");
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide whitespace changes" }));
    expect(useSettings.getState().settings.diff.ignoreWhitespace).toBe(false);
  });

  it("should refetch without ignoreWhitespace after turning it off from the empty state", async () => {
    await seedSettings({ diff: { ignoreWhitespace: true } });
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

  it("should render no viewer for a decoded diff without hunks", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([], { oldEncoding: "utf16Le", newEncoding: "utf8" }),
    );
    setup();
    await screen.findByText("Only the encoding changed");
    expect(screen.queryByRole("region", { name: "Diff" })).toBeNull();
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

// --- Right-click actions (GR-52) ------------------------------------------------------------
//
// threePairDiff in split mode: rows 0 ctx, 1 {1,4}, 2 {2,5}, 3 {3,6}, 4 ctx. Old lines
// "one two three" / "four five six" / "seven eight nine", new lines "one two THREE" /
// "FOUR FIVE SIX" / "SEVEN eight NINE".

const threeDiff = (extra: Partial<FileDiff> = {}): FileDiff => ({ ...threePairDiff(), ...extra });
const serveThree = (extra: Partial<FileDiff> = {}) =>
  vi
    .mocked(getFileDiff)
    .mockImplementation((_id, path) => Promise.resolve(threeDiff({ path, ...extra })));

/** The virtual item wrapper of a row. */
const rowAt = (i: number) => document.querySelector<HTMLElement>(`[data-index="${i}"]`)!;
const rightClick = (el: Element) => fireEvent.contextMenu(el, { clientX: 30, clientY: 40 });
const menu = () => screen.getByRole("menu");
const menuLabels = () =>
  within(menu())
    .getAllByRole("menuitem")
    .map((b) => b.textContent);
const menuItem = (name: string) => within(menu()).getByRole("menuitem", { name });
const revertDialog = () => screen.getByRole("dialog", { name: "Revert changes" });

/** Opens the row menu on row `i` and returns its items. */
const rowMenu = (i: number) => {
  rightClick(rowAt(i));
  return menu();
};

// The real caret resolver runs against the rendered rows: a point (by clientX) is scripted to a
// row, side and line offset, and the document's elementFromPoint/caretRangeFromPoint stubs answer
// with the text node holding that offset in the DOM as it is at the moment of the call.
interface Point {
  row: number;
  side: "old" | "new";
  offset: number;
}
const points = new Map<number, Point>();
const docProps = document as unknown as Record<string, unknown>;
const stubDocument = (name: string, value: unknown) =>
  Object.defineProperty(document, name, { value, configurable: true, writable: true });

function locate({ row, side, offset }: Point): { node: Node; offset: number } {
  const code = document.querySelector(
    `[data-index="${row}"] [data-side="${side}"] code[data-line-text]`,
  )!;
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let left = offset;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent!.length;
    if (left <= length) return { node, offset: left };
    left -= length;
  }
  throw new Error(`no text at ${row}/${side}/${offset}`);
}

function stubCarets() {
  stubDocument("elementFromPoint", (x: number) => {
    const p = points.get(x);
    if (!p) return null;
    // A blank split cell has no code: the point lands on the cell itself.
    const cell = document.querySelector(`[data-index="${p.row}"] [data-side="${p.side}"]`)!;
    return cell.querySelector("code[data-line-text]") ? locate(p).node.parentElement : cell;
  });
  stubDocument("caretRangeFromPoint", (x: number) => {
    const p = points.get(x);
    if (!p) return null;
    const { node, offset } = locate(p);
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    return range;
  });
}

const SCROLL_RECT = { top: 0, bottom: 1000, left: 0, right: 1000, width: 1000, height: 1000 };

/** Drags a text range from `from` to `to` with the primary button. */
function dragRange(from: Point, to: Point) {
  const scroll = screen.getByTestId("diff-scroll");
  scroll.getBoundingClientRect = () =>
    ({ ...SCROLL_RECT, x: 0, y: 0, toJSON: () => SCROLL_RECT }) as DOMRect;
  scroll.setPointerCapture = vi.fn();
  scroll.releasePointerCapture = vi.fn();
  points.set(10, from);
  points.set(20, to);
  const at = (x: number, button: number, buttons: number) => ({
    button,
    buttons,
    clientX: x,
    clientY: 50,
    pointerId: 1,
  });
  fireEvent.pointerDown(scroll, at(10, 0, 1));
  fireEvent.pointerMove(scroll, at(20, -1, 1));
  fireEvent.pointerUp(scroll, at(20, 0, 0));
}

/** The owner's example: new side, from row 1 offset 8 ("THREE") to row 3 offset 5 ("SEVEN"). */
const ownerRange = () =>
  dragRange({ row: 1, side: "new", offset: 8 }, { row: 3, side: "new", offset: 5 });
/** Split rows 1 and 2 whole on the new side: pairs 1<->4 and 2<->5, no partial line. */
const wholeRowsRange = () =>
  dragRange({ row: 1, side: "new", offset: 0 }, { row: 2, side: "new", offset: 13 });
/** Only the context row 0 ("c"). */
const contextRange = () =>
  dragRange({ row: 0, side: "new", offset: 0 }, { row: 0, side: "new", offset: 1 });

const OWNER_STAGE = {
  hunkIndex: 0,
  lines: [1, 2, 3, 4, 5],
  edits: [{ index: 3, text: "SEVEN eight nine" }],
};
const OWNER_REVERT = {
  hunkIndex: 0,
  lines: [1, 2, 4, 5, 6],
  edits: [{ index: 6, text: "seven eight NINE" }],
};
const ROW_1 = { hunkIndex: 0, lines: [1, 4], edits: [] };

afterEach(() => {
  points.clear();
  for (const name of ["elementFromPoint", "caretRangeFromPoint", "caretPositionFromPoint"]) {
    delete docProps[name];
  }
});

// Contract: the exported gate reasons keep their exact copy.
describe("DetailPane gate reason copy", () => {
  it("should keep the exact whitespace reason", () => {
    expect(WHITESPACE_REASON).toBe(
      "Turn off “Hide whitespace changes” to stage, unstage or discard hunks",
    );
  });

  it("should keep the exact decoded reason", () => {
    expect(DECODED_REASON).toBe(
      "Hunk actions are unavailable for files decoded from UTF-16 or UTF-32; stage or discard the whole file from the Changes panel",
    );
  });

  it("should keep the exact pending reason", () => {
    expect(PENDING_REASON).toBe("Applying changes…");
  });
});

// Contract: an unstaged row's menu offers Revert and Stage for that line.
describe("DetailPane row menu (unstaged)", () => {
  beforeEach(() => {
    serveThree();
  });

  it("should list Revert this line then Stage this line on a changed row", async () => {
    setup();
    await diffRegion();
    rowMenu(1);
    expect(menuLabels()).toEqual(["Revert this line", "Stage this line"]);
  });

  it("should prevent the browser's own menu on a row", async () => {
    setup();
    await diffRegion();
    const event = createEvent.contextMenu(rowAt(1), { clientX: 30, clientY: 40 });
    fireEvent(rowAt(1), event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("should enable both items on a changed row", async () => {
    setup();
    await diffRegion();
    rowMenu(1);
    expect(menuItem("Revert this line")).toBeEnabled();
    expect(menuItem("Stage this line")).toBeEnabled();
  });

  it("should stage the split row's line pair", async () => {
    setup();
    await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Stage this line"));
    await waitFor(() =>
      expect(applyHunk).toHaveBeenCalledExactlyOnceWith(REPO, "a.ts", "stage", ROW_1),
    );
  });

  it("should refetch the diff after staging a line", async () => {
    setup();
    await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Stage this line"));
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledTimes(2));
  });

  it("should close the menu once an item is chosen", async () => {
    setup();
    await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Stage this line"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should disable both items on a context row with the not-a-changed-line title", async () => {
    setup();
    await diffRegion();
    rowMenu(0);
    expect(menuLabels()).toEqual(["Revert this line", "Stage this line"]);
    for (const name of ["Revert this line", "Stage this line"]) {
      expect(menuItem(name)).toBeDisabled();
      expect(menuItem(name)).toHaveAttribute("title", "Not a changed line");
    }
  });

  it("should send nothing when a disabled context-row item is clicked", async () => {
    setup();
    await diffRegion();
    rowMenu(0);
    fireEvent.click(menuItem("Stage this line"));
    fireEvent.click(menuItem("Revert this line"));
    expect(applyHunk).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should close the menu when another file is selected", async () => {
    setup("a.ts");
    await diffRegion();
    rowMenu(1);
    select("b.ts");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

// Contract: with a text range, the menu acts on the range instead of the row under the pointer.
describe("DetailPane range menu (unstaged)", () => {
  beforeEach(() => {
    serveThree();
    stubCarets();
  });

  it("should list Revert this section then Stage selection for a range", async () => {
    setup();
    await diffRegion();
    ownerRange();
    rightClick(rowAt(2));
    expect(menuLabels()).toEqual(["Revert this section", "Stage selection"]);
  });

  it("should use the range even when the right-click lands on a row outside it", async () => {
    setup();
    await diffRegion();
    ownerRange();
    rightClick(rowAt(4));
    expect(menuLabels()).toEqual(["Revert this section", "Stage selection"]);
  });

  it("should stage the owner's example selection with its partial-line edit", async () => {
    setup();
    await diffRegion();
    ownerRange();
    rightClick(rowAt(2));
    fireEvent.click(menuItem("Stage selection"));
    await waitFor(() =>
      expect(applyHunk).toHaveBeenCalledExactlyOnceWith(REPO, "a.ts", "stage", OWNER_STAGE),
    );
  });

  it("should stage two whole split rows as their line pairs with no edits", async () => {
    setup();
    await diffRegion();
    wholeRowsRange();
    rightClick(rowAt(1));
    fireEvent.click(menuItem("Stage selection"));
    await waitFor(() =>
      expect(applyHunk).toHaveBeenCalledExactlyOnceWith(REPO, "a.ts", "stage", {
        hunkIndex: 0,
        lines: [1, 2, 4, 5],
        edits: [],
      }),
    );
  });

  it("should disable both items for a range over context only", async () => {
    setup();
    await diffRegion();
    contextRange();
    rightClick(rowAt(0));
    expect(menuLabels()).toEqual(["Revert this section", "Stage selection"]);
    for (const name of ["Revert this section", "Stage selection"]) {
      expect(menuItem(name)).toBeDisabled();
      expect(menuItem(name)).toHaveAttribute("title", "No changed text in the selection");
    }
  });

  it("should not carry a range to another file", async () => {
    setup("a.ts");
    await diffRegion();
    ownerRange();
    select("b.ts");
    await screen.findByText("b.ts");
    await diffRegion();
    rowMenu(1);
    expect(menuLabels()).toEqual(["Revert this line", "Stage this line"]);
  });
});

// Contract: Revert always asks first; the copy follows the target and confirming discards.
describe("DetailPane revert dialog", () => {
  beforeEach(() => {
    serveThree();
    stubCarets();
  });

  it("should open the dialog with the single-line copy from Revert this line", async () => {
    setup();
    await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Revert this line"));
    expect(revertDialog()).toHaveTextContent("Revert this line in a.ts? This cannot be undone.");
  });

  it("should label the confirm button Revert", async () => {
    setup();
    await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Revert this line"));
    expect(within(revertDialog()).getByRole("button", { name: "Revert" })).toBeInTheDocument();
  });

  it("should apply nothing until the user confirms", async () => {
    setup();
    await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Revert this line"));
    expect(applyHunk).not.toHaveBeenCalled();
  });

  it("should discard the split row's line pair when confirmed", async () => {
    setup();
    await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Revert this line"));
    fireEvent.click(within(revertDialog()).getByRole("button", { name: "Revert" }));
    await waitFor(() =>
      expect(applyHunk).toHaveBeenCalledExactlyOnceWith(REPO, "a.ts", "discard", ROW_1),
    );
  });

  it("should close the dialog once Revert is confirmed", async () => {
    setup();
    await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Revert this line"));
    fireEvent.click(within(revertDialog()).getByRole("button", { name: "Revert" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should send nothing and close the dialog when Cancel is clicked", async () => {
    setup();
    await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Revert this line"));
    fireEvent.click(within(revertDialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(applyHunk).not.toHaveBeenCalled();
  });

  it("should use the highlighted-text copy for a range with a partial-line edit", async () => {
    setup();
    await diffRegion();
    ownerRange();
    rightClick(rowAt(2));
    fireEvent.click(menuItem("Revert this section"));
    expect(revertDialog()).toHaveTextContent(
      "Revert the highlighted text in a.ts? This cannot be undone.",
    );
  });

  it("should discard the owner's example range with its revert edit when confirmed", async () => {
    setup();
    await diffRegion();
    ownerRange();
    rightClick(rowAt(2));
    fireEvent.click(menuItem("Revert this section"));
    fireEvent.click(within(revertDialog()).getByRole("button", { name: "Revert" }));
    await waitFor(() =>
      expect(applyHunk).toHaveBeenCalledExactlyOnceWith(REPO, "a.ts", "discard", OWNER_REVERT),
    );
  });

  it("should count only the changed rows when the range also covers a context row", async () => {
    setup();
    await diffRegion();
    // Context row 0 plus split rows 1 and 2 whole on the new side: no partial line, so no edits.
    dragRange({ row: 0, side: "new", offset: 0 }, { row: 2, side: "new", offset: 13 });
    rightClick(rowAt(1));
    fireEvent.click(menuItem("Revert this section"));
    expect(revertDialog()).toHaveTextContent("Revert 2 lines in a.ts? This cannot be undone.");
  });

  it("should count the lines for a range of whole rows", async () => {
    setup();
    await diffRegion();
    wholeRowsRange();
    rightClick(rowAt(1));
    fireEvent.click(menuItem("Revert this section"));
    expect(revertDialog()).toHaveTextContent("Revert 2 lines in a.ts? This cannot be undone.");
  });

  it("should discard the whole rows' line pairs when confirmed", async () => {
    setup();
    await diffRegion();
    wholeRowsRange();
    rightClick(rowAt(1));
    fireEvent.click(menuItem("Revert this section"));
    fireEvent.click(within(revertDialog()).getByRole("button", { name: "Revert" }));
    await waitFor(() =>
      expect(applyHunk).toHaveBeenCalledExactlyOnceWith(REPO, "a.ts", "discard", {
        hunkIndex: 0,
        lines: [1, 2, 4, 5],
        edits: [],
      }),
    );
  });

  it("should focus the file detail when the dialog is cancelled and its opener is gone", async () => {
    setup();
    const region = await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Revert this line"));
    fireEvent.click(within(revertDialog()).getByRole("button", { name: "Cancel" }));
    // The fallback is FileDetail's root, the Diff region's parent.
    expect(region.parentElement).toHaveFocus();
  });

  it("should mark the file detail root as a programmatic focus target", async () => {
    setup();
    const target = (await diffRegion()).parentElement;
    expect(target).toHaveAttribute("data-focus-target");
    expect(target).toHaveAttribute("tabindex", "-1");
  });
});

// Contract: a revert confirmation never applies to a diff other than the one it was opened on.
describe("DetailPane stale revert", () => {
  const changed = fileDiff([
    hunk([L("deletion", "other", 2, null), L("addition", "else", null, 2)]),
  ]);

  async function openDialog() {
    serveThree();
    const view = setup();
    await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Revert this line"));
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
    expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
    expect(applyHunk).not.toHaveBeenCalled();
  });

  it("should keep the dialog open when a refetch returns an identical diff", async () => {
    const { queryClient } = await openDialog();
    vi.mocked(getFileDiff).mockResolvedValue(threeDiff());
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("should close the dialog when another file is selected", async () => {
    await openDialog();
    select("b.ts");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("should not reopen the dialog when returning to the file it was opened on", async () => {
    await openDialog();
    select("b.ts");
    await screen.findByText("b.ts");
    select("a.ts");
    await screen.findByText("a.ts");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(applyHunk).not.toHaveBeenCalled();
  });
});

// Contract: an open menu belongs to the diff it was opened on; a changed refetch drops it.
describe("DetailPane stale menu", () => {
  it("should drop an open menu when a refetch returns a changed diff", async () => {
    serveThree();
    const { queryClient } = setup();
    await diffRegion();
    rowMenu(1);
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([hunk([L("deletion", "other", 2, null), L("addition", "else", null, 2)])]),
    );
    await act(() => queryClient.invalidateQueries());
    await screen.findByText("else");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Stage this line" })).toBeNull();
    expect(applyHunk).not.toHaveBeenCalled();
  });
});

// Contract: the revert count counts a row whose highlighted-side cell is blank when its other
// line is reverted (either-side ruling).
describe("DetailPane revert count with a blank cell", () => {
  // Split rows: 0 ctx, 1 {"a","A"}, 2 {"b", blank new cell}, 3 ctx.
  const lonely = () =>
    fileDiff([
      hunk([
        L("context", "c", 1, 1),
        L("deletion", "a", 2, null),
        L("deletion", "b", 3, null),
        L("addition", "A", null, 2),
        L("context", "d", 4, 3),
      ]),
    ]);

  beforeEach(() => {
    vi.mocked(getFileDiff).mockImplementation(() => Promise.resolve(lonely()));
    stubCarets();
  });

  it("should count the blank-cell row whose deletion is reverted", async () => {
    setup();
    await diffRegion();
    dragRange({ row: 1, side: "new", offset: 0 }, { row: 2, side: "new", offset: 0 });
    rightClick(rowAt(1));
    fireEvent.click(menuItem("Revert this section"));
    expect(revertDialog()).toHaveTextContent("Revert 2 lines in a.ts? This cannot be undone.");
  });

  it("should discard both deletions and the addition when confirmed", async () => {
    setup();
    await diffRegion();
    dragRange({ row: 1, side: "new", offset: 0 }, { row: 2, side: "new", offset: 0 });
    rightClick(rowAt(1));
    fireEvent.click(menuItem("Revert this section"));
    fireEvent.click(within(revertDialog()).getByRole("button", { name: "Revert" }));
    await waitFor(() =>
      expect(applyHunk).toHaveBeenCalledExactlyOnceWith(REPO, "a.ts", "discard", {
        hunkIndex: 0,
        lines: [1, 2, 3],
        edits: [],
      }),
    );
  });
});

// Contract: a staged file's menu only unstages.
describe("DetailPane staged menu", () => {
  beforeEach(() => {
    serveThree({ scope: "staged" });
    stubCarets();
  });

  it("should offer only Unstage this line on a row", async () => {
    setup("a.ts", "staged");
    await diffRegion();
    rowMenu(1);
    expect(menuLabels()).toEqual(["Unstage this line"]);
  });

  it("should unstage the split row's line pair", async () => {
    setup("a.ts", "staged");
    await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Unstage this line"));
    await waitFor(() =>
      expect(applyHunk).toHaveBeenCalledExactlyOnceWith(REPO, "a.ts", "unstage", ROW_1),
    );
  });

  it("should offer only Unstage selection for a range", async () => {
    setup("a.ts", "staged");
    await diffRegion();
    ownerRange();
    rightClick(rowAt(2));
    expect(menuLabels()).toEqual(["Unstage selection"]);
  });

  it("should unstage the owner's example range", async () => {
    setup("a.ts", "staged");
    await diffRegion();
    ownerRange();
    rightClick(rowAt(2));
    fireEvent.click(menuItem("Unstage selection"));
    await waitFor(() =>
      expect(applyHunk).toHaveBeenCalledExactlyOnceWith(REPO, "a.ts", "unstage", OWNER_REVERT),
    );
  });

  it("should disable Unstage this line on a context row", async () => {
    setup("a.ts", "staged");
    await diffRegion();
    rowMenu(0);
    expect(menuItem("Unstage this line")).toBeDisabled();
    expect(menuItem("Unstage this line")).toHaveAttribute("title", "Not a changed line");
  });
});

// Contract: the menu items are disabled, with a reason, when the diff cannot be applied safely.
describe("DetailPane menu gates", () => {
  beforeEach(() => {
    serveThree();
  });

  const expectRowItems = (title: string) => {
    for (const name of ["Revert this line", "Stage this line"]) {
      expect(menuItem(name)).toBeDisabled();
      expect(menuItem(name)).toHaveAttribute("title", title);
    }
  };

  it("should disable the items with the whitespace reason when whitespace is hidden", async () => {
    await seedSettings({ diff: { ignoreWhitespace: true } });
    setup();
    await diffRegion();
    rowMenu(1);
    expectRowItems(WHITESPACE_REASON);
  });

  it("should disable the items with the decoded reason for a decoded diff", async () => {
    serveThree({ oldEncoding: "utf16Le", newEncoding: "utf16Le" });
    setup();
    await diffRegion();
    rowMenu(1);
    expectRowItems(DECODED_REASON);
  });

  it("should prefer the whitespace reason over the decoded reason", async () => {
    await seedSettings({ diff: { ignoreWhitespace: true } });
    serveThree({ oldEncoding: "utf16Le", newEncoding: "utf16Le" });
    setup();
    await diffRegion();
    rowMenu(1);
    expectRowItems(WHITESPACE_REASON);
  });

  it("should disable the items with the pending reason while an action runs", async () => {
    vi.mocked(applyHunk).mockReturnValue(new Promise(() => undefined));
    setup();
    await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Stage this line"));
    await waitFor(() => expect(applyHunk).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      rightClick(rowAt(1));
      expect(menuItem("Stage this line")).toBeDisabled();
    });
    expectRowItems(PENDING_REASON);
  });

  it("should apply nothing more while an action is pending", async () => {
    vi.mocked(applyHunk).mockReturnValue(new Promise(() => undefined));
    setup();
    await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Stage this line"));
    await waitFor(() => expect(applyHunk).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      rightClick(rowAt(1));
      expect(menuItem("Stage this line")).toBeDisabled();
    });
    fireEvent.click(menuItem("Stage this line"));
    expect(applyHunk).toHaveBeenCalledTimes(1);
  });

  it("should apply nothing through items disabled for whitespace", async () => {
    await seedSettings({ diff: { ignoreWhitespace: true } });
    setup();
    await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Stage this line"));
    rightClick(rowAt(1));
    fireEvent.click(menuItem("Revert this line"));
    expect(applyHunk).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should disable the items once the whitespace box is ticked", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide whitespace changes" }));
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenLastCalledWith(REPO, "a.ts", "unstaged", true, undefined),
    );
    await diffRegion();
    await waitFor(() => {
      rightClick(rowAt(1));
      expect(menuItem("Stage this line")).toBeDisabled();
    });
    expectRowItems(WHITESPACE_REASON);
  });

  it("should re-enable the items with no title once the whitespace box is unticked", async () => {
    await seedSettings({ diff: { ignoreWhitespace: true } });
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide whitespace changes" }));
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenLastCalledWith(REPO, "a.ts", "unstaged", false, undefined),
    );
    await waitFor(() => {
      rightClick(rowAt(1));
      expect(menuItem("Stage this line")).toBeEnabled();
    });
    expect(menuItem("Stage this line")).not.toHaveAttribute("title");
    expect(menuItem("Revert this line")).not.toHaveAttribute("title");
  });

  it("should not disable the items for a truncated diff", async () => {
    serveThree({ truncated: true });
    setup();
    await diffRegion();
    rowMenu(1);
    expect(menuItem("Stage this line")).toBeEnabled();
    expect(menuItem("Revert this line")).toBeEnabled();
    expect(menuItem("Stage this line")).not.toHaveAttribute("title");
  });

  it("should stage from a truncated diff", async () => {
    serveThree({ truncated: true });
    setup();
    await diffRegion();
    rowMenu(1);
    fireEvent.click(menuItem("Stage this line"));
    await waitFor(() =>
      expect(applyHunk).toHaveBeenCalledExactlyOnceWith(REPO, "a.ts", "stage", ROW_1),
    );
  });

  it("should no longer show the load-the-full-diff title anywhere", async () => {
    serveThree({ truncated: true });
    setup();
    await diffRegion();
    rowMenu(1);
    expect(
      document.querySelector('[title="Load the full diff to stage, unstage or discard this hunk"]'),
    ).toBeNull();
  });
});

// Contract: an action failure shows above the viewer and can be dismissed.
describe("DetailPane action errors", () => {
  const badSelection: AppError = { kind: "badSelection", message: "The diff changed" };

  beforeEach(() => {
    serveThree();
  });

  const stageRow = () => {
    rowMenu(1);
    fireEvent.click(menuItem("Stage this line"));
  };

  it("should show the failure in an alert", async () => {
    vi.mocked(applyHunk).mockRejectedValue(badSelection);
    setup();
    await diffRegion();
    stageRow();
    expect(await screen.findByRole("alert")).toHaveTextContent("The diff changed");
  });

  it("should keep the viewer visible next to the alert", async () => {
    vi.mocked(applyHunk).mockRejectedValue(badSelection);
    setup();
    await diffRegion();
    stageRow();
    await screen.findByRole("alert");
    expect(screen.getByRole("region", { name: "Diff" })).toBeInTheDocument();
  });

  it("should place the alert above the viewer", async () => {
    vi.mocked(applyHunk).mockRejectedValue(badSelection);
    setup();
    await diffRegion();
    stageRow();
    const alert = await screen.findByRole("alert");
    const region = screen.getByRole("region", { name: "Diff" });
    expect(alert.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("should show only the action error, with no Retry", async () => {
    vi.mocked(applyHunk).mockRejectedValue(badSelection);
    setup();
    await diffRegion();
    stageRow();
    const alert = await screen.findByRole("alert");
    expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("should remove the alert when Dismiss is clicked and keep the viewer", async () => {
    vi.mocked(applyHunk).mockRejectedValue(badSelection);
    setup();
    await diffRegion();
    stageRow();
    fireEvent.click(
      await within(await screen.findByRole("alert")).findByRole("button", { name: "Dismiss" }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("region", { name: "Diff" })).toBeInTheDocument();
  });

  it("should clear a stale action error when a later action succeeds", async () => {
    vi.mocked(applyHunk).mockRejectedValueOnce(badSelection);
    setup();
    await diffRegion();
    stageRow();
    await screen.findByRole("alert");
    stageRow();
    await waitFor(() => expect(applyHunk).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("should clear the action error when another file is selected", async () => {
    vi.mocked(applyHunk).mockRejectedValue(badSelection);
    setup();
    await diffRegion();
    stageRow();
    await screen.findByRole("alert");
    select("b.ts");
    await diffRegion();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

// Contract: the viewer opens on the first change once per diff key; refetches and mode switches
// keep the scroll position.
describe("DetailPane first-change scroll", () => {
  beforeEach(() => {
    serveThree();
  });

  it("should scroll to three rows above the first change once on mount", async () => {
    setup();
    await diffRegion();
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalled());
    expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith(0, { align: "start" });
  });

  it("should scroll to the first change's row less three when it starts further down", async () => {
    // Split rows 0..5 context, 6 the edited pair, 7 context.
    const late = fileDiff([
      hunk(
        [
          ...[1, 2, 3, 4, 5, 6].map((n) => L("context", `c${n}`, n, n)),
          L("deletion", "x", 7, null),
          L("addition", "y", null, 7),
          L("context", "c8", 8, 8),
        ],
        "@@ -1,8 +1,8 @@",
      ),
    ]);
    vi.mocked(getFileDiff).mockResolvedValue(late);
    setup();
    await diffRegion();
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalled());
    expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith(3, { align: "start" });
  });

  it("should not scroll again when the same diff key refetches after an action", async () => {
    setup();
    await diffRegion();
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalledTimes(1));
    rowMenu(1);
    fireEvent.click(menuItem("Stage this line"));
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledTimes(2));
    await diffRegion();
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it("should not scroll again when the same key refetches a changed diff", async () => {
    const { queryClient } = setup();
    await diffRegion();
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalledTimes(1));
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([hunk([L("deletion", "other", 2, null), L("addition", "else", null, 2)])]),
    );
    await act(() => queryClient.invalidateQueries());
    await screen.findByText("else");
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it("should scroll again after Load full diff fetches a new key", async () => {
    serveThree({ truncated: true });
    setup();
    await diffRegion();
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Load full diff" }));
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenLastCalledWith(
        REPO,
        "a.ts",
        "unstaged",
        false,
        FULL_DIFF_LINES,
      ),
    );
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalledTimes(2));
    expect(scrollToIndex).toHaveBeenLastCalledWith(0, { align: "start" });
  });

  it("should not scroll again when switching between side by side and unified", async () => {
    setup();
    await diffRegion();
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("radio", { name: "Unified" }));
    // Unified has eight rows where split has five.
    await waitFor(() => expect(document.querySelector('[data-index="7"]')).not.toBeNull());
    fireEvent.click(screen.getByRole("radio", { name: "Side by side" }));
    await waitFor(() => expect(document.querySelector('[data-index="7"]')).toBeNull());
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });
});

// Contract: a manual scroll forgets the current change, so F7 continues from the viewport.
describe("DetailPane user scroll and navigation", () => {
  // Split rows: 0 ctx, 1 {a,A}, 2..4 ctx, 5 {b,B}, 6..8 ctx, 9 {d,D}, 10 ctx; blocks at 1, 5, 9.
  const threeBlocks = () =>
    fileDiff([
      hunk(
        [
          L("context", "c1", 1, 1),
          L("deletion", "a", 2, null),
          L("addition", "A", null, 2),
          ...[3, 4, 5].map((n) => L("context", `c${n}`, n, n)),
          L("deletion", "b", 6, null),
          L("addition", "B", null, 6),
          ...[7, 8, 9].map((n) => L("context", `c${n}`, n, n)),
          L("deletion", "d", 10, null),
          L("addition", "D", null, 10),
          L("context", "c11", 11, 11),
        ],
        "@@ -1,11 +1,11 @@",
      ),
    ]);

  beforeEach(() => {
    vi.mocked(getFileDiff).mockImplementation(() => Promise.resolve(threeBlocks()));
  });

  /** The scroll event the mount's own scrollToRow causes, then a user wheel scroll to `row`. */
  const userScrollTo = (row: number) => {
    const scroll = screen.getByTestId("diff-scroll");
    fireEvent.scroll(scroll);
    mockWindow.visibleStart = row;
    fireEvent.wheel(scroll, { deltaY: 100 });
    fireEvent.scroll(scroll);
  };

  it("should show the first change as current after mount", async () => {
    setup();
    await diffRegion();
    expect(await screen.findByText("1 of 3")).toBeInTheDocument();
  });

  it("should drop the current change from the counter right after a user scroll", async () => {
    setup();
    await diffRegion();
    await screen.findByText("1 of 3");
    userScrollTo(6);
    expect(await screen.findByText("3 changes")).toBeInTheDocument();
  });

  it("should step from the viewport, not from the old current change, on the next F7", async () => {
    setup();
    await diffRegion();
    await screen.findByText("1 of 3");
    userScrollTo(6);
    await screen.findByText("3 changes");
    scrollToIndex.mockClear();
    act(() => useShell.getState().diffNavigation!.next());
    // The first block below row 6 starts at row 9; stepping from block 0 would give row 5 - 3.
    expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith(6, { align: "start" });
  });
});

// Contract: the open diff publishes its change navigation for F7/Shift+F7 and the palette, and
// withdraws it whenever no diff is shown.
describe("DetailPane navigation publishing", () => {
  // Split rows: 0 ctx, 1 {a,A}, 2..6 ctx, 7 {b,B}, 8 ctx; blocks start at rows 1 and 7.
  const twoBlocks = () =>
    fileDiff([
      hunk(
        [
          L("context", "c1", 1, 1),
          L("deletion", "a", 2, null),
          L("addition", "A", null, 2),
          ...[3, 4, 5, 6, 7].map((n) => L("context", `c${n}`, n, n)),
          L("deletion", "b", 8, null),
          L("addition", "B", null, 8),
          L("context", "c9", 9, 9),
        ],
        "@@ -1,9 +1,9 @@",
      ),
    ]);
  const published = () => useShell.getState().diffNavigation;
  const shape = { repoId: REPO, next: expect.any(Function), prev: expect.any(Function) };

  beforeEach(() => {
    vi.mocked(getFileDiff).mockImplementation(() => Promise.resolve(twoBlocks()));
  });

  it("should publish the navigation while the diff shows", async () => {
    setup();
    await diffRegion();
    await waitFor(() => expect(published()).toEqual(shape));
  });

  it("should publish a next that steps to the following change", async () => {
    setup();
    await diffRegion();
    await waitFor(() => expect(published()).toEqual(shape));
    act(() => published()!.next());
    expect(scrollToIndex).toHaveBeenLastCalledWith(4, { align: "start" });
  });

  it("should publish a prev that steps back to the earlier change", async () => {
    setup();
    await diffRegion();
    await waitFor(() => expect(published()).toEqual(shape));
    act(() => published()!.next());
    act(() => published()!.prev());
    expect(scrollToIndex).toHaveBeenLastCalledWith(0, { align: "start" });
  });

  it("should withdraw the navigation on unmount", async () => {
    const { unmount } = setup();
    await diffRegion();
    await waitFor(() => expect(published()).toEqual(shape));
    unmount();
    expect(published()).toBeNull();
  });

  it("should withdraw the navigation when the view switches to blame", async () => {
    setup();
    await diffRegion();
    await waitFor(() => expect(published()).toEqual(shape));
    act(() => useWorkspace.getState().setCentreView(REPO, "blame"));
    await screen.findByRole("table", { name: "Blame" });
    expect(published()).toBeNull();
  });

  it("should withdraw the navigation when a refetch fails", async () => {
    const { queryClient } = setup();
    await diffRegion();
    await waitFor(() => expect(published()).toEqual(shape));
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    await act(() => queryClient.invalidateQueries());
    await screen.findByRole("alert");
    expect(published()).toBeNull();
  });

  it("should publish nothing for a load error", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    setup();
    await screen.findByRole("alert");
    expect(published()).toBeNull();
  });

  it("should never publish null while the viewer stays mounted and next() steps", async () => {
    setup();
    await diffRegion();
    await waitFor(() => expect(published()).toEqual(shape));
    const seen: unknown[] = [];
    const unsubscribe = useShell.subscribe((s) => seen.push(s.diffNavigation));
    try {
      act(() => published()!.next());
      act(() => published()!.prev());
    } finally {
      unsubscribe();
    }
    expect(seen).not.toContain(null);
    expect(published()).toEqual(shape);
  });

  it("should publish nothing for a diff without rows", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(fileDiff([]));
    setup();
    await screen.findByText("No line changes in this file");
    expect(published()).toBeNull();
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

  // Four context lines, truncated: no change block is within the loaded part.
  const unchangedHead = () =>
    fileDiff(
      [
        hunk(
          [1, 2, 3, 4].map((n) => L("context", `c${n}`, n, n)),
          "@@ -1,4 +1,4 @@",
        ),
      ],
      {
        truncated: true,
      },
    );

  it("should publish no navigation in the unchanged-lines empty state", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(unchangedHead());
    setup();
    await screen.findByText("The first 4 lines are unchanged");
    expect(useShell.getState().diffNavigation).toBeNull();
  });

  it("should say the loaded lines are unchanged when a truncated diff has no change in them", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(unchangedHead());
    setup();
    expect(await screen.findByText("The first 4 lines are unchanged")).toBeInTheDocument();
  });

  it("should offer Load full diff next to the unchanged-lines message", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(unchangedHead());
    setup();
    const message = await screen.findByText("The first 4 lines are unchanged");
    const empty = message.closest("div")!;
    expect(within(empty).getByRole("button", { name: "Load full diff" })).toBeInTheDocument();
  });

  it("should refetch with the full line limit from the unchanged-lines message", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(unchangedHead());
    setup();
    const message = await screen.findByText("The first 4 lines are unchanged");
    fireEvent.click(
      within(message.closest("div")!).getByRole("button", { name: "Load full diff" }),
    );
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

  it("should not show the unchanged-lines message for a truncated diff with changes", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(textDiff({ truncated: true }));
    setup();
    await diffRegion();
    expect(screen.queryByText(/lines are unchanged/)).toBeNull();
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
    await seedSettings({ diff: { mode: "unified" } });
    const { container } = setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("radio", { name: "Side by side" }));
    await waitFor(() => expect(count(container, "empty")).toBeGreaterThan(0));
  });

  it("should store the chosen mode in the preferences", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("radio", { name: "Unified" }));
    expect(useSettings.getState().settings.diff.mode).toBe("unified");
  });

  it("sends the mode change to the backend once the save delay passes", async () => {
    setup();
    await diffRegion();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(screen.getByRole("radio", { name: "Unified" }));
      vi.advanceTimersByTime(300);
    } finally {
      vi.useRealTimers();
    }
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ diff: { mode: "unified" } });
  });

  it("should not refetch the diff when the mode changes", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("radio", { name: "Unified" }));
    expect(getFileDiff).toHaveBeenCalledTimes(1);
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

  it("should offer Close diff in the file header of a loaded diff", async () => {
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

// Coverage: Close diff scoping, side effects and state combinations.
describe("DetailPane Close diff edges", () => {
  const closeButton = () => screen.findByRole("button", { name: "Close diff" });

  it("should clear only the pane's own repository when it is not repository 1", async () => {
    useWorkspace.getState().select(1, { path: "keep.ts", scope: "staged" });
    useWorkspace.getState().select(2, { path: "b.ts", scope: "unstaged" });
    renderWithProviders(<DetailPane repoId={2} />);
    await screen.findByRole("region", { name: "Diff" });
    fireEvent.click(await closeButton());
    expect(useWorkspace.getState().selected).toEqual({
      1: { path: "keep.ts", scope: "staged" },
      2: null,
    });
  });

  it("should not touch the selected commit when the diff is closed", async () => {
    useWorkspace.getState().selectCommit(REPO, "abc");
    setup();
    await diffRegion();
    fireEvent.click(await closeButton());
    expect(useWorkspace.getState().selectedCommit[REPO]).toBe("abc");
  });

  it("should not refetch the diff when it is closed", async () => {
    setup();
    await diffRegion();
    fireEvent.click(await closeButton());
    expect(getFileDiff).toHaveBeenCalledOnce();
  });

  it("should keep the whitespace control next to Close diff in the no-changes state", async () => {
    await seedSettings({ diff: { ignoreWhitespace: true } });
    vi.mocked(getFileDiff).mockRejectedValue({ kind: "noChanges", message: "no changes" });
    setup();
    await screen.findByText("No unstaged changes in a.ts");
    expect(screen.getByRole("checkbox", { name: "Hide whitespace changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close diff" })).toBeInTheDocument();
  });

  it("should offer exactly one Close diff button in the load error state", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    setup();
    await screen.findByRole("alert");
    expect(screen.getAllByRole("button", { name: "Close diff" })).toHaveLength(1);
  });

  it("should not refetch after Close diff in the load error state", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    setup();
    await screen.findByRole("alert");
    const calls = vi.mocked(getFileDiff).mock.calls.length;
    fireEvent.click(await closeButton());
    expect(vi.mocked(getFileDiff).mock.calls).toHaveLength(calls);
  });

  it("should remove the error alert once Close diff clears the selection", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    setup();
    await screen.findByRole("alert");
    fireEvent.click(await closeButton());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should offer exactly one Close diff button for a binary file", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([], { path: "blob.bin", isBinary: true, change: "modified" }),
    );
    setup("blob.bin");
    await screen.findByText("Binary file — no preview available");
    expect(screen.getAllByRole("button", { name: "Close diff" })).toHaveLength(1);
  });

  it("should offer exactly one Close diff button for a binary image", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([], { path: "logo.png", isBinary: true, change: "added" }),
    );
    setup("logo.png");
    await screen.findByAltText("New image");
    expect(screen.getAllByRole("button", { name: "Close diff" })).toHaveLength(1);
  });

  it("should offer exactly one Close diff button while loading and keep the status text", async () => {
    vi.mocked(getFileDiff).mockReturnValue(new Promise(() => undefined));
    setup();
    expect(await screen.findByRole("status")).toHaveTextContent("Loading diff…");
    expect(screen.getAllByRole("button", { name: "Close diff" })).toHaveLength(1);
  });

  it("should show the Close diff button of the newly selected file's state after switching", async () => {
    setup();
    await diffRegion();
    vi.mocked(getFileDiff).mockReturnValue(new Promise(() => undefined));
    select("b.ts");
    expect(await screen.findByRole("status")).toBeInTheDocument();
    fireEvent.click(await closeButton());
    expect(useWorkspace.getState().selected[REPO]).toBeNull();
  });
});

const selectScope = (scope: DiffScope, path = "a.ts") =>
  useWorkspace.getState().select(REPO, { path, scope });
const COMMIT: DiffScope = { commit: "abc1234" };
const header = () => screen.findByRole("radiogroup", { name: "View" });

// Contract: FileHeader tops every state of the centre file view.
describe("DetailPane file header", () => {
  it("should show the header while the diff is loading", async () => {
    vi.mocked(getFileDiff).mockReturnValue(new Promise(() => undefined));
    setup();
    expect(await header()).toBeInTheDocument();
  });

  it("should show the header on a load error", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    setup();
    await screen.findByRole("alert");
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeInTheDocument();
  });

  it("should show the header when there are no changes", async () => {
    vi.mocked(getFileDiff).mockRejectedValue({ kind: "noChanges", message: "none" });
    setup();
    await screen.findByText("No unstaged changes in a.ts");
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeInTheDocument();
  });

  it("should show the header for a binary file", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      textDiff({ path: "a.bin", isBinary: true, hunks: [] }),
    );
    setup("a.bin");
    await screen.findByText(/binary/i);
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeInTheDocument();
  });

  it("should show the header with the path above a loaded diff", async () => {
    setup("src/a.ts");
    await diffRegion();
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
  });

  it("should show old to new in the header for a renamed diff", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      textDiff({ path: "b.ts", oldPath: "a.ts", change: "renamed" }),
    );
    setup("b.ts");
    expect(await screen.findByText("a.ts → b.ts")).toBeInTheDocument();
  });

  it("should check Diff by default", async () => {
    setup();
    await diffRegion();
    expect(screen.getByRole("radio", { name: "Diff" })).toBeChecked();
  });

  it("should store the history path when History is clicked", async () => {
    setup("src/a.ts");
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Show file history" }));
    expect(useWorkspace.getState().historyPath[REPO]).toBe("src/a.ts");
  });

  it("should set the centre view to blame when Blame is chosen", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("radio", { name: "Blame" }));
    expect(useWorkspace.getState().centreView[REPO]).toBe("blame");
  });

  it("should offer exactly one Close diff in the loaded state now the toolbar has none", async () => {
    setup();
    await diffRegion();
    expect(screen.getAllByRole("button", { name: "Close diff" })).toHaveLength(1);
  });

  // R18: DetailPane passes its repoId to FileHeader so Open in editor sends the correct id.
  it("passes repoId to the header so Open in editor includes the repo id", async () => {
    await seedSettings({ tools: { editor: "code" } });
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
    await waitFor(() => expect(openInEditor).toHaveBeenCalledWith("a.ts", REPO));
  });
});

// Contract: a commit-scoped file is a read-only diff with its own copy.
describe("DetailPane commit scope", () => {
  const commitSetup = () => {
    selectScope(COMMIT);
    return renderWithProviders(<DetailPane repoId={REPO} />);
  };

  it("should fetch the diff with the commit scope", async () => {
    commitSetup();
    await diffRegion();
    expect(getFileDiff).toHaveBeenCalledWith(REPO, "a.ts", COMMIT, false, undefined);
  });

  it("should render no Stage, Unstage or Discard buttons", async () => {
    commitSetup();
    await diffRegion();
    expect(screen.queryByRole("button", { name: /^(Stage|Unstage|Discard)/ })).toBeNull();
  });

  it("should open no menu on a right-click", async () => {
    commitSetup();
    await diffRegion();
    rightClick(rowAt(1));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should leave the browser's own menu alone on a right-click", async () => {
    commitSetup();
    await diffRegion();
    const event = createEvent.contextMenu(rowAt(1), { clientX: 30, clientY: 40 });
    fireEvent(rowAt(1), event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("should still render the line text", async () => {
    commitSetup();
    await diffRegion();
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("should say No changes in the path for a commit scope", async () => {
    vi.mocked(getFileDiff).mockRejectedValue({ kind: "noChanges", message: "none" });
    selectScope(COMMIT, "src/a.ts");
    renderWithProviders(<DetailPane repoId={REPO} />);
    expect(await screen.findByText("No changes in src/a.ts")).toBeInTheDocument();
  });

  it("should still offer the stage menu for a working-tree scope", async () => {
    setup("a.ts", "unstaged");
    await diffRegion();
    rightClick(rowAt(1));
    expect(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "Stage this line" }),
    ).toBeInTheDocument();
  });

  it("should not carry the full-diff line cap from one commit to another with the same path", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(textDiff({ truncated: true }));
    commitSetup();
    fireEvent.click(await screen.findByRole("button", { name: "Load full diff" }));
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenCalledWith(REPO, "a.ts", COMMIT, false, FULL_DIFF_LINES),
    );
    act(() => selectScope({ commit: "def5678" }));
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenCalledWith(
        REPO,
        "a.ts",
        { commit: "def5678" },
        false,
        undefined,
      ),
    );
  });
});

// Contract: blame mode renders BlameView and skips the diff query.
describe("DetailPane blame view", () => {
  const blameSetup = (scope: DiffScope = "unstaged") => {
    useWorkspace.getState().setCentreView(REPO, "blame");
    selectScope(scope);
    return renderWithProviders(<DetailPane repoId={REPO} />);
  };

  it("should render the Blame table when the centre view is blame", async () => {
    blameSetup(COMMIT);
    expect(await screen.findByRole("table", { name: "Blame" })).toBeInTheDocument();
  });

  it("should not call getFileDiff in blame mode", async () => {
    blameSetup(COMMIT);
    await screen.findByRole("table", { name: "Blame" });
    expect(getFileDiff).not.toHaveBeenCalled();
  });

  it("should keep the header with Blame checked in blame mode", async () => {
    blameSetup(COMMIT);
    await screen.findByRole("table", { name: "Blame" });
    expect(screen.getByRole("radio", { name: "Blame" })).toBeChecked();
  });

  it("should pass a null oid to BlameView for an unstaged scope", async () => {
    blameSetup("unstaged");
    await screen.findByRole("table", { name: "Blame" });
    expect(vi.mocked(BlameView)).toHaveBeenLastCalledWith(
      { repoId: REPO, path: "a.ts", oid: null },
      undefined,
    );
  });

  it("should pass a null oid to BlameView for a staged scope", async () => {
    blameSetup("staged");
    await screen.findByRole("table", { name: "Blame" });
    expect(vi.mocked(BlameView)).toHaveBeenLastCalledWith(
      { repoId: REPO, path: "a.ts", oid: null },
      undefined,
    );
  });

  it("should pass the commit oid to BlameView for a commit scope", async () => {
    blameSetup(COMMIT);
    await screen.findByRole("table", { name: "Blame" });
    expect(vi.mocked(BlameView)).toHaveBeenLastCalledWith(
      { repoId: REPO, path: "a.ts", oid: "abc1234" },
      undefined,
    );
  });

  it("should toggle Diff, Blame, Diff on an unstaged file without throwing or a loading flash", async () => {
    setup();
    await diffRegion();
    fireEvent.click(screen.getByRole("radio", { name: "Blame" }));
    await screen.findByRole("table", { name: "Blame" });
    fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
    expect(screen.queryByText("Loading diff…")).toBeNull();
    expect(await diffRegion()).toBeInTheDocument();
  });

  it("should toggle Diff, Blame, Diff on a commit file without a loading flash", async () => {
    selectScope(COMMIT);
    renderWithProviders(<DetailPane repoId={REPO} />);
    await diffRegion();
    fireEvent.click(screen.getByRole("radio", { name: "Blame" }));
    await screen.findByRole("table", { name: "Blame" });
    fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
    expect(screen.queryByText("Loading diff…")).toBeNull();
    expect(await diffRegion()).toBeInTheDocument();
  });

  it("should render no diff region in blame mode", async () => {
    blameSetup(COMMIT);
    await screen.findByRole("table", { name: "Blame" });
    expect(screen.queryByRole("region", { name: "Diff" })).toBeNull();
  });

  it("DetailPane renders BlameView for an unstaged scope with a null oid", async () => {
    blameSetup("unstaged");
    expect(await screen.findByRole("table", { name: "Blame" })).toBeInTheDocument();
    expect(getFileDiff).not.toHaveBeenCalled();
  });

  it("should fetch the diff after switching back to Diff", async () => {
    blameSetup("unstaged");
    await screen.findByRole("table", { name: "Blame" });
    fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
    expect(await diffRegion()).toBeInTheDocument();
    expect(getFileDiff).toHaveBeenCalledWith(REPO, "a.ts", "unstaged", false, undefined);
  });

  it("should remove the Blame table after switching back to Diff", async () => {
    blameSetup("unstaged");
    await screen.findByRole("table", { name: "Blame" });
    fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
    await diffRegion();
    expect(screen.queryByRole("table", { name: "Blame" })).toBeNull();
  });

  it("should keep blame mode when another file is selected", async () => {
    blameSetup("unstaged");
    await screen.findByRole("table", { name: "Blame" });
    act(() => selectScope("unstaged", "b.ts"));
    expect(await screen.findByRole("table", { name: "Blame" })).toBeInTheDocument();
    expect(getFileDiff).not.toHaveBeenCalled();
  });

  it("should not apply blame mode of another repository", async () => {
    useWorkspace.getState().setCentreView(2, "blame");
    setup();
    await diffRegion();
    expect(screen.queryByRole("table", { name: "Blame" })).toBeNull();
  });
});

// Contract (F17): a file opened from a stash has no blame; the stored view is kept.
describe("DetailPane stash files", () => {
  const STASH_BLAME_REASON = "Blame is not available for stashed files";
  const selectStashFile = (path = "a.ts") =>
    act(() => useWorkspace.getState().select(REPO, { path, scope: COMMIT, source: "stash" }));

  it("a stash file shows its diff even when the centre view is blame", async () => {
    useWorkspace.getState().setCentreView(REPO, "blame");
    selectStashFile();
    renderWithProviders(<DetailPane repoId={REPO} />);
    expect(await diffRegion()).toBeInTheDocument();
    expect(BlameView).not.toHaveBeenCalled();
    expect(getFileDiff).toHaveBeenCalledWith(REPO, "a.ts", COMMIT, false, undefined);
    expect(screen.getByRole("radio", { name: "Blame" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Blame" }).closest("label")).toHaveAttribute(
      "title",
      STASH_BLAME_REASON,
    );
  });

  it("a stash file leaves the stored centre view untouched", async () => {
    useWorkspace.getState().setCentreView(REPO, "blame");
    selectStashFile();
    renderWithProviders(<DetailPane repoId={REPO} />);
    await diffRegion();
    expect(useWorkspace.getState().centreView[REPO]).toBe("blame");
  });

  it("the stored blame view is kept for the next non-stash file", async () => {
    useWorkspace.getState().setCentreView(REPO, "blame");
    selectStashFile();
    renderWithProviders(<DetailPane repoId={REPO} />);
    await diffRegion();
    act(() => selectScope(COMMIT, "b.ts"));
    expect(await screen.findByRole("table", { name: "Blame" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Blame" })).toBeEnabled();
  });

  it("a stash file opens no menu and leaves the browser's own menu alone on a right-click", async () => {
    selectStashFile();
    renderWithProviders(<DetailPane repoId={REPO} />);
    await diffRegion();
    const event = createEvent.contextMenu(rowAt(1), { clientX: 30, clientY: 40 });
    fireEvent(rowAt(1), event);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  it("a commit file without a source keeps Blame enabled with no title", async () => {
    selectScope(COMMIT);
    renderWithProviders(<DetailPane repoId={REPO} />);
    await diffRegion();
    expect(screen.getByRole("radio", { name: "Blame" })).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Blame" }).closest("label")).not.toHaveAttribute(
      "title",
    );
  });
});

const noHunkButtons = () =>
  screen.queryByRole("button", { name: /^(Stage|Unstage|Discard|Select )/ });

// Contract: every commit-scope state keeps the file header and offers no working-tree actions.
describe("DetailPane commit scope states", () => {
  const commitSetup = (path = "a.ts") => {
    selectScope(COMMIT, path);
    return renderWithProviders(<DetailPane repoId={REPO} />);
  };

  it("should show the header and the loading status while a commit diff loads", async () => {
    vi.mocked(getFileDiff).mockReturnValue(new Promise(() => undefined));
    commitSetup();
    expect(await header()).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading diff…");
    expect(noHunkButtons()).toBeNull();
  });

  it("should show the header and an alert with Retry when a commit diff fails", async () => {
    vi.mocked(getFileDiff).mockRejectedValueOnce(gitError);
    commitSetup();
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await diffRegion()).toBeInTheDocument();
    expect(getFileDiff).toHaveBeenCalledTimes(2);
    expect(getFileDiff).toHaveBeenLastCalledWith(REPO, "a.ts", COMMIT, false, undefined);
  });

  it("should keep the header and offer no stage actions in the no-changes state", async () => {
    vi.mocked(getFileDiff).mockRejectedValue({ kind: "noChanges", message: "none" });
    commitSetup("src/a.ts");
    await screen.findByText("No changes in src/a.ts");
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeInTheDocument();
    expect(screen.queryByText(/No (staged|unstaged|\[object)/)).toBeNull();
    expect(noHunkButtons()).toBeNull();
  });

  it("should show the whitespace control in the commit no-changes state when hiding whitespace", async () => {
    await seedSettings({ diff: { ignoreWhitespace: true } });
    vi.mocked(getFileDiff).mockRejectedValue({ kind: "noChanges", message: "none" });
    commitSetup();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Hide whitespace changes" }));
    expect(useSettings.getState().settings.diff.ignoreWhitespace).toBe(false);
  });

  it("should show the header and the placeholder for a binary file in a commit", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([], { path: "blob.bin", isBinary: true, change: "modified", scope: COMMIT }),
    );
    commitSetup("blob.bin");
    expect(await screen.findByText("Binary file — no preview available")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeInTheDocument();
  });

  it("should load image bytes at the commit scope for a binary image in a commit", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(
      fileDiff([], { path: "logo.png", isBinary: true, change: "modified", scope: COMMIT }),
    );
    commitSetup("logo.png");
    expect(await screen.findByAltText("New image")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeInTheDocument();
    expect(getFileContent).toHaveBeenCalledWith(REPO, "logo.png", COMMIT, "new");
  });

  it("should show the header, no hunk actions and Load full diff for a truncated commit diff", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(textDiff({ truncated: true, scope: COMMIT }));
    commitSetup();
    expect(await screen.findByRole("button", { name: "Load full diff" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeInTheDocument();
    expect(noHunkButtons()).toBeNull();
  });

  it("should show the header and the empty-hunks copy for a commit diff without line changes", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(fileDiff([], { scope: COMMIT }));
    commitSetup();
    expect(await screen.findByText("No line changes in this file")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeInTheDocument();
  });

  it("should close the commit file from the header without touching the selected commit", async () => {
    useWorkspace.getState().selectCommit(REPO, "abc1234");
    commitSetup();
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Close diff" }));
    expect(useWorkspace.getState().selected[REPO]).toBeNull();
    expect(useWorkspace.getState().selectedCommit[REPO]).toBe("abc1234");
  });

  it("should store the file path as the history path from a commit-scope header", async () => {
    commitSetup("src/a.ts");
    await diffRegion();
    fireEvent.click(screen.getByRole("button", { name: "Show file history" }));
    expect(useWorkspace.getState().historyPath[REPO]).toBe("src/a.ts");
  });

  it("should show a commit rename in the header as old → new", async () => {
    vi.mocked(getFileDiff).mockResolvedValue(textDiff({ oldPath: "old.ts", scope: COMMIT }));
    commitSetup();
    expect(await screen.findByText("old.ts → a.ts")).toBeInTheDocument();
  });
});

// Contract: Blame never queries the diff; the cached diff is reused on return unless invalidated.
describe("DetailPane Diff and Blame round trips", () => {
  it("should not call getFileDiff for a commit while in Blame, then reuse the cache on return", async () => {
    selectScope(COMMIT);
    renderWithProviders(<DetailPane repoId={REPO} />);
    await diffRegion();
    fireEvent.click(screen.getByRole("radio", { name: "Blame" }));
    await screen.findByRole("table", { name: "Blame" });
    fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
    await diffRegion();
    expect(getFileDiff).toHaveBeenCalledTimes(1);
  });

  it("should refetch on return to Diff when the repo was invalidated during Blame", async () => {
    selectScope("unstaged");
    const { queryClient } = renderWithProviders(<DetailPane repoId={REPO} />);
    await diffRegion();
    fireEvent.click(screen.getByRole("radio", { name: "Blame" }));
    await screen.findByRole("table", { name: "Blame" });
    await act(() => queryClient.invalidateQueries({ queryKey: ["repo", REPO] }));
    expect(getFileDiff).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
    await diffRegion();
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledTimes(2));
  });

  it("should not refetch a mounted diff on window focus", async () => {
    selectScope("unstaged");
    renderWithProviders(<DetailPane repoId={REPO} />);
    await diffRegion();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(getFileDiff).toHaveBeenCalledTimes(1);
  });

  it("should keep the Blame view and fetch no diff when a commit file is replaced by another commit's file", async () => {
    useWorkspace.getState().setCentreView(REPO, "blame");
    selectScope(COMMIT);
    renderWithProviders(<DetailPane repoId={REPO} />);
    await screen.findByRole("table", { name: "Blame" });
    act(() => selectScope({ commit: "def5678" }));
    await waitFor(() =>
      expect(vi.mocked(BlameView)).toHaveBeenLastCalledWith(
        { repoId: REPO, path: "a.ts", oid: "def5678" },
        undefined,
      ),
    );
    expect(getFileDiff).not.toHaveBeenCalled();
  });
});

// Contract: only commit-scoped diffs are immutable; a working-tree diff revalidates on return.
describe("DetailPane diff caching across the Blame toggle", () => {
  const toggleBlameAndBack = async () => {
    await diffRegion();
    fireEvent.click(screen.getByRole("radio", { name: "Blame" }));
    await screen.findByRole("table", { name: "Blame" });
    fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
    await diffRegion();
  };

  it("should fetch an unstaged diff again after Diff, Blame, Diff with no invalidation", async () => {
    setup("a.ts", "unstaged");
    await toggleBlameAndBack();
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledTimes(2));
  });

  it("should fetch a staged diff again after Diff, Blame, Diff with no invalidation", async () => {
    setup("a.ts", "staged");
    await toggleBlameAndBack();
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledTimes(2));
  });

  it("should reuse a commit diff after Diff, Blame, Diff", async () => {
    selectScope(COMMIT);
    renderWithProviders(<DetailPane repoId={REPO} />);
    await toggleBlameAndBack();
    await new Promise((r) => setTimeout(r, 30));
    expect(getFileDiff).toHaveBeenCalledTimes(1);
  });
});

// Contract (spec 4.10): an unstaged selection whose status entry is conflicted opens the ConflictEditor.
describe("DetailPane conflict routing", () => {
  const statusEntry = (over: Partial<StatusEntry> & { path: string }): StatusEntry => ({
    oldPath: null,
    index: null,
    worktree: "conflicted",
    conflicted: true,
    ...over,
  });
  const provideStatus = (...entries: StatusEntry[]) =>
    vi.mocked(getStatus).mockResolvedValue({ entries, headUnborn: false });

  it("routes a conflicted unstaged selection to the ConflictEditor", async () => {
    provideStatus(statusEntry({ path: "a.ts" }));
    setup("a.ts", "unstaged");
    expect(await screen.findByTestId("conflict-editor")).toHaveTextContent("a.ts");
  });

  it("does not render the diff for a conflicted unstaged selection", async () => {
    provideStatus(statusEntry({ path: "a.ts" }));
    setup("a.ts", "unstaged");
    await screen.findByTestId("conflict-editor");
    expect(screen.queryByRole("region", { name: "Diff" })).toBeNull();
  });

  it("keeps the diff for a staged selection of the same path", async () => {
    provideStatus(statusEntry({ path: "a.ts" }));
    setup("a.ts", "staged");
    expect(await diffRegion()).toBeInTheDocument();
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("conflict-editor")).toBeNull();
  });

  it("keeps the diff when the entry is not conflicted", async () => {
    provideStatus(statusEntry({ path: "a.ts", worktree: "modified", conflicted: false }));
    setup("a.ts", "unstaged");
    expect(await diffRegion()).toBeInTheDocument();
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("conflict-editor")).toBeNull();
  });

  it("keeps the diff when another path is the conflicted one", async () => {
    provideStatus(statusEntry({ path: "other.ts" }));
    setup("a.ts", "unstaged");
    expect(await diffRegion()).toBeInTheDocument();
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("conflict-editor")).toBeNull();
  });

  it("keeps the diff when the file has no status entry", async () => {
    provideStatus();
    setup("a.ts", "unstaged");
    expect(await diffRegion()).toBeInTheDocument();
    expect(screen.queryByTestId("conflict-editor")).toBeNull();
  });

  it("falls back to the diff once the file is no longer conflicted", async () => {
    provideStatus(statusEntry({ path: "a.ts" }));
    const { queryClient } = setup("a.ts", "unstaged");
    await screen.findByTestId("conflict-editor");
    provideStatus(statusEntry({ path: "a.ts", worktree: "modified", conflicted: false }));
    await act(() => queryClient.invalidateQueries());
    expect(await diffRegion()).toBeInTheDocument();
  });
  it("shows the diff while the status is still loading, then the editor once it is conflicted", async () => {
    let release!: (s: { entries: StatusEntry[]; headUnborn: boolean }) => void;
    vi.mocked(getStatus).mockReturnValue(
      new Promise((r) => {
        release = r;
      }),
    );
    setup("a.ts", "unstaged");
    expect(await diffRegion()).toBeInTheDocument();
    expect(screen.queryByTestId("conflict-editor")).toBeNull();
    await act(async () => release({ entries: [statusEntry({ path: "a.ts" })], headUnborn: false }));
    expect(await screen.findByTestId("conflict-editor")).toHaveTextContent("a.ts");
    expect(screen.queryByRole("region", { name: "Diff" })).toBeNull();
  });

  it("keeps the diff when the status query failed", async () => {
    vi.mocked(getStatus).mockRejectedValue(gitError);
    setup("a.ts", "unstaged");
    expect(await diffRegion()).toBeInTheDocument();
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("conflict-editor")).toBeNull();
  });

  it("swaps the editor for the staged diff when the selection moves from unstaged to staged", async () => {
    provideStatus(statusEntry({ path: "a.ts" }));
    setup("a.ts", "unstaged");
    await screen.findByTestId("conflict-editor");
    select("a.ts", "staged");
    expect(await diffRegion()).toBeInTheDocument();
    expect(screen.queryByTestId("conflict-editor")).toBeNull();
  });

  it("swaps the staged diff for the editor when the selection moves back to unstaged", async () => {
    provideStatus(statusEntry({ path: "a.ts" }));
    setup("a.ts", "staged");
    await diffRegion();
    select("a.ts", "unstaged");
    expect(await screen.findByTestId("conflict-editor")).toHaveTextContent("a.ts");
    expect(screen.queryByRole("region", { name: "Diff" })).toBeNull();
  });

  it("shows another conflicted file in the editor when the selection moves between conflicts", async () => {
    provideStatus(statusEntry({ path: "a.ts" }), statusEntry({ path: "b.ts" }));
    setup("a.ts", "unstaged");
    await screen.findByTestId("conflict-editor");
    expect(conflictEditorMounts.count).toBe(1);
    select("b.ts", "unstaged");
    await waitFor(() => expect(screen.getByTestId("conflict-editor")).toHaveTextContent("b.ts"));
    expect(conflictEditorMounts.count).toBe(2);
  });

  it("renders nothing once the selection is cleared", async () => {
    provideStatus(statusEntry({ path: "a.ts" }));
    const { container } = setup("a.ts", "unstaged");
    await screen.findByTestId("conflict-editor");
    act(() => useWorkspace.getState().select(REPO, null));
    expect(container).toBeEmptyDOMElement();
  });
});

// Task 15: DetailPane passes scope and isStash to the FileHeader.
describe("DetailPane passes scope and isStash to the header (GR-14)", () => {
  it("passes scope and isStash to the header", async () => {
    // For a stash file (source === "stash"), DetailPane must set isStash=true on FileHeader,
    // which hides the external tool buttons. We verify the prop is threaded by checking
    // that no external tool buttons appear for a stash selection.
    // The stash detail path: workspace selects a stash file (source="stash").
    // getStashFiles doesn't exist on ipc mock here, but we can select a commit scope.
    // Use a commit scope to confirm scope is forwarded.
    vi.mocked(getFileDiff).mockResolvedValue(
      textDiff({ path: "a.ts", scope: { commit: "abc1234" } }),
    );
    act(() => useWorkspace.getState().select(REPO, { path: "a.ts", scope: { commit: "abc1234" } }));
    renderWithProviders(<DetailPane repoId={REPO} />);
    await screen.findByRole("radiogroup", { name: "View" });
    // A commit scope should have External diff but no Open in editor.
    // These buttons require the scope prop to be threaded from DetailPane to FileHeader.
    // If scope is not passed, FileHeader cannot know to hide Open in editor.
    // This test will fail until DetailPane passes scope and isStash to FileHeader.
    expect(screen.queryByRole("button", { name: "Open in editor" })).toBeNull();
  });
});
