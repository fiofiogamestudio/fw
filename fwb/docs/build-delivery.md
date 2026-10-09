# Resource budgets and local delivery

FWB owns preparation, copying, measurements and artifact identity. A game owns its resource references, acceptable image quality, media selection and gameplay behavior. Browser Web/H5 output is not a native mobile package or a mini-game runtime.

## Optional configuration

```json
{
  "externalAssets": [
    { "source": "assets/video/title.mp4", "destination": "media/title.mp4" }
  ],
  "texturePolicy": {
    "include": ["assets/backgrounds"],
    "exclude": ["assets/backgrounds/pixel-art"],
    "mode": "lossy",
    "quality": 0.78,
    "maxSize": 1024,
    "rules": [
      {
        "include": ["assets/items", "assets/icons"],
        "quality": 0.82,
        "maxSize": 384
      }
    ]
  },
  "targets": {
    "taptap-h5": {
      "preset": "Web",
      "externalAssetsManifest": "tools/generated-web-assets.json",
      "deliveryValidationScript": "tools/validate-delivery.mjs",
      "budgets": {
        "totalBytes": 209715200,
        "startupBytes": 104857600,
        "maxFileBytes": 94371840,
        "decodedBytes": 314572800
      },
      "startupFiles": ["index.html", "index.js", "index.wasm", "index.pck"]
    }
  }
}
```

Merge these optional settings into a complete `fwb.project.json`; the numbers above are project examples, **not platform limits**. Omitted settings retain the old build behavior. `schemaVersion` remains 1. Existing target `prepareScript`, shared resource preparation, `finalizeScript` and `maxBytes` retain their meanings.

`runtimeAddon:false` does not uninstall files from a host that already used `runtime-install`. Preflight explicitly blocks when that setting conflicts with an existing managed `FwbPlatform` autoload, so an apparently disabled runtime cannot silently remain active. Enable the addon for export, or explicitly remove the host autoload and review game references before disabling it. Preflight never edits the host.

`externalAssets` only inherits into browser targets (`web`, `poki`, `taptap-h5`). A target array appends files; `externalAssets:false` disables shared and target list copying. Native and mini-game targets do not inherit the list and cannot explicitly declare it. Every entry is one project-relative source file and one output-relative destination file; globs, links, traversal, empty files, duplicate destinations and overwrites are rejected. Source files must be included in the frozen snapshot. Assets are copied after engine export and before the target finalizer. Original assets must still be excluded from the PCK by the game's export rules when duplicate packaging is unwanted.

`externalAssetsManifest` names a project-relative JSON file read **after preparation**. A preparation script may write it inside its snapshot. Its format is `{ "schemaVersion": 1, "files": [{ "source": "...", "destination": "..." }] }`. Those files append to the resolved static list and use the same copying rules. The manifest is an explicit target setting, independent of `externalAssets:false`. This lets games derive enabled media from their content configuration without reimplementing safe copying. Its source files may be generated inside the snapshot. A missing manifest fails the build; preflight permits generation only when a preparation script is configured.

`texturePolicy` changes only matching texture `.import` settings in the snapshot, after host preparation and before FWC/Godot import. `include` and `exclude` contain exact file or directory prefixes, not globs. Modes are `lossless`, `lossy`, or `vram`; optional `quality` is 0..1 and `maxSize` is 0 (unchanged) or 1..16384. Original images are unchanged and source/import identities are recorded. Global policy only inherits into browser targets; a target can override it or use `false`. Missing or unmatched import files fail explicitly. Runtime appearance and GPU memory still require actual validation; setting compression flags alone does not prove a useful size reduction.

Optional `rules` contains 1..1000 ordered rules. Each rule requires a nonempty `include`, permits `exclude`, and overrides at least one of `mode`, `quality`, or `maxSize`. The base `include` and `mode` remain required. A resource starts with the base parameters; every matching rule replaces only its supplied parameters, so the last matching value for each parameter wins. A rule can select resources outside the base `include`, inheriting any base parameters it does not override. Exclusions apply only to their own selector: a base exclusion does not prevent a later rule from explicitly selecting that resource, and a rule exclusion leaves previous selections and values intact. Unknown fields, empty rules, invalid paths, and out-of-range values fail validation.

Each selected texture import is written once using its final values. The build manifest's `texturePolicy.files` entries record `effectivePolicy`, `sourceSha256`, `importBeforeSha256`, and `importSha256`. A final `maxSize:0` preserves the original snapshot import limit; it does not reset an existing limit to unlimited. To preserve a cover exactly, keep it outside all selectors. To explicitly select a cover with lossless compression and its existing dimensions, add a final rule such as `{ "include": ["assets/cover.png"], "mode": "lossless", "maxSize": 0 }`; inherited `quality` remains recorded but is inactive for lossless mode. The policy does not change source files or remove resources from export.

## Measurements and budgets

Each new artifact has `resource-report.json` and a hash/metrics reference in its manifest. It contains output totals, directory/type groups, largest files, identical output-file candidates, and a bounded read-only index of unencrypted Godot 4 PCK v2/v3 resources. It never extracts or deletes resources. Unknown/encrypted/newer PCK formats remain an explicit report limitation instead of silently inventing contents or breaking legacy exports.

```powershell
node fwb/bin/fwb.mjs resources --project D:/Games/MyGame --artifact <build_id>
```

