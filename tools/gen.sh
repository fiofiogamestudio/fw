#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:?missing fw_gen command}"
shift

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../.."
GENERATOR_PROJECT=""
EXTRA_ARGS=()

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
    --project-root|--root)
      PROJECT_ROOT="$2"
      shift 2
      ;;
    --generator-project)
      GENERATOR_PROJECT="$2"
      shift 2
      ;;
    --generator-manifest|--package)
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
dotnet run --project "${GENERATOR_PROJECT}" -- --root "${PROJECT_ROOT}" "${COMMAND}" "${EXTRA_ARGS[@]}"
popd >/dev/null
