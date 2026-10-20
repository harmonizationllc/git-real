import { undo } from "@codemirror/commands";
import { language } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFileContent,
  getOperationState,
  listBranches,
  resolveConflicts,
  writeResolution,
} from "../../../lib/ipc";
import type { BranchList, OperationState } from "../../../lib/ipc";
import { queryKeys } from "../../../lib/query/keys";
import { useWorkspace } from "../../../lib/store/workspace";
import { renderWithProviders } from "../../../test/renderWithProviders";
import { HIGHLIGHT_LIMIT } from "../../diff/model/limits";
import { languageFor, loadLanguage } from "../../diff/model/highlight";
import { ConflictEditor } from "./ConflictEditor";
import { SAVE_DELAY_MS } from "./useResolutionWriter";

vi.mock(import("../../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getFileContent: vi.fn(),
  getOperationState: vi.fn(),
  listBranches: vi.fn(),
  writeResolution: vi.fn(),
  resolveConflicts: vi.fn(),
}));
vi.mock(import("../../diff/model/highlight"), async (importOriginal) => ({
  ...(await importOriginal()),
  loadLanguage: vi.fn(),
}));

const REPO = 3;
const PATH = "src/conflict.zzz";
const TS_PATH = "src/app.ts";

// Two blocks: ours a1/a2, theirs b1/b2.
const TWO = [
  "top",
  "<<<<<<< HEAD",
  "a1",
  "=======",
  "b1",
  ">>>>>>> feature",
  "mid",
  "<<<<<<< HEAD",
  "a2",
  "=======",
  "b2",
  ">>>>>>> feature",
  "end",
  "",
].join("\n");
const ALL_OURS = "top\na1\nmid\na2\nend\n";
const ALL_THEIRS = "top\nb1\nmid\nb2\nend\n";
const ONE = "x\n<<<<<<< HEAD\nonly-a\n=======\nonly-b\n>>>>>>> feature\ny\n";

const message = { subject: "s", body: "" };
const oid = (c: string) => c.repeat(40);
const mergeState: OperationState = { kind: "merge", head: oid("a"), branch: "feature", message };
const rebaseState: OperationState = {
  kind: "rebase",
  onto: oid("b"),
  ontoName: "main",
  branch: "topic",
  step: 1,
  total: 2,
};
const mainHead: BranchList = { head: { kind: "branch", name: "main" }, local: [], remotes: [] };

const encode = (s: string): ArrayBuffer => {
  const u = new TextEncoder().encode(s);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
};

/** The fake working-tree file: writeResolution updates it, getFileContent reads it. */
let disk: ArrayBuffer;
const writeToDisk = (text: string) => {
  disk = encode(text);
};

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

function setup(
  opts: { path?: string; text?: string; bytes?: ArrayBuffer; state?: OperationState } = {},
) {
  const { path = PATH, text = TWO, state = mergeState } = opts;
  if (opts.bytes) disk = opts.bytes;
  else writeToDisk(text);
  vi.mocked(getOperationState).mockResolvedValue(state);
  const view = renderWithProviders(<ConflictEditor repoId={REPO} path={path} />);
  return view;
}

async function editor(): Promise<EditorView> {
  const content = await screen.findByRole("textbox", { name: "Conflict editor" });
  return EditorView.findFromDOM(content) as EditorView;
}
const doc = (view: EditorView) => view.state.doc.toString();
const type = (view: EditorView, insert: string, at = view.state.doc.length) =>
  act(() => view.dispatch({ changes: { from: at, insert } }));
const replaceAll = (view: EditorView, insert: string) =>
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert } }));
const btn = (name: string) => screen.getByRole("button", { name });
const bar = (n: number) => screen.getByRole("group", { name: `Conflict ${n}` });
const click = (el: HTMLElement) => act(() => void fireEvent.click(el));

/** Simulates the watcher: the repo prefix is invalidated and content is refetched. */
const refetch = (queryClient: { invalidateQueries(f: object): Promise<void> }) =>
  act(() => queryClient.invalidateQueries({ queryKey: queryKeys.repo(REPO) }));

