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

install_fw_hooks() {
  local fw_root
  fw_root="$(cd "${SCRIPT_DIR}/.." && pwd)"
  if [[ -d "${fw_root}/hooks" && -e "${fw_root}/.git" ]]; then
    git -C "${fw_root}" config core.hooksPath hooks >/dev/null 2>&1 || true
  fi
}

install_fw_hooks

get_fw_toml_value() {
  local project_root="$1"
  local section="$2"
  local key="$3"
  local file="${project_root}/fw.toml"
  [[ -f "${file}" ]] || return 1
  awk -v section="${section}" -v key="${key}" '
    function trim(value) {
      gsub(/^[[:space:]]+/, "", value)
      gsub(/[[:space:]]+$/, "", value)
      return value
    }
    /^\s*\[/ {
      current=$0
      gsub(/^\s*\[/, "", current)
      gsub(/\]\s*$/, "", current)
      next
    }
    current == section {
      line=$0
      sub(/#.*/, "", line)
      eq=index(line, "=")
      if (eq == 0) {
        next
      }
      field=trim(substr(line, 1, eq - 1))
      if (field != key) {
        next
      }
      value=trim(substr(line, eq + 1))
      if (value ~ /^".*"$/) {
        sub(/^"/, "", value)
        sub(/"$/, "", value)
        print value
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
  CONFIGURED_CSHARP_PROJECT="$(get_fw_toml_value "${PROJECT_ROOT}" "dotnet" "game" || true)"
  if [[ -z "${CONFIGURED_CSHARP_PROJECT}" ]]; then
    CONFIGURED_CSHARP_PROJECT="$(get_fw_toml_value "${PROJECT_ROOT}" "build" "csharp" || true)"
  fi
  if [[ -z "${CONFIGURED_CSHARP_PROJECT}" ]]; then
    CONFIGURED_CSHARP_PROJECT="$(get_fw_toml_value "${PROJECT_ROOT}" "csharp" "project" || true)"
  fi
  if [[ -n "${CONFIGURED_CSHARP_PROJECT}" ]]; then
    CSHARP_PROJECT="${PROJECT_ROOT}/${CONFIGURED_CSHARP_PROJECT}"
  else
    CSHARP_PROJECT="${PROJECT_ROOT}/wdc.csproj"
  fi
fi
if [[ -z "${GENERATOR_PROJECT}" ]]; then
  CONFIGURED_GENERATOR_PROJECT="$(get_fw_toml_value "${PROJECT_ROOT}" "dotnet" "generator" || true)"
  if [[ -z "${CONFIGURED_GENERATOR_PROJECT}" ]]; then
    CONFIGURED_GENERATOR_PROJECT="$(get_fw_toml_value "${PROJECT_ROOT}" "build" "generator" || true)"
  fi
  if [[ -z "${CONFIGURED_GENERATOR_PROJECT}" ]]; then
    CONFIGURED_GENERATOR_PROJECT="$(get_fw_toml_value "${PROJECT_ROOT}" "generator" "project" || true)"
  fi
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
