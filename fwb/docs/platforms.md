# 平台目录与构建预检

核对日期：2026-09-14。

FWB 将工具链检查、构建成功、运行验收和平台发布分开记录。`doctor.ok=true` 仅表示当前预检没有发现阻止构建的条件，不能证明游戏已经运行、签名正确、平台接纳或审核通过。

## 当前路线

| 目标 ID | 产物入口 | 目录状态 | 首版限制 |
| --- | --- | --- | --- |
| `web` | Godot Web 导出 | supported | 标准版 Godot、GDScript、Compatibility、单线程模板；浏览器验收另行执行 |
| `poki` | Web + Poki 运行时桥接 | experimental | 单线程；需接入 SDK、实际 Inspector 和发行验收 |
| `taptap-h5` | TapTap（App 内即玩）的 H5 候选包 | experimental | 单线程；包接受度和手机 TapTap App 内运行仍需验证，所需平台 API 另行接入 |
| `wechat-minigame` | 自有适配 SDK / preset | unverified | 默认阻断；不能把普通 Web 导出包当小游戏包 |
| `douyin-minigame` | 官方 SDK / 已验证 preset | experimental | 当前保守限定 Godot 4.5 stable、GDScript、Compatibility、无扩展与线程 |
| `google-play` | Android APK / AAB | supported | 检查 SDK、JDK；正式包要求 Gradle AAB 和签名环境 |
| `app-store` | Godot iOS / Xcode 工程 | supported | 仅在 macOS 检查并运行；归档、签名、上传、TestFlight 另行验收 |

当前维护 7 个目标，包含 Web 基线和 6 个发布平台。TapTap 只维护 H5 一条路线，不再维护普通小游戏引擎适配。

`supported` 表示 FWB 已具备对应原生导出路线的预检，不代表商店认证。返回结果的 `compatibility` 是 `compatible`、`experimental` 或 `blocked`，与上表静态目录状态独立。C# 原生移动导出和含扩展的 Web 构建按实验兼容返回。

## TapTap 路线与旧配置

界面统一显示“TapTap（App 内即玩）”，内部目标 ID 保持 `taptap-h5`。H5 是接入技术，交付要求是玩家在手机 TapTap App 内点开并正常游玩。FWB 复用 Godot Web 导出流程生成候选包；本地浏览器正常运行、包结构通过或 Poki 验收通过，都不能替代 TapTap 客户端验收。广告、云存档、排行榜等功能仍需按需接入 TapTap API，当前运行时尚未实现这些接口。

旧配置如果包含 `taptap-minigame`，应移除该目标或明确设为 `enabled: false`。未停用时，FWB 会以 `retired-target` 明确提示停用并改用 `taptap-h5`。例如：

```json
{
  "targets": {
    "taptap-h5": { "enabled": true, "preset": "Web" },
    "taptap-minigame": { "enabled": false }
  }
}
```

这里的 `Web` 必须是工程中经过配置的 Godot Web preset；不能把原普通小游戏 preset 直接改名后视为完成迁移。FWB 不自动转换普通小游戏包。已有普通小游戏产物仍可作为历史记录读取，但不再提供校验或上传。

## 配置

配置文件使用 `fwb.project.json`。最小目标配置：

```json
{
  "schemaVersion": 1,
  "name": "My Game",
  "version": "0.1.0",
  "buildNumber": 1,
  "godot": {
    "executable": "D:/Tools/Godot/Godot_v4.6.2-stable_win64.exe",
    "version": "4.6.2",
    "templatesPath": "D:/Tools/Godot/templates/4.6.2.stable"
  },
  "runtimeAddon": true,
  "targets": {
    "web": { "enabled": true, "preset": "Web" },
    "poki": { "enabled": true, "preset": "Web" },
    "taptap-h5": { "enabled": true, "preset": "Web" },
    "google-play": {
      "enabled": true,
      "preset": "Android",
      "androidSdkPath": "D:/Tools/Android/Sdk",
      "javaHome": "D:/Tools/JDK17"
    }
  },
  "profiles": {
    "debug": { "release": false },
    "release": { "release": true }
  }
}
```

路径相对于工程根目录，也可以使用绝对路径。`templatesPath` 直接指向已解压并含有模板文件的目录；不要指向压缩包或所有版本的父目录。

工具链解析顺序：目标 `godot` 字段覆盖根级 `godot` 字段，未指定可执行文件时使用 `GODOT_BIN`，最后尝试 PATH 中的 `godot`。`godot.version` 是要求的实际引擎版本；FWB 会执行 `--version` 核对，并与 FWC 的引擎声明交叉检查。仅修改版本字段不代表迁移完成。

未指定 `templatesPath` 时，预检按照实际 Godot 版本查找当前用户的标准模板目录，并检查已知的便携编辑器 `editor_data/export_templates` 路径。Godot 的 .NET 模板版本目录保留 `.mono` 后缀。显式模板目录包含 `version.txt` 时必须匹配；缺少版本标记会产生警告。

Web 模板依据 preset 的线程和扩展开关选择，例如 `web_nothreads_debug.zip` 或 `web_dlink_nothreads_release.zip`。preset 自有的 `custom_template/debug`、`custom_template/release` 优先，支持 `res://` 路径。`doctor` 返回解析后的 `templates.debug`、`templates.release` 和 `engine.templatesPath`，供构建执行器使用。

`preset` 必须在真实 `export_presets.cfg` 中唯一存在，且平台类型与目标一致。FWB 不会通过检查时自动修改原工程的导出 preset。普通目标的类型固定为 Web、Android 或 iOS；`exportPlatform` 只用于声明小游戏自有导出器的实际平台类型。

## 小游戏适配的开放条件

