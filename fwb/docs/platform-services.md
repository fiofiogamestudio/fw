# 可复用存档与广告模块

同一个游戏只调用 FWB 接口；导出目标决定装配哪个平台桥接。模块位于 `runtime/addons/fwb/`，不依赖 FWC，也不读取游戏的关卡、角色或奖励字段。

| 模块 | 职责 |
| --- | --- |
| `services/save_service.gd` | 启动选档、命名空间、完整性检查、本局同步许可、限频与冲突状态 |
| `adapters/file_save_adapter.gd` | 可选单文件适配器：大小限制、校验回调、替换前备份、临时文件与原子改名 |
| `ui/save_start_screen.gd` | 默认背景＋本地/云存档页，加载、重试、离线继续和覆盖确认 |
| `ui/cloud_backup_panel.gd` | 设置页里的备份状态与手动上传；不在游戏运行中载入云档 |
| `services/ads_service.gd` | 用途名称、奖励资格、请求去重和插屏冷却 |
| `runtime/web/fwb-taptap.js` | TapTap H5 容器 API；仅 TapTap H5 构建加载 |

## 一次配置，多个目标

合并到游戏的 `fwb.project.json`：

```json
{
  "runtimeAddon": true,
  "runtime": {
    "taptap": { "enabled": true, "cloudSave": true },
    "saveFlow": {
      "enabled": true,
      "platforms": ["taptap-h5"],
      "autoUpload": true,
      "debounceSeconds": 65
    },
    "ads": {
      "enabled": true,
      "placements": { "bonus": "rewarded", "between_runs": "interstitial" },
      "interstitialCooldownSeconds": 120
    }
  }
}
```

`platforms` 决定哪些导出目标每次冷启动显示选档页。只有 `taptap-h5` 时，普通 Web/原生导出会返回 `skipped`；想让 Web 也使用本地存档页就加入 `web`。页面在 SDK 不可用时仍提供本地入口。新增平台实现同样的平台服务协议即可；已有其他平台的云接口不会被假装为可用。页面每次启动都出现，不将“上次选择了某云档”保存成永久绑定。

`autoUpload:true` 只允许界面提供“本局自动备份”选项，玩家仍需主动勾选。广告 SDK 开关与具体广告位独立。公开广告位必须来自当前应用当次官方 `check_ads_status` 返回，按方向匹配后填入 `runtime.taptap.rewardedAdUnitId / interstitialAdUnitId`；不要复制其他游戏的 ID。没有广告位时正常返回 `unavailable`，不影响游戏。框架不存后台令牌或密钥，也不会在启动时弹广告。

安装开发副本，然后正常导出：

```powershell
node D:/Git/fw/fwb/bin/fwb.mjs runtime-install --project D:/Games/MyGame --target taptap-h5
node D:/Git/fw/fwb/bin/fwb.mjs build --project D:/Games/MyGame --target taptap-h5 --profile release
```

`runtime-install` 和导出都会装配全部 GD 模块。`addons/fwb` 是受管副本，不手改；升级后重新安装。

## 启动页：在进入玩法前 await 一次

已有存档系统的游戏提供四个方法：

```gdscript
get_local_snapshot() # {exists, valid, bytes:PackedByteArray, summary, updated_at, playtime}
validate_save(bytes) # {ok, message?}; 必须检查版本、字段和业务约束
import_save(bytes)   # {ok, path?, message?}; 成功才替换唯一主档
create_new_save()    # {ok, path?, message?}; 失败不清空旧档
```

只有一个存档文件时，可以直接用通用文件适配器，提供两个回调：

```gdscript
const FileSave = preload("res://addons/fwb/adapters/file_save_adapter.gd")
var save_service: Node

func start_game() -> void:
    var adapter = FileSave.new()
    adapter.setup("user://progress.json", validate_progress_bytes, make_new_progress_bytes)
    var result: Dictionary = await FwbPlatform.open_save_screen(adapter, {
        "gameId": "your-stable-game-id", # 不同游戏必须不同，发行后保持不变
        "slot": "main",
        "title": "游戏名称",
        "background": preload("res://assets/title.jpg"),
        "font": preload("res://assets/game-font.ttf")
    })
    if result.get("ok", false):
        save_service = result.get("service") # 跳过页面时为 null
        load_local_save_and_enter_gameplay()
```

