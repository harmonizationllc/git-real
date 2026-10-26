/**
 * Contract tests for the Linux packaging and release pipeline (GR-15 Cycle 2).
 *
 * All paths are resolved from __dirname (this file's directory) so the tests
 * are independent of the working directory when Vitest is invoked.
 *
 * Note: the `yaml` package uses YAML 1.2 schema by default, so the key `on:`
 * in a workflow file parses as the string "on", not the boolean true.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Repository root, two levels up from src/test/
const ROOT = resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// Helpers (in-file so they are never counted as importable source modules)
// ---------------------------------------------------------------------------

function readText(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

function readJson(relPath: string): unknown {
  return JSON.parse(readText(relPath));
}

function fileExists(relPath: string): boolean {
  return existsSync(resolve(ROOT, relPath));
}

function fileSize(relPath: string): number {
  return statSync(resolve(ROOT, relPath)).size;
}

/**
 * Extract the set of package names from a shell snippet that contains
 * `apt-get install -y \` followed by backslash-continued lines.
 */
function extractAptPackages(script: string): Set<string> {
  const idx = script.indexOf("apt-get install -y");
  if (idx === -1) return new Set();
  const lines = script.slice(idx).split("\n");
  const pkgs = new Set<string>();
  // Line 0 is the "apt-get install -y \" header; skip it, enter block if it
  // ends with a continuation backslash.
  if (!lines[0].trimEnd().endsWith("\\")) return pkgs; // inline form – not used here
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    const pkg = raw.replace(/\\\s*$/, "").trim();
    if (pkg.length === 0) break;
    pkgs.add(pkg);
    if (!raw.trimEnd().endsWith("\\")) break;
  }
  return pkgs;
}

/**
 * Find the first step in a job's step array whose `run` field contains
 * `apt-get install`, and return that run script.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aptStepScript(steps: any[]): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const step = steps.find(
    (s: any) => typeof s.run === "string" && s.run.includes("apt-get install"),
  );
  return (step?.run as string | undefined) ?? "";
}

/**
 * Extract apt packages from the README `## Development` section's first
 * fenced sh block that contains `apt-get`.
 */
function extractReadmeAptPackages(readme: string): Set<string> {
  const devIdx = readme.indexOf("## Development");
  if (devIdx === -1) return new Set();
  const devSection = readme.slice(devIdx);
  const m = devSection.match(/```sh\n([\s\S]*?apt-get[\s\S]*?)```/);
  if (!m) return new Set();
  return extractAptPackages(m[1]);
}

/** Parse the version from Cargo.toml's [package] section. */
function parseCargoVersion(toml: string): string {
  const section = toml.match(/\[package\]([\s\S]*?)(?=\n\s*\[|\s*$)/);
  if (!section) throw new Error("No [package] section in Cargo.toml");
  const versionLine = section[1].match(/^version\s*=\s*"([^"]+)"/m);
  if (!versionLine) throw new Error("No version in [package] section");
  return versionLine[1];
}

// ---------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------

