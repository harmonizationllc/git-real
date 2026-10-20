import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCommitFiles } from "../../lib/ipc";
import type { CommitFile } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { oidOf } from "../../test/graphFixtures";
import { commitFile } from "../../test/historyFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { CommitFiles } from "./CommitFiles";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getCommitFiles: vi.fn(),
}));

const OID = oidOf(0);
const OTHER = oidOf(1);

const FILES: CommitFile[] = [
  commitFile("src/a.ts"),
  commitFile("src/new.ts", { change: "renamed", oldPath: "src/old.ts" }),
  commitFile("docs/gone.md", { change: "deleted" }),
];

async function renderFiles(files: CommitFile[] = FILES, repoId = 1) {
  vi.mocked(getCommitFiles).mockResolvedValue(files);
  const view = renderWithProviders(<CommitFiles repoId={repoId} oid={OID} />);
  await screen.findByRole("region", { name: "Changed files" });
  return view;
}

const fileButton = (name: string | RegExp) => screen.getByRole("button", { name });
const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 40, clientY: 60 });

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspace.setState(useWorkspace.getInitialState(), true);
});

// Contract: a Changed files region headed "Files (n)" with one button row per file.
describe("CommitFiles content", () => {
  it("should request the files for the repo id and oid", async () => {
    await renderFiles(FILES, 7);
    expect(getCommitFiles).toHaveBeenCalledExactlyOnceWith(7, OID);
  });

  it("should head the list with the file count", async () => {
    await renderFiles();
    expect(screen.getByRole("heading", { name: "Files (3)" })).toBeInTheDocument();
  });

  it("should show a count of zero for a commit that changed nothing", async () => {
    await renderFiles([]);
    expect(screen.getByRole("heading", { name: "Files (0)" })).toBeInTheDocument();
  });

  it("should render one button per file in a list", async () => {
    await renderFiles();
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("button")).toHaveLength(3);
  });

  it("should show each file's path", async () => {
    await renderFiles();
    expect(fileButton(/src\/a\.ts/)).toBeInTheDocument();
    expect(fileButton(/docs\/gone\.md/)).toBeInTheDocument();
  });

  it("should show a status badge for the kind of change", async () => {
    await renderFiles();
    expect(
      within(fileButton(/docs\/gone\.md/)).getByRole("img", { name: "deleted" }),
    ).toBeVisible();
    expect(within(fileButton(/src\/a\.ts/)).getByRole("img", { name: "modified" })).toBeVisible();
  });

  it("should show old → new for a renamed file", async () => {
    await renderFiles();
    expect(fileButton(/src\/new\.ts/)).toHaveTextContent("src/old.ts → src/new.ts");
  });

  it("should show the renamed badge for a renamed file", async () => {
    await renderFiles();
    expect(within(fileButton(/src\/new\.ts/)).getByRole("img", { name: "renamed" })).toBeVisible();
  });

  it("should show a plain path without an arrow for a file that was not renamed", async () => {
    await renderFiles();
    expect(fileButton(/src\/a\.ts/)).not.toHaveTextContent("→");
  });
});

// Contract: clicking a file selects it with this commit's scope, and the selected file is aria-current.
describe("CommitFiles selection", () => {
  it("should select the file with the commit scope when clicked", async () => {
    await renderFiles();
    fireEvent.click(fileButton(/src\/a\.ts/));
    expect(useWorkspace.getState().selected[1]).toEqual({
      path: "src/a.ts",
      scope: { commit: OID },
    });
  });

  it("should select a renamed file by its new path", async () => {
    await renderFiles();
    fireEvent.click(fileButton(/src\/new\.ts/));
    expect(useWorkspace.getState().selected[1]).toEqual({
      path: "src/new.ts",
      scope: { commit: OID },
    });
  });

  it("should select for the component's own repo id", async () => {
    await renderFiles(FILES, 4);
    fireEvent.click(fileButton(/src\/a\.ts/));
    expect(useWorkspace.getState().selected[4]).toBeDefined();
    expect(useWorkspace.getState().selected[1]).toBeUndefined();
  });

  it('should mark the selected file with aria-current="true"', async () => {
    useWorkspace.getState().select(1, { path: "src/a.ts", scope: { commit: OID } });
    await renderFiles();
    expect(fileButton(/src\/a\.ts/)).toHaveAttribute("aria-current", "true");
  });

  it("should not mark the other files", async () => {
    useWorkspace.getState().select(1, { path: "src/a.ts", scope: { commit: OID } });
    await renderFiles();
    expect(fileButton(/docs\/gone\.md/)).not.toHaveAttribute("aria-current");
  });

  it("should not mark a file selected under another commit's scope", async () => {
    useWorkspace.getState().select(1, { path: "src/a.ts", scope: { commit: OTHER } });
    await renderFiles();
    expect(fileButton(/src\/a\.ts/)).not.toHaveAttribute("aria-current");
  });

  it("should not mark a file selected under a working-tree scope", async () => {
    useWorkspace.getState().select(1, { path: "src/a.ts", scope: "unstaged" });
    await renderFiles();
    expect(fileButton(/src\/a\.ts/)).not.toHaveAttribute("aria-current");
  });

  it("should mark nothing when no file is selected", async () => {
    await renderFiles();
    expect(document.querySelector("[aria-current]")).toBeNull();
  });

  it("should move aria-current to the file just clicked", async () => {
    await renderFiles();
    fireEvent.click(fileButton(/docs\/gone\.md/));
    await waitFor(() =>
      expect(fileButton(/docs\/gone\.md/)).toHaveAttribute("aria-current", "true"),
    );
  });
});

