# FWB

FWB 是 FW 家族的 Godot 构建与发行工作台。一个工程配置管理渠道、版本和工具链，通过 FWE 界面或命令行完成预检、隔离构建、产物检查、预览及上传计划。

当前版本 **0.1.0** 已跑通真实 Godot Web Release 和纯 GD 的 FWC → FWB 构建链；Poki 候选包可导出。六个平台全部发布成功仍是后续验收目标，不能由本地构建成功推定。

## 启动

需要 Node.js 22+，CLI 无第三方 npm 依赖。界面使用同级 `fwe/`。

```powershell
# 在 FW 工作区根目录执行；首次启动复制示例到 fwb/.local/demo
.\start.bat fwb

# 指定已经接入 FWB 的游戏
.\fwb\start.bat --project D:\Games\MyGame
```

现有 Godot 工程先初始化，再在 `fwb.project.json` 中填写引擎、模板目录与已有导出 preset：

```powershell
node fwb/bin/fwb.mjs init --project D:/Games/MyGame --godot D:/Tools/Godot/godot.exe --godot-version 4.6.2
node fwb/bin/fwb.mjs doctor --project D:/Games/MyGame --target web --profile release
node fwb/bin/fwb.mjs build --project D:/Games/MyGame --target web --profile release
node fwb/bin/fwb.mjs artifacts --project D:/Games/MyGame
node fwb/bin/fwb.mjs preview --project D:/Games/MyGame --artifact <build_id>
```

Web 使用标准版 Godot、GDScript、Compatibility 和对应的单线程模板。Godot .NET 编辑器本身也不能完成这里的 Web 导出；FWB 会预先指出这个问题。`init` 不生成或覆盖已有 `export_presets.cfg`，可参考 `examples/demo/export_presets.cfg`。

工作台现在包含「工程接入」「本机环境」「平台设置」「构建」「验收与上传」。可在页面选择已有 Godot 工程、首次创建 FWB 配置、补全缺失的 Web/Android/iOS 基础预设，并编辑版本、包名、平台 SDK、工具路径及签名凭据引用。

本机环境保存于 `~/.fwb/environment.json`（可用 `FWB_HOME` 指定目录），优先级为平台覆盖 → 工程覆盖 → 本机环境 → 系统环境。空的工程 `godot: {}` 继承共享设置；已有工程的显式路径仍优先。保存后无需重启；重新检查当前平台和 debug/release 配置即可。配置变化会使旧检查失效。路径浏览只显示目录和文件名。

构建页提供阶段与滚动日志、取消、顺序批量构建、产物目录、交付 ZIP（不超过 256 MiB）和预览；大包使用产物目录交付。批量构建逐个平台预检，缺少条件的目标会被跳过并列出原因。Android 导出使用本次构建专用的自包含 Godot 与编辑器设置，应用已检查的 SDK/JDK 路径。debug 写 APK，release 写 Gradle AAB；还需要实际 SDK、JDK、Gradle 模板、证书和设备验收。界面操作与验证记录见 [工作台复查](docs/verification-workbench-2026-09-15.md)。

## 当前能力

| 路线 | 已实现 | 仍需验收或接入 |
| --- | --- | --- |
| Web 基线 | 预检、隔离导入/导出、预览、哈希校验；真实浏览器交互及刷新存档通过 | 游戏各自的性能、移动浏览器、音频和长时间运行 |
| Poki | Web 包、SDK 生命周期/广告桥接、官方 CLI 上传计划与执行接口 | 平台账户、Inspector、真实广告和发行接纳 |
| TapTap（App 内即玩） | 仅维护 H5 路线，复用 Godot Web 构建生成候选包 | 手机 TapTap App 内运行验收、所需平台 API 接入和后台交付 |
| 微信小游戏 | 独立目标、版本与适配证据预检；微信官方上传接口 | 引擎运行环境适配、SDK、真机包和平台验收 |
| 抖音小游戏 | 官方路线的保守兼容预检、SDK/preset 验证、官方 CLI 上传接口 | 当前官方 Godot 4.5 路线与 FWC 4.6.2 的兼容验证、真实小游戏导出 |
| Google Play | Android APK/AAB 导出编排、依赖/签名变量预检、包结构检查 | 本机 SDK/JDK/模板、真机与签名验收、Play 轨道上传 |
| App Store | Mac/Xcode 预检、Godot iOS 工程导出、Xcode ZIP 检查 | Mac 执行器、Archive/IPA 签名、真机及 TestFlight/商店上传 |

