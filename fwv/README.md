# FWV 美术工作台

面向 AI 辅助游戏开发的美术工作台，产品、目录、包和 CLI 统一使用 **FWV / `fwv`**。默认从已有素材开始：说“想怎么改” → 查看修改结果 → 用这版或继续修改。没有结果时显示一个大视口，有结果才显示同条件对比；名称自动生成，版本、保持条件和专业参数按需展开。图片加工、立绘拆件、骨骼预览与模板换皮保留在“工具”工作区。界面建立在独立 FWE 的扩展接口上，已有资产清单、存储格式和接口保持不变。

没有骨骼模板时，可从「立绘拆件与骨骼」开始：校正多边形分区、关节点与父子关系，再本地生成骨骼和基础动作，接入同一套换皮流程。

## 快速体验

需要 Node.js 20.10+、npm，以及相邻的 FWE 0.2.0（包含 server integration contract v1）。不需要启动 Godot 或 FWA。

Windows 双击 `start.bat` 即可打开工作台；也可以在 `fwv` 目录执行 `npm.cmd run editor`。入口固定使用组件内的 `.local/demo`，第一次启动且该目录不存在时才创建示例，已有工程会直接重新打开。服务使用系统分配的空闲端口，就绪后自动打开浏览器；使用期间保持启动窗口打开，按 Ctrl+C 停止。

首次使用先在 `fwv` 目录安装依赖：

```powershell
npm.cmd ci
start.bat
```

示例包含四个原创图标和一个带两段动画的猫咪换皮项目。需要指定已有工程、FWE 路径或固定端口时：

```powershell
start.bat --project D:/Art/MyGame --fwe-path ../fwe --port 3230
start.bat --check
start.bat --no-open
start.bat --help
```

`--check` 只读检查 Node、图片依赖、FWE 合同和项目，默认示例尚未创建时仅报告首次启动将创建；不会启动服务或写入项目。`--project` 仅打开已有美术工程，缺失时不会自动创建。`--no-open` 或 `FWE_NO_BROWSER=1` 只启动服务并输出地址。

默认示例路径及其已有父目录不能经过符号链接或 Windows junction。自动验证时可设置 `FW_START_NO_PAUSE=1` 跳过失败后的按键等待；正常双击失败仍保留窗口。

`src/`、`bin/`、`tools/`、`test/` 是组件源码与开发工具；示例数据放在 `.local/demo/`，本机验收报告统一放在 `.local/reports/`，均由 Git 忽略。已有报告按原样保留，报告内的历史绝对路径可能仍指向搬迁前的位置。

为已有示例添加六部件、三段动作的角色生产方案：

```powershell
node tools/create-reskin-demo.mjs .local/demo
```

这只创建原创骨骼模板、部件布局和角色设定，不调用模型。工作台默认打开 **素材中心**；进入“角色换皮”并选择「铠甲橘猫」方案，即可检查模板、修改要求，再显式发起生成。已有骨骼可以在“骨骼素材”页导入，然后创建自己的方案。

为同一项目添加立绘拆件示例：

```powershell
node tools/create-rig-demo.mjs .local/demo
```

切到 **立绘拆件与骨骼**，选择「猫咪游侠 · 拆件草稿」，可直接编辑示例轮廓和关节点，查看由这张图片实际构建的骨骼与基础动作。示例标注是人工预设，创建过程不调用模型。

在顶层 FW 也可以启动：

```powershell
node fw/bin/fw.mjs visual --project fwv/.local/demo
```

`fw visual` 目前是本地开发入口，默认使用工作台相邻 `fwv/`、`fwe/`；可以通过 `--fwv-path`、`--fwe-path` 选择其他位置。它不修改原有 `fw editor` 选择。FWV 尚未登记为已发布的远端 gitlink，不能通过 `fw deps install` 分发。

## 已实现

