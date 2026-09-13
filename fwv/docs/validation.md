# 验收记录

2026-09-07，在 Windows 本机使用当前 FWV 工作区源码和相邻 FWE 0.2.0（server integration contract v1）执行。

## 图片与骨骼首版基线

| 范围 | 结果 | 证据边界 |
| --- | --- | --- |
| FWV 单元与真实文件/HTTP 集成 | 34/34 通过 | 图片像素、原图哈希、版本、损坏拦截、跨进程写入、Spine 区域/旋转/裁边/PMA、配方重放、真实 FWE 接口 |
| 顶层 FW 回归 | 17/17 通过 | 原有组件初始化/版本/入口，以及新 `fw visual` 路由 |
| 浏览器验收 | 12/12 通过；错误/警告 0 | 真实文件选择、图片加工与导出、Spine 自动播放、时间定位、换皮像素、版本恢复、导出文件回读 |
| 1000 像素窗口 | 图片与骨骼工作台无横向溢出 | 本次 Chrome 页面测量和截图 |

浏览器最后通过记录：[report.json](../.local/reports/browser/run-j0R6iO/report.json)。图片工作台截图：[图片](../.local/reports/browser/run-j0R6iO/02-image-processed-top.png)；骨骼工作台截图：[Spine](../.local/reports/browser/run-j0R6iO/10-spine-replaced-top.png)。这些本机证据不进入源码分发，换机器后可运行 `node tools/test-browser.mjs` 重新生成。

验收使用本项目原创猫咪素材，骨骼数据为 4.2、包含两段动作，浏览器额外覆盖大写扩展名和只有命名皮肤的情况。实际画布中可见像素、动作时间变化、原版橙色/换皮紫色都已检查；不只验证 DOM 或文件存在。

真实重复验收曾在 Windows 原子替换索引时触发 EPERM，失败记录保留于 `reports/browser/run-nRehDO`。修复为仅对 Windows 共享占用类错误进行有限重试，同一临时文件与目标、始终保留原索引；新增短暂/永久占用及非占用错误注入测试，随后完整浏览器流程通过。

未进行目标 Godot/Unity 工程运行验收，也没有用复杂商业骨骼素材证明全部 Spine 功能兼容。该基线验收时尚未接入 AI 生图；自动绑定、新动作制作及 3D 仍未实现。这份记录只适用于本次工作区状态，不是发布组合认证。

## 生图服务接入

同日补充 GPT Image / OpenAI Images 基础兼容接口、单张参考图编辑、服务凭据配置、异步任务、产物入库、CLI，以及 Spine 素材库图片选择。

- 顶层 FW 回归 17/17 通过。
- FWV 完整自动检查 67/67 通过，包含原有 34 项及新增 33 项生成接口、任务、CLI 与来源保留检查。
- 原有图片与骨骼浏览器验收重新执行，12/12 通过：[report.json](../.local/reports/browser/run-GBHGUf/report.json)。
- 生图浏览器验收 10/10 通过，0 项非预期浏览器错误：[report.json](../.local/reports/generation-browser/run-PrH9pq/report.json)。覆盖凭据保存与清除、排队状态轮询、文生图、参考图编辑、响应丢失后按请求编号恢复、本地保存失败重试、取消后的未知状态、进入图片工作台以及生成图片用于 Spine 图集替换；1000 像素窗口无横向溢出。
- 生图截图：[界面与已保存结果](../.local/reports/generation-browser/run-PrH9pq/01-generated.png)；[生成图片用于 Spine 换皮](../.local/reports/generation-browser/run-PrH9pq/05-generated-spine.png)。图中纯色图片由模拟服务返回，用于字节和像素验收，不代表真实 AI 的画质。
- 生成验证使用测试自建的 loopback HTTP 服务，检查真实 JSON/Multipart 请求、鉴权头、返回图片字节及项目存储。未调用付费模型、未使用真实用户 Key。
- 任务测试覆盖请求去重、未知远端结果、取消、本地保存重试、参考图校验，以及生成图片经过两次加工后导出仍保留来源与参考图。
- CLI 的本地入库失败测试验证了恢复目录中保留确切图片和参考图字节。

