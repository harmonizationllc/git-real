import { describe, expect, it } from "vitest";
import { queryKeys } from "./keys";

// Contract: the git CLI availability check has its own cache key, distinct from other queries.
describe("queryKeys", () => {
  it("should define a gitCli key", () => {
    expect(queryKeys.gitCli).toEqual(["gitCli"]);
  });

  it("should use a gitCli key that differs from the recent key", () => {
    expect(queryKeys.gitCli).not.toEqual(queryKeys.recent);
  });
});