| 流程 | 能力 |
| --- | --- |
| 素材中心 | 一个主输入、自动名称、图片圈选、按需保持条件；本地 AI 请求准备或图像 API 编辑；结果出现后同条件对比，“用这版”顺序评审并采用；图片局部结果默认锁定选区外像素 |
| 立绘拆件与骨骼 | 六部件预设、可编辑多边形与关节点、父子关系和绘制顺序；本地裁切、打包、刚性部件绑定及 idle/walk/wave 基础动作，生成独立 Spine 候选 |
| 角色生产流程 | 固定骨骼模板与版本，选择最多 16 个部件，编辑角色设定/风格/部件要求；每批一张布局图、一次模型请求，自动切回图集并形成独立角色候选 |
| 局部修正 | 基于当前候选只重做选定部件，其余部件保留；已生成结果可平移/缩放/旋转后本地重新装配，无需再次调用模型 |
| 本地 Agent | 当前 Codex 对话领取角色任务，保存部件理解，使用内置生图后回填自动装配；无需在 FWV 配置 Key，重启不重复派发 |
| API 生图 | 配置服务地址、模型和 API Key，文生图或单张参考图编辑，任务状态、原始结果入库、提示词与用量留存 |
| 图片 | 导入 PNG/JPEG/WebP，纯色色键去底、透明裁边、等比适应/裁满/拉伸、留白、画布背景、48 像素预览；修改配方保持原输入，也可选择追加加工 |
| 版本 | 保留原始文件，加工另存版本，选择历史版本，记录配方与 SHA-256 |
| Spine | 4.2 JSON + 文本 Atlas + PNG；解析部件、旋转/裁边/PMA，替换图集区域、平移/缩放/旋转/翻转 |
| Spine 骨骼与权重修复 | 读取真实结构、约束、动作和网格权重；修复当前骨骼初始变换及允许的父级、独立加权网格的单顶点已有影响；实际文件候选同相机/同时间对比、评审后采用 |
| 3D 模型与绑定 | 内嵌 GLB 2.0 的材质、贴图、蒙皮、骨骼和动作视口；局部 TRS 骨骼与四个既有影响的权重修复；贴图提取接入图片 AI 工作流并回装候选 |
| 动画预览 | 可选官方 4.2.120 WebGL 运行时；原版/当前版同步播放，动作与皮肤选择、暂停和时间定位 |
| 交付 | 技术检查、损坏文件阻止导出、按原始文件名复制资源并生成清单 |
| 接口 | CLI 与 FWE 界面使用相同资产应用操作；本机 HTTP 写操作有来源和 CSRF 校验 |

图片去底是按指定颜色进行的确定性处理，不是 AI 分割。角色换皮可选择本地 Agent 或 API；透明背景等能力取决于所选模型。

## FWE 草稿编辑

六个面板共用 FWE 的 `authoring.json` 资源、类型模型、导航、修改状态及撤销历史。**顶部“保存草稿” / Ctrl+S 只保存编辑参数**到项目的 `.fwv/editor-drafts.json`，不会调用模型，也不会生成或导出资产；“撤销草稿 / 重做草稿”同样只影响参数。新方案尚未建立时，填写的要求、选区和模板选择也可以保存。刷新可恢复已保存参数。

