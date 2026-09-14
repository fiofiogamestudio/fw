# FWB 工作台补全与复查

本轮修复环境与平台配置缺少操作界面、检查状态误用、Android 检查路径未应用到导出的问题，并补齐工程接入、构建控制、产物交付和验收上传操作。未把本地检查通过当成平台验收通过。

## 已实现

- 工程接入：文件夹浏览、首次创建 FWB 配置、切换工程、最近工程、版本与构建序号编辑。保留已有配置及游戏内容。
- 本机环境：Godot/模板/Android SDK/JDK 表单、当前工具路径识别、文件与目录选择、共享配置保存。平台覆盖、工程覆盖、本机环境、系统环境依次生效。
- 平台设置：开关、预设、包体预算、应用 ID、Bundle ID、Team ID、签名证书与凭据变量引用、适配 SDK 与版本声明、官方上传工具参数。
- 基础预设：只追加缺少的 Web、Android、iOS 预设；小游戏不会生成假的 Web 替代预设。
- 状态修复：停用平台禁止构建；按平台、debug/release、配置代次及本机环境版本匹配检查结果；构建内置预检也用于状态展示。
- 构建控制：实时输出、取消、顺序批量构建；缺少条件的平台列出原因并跳过。页面无状态变化时保留按钮，避免轮询打断操作。
- 产物交付：打开输出目录、校验输出哈希后下载 ZIP、预览；ZIP 限制 256 MiB，大包使用目录交付。
- 验收上传：登记与产物哈希绑定的运行/平台报告，检查报告文件哈希与每类最新结果；查看上传记录、登记人工对账。上传需先核对应用和版本，执行前再次核对配置版本、产物哈希与上传条件。审核和上线仍由平台完成。
- Android：在产物目录复制自包含编辑器并写入专用 EditorSettings；预检解析的 SDK/JDK 路径应用到实际编辑器与进程环境。debug 明确导出 APK，release 使用 Gradle AAB。

## 本轮实测

- FWB 自动回归 104 项，FW 启动集成 2 项。
- 实际页面完成：识别并保存共享环境 → 文件夹浏览 → 导入无 FWB 配置的 Godot 测试工程 → 继承共享工具链 → 保存运行时桥接 → 停用/启用平台 → 补全 Web 预设 → release 构建 → 预览 → 登记运行验收 → 检查上传条件。
- 在 debug 预检后切换 release，页面显示 release 尚未检查；完成 release 构建后正确显示 release 预检结果。
- 测试工程为 `.local/verification/ui-game`，产物 `build_1789414592419_e2c58d21f23a47e79374b7869c52928a`：9 个输出文件，38,161,717 字节，包体检查通过。
- 浏览器显示游戏，连续三次点击能量由 0 变为 3，刷新后恢复为 3。仅登记运行通过，平台保持未验收。
- 导出交付 ZIP 后，用 .NET ZIP 读取器独立读取到全部 9 个输出文件。
- 真正启动 Godot 4.6.2 自包含编辑器，由 EditorPlugin 读取到指定的 SDK/JDK 路径。该验证证明设置链路生效，不代表 Android 包或签名已经通过。
- 真实 Web 构建取消后返回 `Build cancelled.`，保留失败记录，构建锁已释放。
- 在原示例工程通过页面执行全部已启用平台的 release 批量构建：Web、TapTap、Poki 三项构建成功，微信、抖音、Google Play、App Store 四项按实际缺项跳过。批次未标为全部成功，界面分别显示构建条件和验收状态。
- 批量产物：Web `build_1789415318251_2cdbc2761c0d4a1da75e73b3a8958379`；TapTap `build_1789415326372_4985ace61e2942a1b86d427b3032473d`；Poki `build_1789415335343_d39adfb9405645a09dce64ec1dbd3ac5`。三者的包体校验通过，后两者尚未完成平台运行验收。
- 本地详细记录：`.local/verification/workbench-checks.json`、`platform-recheck.json`、`tests.txt`、`settings-probe/game/probe.json`。

## 再次检查后仍需完成

| 平台 | 本机检查结果与剩余工作 |
| --- | --- |
| Web | debug/release 环境通过；本轮 release 包已运行验收 |
| TapTap | H5 候选包构建条件通过；手机 TapTap App 内验收、实际上传未完成 |
| Poki | 构建条件通过；Inspector、真实 SDK/广告和实际上传未完成 |
| 微信 | 缺适配 SDK、真实导出预设及对应版本实测报告；适配器本身仍待接入 |
| 抖音 | 当前工程引擎不符合现有适配约束，且缺 SDK、预设和实测报告；真实适配仍待接入 |
| Google Play | 缺 Android SDK/JDK、相应模板、Gradle 模板和发布签名；未构建 Android 包或验证设备 |
| App Store | 缺 Mac/Xcode、iOS 模板与预设；远程 Mac 执行器、签名归档和 TestFlight 尚未实现 |

各平台登录、分享、支付等完整运行时适配、商店元数据、分包/CDN、自动安装工具链及游戏导出 CI 矩阵仍是后续工作。实际上传/审核/上线本轮均未执行。

## Android 设置依据

Godot 的 Android 导出从 EditorSettings 读取 SDK/JDK，再设置 Gradle 的进程环境。FWB 使用引擎支持的自包含目录来隔离本次编辑器设置。参见 [Godot 4.6 Android 导出实现](https://github.com/godotengine/godot/blob/4.6-stable/platform/android/export/export_plugin.cpp)、[编辑器路径实现](https://github.com/godotengine/godot/blob/4.6-stable/editor/file_system/editor_paths.cpp)、[编辑器设置加载实现](https://github.com/godotengine/godot/blob/4.6-stable/editor/settings/editor_settings.cpp)。
