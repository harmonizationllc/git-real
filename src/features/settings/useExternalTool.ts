import { toAppError } from "../../lib/ipc";
import type { Settings } from "../../lib/ipc";
import { useSettings } from "../../lib/store/settings";
import { useShell } from "../../lib/store/shell";
import { useToasts } from "../../lib/store/toasts";

export type ExternalTool = "editor" | "diff" | "merge";

/** The noun each tool goes by in the toast copy. */
export const TOOL_LABEL: Record<ExternalTool, string> = {
  editor: "editor",
  diff: "diff tool",
  merge: "merge tool",
};

/** The `settings.tools` field that holds each tool's command line. */
const SETTING_KEY: Record<ExternalTool, keyof Settings["tools"]> = {
  editor: "editor",
  diff: "diffTool",
  merge: "mergeTool",
};

export interface UseExternalTool {
  configured: boolean;
  /** Runs `call` when the tool is set; otherwise opens Settings at Tools. A rejection toasts. */
  run(call: () => Promise<void>): Promise<void>;
}

/** Shared launch path for the editor, diff and merge entry points. */
export function useExternalTool(tool: ExternalTool): UseExternalTool {
  const command = useSettings((s) => s.settings.tools[SETTING_KEY[tool]]);
  const configured = typeof command === "string";

  const openTools = () => useShell.getState().open({ kind: "settings", section: "tools" });

  const run = async (call: () => Promise<void>): Promise<void> => {
    if (!configured) {
      openTools();
      return;
    }
    try {
      await call();
    } catch (e) {
      const err = toAppError(e);
      useToasts.getState().notify({
        text: `Couldn't open ${TOOL_LABEL[tool]}: ${err.message}`,
        variant: "error",
        action: { label: "Settings…", run: openTools },
      });
    }
  };

  return { configured, run };
}
