#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:?missing fw_gen command}"
shift
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../.."
GENERATOR_MANIFEST=""
PACKAGE="fw_gen"
EXTRA_ARGS=()

get_fw_toml_value() {
  local project_root="$1"
  local section="$2"
  local key="$3"
  local file="${project_root}/fw.toml"
  [[ -f "${file}" ]] || return 1
  awk -v section="${section}" -v key="${key}" '
    /^\s*\[/ {
      current=$0
      gsub(/^\s*\[/, "", current)
      gsub(/\]\s*$/, "", current)
      next
    }
    current == section {
      if (match($0, "^[[:space:]]*" key "[[:space:]]*=[[:space:]]*\"([^\"]*)\"", parts)) {
        print parts[1]
        exit
      }
    }
  ' "${file}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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
    --)
      shift
      EXTRA_ARGS+=("$@")
      break
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

PROJECT_ROOT="$(cd "${PROJECT_ROOT}" && pwd)"
if [[ -z "${GENERATOR_MANIFEST}" ]]; then
  CONFIGURED_GENERATOR_MANIFEST="$(get_fw_toml_value "${PROJECT_ROOT}" "rust" "generator_manifest" || true)"
  CONFIGURED_CARGO_MANIFEST="$(get_fw_toml_value "${PROJECT_ROOT}" "rust" "workspace" || true)"
  if [[ -n "${CONFIGURED_GENERATOR_MANIFEST}" ]]; then
    GENERATOR_MANIFEST="${PROJECT_ROOT}/${CONFIGURED_GENERATOR_MANIFEST}"
  elif [[ -n "${CONFIGURED_CARGO_MANIFEST}" ]]; then
    GENERATOR_MANIFEST="${PROJECT_ROOT}/${CONFIGURED_CARGO_MANIFEST}"
  else
    GENERATOR_MANIFEST="${PROJECT_ROOT}/rust/Cargo.toml"
  fi
fi
if [[ "${PACKAGE}" == "fw_gen" ]]; then
  CONFIGURED_PACKAGE="$(get_fw_toml_value "${PROJECT_ROOT}" "rust" "generator_package" || true)"
  if [[ -n "${CONFIGURED_PACKAGE}" ]]; then
    PACKAGE="${CONFIGURED_PACKAGE}"
  fi
fi

pushd "${PROJECT_ROOT}" >/dev/null
cargo run --manifest-path "${GENERATOR_MANIFEST}" -p "${PACKAGE}" -- --root "${PROJECT_ROOT}" "${COMMAND}" "${EXTRA_ARGS[@]}"
popd >/dev/null