beforeEach(async () => {
  vi.resetAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const actual = await vi.importActual<typeof import("../../diff/model/highlight")>(
    "../../diff/model/highlight",
  );
  vi.mocked(loadLanguage).mockImplementation(actual.loadLanguage);
  vi.mocked(getFileContent).mockImplementation(() => Promise.resolve(disk));
  vi.mocked(listBranches).mockResolvedValue(mainHead);
  vi.mocked(writeResolution).mockImplementation((_id, _path, text) => {
    writeToDisk(text);
    return Promise.resolve();
  });
  vi.mocked(resolveConflicts).mockResolvedValue(undefined);
  useWorkspace.setState(useWorkspace.getInitialState(), true);
});

afterEach(() => {
  vi.useRealTimers();
});

// Contract (4.7 state 1): while the bytes load, the toolbar shows path and Close and a status line.
describe("ConflictEditor loading", () => {
  it("shows Loading {name}… with role status", () => {
    vi.mocked(getFileContent).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<ConflictEditor repoId={REPO} path={PATH} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading conflict.zzz…");
  });

  it("shows only Close in the toolbar while loading", () => {
    vi.mocked(getFileContent).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<ConflictEditor repoId={REPO} path={PATH} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Close"]);
  });

  it("does not mount the editor while loading", () => {
    vi.mocked(getFileContent).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<ConflictEditor repoId={REPO} path={PATH} />);
    expect(screen.queryByRole("textbox", { name: "Conflict editor" })).toBeNull();
  });

  it("requests the unstaged working-tree side of the path", async () => {
    setup();
    await editor();
    expect(getFileContent).toHaveBeenCalledWith(REPO, PATH, "unstaged", "new");
  });
});

