import { describe, expect, it } from "vitest";
import type { AppError } from "../../lib/ipc";
import { remoteFieldError, removeRemoteCopy } from "./remoteCopy";

const err = (kind: AppError["kind"]): AppError => ({ kind, message: "raw" });

// Contract: the remove confirmation names the remote and says what it does and does not touch.
describe("removeRemoteCopy", () => {
  it("should title the confirmation Remove remote origin?", () => {
    expect(removeRemoteCopy("origin").title).toBe("Remove remote origin?");
  });

  it("should say remote-tracking branches are deleted locally and the server is untouched", () => {
    expect(removeRemoteCopy("origin").body).toBe(
      "Its remote-tracking branches are deleted locally. Nothing changes on the server.",
    );
  });

  it("should name whichever remote is given", () => {
    expect(removeRemoteCopy("up/stream").title).toBe("Remove remote up/stream?");
  });
});

// Contract: add/edit errors that belong to a field map to that field; everything else is a panel message.
describe("remoteFieldError", () => {
  it("should map invalidRemoteName to the name field", () => {
    expect(remoteFieldError(err("invalidRemoteName"), "bad name")).toEqual({
      field: "name",
      text: "bad name is not a valid remote name.",
    });
  });

  it("should map remoteExists to the name field", () => {
    expect(remoteFieldError(err("remoteExists"), "origin")).toEqual({
      field: "name",
      text: "A remote named origin already exists.",
    });
  });

  it("should map invalidRemoteUrl to the url field", () => {
    expect(remoteFieldError(err("invalidRemoteUrl"), "origin")).toEqual({
      field: "url",
      text: "Enter a valid URL.",
    });
  });

  it("should return null for remoteNotFound", () => {
    expect(remoteFieldError(err("remoteNotFound"), "origin")).toBeNull();
  });

  it("should return null for io", () => {
    expect(remoteFieldError(err("io"), "origin")).toBeNull();
  });
});
