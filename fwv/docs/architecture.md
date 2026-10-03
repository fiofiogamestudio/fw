# FWD 2D 架构

FWD 是建立在 FWE 上的独立 2D 美术编辑器。FWE 提供工作区、Schema、原生 catalog 列表／网格、搜索筛选、缩略图、分页、选中导航、Form 生命周期、撤销/重做和草稿保存；FWD 提供资产库和 2D 专业 Form。宿主只负责转换与发布适配。

## 模块

| 模块 | 职责 |
| --- | --- |
| `src/core/project.mjs` | 不可变文件修订、确切身份、SHA-256 / 大小验证、写锁、原子索引和导出包 |
| `src/image/processor.mjs` | PNG / JPEG / WebP 解码与尺寸、alpha 检查；保留文件名以兼容宿主导入路径 |
| `src/skeleton2d/document.mjs` | 通用区域附着与加权网格骨骼文档校验，不识别游戏角色或玩法 |
| `src/skeleton2d/sample.mjs` | 无 DOM 的纯采样模块，浏览器和宿主工具复用 |
| `src/skeleton2d/application.mjs` | 导入、检查、版本冲突校验、保存和导出 |
| `src/editor/catalog.mjs` | 将登记图片及骨骼投影为 FWE 原生 Source 集合；只持久化实际编辑草稿 |
| `src/editor/gallery2d-api.mjs` | 校验确切图片身份、文件字节、真实格式，提供原图和受限缩略图 |
| `src/editor/app/gallery2d-panel.js` | 当前选中图片的画布预览、缩放和拖动 |
| `src/editor/app/skeleton2d-panel.js` | 播放、骨骼/部件/网格权重/关键帧编辑以及修订保存 |

## 两个界面入口

`fwe.app.json` 注册一个工作区、两个 Source 域：只读 `fwv-catalog/images` 与可编辑 `fwv-authoring/skeleton2dDrafts`。集合字段、模式、缩略图、分页和筛选只在对应 `.fwe` 中声明。两者都声明 `layout catalog`，不注册自定义 WorkbenchLayout。专业模块直接调用 FWE `registerForm`；公共适配器只组装 Form 上下文，不维护第二套注册表。`fwd-image-preview` 与 `fwd-skeleton2d` Form 仅占所选记录的专业详情。Form 返回 `{element, dispose, canLeave}`，切换时由 FWE 回收画布、监听和动画循环。

普通字段复用 FWE Surface 的模型解析入口、控件、类型化值读取、事件和原生有效性约束。关键帧新增/修改走原生 form 提交；骨骼父子关系使用 FWE DAG 图。保存草稿统一使用 FWE 顶栏保存，专业面板不另建保存入口。Surface 的所有权统一归 Form 适配器，领域面板只回收自己的画布、图和播放循环。

图库按原图归组，默认筛选当前版本；历史版本通过原生筛选查看。同一素材、同一修订内，存在同扩展名原图时，`__flash / __stone / __frozen / __poor / __unavailable / __visited` 派生文件收进原图的 `variants`，卡片显示状态数量，详情展开后可切换预览。显式标记为 source、preview、reference 的文件、未知后缀和缺少原图的文件保留独立条目；不会跨素材或版本合并。搜索包含组内全部文件名。归组仅改变目录投影，不改动资产、采用记录或运行时文件；预览请求保留确切文件身份，取消过期请求以防快速切换串图。

骨骼集合包含所有登记角色，未编辑的记录仅为目录投影；查看和切换角色不会写入草稿。修改使用 FWE 原生撤销/重做和保存，Source 写入时剥离名称、缩略图等派生字段，保留原始草稿合同。FWE 的同步 `canLeave` Form 守卫保护新建修订事务，`saveCurrent({refresh:false})` 允许连续保存与回读而不中途卸载当前编辑器。

骨骼保存产生新修订，原始文档和 PNG 不变。写入在锁内检查期望版本，过期窗口返回 409。素材浏览可查看历史版本；游戏导出始终固定 `assetId + revisionId`，不隐式跟随 latest。

## 读写边界

HTTP 服务固定绑定项目身份，检查 Host / Origin 和写入 CSRF token。公开路由只包含会话、快照、UI 配置、图片、骨骼及其固定采样脚本。图片读取校验文件名、字节数、SHA-256 和真实解码；不接受任意磁盘路径。旧 `/api/fwv/gallery2d` 查询/分页接口已经删除，集合查询统一交给 FWE。

请求体复用 FWE `readBody({maxBytes})`，要求 `boundedRequestBody: bytes-v1` 能力。FWE 默认仍为 8 MiB；FWD 的命令传输上限为 30 MiB，草稿域 JSON 传输为 17 MiB，实际草稿数据仍受 16 MiB 领域限制。UTF-8 在完整字节收齐后解码，超限或中止不写入文件。

图库识别图片文件本身，因此同一素材的多个 PNG、骨骼纹理、自定义 2D 包及旧版本都可查看。FWE 集合配置每页 48 项，原生列表和网格共用分页；缩略图懒加载，最大 256 像素。图片 API 合并并发索引读取，缓存缩略图有容量上限，每次仍校验源字节；骨骼批量读取同一修订的纹理。

旧项目资产、来源、导出和交付历史保持可读。历史工作流和图库筛选草稿作为不透明数据原样保存，当前编辑 API 拒绝写入这些集合。图库视图状态由 FWE 管理，不再持久化一套 FWD 查询草稿。不存在旧工作流服务、轮询任务或隐藏功能入口；3D 资产不能通过当前 2D 导出验证。

## 专业扩展边界

FWE 提供画布尺寸与设备像素比例管理；图片棋盘/缩放/拖动视口、区域与加权网格的骨骼采样/播放、纹理绑定和关键帧时间轴仍由 FWD 的通用 2D 模块实现。关键帧顺序、同一时刻唯一性及轨道值类型由骨骼合同校验。不可变资产修订、哈希验证和版本冲突事务同样属于 FWD 资产库；FWE 原生草稿保存管理编辑文件。上述能力与具体游戏身份解耦。

## 宿主复用

宿主把原始 2D 数据转为 `fwd-skeleton2d`，使用公开 API 导入。编辑器只消费标准文档与 PNG，不读取游戏数据库。宿主根据自己的 renderer 支持范围检查确切编辑修订，再发布资源。

`examples/skeleton2d/windmill.json` 和 `tools/create-skeleton2d-demo.mjs` 是完全独立于游戏的风车样例，复用同一导入、预览、编辑、保存和导出链。
