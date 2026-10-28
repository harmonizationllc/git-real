/**
 * Contract tests for the packaging and release pipeline: GR-15 (Linux), GR-24
 * (Windows, per-platform Tauri overlays) and GR-23 (universal macOS DMG).
 *
 * All paths are resolved from __dirname (this file's directory) so the tests
 * are independent of the working directory when Vitest is invoked.
 *
 * Note: the `yaml` package uses YAML 1.2 schema by default, so the key `on:`
 * in a workflow file parses as the string "on", not the boolean true.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
function aptStepScript(steps: Record<string, unknown>[]): string {
  const step = steps.find(
    (s) => typeof s["run"] === "string" && (s["run"] as string).includes("apt-get install"),
  );
  return (step?.["run"] as string | undefined) ?? "";
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
//       values exactly. Targets and platform blocks live in the overlays.
describe("bundle config", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tauriConf = readJson("src-tauri/tauri.conf.json") as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bundle = tauriConf.bundle as any;

  // GR-24: Tauri merges tauri.<platform>.conf.json over the base file, so the
  // base must not name targets or platform blocks.
  it("base config has no targets and no linux block", () => {
    expect(bundle).not.toHaveProperty("targets");
    expect(bundle).not.toHaveProperty("linux");
    expect(bundle).not.toHaveProperty("windows");
  });

  it("category is DeveloperTool", () => {
    expect(bundle.category).toBe("DeveloperTool");
  });

  it("descriptions, homepage and license are set", () => {
    expect(bundle.shortDescription).toBe("Lightweight desktop Git client");
    expect(typeof bundle.longDescription).toBe("string");
    expect((bundle.longDescription as string).length).toBeGreaterThan(0);
    expect(bundle.homepage).toBe("https://github.com/harmonizationllc/git-real");
    expect(bundle.license).toBe("GPL-3.0-only");
    expect(bundle.licenseFile).toBe("../LICENSE");
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

  it("window decorations are explicit in main_window.rs", () => {
    // The main window is built in Rust (GR-29), so the explicit decorations
    // that give Wayland/COSMIC server-side decorations live there.
    expect(readText("src-tauri/src/main_window.rs")).toContain(".decorations(true)");
  });
});

// ---------------------------------------------------------------------------
// platform overlays
// ---------------------------------------------------------------------------

// GR-24: src-tauri/tauri.<platform>.conf.json files carry each platform's
//        bundle targets and platform block; Tauri merges them over the base.
describe("platform overlays", () => {
  const OVERLAY = /^tauri\.([a-z]+)\.conf\.json$/;
  const overlayFiles = readdirSync(resolve(ROOT, "src-tauri")).filter((f) => OVERLAY.test(f));
  const platformOf = (f: string): string => OVERLAY.exec(f)?.[1] ?? "";
  // A missing overlay reads as {} so the assertion fails, not the file read.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const overlay = (platform: string): any =>
    fileExists(`src-tauri/tauri.${platform}.conf.json`)
      ? readJson(`src-tauri/tauri.${platform}.conf.json`)
      : {};

  it("exactly linux, macos and windows overlays exist and each names its targets", () => {
    expect(overlayFiles.map(platformOf).sort()).toEqual(["linux", "macos", "windows"]);
    for (const file of overlayFiles) {
      const bundle = readJson(`src-tauri/${file}`) as { bundle?: { targets?: unknown } };
      const targets = bundle.bundle?.targets;
      expect(Array.isArray(targets), `${file} bundle.targets is an array`).toBe(true);
      expect((targets as unknown[]).length, `${file} bundle.targets is empty`).toBeGreaterThan(0);
    }
  });

  it("linux overlay has the Linux targets and the deb/rpm block", () => {
    const bundle = overlay("linux").bundle;
    expect(bundle?.targets).toEqual(["deb", "rpm", "appimage"]);
    const linux = bundle?.linux;
    expect(linux?.deb?.section).toBe("vcs");
    expect(linux?.deb?.recommends).toContain("git");
    expect(linux?.deb?.desktopTemplate).toBe("packaging/git-real.desktop");
    expect(linux?.rpm?.desktopTemplate).toBe("packaging/git-real.desktop");
    // The file referenced by both desktopTemplate values must exist
    expect(fileExists("src-tauri/packaging/git-real.desktop")).toBe(true);
  });

  it("windows overlay has nsis and msi with a per-user NSIS install", () => {
    const bundle = overlay("windows").bundle;
    expect(bundle?.targets).toEqual(["nsis", "msi"]);
    expect(bundle?.windows?.nsis?.installMode).toBe("currentUser");
  });

  // Unsigned installers for now: no signing material may be configured.
  it("windows overlay has no signing keys", () => {
    expect(fileExists("src-tauri/tauri.windows.conf.json")).toBe(true);
    const windows = overlay("windows").bundle?.windows ?? {};
    for (const key of ["signCommand", "certificateThumbprint", "timestampUrl"]) {
      expect(windows).not.toHaveProperty(key);
    }
  });

  it("macos overlay has the dmg target and nothing else", () => {
    expect(overlay("macos").bundle?.targets).toEqual(["dmg"]);
    expect(Object.keys(overlay("macos").bundle ?? {})).toEqual(["targets"]);
  });

  // Tauri's key is `macOS` with a capital OS. Signing is decided by the
  // environment alone (spec R4, R5), so no signing key may be configured.
  it("macos overlay has no signing keys", () => {
    expect(fileExists("src-tauri/tauri.macos.conf.json")).toBe(true);
    for (const key of ["signingIdentity", "providerShortName", "entitlements"]) {
      expect(overlay("macos").bundle?.macOS ?? {}).not.toHaveProperty(key);
    }
  });

  it("overlays carry the Tauri schema", () => {
    expect(overlayFiles.map(platformOf).sort()).toEqual(["linux", "macos", "windows"]);
    for (const file of overlayFiles) {
      expect((readJson(`src-tauri/${file}`) as { $schema?: string }).$schema).toBe(
        "https://schema.tauri.app/config/2",
      );
    }
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

  // R16: StartupWMClass must be the exec placeholder so compositors (COSMIC,
  //      GNOME) can group the app's windows under the correct launcher icon.
  it("has StartupWMClass set to the exec placeholder", () => {
    const template = readText("src-tauri/packaging/git-real.desktop");
    expect(template).toContain("StartupWMClass={{exec}}");
  });

  // Every product-name field must use Handlebars placeholders, never a
  // hard-coded string, so Tauri substitutes the canonical value at bundle time.
  it("contains no literal product name (all placeholders)", () => {
    const template = readText("src-tauri/packaging/git-real.desktop");
    expect(template).not.toContain("Git Real");
    expect(template).not.toContain("git-real");
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

type Step = Record<string, unknown>;

// §3 / R9 / R10 + GR-24: ci.yml has per-platform package jobs and workflow-level
//   concurrency that cancels stale runs on the same ref.
describe("ci workflow", () => {
  const ciText = readText(".github/workflows/ci.yml");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ciConf = parse(ciText) as any;

  it("has build-and-test, package-linux, package-windows and package-macos jobs and no package job", () => {
    expect(ciConf.jobs).toHaveProperty("build-and-test");
    expect(ciConf.jobs).toHaveProperty("package-linux");
    expect(ciConf.jobs).toHaveProperty("package-windows");
    expect(ciConf.jobs).toHaveProperty("package-macos");
    expect(ciConf.jobs).not.toHaveProperty("package");
  });

  it("package-linux bundles on ubuntu-22.04 and uploads the three globs", () => {
    const pkg = ciConf.jobs?.["package-linux"];
    expect(pkg?.["runs-on"]).toBe("ubuntu-22.04");
    expect(pkg?.name).toBe("Package (Linux)");

    const steps: Step[] = pkg?.steps ?? [];

    // Must have a step that runs the Tauri build with the three bundle targets
    const buildStep = steps.find(
      (s) => typeof s.run === "string" && (s.run as string).includes("npm run tauri build"),
    );
    expect(buildStep).toBeDefined();
    expect(String(buildStep?.run)).toContain("--bundles deb,rpm,appimage");

    // Must upload the bundles with actions/upload-artifact@v4
    const uploadStep = steps.find(
      (s) =>
        typeof s.uses === "string" && (s.uses as string).startsWith("actions/upload-artifact@v4"),
    );
    expect(uploadStep).toBeDefined();
    const w = (uploadStep?.with ?? {}) as Record<string, unknown>;
    // Artifact name must be prefixed with git-real-linux- for discoverability
    expect(String(w["name"])).toContain("git-real-linux-");
    const path = String(w.path);
    expect(path).toContain("src-tauri/target/release/bundle/deb/*.deb");
    expect(path).toContain("src-tauri/target/release/bundle/rpm/*.rpm");
    expect(path).toContain("src-tauri/target/release/bundle/appimage/*.AppImage");
    expect(w["if-no-files-found"]).toBe("error");
    expect(w["retention-days"]).toBe(14);
  });

  it("package-windows bundles nsis and msi on windows-latest under bash and uploads both globs", () => {
    const win = ciConf.jobs?.["package-windows"];
    expect(win?.["runs-on"]).toBe("windows-latest");
    expect(win?.name).toBe("Package (Windows)");

    const steps: Step[] = win?.steps ?? [];
    const runs = steps.filter((s) => typeof s.run === "string");

    const buildStep = runs.find((s) => (s.run as string).includes("npm run tauri build"));
    expect(buildStep).toBeDefined();
    expect(String(buildStep?.run)).toContain("--bundles nsis,msi");

    // Bash everywhere, so the same scripts behave on the Windows runner
    expect(runs.length).toBeGreaterThan(0);
    for (const s of runs) {
      expect(s.shell, `step ${String(s.name)} must run under bash`).toBe("bash");
      expect(s.run as string).not.toContain("apt-get");
    }

    const uploadStep = steps.find(
      (s) =>
        typeof s.uses === "string" && (s.uses as string).startsWith("actions/upload-artifact@v4"),
    );
    expect(uploadStep).toBeDefined();
    const w = (uploadStep?.with ?? {}) as Record<string, unknown>;
    expect(String(w["name"])).toContain("git-real-windows-");
    const path = String(w.path);
    expect(path).toContain("src-tauri/target/release/bundle/nsis/*.exe");
    expect(path).toContain("src-tauri/target/release/bundle/msi/*.msi");
    expect(w["if-no-files-found"]).toBe("error");
    expect(w["retention-days"]).toBe(14);
  });

  it("package-macos builds a universal dmg on macos-latest and uploads it", () => {
    const mac = ciConf.jobs?.["package-macos"];
    expect(mac?.["runs-on"]).toBe("macos-latest");
    expect(mac?.name).toBe("Package (macOS)");

    const steps: Step[] = mac?.steps ?? [];
    const rust = steps.find((s) => s.uses === "dtolnay/rust-toolchain@stable");
    expect(rust).toBeDefined();
    const targets = String((rust?.with as Record<string, unknown> | undefined)?.targets);
    expect(targets).toContain("aarch64-apple-darwin");
    expect(targets).toContain("x86_64-apple-darwin");

    const runs = steps.filter((s) => typeof s.run === "string");
    const buildStep = runs.find((s) => (s.run as string).includes("npm run tauri build"));
    expect(buildStep).toBeDefined();
    expect(String(buildStep?.run)).toContain("--target universal-apple-darwin");
    expect(String(buildStep?.run)).toContain("--bundles dmg");
    for (const s of runs) {
      expect(s.run as string).not.toContain("apt-get");
    }

    const uploadStep = steps.find(
      (s) =>
        typeof s.uses === "string" && (s.uses as string).startsWith("actions/upload-artifact@v4"),
    );
    expect(uploadStep).toBeDefined();
    const w = (uploadStep?.with ?? {}) as Record<string, unknown>;
    expect(String(w["name"])).toContain("git-real-macos-");
    const path = String(w.path);
    expect(path).toContain("src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg");
    expect(path).not.toContain("src-tauri/target/release/bundle");
    expect(w["if-no-files-found"]).toBe("error");
    expect(w["retention-days"]).toBe(14);
  });

  // Apple signing secrets belong to the release workflow's gate step only.
  it("ci workflow never references Apple secrets", () => {
    expect(ciText).not.toContain("APPLE_");
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

// §6 / R3 / R6 + GR-24: release.yml triggers on v* tags only, checks the tag
//   against the version, builds Linux, Windows and macOS in parallel, then one
//   publish job uploads every installer to a single release.
describe("release workflow", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const conf = parse(readText(".github/workflows/release.yml")) as any;
  const jobs = (conf.jobs ?? {}) as Record<string, any>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const stepsOf = (name: string): Step[] => jobs[name]?.steps ?? [];
  const needsOf = (job: { needs?: string | string[] } | undefined): string[] =>
    ([] as string[]).concat(job?.needs ?? []);
  const uploadOf = (name: string): Step | undefined =>
    stepsOf(name).find(
      (s) =>
        typeof s.uses === "string" && (s.uses as string).startsWith("actions/upload-artifact@v4"),
    );
  const buildRunOf = (name: string): string =>
    String(
      stepsOf(name).find(
        (s) => typeof s.run === "string" && (s.run as string).includes("npm run tauri build"),
      )?.run ?? "",
    );

  it("runs on v tags only", () => {
    // The yaml package (YAML 1.2) parses `on:` as the string key "on"
    const trigger = conf["on"] as Record<string, unknown>;
    const push = trigger.push as Record<string, unknown>;
    expect(push.tags).toEqual(["v*"]);
    expect(push).not.toHaveProperty("branches");
  });

  it("has check-version, build-linux, build-windows, build-macos and publish jobs", () => {
    expect(Object.keys(jobs).sort()).toEqual([
      "build-linux",
      "build-macos",
      "build-windows",
      "check-version",
      "publish",
    ]);
  });

  it("check-version guards the tag and rejects pre-release suffixes", () => {
    const step = stepsOf("check-version").find(
      (s) => s["name"] === "Check the tag matches the app version",
    );
    expect(step).toBeDefined();
    const run = String(step?.run ?? "");
    expect(run).toContain("GITHUB_REF_NAME");
    expect(run).toContain("tauri.conf.json");
    // Release tags are vX.Y.Z only; no pre-release suffix
    expect(run).toContain("^[0-9]+\\.[0-9]+\\.[0-9]+$");
    expect(run).not.toContain("(-[0-9]+)?");
  });

  it("all builds need check-version and publish needs all three builds", () => {
    expect(needsOf(jobs["build-linux"])).toEqual(["check-version"]);
    expect(needsOf(jobs["build-windows"])).toEqual(["check-version"]);
    expect(needsOf(jobs["build-macos"])).toEqual(["check-version"]);
    expect(needsOf(jobs["publish"]).sort()).toEqual([
      "build-linux",
      "build-macos",
      "build-windows",
    ]);
  });

  it("build-linux builds the Linux bundles on ubuntu-22.04 and uploads release-linux", () => {
    expect(jobs["build-linux"]?.["runs-on"]).toBe("ubuntu-22.04");
    expect(buildRunOf("build-linux")).toContain("--bundles deb,rpm,appimage");
    const upload = uploadOf("build-linux");
    expect(upload).toBeDefined();
    const w = (upload?.with ?? {}) as Record<string, unknown>;
    expect(w["name"]).toBe("release-linux");
    const path = String(w.path);
    expect(path).toContain("src-tauri/target/release/bundle/deb/*.deb");
    expect(path).toContain("src-tauri/target/release/bundle/rpm/*.rpm");
    expect(path).toContain("src-tauri/target/release/bundle/appimage/*.AppImage");
    expect(w["if-no-files-found"]).toBe("error");
    expect(w["retention-days"]).toBe(1);
  });

  it("build-windows builds the Windows bundles on windows-latest under bash and uploads release-windows", () => {
    expect(jobs["build-windows"]?.["runs-on"]).toBe("windows-latest");
    expect(buildRunOf("build-windows")).toContain("--bundles nsis,msi");
    const runs = stepsOf("build-windows").filter((s) => typeof s.run === "string");
    expect(runs.length).toBeGreaterThan(0);
    for (const s of runs) {
      expect(s.shell, `step ${String(s.name)} must run under bash`).toBe("bash");
    }
    const upload = uploadOf("build-windows");
    expect(upload).toBeDefined();
    const w = (upload?.with ?? {}) as Record<string, unknown>;
    expect(w["name"]).toBe("release-windows");
    const path = String(w.path);
    expect(path).toContain("src-tauri/target/release/bundle/nsis/*.exe");
    expect(path).toContain("src-tauri/target/release/bundle/msi/*.msi");
    expect(w["if-no-files-found"]).toBe("error");
    expect(w["retention-days"]).toBe(1);
  });

  it("build-macos builds a universal dmg on macos-latest and uploads release-macos", () => {
    expect(jobs["build-macos"]?.["runs-on"]).toBe("macos-latest");
    const rust = stepsOf("build-macos").find((s) => s.uses === "dtolnay/rust-toolchain@stable");
    expect(rust).toBeDefined();
    const targets = String((rust?.with as Record<string, unknown> | undefined)?.targets);
    expect(targets).toContain("aarch64-apple-darwin");
    expect(targets).toContain("x86_64-apple-darwin");
    expect(buildRunOf("build-macos")).toContain("--target universal-apple-darwin");
    expect(buildRunOf("build-macos")).toContain("--bundles dmg");
    const upload = uploadOf("build-macos");
    expect(upload).toBeDefined();
    const w = (upload?.with ?? {}) as Record<string, unknown>;
    expect(w["name"]).toBe("release-macos");
    const path = String(w.path);
    expect(path).toContain("src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg");
    expect(path).not.toContain("src-tauri/target/release/bundle");
    expect(w["if-no-files-found"]).toBe("error");
    expect(w["retention-days"]).toBe(1);
  });

  // Signing is dormant until the owner adds secrets: one gate step maps them,
  // the script exports only what is set, and the build step inherits via GITHUB_ENV.
  it("build-macos gates Apple signing through the script before the build", () => {
    const steps = stepsOf("build-macos");
    const gateIdx = steps.findIndex(
      (s) =>
        typeof s.run === "string" &&
        (s.run as string).trim() === ".github/scripts/apple-signing-env.sh" &&
        s.name === "Prepare Apple signing",
    );
    const buildIdx = steps.findIndex(
      (s) => typeof s.run === "string" && (s.run as string).includes("npm run tauri build"),
    );
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(gateIdx).toBeLessThan(buildIdx);

    const names: string[] = [
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_SIGNING_IDENTITY",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID",
    ];
    const env = (steps[gateIdx]?.env ?? {}) as Record<string, unknown>;
    expect(Object.keys(env).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(env[name]).toBe("${{ secrets." + name + " }}");
    }
    expect(steps[buildIdx]).not.toHaveProperty("env");
  });

  it("release workflow references Apple secrets only in the gate env block", () => {
    const rest = readText(".github/workflows/release.yml")
      .split("\n")
      .filter((l) => !/^\s*APPLE_[A-Z_]+: \$\{\{ secrets\.APPLE_[A-Z_]+ \}\}\s*$/.test(l))
      .join("\n");
    expect(rest).not.toContain("APPLE_");
  });

  it("publish downloads all three artifacts then releases all six globs once", () => {
    const steps = stepsOf("publish");
    const downloadIdx = steps.findIndex(
      (s) =>
        typeof s.uses === "string" && (s.uses as string).startsWith("actions/download-artifact@v4"),
    );
    const releaseIdx = steps.findIndex(
      (s) =>
        typeof s.uses === "string" &&
        (s.uses as string).startsWith("softprops/action-gh-release@v2"),
    );
    expect(downloadIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeGreaterThanOrEqual(0);
    expect(downloadIdx).toBeLessThan(releaseIdx);

    const dl = (steps[downloadIdx]?.with ?? {}) as Record<string, unknown>;
    expect(dl["pattern"]).toBe("release-*");
    expect(dl["merge-multiple"]).toBe(true);
    expect(dl["path"]).toBe("release-assets");

    const w = (steps[releaseIdx]?.with ?? {}) as Record<string, unknown>;
    expect(w["generate_release_notes"]).toBe(true);
    expect(w["fail_on_unmatched_files"]).toBe(true);
    expect(w).not.toHaveProperty("prerelease");
    expect(readText(".github/workflows/release.yml")).not.toContain("prerelease");
    expect(String(w["name"])).toContain("Git Real");
    const files = String(w["files"]);
    // upload-artifact@v4 keeps paths relative to the globs' common ancestor, so
    // after the merge each file sits under its bundle folder (release-assets/deb/...).
    // Derive the expected publish globs from the upload paths, never hard-code them.
    const BUNDLE_DIR = "src-tauri/target/release/bundle/";
    const uploadedGlobs = ["build-linux", "build-windows"].flatMap((name) =>
      String((uploadOf(name)?.with as Record<string, unknown> | undefined)?.path ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith(BUNDLE_DIR))
        .map((l) => l.slice(BUNDLE_DIR.length)),
    );
    expect(uploadedGlobs).toHaveLength(5);
    for (const glob of uploadedGlobs) {
      expect(files).toContain(`release-assets/${glob}`);
    }
    // The macOS upload has one glob whose only wildcard is the file name, so
    // upload-artifact@v4 puts the DMG at the artifact root; `**` matches the
    // root and a `dmg/` folder alike (spec R7).
    expect(files).toContain("release-assets/**/*.dmg");
    const fileLines = files
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(fileLines).toHaveLength(6);
    // A flat release-assets/*.ext glob matches nothing after the merge
    for (const line of fileLines) {
      expect(line, `flat glob ${line}`).not.toMatch(/^release-assets\/\*\./);
    }

    // Exactly one release step across every job, so assets land on one release
    const releaseSteps = Object.keys(jobs).flatMap((name) =>
      stepsOf(name).filter(
        (s) =>
          typeof s.uses === "string" &&
          (s.uses as string).startsWith("softprops/action-gh-release@v2"),
      ),
    );
    expect(releaseSteps).toHaveLength(1);
  });

  it("publish can write releases", () => {
    expect(jobs["publish"]?.permissions?.contents ?? conf.permissions?.contents).toBe("write");
  });

  it("has release-scoped concurrency to prevent duplicate releases", () => {
    const concurrency = conf["concurrency"] as Record<string, unknown>;
    expect(concurrency).toBeDefined();
    expect(String(concurrency["group"])).toContain("release-");
  });
});

