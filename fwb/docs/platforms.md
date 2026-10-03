# 平台目录与构建预检

## 导出端分类

目标同时记录 `technology`（共用资源准备能力）与 `category`（交付方式）。旧 `family` 与目标 ID 保持兼容，不因共用 Web 技术而把小游戏改成浏览器目标。

| 技术 | 分类 | 目标 | 最终交付 |
| --- | --- | --- | --- |
| Web | 静态网页 | `web` | HTML、JS、WASM、资源；可部署到静态 HTTP/HTTPS 托管 |
| Web | H5 平台 | `taptap-h5`、`poki` | 浏览器产物及平台接入；客户端或平台验收独立 |
| Web | 小游戏 | `wechat-minigame`、`douyin-minigame` | 适配器生成的平台专用游戏工程 |
| 原生 | Android | `google-play` | APK / AAB |
| 原生 | iOS | `app-store` | Xcode 工程及后续签名归档 |

资源裁剪、贴图尺寸/质量、字体子集、数据压缩可以共用策略。浏览器 `fetch`、`DecompressionStream`、存档和分包加载器不能据此直接用于微信；引擎 WASM、压缩格式解码及运行接口必须由目标适配器验证。静态网页是完整资源目录，通过 HTTP/HTTPS 打开，不是单个可双击的 HTML 文件。

## 共用资源流水线

工程可用 `resourcePipelines` 声明一次准备脚本。所有 `technology: "web"` 目标在没有单独覆盖时继承名为 `web` 的流水线，包括静态网页、TapTap H5、Poki、微信和抖音：

```json
{
  "resourcePipelines": {
    "web": { "prepareScript": "tools/prepare-web-resources.mjs" }
  },
  "targets": {
    "web": { "enabled": true, "preset": "Web" },
    "taptap-h5": { "enabled": true, "preset": "Web" },
    "wechat-minigame": {
      "enabled": true,
      "preset": "Web",
      "convertScript": "tools/convert-wechat.mjs",
      "sdkPath": "vendor/verified-wechat-adapter"
    }
  }
}
```

这是需合并到完整配置的结构示例，SDK 版本与验证声明仍须按下文补齐；仓库不附带已验证的 Godot 微信适配器。准备脚本必须接受实际 `--target`，不能只允许 `web` 与 `taptap-h5`。旧目标级 `prepareScript` 优先于共享设置；`resourcePipeline: false` 关闭继承，字符串选择已声明的流水线，未知名称报错。原生目标不自动继承，也可以显式选择已兼容的流水线。配置没有 `resourcePipelines` 时保持原行为。

共享脚本只在冻结快照中执行，参数与目标级准备脚本一致，另提供 `FWB_RESOURCE_PIPELINE`（共享名称，目标独立脚本为空）。`manifest.preparation` 记录选择来源、流水线、脚本路径与哈希。通用编排留在 FWB，游戏资源引用关系和压缩实现留在宿主。`finalizeScript` 保持目标专用，不自动跨浏览器和小游戏继承，避免直接复用不兼容的加载器。

工作台的「工程接入 → 共享 Web 资源准备脚本」可设置或清空 `resourcePipelines.web.prepareScript`；清空只移除这个共享定义。平台页可设置或清空单独的 `prepareScript`，并显示按优先级实际生效的脚本。选择共享流水线时如仍有平台覆盖，应先清空覆盖。工程和本机环境草稿分别保存；未保存时检查、构建和补全预设会被明确阻止。

## 宿主的隔离资源准备

目标可显式声明 `targets.<id>.prepareScript`，值为项目内 `.mjs` 相对路径。FWB 完成源码快照后、FWC 准备与 Godot 导入前，用当前 Node 执行快照中的该文件，传入 `--project <stage> --target <id> --profile <profile>`，设置 `FWB_SNAPSHOT_ROOT=<stage>`。未声明时无额外操作；非零退出、超时或取消会终止该次构建。构建 manifest 记录脚本路径及 SHA-256。该脚本属于可信宿主构建代码，与原有 Godot/FWC 脚本具有相同本机执行权限，并非安全沙箱；仅应用于已授权工程，不用于上传或运行不可信平台命令。