`validate_progress_bytes` 返回 `{ok:true,summary:"第 3 天",playtime:300}` 或 `{ok:false,message:"..."}`；`make_new_progress_bytes` 返回新存档的 `PackedByteArray`。`updated_at` 为 Unix 秒、`playtime` 为秒。自定义适配器也使用同一合同。不要先创建会自动写存档的游戏系统再弹选档页；`open_save_screen` 会拒绝在已上报 gameplay_start 后调用。

正常游戏保存成功之后，通知服务读取最新本地内容：

```gdscript
FwbPlatform.report_file_written("user://progress.json")
if is_instance_valid(save_service):
    save_service.notify_local_saved()
```

通知只安排备份，不改变游戏事务或奖励。持续保存不会无限推迟上传，上传时读取最新已提交数据；平台每分钟上传限制仍有效。不要在未成功写盘时通知。关闭游戏时调用 `save_service.dispose()` 并释放节点；浏览器关闭过程不保证来得及上传最后一次变化。

## 运行中的云备份面板

把下面的控件加入设置页即可显示状态并手动备份：

```gdscript
const BackupPanel = preload("res://addons/fwb/ui/cloud_backup_panel.gd")
var service: Node = FwbPlatform.active_save_service()
if service != null:
    var panel = BackupPanel.new()
    panel.configure(service, {"theme": theme})
    settings_container.add_child(panel)
```

手动操作会明确确认“新建云备份”或“更新本次选中的云档”。云端已有更新、上传结果未知或本地失败都会显示状态；不会在玩家继续游戏时从云端替换内存模型。

默认页面支持 `background:Texture2D`、`title`、`subtitle`、`font`、`theme`、`locale`（`zh-CN/en`）、`strings` 文案覆盖及 `safe_insets:Vector4`。也可以完全替换 UI，使用 `create_save_service(adapter, options)`、`refresh()`、`snapshot()`、`state_changed`、`choose_local/choose_new/choose_cloud`、`start_session(selection)`；底层自定义接入同样必须在玩法开始前完成选择，并在销毁时 dispose。

### 使用游戏自己的界面风格

传入 `theme:Theme` 后，所有按钮状态、字体和字号直接继承游戏的 `Button` Theme，不再覆盖为默认薄荷绿样式。主操作与确认操作使用 `FwbSavePrimaryButton` 类型变体；没有定义此变体时继承普通 `Button`。也可用 `primaryButtonVariation` 和 `buttonVariation` 指定已有变体名。FWB 不会修改传入 Theme 的共享 StyleBox。

```gdscript
var startup_theme: Theme = make_game_theme()
startup_theme.set_type_variation("FwbSavePrimaryButton", "Button")
startup_theme.set_stylebox("normal", "FwbSavePrimaryButton", make_primary_button_style())
var options := {
    "theme": startup_theme,
    "background": preload("res://assets/game-cover.png"),
    "cornerRadius": 2,
    "palette": {
        "ink": Color("ede9dc"), "muted": "#b2afa1", "accent": "#c5bd95",
        "surface": Color(0.09, 0.10, 0.08, 0.92), "border": "#484b41",
        "background": "#080b08", "footer": "#8c8d7b",
        "overlay_top": Color(0.02, 0.03, 0.02, 0.18),
        "overlay_middle": Color(0.02, 0.03, 0.02, 0.70),
        "overlay_bottom": Color(0.02, 0.03, 0.02, 0.96)
    }
}
```

`palette` 接受 `Color` 或 HTML 色值，可覆盖 `ink / muted / accent / surface / border / background / footer / warning / overlay_top / overlay_middle / overlay_bottom / modal_overlay`。`cornerRadius` 控制面板和默认按钮的圆角；传入 Theme 后按钮圆角由 Theme 决定。只传 `font` 或不传换肤参数的游戏继续使用原有默认样式。封面与游戏专属配色留在宿主，FWB 只负责呈现这些参数。

### 封面布局与字号

`layout: "cover"` 启用封面布局：顶部标题和副标题、中间可伸展的背景区域、底部存档操作。默认选中本地页，玩家可以切换“本地存档 / 云端存档”；切换只改变显示，不会导入存档。离线或云端刷新期间仍能返回本地页继续游戏。默认 `cards` 布局保留原有结构。