// Contract (4.7 state 2): files that cannot be edited here show a placeholder with the reason.
describe("ConflictEditor placeholder", () => {
  const placeholder = (name = "conflict.zzz") =>
    screen.findByRole("heading", { name: `Can’t edit ${name} here` });

  it("shows the placeholder with reasons for bytes above 2 MB", async () => {
    setup({ bytes: new ArrayBuffer(2 * 1024 * 1024 + 1) });
    await placeholder();
    expect(screen.getByText("It is larger than 2 MB.")).toBeInTheDocument();
  });

  it("shows the placeholder with reasons for invalid UTF-8", async () => {
    setup({ bytes: new Uint8Array([0x61, 0xff, 0xfe]).buffer });
    await placeholder();
    expect(screen.getByText("It is not UTF-8 text.")).toBeInTheDocument();
  });

  it("shows the placeholder with reasons for a tooLarge AppError", async () => {
    vi.mocked(getFileContent).mockRejectedValue({ kind: "tooLarge", message: "big" });
    setup();
    await placeholder();
    expect(screen.getByText("It is larger than 2 MB.")).toBeInTheDocument();
  });

  it("shows the placeholder with reasons for a binaryFile AppError", async () => {
    vi.mocked(getFileContent).mockRejectedValue({ kind: "binaryFile", message: "bin" });
    setup();
    await placeholder();
    expect(screen.getByText("It is not UTF-8 text.")).toBeInTheDocument();
  });

  it("shows the placeholder with reasons for a pathNotFound AppError", async () => {
    vi.mocked(getFileContent).mockRejectedValue({ kind: "pathNotFound", message: "nope" });
    setup();
    await placeholder();
    expect(screen.getByText("It is missing from the working tree.")).toBeInTheDocument();
  });

  it("shows the placeholder with reasons for another error: its message", async () => {
    vi.mocked(getFileContent).mockRejectedValue({ kind: "git", message: "libgit2 exploded" });
    setup();
    await placeholder();
    expect(screen.getByText("libgit2 exploded")).toBeInTheDocument();
  });

  it("names the file by its last path segment", async () => {
    vi.mocked(getFileContent).mockRejectedValue({ kind: "binaryFile", message: "bin" });
    setup({ path: "deep/dir/image.png" });
    expect(await placeholder("image.png")).toBeInTheDocument();
  });

  it("does not mount the editor on the placeholder", async () => {
    vi.mocked(getFileContent).mockRejectedValue({ kind: "binaryFile", message: "bin" });
    setup();
    await placeholder();
    expect(screen.queryByRole("textbox", { name: "Conflict editor" })).toBeNull();
  });

  it("shows only the path and Close in the toolbar on the placeholder", async () => {
    vi.mocked(getFileContent).mockRejectedValue({ kind: "binaryFile", message: "bin" });
    setup();
    await placeholder();
    expect(screen.getByText(PATH)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark resolved" })).toBeNull();
  });

  it("placeholder Keep and Take resolve the file", async () => {
    vi.mocked(getFileContent).mockRejectedValue({ kind: "binaryFile", message: "bin" });
    setup();
    await placeholder();
    await screen.findByRole("button", { name: "Keep main" });
    click(btn("Keep main"));
    await waitFor(() => expect(resolveConflicts).toHaveBeenCalledTimes(1));
    expect(resolveConflicts).toHaveBeenLastCalledWith(REPO, [PATH], "ours");
    click(btn("Take feature"));
    await waitFor(() => expect(resolveConflicts).toHaveBeenCalledTimes(2));
    expect(resolveConflicts).toHaveBeenLastCalledWith(REPO, [PATH], "theirs");
  });

  it("disables the placeholder buttons while a resolve is pending", async () => {
    vi.mocked(getFileContent).mockRejectedValue({ kind: "binaryFile", message: "bin" });
    vi.mocked(resolveConflicts).mockReturnValue(new Promise(() => undefined));
    setup();
    await placeholder();
    click(await screen.findByRole("button", { name: "Keep main" }));
    await waitFor(() => expect(btn("Take feature")).toBeDisabled());
    expect(btn("Keep main")).toBeDisabled();
  });

  it("shows the error of a failed placeholder Keep", async () => {
    vi.mocked(getFileContent).mockRejectedValue({ kind: "binaryFile", message: "bin" });
    vi.mocked(resolveConflicts).mockRejectedValue({ kind: "git", message: "cannot resolve" });
    setup();
    await placeholder();
    click(await screen.findByRole("button", { name: "Keep main" }));
    expect(await screen.findByText("cannot resolve")).toBeInTheDocument();
  });

  it("labels the placeholder buttons from the operation state", async () => {
    vi.mocked(getFileContent).mockRejectedValue({ kind: "binaryFile", message: "bin" });
    setup({ state: rebaseState });
    await placeholder();
    expect(await screen.findByRole("button", { name: "Take topic" })).toBeInTheDocument();
  });
});

// Contract (4.7 state 3): the editable state shows the toolbar, block bars and the live count.
describe("ConflictEditor editable state", () => {
  it("renders the editor with the block bars and the count", async () => {
    setup();
    const view = await editor();
    expect(doc(view)).toBe(TWO);
    expect(screen.getByText("2 conflicts remaining")).toBeInTheDocument();
    expect(bar(1)).toBeInTheDocument();
    expect(bar(2)).toBeInTheDocument();
  });

  it("shows the path in the toolbar", async () => {
    setup();
    await editor();
    expect(screen.getByText(PATH)).toBeInTheDocument();
  });

  it("shows All conflicts resolved for a file without markers", async () => {
    setup({ text: "clean\n" });
    await editor();
    expect(screen.getByText("All conflicts resolved")).toBeInTheDocument();
  });

  it("shows 1 conflict remaining for a single block", async () => {
    setup({ text: ONE });
    await editor();
    expect(screen.getByText("1 conflict remaining")).toBeInTheDocument();
  });

  it("Keep main on a block resolves it and the count drops", async () => {
    setup();
    const view = await editor();
    click(within(bar(1)).getByRole("button", { name: "Keep main" }));
    expect(doc(view)).toBe(TWO.replace(/<<<<<<< HEAD\na1\n=======\nb1\n>>>>>>> feature\n/, "a1\n"));
    expect(screen.getByText("1 conflict remaining")).toBeInTheDocument();
  });

  it("Take feature on a block takes the incoming side", async () => {
    setup();
    const view = await editor();
    click(within(bar(2)).getByRole("button", { name: "Take feature" }));
    expect(doc(view)).toContain("mid\nb2\nend\n");
  });

  it("Keep all / Take all resolve every block", async () => {
    setup();
    const view = await editor();
    click(btn("Keep all main"));
    expect(doc(view)).toBe(ALL_OURS);
    expect(screen.getByText("All conflicts resolved")).toBeInTheDocument();
    click(within(bar(1)).getByRole("button", { name: "Undo" }));
    click(within(bar(2)).getByRole("button", { name: "Undo" }));
    click(btn("Take all feature"));
    expect(doc(view)).toBe(ALL_THEIRS);
  });

  it("disables Keep all and Take all once every block is resolved", async () => {
    setup();
    await editor();
    click(btn("Keep all main"));
    expect(btn("Keep all main")).toBeDisabled();
    expect(btn("Take all feature")).toBeDisabled();
  });

  it("Undo on a block restores its markers and the count rises", async () => {
    setup();
    await editor();
    click(within(bar(1)).getByRole("button", { name: "Keep main" }));
    click(within(bar(1)).getByRole("button", { name: "Undo" }));
    expect(screen.getByText("2 conflicts remaining")).toBeInTheDocument();
  });

  it("Previous and Next move the selection between blocks", async () => {
    setup();
    const view = await editor();
    const first = TWO.indexOf("<<<<<<<");
    const second = TWO.lastIndexOf("<<<<<<<");
    act(() => view.dispatch({ selection: { anchor: 0 } }));
    click(btn("Next"));
    expect(view.state.selection.main.head).toBe(first);
    click(btn("Next"));
    expect(view.state.selection.main.head).toBe(second);
    click(btn("Previous"));
    expect(view.state.selection.main.head).toBe(first);
  });
});

// Contract (4.9): edits autosave through the writer, 500 ms after the last change, unstaged.
describe("ConflictEditor autosave", () => {
  it("typing schedules an autosave", async () => {
    setup();
    const view = await editor();
    type(view, "x", 0);
    expect(writeResolution).not.toHaveBeenCalled();
    await tick(SAVE_DELAY_MS);
    expect(writeResolution).toHaveBeenCalledExactlyOnceWith(REPO, PATH, "x" + TWO, false);
  });

  it("typing restores CRLF when the source had CRLF", async () => {
    setup({ text: TWO.replace(/\n/g, "\r\n") });
    const view = await editor();
    expect(doc(view)).toBe(TWO);
    type(view, "x", 0);
    await tick(SAVE_DELAY_MS);
    expect(writeResolution).toHaveBeenCalledExactlyOnceWith(
      REPO,
      PATH,
      ("x" + TWO).replace(/\n/g, "\r\n"),
      false,
    );
  });

  it("does not write anything before the user edits", async () => {
    setup();
    await editor();
    await tick(SAVE_DELAY_MS * 2);
    expect(writeResolution).not.toHaveBeenCalled();
  });

  it("picking a block autosaves the resolved text", async () => {
    setup();
    await editor();
    click(btn("Keep all main"));
    await tick(SAVE_DELAY_MS);
    expect(writeResolution).toHaveBeenCalledExactlyOnceWith(REPO, PATH, ALL_OURS, false);
  });

  it("shows the error strip with Dismiss when an autosave fails", async () => {
    vi.mocked(writeResolution).mockRejectedValue({ kind: "io", message: "disk full" });
    setup();
    const view = await editor();
    type(view, "x", 0);
    await tick(SAVE_DELAY_MS);
    expect(screen.getByRole("alert")).toHaveTextContent("disk full");
    click(btn("Dismiss"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract (spec focus 5): the count comes from re-parsing the document, so hand edits count.
describe("ConflictEditor hand edits", () => {
  it("counts markers left by a custom edit", async () => {
    setup();
    const view = await editor();
    type(view, "edited ", TWO.indexOf("a1"));
    expect(screen.getByText("2 conflicts remaining")).toBeInTheDocument();
    expect(btn("Mark resolved")).toBeDisabled();
  });

  it("enables Mark resolved once a custom edit removes the markers", async () => {
    setup();
    const view = await editor();
    replaceAll(view, "clean\n");
    expect(screen.getByText("All conflicts resolved")).toBeInTheDocument();
    expect(btn("Mark resolved")).toBeEnabled();
  });

  it("disables Keep all and Take all when only edited blocks remain", async () => {
    setup({ text: ONE });
    const view = await editor();
    type(view, "z", ONE.indexOf("only-a"));
    expect(screen.getByText("1 conflict remaining")).toBeInTheDocument();
    expect(btn("Mark resolved")).toBeDisabled();
    expect(btn("Keep all main")).toBeDisabled();
    expect(btn("Take all feature")).toBeDisabled();
  });

  it("marks a hand-edited block as Edited", async () => {
    setup();
    const view = await editor();
    type(view, "z", TWO.indexOf("a1"));
    expect(within(bar(1)).getByText("Edited")).toBeInTheDocument();
  });
});

// Contract (4.8): Mark resolved flushes, stages and reselects the staged file; failure keeps the editor.
describe("ConflictEditor Mark resolved", () => {
  it("Mark resolved flushes, stages and reselects the file as staged", async () => {
    setup();
    const view = await editor();
    useWorkspace.getState().select(REPO, { path: PATH, scope: "unstaged" });
    replaceAll(view, "clean\n");
    click(btn("Mark resolved"));
    await waitFor(() =>
      expect(useWorkspace.getState().selected[REPO]).toEqual({ path: PATH, scope: "staged" }),
    );
    expect(vi.mocked(writeResolution).mock.calls).toEqual([
      [REPO, PATH, "clean\n", false],
      [REPO, PATH, "clean\n", true],
    ]);
  });

  it("Mark resolved reselects as staged without waiting for the refetch", async () => {
    setup();
    await editor();
    click(btn("Keep all main"));
    // Every refetch triggered by the invalidation stays pending.
    vi.mocked(getFileContent).mockReturnValue(new Promise(() => undefined));
    vi.mocked(getOperationState).mockReturnValue(new Promise(() => undefined));
    vi.mocked(listBranches).mockReturnValue(new Promise(() => undefined));
    click(btn("Mark resolved"));
    await waitFor(() =>
      expect(useWorkspace.getState().selected[REPO]).toEqual({ path: PATH, scope: "staged" }),
    );
  });

  it("Mark resolved after Keep all stages the resolved text", async () => {
    setup();
    await editor();
    click(btn("Keep all main"));
    click(btn("Mark resolved"));
    await waitFor(() =>
      expect(writeResolution).toHaveBeenLastCalledWith(REPO, PATH, ALL_OURS, true),
    );
  });

  it("Mark resolved failure shows the error strip with Dismiss", async () => {
    vi.mocked(writeResolution).mockImplementation((_id, _path, _text, stage) =>
      stage
        ? Promise.reject<void>({ kind: "unresolvedConflicts", message: "still conflicted" })
        : Promise.resolve(),
    );
    setup();
    const view = await editor();
    useWorkspace.getState().select(REPO, { path: PATH, scope: "unstaged" });
    replaceAll(view, "clean\n");
    click(btn("Mark resolved"));
    expect(await screen.findByRole("alert")).toHaveTextContent("still conflicted");
    click(btn("Dismiss"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Mark resolved failure keeps the unstaged selection", async () => {
    vi.mocked(writeResolution).mockRejectedValue({ kind: "git", message: "nope" });
    setup();
    const view = await editor();
    useWorkspace.getState().select(REPO, { path: PATH, scope: "unstaged" });
    replaceAll(view, "clean\n");
    click(btn("Mark resolved"));
    await screen.findByRole("alert");
    expect(useWorkspace.getState().selected[REPO]).toEqual({ path: PATH, scope: "unstaged" });
  });

  it("disables Mark resolved while a save is in flight", async () => {
    vi.mocked(writeResolution).mockReturnValue(new Promise(() => undefined));
    setup({ text: "clean\n" });
    const view = await editor();
    type(view, "x", 0);
    await tick(SAVE_DELAY_MS);
    expect(btn("Mark resolved")).toBeDisabled();
    expect(btn("Mark resolved")).toHaveAttribute("title", "Saving…");
  });
});

// Contract (4.7 reload rule): disk changes replace the document unless they are our own echo.
describe("ConflictEditor reload", () => {
  it("reloads when the file changes on disk", async () => {
    const { queryClient } = setup();
    const view = await editor();
    writeToDisk(ONE);
    await refetch(queryClient);
    await waitFor(() => expect(doc(view)).toBe(ONE));
    expect(screen.getByText("1 conflict remaining")).toBeInTheDocument();
    expect(bar(1)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Conflict 2" })).toBeNull();
  });

  it("reloads a resolved file to zero conflicts", async () => {
    const { queryClient } = setup();
    const view = await editor();
    writeToDisk(ALL_OURS);
    await refetch(queryClient);
    await waitFor(() => expect(doc(view)).toBe(ALL_OURS));
    expect(screen.getByText("All conflicts resolved")).toBeInTheDocument();
  });

  it("a disk reload is not undoable", async () => {
    const { queryClient } = setup();
    const view = await editor();
    writeToDisk(ONE);
    await refetch(queryClient);
    await waitFor(() => expect(doc(view)).toBe(ONE));
    act(() => void undo(view));
    expect(doc(view)).toBe(ONE);
  });

  it("a reload drops the unsent autosave", async () => {
    const { queryClient } = setup();
    const view = await editor();
    type(view, "unsent", 0);
    writeToDisk(ONE);
    await refetch(queryClient);
    await waitFor(() => expect(doc(view)).toBe(ONE));
    await tick(SAVE_DELAY_MS * 2);
    const sent = vi.mocked(writeResolution).mock.calls.map((c) => c[2]);
    expect(sent.some((text) => text.includes("unsent"))).toBe(false);
  });

  it("a disk reload does not schedule an autosave", async () => {
    const { queryClient } = setup();
    const view = await editor();
    writeToDisk(ONE);
    await refetch(queryClient);
    await waitFor(() => expect(doc(view)).toBe(ONE));
    await tick(SAVE_DELAY_MS * 2);
    expect(writeResolution).not.toHaveBeenCalled();
  });

  it("keeps the editor when a background refetch fails", async () => {
    const { queryClient } = setup();
    const view = await editor();
    vi.mocked(getFileContent).mockRejectedValueOnce({ kind: "io", message: "flaky" });
    await refetch(queryClient);
    await tick(0);
    expect(getFileContent).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("textbox", { name: "Conflict editor" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Can’t edit/ })).toBeNull();
    expect(doc(view)).toBe(TWO);
  });

  it("ignores a watcher echo of an earlier write", async () => {
    const { queryClient } = setup();
    const view = await editor();
    type(view, "a");
    await tick(SAVE_DELAY_MS);
    expect(writeResolution).toHaveBeenCalledExactlyOnceWith(REPO, PATH, TWO + "a", false);
    type(view, "b");
    // The watcher now delivers the file as written for "a", while "b" is still unsent.
    writeToDisk(TWO + "a");
    await refetch(queryClient);
    await tick(0);
    expect(doc(view)).toBe(TWO + "ab");
  });

  it("keeps the unsent autosave when it ignores an echo", async () => {
    const { queryClient } = setup();
    const view = await editor();
    type(view, "a");
    await tick(SAVE_DELAY_MS);
    type(view, "b");
    writeToDisk(TWO + "a");
    await refetch(queryClient);
    await tick(SAVE_DELAY_MS);
    expect(writeResolution).toHaveBeenLastCalledWith(REPO, PATH, TWO + "ab", false);
  });

  it("ignores a refetch equal to the current document", async () => {
    const { queryClient } = setup();
    const view = await editor();
    type(view, "x");
    // The disk already holds the edited text, but the autosave has not been sent yet.
    writeToDisk(TWO + "x");
    await refetch(queryClient);
    await tick(0);
    expect(doc(view)).toBe(TWO + "x");
    await tick(SAVE_DELAY_MS);
    expect(writeResolution).toHaveBeenCalledExactlyOnceWith(REPO, PATH, TWO + "x", false);
  });

  it("keeps the cursor when a refetch delivers identical bytes", async () => {
    const { queryClient } = setup();
    const view = await editor();
    act(() => view.dispatch({ selection: { anchor: 5 } }));
    await refetch(queryClient);
    await tick(0);
    expect(view.state.selection.main.head).toBe(5);
  });
});

// Contract (4.7): side labels follow the operation state, including after the editor mounted.
describe("ConflictEditor labels", () => {
  it("labels follow the operation state", async () => {
    setup({ state: rebaseState });
    await editor();
    expect(within(bar(1)).getByRole("button", { name: "Keep main" })).toBeInTheDocument();
    expect(within(bar(1)).getByRole("button", { name: "Take topic" })).toBeInTheDocument();
    expect(btn("Keep all main")).toBeInTheDocument();
    expect(btn("Take all topic")).toBeInTheDocument();
  });

  it("falls back to ours and theirs without an operation", async () => {
    setup({ state: { kind: "none" } });
    await editor();
    expect(within(bar(1)).getByRole("button", { name: "Keep ours" })).toBeInTheDocument();
  });

  it("relabels the block bars when the operation state changes", async () => {
    const { queryClient } = setup();
    await editor();
    expect(within(bar(1)).getByRole("button", { name: "Take feature" })).toBeInTheDocument();
    vi.mocked(getOperationState).mockResolvedValue(rebaseState);
    await refetch(queryClient);
    await waitFor(() =>
      expect(within(bar(1)).getByRole("button", { name: "Take topic" })).toBeInTheDocument(),
    );
  });

  it("uses HEAD as the ours label when HEAD is detached", async () => {
    vi.mocked(listBranches).mockResolvedValue({
      head: { kind: "detached", oid: oid("a") },
      local: [],
      remotes: [],
    });
    setup();
    await editor();
    await waitFor(() =>
      expect(within(bar(1)).getByRole("button", { name: "Keep HEAD" })).toBeInTheDocument(),
    );
  });
});

// Contract (4.7): syntax highlighting loads for known languages and is skipped for huge files.
describe("ConflictEditor language", () => {
  it("loads language support for a known extension", async () => {
    setup({ path: TS_PATH });
    await editor();
    await waitFor(() => expect(loadLanguage).toHaveBeenCalledExactlyOnceWith(languageFor(TS_PATH)));
  });

  it("loads language support for a file of exactly HIGHLIGHT_LIMIT lines", async () => {
    setup({ path: TS_PATH, text: "x\n".repeat(HIGHLIGHT_LIMIT - 1) });
    await editor();
    await waitFor(() => expect(loadLanguage).toHaveBeenCalledOnce());
  });

  it("skips language loading above HIGHLIGHT_LIMIT", async () => {
    setup({ path: TS_PATH, text: "x\n".repeat(HIGHLIGHT_LIMIT) });
    await editor();
    await tick(50);
    expect(loadLanguage).not.toHaveBeenCalled();
  });

  it("skips language loading for an unknown extension", async () => {
    setup();
    await editor();
    await tick(50);
    expect(loadLanguage).not.toHaveBeenCalled();
  });

  it("applies the loaded language to the editor", async () => {
    setup({ path: TS_PATH });
    const view = await editor();
    await waitFor(() => expect(view.state.facet(language)).not.toBeNull());
  });

  it("ignores a language that finishes loading after the editor closed", async () => {
    const actual = await vi.importActual<typeof import("../../diff/model/highlight")>(
      "../../diff/model/highlight",
    );
    let release!: () => void;
    vi.mocked(loadLanguage).mockImplementation(async (desc) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return actual.loadLanguage(desc);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = setup({ path: TS_PATH });
    await editor();
    await waitFor(() => expect(loadLanguage).toHaveBeenCalledOnce());
    unmount();
    const dispatch = vi.spyOn(EditorView.prototype, "dispatch");
    await act(async () => {
      release();
      await tick(50);
    });
    const calls = dispatch.mock.calls.length;
    dispatch.mockRestore();
    expect(calls).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });

  it("drops highlighting when a reload takes the file above HIGHLIGHT_LIMIT", async () => {
    const { queryClient } = setup({ path: TS_PATH });
    const view = await editor();
    await waitFor(() => expect(view.state.facet(language)).not.toBeNull());
    writeToDisk("x\n".repeat(HIGHLIGHT_LIMIT));
    await refetch(queryClient);
    await waitFor(() => expect(view.state.doc.lines).toBeGreaterThan(HIGHLIGHT_LIMIT));
    await waitFor(() => expect(view.state.facet(language)).toBeNull());
  });

  it("does not apply a language that was still loading when a reload crossed HIGHLIGHT_LIMIT", async () => {
    const actual = await vi.importActual<typeof import("../../diff/model/highlight")>(
      "../../diff/model/highlight",
    );
    let release!: () => void;
    vi.mocked(loadLanguage).mockImplementation(async (desc) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return actual.loadLanguage(desc);
    });
    const { queryClient } = setup({ path: TS_PATH });
    const view = await editor();
    await waitFor(() => expect(loadLanguage).toHaveBeenCalledOnce());
    writeToDisk("x\n".repeat(HIGHLIGHT_LIMIT));
    await refetch(queryClient);
    await waitFor(() => expect(view.state.doc.lines).toBeGreaterThan(HIGHLIGHT_LIMIT));
    await act(async () => {
      release();
      await tick(50);
    });
    expect(view.state.facet(language)).toBeNull();
  });

  it("logs the failure and keeps the editor usable when the language fails to load", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("grammar missing");
    vi.mocked(loadLanguage).mockRejectedValue(failure);
    setup({ path: TS_PATH });
    const view = await editor();
    await waitFor(() => expect(error).toHaveBeenCalledWith("language load failed", failure));
    expect(doc(view)).toBe(TWO);
  });
});

// Contract (4.8): Close clears the selection, in every state that shows the toolbar.
describe("ConflictEditor Close", () => {
  it("Close clears the selection", async () => {
    setup();
    await editor();
    useWorkspace.getState().select(REPO, { path: PATH, scope: "unstaged" });
    click(btn("Close"));
    expect(useWorkspace.getState().selected[REPO]).toBeNull();
  });

  it("Close with an unsent autosave still saves it exactly once", async () => {
    const { unmount } = setup();
    const view = await editor();
    useWorkspace.getState().select(REPO, { path: PATH, scope: "unstaged" });
    type(view, "x", 0);
    click(btn("Close"));
    expect(useWorkspace.getState().selected[REPO]).toBeNull();
    await tick(SAVE_DELAY_MS);
    unmount();
    await tick(0);
    expect(writeResolution).toHaveBeenCalledExactlyOnceWith(REPO, PATH, "x" + TWO, false);
  });

  it("Close clears the selection while loading", () => {
    vi.mocked(getFileContent).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<ConflictEditor repoId={REPO} path={PATH} />);
    useWorkspace.getState().select(REPO, { path: PATH, scope: "unstaged" });
    click(btn("Close"));
    expect(useWorkspace.getState().selected[REPO]).toBeNull();
  });

  it("Close clears the selection from the placeholder", async () => {
    vi.mocked(getFileContent).mockRejectedValue({ kind: "binaryFile", message: "bin" });
    setup();
    await screen.findByRole("heading", { name: "Can’t edit conflict.zzz here" });
    useWorkspace.getState().select(REPO, { path: PATH, scope: "unstaged" });
    click(btn("Close"));
    expect(useWorkspace.getState().selected[REPO]).toBeNull();
  });
});

// Contract (4.9): unmounting the editor sends the last unsent edit.
describe("ConflictEditor unmount", () => {
  it("flushes the unsent autosave when closed", async () => {
    const { unmount } = setup();
    const view = await editor();
    type(view, "x", 0);
    unmount();
    await tick(0);
    expect(writeResolution).toHaveBeenCalledExactlyOnceWith(REPO, PATH, "x" + TWO, false);
  });
});