可选 `targets.<id>.finalizeScript` 使用同样的项目相对 `.mjs` 路径规则，在 Godot 导出成功后、收集输出与包验证前执行。参数另含 `--output <out>`，环境另含 `FWB_OUTPUT_ROOT=<out>`；stage/out 必须是同一 artifact 内的不同目录，不能是源工程。脚本负责宿主的压缩或分包，不执行发布，失败保留失败 artifact。`manifest.finalization` 记录实际脚本 SHA-256。

Web 产物可以提供 `out/web-delivery.json` 显式采用 gzip：`schemaVersion:1, encoding:"gzip", files:{"index.wasm":descriptor,"index.pck":descriptor}, packs:{id:descriptor}`。descriptor 为 `{url,compressedBytes,bytes,sha256,gzipSha256}`，URL 是输出目录内的相对 `.gz` 路径；`bytes/sha256` 对应解压内容。验证器要求 HTML/JS、逐一核对压缩和解压身份、引擎/PCK 文件头、256 MiB 单文件与 1 GiB 解压总界，并拒绝重复原始引擎文件。无 manifest 时沿用原始 Web 产物合同。宿主负责相应浏览器加载器与运行验收；压缩通过不代表分包运行或平台接入通过。

宿主负责资源压缩、原件校验和内容裁剪，FWB 只负责隔离生命周期与失败传播。只允许项目相对路径，拒绝缺失文件、路径穿越、链接和直接对源根执行。目标 `maxBytes` 仍检查完整原始导出文件大小，与平台服务端限制、ZIP 大小和运行性能是不同结论。

核对日期：2026-09-14。

FWB 将工具链检查、构建成功、运行验收和平台发布分开记录。`doctor.ok=true` 仅表示当前预检没有发现阻止构建的条件，不能证明游戏已经运行、签名正确、平台接纳或审核通过。

## 当前路线

| 目标 ID | 产物入口 | 目录状态 | 首版限制 |
| --- | --- | --- | --- |
| `web` | 静态网页，Godot Web 导出 | supported | 标准版 Godot、GDScript、Compatibility、单线程模板；浏览器验收另行执行 |
| `poki` | Web + Poki 运行时桥接 | experimental | 单线程；需接入 SDK、实际 Inspector 和发行验收 |
| `taptap-h5` | TapTap（App 内即玩）的 H5 候选包 | experimental | 单线程；包接受度和手机 TapTap App 内运行仍需验证，所需平台 API 另行接入 |
| `wechat-minigame` | Web → `convertScript` → 微信工程，或自有 SDK / preset | unverified | 必须有版本匹配的适配器与证据；不能把普通 Web 导出包当小游戏包 |
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

根级 `timeoutSeconds` 可设为 10..3600，限制每个构建命令的执行时间，未声明时为 600 秒。FWC 准备阶段还使用其脚本自有的 Godot 导入超时：未声明时保持 180 秒；显式配置时通过 `-GodotImportTimeoutSeconds` / `--godot-import-timeout-seconds` 传入同一值，最多 1800 秒。外层命令预算仍包括生成与打包，内层预算不会延长外层期限。大量素材的冷导入可显式设置 1200 或 1800 秒；超时失败仍保留构建证据，不修改 FWC 的默认值。

工具链解析顺序：目标 `godot` 字段覆盖根级 `godot` 字段，再继承 FWB 本机环境；未指定可执行文件时使用 `GODOT_BIN`，最后尝试 PATH 中的 `godot`。`godot.version` 是要求的实际引擎版本；FWB 会执行 `--version` 核对。仅修改版本字段不代表迁移完成。

FWC 文档中的 Godot 版本记录为 `inspection.fwc.baselineGodotVersion`，表示框架回归基线。实际引擎与该基线不同，只有工程或目标的 `godot.version` 明确固定了与实际匹配的稳定版时，才开放 `experimental` 构建并保留 `fwc-godot-version` 警告；缺少这一宿主声明仍阻断。FWB 本机环境的版本设置不能代替宿主声明，实际引擎与显式版本不匹配及预发布引擎也不能通过。此规则不修改 FWC 的版本声明，也不自动产生运行验收证据；必须验证当前导出包的配置、交互和持久化后才登记结果。