真实账号权限、余额、服务商参数差异和生成视觉质量尚未验证。已入库资产持久化；任务和待保存图片只在本次服务进程内保留，不支持重启后自动恢复远端任务。

## 模板驱动角色生产流程

在生图接入之上，新增持久化角色方案、统一部件模板、一次生成整批部件、自动形成 Spine 候选、保留其余部件的局部重做，以及本地重装和角色动画对照。

- 完整 FWV 自动检查 89/89 通过。新增 8 项模板与部件检查、10 项持久流程与并发测试、4 项真实 FWE HTTP 集成测试。
- HTTP 集成使用六部件角色模板，验证创建方案不调用模型；来源/CSRF 错误不登记生成请求；允许的单次请求通过 Multipart 编辑接口出图、装配并导出，骨骼 JSON 与 Atlas 保持原始字节。
- 模板测试涵盖旋转、裁边、局部替换、原始透明轮廓保护、错误布局拒绝、部件消失拒绝，以及覆盖不足提示。
- 流程测试涵盖调用前持久登记、跨重启请求去重、未保存图片重启后的未知状态、取消时序、本地装配失败后复用图片，以及并发版本写入拒绝覆盖。
- 原图片/Spine 浏览器回归 12/12 通过：[report.json](../.local/reports/browser/run-nryV3i/report.json)。生图页回归 10/10 通过：[report.json](../.local/reports/generation-browser/run-rPleyI/report.json)。
- 角色换皮流程浏览器验收 10/10 通过，非预期浏览器错误 0：[report.json](../.local/reports/reskin-browser/run-zuJI3l/report.json)。覆盖六部件一次请求、单头部重做保留其余五部件原始像素、本地缩放/偏移重装不调用模型、官方运行时真实动画对照、精确候选导航与导出，以及服务重启后保留未知状态且不自动重发。
- 已检查[完整角色对照截图](../.local/reports/reskin-browser/run-zuJI3l/02-whole-character.png)和[1000 像素窗口截图](../.local/reports/reskin-browser/run-zuJI3l/05-narrow.png)，画布已实际渲染且无横向溢出。蓝色候选来自本地模拟服务，仅用于验证生产链路和像素变化，不代表真实模型美术效果。

演示项目新增六部件、三段动作的原创猫咪模板和「铠甲橘猫」生产方案，创建时模型请求数为 0。真实 AI 对固定部件布局、语义、风格与接缝的遵从性尚未以用户模型服务验证；当前完成的是生产链路及技术检查，不能据此宣称美术品质或目标游戏运行验收通过。

## 立绘拆件与骨骼制作

2026-09-08，新增 `kind=rig` 草稿、多边形与关节点编辑、本地裁切和刚性部件绑定、基础动作、工作台与 CLI，以及新骨骼作为换皮模板的完整衔接。

- FWV 完整自动检查 **101/101 通过，0 跳过**：[测试输出](../.local/reports/rig-automated-20260908.log)。新增 8 项几何/像素/实际运行时测试和 4 项真实 FWE HTTP/CLI 集成检查。
- 骨骼测试验证原始 RGBA、三角形像素遮罩、JSON 中精确父子累计坐标和附件位置，以及官方运行时的实际解析和 idle/walk/wave。运行时几何比较的数值误差界限依据其 PI 常量与 Float32 量化，不以画面近似替代坐标断言。
- 覆盖坏多边形、越界关节点、父子环、空部件构建拒绝、损坏文件、文档/元数据不一致和 CAS 并发保护；HTTP 验证来源/CSRF、严格查询、导出原始字节、继续创建换皮方案，CLI 使用相同应用函数。
- 新流程真实浏览器 **10/10 通过，0 项非预期错误，0 次模型请求**：[report.json](../.local/reports/rig-browser/run-s4cHFH/report.json)。使用真实文件选择器和鼠标事件划分六个部件、设置关节点与绘制顺序；拖动轮廓改变贴图字节、修改关节点改变骨骼数据；三种动作均检查实际画布帧变化。
- 浏览器还验证未保存修改阻止切页/构建、自交轮廓被真实 API 拒绝且编辑不丢失、修正后继续保存、刷新恢复、精确候选进入 Spine/换皮和导出。1000 像素窗口页面与面板横向溢出均为 0。
- 已检查[分区编辑截图](../.local/reports/rig-browser/run-s4cHFH/01-six-part-draft.png)、[实际动作预览](../.local/reports/rig-browser/run-s4cHFH/04-rule-motion-preview.png)与[窄屏预览](../.local/reports/rig-browser/run-s4cHFH/07-narrow-preview.png)。源图为项目原创测试素材，标注是人工预设；不代表自动识别任意立绘。
- 原图片/Spine 浏览器回归 **12/12 通过**：[report.json](../.local/reports/browser/run-t93hMO/report.json)。原换皮流程浏览器回归 **10/10 通过**：[report.json](../.local/reports/reskin-browser/run-IPQgKq/report.json)。

