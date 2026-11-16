import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { AppError } from "../../lib/ipc";
import {
  NameList,
  deleteMenuLabel,
  failedDeleteToast,
  forceDeleteCopy,
  localDeleteCopy,
  remoteDeleteCopy,
  remoteDeleteMenuLabel,
} from "./deleteCopy";

const text = (node: ReactNode) => {
  const { container } = render(<div>{node}</div>);
  return container.textContent;
};

describe("localDeleteCopy", () => {
  it("should keep today's copy for one branch", () => {
    const c = localDeleteCopy(["feature"]);
    expect(c.title).toBe("Delete branch feature?");
    expect(c.body).toBe("The branch is merged into the current branch.");
    expect(c.confirmLabel).toBe("Delete");
  });

  it("should list the names for several branches", () => {
    const c = localDeleteCopy(["a", "b"]);
    expect(c.title).toBe("Delete 2 branches?");
    expect(text(c.body)).toBe("abThe branches are merged into the current branch.");
  });
});

describe("forceDeleteCopy", () => {
  it("should keep today's copy for one branch", () => {
    const c = forceDeleteCopy(["feature"]);
    expect(c.title).toBe("Force delete feature?");
    expect(c.body).toBe(
      "feature has commits that are not merged into the current branch. Deleting it loses them unless another ref points at them.",
    );
    expect(c.confirmLabel).toBe("Force delete");
  });

  it("should use the plural copy for several branches", () => {
    const c = forceDeleteCopy(["a", "b"]);
    expect(c.title).toBe("Force delete 2 branches?");
    expect(text(c.body)).toBe(
      "abThese branches have commits that are not merged into the current branch. Deleting them loses those commits unless another ref points at them.",
    );
  });
});

describe("remoteDeleteCopy", () => {
  it("should keep today's copy for one branch", () => {
    const c = remoteDeleteCopy("origin", ["other"]);
    expect(c.title).toBe("Delete origin/other on origin?");
    expect(c.body).toBe("This removes the branch from the remote for everyone.");
    expect(c.confirmLabel).toBe("Delete on origin");
  });

  it("should use the plural copy for several branches", () => {
    const c = remoteDeleteCopy("origin", ["a", "b"]);
    expect(c.title).toBe("Delete 2 branches on origin?");
    expect(text(c.body)).toBe("abThis removes the branches from the remote for everyone.");
    expect(c.confirmLabel).toBe("Delete on origin");
  });
});

describe("NameList", () => {
  it("should render one item per name in a labelled list", () => {
    render(<NameList names={["a", "b", "c"]} />);
    const list = screen.getByRole("list", { name: "Branches" });
    expect(list.querySelectorAll("li")).toHaveLength(3);
  });
});

describe("menu labels", () => {
  it("should label by count", () => {
    expect(deleteMenuLabel(1)).toBe("Delete…");
    expect(deleteMenuLabel(3)).toBe("Delete 3 branches…");
    expect(remoteDeleteMenuLabel("origin", 1)).toBe("Delete on origin…");
    expect(remoteDeleteMenuLabel("origin", 2)).toBe("Delete 2 on origin…");
  });
});

describe("failedDeleteToast", () => {
  const e1: AppError = { kind: "io", message: "boom" };
  const e2: AppError = { kind: "checkoutFailed", message: "bang" };

  it("should return the error itself for one failure", () => {
    expect(failedDeleteToast([{ name: "a", error: e1 }])).toBe(e1);
  });

  it("should name every failed branch and keep the first error's kind", () => {
    const failed = [
      { name: "a", error: e1 },
      { name: "b", error: e2 },
    ];
    expect(failedDeleteToast(failed)).toEqual({
      kind: "io",
      message: "Couldn't delete a, b: boom",
    });
  });
});
