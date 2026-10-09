# FWB Godot 平台运行时

FWB 的可选运行时是普通 Godot 4.6.2 GDScript addon，不依赖 FWC、Node.js 或构建凭据。源位于 `runtime/addons/fwb`；构建时复制到隔离工程的 `addons/fwb`。演示工程引用这个路径，不保存一份 addon 副本。开发运行可使用 `install-runtime` 安装受管副本；也可打开 FWB 构建的隔离工程。

游戏的 `project.godot` 登记：

```ini
[autoload]
FwbPlatform="*res://addons/fwb/platform.gd"
```

`runtimeAddon: true` 开启装配。可选 `runtime` 配置由构建器写入 `res://fwb.runtime.json`，并补入实际 `platform`。`runtime.sdk.mock: true` 只用于确认模拟状态，所有广告均返回 `unavailable` 且 `simulated: true`，不提供成功广告 mock。未配置平台时使用 `web`；未接入渠道明确返回 SDK 不可用。

```json
{
  "runtimeAddon": true,
  "runtime": {
    "taptap": {
      "enabled": true,
      "cloudSave": false
    }
  }
}
```

TapTap 默认禁用；上例只允许检测容器。广告另外配置公开 `rewardedAdUnitId` / `interstitialAdUnitId`，云存档另外设 `cloudSave: true`。配置不接受密钥。可选 `requestTimeoutMs` 范围 1000–120000；Tap 云请求默认 30 秒，广告默认 120 秒。Poki 保留既有 10 秒初始化、120 秒广告截止时间。

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
- `interruption_changed(paused, reasons)` 报告暂停原因集合；`interruption_state()` 可取得初始快照，`set_pause_reason("manual", true/false)` 供宿主加入自己的原因。焦点、应用挂起、页面隐藏/冻结、广告互不覆盖；广告结束不会解除仍存在的后台或手动暂停。addon 使用 `PROCESS_MODE_ALWAYS`，宿主应暂停自己的 mode/输入，保留平台回调运行。
- `request_rewarded_ad()` 和 `request_commercial_ad()` 总是异步。统一结果为 `success / cancelled / unavailable / error`，附 `kind`、`message`、`reward_eligible`、`simulated`、`platform`；桥接请求另有 `request_id`。
- 激励广告仅在官方 SDK Promise 返回布尔值 `true` 时拥有奖励资格；`false` 或未返回布尔值时为 `cancelled`。SDK 没有区分取消、未展示或无填充时，FWB 不推断具体原因。
- 普通广告的 `success` 仅表示广告机会流程已结束，不能证明广告实际展示，永远不产生奖励资格。
- 同时只能有一个广告请求；第二个返回 `error/busy`。超时后的晚到结果不再发放资格；超时不能取消 SDK，直到原请求实际结束前保留广告暂停原因和请求锁，不允许再次调用广告 SDK。

## 移动 Web 通用层

`runtime/web/fwb-web.js` 在启用 addon 的 Web 构建中统一加载。它报告初始页面隐藏状态、`visibilitychange`、`pagehide/pageshow`、`freeze/resume`；这些事件不再藏在 Poki bridge 内。Godot 侧同时合并引擎的 focus/pause/resume 通知。

FWB 不修改 SceneTree 暂停状态、玩家静音设置或存档内容。宿主收到暂停事件后负责停止自己的输入/模拟，保存音频/视频的原有暂停状态，再在全部原因解除后恢复。FWC 宿主可继续使用已有 FAudio/FDisplay，不需要让 FWB 依赖 FWC。

### 本地持久化状态

宿主保持原来的唯一主档和写入事务。成功完成写入及替换后调用 `report_file_written(path)`：它记录 `file_written`、发出 `storage_changed(result)`，并在 Web 调用 `JavaScriptBridge.force_fs_sync()`。`request_storage_sync()` 可单独请求同步；`storage_status()` 返回当前状态。

状态区分 `unknown`、`file_written`、`sync_requested`。`durability` 始终为 `unknown`：Godot 4.6 的 `force_fs_sync()` 是无完成回调的 void API，`OS.is_userfs_persistent()` 仅作为 `persistent_hint`，不能确认本次写入已进入 IndexedDB。原生 FileAccess 成功也不被包装为断电安全保证。当前不另建 IndexedDB 主档、不复制或迁移宿主存档、不把云同步当成本地落盘成功。