```gdscript
options.merge({
    "layout": "cover",
    "title": "游戏标题", "subtitle": "副标题", "eyebrow": "",
    "showTimestamps": false,
    "panelPadding": 16,
    "sourceTabVariation": "GameSaveSourceTab",
    "coverPageMinHeight": 176,
    "fontSizes": {
        "eyebrow": 12, "title": 24, "subtitle": 18,
        "section": 16, "saveTitle": 16, "body": 16, "meta": 12,
        "button": 14, "confirmationTitle": 18, "confirmationBody": 16
    }
})
```

`fontSizes` 按角色覆盖字号，包括覆盖确认弹窗。显式 `title` 字号不会随窄屏缩小；未指定的角色沿用默认值，按钮未指定字号时继续继承游戏 Theme。按钮和勾选项的最小触摸高度均为 48。`sourceTabVariation` 可指定游戏 Theme 中单独的来源页签变体。

`panelPadding` 控制面板内边距；封面布局默认 16，容器间隔使用 8/12/16。封面外边距左右至少 16、底部 16、顶部按高度为 24 或 32，宽屏继续居中。本地与云端页共用本地页所需高度，默认至少 144，可用 `coverPageMinHeight` 增加下限。切换短状态不会移动来源页签；云端内容在区域内滚动，保留所有档案入口。封面布局把刷新按钮放在来源页签同一行；有云档且状态正常时隐藏重复的选择提示，加载、空档和错误仍显示。整页在更小窗口仍可滚动。

封面布局默认隐藏重复的本地标题、新档说明和页尾提示；可分别用 `showLocalTitle`、`showNewSummary`、`showFooter` 恢复。`showTimestamps: false` 只隐藏时间展示，不修改存档元数据。`strings.local_tab` 可覆盖本地页签文案，其他文案沿用原有 `strings` 合同。本地操作失败会在当前可见页显示错误。

自动化可使用稳定节点名 `LocalSourceTab / CloudSourceTab / LocalSaves / CloudSaves / CloudSaveScroll / SaveTitle / SaveSubtitle / CoverSpacer / SelectionStatus`；原有 `ContinueLocal / StartNew / UseCloud_<id> / RefreshCloud / AutoBackup / ConfirmOverwrite / CancelOverwrite / AcceptOverwrite` 保持不变。

### 品牌图与纵向存档来源

在封面布局上设置 `sourceLayout: "rows"`，可改成两条全宽来源行：左侧选择方块和来源名称、右侧短摘要。两行均保持 48 的触摸高度，点击只切换来源页面。来源区下方间隔 16 放主操作，本地正常进度的主次操作间隔 8；本地页按实际内容高度排版，不保留页签布局的固定空白。

```gdscript
options.merge({
    "layout": "cover", "sourceLayout": "rows",
    "brandTexture": preload("res://assets/game-logo.png"),
    "brandWidth": 144, "brandHeight": 124, "coverTopInsetRatio": 0.09,
    "sourceRowVariation": "GameSaveSourceRow",
    "secondaryButtonVariation": "GameTextAction", "secondaryActionCentered": true,
    "showLocalDetails": false,
    "localRowSummary": func(local: Dictionary) -> String:
        return format_short_save_summary(local)
})
```

`brandTexture` 按比例放进 `brandWidth × brandHeight` 的区域，存在品牌图时隐藏普通文字标题、副标题和眉题；不传品牌图则继续显示文字。可选 `brandMaterial: Material` 直接赋给品牌 TextureRect，供宿主控制遮罩和着色，默认无材质。`coverTopInsetRatio` 是顶部留白占可用高度的比例。来源行模式左右外边距至少 20、底部 24，中间背景区域伸展，小屏必要时整页可滚动。

`sourceRowVariation` 使用游戏 Theme 的按钮选中/未选状态；行中文字通过 `fontSizes.sourceRowText` 配置（默认沿用 `button` 字号），选择方块和字色沿用 palette。`localRowSummary` 接收本地存档描述的副本，只格式化显示，不改变存档。`strings.source_heading` 控制“选择存档”标题，`row_new / row_ready / row_invalid / row_offline / row_loading / row_working / row_error / row_empty / row_count` 控制短状态文案。

