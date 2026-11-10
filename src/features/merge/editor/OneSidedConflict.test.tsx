import { language } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFileContent, resolveConflicts, stagePaths } from "../../../lib/ipc";
import type { ConflictKind } from "../../../lib/ipc";
import { useWorkspace } from "../../../lib/store/workspace";
import { renderWithProviders } from "../../../test/renderWithProviders";
import { loadLanguage } from "../../diff/model/highlight";
import type { BlockLabels } from "./model/blocks";
import { OneSidedConflict } from "./OneSidedConflict";

vi.mock(import("../../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getFileContent: vi.fn(),
  stagePaths: vi.fn(),
  resolveConflicts: vi.fn(),
}));
vi.mock(import("../../diff/model/highlight"), async (importOriginal) => ({
  ...(await importOriginal()),
  loadLanguage: vi.fn(),
}));

const REPO = 3;
const PATH = "src/gone.txt";
const MERGE: BlockLabels = { ours: "main", theirs: "feature" };
const REBASE: BlockLabels = { ours: "main", theirs: "topic" };

const encode = (s: string): ArrayBuffer => {
  const u = new TextEncoder().encode(s);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
};

function setup(
  opts: { path?: string; kind?: ConflictKind; labels?: BlockLabels; text?: string } = {},
) {
  const { path = PATH, kind = "deletedByThem", labels = MERGE, text = "x\ny\nz\n" } = opts;
  if (!vi.mocked(getFileContent).getMockImplementation()) {
    vi.mocked(getFileContent).mockResolvedValue(encode(text));
  }
  const onClose = vi.fn();
  const view = renderWithProviders(
    <OneSidedConflict repoId={REPO} path={path} kind={kind} labels={labels} onClose={onClose} />,
  );
  return { ...view, onClose };
}

async function surviving(): Promise<EditorView> {
  const content = await screen.findByRole("textbox", { name: "Surviving file" });
  return EditorView.findFromDOM(content) as EditorView;
}
const btn = (name: string) => screen.getByRole("button", { name });
const click = (el: HTMLElement) => act(() => void fireEvent.click(el));

beforeEach(async () => {
  vi.resetAllMocks();
  const actual = await vi.importActual<typeof import("../../diff/model/highlight")>(
    "../../diff/model/highlight",
  );
  vi.mocked(loadLanguage).mockImplementation(actual.loadLanguage);
  vi.mocked(stagePaths).mockResolvedValue(undefined);
  vi.mocked(resolveConflicts).mockResolvedValue(undefined);
  useWorkspace.setState(useWorkspace.getInitialState(), true);
});

describe("OneSidedConflict notice", () => {
  it("names the deleting and modifying sides for deletedByUs", async () => {
    setup({ kind: "deletedByUs" });
    expect(await screen.findByText("Deleted on main, modified on feature.")).toBeInTheDocument();
  });

  it("names the sides the other way round for deletedByThem", async () => {
    setup({ kind: "deletedByThem" });
    expect(await screen.findByText("Deleted on feature, modified on main.")).toBeInTheDocument();
  });

  it("names the onto branch as the deleter during a rebase", async () => {
    setup({ kind: "deletedByUs", labels: REBASE });
    expect(await screen.findByText("Deleted on main, modified on topic.")).toBeInTheDocument();
  });
});

