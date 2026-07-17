#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FW_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fw-template-test.XXXXXX")"
GODOT_EDITOR_TIMEOUT_SECONDS="${FW_GODOT_EDITOR_TIMEOUT_SECONDS:-90}"
GODOT_RUN_TIMEOUT_SECONDS="${FW_GODOT_RUN_TIMEOUT_SECONDS:-30}"

for value in "${GODOT_EDITOR_TIMEOUT_SECONDS}" "${GODOT_RUN_TIMEOUT_SECONDS}"; do
  [[ "${value}" =~ ^[1-9][0-9]*$ ]] || {
    echo "Godot test timeouts must be positive seconds." >&2
    exit 1
  }
done

cleanup() {
  rm -f "${TEST_ROOT}/fw"
  rm -rf "${TEST_ROOT}"
}
trap cleanup EXIT

for pair in \
  "docs/rule.md:templates/fw_new/default/docs/fw/rule.md.tpl" \
  "docs/spec.md:templates/fw_new/default/docs/fw/spec.md.tpl" \
  "docs/use.md:templates/fw_new/default/docs/fw/use.md.tpl" \
  ".codex/skills/fw/SKILL.md:templates/fw_new/default/.codex/skills/fw/SKILL.md.tpl"; do
  source_path="${FW_ROOT}/${pair%%:*}"
  mirror_path="${FW_ROOT}/${pair#*:}"
  cmp -s "${source_path}" "${mirror_path}" || {
    echo "framework mirror is stale: ${pair}" >&2
    exit 1
  }
done

dotnet build "${FW_ROOT}/csharp/FwRuntime/FwRuntime.csproj" -c Release
dotnet build "${FW_ROOT}/csharp/FwGen/FwGen.csproj" -c Release
dotnet run --project "${FW_ROOT}/csharp/FwGenTests/FwGenTests.csproj" -c Release

ln -s "${FW_ROOT}" "${TEST_ROOT}/fw"
GENERATOR="${FW_ROOT}/csharp/FwGen/FwGen.csproj"
dotnet run --project "${GENERATOR}" -c Release -- --root "${TEST_ROOT}" craft fw-new --name fw_audit
dotnet run --project "${GENERATOR}" -c Release -- --root "${TEST_ROOT}" check
generated_before="$(cd "${TEST_ROOT}" && find scripts/_gen csharp/_gen -type f -print0 | sort -z | xargs -0 sha256sum)"
for command in system bridge config; do
  dotnet run --project "${GENERATOR}" -c Release -- --root "${TEST_ROOT}" "${command}"
done
generated_after="$(cd "${TEST_ROOT}" && find scripts/_gen csharp/_gen -type f -print0 | sort -z | xargs -0 sha256sum)"
[[ "${generated_before}" == "${generated_after}" ]] || {
  echo "repeated generation is not deterministic" >&2
  exit 1
}
printf '\n// tampered\n' >> "${TEST_ROOT}/csharp/_gen/_core_systems.cs"
if dotnet run --project "${GENERATOR}" -c Release -- --root "${TEST_ROOT}" check; then
  echo "fw check accepted a modified generated file" >&2
  exit 1
fi
dotnet run --project "${GENERATOR}" -c Release -- --root "${TEST_ROOT}" system
dotnet run --project "${GENERATOR}" -c Release -- --root "${TEST_ROOT}" check
dotnet run --project "${GENERATOR}" -c Release -- --root "${TEST_ROOT}" config_pack
pack_before="$(cd "${TEST_ROOT}" && find pack/config -type f -print0 | sort -z | xargs -0 sha256sum)"
dotnet run --project "${GENERATOR}" -c Release -- --root "${TEST_ROOT}" config_pack
pack_after="$(cd "${TEST_ROOT}" && find pack/config -type f -print0 | sort -z | xargs -0 sha256sum)"
[[ "${pack_before}" == "${pack_after}" ]] || {
  echo "repeated config packing is not deterministic" >&2
  exit 1
}
dotnet build "${TEST_ROOT}/fw_audit.csproj" -c Release

GODOT_DOTNET="${GODOT_BIN:-}"
if [[ -z "${GODOT_DOTNET}" ]]; then
  for candidate in godot_mono godot4_mono godot godot4; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      resolved="$(readlink -f "$(command -v "${candidate}")")"
      if [[ "$(basename "${resolved}")" =~ [Mm][Oo][Nn][Oo] ]] || [[ -d "$(dirname "${resolved}")/GodotSharp" ]]; then
        GODOT_DOTNET="${resolved}"
        break
      fi
    fi
  done
fi

if [[ -n "${GODOT_DOTNET}" && -x "${GODOT_DOTNET}" ]]; then
  dotnet build "${TEST_ROOT}/fw_audit.csproj" -c Debug
  timeout "${GODOT_EDITOR_TIMEOUT_SECONDS}s" "${GODOT_DOTNET}" --headless --editor --path "${TEST_ROOT}" --log-file "${TEST_ROOT}/godot_editor.log" --quit
  dotnet run --project "${GENERATOR}" -c Release -- --root "${TEST_ROOT}" check
  dotnet build "${TEST_ROOT}/fw_audit.csproj" -c Debug
  timeout "${GODOT_RUN_TIMEOUT_SECONDS}s" "${GODOT_DOTNET}" --headless --path "${TEST_ROOT}" --log-file "${TEST_ROOT}/godot_runtime.log" --script "res://fw/tests/runtime_test.gd"
  timeout "${GODOT_RUN_TIMEOUT_SECONDS}s" "${GODOT_DOTNET}" --headless --path "${TEST_ROOT}" --log-file "${TEST_ROOT}/godot_game.log" --quit-after 3
  test -f "${TEST_ROOT}/.godot/global_script_class_cache.cfg"
  ! grep -Eiq 'SCRIPT ERROR|Parse Error|Compile Error|Can.t run project|^ERROR:' \
    "${TEST_ROOT}/godot_editor.log" "${TEST_ROOT}/godot_game.log"
  ! sed \
    -e "/^ERROR: System 'second' init must return true; initialization failed\.$/d" \
    -e '/^ERROR: FUI can only open scenes whose root extends FForm\.$/d' \
    "${TEST_ROOT}/godot_runtime.log" \
    | grep -Eiq 'SCRIPT ERROR|Parse Error|Compile Error|Can.t run project|^ERROR:'
else
  echo "Godot .NET not found; headless C# template check skipped. Set GODOT_BIN to enable it."
fi

echo "fw tests passed."