未指定 `templatesPath` 时，预检按照实际 Godot 版本查找当前用户的标准模板目录，并检查已知的便携编辑器 `editor_data/export_templates` 路径。Godot 的 .NET 模板版本目录保留 `.mono` 后缀。显式模板目录包含 `version.txt` 时必须匹配；缺少版本标记会产生警告。

Web 模板依据 preset 的线程和扩展开关选择，例如 `web_nothreads_debug.zip` 或 `web_dlink_nothreads_release.zip`。preset 自有的 `custom_template/debug`、`custom_template/release` 优先，支持 `res://` 路径。`doctor` 返回解析后的 `templates.debug`、`templates.release` 和 `engine.templatesPath`，供构建执行器使用。

实际使用的模板若位于工程内，必须进入源码快照；构建预设与工具链指纹均改用快照路径。位于标准安装目录等工程外的模板继续使用已检查的外部路径。预检要求目标已在 `targets` 中声明；省略 `enabled` 仍视为启用，缺少目标配置不视为启用。

`preset` 必须在真实 `export_presets.cfg` 中唯一存在，且平台类型与目标一致。FWB 不会通过检查时自动修改原工程的导出 preset。普通目标的类型固定为 Web、Android 或 iOS；`exportPlatform` 只用于声明小游戏自有导出器的实际平台类型。

## 小游戏适配的开放条件

### 微信的显式转换步骤

微信新增 `targets.wechat-minigame.convertScript`（工程内 `.mjs` 相对路径）：

```text
源码快照 → 共用资源准备 → FWC 生成/配置打包 → Godot Web 导入/导出
         → web/ 中间产物 → 微信转换脚本 → out/ 微信工程 → 目标后处理 → 包检查
```

选择该路线时 `preset` 缺省为 `Web`，实际平台必须为 Web；`exportPlatform` 省略或设为 `Web`。工作台可以补全基础 Web 预设，但这一步不安装微信适配器。`sdkPath` 必须是工程内真实相对目录，保证 SDK 随源码冻结；相关文件不能被 `exclude` 排除。已有不声明 `convertScript` 的专用小游戏 preset 路线保持原调用方式。

新建工程不为小游戏写入固定预设名，由上述路线解析默认值；已保存的显式 `preset` 不会自动覆写。旧工程从专用预设切换到转换路线时，请选择实际 Web 预设，或清空 `preset` 以使用路线默认值。

FWB 用当前 Node 调用冻结的脚本：

```text
node <snapshot/convertScript> --project <project/> --input <web/> --output <out/>
     --target wechat-minigame --profile release
```

脚本环境包含 `FWB_SNAPSHOT_ROOT`、`FWB_WEB_INPUT_ROOT`、`FWB_OUTPUT_ROOT`。三个目录必须属于同一正在构建的 artifact；输出初始为空。适配器只能复制后修改输入，不能原地改写 `web/`；FWB 会核对转换前后全部输入哈希。非零退出、取消、超时和空输出使构建失败，失败记录保留。转换脚本与 SDK 属于授权工程的构建代码，不是执行不可信代码的沙箱。

转换脚本负责调用实际 SDK、匹配或替换微信兼容的引擎文件、产生启动代码与所需 API 适配，并写入项目配置。FWB 不通过通用字符串替换假造 Godot 引擎兼容性。`manifest.conversion` 保存脚本哈希和 Web 输入指纹；中间 `web/` 不进入最终交付 ZIP，最终入口是 `out/game.js`。

最终微信目录必须包含非空 `game.js`、对象形式的 `game.json`，以及 `compileType: "game"`、真实 AppID 的 `project.config.json`。配置了目标 `applicationId` 时必须一致；`miniprogramRoot` 省略或为当前目录。旧自有 preset 也必须生成这些可校验的工程文件；只交付一个不可检查的 `game.zip` 不满足小游戏合同。

`finalizeScript` 如用于微信，处理的是转换后的 `out/`，必须与微信加载器一致。不要直接复制浏览器的 WASM gzip/分包后处理。包结构检查不执行微信开发者工具，不把 `runtime` 或 `platform` 从 `not-tested` 升级为通过。

### 适配器证据

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
