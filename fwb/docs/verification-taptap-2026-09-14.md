# TapTap 单一路线验证 · 2026-09-14

FWB 仅维护 TapTap H5，内部 ID 保留 `taptap-h5`，界面名称为“TapTap（App 内即玩）”。平台目录和初始化配置共 7 个目标。本地示例已移除普通小游戏目标，原有 H5 配置及历史产物保持可用。

旧 `taptap-minigame` 配置只有显式 `enabled: false` 时可保留；否则提示 `retired-target`，要求停用并按 H5 路线重新构建。旧普通小游戏产物和日志可读取，但不能继续构建、校验或上传，也不会自动转换包。

## 本次检查

- `npm test`（`fwb/`）：93 项通过，0 失败。
- `node --test fw/test/build.test.mjs`：2 项通过，0 失败。
- `node fw/tools/start.mjs fwb --check`：通过，成功读取本地示例。
- 工作台实际显示 7 个平台选项，TapTap 只有一个；选中后显示 App 内运行的验收要求。
- 从工作台执行 TapTap 环境检查及 Release 构建成功。

## 实际候选包

- 工程：`fwb/.local/demo`。
- 构建 ID：`build_1789395695557_15a3405d20004ebe95d1357dad8e5d7a`。
- 目标/配置：`taptap-h5` / `release`。
- 引擎：Godot `4.6.2.stable.official.71f334935`。
- 输出：7 个文件，共 38,148,375 字节。
- 包体校验：`passed`。
- 运行/平台验收：均为 `not-tested`。
- 上传状态：`not-uploaded`。

构建清单位于该工程的 `.local/fwb/artifacts/<构建 ID>/manifest.json`，日志为同目录的 `build.log`。

本次验证证明构建路线收敛和本地候选包生成正常。手机 TapTap App 内的启动、触控、音频、存档、前后台与按需使用的平台 API 仍需真机验收；没有执行平台上传、提审或发布。
