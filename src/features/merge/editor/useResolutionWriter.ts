import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { toAppError, writeResolution } from "../../../lib/ipc";
import type { AppError, RepoId } from "../../../lib/ipc";
import { queryKeys } from "../../../lib/query/keys";
import { encodeForDisk } from "./model/text";

export const SAVE_DELAY_MS = 500;
export const WRITTEN_MEMORY = 32;

export interface UseResolutionWriter {
  scheduleSave(text: string): void;
  discardPending(): void;
  flush(): Promise<void>;
  markResolved(text: string): Promise<AppError | null>;
  /** True when `text` is among the last WRITTEN_MEMORY texts sent, so a watcher echo can be ignored. */
  wasWritten(text: string): boolean;
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}

/**
 * Debounced, serialised writes of an edited conflict resolution. Writes never overlap, a failure
 * never blocks the next one, and a queued save is sent when the component unmounts.
 */
export function useResolutionWriter(
  repoId: RepoId,
  path: string,
  crlf: boolean,
): UseResolutionWriter {
  const queryClient = useQueryClient();
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queued = useRef<string | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const written = useRef<string[]>([]);
  // A ref, so a line-ending change neither re-creates the callbacks nor triggers the unmount flush.
  const crlfRef = useRef(crlf);
  useEffect(() => {
    crlfRef.current = crlf;
  }, [crlf]);

  const write = useCallback(
    (text: string, stage: boolean): Promise<AppError | null> => {
      setBusy((n) => n + 1);
      // Recorded before the IPC, so a watcher echo can never arrive ahead of its own record.
      written.current = [...written.current.slice(-(WRITTEN_MEMORY - 1)), text];
      const run = chain.current.then(() =>
        writeResolution(repoId, path, encodeForDisk(text, crlfRef.current), stage).then(
          () => null,
          (e: unknown) => toAppError(e),
        ),
      );
      chain.current = run;
      return run.finally(() => setBusy((n) => n - 1));
    },
    [repoId, path],
  );

  const discardPending = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    queued.current = null;
  }, []);

  const flush = useCallback((): Promise<void> => {
    const text = queued.current;
    discardPending();
    if (text === null) return chain.current.then(() => undefined);
    return write(text, false).then((e) => {
      if (e !== null) setError(e);
    });
  }, [discardPending, write]);

  const scheduleSave = useCallback(
    (text: string) => {
      queued.current = text;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  const markResolved = useCallback(
    async (text: string): Promise<AppError | null> => {
      // Busy from the click, so a second click cannot start another staging write.
      setBusy((n) => n + 1);
      try {
        await flush();
        const e = await write(text, true);
        if (e !== null) setError(e);
        // Not awaited: the caller reselects the staged file before any refetch can land.
        else void queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) });
        return e;
      } finally {
        setBusy((n) => n - 1);
      }
    },
    [flush, write, queryClient, repoId],
  );

  const onUnmount = useEffectEvent(() => void flush());
  useEffect(() => () => onUnmount(), []);

  return {
    scheduleSave,
    discardPending,
    flush,
    markResolved,
    wasWritten: (text) => written.current.includes(text),
    pending: busy > 0,
    error,
    clearError: () => setError(null),
  };
}