微信和抖音要求本地 SDK、经过审查的导出 preset、版本绑定的证据。以下配置只是证据字段格式，不是可直接使用的 SDK：

```json
{
  "enabled": true,
  "preset": "My Verified WeChat Export",
  "exportPlatform": "Web",
  "sdkPath": "addons/my_verified_wechat_adapter",
  "sdkVersion": "1.2.3",
  "validation": {
    "status": "verified",
    "evidence": "docs/platform-tests/wechat-1.2.3.md",
    "godotVersion": "4.6.2",
    "sdkVersion": "1.2.3"
  }
}
```

证据文件必须存在且非空，所列 Godot 版本必须与本次运行引擎匹配，SDK 版本必须与目标配置一致。证据是维护者的人工验收声明，FWB 不会把文件存在误称为自动完成了真机测试。

证据应包含 SDK 来源与版本、导出器调用方法、目标平台、设备和日期、启动与资源加载、触摸、音频、存档、前后台和已接入的平台能力。若 SDK 复用 Web preset，它必须已实际完成平台转换；必须检查最终小游戏工程结构，单纯导出 HTML 不满足该条件。

验证通过只开放实验构建。自有 SDK 与证据不会解除当前引擎已知硬限制：例如抖音不支持 C#、GDExtension 和线程，当前官方页面仅列 Godot 4.5。

Poki 可启用根级 `runtimeAddon: true` 使用 FWB 运行时桥接；也可配置并接入自己的 `sdkPath`。预检保留平台验收警告。TapTap（App 内即玩）复用 Web 导出生成 H5 候选包，平台接受度和真实客户端验收始终另列；启用 `runtimeAddon` 不会自动接入 TapTap API。

## Android 与 iOS

Android SDK 目录按目标 `androidSdkPath`、`ANDROID_HOME`、`ANDROID_SDK_ROOT` 查找，Windows 还会检查常规 `%LOCALAPPDATA%/Android/Sdk`。预检确认 adb、至少一套 Build Tools 的 aapt2，以及已安装 SDK Platform 的 android.jar。它没有把“存在一套 SDK”当成满足所有 Godot 版本和商店要求；实际导出仍会校验 preset 指定版本。

JDK 按目标 `javaHome`、`JAVA_HOME` 或 PATH 中的 `javac` 探测，要求主版本至少 17。用户仍须在 Godot 的 Editor Settings 中设置对应 Java SDK 和 Android SDK 路径，预检不会改写全局编辑器配置。

`release` 配置的 Google Play 目标还要求：

- preset 的 `gradle_build/use_gradle_build=true` 和 `gradle_build/export_format=1`（AAB）。
- 工程已安装 Android Gradle 构建模板，默认存在 `android/build/build.gradle` 或 `build.gradle.kts`。自定义 `gradle_build/gradle_build_directory` 必须是安全的工程内相对路径或 `res://` 路径，检查跟随该目录；绝对路径、目录穿越和目录联接会阻断。Gradle 路线不要求其不会使用的 APK 导出模板。
- 当前进程提供 `GODOT_ANDROID_KEYSTORE_RELEASE_PATH`、`GODOT_ANDROID_KEYSTORE_RELEASE_USER`、`GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD`，并且证书文件可访问。

FWB 只检查签名变量是否存在，不输出值，不打开 `.godot/export_credentials.cfg`，不读取私钥内容。证书有效性、签名是否成功、Play 处理和测试轨道状态由后续步骤确认。

iOS 在非 macOS 主机直接返回阻断。在 Mac 上检查 `xcodebuild -version` 和 `xcrun --sdk iphoneos --show-sdk-version`。Godot 导出的 Xcode 工程与可上传的签名归档不同；预检不会声称已完成 Archive、TestFlight 或 App Store 发布。

## 程序接口

```js
import { targets, getTarget } from './src/platforms.mjs';
import { doctor } from './src/doctor.mjs';

const report = await doctor(project, { target: 'web', profile: 'debug' });
// { ok, target, profile, checks, engine, platform, templates, compatibility }
// checks: [{ id, status: 'pass' | 'warning' | 'fail', message, action? }]
```

进程探测使用 `shell:false`、隐藏窗口、8 秒限时和 32 KiB 输出上限。报告仅使用所需的版本信息，不回显探测失败时的原始标准输出。`createDoctor` 提供依赖注入用于单元测试；公开 `doctor` 使用真实主机。

## 官方依据

- [Godot Web 导出](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html)：Godot 4 C#、渲染器、线程与扩展条件。
- [Godot 导出模板文件](https://docs.godotengine.org/en/stable/engine_details/development/compiling/introduction_to_the_buildsystem.html)：模板命名及布局。
- [Godot Android 导出](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_android.html)：JDK、SDK、AAB 和签名环境变量。
- [Godot iOS 导出](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_ios.html)：Mac/Xcode 路线。
- [抖音 Godot 接入指引](https://developer.open-douyin.com/docs/resource/zh-CN/mini-game/develop/guide/game-engine/godot/godot-engine-integration-guide)：当前支持的引擎版本和能力范围。
- [微信通用引擎适配](https://developers.weixin.qq.com/minigame/dev/guide/game-engine/common-adaptation.html)：适配入口；不构成当前工程 Godot 兼容证明。
- [TapTap 小游戏形态](https://developer.taptap.cn/minigameapidoc/quick-start/guide/minigames-intro/)与[H5 接入说明](https://developer.taptap.cn/minigameapidoc/quick-start/mcp-guide/mcp-setup/)：FWB 选择维护 H5 路线；平台文档不构成当前 Godot 包的客户端验收证据。
- [Poki Godot 接入](https://developers.poki.com/guide/sdk-godot)与[Inspector](https://developers.poki.com/guide/inspector)：SDK 与平台验收入口。
