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

- **截图图库**沿用 FWE 原生集合、网格 / 明细、搜索与分类 / 版本 / 审阅状态筛选。编号来自清单，不随筛选或排序改变。
- 打开一张截图后，用“上一张 / 下一张”或编号前往；这组导航按整批截图的固定编号顺序浏览。
- PNG 默认完整适配预览区。滚轮缩放、拖动平移；“100% 原始尺寸”以一个源像素对应一个 CSS 像素显示。预览聚焦后，方向键切图，`+` / `-` 缩放，`0` 适配。
- 在原生“审阅记录”字段选择状态并填写建议，用顶部 **保存审阅** 持久化；撤销与重做使用 FWE 原生历史。
- **覆盖与缺口**列出母清单全部状态，保留已采集、待补拍 / 受阻和有据排除的具体原因，并链接支撑截图。
- 采集证据、原始说明和 SHA-256 默认折叠。它们是采集记录；新写的修改意见保存在独立审阅字段。
- “导出与采集信息”提供已保存审阅 JSON 和单文件离线图库下载。离线图库嵌入原始 PNG，下载后不依赖本地服务。导出前请先保存当前修改。

## 数据与保存

输入为 `schemaVersion: 1` 的 UI 采集 manifest，包括 `run`、`screenshots`、`coverage`。截图路径相对 manifest 所在目录；PNG 尺寸、散列、稳定编号、ID 和覆盖引用会在启动前校验。原始 manifest 与 PNG 不由审阅界面修改。

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