// ---------------------------------------------------------------------------
// apt packages
// ---------------------------------------------------------------------------

// §3 / Global Constraints: the package-linux job in ci.yml, the build-linux job
//   in release.yml, and the README Development section must all install the same
//   set of apt packages (including `file` and `patchelf`).
describe("apt packages", () => {
  it("both workflows and the README list the same packages", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ciConf = parse(readText(".github/workflows/ci.yml")) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const releaseConf = parse(readText(".github/workflows/release.yml")) as any;
    const readmeText = readText("README.md");

    const ciPkgs = extractAptPackages(aptStepScript(ciConf.jobs?.["package-linux"]?.steps ?? []));
    const releasePkgs = extractAptPackages(
      aptStepScript(releaseConf.jobs?.["build-linux"]?.steps ?? []),
    );
    const readmePkgs = extractReadmeAptPackages(readmeText);

    expect(ciPkgs).toEqual(releasePkgs);
    expect(ciPkgs).toEqual(readmePkgs);
    expect(ciPkgs.has("file")).toBe(true);
    expect(ciPkgs.has("patchelf")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

// GR-24/GR-38: the README documents the Windows install steps and the dotted
//        download names, and states no pre-release tag convention; the ADRs
//        record the decision.
describe("README", () => {
  const readme = readText("README.md");
  /** Text from `\n## <heading>` to the next `\n## ` (or the end). */
  const section = (text: string, heading: string): string => {
    const start = text.indexOf(`\n## ${heading}`);
    if (start === -1) return "";
    const next = text.indexOf("\n## ", start + 1);
    return text.slice(start, next === -1 ? undefined : next);
  };

  it("intro no longer calls Windows a follow-on target", () => {
    expect(readme.slice(0, readme.indexOf("\n## "))).not.toMatch(/Windows[^.\n]*follow-on/);
  });

  it("intro no longer calls macOS a follow-on target", () => {
    expect(readme.slice(0, readme.indexOf("\n## "))).not.toMatch(/macOS[^.\n]*follow-on/);
  });

  it("install section documents the universal DMG and the Gatekeeper path", () => {
    const install = section(readme, "Install");
    expect(install).toContain(".dmg");
    expect(install).toContain("universal");
    expect(install).toContain("Git.Real_");
    expect(install).toContain("Open Anyway");
  });

  it("install section documents the Windows installers and the SmartScreen prompt", () => {
    const install = section(readme, "Install");
    expect(install).toContain("-setup.exe");
    expect(install).toContain(".msi");
    expect(install).toContain("SmartScreen");
    expect(install).toContain("msiexec");
  });

  it("install section spells download names Git.Real_", () => {
    const install = section(readme, "Install");
    expect(install).toContain("Git.Real_");
    expect(install).not.toContain("Git Real_");
  });

  it("releasing section mentions Windows installers and no pre-release convention", () => {
    const releasing = section(readme, "Releasing");
    expect(releasing).toContain("Windows");
    expect(releasing).toContain("macOS");
    expect(releasing).toContain("six");
    expect(releasing).not.toContain("pre-release");
    expect(releasing).not.toContain("-beta");
  });

  it("development section has a Windows build paragraph", () => {
    expect(section(readme, "Development")).toContain("Building on Windows");
  });

  it("development section has a macOS build paragraph", () => {
    expect(section(readme, "Development")).toContain("Building on macOS");
  });

  it("ADR 0006 exists and ADR 0003 points to it", () => {
    expect(fileExists("docs/adr/0006-per-platform-bundles-and-release.md")).toBe(true);
    const adr = readText("docs/adr/0006-per-platform-bundles-and-release.md");
    expect(adr).toContain("build-macos");
    expect(adr).toContain("APPLE_CERTIFICATE");
    expect(adr).toContain("Windows signing stays out of the code");
    expect(adr).not.toContain("— Signing stays out of the code");
    expect(readText("docs/adr/0003-release-pipeline-and-update-check.md")).toContain("ADR 0006");
  });
});

// ---------------------------------------------------------------------------
// bench workflow
// ---------------------------------------------------------------------------

// GR-16 §4: ci.yml gains a `bench` job that builds git-real-bench in release,
//           prepares three cached fixtures, runs them with a JSON report and the
//           step summary, and uploads the results even when a budget fails.
describe("bench workflow", () => {
  const BENCH = "src-tauri/target/release/git-real-bench";
  const CACHE = "~/.cache/git-real-bench";
  const conf = parse(readText(".github/workflows/ci.yml")) as {
    jobs: Record<string, { steps?: Array<Record<string, unknown>> } & Record<string, unknown>>;
  };
  const bench = conf.jobs.bench;
  const steps = (): Array<Record<string, unknown>> => bench?.steps ?? [];
  const runOf = (s: Record<string, unknown> | undefined): string => String(s?.run ?? "");
  const stepIndex = (pred: (s: Record<string, unknown>) => boolean): number =>
    steps().findIndex(pred);
  const prepareStep = () => steps().find((s) => runOf(s).includes(" prepare "));
  const runStep = () => steps().find((s) => runOf(s).includes(`${BENCH} run `));

  it("has a bench job on ubuntu-latest with a timeout", () => {
    expect({
      name: bench?.name,
      runsOn: bench?.["runs-on"],
      timeout: bench?.["timeout-minutes"],
    }).toEqual({
      name: "Benchmarks (large repositories)",
      runsOn: "ubuntu-latest",
      timeout: 30,
    });
  });

  it("builds git-real-bench in release before preparing fixtures", () => {
    const build = stepIndex((s) => runOf(s).includes("cargo build --release -p git-real-bench"));
    const prepare = stepIndex((s) => runOf(s).includes(" prepare "));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThan(build);
    expect(steps()[build]["working-directory"]).toBe("src-tauri");
  });

  it("prepares the synthetic, public-graph and public-worktree fixtures under the cached directory", () => {
    const cache = steps().find((s) => String(s.uses ?? "").startsWith("actions/cache@v4"));
    const withCache = cache?.with as Record<string, unknown> | undefined;
    expect({
      path: withCache?.path,
      key: withCache?.key,
      lines: runOf(prepareStep())
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    }).toEqual({
      path: CACHE,
      key: "git-real-bench-fixtures-v1-${{ hashFiles('src-tauri/crates/git-real-bench/src/fixtures.rs', 'src-tauri/crates/git-real-bench/src/cli.rs') }}",
      lines: [
        `${BENCH} prepare synthetic ${CACHE}/synthetic`,
        `${BENCH} prepare public-graph ${CACHE}/qemu-graph`,
        `${BENCH} prepare public-worktree ${CACHE}/qemu-worktree`,
      ],
    });
  });

  it("runs the three fixtures with a JSON report and the step summary", () => {
    // `run: >` folds to a single line
    expect(runOf(runStep()).trim()).toBe(
      `${BENCH} run ${CACHE}/synthetic ${CACHE}/qemu-graph ${CACHE}/qemu-worktree ` +
        `--json bench-results.json --summary "$GITHUB_STEP_SUMMARY"`,
    );
  });

  it("uploads the results artifact even on failure", () => {
    const upload = steps().find((s) =>
      String(s.uses ?? "").startsWith("actions/upload-artifact@v4"),
    );
    expect({ if: upload?.if, uses: upload?.uses, with: upload?.with }).toEqual({
      if: "always()",
      uses: "actions/upload-artifact@v4",
      with: {
        name: "bench-results-${{ github.sha }}",
        path: "bench-results.json",
        "retention-days": 30,
        "if-no-files-found": "ignore",
      },
    });
  });

  it("restores the fixture cache before preparing and uploads only after running", () => {
    const cache = stepIndex((s) => String(s.uses ?? "").startsWith("actions/cache@v4"));
    const prepare = stepIndex((s) => runOf(s).includes(" prepare "));
    const run = stepIndex((s) => runOf(s).includes(`${BENCH} run `));
    const upload = stepIndex((s) => String(s.uses ?? "").startsWith("actions/upload-artifact@v4"));
    expect(cache).toBeGreaterThanOrEqual(0);
    expect([cache < prepare, prepare < run, run < upload]).toEqual([true, true, true]);
  });

  it("never continues on error", () => {
    expect(bench).toBeDefined();
    const flagged = [bench, ...steps()].filter(
      (n) => n !== undefined && Object.prototype.hasOwnProperty.call(n, "continue-on-error"),
    );
    expect(flagged).toEqual([]);
  });

  it("README documents the benchmark commands", () => {
    const readme = readText("README.md");
    const idx = readme.indexOf("## Benchmarks");
    expect(idx).toBeGreaterThanOrEqual(0);
    const next = readme.indexOf("\n## ", idx + 1);
    const section = readme.slice(idx, next === -1 ? undefined : next);
    expect({
      synthetic: /git-real-bench -- prepare synthetic /.test(section),
      graph: /git-real-bench -- prepare public-graph /.test(section),
      worktree: /git-real-bench -- prepare public-worktree /.test(section),
      run: /git-real-bench -- run /.test(section),
    }).toEqual({ synthetic: true, graph: true, worktree: true, run: true });
  });

  it("cache key hashes the fixtures source and the CLI defaults", () => {
    const cache = steps().find((s) => String(s.uses ?? "").startsWith("actions/cache@v4"));
    const key = String((cache?.with as Record<string, unknown> | undefined)?.key ?? "");
    expect(key).toContain(
      "hashFiles('src-tauri/crates/git-real-bench/src/fixtures.rs', 'src-tauri/crates/git-real-bench/src/cli.rs')",
    );
  });
});
