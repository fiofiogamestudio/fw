# FWB Godot 平台运行时

FWB 的可选运行时是普通 Godot 4.6.2 GDScript addon，不依赖 FWC、Node.js 或构建凭据。源位于 `runtime/addons/fwb`；构建时复制到隔离工程的 `addons/fwb`。演示工程引用这个路径，不再保存一份 addon 副本。直接打开原始演示工程会缺少 autoload，应先执行 FWB 构建后打开产物对应的隔离工程。

游戏的 `project.godot` 登记：

```ini
[autoload]
FwbPlatform="*res://addons/fwb/platform.gd"
```

构建器写入 `res://fwb.runtime.json`，例如 `{"platform":"poki"}`。可选 `sdk.mock: true` 只用于确认模拟状态，所有广告均返回 `unavailable` 且 `simulated: true`，不提供成功广告 mock。未配置平台时使用 `web`；其他未接入的渠道明确返回 SDK 不可用。

## 接口和职责

```gdscript
var state: Dictionary = await FwbPlatform.initialize()
FwbPlatform.loading_complete()
FwbPlatform.gameplay_start()
FwbPlatform.gameplay_stop()

# 游戏先暂停输入与声音，再请求广告；结果返回后按自己的状态恢复。
var result: Dictionary = await FwbPlatform.request_rewarded_ad()
if result.status == "success" and result.reward_eligible and not result.simulated:
    grant_reward_once() # 游戏负责规则、事务与去重
```

- `capabilities()` 返回平台、SDK 状态/说明、生命周期和广告能力，以及是否模拟。SDK 初始化成功仅说明接入可用，不等于广告或发行已验收。
- `initialize()` 可重复调用，未装 SDK、初始化失败或超时不会阻止游戏继续加载。
- 加载完成事件和玩法开始/停止事件防止重复上报；在 SDK 初始化前记录的状态会在成功后补送。
- `lifecycle_changed` 提供 `background`、`foreground`、`ad_started`。运行时报告事件，游戏决定暂停、输入、音频及恢复时机。
- `request_rewarded_ad()` 和 `request_commercial_ad()` 总是异步。统一结果为 `success / cancelled / unavailable / error`，附 `kind`、`message`、`reward_eligible`、`simulated`、`platform`；桥接请求另有 `request_id`。
- 激励广告仅在官方 SDK Promise 返回布尔值 `true` 时拥有奖励资格；`false` 或未返回布尔值时为 `cancelled`。SDK 没有区分取消、未展示或无填充时，FWB 不推断具体原因。
- 普通广告的 `success` 仅表示广告机会流程已结束，不能证明广告实际展示，永远不产生奖励资格。
- 同时只能有一个广告请求；第二个返回 `error/busy`。初始化超时 10 秒，广告请求超时 120 秒。超时后的晚到结果不再发放资格；超时不能取消 SDK，直到原请求实际结束前不允许再次调用广告 SDK。

## Poki 装配

仅 `poki` 构建在 HTML 入口加载以下脚本，先于 Godot 引擎启动：

```html
<script src="https://game-cdn.poki.com/scripts/v2/poki-sdk.js"></script>
<script src="fwb-poki.js"></script>
```

第二个文件来自 `runtime/web/fwb-poki.js`。通过 Godot `JavaScriptBridge` 传输 JSON 事件，不依赖旧版 Godot Poki 插件。官方脚本不存在、被拦截、初始化失败时，游戏继续可玩，广告返回不可用或错误，不安装伪造 SDK。桥接层采用官方 [HTML5 SDK](https://developers.poki.com/guide/sdk-html5) 的 `init`、`gameLoadingFinished`、`gameplayStart`、`gameplayStop`、`rewardedBreak` 和 `commercialBreak`（2026-09-14 核查）；事件时机以 [SDK overview](https://developers.poki.com/guide/sdk-overview) 为依据。

本地测试能验证桥接逻辑和失败回退，真实 SDK、广告展示与奖励必须另经 Poki Inspector/平台环境确认。微信、抖音、TapTap 不会复用 Poki API，也没有虚构 SDK 实现。安全区域、登录、分享和分包仍待各渠道接入。

## TapTap（App 内即玩）

TapTap 仅维护 H5 路线，内部平台值为 `taptap-h5`，与 Web、Poki 共用 Godot Web 导出流程。普通小游戏目标 `taptap-minigame` 已停止维护，不再提供其引擎运行环境适配；旧配置需停用该目标并按 H5 路线配置，详情见 [平台说明](platforms.md#taptap-路线与旧配置)。

当前 addon 尚未实现 TapTap 广告、云存档、排行榜等 API，启用 `runtimeAddon` 不会使这些能力自动可用。平台功能应集中在渠道桥接中按需接入，游戏继续使用统一接口；需要新增的统一接口也须随实际接入实现和验证。

交付验收要求是在手机 TapTap App 内启动、加载资源并完成触摸、音频、存档及前后台检查，以及已接入平台能力的检查。普通浏览器中的 Web 候选包验证不能替代这一步，当前尚无 TapTap 客户端通过记录。

## 演示工程与验证

`examples/demo` 是中文“星港补给站”：每次触摸/点击收集 1 能量，达到配置 `data/game.json` 中的 12 能量完成一次补给。包含暂停/继续、合成短音效、本机存档恢复、渠道状态和自愿激励广告入口。未获得真实奖励资格时计数保持不变。界面使用约 100 KB 的 Noto Sans SC 字体子集，使浏览器也能显示中文；字体遵循随包 `assets/OFL.txt`，来源为 [Google Fonts Noto Sans SC](https://github.com/google/fonts/tree/main/ofl/notosanssc)。字体子集仅覆盖当前 UI，用于新增文本时需重新生成或换用完整字体。

存档为 `user://progress.json`，应用目录名 `fwb-demo`；浏览器存档作用域依赖站点 origin。测试或预览地址端口改变时，浏览器可能使用不同存档。失败或无法持久化时界面明确说明。导出 preset 包含配置 JSON，并排除测试脚本、FWB 工程配置和文档；构建工具与凭据不属于运行时。

验证入口：

```text
node --test test/runtime-bridge.test.mjs
godot --headless --editor --path <assembled-stage> --import
godot --headless --path <assembled-stage> --script res://tests/runtime_smoke.gd
```

Godot 冒烟验证配置读取、14 次收集后的补给结算、广告不可用不发奖励、销毁重建场景后恢复存档，并输出 `FWB_RUNTIME_SMOKE_OK`。它会重置演示存档，勿对游戏正式存档使用该测试。浏览器另检查中文布局、输入、音频、刷新恢复与前后台；使用导出后的真实包，不以编辑器运行替代。演示输出 `FWB_DEMO_READY`、`FWB_DEMO_STATE`、`FWB_AD_RESULT` 控制台证据，不包含凭据。