六个主页面的普通界面都由 FWE 读取 `src/editor/app/*.ui.json` 配置生成，字段约束来自 `authoring.fwe`；FWE 侧栏是唯一主导航。素材对比画布、拆件 SVG 与 Spine WebGL 保留专业绘制代码，共用的播放控件也来自配置。修改文案、字段排列、控件样式预设或状态绑定无需修改页面 JavaScript，详见[编辑配置合同](docs/architecture.md#fwe-编辑合同)。

素材中心的主操作固定确切基线与修改意图。结果出现后点击“用这版”，界面顺序记录接受并采用，更新原素材的当前版本；后端仍分别检查两个操作，遇到其他窗口改变评审或采用状态时提示冲突。部分失败可以重试，已经完成的接受不会重复提交。分开的评审与采用操作保留在详细记录中。原始素材、被驳回候选和采用记录均保留，详见[素材中心](docs/asset-center.md)及[修改请求合同](docs/art-changes.md)。

素材中心的 Spine 骨骼/权重参数也使用 FWE 草稿保存与撤销。3D 专业页尚未建立的输入仅在当前页面内暂存，建立修改请求才固定源版本、问题与锚点，详见 [3D 模型工作流](docs/model-workbench.md)。

撤销/重做影响参数；生成、保存拆件资产版本、装配和导出仍通过对应按钮明确执行，已经产生的资产版本不会被编辑器撤销删除。不同进程同时保存时会拒绝旧版本覆盖，并保留当前窗口的修改。API Key 由服务设置单独管理，不写入编辑草稿。

图片加工版默认“修改这一版的配方”，会从该配方原输入重算，避免重复叠加留白或缩小内容；选择“基于这一版追加加工”时，以当前像素为新输入并从中性参数开始。两者都另存版本。Spine 部件校准显示临时动画和部件效果，点击“应用替换”才创建版本；各部件和版本的待应用参数独立保存。历史拆件版本只读，通过“从此版本继续制作”创建独立副本，保留来源和当前编辑。

配置与保存边界见[架构说明](docs/architecture.md#fwe-编辑合同)。

## 配置生图服务

角色换皮默认使用**本地 Agent**：建立任务后，把任务指令交给当前 Codex 对话，由 Agent 分析并调用内置生图，结果自动装配。FWV 无需额外 Key；这不表示模型离线运行，也不表示网页能自行唤醒 Codex。具体操作与中断恢复见[本地 Agent 说明](docs/local-agent.md)。

打开工作台的 **AI 生图** 页，填写 Base URL、模型和 API Key，保存后即可发起生成。默认接口为 `https://api.openai.com/v1`，模型为 `gpt-image-2`，也可切换支持 Images API 的兼容服务。Key 保留在当前本机服务进程内，重启后需重新配置；不会写入资产项目或导出包。

“测试连接”只检查模型列表接口的鉴权，不证明图像模型权限、额度或所有生成参数可用。生成结果自动保存到素材库，可继续加工；Spine 页可以直接选择素材库图片用作替换部件。

模型返回的图片先暂存到项目磁盘，再登记为素材。暂存成功但入库失败时，重启后可继续“保存已生成图片”，不会再次调用模型或重复创建同一资产；磁盘完全不可写时会明确提示结果仅在内存中。没有取得可恢复结果的中断任务保持未知，不自动重新生成。

服务也可以从 `FWV_IMAGE_API_KEY`、`FWV_IMAGE_BASE_URL`、`FWV_IMAGE_MODEL` 环境变量初始化。不要把密钥放进源码、提示词或命令行参数。具体协议、CLI 和任务恢复边界见[生成服务说明](docs/generation.md)。

已有 Spine 的换皮保持骨骼 JSON 和 Atlas 文本原始字节，新图被放回原有部件画布和裁边范围，越界裁掉会给出提示。「立绘拆件与骨骼」则按用户校正的标注生成新的骨骼与规则动作；尚不支持任意图片的自动语义拆件、遮挡补画或加权网格。详见[立绘骨骼流程](docs/rig-workflow.md)。两条流程均不生成 `.spine` 工程。暂不接受 SKEL、其他 Spine 版本、序列附件、物理约束或混合 PMA 页；重叠区域不能替换。区域别名、九宫格等额外限制会在检查或替换时明确报出。

Spine 动画预览依赖独立的 [Spine Runtime 许可](THIRD_PARTY.md)。示例素材由代码原创绘制。

Spine 修复用于已有骨骼及独立加权网格，保留动画时间线、贴图和 Atlas；关联网格权重只读。3D 首版限单个内嵌 buffer、PNG/JPEG 内嵌贴图的 GLB 2.0，支持基础 glTF、unlit 和 texture_transform；其他格式未适配。骨骼修复保留逆绑定和动画，权重修复只调整已有影响，不自动重绑。详见[素材中心](docs/asset-center.md)和 [3D 模型工作流](docs/model-workbench.md)。

## 自己的项目

```powershell
node bin/fwv.mjs init --project D:/Art/MyGame --name "我的游戏美术"
node bin/fwv.mjs import --project D:/Art/MyGame --file D:/Art/Input/icon.png --name "药剂"
node bin/fwv.mjs status --project D:/Art/MyGame
```

使用返回的资产 ID：

```powershell
node bin/fwv.mjs process --project D:/Art/MyGame --asset <asset-id> --width 256 --height 256 --padding 24 --trim
node bin/fwv.mjs validate --project D:/Art/MyGame --asset <asset-id>
node bin/fwv.mjs export --project D:/Art/MyGame --asset <asset-id>
```

Spine 导入目录应只包含目标骨骼 JSON、Atlas 和该 Atlas 的 PNG 页：

```powershell
node bin/fwv.mjs spine-import --project D:/Art/MyGame --directory D:/Art/Input/character
node bin/fwv.mjs spine-replace --project D:/Art/MyGame --asset <asset-id> --region body --file D:/Art/Input/body.png --scale 1 --x 0 --y 0
```

所有 CLI 结果以 JSON 输出。`--revision` 可以显式选择输入版本；不指定时使用资产当前选择。导出路径是相对资产项目目录的路径，不是相对 FWV 源码目录。

## 文件与验收

```text
<asset-project>/
  fwv.project.json
  assets/<asset-id>/<revision-id>/
  .fwv/editor-drafts.json   # FWE 保存的编辑参数
  .fwv/generation/<job-id>/ # 请求记录与尚未入库的精确生成结果
  exports/<package-id>/
    manifest.json
    resources/
    references/    # 替换源图（存在时）
```

替换部件的输入图保存在版本内，配方记录该文件及变换参数，可以重新处理。导出清单的 `role` 区分运行时资源与参考输入，参考输入单独放在 `references/`，`resources/` 可以重新导入 Spine 工作台。整个资产项目可以纳入宿主版本控制；生成的演示项目、缓存和浏览器证据不纳入框架源码。

技术检查通过只证明检查列出的内容，不代表人工视觉认可或目标引擎运行成功。Spine 的结构检查在导入和替换时执行，通用版本验证检查已登记文件的长度与哈希。导出的资源还需要在实际 Godot/Unity 项目中验收。

索引保存采用原子替换，写操作用项目锁串行执行。进程崩溃留下 `.fwv.lock` 时，先确认没有 FWV 写进程，再移除该锁目录。失败产生的未登记版本或导出目录会保留，不自动清理原始数据。

## 验证

```powershell
npm.cmd test
node tools/test-browser.mjs --output .local/reports/browser
node tools/test-generation-browser.mjs
node tools/test-fwe-authoring-browser.mjs
node tools/test-image-recipe-browser.mjs
node tools/test-assets-browser.mjs
node tools/test-spine-repair-browser.mjs
node tools/test-model-browser.mjs
```

浏览器验收需要 Node.js 22+ 和本机 Chrome，使用独立用户目录与真实 FWE 服务，不连接已有浏览器会话。测试保留截图、项目、导出包和 JSON 结果，覆盖真实文件选择、加工、版本切换、Spine 播放和导出。没有安装可选 Spine Runtime 时，对应播放检查会明确跳过。

[架构与后续范围](docs/architecture.md)定义了 2D/3D 共用边界、生成服务扩展、UI/序列帧/Tile 以及引擎验收路线。尚未实现任意立绘的自动语义拆件、自动加权绑定、其他 3D 格式适配或 FWA 调度适配器。

角色生产方案、固定布局、局部重做和恢复边界见[模板角色换皮](docs/reskin-workflow.md)。

本次实际通过的检查及未验证范围见[验收记录](docs/validation.md)。