本地演示新增「猫咪游侠 · 拆件草稿」及由源图实际构建的 Spine 候选。任意画风自动语义分割、遮挡补全、加权网格、AI 动作生成以及目标 Godot/Unity 项目验收仍未实现。本轮也未调用真实图像模型。

## 本地 Agent 与 API 双模式

2026-09-08，角色流程新增当前对话领取、部件理解、单次派发登记、回填自动装配和可恢复的本地任务。新建方案默认本地，旧 API 方案保持原方式。

- 全量自动检查 **114/114 通过，0 跳过**：[测试输出](../.local/reports/local-automated-20260908.log)。覆盖两真实 Node 进程竞争领取、并发回填收敛唯一候选、精确身份与来源幂等、分析冻结、前后取消、未知结果、重启恢复和装配存储失败后的本地重试。
- CLI 实际任务包保持参考图原字节，分析后导出新提示词；错误项目阻止使用，未知调用可补交原图。归一来源测试验证 1254 RGB→1024、父文件与元数据校验、加工配方白名单和导出追溯。
- 本地工作台浏览器 **6 项通过**：[report.json](../.local/reports/local-reskin-browser/run-IUrpAp/report.json)。无 Key 建任务，外部 worker 分析/领取/回填后页面轮询自动显示候选、真实 Spine 运行时动画、刷新恢复及窄屏。此套测试明确使用模拟图片，模型调用 0。
- 原 API 换皮浏览器 **10 项通过**：[report.json](../.local/reports/reskin-browser/run-FiEkOm/report.json)。独立模拟服务，不使用真实 API Key。

另外执行 **1 次真实 Codex 内置 image_gen**，制作「铠甲橘猫」，没有 FWV API Key 或 Images API 请求。工具返回 1254×1254 RGB，与所需 1024 尺寸不一致；原图先保留，目测布局后显式用 FWV 等比归一，再按严格 1024 校验回填。未重发生图，也未放宽错误尺寸拒绝规则。

[真实执行记录](../.local/reports/local-real/fwv-task-I7XmBK/result.json)、[实际提示词](../.local/reports/local-real/fwv-task-I7XmBK/prompt-rev_199c4bb7343b4507863f41aeb9123769.txt)、[原始图片](../.local/reports/local-real/fwv-task-I7XmBK/generated-original.png)均已保存。候选通过文件完整性检查并导出；`cat.json` 与 `cat.atlas` 哈希和模板完全相同。来源保留原始父图、1254→1024 的处理配方、前后尺寸与哈希。

原 RGB 图的背景没有 alpha，装配依赖原模板遮罩。覆盖率不代表语义或关节对齐；美术验收必须查看真实角色及动作。此轮仍未验证 Godot/Unity 内的最终交付效果。

真实候选只读运行时检查 **7 项通过**：[report.json](../.local/reports/local-real/runtime/run-2YxAuT/report.json)。idle/walk/wave 均加载确切模板和候选版本、同步播放，并检测两时间点实际像素变化；浏览器错误为 0，全部项目文件前后哈希相同。已目视检查[静止对照](../.local/reports/local-real/runtime/run-2YxAuT/idle-workspace.png)、[挥手对照](../.local/reports/local-real/runtime/run-2YxAuT/wave-workspace.png)及行走帧/部件图：轻甲配色统一，脸部保留，受检帧未见明显脱节或黑色矩形背景。单轮简单模板的效果不能证明任意复杂角色均可无修正换皮，也不代替用户美术验收。

