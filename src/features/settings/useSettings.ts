import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSettings, toAppError, updateSettings } from "../../lib/ipc";
import type { AppError, Settings, SettingsPatch } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseSettings {
  settings: Settings | undefined;
  error: AppError | null;
  saving: boolean;
  /** Persists the patch; rejects with the backend `AppError`. */
  update(patch: SettingsPatch): Promise<Settings>;
}

/**
 * Reads the backend settings under {@link queryKeys.settings} and writes updates back. A successful
 * update replaces the cached settings; a change to the Git executable also re-probes the CLI.
 */
export function useSettings(): UseSettings {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.settings, queryFn: () => getSettings() });
  const mutation = useMutation({
    mutationFn: (patch: SettingsPatch) => updateSettings(patch),
    onSuccess: (next, patch) => {
      queryClient.setQueryData(queryKeys.settings, next);
      // The located Git CLI depends on the configured executable; nothing else does.
      if ("gitExecutable" in patch) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.gitCli });
      }
    },
  });
  return {
    settings: query.data,
    error: query.error ? toAppError(query.error) : null,
    saving: mutation.isPending,
    update: (patch) => mutation.mutateAsync(patch),
  };
}