The report command also diagnoses artifacts rejected for size budgets, while still requiring intact outputs and valid package structure. Its `packageValidationPassed` field preserves that distinction. All limits are positive integer byte counts:

| Field | Meaning |
| --- | --- |
| Existing `maxBytes` | Complete exported output total, unchanged |
| `budgets.totalBytes` | Complete output total, including media and manifests |
| `budgets.maxFileBytes` | Largest output file |
| `budgets.startupBytes` | Sum of explicit `startupFiles`, or conservatively all outputs if omitted |
| `budgets.decodedBytes` | Output total with gzip delivery files replaced by their declared decoded representations |

`startupFiles` is a host declaration, **not a measured network trace**. Every named file must exist. Include all actual startup dependencies, including shell/runtime scripts and delivery manifests. A smaller declared list cannot establish runtime deferred loading. Decoded size is not runtime heap, GPU memory, ZIP size or a storefront acceptance result. Gzip identity and decode limits continue to use `web-delivery.json` validation. Budget failures stop build/preview/delivery; old artifacts without budgets retain their previous behavior.

## Immutable local handoff

```powershell
node fwb/bin/fwb.mjs deliver --project D:/Games/MyGame --artifact <build_id> --destination output/web --zip
```

`--destination` selects a parent directory. Delivery creates `<parent>/<build_id>/game`, `evidence`, and `delivery.json`; `--zip` adds a deflated ZIP. `--no-latest` omits the atomic `<parent>/latest.json` update. Existing artifact-ID deliveries are never overwritten. Failed work remains in a uniquely named `.partial` directory with `failure.json`; it does not replace `latest.json`. A per-artifact delivery lock prevents competing writers and is released after ordinary failure.

The operation revalidates the artifact, copies only recorded outputs, checks copied hashes, preserves package/runtime/platform states, copies available toolchain/log/resource/acceptance evidence, and records archive hashes. It never uploads or publishes; `published` is always false. Runtime/platform states are not upgraded by local packaging.

ZIP writing streams level-9 deflate, CRC and SHA-256 and does not buffer all payloads. It supports fewer than 60001 entries and less than 4 GiB within ZIP32 constraints; larger packages use directory delivery. The older workbench `packageArtifact()` Buffer/download API also uses level-9 deflate and retains its 256 MiB input guard. That guard is an implementation memory limit, not a TapTap rule.

For `taptap-h5`, both ZIP entry points wrap all output files inside a single `game/` directory, require `game/index.html`, and reject compressed ZIPs larger than 300 MiB (314,572,800 bytes). Other targets keep their existing archive-root layout. Directory delivery and preview still serve `<delivery>/game/index.html`. The streaming receipt records archive layout, entry, compression level and compressed-size limit. Evidence and delivery receipts remain outside the upload ZIP.

This H5 rule was verified on 2026-10-09 against the current public developer-center H5 management [page bundle](https://assets.tapimg.com/developer-center-v2/static/js/4927.1854b5ee.js) and [upload component](https://assets.tapimg.com/developer-center-v2/static/js/8770.fc38089e.js), loaded by the `h5-package-manage` route. The component checks the selected ZIP's `size / 1024 / 1024 > 300`; its instructions require one enclosing directory containing `index.html`. The [official H5 MCP uploader](https://github.com/taptap/instant-games-open-mcp/blob/12ce13c382c27275e9c42f7943de2eff92a32d24/src/features/h5Game/handlers.ts#L236-L284) likewise preserves the source directory as the archive prefix. This is an observed H5 upload-front-end check, not a documented decompressed-size budget or a guarantee of server parsing, device compatibility, or review acceptance. Recheck the current console if the service changes; do not substitute ordinary Tap mini-game size rules.

### Host delivery validation

`targets.<id>.deliveryValidationScript` is an optional project-relative `.mjs`. Preflight verifies it enters the snapshot; the artifact records its frozen SHA-256 and a separate index of the prepared snapshot input files (using the same reserved-directory and project-exclusion rules as source collection). Delivery verifies that index, dependencies and input file set before invoking the snapshot script with:

```text
--project <artifact/project> --output <delivery/game>
--target <id> --profile <profile> --report <delivery/evidence/host-validation.json>
```

The script must return exit code 0 **and** write a report such as:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "checks": [{ "id": "host-package-policy", "status": "pass", "message": "Checked actual package contents." }]
}
```

Missing/empty reports, `ok:false`, non-pass checks, changed scripts/dependencies, and any output file-set/hash mutation fail before ZIP and latest promotion. The report, log and frozen input index become delivery evidence. The hook must use declared snapshot inputs and the delivered output, not mutable caches or external files. It is trusted host build code, not a sandbox or an independent security certification. Gameplay-specific audits belong here instead of inside FWB. Existing finalizers remain available and do not execute publication.

## Browser previews

`startPreview(root, artifactId, {port})` and `startDeliveryPreview(gameDirectory, {port})` serve recorded files over loopback HTTP. Delivery previews validate the receipt, complete file set and hashes. Both revalidate GET/HEAD content on every request and send the same verified bytes, including byte ranges. MP4/WebM, audio, WebP and font MIME types are supported; valid ranges return 206, unsatisfiable/multiple ranges return 416, and HEAD describes the entire file. Changed or missing output returns 409. Unknown `If-Range` falls back to a complete response.

These are local runtime tools. They do not claim mobile browser, TapTap App, device or platform acceptance. Continue to bind runtime and platform reports separately to the final artifact output fingerprint.
