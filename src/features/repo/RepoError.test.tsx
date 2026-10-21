/// <reference types="node" />
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppError } from "../../lib/ipc";
import { RepoError } from "./RepoError";

const notARepo: AppError = { kind: "notARepository", message: "Not a git repository" };
const missing: AppError = { kind: "pathNotFound", message: "Path does not exist" };
const initName = { name: "Initialize repository here" };

// Contract: the error panel shows the message, always offers Dismiss, and offers init only
// for notARepository when a path and handler are available.
describe("RepoError message", () => {
  it("should show the error message when rendered", () => {
    render(<RepoError error={notARepo} path="/r" onInitHere={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Not a git repository");
  });
});

describe("RepoError init offer", () => {
  it("should offer init when the error is notARepository and a path is set", () => {
    render(<RepoError error={notARepo} path="/r" onInitHere={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole("button", initName)).toBeInTheDocument();
  });

  it("should not offer init when the error is pathNotFound", () => {
    render(<RepoError error={missing} path="/r" onInitHere={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByRole("button", initName)).toBeNull();
  });

  it("should not offer init when the path is null", () => {
    render(<RepoError error={notARepo} path={null} onInitHere={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByRole("button", initName)).toBeNull();
  });

  it("should not offer init when onInitHere is omitted", () => {
    render(<RepoError error={notARepo} path="/r" onDismiss={vi.fn()} />);
    expect(screen.queryByRole("button", initName)).toBeNull();
  });

  it("should call onInitHere with the path when the init button is clicked", async () => {
    const onInitHere = vi.fn();
    const user = userEvent.setup();
    render(<RepoError error={notARepo} path="/r" onInitHere={onInitHere} onDismiss={vi.fn()} />);
    await user.click(screen.getByRole("button", initName));
    expect(onInitHere).toHaveBeenCalledExactlyOnceWith("/r");
  });
});

describe("RepoError dismiss", () => {
  it("should call onDismiss when Dismiss is clicked", async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<RepoError error={missing} path="/r" onDismiss={onDismiss} />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("should not call onInitHere when Dismiss is clicked", async () => {
    const onInitHere = vi.fn();
    const user = userEvent.setup();
    render(<RepoError error={notARepo} path="/r" onInitHere={onInitHere} onDismiss={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onInitHere).not.toHaveBeenCalled();
  });
});

describe("RepoError other kinds", () => {
  it.each([
    "alreadyARepository",
    "gitCliMissing",
    "cloneFailed",
    "io",
    "git",
    "unknownRepo",
  ] as const)(
    "should show the message and no init offer when the kind is %s even with a path and handler",
    (kind) => {
      render(
        <RepoError
          error={{ kind, message: `msg ${kind}` }}
          path="/r"
          onInitHere={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
      expect(screen.getByRole("alert")).toHaveTextContent(`msg ${kind}`);
      expect(screen.queryByRole("button", initName)).toBeNull();
      expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    },
  );
});

// Contract: Retry is offered only when a handler is given, sits before Dismiss and calls it.
describe("RepoError retry", () => {
  it("should render a Retry button when onRetry is given", () => {
    render(<RepoError error={missing} path={null} onRetry={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("should call onRetry once and not onDismiss when Retry is clicked", async () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<RepoError error={missing} path={null} onRetry={onRetry} onDismiss={onDismiss} />);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("should render no Retry button when onRetry is omitted", () => {
    render(<RepoError error={missing} path="/r" onDismiss={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("should place Retry before Dismiss", () => {
    render(<RepoError error={missing} path={null} onRetry={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Retry", "Dismiss"]);
  });

  it("should offer init, Retry and Dismiss together in that order", () => {
    render(
      <RepoError
        error={notARepo}
        path="/r"
        onInitHere={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Initialize repository here",
      "Retry",
      "Dismiss",
    ]);
  });

  it("should not call onRetry when Dismiss is clicked", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<RepoError error={missing} path={null} onRetry={onRetry} onDismiss={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onRetry).not.toHaveBeenCalled();
  });
});

// Contract: variant="panel" tags the alert for the narrow-column layout; omitting it adds nothing.
describe("RepoError variant", () => {
  it('should put data-variant="panel" on the alert when variant is panel', () => {
    render(<RepoError error={missing} path={null} variant="panel" onDismiss={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveAttribute("data-variant", "panel");
  });

  it("should render no data-variant attribute when variant is omitted", () => {
    render(<RepoError error={missing} path={null} onDismiss={vi.fn()} />);
    expect(screen.getByRole("alert")).not.toHaveAttribute("data-variant");
  });
});

// Contract: the action buttons sit at the top of the alert so Dismiss stays visible when the
// message is long. happy-dom applies no CSS modules, so the stylesheet source is pinned instead.
describe("RepoError layout", () => {
  const css = readFileSync("src/features/repo/RepoError.module.css", "utf8");
  const rootBlock = /\.root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

  it("should pin the root row to flex-start and not center when the stylesheet is read", () => {
    expect(rootBlock).toContain("align-items: flex-start");
    expect(rootBlock).not.toContain("align-items: center");
  });

  // Contract: the panel variant scrolls a long message in place instead of wrapping it per
  // character, and stacks the message above right-aligned actions.
  const blockOf = (selector: string) =>
    new RegExp(`${selector.replace(/[.[\]"=]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  const panelRoot = blockOf('.root[data-variant="panel"]');
  const panelMessage = blockOf('.root[data-variant="panel"] .message');

  it("should stack the panel variant root in a column when the stylesheet is read", () => {
    expect(panelRoot).toContain("flex-direction: column");
  });

  it("should cap the panel message height when the stylesheet is read", () => {
    expect(panelMessage).toContain("max-height");
  });

  it("should scroll the panel message when the stylesheet is read", () => {
    expect(panelMessage).toContain("overflow: auto");
  });

  it("should keep panel message lines unwrapped with white-space: pre when the stylesheet is read", () => {
    expect(panelMessage).toMatch(/white-space:\s*pre\s*;/);
  });

  it("should not use pre-wrap in the panel message when the stylesheet is read", () => {
    expect(panelMessage).not.toContain("pre-wrap");
  });

  it("should not break anywhere in the panel message when the stylesheet is read", () => {
    expect(panelMessage).not.toContain("overflow-wrap: anywhere");
  });

  it("should keep pre-wrap on the default message when the stylesheet is read", () => {
    expect(/\.message\s*\{([^}]*)\}/.exec(css)?.[1]).toContain("white-space: pre-wrap");
  });
});
