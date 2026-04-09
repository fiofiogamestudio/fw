#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../.."
CARGO_MANIFEST=""
GENERATOR_MANIFEST=""
GENERATOR_PACKAGE="fw_gen"
LIBRARY_PACKAGE="bridge"
LIBRARY_NAME="bridge"
BIN_DIR=""
PROFILE="debug"
RELEASE="false"
GEN_COMMANDS=(${FW_GEN_COMMANDS:-system bridge config})
RELEASE_GEN_COMMANDS=(${FW_RELEASE_GEN_COMMANDS:-pak-config})
EXTRA_CARGO_ARGS=()

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
    --release)
      PROFILE="release"
      RELEASE="true"
      EXTRA_CARGO_ARGS+=("--release")
      shift
      ;;
    --project-root)
      PROJECT_ROOT="$2"
      shift 2
      ;;
    --manifest-path)
      CARGO_MANIFEST="$2"
      shift 2
      ;;
    --generator-manifest)
      GENERATOR_MANIFEST="$2"
      shift 2
      ;;
    --generator-package)
      GENERATOR_PACKAGE="$2"
      shift 2
      ;;
    --package)
      LIBRARY_PACKAGE="$2"
      shift 2
      ;;
    --lib-name)
      LIBRARY_NAME="$2"
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="$2"
      shift 2
      ;;
    --)
      shift
      EXTRA_CARGO_ARGS+=("$@")
      break
      ;;
    *)
      EXTRA_CARGO_ARGS+=("$1")
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
if [[ -z "${CARGO_MANIFEST}" ]]; then
  CONFIGURED_CARGO_MANIFEST="$(get_fw_toml_value "${PROJECT_ROOT}" "rust" "workspace" || true)"
  if [[ -n "${CONFIGURED_CARGO_MANIFEST}" ]]; then
    CARGO_MANIFEST="${PROJECT_ROOT}/${CONFIGURED_CARGO_MANIFEST}"
  else
    CARGO_MANIFEST="${PROJECT_ROOT}/rust/Cargo.toml"
  fi
fi
if [[ "${GENERATOR_PACKAGE}" == "fw_gen" ]]; then
  CONFIGURED_GENERATOR_PACKAGE="$(get_fw_toml_value "${PROJECT_ROOT}" "rust" "generator_package" || true)"
  if [[ -n "${CONFIGURED_GENERATOR_PACKAGE}" ]]; then
    GENERATOR_PACKAGE="${CONFIGURED_GENERATOR_PACKAGE}"
  fi
fi
if [[ "${LIBRARY_PACKAGE}" == "bridge" ]]; then
  CONFIGURED_LIBRARY_PACKAGE="$(get_fw_toml_value "${PROJECT_ROOT}" "rust" "library_package" || true)"
  if [[ -n "${CONFIGURED_LIBRARY_PACKAGE}" ]]; then
    LIBRARY_PACKAGE="${CONFIGURED_LIBRARY_PACKAGE}"
  fi
fi
if [[ "${LIBRARY_NAME}" == "bridge" ]]; then
  CONFIGURED_LIBRARY_NAME="$(get_fw_toml_value "${PROJECT_ROOT}" "rust" "library_name" || true)"
  if [[ -n "${CONFIGURED_LIBRARY_NAME}" ]]; then
    LIBRARY_NAME="${CONFIGURED_LIBRARY_NAME}"
  fi
fi
if [[ -z "${BIN_DIR}" ]]; then
  CONFIGURED_BIN_DIR="$(get_fw_toml_value "${PROJECT_ROOT}" "rust" "bin_dir" || true)"
  if [[ -n "${CONFIGURED_BIN_DIR}" ]]; then
    BIN_DIR="${PROJECT_ROOT}/${CONFIGURED_BIN_DIR}"
  else
    BIN_DIR="${PROJECT_ROOT}/bin"
  fi
fi
RUST_ROOT="$(cd "$(dirname "${CARGO_MANIFEST}")" && pwd)"

pushd "${PROJECT_ROOT}" >/dev/null
for command in "${GEN_COMMANDS[@]}"; do
  "${SCRIPT_DIR}/gen.sh" "${command}" \
    --project-root "${PROJECT_ROOT}" \
    --generator-manifest "${GENERATOR_MANIFEST}" \
    --package "${GENERATOR_PACKAGE}"
done
if [[ "${RELEASE}" == "true" ]]; then
  for command in "${RELEASE_GEN_COMMANDS[@]}"; do
    "${SCRIPT_DIR}/gen.sh" "${command}" \
      --project-root "${PROJECT_ROOT}" \
      --generator-manifest "${GENERATOR_MANIFEST}" \
      --package "${GENERATOR_PACKAGE}"
  done
fi
cargo build --manifest-path "${CARGO_MANIFEST}" -p "${LIBRARY_PACKAGE}" "${EXTRA_CARGO_ARGS[@]}"
mkdir -p "${BIN_DIR}"

if [[ "$OSTYPE" == darwin* ]]; then
  ARTIFACT_NAME="lib${LIBRARY_NAME}.dylib"
else
  ARTIFACT_NAME="lib${LIBRARY_NAME}.so"
fi

cp "${RUST_ROOT}/target/${PROFILE}/${ARTIFACT_NAME}" "${BIN_DIR}/${ARTIFACT_NAME}"
popd >/dev/null