// Contract: the context menu offers File history and Blame at this commit.
describe("CommitFiles context menu", () => {
  it("should offer File history and Blame at this commit", async () => {
    await renderFiles();
    rightClick(fileButton(/src\/a\.ts/));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "File history",
      "Blame at this commit",
    ]);
  });

  it("should show no menu until a file is right-clicked", async () => {
    await renderFiles();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should show the file's history from the File history item", async () => {
    await renderFiles();
    rightClick(fileButton(/src\/a\.ts/));
    fireEvent.click(screen.getByRole("menuitem", { name: "File history" }));
    expect(useWorkspace.getState().historyPath[1]).toBe("src/a.ts");
  });

  it("should show a renamed file's history under its new path", async () => {
    await renderFiles();
    rightClick(fileButton(/src\/new\.ts/));
    fireEvent.click(screen.getByRole("menuitem", { name: "File history" }));
    expect(useWorkspace.getState().historyPath[1]).toBe("src/new.ts");
  });

  it("should select the file with the commit scope from Blame at this commit", async () => {
    await renderFiles();
    rightClick(fileButton(/src\/a\.ts/));
    fireEvent.click(screen.getByRole("menuitem", { name: "Blame at this commit" }));
    expect(useWorkspace.getState().selected[1]).toEqual({
      path: "src/a.ts",
      scope: { commit: OID },
    });
  });

  it("should switch the centre view to blame from Blame at this commit", async () => {
    await renderFiles();
    rightClick(fileButton(/src\/a\.ts/));
    fireEvent.click(screen.getByRole("menuitem", { name: "Blame at this commit" }));
    expect(useWorkspace.getState().centreView[1]).toBe("blame");
  });

  it("should not change the centre view from File history", async () => {
    await renderFiles();
    rightClick(fileButton(/src\/a\.ts/));
    fireEvent.click(screen.getByRole("menuitem", { name: "File history" }));
    expect(useWorkspace.getState().centreView[1]).toBeUndefined();
  });

  it("should focus the Files heading when the menu closes and nothing held focus", async () => {
    const { user } = await renderFiles();
    rightClick(fileButton(/src\/a\.ts/));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("heading", { name: "Files (3)" })).toHaveFocus();
  });

  it("should mark the Files heading as a programmatic focus target", async () => {
    await renderFiles();
    const target = screen.getByRole("heading", { name: "Files (3)" });
    expect(target).toHaveAttribute("data-focus-target");
    expect(target).toHaveAttribute("tabindex", "-1");
  });
});

// Contract: loading shows a status; a failure shows an alert with Retry.
describe("CommitFiles loading and error", () => {
  it("should show Loading files… with role status while loading", () => {
    vi.mocked(getCommitFiles).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<CommitFiles repoId={1} oid={OID} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading files…");
  });

  it("should not show the files region while loading", () => {
    vi.mocked(getCommitFiles).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<CommitFiles repoId={1} oid={OID} />);
    expect(screen.queryByRole("region", { name: "Changed files" })).toBeNull();
  });

  it("should not show the loading status once loaded", async () => {
    await renderFiles();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("should show the error message in an alert on failure", async () => {
    vi.mocked(getCommitFiles).mockRejectedValue({ kind: "git", message: "files boom" });
    renderWithProviders(<CommitFiles repoId={1} oid={OID} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("files boom");
  });

  it("should fetch the files again when Retry is clicked", async () => {
    vi.mocked(getCommitFiles).mockRejectedValueOnce({ kind: "git", message: "files boom" });
    vi.mocked(getCommitFiles).mockResolvedValue(FILES);
    renderWithProviders(<CommitFiles repoId={1} oid={OID} />);
    fireEvent.click(
      await within(await screen.findByRole("alert")).findByRole("button", { name: "Retry" }),
    );
    expect(await screen.findByRole("heading", { name: "Files (3)" })).toBeInTheDocument();
    expect(getCommitFiles).toHaveBeenCalledTimes(2);
  });
});

// Contract: right-clicking a row selects that file in the commit, then opens the menu on it.
describe("CommitFiles right-click", () => {
  it("should select the right-clicked file with the commit scope", async () => {
    await renderFiles();
    rightClick(fileButton(/docs\/gone\.md/));
    expect(useWorkspace.getState().selected[1]).toEqual({
      path: "docs/gone.md",
      scope: { commit: OID },
    });
  });

  it("should mark the right-clicked file as current", async () => {
    await renderFiles();
    rightClick(fileButton(/docs\/gone\.md/));
    await waitFor(() =>
      expect(fileButton(/docs\/gone\.md/)).toHaveAttribute("aria-current", "true"),
    );
  });

  it("should open the menu at the pointer position", async () => {
    await renderFiles();
    rightClick(fileButton(/src\/a\.ts/));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("should not change the centre view just by right-clicking", async () => {
    await renderFiles();
    rightClick(fileButton(/src\/a\.ts/));
    expect(useWorkspace.getState().centreView[1]).toBeUndefined();
  });
});

// Contract: a files error offers Retry only; dismissing would strand the summary without files.
describe("CommitFiles error actions", () => {
  it("should offer Retry and no Dismiss on failure", async () => {
    vi.mocked(getCommitFiles).mockRejectedValue({ kind: "git", message: "files boom" });
    renderWithProviders(<CommitFiles repoId={1} oid={OID} />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(within(alert).queryByRole("button", { name: /dismiss/i })).toBeNull();
    expect(within(alert).getAllByRole("button")).toHaveLength(1);
  });
});
