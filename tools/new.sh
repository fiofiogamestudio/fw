#!/usr/bin/env bash
set -euo pipefail

NAME=""
PROJECT_ROOT=""
GENERATOR_MANIFEST=""
PACKAGE="fw_gen"
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      NAME="$2"
      shift 2
      ;;
    --project-root)
      PROJECT_ROOT="$2"
      shift 2
      ;;
    --generator-manifest)
      GENERATOR_MANIFEST="$2"
      shift 2
      ;;
    --package)
      PACKAGE="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PROJECT_ROOT" ]]; then
  PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fi

if [[ -z "$GENERATOR_MANIFEST" ]]; then
  GENERATOR_MANIFEST="$PROJECT_ROOT/fw/rust/Cargo.toml"
fi

pushd "$PROJECT_ROOT" >/dev/null
ARGS=(
  run
  --manifest-path "$GENERATOR_MANIFEST"
  -p "$PACKAGE"
  --
  --root "$PROJECT_ROOT"
  craft
  fw-new
)
if [[ -n "$NAME" ]]; then
  ARGS+=(--name "$NAME")
fi
if [[ "$FORCE" -eq 1 ]]; then
  ARGS+=(--force)
fi
cargo "${ARGS[@]}"
popd >/dev/null