参考：[Godot JavaScriptBridge](https://docs.godotengine.org/en/4.6/classes/class_javascriptbridge.html#class-javascriptbridge-method-force-fs-sync)、[OS 持久化检测](https://docs.godotengine.org/en/4.6/classes/class_os.html#class-os-method-is-userfs-persistent)。

## Poki 装配

仅 `poki` 构建在 HTML 入口加载以下脚本，先于 Godot 引擎启动：

```html
<script src="https://game-cdn.poki.com/scripts/v2/poki-sdk.js"></script>
<script src="fwb-poki.js"></script>
```

第二个文件来自 `runtime/web/fwb-poki.js`。通过 Godot `JavaScriptBridge` 传输 JSON 事件，不依赖旧版 Godot Poki 插件。官方脚本不存在、被拦截、初始化失败时，游戏继续可玩，广告返回不可用或错误，不安装伪造 SDK。桥接层采用官方 [HTML5 SDK](https://developers.poki.com/guide/sdk-html5) 的 `init`、`gameLoadingFinished`、`gameplayStart`、`gameplayStop`、`rewardedBreak` 和 `commercialBreak`（2026-09-14 核查）；事件时机以 [SDK overview](https://developers.poki.com/guide/sdk-overview) 为依据。

本地测试能验证桥接逻辑和失败回退，真实 SDK、广告展示与奖励必须另经 Poki Inspector/平台环境确认。微信、抖音、TapTap 不会复用 Poki API。登录、分享和分包尚未接入。

## TapTap（App 内即玩）

TapTap 仅维护 H5 路线，内部平台值为 `taptap-h5`，与 Web、Poki 共用 Godot Web 导出流程。普通小游戏目标 `taptap-minigame` 已停止维护，不再提供其引擎运行环境适配；旧配置需停用该目标并按 H5 路线配置，详情见 [平台说明](platforms.md#taptap-路线与旧配置)。

`runtime/web/fwb-taptap.js` 对接 TapTap H5 容器提供的全局 `tap`，不安装或下载 APK/普通小游戏 SDK。没有容器、未启用、缺少广告位或缺少实际 API 时相应能力为 unavailable；构建目标叫 TapTap 不代表 SDK 可用。

已实现的桥接：

- 激励/插屏广告：检测 `createRewardedVideoAd` / `createInterstitialAd`，执行 load/show，通过 onClose/onError 收尾。仅激励广告的 `onClose({isEnded: true})` 产生资格；show Promise 成功不发奖。宿主仍负责奖励规则、事务和去重。
- `list_cloud_archives()` 列出当前容器账号的档案。
- `write_cloud_bytes(bytes, metadata, archive_uuid="")` 创建或更新档案。metadata 使用平台的 `name/summary/extra/playtime`；框架不读取游戏字段。传输文件仅写入 `tap.env.TEMP_DATA_PATH`，不产生第二个本地主档。
- `read_cloud_bytes(archive_uuid, file_id)` 下载并返回不透明 `PackedByteArray`，不自动覆盖游戏主档。路径必须保持在容器临时目录，传输结束尽力删除临时文件。
- 云请求串行、限时；上传按官方每分钟一次限频，返回 `code: rate_limited` 和 `retry_after_ms`。提交后超时返回 `remote_outcome: unknown`，不自动重试或报告成功，待 SDK 实际收尾前保持锁。游戏需重新查询、对账，再决定采用哪个存档。

账号身份获取/登录、冲突合并、排行榜、分享、支付未实现。`capabilities().login` 明确为 false；当前没有已核实的 H5 玩家登录合同，不借用 APK 登录接口。[独立存档与广告服务](platform-services.md) 提供默认启动选档页、设置备份面板和按用途名称调用广告的入口。后室已启用 TapTap H5 启动选档；广告未配置实际广告位。

合同来源（2026-10-08）：[官方 H5 入口](https://developer.taptap.cn/agents/)、[MCP 安装说明](https://developer.taptap.cn/minigameapidoc/quick-start/mcp-guide/mcp-setup/)、[H5 广告指南](https://developer.taptap.cn/minigameapidoc/quick-start/mcp-guide/ad-integration-guide/)。实际函数与回调依据该官方入口链接的 `@taptap/instant-games-open-mcp` **1.24.14** 包内 `docs://cloud-save/overview`、云存档接入工作流及广告管理器文档；仅静态读取公开包，没有启动 MCP、授权账号或对外上传。

交付验收要求是在手机 TapTap App 内启动、加载资源并完成触摸、音频、存档及前后台检查，以及已接入平台能力的检查。普通浏览器中的 Web 候选包验证不能替代这一步，当前尚无 TapTap 客户端通过记录。

## 演示工程与验证

`examples/demo` 是中文“星港补给站”：每次触摸/点击收集 1 能量，达到配置 `data/game.json` 中的 12 能量完成一次补给。包含暂停/继续、合成短音效、本机存档恢复、渠道状态和自愿激励广告入口。未获得真实奖励资格时计数保持不变。界面使用约 100 KB 的 Noto Sans SC 字体子集，使浏览器也能显示中文；字体遵循随包 `assets/OFL.txt`，来源为 [Google Fonts Noto Sans SC](https://github.com/google/fonts/tree/main/ofl/notosanssc)。字体子集仅覆盖当前 UI，用于新增文本时需重新生成或换用完整字体。

存档为 `user://progress.json`，应用目录名 `fwb-demo`；浏览器存档作用域依赖站点 origin。测试或预览地址端口改变时，浏览器可能使用不同存档。失败或无法持久化时界面明确说明。导出 preset 包含配置 JSON，并排除测试脚本、FWB 工程配置和文档；构建工具与凭据不属于运行时。

验证入口：

```text
node --test test/runtime-bridge.test.mjs
node --test test/runtime-environment.test.mjs test/runtime-taptap.test.mjs
godot --headless --editor --path <assembled-stage> --import
godot --headless --path <assembled-stage> --script res://tests/runtime_smoke.gd
```

Godot 冒烟验证配置读取、14 次收集后的补给结算、广告不可用不发奖励、销毁重建场景后恢复存档，并输出 `FWB_RUNTIME_SMOKE_OK`。它会重置演示存档，勿对游戏正式存档使用该测试。浏览器另检查中文布局、输入、音频、刷新恢复与前后台；使用导出后的真实包，不以编辑器运行替代。演示输出 `FWB_DEMO_READY`、`FWB_DEMO_STATE`、`FWB_AD_RESULT` 控制台证据，不包含凭据。