`secondaryButtonVariation` 只作用于存在继续操作时的“新游戏”按钮；`secondaryActionCentered` 可令这项操作居中并保留至少 48 高触摸区，主操作继续全宽。`showLocalDetails: false` 隐藏本地重复摘要，但损坏存档的错误说明仍显示。云端页继续提供刷新、滚动列表、错误及覆盖确认，`coverPageMinHeight` 在此模式下只约束云端滚动区域；自动备份选择仍使用原有会话语义。

来源行模式进入云端时改为详情态：隐藏品牌区和两条来源行，把原 `LocalSourceTab` 显示为“返回本地”，与云端标题、刷新按钮放在同一行；顶部留白为 24。返回会恢复原品牌、顶部比例和来源行，两种导航都不会读取存档。云档列表保留局部滚动，备份选项位于其下，320×568 下三档和开启备份说明可在同一视口操作，不增加外层滚动。`fontSizes.primaryButton` 可单独设置主操作及确认操作字号，未指定时沿用 `button`。

来源行模式的备份选项只在云端详情态显示，本地封面不显示该组。已勾选的会话选择在返回时保留；之后继续本地游戏，仍依据实际云端能力与保留的选择决定是否备份，不以控件是否显示作为授权。再次进入云端详情会显示原来的勾选状态。

## 广告：只传用途名称

```gdscript
var ads: Node = FwbPlatform.create_ads_service()

func on_bonus_clicked() -> void:
    var result: Dictionary = await ads.rewarded("bonus")
    var grant: Variant = result.get("grant")
    if grant is Dictionary and grant.get("verified", false):
        apply_reward_transaction_once(grant.id) # 奖励值、落盘、去重仍是游戏规则

func on_round_completed() -> void:
    await ads.interstitial("between_runs")
```

用途在 `runtime.ads.placements` 映射为 `rewarded/interstitial`；同一份游戏代码可用 TapTap、Poki 或明确不可用的其他平台适配。应从玩家点击触发激励广告。平台暂停事件仍由宿主处理输入与音频，FWB 合并广告/后台/手动暂停原因。服务不凭广告 show 返回值发奖励，未展示、取消、超时、模拟和重复回调均没有 grant。插屏最短间隔为 120 秒。

## 数据边界

- 云端封装包含 `gameId`、`slot`、版本和 payload SHA-256；下载后还必须通过游戏校验。SHA-256 用于损坏检查，不是防作弊认证。旧的非 FWB 云档不会自动混入本模块列表。
- 本地/新档继续时默认保留所有旧云档；勾选备份会创建新云档。选择云档并勾选后才更新该槽，因此多次选择本地备份可能产生多个云档，不自动删除旧档。
- TapTap H5 暂无已核实的账号变化通知或可用账号 ID。进入后台会撤销本局自动更新许可；设置面板仍可手动创建新备份，恢复自动模式需重新启动并选档。
- 更新前重新列出云档并核对 `file_id`，检测已观察到的远端变化。官方更新接口没有条件写入 CAS，因此检查和写入之间的跨设备竞争仍需平台真机验证，不能承诺绝对无冲突。
- 上传后超时或回包不明会保留 `remote_uncertain`，不盲目重试；重新启动并核对云端列表后再选择。单次服务 payload 上限为 7 MiB，包含 Base64 的封装还需满足传输限制。
- 本地写入、Web 文件系统同步请求、云上传是三种状态。`force_fs_sync()` 无完成回调，不能把调用成功当作浏览器耐久保证。

完整无 FWC 样例见 [`examples/save-flow`](../examples/save-flow/)。后室使用自己的存档版本和恢复点校验，共用本模块的页面、事务适配和状态面板。

官方依据：[H5 入口](https://developer.taptap.cn/agents/)、[H5 广告指南](https://developer.taptap.cn/minigameapidoc/quick-start/mcp-guide/ad-integration-guide/) 及其指向的官方 `@taptap/instant-games-open-mcp` 1.24.14 静态文档。模拟、原生和导出测试分别记录；真实云端账号、广告与跨设备行为需要在 TapTap H5 容器验收。