## FWE 编辑合同重构

2026-09-08，将五类面板的编辑参数从面板私有状态移入 FWE 的同一类型化资源。FWE 负责导航、修改状态、历史、保存与冲突提示；FWV 使用正式 Workbench Layout 扩展保留画布、部件和动作操作。

| 范围 | 结果 | 当前证据 |
| --- | --- | --- |
| FWV 文件、并发与 HTTP 自动检查 | 124/124 通过，0 跳过 | [测试输出](../.local/reports/fwe-automated-20260908.log) |
| FWE 草稿浏览器 | 9/9 通过 | [report.json](../.local/reports/fwe-authoring-browser/run-387vOj/report.json) |
| 拆件与骨骼浏览器 | 12/12 通过 | [report.json](../.local/reports/rig-browser/run-n6Urzh/report.json) |
| API 生图浏览器 | 10/10 通过 | [report.json](../.local/reports/generation-browser/run-EcIrkc/report.json) |
| 本地 Agent 换皮浏览器 | 6/6 通过 | [report.json](../.local/reports/local-reskin-browser/run-bJ3JZV/report.json) |
| API 换皮浏览器 | 10/10 通过 | [report.json](../.local/reports/reskin-browser/run-YpDJeD/report.json) |
| 图片与 Spine 浏览器 | 12/12 通过 | [report.json](../.local/reports/browser/run-EO0pwa/report.json) |

草稿验收从真实浏览器按 Ctrl+S，通过 FWE Source 写入 `.fwv/editor-drafts.json`；覆盖尚未建立的换皮方案、生图参数、图片配方、Spine 校准的撤销/重做和完整刷新。FWE 内置 catalog 的表单修改可返回专业面板继续编辑，共用相同历史。全过程只有草稿 PUT，没有资产命令、模型调用或资产索引变化。外部修改导致旧窗口保存 409，当前输入与 dirty 状态保留，外部版本不被覆盖。

拆件验收用真实鼠标完成多点拖动，确认一次 FWE 撤销恢复整个原多边形，重做恢复精确像素坐标；切页保留未提交的几何，刷新恢复正确的当前草稿、版本和角色候选。通用 JSON 填入不可显示的 `document={}` 时，原始参数仍保留，画布退回已保存资产并提示修复，FWE 撤销后恢复编辑。自交轮廓仍由生产 API 拒绝，未降低几何与像素断言。

本轮修复了空集合误触发 FWE required 检查、模板异步加载插入额外撤销历史、拖动中提示高度改变坐标、创建后 URL 停留在新建草稿，以及非法 JSON 恢复失败等实际问题。更新了测试中随异步挂载失效的 DOM 等待；未用跳过校验、删除业务断言或模拟 FWE 代替真实验收。

重启恢复生成任务时，精确待确认请求的执行状态优先显示，避免已保存草稿中的旧候选覆盖 `unknown` 提示；普通历史选择和 FWE 撤销仍按用户草稿恢复。API 换皮回归验证重启后不会重复请求，本地 Agent 路径也重新通过。

Source 自动检查还覆盖两个独立进程竞争首次/后续保存、原始文件字节版本、字段和凭据边界、损坏或跨项目文档，以及空/未完成拆件结构。首次创建用排他硬链接发布已同步的临时文件；不持项目锁的外部进程抢先创建目标时收到 409，外部完整字节保留，临时文件清理。后续覆盖写仍受版本检查、项目锁和原子替换保护。

已查看[原生参数表单](../.local/reports/fwe-authoring-browser/run-qKM3vV/02-native-parameter-catalog.png)和[1000 像素拆件工作台](../.local/reports/rig-browser/run-n6Urzh/06-narrow-rig.png)：FWE 顶栏、侧栏和诊断区域保留，页面无横向溢出。此轮使用独立测试项目与模拟服务，不重新调用真实图像模型；原「铠甲橘猫」资产保持。既有目标游戏运行时验收边界不变。

