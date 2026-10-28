#!/usr/bin/env bash
# Gate for Apple code signing and notarization (GR-23, ADR 0006 R13).
#
# The Tauri bundler reads the APPLE_* variables with var_os, so a variable that
# is present but empty breaks the build. A step-level env mapping from secrets
# would export empty strings for secrets that do not exist, so this script
# validates the six values and appends only the non-empty ones to GITHUB_ENV.
# Later steps then inherit exactly what is set. Nothing is written until every
# check has passed.
#
# With no certificate the script exports APPLE_SIGNING_IDENTITY=-, the ad-hoc
# pseudo-identity. Apple Silicon refuses an app bundle that carries no signature
# at all ("is damaged"), and an ad-hoc signature needs no Developer ID. The
# Tauri bundler signs the .app ad-hoc, skips self-signing the DMG and skips
# notarization when it sees "-".
set -euo pipefail

github_env="${GITHUB_ENV:-}"
cert="${APPLE_CERTIFICATE:-}"
cert_password="${APPLE_CERTIFICATE_PASSWORD:-}"
identity="${APPLE_SIGNING_IDENTITY:-}"
apple_id="${APPLE_ID:-}"
apple_password="${APPLE_PASSWORD:-}"
team_id="${APPLE_TEAM_ID:-}"

fail() {
  echo "apple-signing-env: $1" >&2
  exit 1
}

[ -n "$github_env" ] || fail "GITHUB_ENV is not set; this script must run inside GitHub Actions"

if [ -n "$cert" ] && [ -z "$cert_password" ]; then
  fail "APPLE_CERTIFICATE is set but APPLE_CERTIFICATE_PASSWORD is missing"
fi
if [ -z "$cert" ] && [ -n "$cert_password" ]; then
  fail "APPLE_CERTIFICATE_PASSWORD is set but APPLE_CERTIFICATE is missing"
fi
if [ -z "$cert" ] && [ -n "$identity" ]; then
  fail "APPLE_SIGNING_IDENTITY is set but APPLE_CERTIFICATE is missing"
fi

notarize=0
if [ -n "$apple_id" ] || [ -n "$apple_password" ] || [ -n "$team_id" ]; then
  [ -n "$apple_id" ] || fail "notarization needs APPLE_ID, which is missing"
  [ -n "$apple_password" ] || fail "notarization needs APPLE_PASSWORD, which is missing"
  [ -n "$team_id" ] || fail "notarization needs APPLE_TEAM_ID, which is missing"
  [ -n "$cert" ] || fail "notarization needs APPLE_CERTIFICATE, which is missing"
  notarize=1
fi

export_var() {
  local name="$1" value="$2"
  [ -n "$value" ] || return 0
  {
    printf '%s<<EOF_APPLE_SIGNING\n' "$name"
    printf '%s\n' "$value"
    printf 'EOF_APPLE_SIGNING\n'
  } >>"$github_env"
}

export_var APPLE_CERTIFICATE "$cert"
export_var APPLE_CERTIFICATE_PASSWORD "$cert_password"
if [ -z "$cert" ]; then
  identity="-"
fi
export_var APPLE_SIGNING_IDENTITY "$identity"
export_var APPLE_ID "$apple_id"
export_var APPLE_PASSWORD "$apple_password"
export_var APPLE_TEAM_ID "$team_id"

if [ "$notarize" -eq 1 ]; then
  echo "::notice::Apple signing: signed and notarized"
elif [ -n "$cert" ]; then
  echo "::notice::Apple signing: signed, not notarized"
else
  echo "::notice::Apple signing: unsigned (ad-hoc identity, no Developer ID secrets)"
fi
