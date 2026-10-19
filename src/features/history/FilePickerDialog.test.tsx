import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listTrackedFiles } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { renderWithProviders } from "../../test/renderWithProviders";
import { FilePickerDialog } from "./FilePickerDialog";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  listTrackedFiles: vi.fn(),
}));

const FILES = ["README.md", "src/main.rs", "src/lib.rs", "docs/main-notes.md"];

type Props = Partial<React.ComponentProps<typeof FilePickerDialog>>;

async function renderDialog(props: Props = {}, wait = true) {
  const onPick = vi.fn();
  const onCancel = vi.fn();
  const view = renderWithProviders(
    <FilePickerDialog repoId={1} open onPick={onPick} onCancel={onCancel} {...props} />,
  );
  if (props.open !== false && wait) await screen.findAllByRole("option");
  return { onPick, onCancel, ...view };
}

const input = () => screen.getByRole("searchbox", { name: "Find file" });
const options = () => screen.getAllByRole("option").map((o) => o.textContent);
const activeOption = () =>
  document.getElementById(input().getAttribute("aria-activedescendant") ?? "missing");
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const press = (key: string) => fireEvent.keyDown(input(), { key });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listTrackedFiles).mockResolvedValue(FILES);
});

// Contract: nothing while closed; when open a modal File history dialog with a search box and a Files listbox.
describe("FilePickerDialog rendering", () => {
  it("should render nothing when closed", async () => {
    await renderDialog({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should not fetch the files while closed", async () => {
    await renderDialog({ open: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(listTrackedFiles).not.toHaveBeenCalled();
  });

  it("should render a modal dialog titled File history when open", async () => {
    await renderDialog();
    expect(screen.getByRole("dialog", { name: "File history" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
  });

  it("should request the tracked files for the repo id", async () => {
    await renderDialog({ repoId: 5 });
    expect(listTrackedFiles).toHaveBeenCalledWith(5);
  });

  it("should render a search input named Find file with the placeholder", async () => {
    await renderDialog();
    expect(input()).toHaveAttribute("placeholder", "Type a file name");
  });

  it("should render a listbox named Files with one option per file", async () => {
    await renderDialog();
    const list = screen.getByRole("listbox", { name: "Files" });
    expect(within(list).getAllByRole("option")).toHaveLength(4);
  });

  it("should list every file under an empty query in the order received", async () => {
    await renderDialog();
    expect(options()).toEqual(FILES);
  });
});

// Contract: opening focuses the search input and closing restores the previous focus.
describe("FilePickerDialog focus", () => {
  it("should focus the search input when opened", async () => {
    await renderDialog();
    expect(input()).toHaveFocus();
  });

  it("should restore focus to the previously focused element on close", async () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    const ui = (open: boolean) => (
      <>
        <button type="button">Opener</button>
        <FilePickerDialog repoId={1} open={open} onPick={onPick} onCancel={onCancel} />
      </>
    );
    const { rerender } = renderWithProviders(ui(false));
    screen.getByRole("button", { name: "Opener" }).focus();
    rerender(ui(true));
    await screen.findAllByRole("option");
    rerender(ui(false));
    expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus();
  });
});

// Contract: typing filters and ranks with rankFiles; blank queries list the first files.
describe("FilePickerDialog filtering", () => {
  it("should keep only the files that match the query", async () => {
    await renderDialog();
    type("lib");
    expect(options()).toEqual(["src/lib.rs"]);
  });

  it("should match case-insensitively", async () => {
    await renderDialog();
    type("README");
    expect(options()).toEqual(["README.md"]);
    type("readme");
    expect(options()).toEqual(["README.md"]);
  });

  it("should rank a basename match above a scattered match", async () => {
    vi.mocked(listTrackedFiles).mockResolvedValue(["m/a/i/n.txt", "src/main.rs"]);
    await renderDialog();
    type("main");
    expect(options()).toEqual(["src/main.rs", "m/a/i/n.txt"]);
  });

  it("should show No matching files when nothing matches", async () => {
    await renderDialog();
    type("zzzzz");
    expect(screen.getByText("No matching files")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toEqual([]);
  });

  it("should not show No matching files while files match", async () => {
    await renderDialog();
    expect(screen.queryByText("No matching files")).toBeNull();
  });

  it("should list the first 200 files for a whitespace-only query", async () => {
    vi.mocked(listTrackedFiles).mockResolvedValue(Array.from({ length: 250 }, (_, i) => `f${i}`));
    await renderDialog();
    type("   ");
    expect(screen.getAllByRole("option")).toHaveLength(200);
    expect(options()[0]).toBe("f0");
  });

  it("should trim the query before matching", async () => {
    await renderDialog();
    type("  lib  ");
    expect(options()).toEqual(["src/lib.rs"]);
  });

  it("should cap the results at 200 rows", async () => {
    vi.mocked(listTrackedFiles).mockResolvedValue(Array.from({ length: 250 }, (_, i) => `f${i}`));
    await renderDialog();
    expect(screen.getAllByRole("option")).toHaveLength(200);
  });

  it("should list all files when fewer than 200 exist", async () => {
    await renderDialog();
    expect(screen.getAllByRole("option")).toHaveLength(FILES.length);
  });
});

// Contract: the input owns focus, so the combobox wiring lives on it.
describe("FilePickerDialog combobox", () => {
  it("should point aria-controls at the listbox", async () => {
    await renderDialog();
    const list = screen.getByRole("listbox", { name: "Files" });
    expect(input().getAttribute("aria-controls")).toBe(list.id);
    expect(list.id).not.toBe("");
  });

  it("should make the first option active on open", async () => {
    await renderDialog();
    expect(activeOption()).toBe(screen.getAllByRole("option")[0]);
    expect(activeOption()).toHaveAttribute("aria-selected", "true");
  });

  it("should not put aria-activedescendant on the listbox", async () => {
    await renderDialog();
    expect(screen.getByRole("listbox", { name: "Files" })).not.toHaveAttribute(
      "aria-activedescendant",
    );
  });

  it("should move the active option down on ArrowDown", async () => {
    await renderDialog();
    press("ArrowDown");
    expect(activeOption()).toBe(screen.getAllByRole("option")[1]);
  });

  it("should move the active option back up on ArrowUp", async () => {
    await renderDialog();
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowUp");
    expect(activeOption()).toBe(screen.getAllByRole("option")[1]);
  });

  it("should mark only the active option aria-selected", async () => {
    await renderDialog();
    press("ArrowDown");
    const selected = screen
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toEqual([screen.getAllByRole("option")[1]]);
  });

  it("should reset the active option to the first when the query changes", async () => {
    await renderDialog();
    press("ArrowDown");
    press("ArrowDown");
    type("rs");
    expect(activeOption()).toBe(screen.getAllByRole("option")[0]);
  });

  it("should prevent the default action of ArrowDown and ArrowUp", async () => {
    await renderDialog();
    expect(press("ArrowDown")).toBe(false);
    expect(press("ArrowUp")).toBe(false);
  });
});

// Contract: Enter or a click picks, Escape or the backdrop cancels.
describe("FilePickerDialog picking", () => {
  it("should pick the active file on Enter", async () => {
    const { onPick } = await renderDialog();
    press("Enter");
    expect(onPick).toHaveBeenCalledExactlyOnceWith("README.md");
  });

  it("should pick the file moved to with ArrowDown on Enter", async () => {
    const { onPick } = await renderDialog();
    press("ArrowDown");
    press("Enter");
    expect(onPick).toHaveBeenCalledExactlyOnceWith("src/main.rs");
  });

  it("should pick the best match for a typed query on Enter", async () => {
    const { onPick } = await renderDialog();
    type("lib");
    press("Enter");
    expect(onPick).toHaveBeenCalledExactlyOnceWith("src/lib.rs");
  });

  it("should prevent the default action of Enter", async () => {
    await renderDialog();
    expect(press("Enter")).toBe(false);
  });

  it("should pick nothing on Enter when no file matches", async () => {
    const { onPick } = await renderDialog();
    type("zzzzz");
    press("Enter");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("should pick a file when its option is clicked", async () => {
    const { onPick } = await renderDialog();
    fireEvent.click(screen.getByRole("option", { name: "src/lib.rs" }));
    expect(onPick).toHaveBeenCalledExactlyOnceWith("src/lib.rs");
  });

  it("should pick nothing before any key or click", async () => {
    const { onPick } = await renderDialog();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("should cancel on Escape", async () => {
    const { onCancel } = await renderDialog();
    press("Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("should cancel when the backdrop is clicked", async () => {
    const { onCancel } = await renderDialog();
    fireEvent.click(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("should not cancel when the dialog itself is clicked", async () => {
    const { onCancel } = await renderDialog();
    fireEvent.click(screen.getByRole("dialog"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("should not cancel on other keys", async () => {
    const { onCancel } = await renderDialog();
    press("a");
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// Contract: each open starts clean.
describe("FilePickerDialog reopening", () => {
  it("should clear the query when reopened", async () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    const ui = (open: boolean) => (
      <FilePickerDialog repoId={1} open={open} onPick={onPick} onCancel={onCancel} />
    );
    const { rerender } = renderWithProviders(ui(true));
    await screen.findAllByRole("option");
    await userEvent.type(input(), "lib");
    rerender(ui(false));
    rerender(ui(true));
    await screen.findAllByRole("option");
    expect(input()).toHaveValue("");
    expect(options()).toEqual(FILES);
  });

  it("should reset the active option when reopened", async () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    const ui = (open: boolean) => (
      <FilePickerDialog repoId={1} open={open} onPick={onPick} onCancel={onCancel} />
    );
    const { rerender } = renderWithProviders(ui(true));
    await screen.findAllByRole("option");
    press("ArrowDown");
    rerender(ui(false));
    rerender(ui(true));
    await screen.findAllByRole("option");
    expect(activeOption()).toBe(screen.getAllByRole("option")[0]);
  });
});

// Contract: Loading files… while pending; a failure shows an alert with Retry.
describe("FilePickerDialog loading and error", () => {
  it("should show Loading files… with role status while loading", async () => {
    vi.mocked(listTrackedFiles).mockReturnValue(new Promise(() => undefined));
    await renderDialog({}, false);
    expect(screen.getByRole("status")).toHaveTextContent("Loading files…");
  });

  it("should still show the search input while loading", async () => {
    vi.mocked(listTrackedFiles).mockReturnValue(new Promise(() => undefined));
    await renderDialog({}, false);
    expect(input()).toBeInTheDocument();
  });

  it("should not show No matching files while loading", async () => {
    vi.mocked(listTrackedFiles).mockReturnValue(new Promise(() => undefined));
    await renderDialog({}, false);
    expect(screen.queryByText("No matching files")).toBeNull();
  });

  it("should pick nothing on Enter while loading", async () => {
    vi.mocked(listTrackedFiles).mockReturnValue(new Promise(() => undefined));
    const { onPick } = await renderDialog({}, false);
    press("Enter");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("should show the error message in an alert on failure", async () => {
    vi.mocked(listTrackedFiles).mockRejectedValue({ kind: "git", message: "list boom" });
    await renderDialog({}, false);
    expect(await screen.findByRole("alert")).toHaveTextContent("list boom");
  });

  it("should fetch the files again when Retry is clicked", async () => {
    vi.mocked(listTrackedFiles).mockRejectedValueOnce({ kind: "git", message: "list boom" });
    await renderDialog({}, false);
    fireEvent.click(
      await within(await screen.findByRole("alert")).findByRole("button", { name: "Retry" }),
    );
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(4));
    expect(listTrackedFiles).toHaveBeenCalledTimes(2);
  });
});

// Contract: ArrowUp and ArrowDown clamp at the ends of the results rather than wrapping.
describe("FilePickerDialog arrow clamping", () => {
  it("should stay on the first option on ArrowUp at the start", async () => {
    await renderDialog();
    press("ArrowUp");
    expect(activeOption()).toBe(screen.getAllByRole("option")[0]);
  });

  it("should pick the first file on Enter after ArrowUp at the start", async () => {
    const { onPick } = await renderDialog();
    press("ArrowUp");
    press("Enter");
    expect(onPick).toHaveBeenCalledExactlyOnceWith(FILES[0]);
  });

  it("should stay on the last option on ArrowDown at the end", async () => {
    await renderDialog();
    for (let i = 0; i < FILES.length + 3; i++) press("ArrowDown");
    expect(activeOption()).toBe(screen.getAllByRole("option")[FILES.length - 1]);
  });

  it("should pick the last file on Enter after ArrowDown past the end", async () => {
    const { onPick } = await renderDialog();
    for (let i = 0; i < FILES.length + 3; i++) press("ArrowDown");
    press("Enter");
    expect(onPick).toHaveBeenCalledExactlyOnceWith(FILES[FILES.length - 1]);
  });

  it("should move up from the last option after clamping at the end", async () => {
    await renderDialog();
    for (let i = 0; i < FILES.length + 3; i++) press("ArrowDown");
    press("ArrowUp");
    expect(activeOption()).toBe(screen.getAllByRole("option")[FILES.length - 2]);
  });

  it("should keep the only option active on both arrows when one file matches", async () => {
    await renderDialog();
    type("lib");
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowUp");
    expect(activeOption()).toBe(screen.getAllByRole("option")[0]);
  });
});

// Contract (review fix round 1): Enter on a focused button activates it, and Enter never picks a missing row.
describe("FilePickerDialog review fixes", () => {
  it("should retry when Enter is pressed on the focused Retry button", async () => {
    vi.mocked(listTrackedFiles).mockRejectedValueOnce({ kind: "git", message: "list boom" });
    const { user } = await renderDialog({}, false);
    const retry = await within(await screen.findByRole("alert")).findByRole("button", {
      name: "Retry",
    });
    retry.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(listTrackedFiles).toHaveBeenCalledTimes(2));
  });

  it("should never pick undefined when the list shrinks under the active last row", async () => {
    const { onPick, queryClient } = await renderDialog();
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowDown");
    expect(activeOption()).toBe(screen.getAllByRole("option")[FILES.length - 1]);
    vi.mocked(listTrackedFiles).mockResolvedValue(["README.md"]);
    await queryClient.refetchQueries({ queryKey: queryKeys.trackedFiles(1) });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    press("Enter");
    expect(onPick).not.toHaveBeenCalledWith(undefined);
    for (const call of onPick.mock.calls) expect(FILES).toContain(call[0]);
  });
});