## 主界面全面配置化

2026-09-08，继续修正上轮只有生命周期接入 FWE、主界面仍自行构造普通 DOM 的问题。五个页面与共享播放条改由 FWE 读取七份 JSON 配置，原生 Inspector 负责字段；布局、按钮、文案、字段约束、运行时显隐/禁用/状态输出均来自配置。删除私有样式文件、重复主导航、参数草稿第二入口、重复导入按钮和拆件选择列表。专业 SVG 几何及 Spine WebGL 保留扩展实现。

| 验证范围 | 结果 | 证据 |
| --- | --- | --- |
| FWV 单元、文件与 HTTP | 127/127，0 跳过 | [完整输出](../.local/reports/fwe-config-automated-20260908.log) |
| FWE 语法、配置与单元 | 103/103 | `cd ../fwe; npm test`，含领域继承和 Surface 回归 |
| FWE 配置界面浏览器 | 6 项通过 | [报告](../../fwe/.local/reports/surface-browser/report.json) |
| 草稿生命周期与启动导航 | 10/10 | [报告](../.local/reports/fwe-authoring-browser/run-4tFhiM/report.json) |
| 立绘拆件与候选 | 12/12 | [报告](../.local/reports/rig-browser/run-kh2kKt/report.json) |
| 图片与 Spine | 12/12 | [报告](../.local/reports/browser/run-AETqqA/report.json) |
| API 生图 | 11/11 | [报告](../.local/reports/generation-browser/run-ApuSQf/report.json) |
| API 换皮 | 10/10 | [报告](../.local/reports/reskin-browser/run-tiKHAv/report.json) |
| 本地 Agent 换皮 | 6/6 | [报告](../.local/reports/local-reskin-browser/run-poJOQn/report.json) |
| 原真实候选只读复核 | 7/7 | [报告](../.local/reports/fwe-config-real-runtime/run-ubmehU/report.json) |

FWE 原有示例、资源生命周期和 Graph 浏览器回归也通过。Surface 验证涵盖更换 JSON 后布局/字段变化、模型枚举与范围优先、状态更新保持焦点、移除旧属性、片段释放及密码不写入文档。FWV 配置合同检查逐一解析全部 `schemaPath`，阻止普通 DOM/CSS/固定文案/表现状态重新写回控制器。

本轮补齐 `@length` 的原生控件元数据，生图 prompt 上限与执行层统一为 8000；任务校验复用 provider 的已有能力，兼容协议的 `hd` 与 768×512 请求实际经过测试 HTTP 服务入库。图片 `cover` 配方以及生图 `hd` 在保存、撤销和刷新后保留。延迟初始资产快照再切页的测试验证最新导航不会被启动回调覆盖。

浏览器全部无非预期错误。测试采用自建模拟服务，没有调用真实模型。原有「铠甲橘猫」重新以真实 Spine Runtime 检查 idle/walk/wave 的同步时钟和变化像素；项目全部文件哈希前后相同。已目视检查[配置表单](../.local/reports/fwe-authoring-browser/run-4tFhiM/02-configured-parameter-form.png)与[真实角色对照](../.local/reports/fwe-config-real-runtime/run-ubmehU/wave-workspace.png)。目标游戏运行时与最终美术验收仍沿用前述边界。

本地 3230 服务已加载最新配置；重启前后项目 ID、16 项资产、索引哈希及草稿文件存在状态保持一致：[重启前](../.local/reports/fwe-config-service-before.json)、[重启后](../.local/reports/fwe-config-service-after.json)。

## 工作页信息精简与渐进展开

2026-09-08，根据实际使用反馈重排五个工作页。主区保留预览，约 340px 参数栏保留当前必要输入与一个主要生产动作；部件要求、校准、版本、模型设置与技术详情按需展开。新建换皮先显示实际动画模板，生成后对照原图和候选；成功结果与首屏要求不再夹在大段部件说明之间。已有模型配置时生图默认只显示名称、要求两个输入。

