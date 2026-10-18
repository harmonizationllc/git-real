import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

// Legacy modes that @codemirror/language-data imports. The package exports only
// `./mode/*` (no root entry, and Vite rejects a glob for it), so each subpath is listed.
// Regenerate with:
//   grep -oE "@codemirror/legacy-modes/mode/[a-zA-Z0-9_-]+" node_modules/@codemirror/language-data/dist/index.js | sort -u
const legacyModes = [
  "apl",
  "asciiarmor",
  "asn1",
  "asterisk",
  "brainfuck",
  "clike",
  "clojure",
  "cmake",
  "cobol",
  "coffeescript",
  "commonlisp",
  "crystal",
  "css",
  "cypher",
  "d",
  "diff",
  "dockerfile",
  "dtd",
  "dylan",
  "ebnf",
  "ecl",
  "eiffel",
  "elm",
  "erlang",
  "factor",
  "fcl",
  "forth",
  "fortran",
  "gas",
  "gherkin",
  "groovy",
  "haskell",
  "haxe",
  "http",
  "idl",
  "javascript",
  "julia",
  "livescript",
  "lua",
  "mathematica",
  "mbox",
  "mirc",
  "mllike",
  "modelica",
  "mscgen",
  "mumps",
  "nginx",
  "nsis",
  "ntriples",
  "octave",
  "oz",
  "pascal",
  "perl",
  "pig",
  "powershell",
  "properties",
  "protobuf",
  "pug",
  "puppet",
  "python",
  "q",
  "r",
  "rpm",
  "ruby",
  "sas",
  "scheme",
  "shell",
  "sieve",
  "smalltalk",
  "solr",
  "sparql",
  "spreadsheet",
  "sql",
  "stex",
  "stylus",
  "swift",
  "tcl",
  "textile",
  "tiddlywiki",
  "tiki",
  "toml",
  "troff",
  "ttcn",
  "ttcn-cfg",
  "turtle",
  "vb",
  "vbscript",
  "velocity",
  "verilog",
  "vhdl",
  "webidl",
  "xquery",
  "yacas",
  "z80",
];

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // Pre-bundle every runtime dependency up front so Vite never re-optimizes
  // (and reloads) mid-session when a new bare import is first discovered.
  optimizeDeps: {
    include: [
      "react",
      "react/jsx-dev-runtime",
      "react-dom/client",
      "@tanstack/react-query",
      "zustand",
      "zustand/middleware",
      "@tauri-apps/api/core",
      "@tauri-apps/api/event",
      "@tauri-apps/plugin-dialog",
      "@codemirror/language",
      "@codemirror/language-data",
      "@lezer/highlight",
      "@tanstack/react-virtual",
      // The grammars @codemirror/language-data loads lazily: every `@codemirror/lang-*`
      // key of its package.json `dependencies`, listed literally. Regenerate with:
      //   node -p "Object.keys(JSON.parse(require('fs').readFileSync('node_modules/@codemirror/language-data/package.json','utf8')).dependencies).filter(k=>/lang-/.test(k)).map(k=>JSON.stringify(k)).join(',\\n')"
      "@codemirror/lang-angular",
      "@codemirror/lang-cpp",
      "@codemirror/lang-css",
      "@codemirror/lang-go",
      "@codemirror/lang-html",
      "@codemirror/lang-java",
      "@codemirror/lang-javascript",
      "@codemirror/lang-jinja",
      "@codemirror/lang-json",
      "@codemirror/lang-liquid",
      "@codemirror/lang-less",
      "@codemirror/lang-markdown",
      "@codemirror/lang-php",
      "@codemirror/lang-python",
      "@codemirror/lang-rust",
      "@codemirror/lang-sass",
      "@codemirror/lang-sql",
      "@codemirror/lang-vue",
      "@codemirror/lang-wast",
      "@codemirror/lang-xml",
      "@codemirror/lang-yaml",
      ...legacyModes.map((mode) => `@codemirror/legacy-modes/mode/${mode}`),
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` and test coverage output
      ignored: ["**/src-tauri/**", "**/coverage/**"],
    },
  },

  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    passWithNoTests: true,
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
}));