当前维护 7 个构建目标：Web 基线及上述 6 个发布平台。TapTap 的内部目标 ID 保持 `taptap-h5`，验收要求是玩家在手机 TapTap App 内点开并正常游玩；本地浏览器预览或 Web 包检查通过不代表达成这一要求。广告、云存档等 TapTap API 仍需按游戏需求接入，当前未实现。

TapTap 普通小游戏目标 `taptap-minigame` 已退出维护范围，不再维护其引擎适配。旧配置中的该目标必须设为 `enabled: false` 或移除，再按 Web 路线配置 `taptap-h5`；未停用时会明确提示。FWB 不会自动转换普通小游戏包。详见 [TapTap 路线与旧配置](docs/platforms.md#taptap-路线与旧配置)。

`supported` 是导出路线的静态标签。界面和报告分别显示包检查、运行验收、平台验收；没有填写验收证据时维持 `not-tested`。微信和抖音小游戏适配器不能用普通 Web 包代替，缺少已验证 SDK 时构建会停止。

上传默认只检查条件。「验收与上传」页可登记报告、核对应用与版本后确认上传开发版本、查看上传记录并登记人工对账结果；CLI 仍支持 `upload --execute`。只有已配置的微信、抖音、Poki 官方工具接口可以执行，且要求绑定产物的运行/平台验收报告。Google Play、App Store 和 TapTap 当前提供人工交接说明。FWB 不自动提审或上线。详见 [上传与回执](docs/publishing.md)。

## 构建合同

```text
游戏配置 → 平台预检 → 源码快照 → FWC 自有生成/配置打包（若存在）
         → 装配运行时 → Godot 导入/导出 → 产物验证 → 预览/验收 → 上传计划
```

每次构建保存在游戏的 `.local/fwb/artifacts/<build_id>/`：

- `manifest.json`：源码文件指纹、Git 版本（可取得时）、目标、构建状态、产物哈希和分层验收结果。
- `toolchain.json`：实际引擎、Windows console 配套引擎、模板和 FWB 源码指纹。
- `project/`：隔离工程；生成器与 Godot 只在这里工作。
- `out/`、`build.log`、`evidence/`：交付文件、构建过程和后续人工验收报告。

构建不会修改宿主的生成输出、导出 preset 或 `.godot` 缓存。首次接入与显式保存会修改 `fwb.project.json`；「补全缺失导出预设」只追加缺失项，保留现有预设。每个工程一次只运行一个构建，失败或取消保留记录。异常断电后若锁残留，先核实锁内进程已经退出，再处理这一份 `build.lock`。

默认快照排除 `.git`、`.godot`、`.local`、依赖缓存、`bin`/`obj`、根目录 `dist`/`build`、常见密钥文件及环境文件。游戏资源不要放在这些保留目录。额外排除项使用 `exclude` 的相对精确路径或目录，不支持 glob。外部链接目录需要先变成工程内真实依赖；FWB 不遍历符号链接/目录联接。大于 4 MiB 的 JSON 清单和 ZIP64 原生包当前会被明确拒绝。

锁文件是工具链实况记录，尚不提供自动安装和历史工具链恢复，也不承诺 Godot 导出文件逐字节可复现。

## 验证和后续工作

```powershell
cd fwb
npm test
node tools/test-fwc.mjs --help
```

验收实际包后可保存证据：

```powershell
node fwb/bin/fwb.mjs evidence --project D:/Games/MyGame --artifact <build_id> --kind runtime --result passed --file D:/Reports/runtime.json
node fwb/bin/fwb.mjs upload-plan --project D:/Games/MyGame --artifact <build_id> --channel development
```

`evidence` 是操作者提交的验收声明与报告副本，不会自动执行浏览器/真机测试，也不把运行验收升级为平台验收。

已配置 Windows/Linux 的框架回归 CI，尚未远程运行。下一阶段需完成 TapTap H5 候选包在手机 TapTap App 内的运行验收、建立 Android 工具链与设备验证，并以一个实际游戏完成 Poki Inspector 闭环；微信和抖音分别验证运行时适配。Mac 执行器、游戏导出 CI 矩阵、工具链安装、分包/CDN、各渠道登录/分享/支付/隐私接口、Google/Apple 上传及商店元数据管理仍未实现。

更多说明：[平台与配置](docs/platforms.md) · [Godot 运行时与示例](docs/runtime.md) · [上传接口](docs/publishing.md) · [本轮实测记录](docs/verification-2026-09-14.md)。
