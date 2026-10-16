import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const ipcSeamMessage = "Imports of the Tauri IPC must go through src/lib/ipc.";

const restrictedTauriImports = {
  patterns: [{ regex: "^@tauri-apps/(?!api/mocks$)", message: ipcSeamMessage }],
};

export default tseslint.config(
  {
    ignores: ["dist", "node_modules", "src-tauri/target", "coverage"],
  },
  ...tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  {
    rules: {
      "no-restricted-imports": ["error", restrictedTauriImports],
    },
  },
  {
    files: ["src/lib/ipc/**"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);
