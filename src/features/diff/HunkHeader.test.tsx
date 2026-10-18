import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DiffScope } from "../../lib/ipc";
import { HunkHeader } from "./HunkHeader";

function setup(
  over: {
    scope?: DiffScope;
    selectedCount?: number;
    disabledReason?: string;
    withAction?: boolean;
  } = {},
) {
  const onAction = vi.fn();
  const view = render(
    <HunkHeader
      header="@@ -1,2 +1,2 @@"
      scope={over.scope ?? "unstaged"}
      selectedCount={over.selectedCount ?? 0}
      disabledReason={over.disabledReason}
      onAction={over.withAction === false ? undefined : onAction}
    />,
  );
  return { ...view, onAction };
}

const names = () => screen.queryAllByRole("button").map((b) => b.textContent);

// Contract: the header text is a plain element marked data-kind header, not a table row.
describe("HunkHeader text", () => {
  it("should render the header text", () => {
    setup();
    expect(screen.getByText("@@ -1,2 +1,2 @@")).toBeInTheDocument();
  });

  it("should mark the root with data-kind header", () => {
    const { container } = setup();
    expect(container.firstElementChild).toHaveAttribute("data-kind", "header");
  });

  it("should not use the row role", () => {
    setup();
    expect(screen.queryByRole("row")).toBeNull();
  });
});

// Contract: labels follow scope and selection: hunk at 0, line(s) otherwise, ellipsis on discard only.
describe("HunkHeader labels", () => {
  it("should offer Stage hunk and Discard hunk… when unstaged with nothing selected", () => {
    setup();
    expect(names()).toEqual(["Stage hunk", "Discard hunk…"]);
  });

  it("should offer only Unstage hunk when staged with nothing selected", () => {
    setup({ scope: "staged" });
    expect(names()).toEqual(["Unstage hunk"]);
  });

  it("should pluralise the labels for three selected lines when unstaged", () => {
    setup({ selectedCount: 3 });
    expect(names()).toEqual(["Stage 3 lines", "Discard 3 lines…"]);
  });

  it("should use the singular for one selected line when staged", () => {
    setup({ scope: "staged", selectedCount: 1 });
    expect(names()).toEqual(["Unstage 1 line"]);
  });

  it("should use the singular for one selected line when unstaged", () => {
    setup({ selectedCount: 1 });
    expect(names()).toEqual(["Stage 1 line", "Discard 1 line…"]);
  });

  it("should pluralise the unstage label for several selected lines", () => {
    setup({ scope: "staged", selectedCount: 2 });
    expect(names()).toEqual(["Unstage 2 lines"]);
  });
});

// Contract: each button reports its action.
describe("HunkHeader actions", () => {
  it("should call onAction with stage when Stage hunk is clicked", () => {
    const { onAction } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    expect(onAction).toHaveBeenCalledWith("stage");
  });

  it("should call onAction with discard when Discard hunk… is clicked", () => {
    const { onAction } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Discard hunk…" }));
    expect(onAction).toHaveBeenCalledWith("discard");
  });

  it("should call onAction with unstage when Unstage hunk is clicked", () => {
    const { onAction } = setup({ scope: "staged" });
    fireEvent.click(screen.getByRole("button", { name: "Unstage hunk" }));
    expect(onAction).toHaveBeenCalledWith("unstage");
  });

  it("should call onAction once per click", () => {
    const { onAction } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

// Contract: a disabled reason disables every button and explains itself in the title.
describe("HunkHeader disabled reason", () => {
  it("should disable every button when disabledReason is set", () => {
    setup({ disabledReason: "Not now" });
    for (const b of screen.getAllByRole("button")) expect(b).toBeDisabled();
  });

  it("should set the title of every button to the reason", () => {
    setup({ disabledReason: "Not now" });
    for (const b of screen.getAllByRole("button")) expect(b).toHaveAttribute("title", "Not now");
  });

  it("should disable the unstage button too when staged", () => {
    setup({ scope: "staged", disabledReason: "Not now" });
    expect(screen.getByRole("button", { name: "Unstage hunk" })).toBeDisabled();
  });

  it("should not call onAction when a disabled button is clicked", () => {
    const { onAction } = setup({ disabledReason: "Not now" });
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    expect(onAction).not.toHaveBeenCalled();
  });

  it("should enable the buttons and set no title without a reason", () => {
    setup();
    const button = screen.getByRole("button", { name: "Stage hunk" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("title");
  });
});

// Contract: without onAction the header is read-only.
describe("HunkHeader read-only", () => {
  it("should render no buttons when onAction is absent", () => {
    setup({ withAction: false });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("should still render the header text when onAction is absent", () => {
    setup({ withAction: false });
    expect(screen.getByText("@@ -1,2 +1,2 @@")).toBeInTheDocument();
  });

  it("should render no buttons when onAction is absent even with a reason", () => {
    setup({ withAction: false, disabledReason: "Not now" });
    expect(screen.queryByRole("button")).toBeNull();
  });
});

// Contract: the scope and the selection never leak a button the scope does not allow.
describe("HunkHeader scope rules", () => {
  it("should never offer Discard for a staged diff, whatever the selection", () => {
    for (const selectedCount of [0, 1, 4]) {
      const { unmount } = setup({ scope: "staged", selectedCount });
      expect(names().some((n) => n?.startsWith("Discard"))).toBe(false);
      expect(names().some((n) => n?.startsWith("Stage"))).toBe(false);
      unmount();
    }
  });

  it("should never offer Unstage for an unstaged diff", () => {
    setup({ scope: "unstaged", selectedCount: 2 });
    expect(names().some((n) => n?.startsWith("Unstage"))).toBe(false);
  });

  it("should render no buttons with a selection count but no onAction", () => {
    setup({ withAction: false, selectedCount: 3 });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("should render no buttons for a staged diff with a selection count but no onAction", () => {
    setup({ withAction: false, scope: "staged", selectedCount: 3 });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("should carry the reason on the title of both unstaged buttons and a labelled count", () => {
    setup({ selectedCount: 2, disabledReason: "Not now" });
    expect(screen.getByRole("button", { name: "Stage 2 lines" })).toHaveAttribute(
      "title",
      "Not now",
    );
    expect(screen.getByRole("button", { name: "Discard 2 lines…" })).toHaveAttribute(
      "title",
      "Not now",
    );
  });

  it("should carry the reason on the title of the staged button", () => {
    setup({ scope: "staged", disabledReason: "Not now" });
    expect(screen.getByRole("button", { name: "Unstage hunk" })).toHaveAttribute(
      "title",
      "Not now",
    );
  });
});
