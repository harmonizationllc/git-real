import { describe, expect, it } from "vitest";
import { createQueryClient, queryClient } from "./client";
import { queryKeys } from "./keys";

// Contract: shared QueryClient defaults and the query key registry.
describe("query client", () => {
  it("queries do not retry", () => {
    expect(createQueryClient().getDefaultOptions().queries?.retry).toBe(false);
  });

  it("factory returns a fresh client each call", () => {
    expect(createQueryClient()).not.toBe(createQueryClient());
  });

  it("app singleton uses the same defaults", () => {
    expect(queryClient.getDefaultOptions().queries?.retry).toBe(false);
  });

  it("clients from the factory do not share cache state", () => {
    const a = createQueryClient();
    const b = createQueryClient();
    a.setQueryData(queryKeys.recent, [1]);
    expect(a.getQueryData(queryKeys.recent)).toEqual([1]);
    expect(b.getQueryData(queryKeys.recent)).toBeUndefined();
  });

  it("app singleton is stable across reads", () => {
    expect(queryClient).toBe(queryClient);
    expect(queryClient).not.toBe(createQueryClient());
  });
});

describe("query keys", () => {
  it("recent query key", () => {
    expect(queryKeys.recent).toEqual(["recent"]);
  });
});
