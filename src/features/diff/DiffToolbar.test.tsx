import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FileDiff } from "../../lib/ipc";
import type { DiffMode } from "../../lib/store/diffPrefs";
import { fileDiff, hunk, L } from "../../test/diffFixtures";
import { DiffToolbar } from "./DiffToolbar";

// Two hunks: 2 additions and 1 deletion over 5 lines in total.
const baseDiff = fileDiff([
  hunk([L("context", "c", 1, 1), L("deletion", "d", 2, null), L("addition", "a", null, 2)]),
  hunk([L("addition", "b", null, 9), L("context", "e", 9, 10)]),
]);

function setup(
  over: {
    diff?: FileDiff;
    mode?: DiffMode;
    ignoreWhitespace?: boolean;
  } = {},
) {
  const props = {
    onModeChange: vi.fn(),
    onIgnoreWhitespaceChange: vi.fn(),
    onLoadFull: vi.fn(),
  };
  const view = render(
    <DiffToolbar
      diff={over.diff ?? baseDiff}
      mode={over.mode ?? "split"}
      ignoreWhitespace={over.ignoreWhitespace ?? false}
      {...props}
    />,
  );
  return { ...view, ...props };
}

// Contract: the path now lives in FileHeader; the toolbar shows none.
describe("DiffToolbar path removal", () => {
  it("should not show the path", () => {
    setup();
    expect(screen.queryByText("a.ts")).toBeNull();
  });

  it("should not show old and new path for a rename", () => {
    const { container } = setup({
      diff: { ...baseDiff, oldPath: "old.ts", path: "new.ts", change: "renamed" },
    });
    expect(container.textContent).not.toContain("→");
    expect(screen.queryByText("new.ts")).toBeNull();
  });
});

