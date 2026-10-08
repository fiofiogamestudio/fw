# UI 截图审阅

这是 FWV 的固定 FWE 应用。采集工具只需产出符合协议的 `capture.json` 和 PNG，再调用本应用；每次采集不生成或改写编辑器。

在 FWV 目录启动：

```powershell
node ui/cli.mjs serve --manifest "D:/Games/MyGame/output/ui-capture/capture.json" --fwe-path "D:/Git/fw/fwe" --open
```

也可从 FWV 主命令进入：

```powershell
node bin/fwv.mjs ui serve --manifest "D:/Games/MyGame/output/ui-capture/capture.json" --fwe-path "D:/Git/fw/fwe"
node bin/fwv.mjs ui validate --manifest "D:/Games/MyGame/output/ui-capture/capture.json"
node bin/fwv.mjs ui export --manifest "D:/Games/MyGame/output/ui-capture/capture.json" --out "D:/Games/MyGame/output/ui-review-export"
```

`--port` 默认选择空闲本地端口；服务仅监听 `127.0.0.1`。`--fwe-path` 指向具备本应用所需集成合同的 FWE 0.2.0；默认使用 FWV 同级的 `fwe/`。CLI 离线导出要求新的输出目录，不覆盖既有目录。

## 审阅方式

- **截图图库**沿用 FWE 原生集合、网格 / 明细、搜索，以及模块 / 自动检查 / 审阅状态三组筛选。只显示当前截图，历史记录仍保留在原清单中。编号来自清单，不随筛选或排序改变。
- 打开一张截图后，用“上一张 / 下一张”或编号前往；这组导航按整批截图的固定编号顺序浏览。
- PNG 默认完整适配预览区。滚轮缩放、拖动平移；“100% 原始尺寸”以一个源像素对应一个 CSS 像素显示。预览聚焦后，方向键切图，`+` / `-` 缩放，`0` 适配。
- **自动检查**常显采集时 AI 的逐图结论与具体依据：绿色安全表示 AI 未发现画面问题，黄色风险表示可能有问题，红色错误表示已确认问题。它不等于人工通过或游戏功能测试通过。缺少评估的旧图显示黄色“尚未进行自动检查”，不会默认标绿。
- **基本信息**仅显示编号、模块、尺寸与采集时间；复现路径、原始说明、状态及图片散列保留在复制出的 JSON 中。
- **审阅记录**提供“通过 / 跳过 / 不通过”按钮和问题备注。新图默认为跳过（待审阅）；“跳过”不改已有判定，按全库固定编号循环查找下一个未决项，不受当前筛选限制。只剩当前图时停留并提示；全部已通过或不通过后禁用跳过。
- “通过 / 不通过”和备注写入 FWE 原生草稿；用顶部 **保存审阅** 持久化，撤销与重做仍使用原生历史。
- **复制 JSON**复制当前图的身份、图片定位、AI 检查、人审结论、最新草稿备注和复现信息；**复制所有 JSON**复制全库当前有问题的图，包含黄色 / 红色或人工不通过，排除人工通过及历史截图，不受当前筛选限制。没有问题时复制空数组。浏览器拒绝剪贴板时显示完整 JSON 供手动复制。
- **覆盖与缺口**列出母清单全部状态，保留已采集、待补拍 / 受阻和有据排除的具体原因，并链接支撑截图。
- 页面不再显示折叠采集记录或导出链接。CLI 离线导出仍可用，并包含已保存审阅；原始 PNG 与采集证据保留。

## 数据与保存

输入为 `schemaVersion: 1` 的 UI 采集 manifest，包括 `run`、`screenshots`、`coverage`。新采集图必须提供 `autoCheck: { status: "safe" | "risk" | "error", summary: "具体判断依据" }`；`summary` 为不超过 500 字符的非空文本，来自 AI 实际画面检查，不由编辑器关键词推断。截图路径相对 manifest 所在目录；PNG 尺寸、散列、稳定编号、ID 和覆盖引用会在启动前校验。原始 manifest 与 PNG 不由审阅界面修改。

审阅写入 manifest 同目录的 `review.json`，以 manifest 的 SHA-256 绑定批次，按 screenshot ID 保存 `status` 和 `note`。版本冲突会拒绝覆盖另一窗口的保存；重新打开当前数据后再继续。FWE 的 Source 投影为 `catalog.json`，它是运行时集合数据，不是另一个待手工维护的清单文件。

## 固定应用边界

- `app/catalog.fwe`：集合模型、搜索、筛选和展示模式。
- `app/fwe.app.json`：原生导航、撤销 / 重做 / 保存，以及审阅字段。
- `app/preview.ui.json`、`app/coverage.ui.json`：FWE Surface 配置。
- `app/review-panel.js`：专业 PNG 预览 Form 与覆盖链接；画布由 FWE 管理设备像素比例与尺寸。
- `app/extension.cjs`、`server.mjs`、`core/`：登记资源、只读图片、独立审阅保存和离线导出。

不注册自定义工作台，不嵌入 iframe，不复制 FWE 页面布局。扩展图片能力时保留原生集合、历史和保存合同。

验证应用配置：

```powershell
node D:/Git/fw/fwe/bin/fwe.js --app ui/app/fwe.app.json --check
```
