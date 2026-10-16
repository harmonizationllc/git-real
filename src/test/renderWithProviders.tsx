import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  render,
  renderHook,
  type RenderHookResult,
  type RenderOptions,
  type RenderResult,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { createQueryClient } from "../lib/query/client";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
): RenderResult & { user: UserEvent; queryClient: QueryClient } {
  const queryClient = createQueryClient();
  const user = userEvent.setup();
  const result = render(ui, { ...options, wrapper: makeWrapper(queryClient) });
  return { ...result, user, queryClient };
}

export function renderHookWithProviders<R>(
  hook: () => R,
): RenderHookResult<R, unknown> & { queryClient: QueryClient } {
  const queryClient = createQueryClient();
  const result = renderHook(hook, { wrapper: makeWrapper(queryClient) });
  return { ...result, queryClient };
}