// Contract: a labelled radio group chooses the view mode.
describe("DiffToolbar view mode", () => {
  it("should expose a radiogroup named View mode with both radios", () => {
    setup();
    const group = screen.getByRole("radiogroup", { name: "View mode" });
    expect(group).toContainElement(screen.getByRole("radio", { name: "Side by side" }));
    expect(group).toContainElement(screen.getByRole("radio", { name: "Unified" }));
  });

  it("should check Side by side when mode is split", () => {
    setup({ mode: "split" });
    expect(screen.getByRole("radio", { name: "Side by side" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Unified" })).not.toBeChecked();
  });

  it("should check Unified when mode is unified", () => {
    setup({ mode: "unified" });
    expect(screen.getByRole("radio", { name: "Unified" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Side by side" })).not.toBeChecked();
  });

  it("should call onModeChange with unified when Unified is clicked", () => {
    const { onModeChange } = setup({ mode: "split" });
    fireEvent.click(screen.getByRole("radio", { name: "Unified" }));
    expect(onModeChange).toHaveBeenCalledWith("unified");
  });

  it("should call onModeChange with split when Side by side is clicked", () => {
    const { onModeChange } = setup({ mode: "unified" });
    fireEvent.click(screen.getByRole("radio", { name: "Side by side" }));
    expect(onModeChange).toHaveBeenCalledWith("split");
  });
});

// Contract: the whitespace checkbox mirrors the preference and reports toggles.
describe("DiffToolbar whitespace", () => {
  it("should leave the checkbox unchecked when ignoreWhitespace is false", () => {
    setup({ ignoreWhitespace: false });
    expect(screen.getByRole("checkbox", { name: "Hide whitespace changes" })).not.toBeChecked();
  });

  it("should check the checkbox when ignoreWhitespace is true", () => {
    setup({ ignoreWhitespace: true });
    expect(screen.getByRole("checkbox", { name: "Hide whitespace changes" })).toBeChecked();
  });

  it("should call onIgnoreWhitespaceChange with true when checking", () => {
    const { onIgnoreWhitespaceChange } = setup({ ignoreWhitespace: false });
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide whitespace changes" }));
    expect(onIgnoreWhitespaceChange).toHaveBeenCalledWith(true);
  });

  it("should call onIgnoreWhitespaceChange with false when unchecking", () => {
    const { onIgnoreWhitespaceChange } = setup({ ignoreWhitespace: true });
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide whitespace changes" }));
    expect(onIgnoreWhitespaceChange).toHaveBeenCalledWith(false);
  });
});

// Contract: the summary counts additions and deletions over every hunk.
describe("DiffToolbar summary", () => {
  it("should count additions over all hunks", () => {
    setup();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("should count deletions over all hunks", () => {
    setup();
    expect(screen.getByText("−1")).toBeInTheDocument();
  });

  it("should show zero counts for a diff without hunks", () => {
    setup({ diff: fileDiff([]) });
    expect(screen.getByText("+0")).toBeInTheDocument();
    expect(screen.getByText("−0")).toBeInTheDocument();
  });
});

// Contract: a truncated diff says so in a status and offers the full diff.
describe("DiffToolbar truncation", () => {
  const truncated = { ...baseDiff, truncated: true };

  it("should show the line count in a status when truncated", () => {
    setup({ diff: truncated });
    expect(screen.getByRole("status")).toHaveTextContent("Showing the first 5 lines");
  });

  it("should keep the Load full diff button out of the status text", () => {
    setup({ diff: truncated });
    expect(screen.getByRole("status")).not.toHaveTextContent("Load full diff");
  });

  it("should call onLoadFull when Load full diff is clicked", () => {
    const { onLoadFull } = setup({ diff: truncated });
    fireEvent.click(screen.getByRole("button", { name: "Load full diff" }));
    expect(onLoadFull).toHaveBeenCalledTimes(1);
  });

  it("should show no status when not truncated", () => {
    setup();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("should show no Load full diff button when not truncated", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Load full diff" })).toBeNull();
  });
});

// Contract: a decoded diff carries an encoding notice.
describe("DiffToolbar encoding notice", () => {
  it("should show the notice when the file was decoded", () => {
    setup({ diff: { ...baseDiff, oldEncoding: "utf16Le", newEncoding: "utf16Le" } });
    expect(screen.getByTestId("encoding-notice")).toHaveTextContent("Decoded from UTF-16 LE");
  });

  it("should show the changed-encoding notice when the encodings differ", () => {
    setup({ diff: { ...baseDiff, oldEncoding: "utf16Le", newEncoding: "utf32Be" } });
    expect(screen.getByTestId("encoding-notice")).toHaveTextContent(
      "Encoding changed from UTF-16 LE to UTF-32 BE",
    );
  });

  it("should show no notice for an ordinary diff", () => {
    setup();
    expect(screen.queryByTestId("encoding-notice")).toBeNull();
  });
});

// Contract: counts only add and remove lines; a path without an old path has no arrow.
describe("DiffToolbar summary edge cases", () => {
  it("should show +0 and the deletion count when there are no additions", () => {
    setup({ diff: fileDiff([hunk([L("deletion", "d", 1, null), L("deletion", "e", 2, null)])]) });
    expect(screen.getByText("+0")).toBeInTheDocument();
    expect(screen.getByText("−2")).toBeInTheDocument();
  });

  it("should show −0 and the addition count when there are no deletions", () => {
    setup({ diff: fileDiff([hunk([L("addition", "a", null, 1)])]) });
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("−0")).toBeInTheDocument();
  });

  it("should not count context lines", () => {
    setup({ diff: fileDiff([hunk([L("context", "c", 1, 1), L("context", "d", 2, 2)])]) });
    expect(screen.getByText("+0")).toBeInTheDocument();
    expect(screen.getByText("−0")).toBeInTheDocument();
  });
});

// Contract: the radios form one group per toolbar so the browser keeps a single choice.
describe("DiffToolbar radio group", () => {
  it("should give both radios the same non-empty name", () => {
    setup();
    const [a, b] = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(a.name).not.toBe("");
    expect(a.name).toBe(b.name);
  });

  it("should not give the whitespace checkbox the radios' name", () => {
    setup();
    const radio = screen.getAllByRole("radio")[0] as HTMLInputElement;
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.name).not.toBe(radio.name);
  });

  it("should give two toolbars different group names", () => {
    setup();
    setup();
    const names = (screen.getAllByRole("radio") as HTMLInputElement[]).map((r) => r.name);
    expect(new Set(names).size).toBe(2);
  });

  it("should give each radio its mode as the value", () => {
    setup();
    const values = (screen.getAllByRole("radio") as HTMLInputElement[]).map((r) => r.value);
    expect(values).toEqual(["split", "unified"]);
  });
});

// Contract: the truncation notice and the encoding notice are independent.
describe("DiffToolbar notices together", () => {
  it("should show both the encoding notice and the truncation status when both apply", () => {
    setup({
      diff: { ...baseDiff, truncated: true, oldEncoding: "utf16Le", newEncoding: "utf16Le" },
    });
    expect(screen.getByTestId("encoding-notice")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Showing the first 5 lines");
  });

  it("should show no Load full diff button for a decoded diff that is not truncated", () => {
    setup({ diff: { ...baseDiff, oldEncoding: "utf16Le", newEncoding: "utf16Le" } });
    expect(screen.queryByRole("button", { name: "Load full diff" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

// Contract: the close control moved to FileHeader; the toolbar renders none.
describe("DiffToolbar close removal", () => {
  it("should not render a Close diff button", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Close diff" })).toBeNull();
  });
});