布局、文案、显隐、强调按钮和展开条件仍由 FWE JSON 配置。FWE 通用 workspace/stage/thumbnail 预设负责响应布局与预览尺寸，并修复空导航栏、窄屏异常留白、轮询覆盖手动折叠和导航状态残留。空 Spine 项目直接展开导入，首次构建骨骼自动打开动作预览；后续手动折叠保持。失败状态使用 danger 色，并在上次成功结果仍保留时显示新的操作错误。

| 验证范围 | 结果 | 证据 |
| --- | --- | --- |
| FWV 自动检查 | 127/127，0 跳过 | [完整输出](../.local/reports/ux-automated-20260908.log) |
| FWE 自动检查 | 105/105 | 本轮 npm test |
| FWE Surface / Workspace 浏览器 | 6 / 3 项通过 | [Surface](../../fwe/.local/reports/surface-browser/report.json)、[Workspace](../../fwe/.local/reports/surface-workspace/report.json) |
| 草稿生命周期与启动导航 | 10/10 | [报告](../.local/reports/fwe-authoring-browser/run-vUUXLd/report.json) |
| 立绘拆件与骨骼 | 13/13 | [报告](../.local/reports/rig-browser/run-3Az9zY/report.json) |
| 图片与 Spine | 15/15 | [报告](../.local/reports/browser/run-Ox3TAf/report.json) |
| API 生图 | 13/13 | [报告](../.local/reports/generation-browser/run-biH79j/report.json) |
| API 换皮 | 10/10 | [报告](../.local/reports/ux-reskin/run-zK9fi9/report.json) |
| 本地 Agent 换皮 | 7/7 | [报告](../.local/reports/ux-local-reskin/run-Z7C3p5/report.json) |
| 原真实角色只读与首屏 | 9/9 | [报告](../.local/reports/ux-real-runtime/run-WykkYX/report.json) |

浏览器通过真实 summary 点击访问折叠控件，保留原有像素、版本、导出、撤销、冲突和不重复生图断言。额外覆盖成功结果后的新错误、已确认任务恢复后的过期错误清理，以及导航离开 Spine 时尚未完成的真实图片响应。首次并行捕获动画帧及测试 reload / Fetch 清理出现过时序失败；保留失败报告，修正测试生命周期等待后相关组重新通过，未削弱业务断言。

已目视检查[1000px 真实换皮页](../.local/reports/ux-real-runtime/run-WykkYX/focused-1000.png)、[新建模板页](../.local/reports/ux-local-reskin/run-Z7C3p5/00-new-template.png)、[图片页](../.local/reports/browser/run-Ox3TAf/01-focused-image.png)、[拆件页](../.local/reports/rig-browser/run-3Az9zY/06-narrow-rig.png)和[生图页](../.local/reports/generation-browser/run-biH79j/04-narrow.png)。1280px 和 1000px 的换皮页都能在首屏看到两侧角色与主操作，默认只有方案、动作、要求、执行方式四个控件，没有横向溢出。

全部生图链路测试使用自建模拟服务或模拟本地 worker，未调用真实模型。原「铠甲橘猫」的 idle/walk/wave 实际播放与项目全部文件哈希通过只读复验。本地 3230 服务加载最终配置，16 项资产、索引和草稿存在状态在重启前后保持一致：[重启前](../.local/reports/ux-service-before.json)、[重启后](../.local/reports/ux-service-after.json)。

## 工作流一致性与中断恢复

2026-09-12，按工作流审查确认的问题修复图片配方、Spine 校准、历史拆件和生成结果恢复。普通控件、文案、布局和状态继续由 FWE JSON 配置，专业像素处理与绘制留在 FWV 应用层。