// R8: version strings in package.json, tauri.conf.json and Cargo.toml must
//     be equal and semver-shaped (MAJOR.MINOR.PATCH).
describe("versions", () => {
  const tauriConf = readJson("src-tauri/tauri.conf.json") as Record<string, unknown>;
  const pkgJson = readJson("package.json") as Record<string, unknown>;
  const cargoToml = readText("src-tauri/Cargo.toml");

  it("package.json, tauri.conf.json and Cargo.toml agree", () => {
    const cargoVersion = parseCargoVersion(cargoToml);
    expect(pkgJson.version).toBe(tauriConf.version);
    expect(pkgJson.version).toBe(cargoVersion);
  });

  it("version is MAJOR.MINOR.PATCH", () => {
    expect(String(pkgJson.version)).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ---------------------------------------------------------------------------
// bundle config
// ---------------------------------------------------------------------------

// §4.1: bundle metadata in src-tauri/tauri.conf.json must match the spec
//       values exactly.
describe("bundle config", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tauriConf = readJson("src-tauri/tauri.conf.json") as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bundle = tauriConf.bundle as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = tauriConf.app as any;

  // R7: targets stay ["deb", "rpm", "appimage"]
  it("targets are deb, rpm, appimage", () => {
    expect(bundle.targets).toEqual(["deb", "rpm", "appimage"]);
  });

  it("category is DeveloperTool", () => {
    expect(bundle.category).toBe("DeveloperTool");
  });

  it("descriptions, homepage and license are set", () => {
    expect(typeof bundle.shortDescription).toBe("string");
    expect((bundle.shortDescription as string).length).toBeGreaterThan(0);
    expect(typeof bundle.longDescription).toBe("string");
    expect((bundle.longDescription as string).length).toBeGreaterThan(0);
    expect(bundle.homepage).toBe("https://github.com/harmonizationllc/git-real");
    expect(bundle.license).toBe("GPL-3.0-only");
    expect(typeof bundle.licenseFile).toBe("string");
    expect((bundle.licenseFile as string).length).toBeGreaterThan(0);
  });

  // icon list must include icons/icon.png and every listed file must exist on disk
  it("icon list includes icon.png and every file exists", () => {
    const icons = bundle.icon as string[];
    expect(icons).toContain("icons/icon.png");
    for (const icon of icons) {
      expect(fileExists(`src-tauri/${icon}`), `icon file missing: src-tauri/${icon}`).toBe(true);
    }
  });

  // After `npx tauri icon src-tauri/icons/icon.svg` the regenerated PNGs
  // must differ in size from the original Tauri scaffold templates.
  it("icons are not the Tauri template files", () => {
    const TEMPLATE_SIZES: Record<string, number> = {
      "icons/32x32.png": 567,
      "icons/128x128.png": 1593,
      "icons/128x128@2x.png": 2861,
      "icons/icon.png": 5664,
    };
    for (const [iconPath, templateSize] of Object.entries(TEMPLATE_SIZES)) {
      const actual = fileSize(`src-tauri/${iconPath}`);
      expect(actual, `${iconPath} still has template size ${templateSize} bytes`).not.toBe(
        templateSize,
      );
    }
  });

  it("deb recommends git and both desktop templates exist", () => {
    const linux = bundle.linux as Record<string, unknown>;
    const deb = linux.deb as Record<string, unknown>;
    expect(deb.section).toBe("vcs");
    expect(deb.recommends).toContain("git");
    expect(deb.desktopTemplate).toBe("packaging/git-real.desktop");
    const rpm = linux.rpm as Record<string, unknown>;
    expect(rpm.desktopTemplate).toBe("packaging/git-real.desktop");
    // The file referenced by both desktopTemplate values must exist
    expect(fileExists("src-tauri/packaging/git-real.desktop")).toBe(true);
  });

  it("window decorations are explicit", () => {
    const windows = app.windows as Array<Record<string, unknown>>;
    expect(windows[0].decorations).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// desktop template
// ---------------------------------------------------------------------------

// §4.2: src-tauri/packaging/git-real.desktop must have the freedesktop keys
//       and Handlebars placeholders Tauri substitutes at bundle time.
describe("desktop template", () => {
  it("has the required keys and placeholders", () => {
    const template = readText("src-tauri/packaging/git-real.desktop");
    expect(template).toContain("Type=Application");
    expect(template).toContain("Terminal=false");
    expect(template).toContain("StartupNotify=true");
    expect(template).toMatch(/Keywords=.*git;/);
    expect(template).toContain("{{exec}}");
    expect(template).toContain("{{icon}}");
    expect(template).toContain("{{name}}");
    expect(template).toContain("{{categories}}");
  });
});

// ---------------------------------------------------------------------------
// icon source
// ---------------------------------------------------------------------------

// §4.3: src-tauri/icons/icon.svg must be a self-contained 1024×1024 SVG with
//       no external references (no bitmap embeds, no remote scripts, no hrefs).
describe("icon source", () => {
  it("is a 1024 square SVG without external references", () => {
    const svgText = readText("src-tauri/icons/icon.svg");
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, "image/svg+xml");
    const root = doc.documentElement;

    // File must parse as valid SVG (no parsererror element)
    expect(doc.querySelector("parsererror")).toBeNull();

    // Root viewBox must be "0 0 1024 1024"
    expect(root.getAttribute("viewBox")).toBe("0 0 1024 1024");

    // No <image> elements (external bitmap embeds)
    expect(doc.querySelectorAll("image").length).toBe(0);

    // No <script> elements
    expect(doc.querySelectorAll("script").length).toBe(0);

    // No href or xlink:href attribute on any element
    const allElements = Array.from(doc.querySelectorAll("*"));
    for (const el of allElements) {
      expect(el.getAttribute("href"), `<${el.tagName}> has href`).toBeNull();
      expect(el.getAttribute("xlink:href"), `<${el.tagName}> has xlink:href`).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// ci workflow
// ---------------------------------------------------------------------------

// §3 / R9 / R10: ci.yml gains a `package` job on ubuntu-22.04 with workflow-level
//                concurrency that cancels stale runs on the same ref.
describe("ci workflow", () => {
  const ciText = readText(".github/workflows/ci.yml");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ciConf = parse(ciText) as any;

  it("has build-and-test and package jobs", () => {
    expect(ciConf.jobs).toHaveProperty("build-and-test");
    expect(ciConf.jobs).toHaveProperty("package");
  });

  it("package bundles on ubuntu-22.04 and uploads the three globs", () => {
    const pkg = ciConf.jobs.package;
    expect(pkg["runs-on"]).toBe("ubuntu-22.04");

    const steps: Array<Record<string, unknown>> = pkg.steps;

    // Must have a step that runs the Tauri build with the three bundle targets
    const buildStep = steps.find(
      (s) => typeof s.run === "string" && (s.run as string).includes("npm run tauri build"),
    );
    expect(buildStep).toBeDefined();
    expect(buildStep!.run as string).toContain("--bundles deb,rpm,appimage");

    // Must upload the bundles with actions/upload-artifact@v4
    const uploadStep = steps.find(
      (s) =>
        typeof s.uses === "string" && (s.uses as string).startsWith("actions/upload-artifact@v4"),
    );
    expect(uploadStep).toBeDefined();
    const w = uploadStep!.with as Record<string, unknown>;
    const path = String(w.path);
    expect(path).toContain("src-tauri/target/release/bundle/deb/*.deb");
    expect(path).toContain("src-tauri/target/release/bundle/rpm/*.rpm");
    expect(path).toContain("src-tauri/target/release/bundle/appimage/*.AppImage");
    expect(w["if-no-files-found"]).toBe("error");
    expect(w["retention-days"]).toBe(14);
  });

  it("cancels in-progress runs per ref", () => {
    const concurrency = ciConf.concurrency as Record<string, unknown>;
    expect(String(concurrency.group)).toContain("ci-");
    expect(concurrency["cancel-in-progress"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// release workflow
// ---------------------------------------------------------------------------

// §6 / R3 / R6: release.yml triggers on v* tags only, checks the tag against
//               the version before building, then publishes with gh-release.
describe("release workflow", () => {
  it("runs on v tags only with contents write", () => {
    const conf = parse(readText(".github/workflows/release.yml")) as Record<string, unknown>;
    // The yaml package (YAML 1.2) parses `on:` as the string key "on"
    const trigger = conf["on"] as Record<string, unknown>;
    const push = trigger.push as Record<string, unknown>;
    expect(push.tags).toEqual(["v*"]);
    expect(push).not.toHaveProperty("branches");
    const permissions = conf.permissions as Record<string, unknown>;
    expect(permissions.contents).toBe("write");
  });

  it("checks the tag before building", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conf = parse(readText(".github/workflows/release.yml")) as any;
    const steps: Array<Record<string, unknown>> = conf.jobs.release.steps;

    const checkIdx = steps.findIndex((s) => s.name === "Check the tag matches the app version");
    const buildIdx = steps.findIndex(
      (s) => typeof s.run === "string" && (s.run as string).includes("npm run tauri build"),
    );

    expect(checkIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    // The version-check step must precede the build step
    expect(checkIdx).toBeLessThan(buildIdx);
  });

  it("builds the three bundles", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conf = parse(readText(".github/workflows/release.yml")) as any;
    const steps: Array<Record<string, unknown>> = conf.jobs.release.steps;
    const buildStep = steps.find(
      (s) => typeof s.run === "string" && (s.run as string).includes("npm run tauri build"),
    );
    expect(buildStep).toBeDefined();
    expect(buildStep!.run as string).toContain("--bundles deb,rpm,appimage");
  });

  it("publishes with generated notes and the three globs", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conf = parse(readText(".github/workflows/release.yml")) as any;
    const job = conf.jobs.release;
    expect(job["runs-on"]).toBe("ubuntu-22.04");

    const steps: Array<Record<string, unknown>> = job.steps;
    const releaseStep = steps.find(
      (s) =>
        typeof s.uses === "string" &&
        (s.uses as string).startsWith("softprops/action-gh-release@v2"),
    );
    expect(releaseStep).toBeDefined();
    const w = releaseStep!.with as Record<string, unknown>;
    expect(w["generate_release_notes"]).toBe(true);
    expect(w["fail_on_unmatched_files"]).toBe(true);
    expect(String(w["prerelease"])).toContain("contains(github.ref_name, '-')");
    const files = String(w["files"]);
    expect(files).toContain("src-tauri/target/release/bundle/deb/*.deb");
    expect(files).toContain("src-tauri/target/release/bundle/rpm/*.rpm");
    expect(files).toContain("src-tauri/target/release/bundle/appimage/*.AppImage");
    expect(String(w["name"])).toContain("Git Real");
  });
});

// ---------------------------------------------------------------------------
// apt packages
// ---------------------------------------------------------------------------

// §3 / Global Constraints: the package job in ci.yml, the release job in
//   release.yml, and the README Development section must all install the same
//   set of apt packages (including `file` and `patchelf`).
describe("apt packages", () => {
  it("both workflows and the README list the same packages", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ciConf = parse(readText(".github/workflows/ci.yml")) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const releaseConf = parse(readText(".github/workflows/release.yml")) as any;
    const readmeText = readText("README.md");

    const ciPkgs = extractAptPackages(aptStepScript(ciConf.jobs.package.steps));
    const releasePkgs = extractAptPackages(aptStepScript(releaseConf.jobs.release.steps));
    const readmePkgs = extractReadmeAptPackages(readmeText);

    expect(ciPkgs).toEqual(releasePkgs);
    expect(ciPkgs).toEqual(readmePkgs);
    expect(ciPkgs.has("file")).toBe(true);
    expect(ciPkgs.has("patchelf")).toBe(true);
  });
});
