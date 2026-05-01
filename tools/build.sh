#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../.."
CSHARP_PROJECT=""
GENERATOR_PROJECT=""
CONFIGURATION="Debug"
RELEASE="false"
GEN_COMMANDS=(${FW_GEN_COMMANDS:-system bridge config})
RELEASE_GEN_COMMANDS=(${FW_RELEASE_GEN_COMMANDS:-pak-config})

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
      CONFIGURATION="Release"
      RELEASE="true"
      shift
      ;;
    --project-root|--root)
      PROJECT_ROOT="$2"
      shift 2
      ;;
    --csharp-project|--project)
      CSHARP_PROJECT="$2"
      shift 2
      ;;
    --generator-project)
      GENERATOR_PROJECT="$2"
      shift 2
      ;;
    --manifest-path|--generator-manifest|--generator-package|--package|--lib-name|--bin-dir)
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

PROJECT_ROOT="$(cd "${PROJECT_ROOT}" && pwd)"
if [[ -z "${CSHARP_PROJECT}" ]]; then
  CONFIGURED_CSHARP_PROJECT="$(get_fw_toml_value "${PROJECT_ROOT}" "csharp" "project" || true)"
  if [[ -n "${CONFIGURED_CSHARP_PROJECT}" ]]; then
    CSHARP_PROJECT="${PROJECT_ROOT}/${CONFIGURED_CSHARP_PROJECT}"
  else
    CSHARP_PROJECT="${PROJECT_ROOT}/wdc.csproj"
  fi
fi
if [[ -z "${GENERATOR_PROJECT}" ]]; then
  CONFIGURED_GENERATOR_PROJECT="$(get_fw_toml_value "${PROJECT_ROOT}" "generator" "project" || true)"
  if [[ -n "${CONFIGURED_GENERATOR_PROJECT}" ]]; then
    GENERATOR_PROJECT="${PROJECT_ROOT}/${CONFIGURED_GENERATOR_PROJECT}"
  else
    GENERATOR_PROJECT="${PROJECT_ROOT}/fw/csharp/FwGen/FwGen.csproj"
  fi
fi

pushd "${PROJECT_ROOT}" >/dev/null
for command in "${GEN_COMMANDS[@]}"; do
  "${SCRIPT_DIR}/gen.sh" "${command}" \
    --project-root "${PROJECT_ROOT}" \
    --generator-project "${GENERATOR_PROJECT}"
done
if [[ "${RELEASE}" == "true" ]]; then
  for command in "${RELEASE_GEN_COMMANDS[@]}"; do
    "${SCRIPT_DIR}/gen.sh" "${command}" \
      --project-root "${PROJECT_ROOT}" \
      --generator-project "${GENERATOR_PROJECT}"
  done
fi
dotnet build "${CSHARP_PROJECT}" -c "${CONFIGURATION}"
popd >/dev/null
