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
