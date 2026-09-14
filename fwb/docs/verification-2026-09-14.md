# 2026-09-14 本地验证

主机 Windows；Node.js 24.14.1；标准版 Godot 4.6.2。测试依赖本机工具链，`.local` 记录不会进入源码版本。

## 实际导出与运行

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 中文示例 Web Release | 构建和包检查通过 | `fwb/.local/demo/.local/fwb/artifacts/build_1789327532727_e50dbc5813e84883b8ec0002654923db/` |
| 示例浏览器运行 | 中文显示、收集交互、JSON 配置、刷新存档恢复通过；所查控制台无 error/warn | `fwb/.local/reports/web-runtime-20260914.json` |
| 示例 Poki Release | 构建及 SDK 引用检查通过；平台运行未验收 | `fwb/.local/demo/.local/fwb/artifacts/build_1789327561024_3d21788262084196af4e67fb50d7f7e6/` |
| FWE 工作台 → Web Debug | 在实际界面触发构建成功，7 个输出文件约 36.17 MB；上传计划返回 handoff、canExecute=false | `fwb/.local/demo/.local/fwb/artifacts/build_1789328546337_94bc00adf30e4969944e6588780beb00/` |
| 当前 FWC → FWB Web Release | FWC 生成、校验、config_pack、Godot 导入导出及包验证通过；浏览器未测试 | `fwb/.local/fwc-probe/1789327985579_1053a229/report.json` |
| Android | 预检阻断；独立 Godot 实际导出也退出 1，无 APK | `fwb/.local/android-probe/report.json` |

FWC 探针复制当前框架的 392 个源文件，通过框架自身 `new.ps1` 创建纯 GD 宿主。构建日志包含 `fw check passed`，148 字节 `pack/config/game.bin` 已进入最终 PCK。原 FWC 与新宿主源码指纹前后一致，宿主未产生 `.godot`。可用 `tools/test-fwc.mjs` 在新隔离目录复现。

Android 明确缺少模板、SDK platform-tools、Build Tools、SDK Platform 与 JDK；没有安装许可证、改系统环境或产生可交付安装包。iOS、三个小游戏运行环境、Poki Inspector、广告展示、签名、上传和商店审核均未在本轮完成。浏览器音频、移动设备、前后台压力测试也不列为已通过。

## 回归范围

自动化覆盖配置并发写入、路径/快照排除、失败记录与锁释放、包哈希篡改、原生归档结构、预览隔离、FWE 命令合同、工具链和平台预检、上传计划/回执、SDK 失败与广告资格。平台 CLI 用隔离测试替身验证执行合同，未联系真实账户；这些测试不代表平台接纳。

最终 FWB 86/86、FW 22/22 测试通过。FW 的 `build --no-open` 实际启动工作台成功，默认 `start.bat fwb --check` 通过。Windows/Linux 框架 CI 已配置，未执行远程 CI。

最终审查还修复了默认 preset 解析不一致、Android 自定义 Gradle 目录越过隔离边界的问题。回归覆盖真实 Windows 目录联接、绝对路径、目录穿越和源码 preset 不变；省略 Web preset 的完整示例重新实际导出通过。

早期 Web 导出暴露缺少移动纹理导入设置，已在隔离工程同时启用对应压缩导入并重新导出通过；保留失败记录以便追查。工作区没有提交、推送或远程发布。
