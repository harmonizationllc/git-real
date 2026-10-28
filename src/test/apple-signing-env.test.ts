/**
 * Behavior tests for the Apple signing gate script (GR-23, spec R5):
 * .github/scripts/apple-signing-env.sh. It validates the six APPLE_* variables,
 * exports the set ones to $GITHUB_ENV, and prints a notice naming the signing
 * mode. Each test runs the script under bash with a clean environment.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Repository root, two levels up from src/test/
const ROOT = resolve(__dirname, "../..");
const SCRIPT = resolve(ROOT, ".github/scripts/apple-signing-env.sh");

const NAMES = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
] as const;

/** Run the gate with only PATH, the given variables and (optionally) GITHUB_ENV. */
function runGate(
  vars: Partial<Record<(typeof NAMES)[number], string>>,
  opts?: { noGithubEnv?: boolean },
): { status: number; output: string; envFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "gr23-"));
  const file = join(dir, "github.env");
  writeFileSync(file, "");
  let status = 0;
  let output = "";
  try {
    output = execFileSync("bash", [SCRIPT], {
      env: {
        PATH: process.env.PATH ?? "",
        ...(opts?.noGithubEnv ? {} : { GITHUB_ENV: file }),
        ...vars,
      },
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (e) {
    const err = e as { status?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    status = typeof err.status === "number" ? err.status : -1;
    output = `${String(err.stdout ?? "")}${String(err.stderr ?? "")}${err.message ?? ""}`;
  }
  return { status, output, envFile: readFileSync(file, "utf8") };
}

/** Parse the NAME<<EOF_APPLE_SIGNING heredoc blocks the script appends to GITHUB_ENV. */
function parseGithubEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^([A-Z_]+)<<EOF_APPLE_SIGNING\n([\s\S]*?)\nEOF_APPLE_SIGNING$/gm;
  for (const m of text.matchAll(re)) out[m[1]] = m[2];
  return out;
}

const hasBash = (() => {
  try {
    execFileSync("bash", ["-c", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const CERT = "MIIabc\nMIIdef";
const PW = "p12-pass";
const ID = "Developer ID Application: Harmonization LLC (TEAMID1234)";
const AID = "owner@example.com";
const APW = "abcd-efgh-ijkl-mnop";
const TEAM = "TEAMID1234";
const PAIR = { APPLE_CERTIFICATE: CERT, APPLE_CERTIFICATE_PASSWORD: PW };

describe.skipIf(!hasBash)("apple-signing-env", () => {
  it("script exists and is executable", () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  // No Developer ID secrets: the script itself exports the ad-hoc pseudo-identity
  // "-" so the bundle is still code-signed (Apple Silicon refuses an unsigned app).
  const ADHOC_NOTICE =
    "::notice::Apple signing: unsigned (ad-hoc identity, no Developer ID secrets)";

  it("nothing set: ad-hoc identity, unsigned", () => {
    const r = runGate({});
    expect(r.status).toBe(0);
    expect(parseGithubEnv(r.envFile)).toEqual({ APPLE_SIGNING_IDENTITY: "-" });
    expect(r.output).toContain(ADHOC_NOTICE);
  });

  it("empty strings behave as unset", () => {
    const r = runGate(Object.fromEntries(NAMES.map((n) => [n, ""])));
    expect(r.status).toBe(0);
    expect(parseGithubEnv(r.envFile)).toEqual({ APPLE_SIGNING_IDENTITY: "-" });
    expect(r.output).toContain(ADHOC_NOTICE);
  });

  it("all six set round-trip, including a multi-line certificate", () => {
    const r = runGate({
      APPLE_CERTIFICATE: CERT,
      APPLE_CERTIFICATE_PASSWORD: PW,
      APPLE_SIGNING_IDENTITY: ID,
      APPLE_ID: AID,
      APPLE_PASSWORD: APW,
      APPLE_TEAM_ID: TEAM,
    });
    expect(r.status).toBe(0);
    expect(parseGithubEnv(r.envFile)).toEqual({
      APPLE_CERTIFICATE: CERT,
      APPLE_CERTIFICATE_PASSWORD: PW,
      APPLE_SIGNING_IDENTITY: ID,
      APPLE_ID: AID,
      APPLE_PASSWORD: APW,
      APPLE_TEAM_ID: TEAM,
    });
    expect(r.output).toContain("::notice::Apple signing: signed and notarized");
  });

  it("certificate pair alone signs without notarizing", () => {
    const r = runGate(PAIR);
    expect(r.status).toBe(0);
    expect(Object.keys(parseGithubEnv(r.envFile)).sort()).toEqual([
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
    ]);
    expect(r.output).toContain("::notice::Apple signing: signed, not notarized");
  });

  it("identity is optional and exported with the certificate", () => {
    const r = runGate({ ...PAIR, APPLE_SIGNING_IDENTITY: ID });
    expect(r.status).toBe(0);
    expect(Object.keys(parseGithubEnv(r.envFile)).sort()).toEqual([
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_SIGNING_IDENTITY",
    ]);
    expect(r.output).toContain("signed, not notarized");
  });

  // On every failure the script must validate before it writes anything.
  it("certificate without its password fails naming the password", () => {
    const r = runGate({ APPLE_CERTIFICATE: CERT });
    expect(r.status).toBe(1);
    expect(r.output).toContain("APPLE_CERTIFICATE_PASSWORD");
    expect(r.envFile).toBe("");
  });

  it("password without the certificate fails naming the certificate", () => {
    const r = runGate({ APPLE_CERTIFICATE_PASSWORD: PW });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/APPLE_CERTIFICATE(?!_)/);
    expect(r.envFile).toBe("");
  });

  it("identity alone fails naming the certificate", () => {
    const r = runGate({ APPLE_SIGNING_IDENTITY: ID });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/APPLE_CERTIFICATE(?!_)/);
    expect(r.envFile).toBe("");
  });

  // The "-" is the script's own; a secret-supplied identity needs a certificate.
  it('a secret identity of "-" without a certificate still fails', () => {
    const r = runGate({ APPLE_SIGNING_IDENTITY: "-" });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/APPLE_CERTIFICATE(?!_)/);
    expect(r.envFile).toBe("");
  });

  it("notarization trio missing the team id fails naming it", () => {
    const r = runGate({ ...PAIR, APPLE_ID: AID, APPLE_PASSWORD: APW });
    expect(r.status).toBe(1);
    expect(r.output).toContain("APPLE_TEAM_ID");
    expect(r.envFile).toBe("");
  });

  it("notarization trio without a certificate fails naming the certificate", () => {
    const r = runGate({ APPLE_ID: AID, APPLE_PASSWORD: APW, APPLE_TEAM_ID: TEAM });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/APPLE_CERTIFICATE(?!_)/);
    expect(r.envFile).toBe("");
  });

  it("missing GITHUB_ENV fails", () => {
    const r = runGate(PAIR, { noGithubEnv: true });
    expect(r.status).toBe(1);
    expect(r.output).toContain("GITHUB_ENV");
  });
});