describe("OneSidedConflict contents", () => {
  it("shows the surviving contents read-only", async () => {
    setup();
    const view = await surviving();
    expect(view.state.doc.toString()).toBe("x\ny\nz\n");
    const box = screen.getByRole("textbox", { name: "Surviving file" });
    expect(box).toHaveTextContent("xyz");
    expect(view.state.readOnly).toBe(true);
    expect(box).toHaveAttribute("contenteditable", "false");
  });

  it("highlights by file extension under the limit", async () => {
    setup({ path: "src/app.ts" });
    const view = await surviving();
    await waitFor(() => expect(view.state.facet(language)).not.toBeNull());
  });

  it("shows the count-less toolbar: no Mark resolved, Keep all, Take all or merge tool", async () => {
    setup();
    await surviving();
    expect(screen.getByText(PATH)).toBeInTheDocument();
    expect(btn("Close")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark resolved" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Keep all/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Take all/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.queryByRole("button", { name: /merge tool/ })).toBeNull();
    expect(screen.queryByText(/conflicts? remaining|All conflicts resolved/)).toBeNull();
  });
});

describe("OneSidedConflict actions", () => {
  it("Keep file stages the full path and follows it into Staged", async () => {
    setup();
    await surviving();
    useWorkspace.getState().select(REPO, { path: PATH, scope: "unstaged" });
    click(btn("Keep file"));
    await waitFor(() =>
      expect(useWorkspace.getState().selected[REPO]).toEqual({ path: PATH, scope: "staged" }),
    );
    expect(stagePaths).toHaveBeenCalledExactlyOnceWith(REPO, [PATH]);
    expect(resolveConflicts).not.toHaveBeenCalled();
  });

  it("Delete file for deletedByThem resolves with theirs and follows the staged deletion", async () => {
    setup({ kind: "deletedByThem" });
    await surviving();
    useWorkspace.getState().select(REPO, { path: PATH, scope: "unstaged" });
    click(btn("Delete file"));
    await waitFor(() =>
      expect(useWorkspace.getState().selected[REPO]).toEqual({ path: PATH, scope: "staged" }),
    );
    expect(resolveConflicts).toHaveBeenCalledExactlyOnceWith(REPO, [PATH], "theirs");
    expect(stagePaths).not.toHaveBeenCalled();
  });

  it("Delete file for deletedByUs resolves with ours and closes the pane", async () => {
    setup({ kind: "deletedByUs" });
    await surviving();
    useWorkspace.getState().select(REPO, { path: PATH, scope: "unstaged" });
    click(btn("Delete file"));
    await waitFor(() => expect(useWorkspace.getState().selected[REPO] ?? null).toBeNull());
    expect(resolveConflicts).toHaveBeenCalledExactlyOnceWith(REPO, [PATH], "ours");
    expect(stagePaths).not.toHaveBeenCalled();
  });

  it("disables both buttons while an action is pending", async () => {
    vi.mocked(stagePaths).mockReturnValue(new Promise(() => undefined));
    setup();
    await surviving();
    click(btn("Keep file"));
    await waitFor(() => expect(btn("Keep file")).toBeDisabled());
    expect(btn("Delete file")).toBeDisabled();
  });

  it("shows the error and keeps the selection when Keep file fails", async () => {
    vi.mocked(stagePaths).mockRejectedValue({ kind: "io", message: "disk full" });
    setup();
    await surviving();
    useWorkspace.getState().select(REPO, { path: PATH, scope: "unstaged" });
    click(btn("Keep file"));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(useWorkspace.getState().selected[REPO]).toEqual({ path: PATH, scope: "unstaged" });
  });
});

describe("OneSidedConflict unreadable file", () => {
  it("keeps the notice and buttons when the file is not UTF-8", async () => {
    vi.mocked(getFileContent).mockResolvedValue(new Uint8Array([0x61, 0x00, 0x62]).buffer);
    setup();
    expect(
      await screen.findByRole("heading", { name: "Can’t edit gone.txt here" }),
    ).toBeInTheDocument();
    expect(screen.getByText("It is not UTF-8 text.")).toBeInTheDocument();
    expect(screen.getByText("Deleted on feature, modified on main.")).toBeInTheDocument();
    expect(btn("Keep file")).toBeInTheDocument();
    expect(btn("Delete file")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Surviving file" })).toBeNull();
  });

  it("keeps the notice and buttons when the file is missing", async () => {
    vi.mocked(getFileContent).mockRejectedValue({ kind: "pathNotFound", message: "nope" });
    setup();
    expect(await screen.findByText("It is missing from the working tree.")).toBeInTheDocument();
    expect(btn("Keep file")).toBeInTheDocument();
    expect(btn("Delete file")).toBeInTheDocument();
  });

  it("uses the file name, not the path, in the loading status", () => {
    vi.mocked(getFileContent).mockReturnValue(new Promise(() => undefined));
    setup();
    expect(screen.getByRole("status")).toHaveTextContent("Loading gone.txt…");
  });
});

describe("OneSidedConflict refetch", () => {
  it("replaces the contents when the file changes on disk", async () => {
    const { queryClient } = setup();
    const view = await surviving();
    vi.mocked(getFileContent).mockResolvedValue(encode("new\n"));
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(view.state.doc.toString()).toBe("new\n"));
  });
});
