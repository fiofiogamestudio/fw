#!/usr/bin/env bash
set -euo pipefail

NAME=""
PROJECT_ROOT=""
GENERATOR_PROJECT=""
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      NAME="$2"
      shift 2
      ;;
    --project-root|--root)
      PROJECT_ROOT="$2"
      shift 2
      ;;
    --generator-project)
      GENERATOR_PROJECT="$2"
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
PROJECT_ROOT="$(cd "${PROJECT_ROOT}" && pwd)"

if [[ -z "$GENERATOR_PROJECT" ]]; then
  GENERATOR_PROJECT="$PROJECT_ROOT/fw/csharp/FwGen/FwGen.csproj"
fi

pushd "$PROJECT_ROOT" >/dev/null
ARGS=(
  run
  --project "$GENERATOR_PROJECT"
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
dotnet "${ARGS[@]}"
popd >/dev/null