- 图片加工版默认修改既有配方，从原输入重算；追加加工显式选择并从中性参数开始。100×100 测试图留白 10 后主体为 80×80，重复修改相同配方的输出 SHA 完全一致；留白 20 后为 60×60，再显式追加留白 10 后为 48×48。新版本同时保留编辑父版本和实际输入版本。补齐界面已有的 cover/fill 选项处理，矩形条纹像素检查区别等比适应、裁满和拉伸。历史版本只显示对应导出路径。
- Spine 校准先更新临时角色动画与部件图，不创建版本；应用后图集、部件及受检动画帧与预览一致。参数按版本、部件保存，旧单部件草稿兼容迁移。切页、切部件和延迟响应不会覆盖当前输入。技术检查和导出明确作用于已保存版本。
- 历史拆件只读，提供“从此版本继续制作”以创建独立副本；保留确切来源、原图字节和标注，原资产当前版本不变。409 冲突后保留本页修改并允许带到副本；恢复成功清理旧错误。局部“创建拆件版本”与顶部 Ctrl+S 保存参数的语义分开。
- 生成请求先记录派发意图，返回图片和参考字节先同步暂存再入库。真正关闭并重建编辑器服务后，无需凭据即可保存原结果，不新增模型请求。入库回执处理成功响应丢失、任务状态更新失败、两个服务同时保存及陈旧 unknown 状态；同一结果只登记一份资产，用户后选版本不回退。暂存文件损坏保留并拒绝使用；磁盘不可写时明确提示结果仅在当前内存中。

浏览器验收使用独立 Chrome 用户目录、真实 FWE 服务和隔离测试项目，模型部分使用本机模拟 HTTP 服务或模拟本地 worker。自动通过不代表真实模型的视觉质量或 Godot/Unity 导入验收。暂存提交前进程退出仍无法保证取回远端结果，不能把这一状态显示为可恢复成功。

角色换皮同时接通生成任务恢复：精确核对请求、模板参考版本、提示词、服务模型和生成参数，重启后直接显示“保存并装配角色”。从已暂存图片继续保存和装配，以及候选已写入但流程记录失败后的重试，都使用原结果而不重复创建资产。已有候选的校准仍保持折叠，未知远端任务仍不重发。

| 验证范围 | 最终结果 | 本轮证据 |
| --- | --- | --- |
| FWV 单元、文件、CLI 与 HTTP | 151/151，0 跳过 | [完整输出](../.local/reports/workflow-refine-final-20260912.log) |
| 图片配方与来源 | 9/9 | [报告](../.local/reports/image-recipe-browser/run-NGyPmx/report.json) |
| 图片与 Spine 校准 | 19/19 | [报告](../.local/reports/spine-calibration-browser/run-reZrO7/report.json) |
| 历史拆件与冲突恢复 | 16/16 | [报告](../.local/reports/rig-workflow-fix/run-Z3NtO7/report.json) |
| API 生图及真正服务重启 | 13/13 | [报告](../.local/reports/generation-browser/run-GzW4ch/report.json) |
| FWE 草稿生命周期 | 10/10 | [报告](../.local/reports/fwe-authoring-browser/run-wbjKqX/report.json) |
| API 换皮及恢复装配 | 11/11 | [报告](../.local/reports/reskin-recovery-browser/run-UVZUCD/report.json) |
| 本地 Agent 换皮 | 7/7 | [报告](../.local/reports/refine-final-local-reskin/run-BSU6oi/report.json) |

已目视[图片加工](../.local/reports/image-recipe-browser/run-NGyPmx/01-revise-1280.png)、[Spine 待应用动画](../.local/reports/spine-calibration-browser/run-reZrO7/05-calibration-workspace.png)、[历史拆件](../.local/reports/rig-workflow-fix/run-Z3NtO7/08-historical-readonly.png)、[重启后生成恢复](../.local/reports/generation-browser/run-GzW4ch/02-restored-result.png)及[换皮恢复入口](../.local/reports/reskin-recovery-browser/run-UVZUCD/06-recovered-ready.png)。1280px / 1000px 图片页与各工作页窄屏检查通过，原有 FWE 配置合同测试保持通过。

本地 `http://127.0.0.1:3230/` 已启动最终源码，原项目 16 项资产、1 份导出及全部 61 个文件哈希保持一致：[启动前](../.local/reports/workflow-refine-service-before.json)、[启动后与 HTTP 检查](../.local/reports/workflow-refine-service-after.json)。本轮没有重新生成示例或调用真实图像模型，也没有提交 Git。
