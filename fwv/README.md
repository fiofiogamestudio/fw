# FWV 可视化工具

FWV 基于 FWE，提供 **2D 美术素材**、**2D 骨骼动画**及独立的 **UI 截图审阅**工具。产品、源码目录、npm 包和 CLI 统一使用 FWV / `fwv`。

## UI 截图审阅

固定应用位于 [`ui/`](ui/README.md)，直接读取游戏生成的 `capture.json` 和原图，审阅备注写到独立 `review.json`。FWE 提供列表、筛选、详情、保存及撤销；Skill 负责采集并调用工具，不再生成编辑器代码。

```text
node ui/cli.mjs serve --manifest <capture.json> --fwe-path ../fwe
node ui/cli.mjs validate --manifest <capture.json>
node ui/cli.mjs export --manifest <capture.json> --out <new-directory>
```

顶层也可用 `start.bat fwv ui --manifest <capture.json>`。离线导出不需要启动 FWE。

## 2D 美术工具

- **2D 美术素材**：浏览素材库所有 PNG / JPEG / WebP，包括自定义资产包、骨骼贴图和历史版本；按素材或文件名搜索，分页查看缩略图，缩放、拖动画布、切换透明棋盘或明暗背景。查看历史版本不会改动当前版本。
- **2D 骨骼动画**：查看 `skeleton2d` 的角色、皮肤和动作，播放、定位、调整速度；编辑骨骼、区域部件、加权网格的顶点与权重、关键帧及插值，使用 FWE 撤销/重做和草稿保存，创建不可变修订并导出。

## 启动

需要 Node.js 20.10+ 和 FWE 0.2.0（server integration contract v1，含 `nativeCatalog: media-pagination-forms-v1`、`surfaceCanvas: device-resolution-v1` 与 `boundedRequestBody: bytes-v1` 能力），不需要启动游戏。旧 FWE 缺少所需合同会在启动时明确报错。浏览器验收另外需要 Node.js 22+ 和本机 Chrome/Chromium。

```powershell
npm.cmd ci
start.bat
start.bat --project D:/Art/MyGame --fwe-path ../fwe --port 3230
```

默认使用组件内 `.local/demo`；只有目录不存在时才创建四个图标和一个通用骨骼风车。已有项目直接打开。`--check` 只读检查配置，`--no-open` 只启动服务，`--help` 查看参数。新项目可用 `node bin/fwv.mjs init --project <目录> --name <名称>` 创建。

图片使用 `import` 导入；骨骼文档及其 PNG 部件使用 `skeleton2d-import` 或公开 API 导入，宿主负责自己的数据转换。

两个入口均使用 FWE 原生 `catalog` 集合视图，复用搜索、筛选、列表／网格、缩略图、分页、选中导航和深链。FWV 只通过 Form 扩展提供所选图片的画布预览、骨骼播放与编辑；不替换 FWE 的资源浏览区域。

专业 Form 的普通字段、约束与事件也使用 FWE Surface；骨骼层级使用原生 DAG 图。保存草稿只使用顶栏入口，撤销/重做由 FWE 管理。图片视口、骨骼采样和关键帧时间轴是 FWE 尚未提供的专业能力，统一维护在 FWV 中，供不同 2D 游戏复用。

```text
fwv import --project <project> --file <image.png>
fwv skeleton2d-import --project <project> --file <skeleton2d.json>
fwv skeleton2d-inspect --project <project> --asset <id> --revision <id>
fwv skeleton2d-save --project <project> --asset <id> --revision <id> --file <edited.json>
fwv skeleton2d-export --project <project> --asset <id> --revision <id>
```

完整命令见 `node bin/fwv.mjs help`。保存草稿、创建资产修订和发布到游戏分别是独立操作。框架不含游戏角色、阵营、玩法或生产目录约定。

## 数据和范围

保留资产库、不可变历史、SHA-256 / 文件大小校验、跨进程写锁、原子保存和导出包。旧项目中的来源与交付记录作为历史数据保留；旧草稿集合不再提供编辑入口。

已删除 AI 生图、候选/评审/采用工作流、换皮流程、立绘拆件、图片加工、3D 模型以及旧 Spine 制作/修复模块及其 API、命令和依赖。当前 `skeleton2d` 合同支持独立 PNG 的区域附着和加权网格；原生 Spine 数据须由宿主显式转换，不支持 IK、deform 轨道、linked mesh 或未加权顶点简写。不支持的数据明确拒绝。

## 文档与验证

- [架构与复用](docs/architecture.md)
- [骨骼数据与 API 合同](docs/skeleton2d.md)
- [验证入口](docs/validation.md)
- [第三方组件](THIRD_PARTY.md)

```powershell
npm.cmd test
npm.cmd run test:gallery2d-browser
npm.cmd run test:skeleton2d-browser
```

`npm ci` 会安装像素回归所需的 Canvas 开发依赖，`npm test` 必须实际执行这些用例。两项浏览器验收默认使用同级 `../fwe`，也可用 `FWV_BROWSER_FWE_PATH` 显式选择 FWE；测试在 `.local/reports/` 下创建独立工程，不编辑已有美术项目。

本地项目和验收报告位于 `.local/`，不作为组件源码分发。
