// GR-15 Cycle 1, Task 3 – IPC seam tests for checkForUpdate.
//
// RED PHASE: `./update` does not exist yet; every test in this file fails at
// module resolution time.

import { afterEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { checkForUpdate } from "./update"; // RED: module missing

afterEach(() => {
  clearMocks();
});

// Contract: checkForUpdate invokes the "check_for_update" Tauri command and
// returns the UpdateInfo payload directly.
describe("checkForUpdate", () => {
  it("should invoke check_for_update and return the UpdateInfo", async () => {
    const payload = {
      current: "0.1.0",
      latest: "1.0.0",
      available: true,
      url: "https://github.com/harmonizationllc/git-real/releases/tag/v1.0.0",
    };
    mockIPC((cmd) => {
      if (cmd === "check_for_update") return payload;
    });
    const result = await checkForUpdate();
    expect(result).toEqual(payload);
  });

  it("should rethrow an AppError when the backend rejects", async () => {
    const appError = { kind: "updateCheckFailed", message: "rate limited" };
    mockIPC((cmd) => {
      if (cmd === "check_for_update") throw appError;
    });
    await expect(checkForUpdate()).rejects.toEqual(appError);
  });

  it("should call no other command than check_for_update", async () => {
    const commands: string[] = [];
    mockIPC((cmd) => {
      commands.push(cmd);
      if (cmd === "check_for_update") {
        return { current: "0.1.0", latest: null, available: false, url: null };
      }
    });
    await checkForUpdate();
    expect(commands).toEqual(["check_for_update"]);
  });
});
