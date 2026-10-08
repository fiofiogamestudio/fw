# 通用 2D 部件骨骼编辑

`kind=skeleton2d` 面向独立 PNG 部件组成的 2D 角色、机械道具和场景物件，支持区域附着与加权网格。数据、验证、采样、版本保存与导出位于 `src/skeleton2d/`；FWE 只承载编辑交互，不拥有另一份动画真值。模块不包含宿主名称、角色 ID、阵营或玩法判断。旧原生 Spine 工作流已删除，需要由宿主将可表达的数据显式转换后导入。

每个不可变修订保存 `skeleton2d.json` 和其引用的 PNG 文件。文档是编辑真值；`metadata.skeleton2d` 仅为可重新计算的摘要。导入、保存、检查和通用 `asset.export` 均执行同一专业验证；哈希正确不等于文档合法。

## 版本 1 合同

新导入和新修订统一写 `fwv-skeleton2d`。旧序列化格式在读取时转换为当前名称；不原地改写历史修订、文件摘要或已有导出，因此已存资产仍可检查和恢复。

必填字段：

```json
{
  "format": "fwv-skeleton2d",
  "schemaVersion": 1,
  "coordinateSystem": "y-up",
  "bones": [{ "name": "root" }],
  "slots": [{ "name": "body", "bone": "root", "attachment": "part" }],
  "skins": [{ "name": "default", "attachments": {
    "body": { "part": { "type": "region", "path": "body", "width": 64, "height": 64 } }
  }}],
  "textures": { "body": "body.png" },
  "animations": { "idle": {} },
  "animationDurations": { "idle": 1 }
}
```

骨骼使用父级先于子级的数组。`x/y/rotation/scaleX/scaleY` 是局部 setup pose；位移轨道与 setup 相加，旋转轨道 `value` 使用角度并与 setup 相加，缩放轨道与 setup 相乘。`rotationLimit` 可约束最终局部旋转，`length` 为编辑辅助数据。允许负缩放与零缩放；局部缩放和轨道缩放限定在 ±100，骨骼层级最多 64 层，防止有限输入通过层级组合溢出。

区域附着支持 `x/y/rotation/scaleX/scaleY` 和 `tip:{x,y}`。`path` 精确引用 `textures` 的区域名，文件值必须是同修订内的安全 PNG basename。无 atlas、远程 URL、目录遍历或隐式外部文件。未提供某个附着的稀疏皮肤会隐藏相应槽位，不自动替换成另一皮肤的图。

加权网格附着使用 `type:'mesh'`，保留 `path/width/height/tip`，增加 `uvs:[u,v,...]`、`triangles:[vertexIndex,...]` 和 Spine 格式的 `vertices:[count,boneIndex,localX,localY,weight,...]`。UV 原点为图片左上角，范围 0..1；每个顶点有 1..4 个互不重复的骨骼影响，坐标属于对应骨骼的局部 Y 向上空间，正权重之和须为 1（误差不超过 1e-5）。加权结果直接是世界顶点，附件 TRS 必须省略或为 identity，不重复应用槽位/附件变换；`tip` 仍是槽位骨骼的局部坐标。网格至多 4096 顶点、8192 三角形，文档总计至多 65536 三角形；无效索引、重复/退化 UV 三角形、未使用顶点、截断权重流会拒绝。当前不支持 deform 轨道、linked mesh、IK 或未加权的 Spine 顶点简写。

每段动画支持：

- `bones:{bone:{translate:[{time,x,y}],rotate:[{time,value}],scale:[{time,x,y}]}}`。
- 数值关键帧 `curve` 只能是 `linear` 或 `stepped`，默认线性。首个关键帧之前保留 setup pose。
- `slots:{slot:{attachment:[{time,name}]}}`，`name:null` 隐藏附着。
- `drawOrder:[{time,offsets:[{slot,offset}]}]` 使用 setup 槽位序号偏移，偏移必须按原槽位顺序排列、目标不能冲突或越界；空偏移恢复原顺序。
- `events:[{time,name,int?,float?,string?}]` 引用顶层 `events:{name:{int?,float?,string?}}`。事件仅是时间线事实，采样不会执行游戏逻辑或反复触发事件回调。

`animationDurations` 为每段动作声明大于零的秒数，所有关键帧不能超时。除事件可同刻多条外，单条轨道的关键帧时间必须严格递增。

可选字段：

- `loopAnimations:[clip]`；`skinAnimations:{skin:{alias:clip}}` 将语义动作名映射到真实动作。
- `skinBones:{skin:[bone...]}` 保存完整皮肤 setup pose，骨骼名字和顺序须与基础数组一致；编辑当前皮肤应修改该数组。
- `skinSockets:{skin:{socketName:slotName}}` 引用附着 `tip` 或附着默认上端，供宿主读取发射点等信息。
- `bounds:{x,y,width,height}` 给编辑器固定镜头；`clipBounds:{clip:{x,y,width,height}}` 给动作定义全局 rig 坐标裁切区域。
- `lines:[{name,slot,attachment,skin?,color,width,points:[{bone,x,y}]}]` 是通用多骨骼连线，在关联附着之前绘制，可表示弓弦、拉索；没有特定游戏或部件名称。
- `metadata` 保存有界 JSON 来源信息，不参与采样或隐式改变渲染。

当前上限为 256 根骨骼、256 个槽位、128 个皮肤、512 段动作、100000 个关键帧、63 个 PNG 文件和 4 MiB 文档。PNG 解码复用现有图片安全与尺寸验证。未知字段、IK、shear、颜色轨道、贝塞尔曲线等未实现结构会明确拒绝，不会在保存时静默丢弃。

## 应用 API 和采样

```js
import { importSkeleton2d, inspectSkeleton2d, saveSkeleton2d,
  exportSkeleton2d, readSkeleton2dBundle } from 'fwv/skeleton2d/application';
import { validateSkeleton2dDocument } from 'fwv/skeleton2d';
import { sampleSkeleton2d } from 'fwv/skeleton2d/sample';
```

`importSkeleton2d(project,{name,document,textures:[{name,buffer}],idempotencyKey?,metadata?})` 验证后入库，返回标准资产。每个角色可以是独立资产，也可由宿主选择多皮肤资产；框架不假设角色目录结构。幂等编号绑定精确输入，重复导入不会改变用户后来选中的版本。

`inspectSkeleton2d(project,{assetId,revisionId})` 要求确切版本，返回 `document`、摘要、当前选择版本和区域对应文件清单。`readSkeleton2dBundle` 只加载一次项目索引，返回全部已校验文件 Buffer，方便批量宿主导出。

`saveSkeleton2d(project,{assetId,revisionId,expectedRevisionId,document})` 要求两个版本号相等，并在现有项目写锁内部再次检查 selected revision。成功写出新版本，原版和纹理字节保留；并发旧窗口收到 409。读取历史版与将历史版显式设为当前版是两个动作。编辑保存不会创建人工验收通过记录，也不会自动写入游戏生产目录。

`exportSkeleton2d` 复用既有导出包和技术校验合同。通用 `validateRevision/exportAsset` 也运行相同专业校验，不能通过绕开专用 API 来导出错误文档。

`sampleSkeleton2d(document,{skin,animation,time,loop})` 是无 DOM、无文件系统、无游戏依赖的纯 JS。`animation:''` 返回初始姿势。结果包含最终局部 TRS、世界矩阵、按 draw order 排列的可见槽位、区域顶点、socketPoints、lines、clipBounds 与当前时刻之前的事件事实。矩阵为 Canvas2D `[a,b,c,d,tx,ty]`，坐标保持 Y 向上。`slot.matrix` 已含附着变换；画 PNG 时在全局 Y 翻转以外还需图片自身局部 Y 翻转，或使用返回的左上、右上、右下、左下顶点。

网格槽位返回 `type:'mesh'`、世界 `vertices:[{x,y}]`、同值的扁平 `worldVertices:[x,y,...]` 以及 `uvs/triangles`。`skeleton2dMeshTriangles(slot)` 提供 UV 到世界的三角仿射映射；专业 Canvas 与透明 PNG 缩略图共享此映射。`drawSkeleton2dSlot(context,slot,image)` 在宿主已设置 Y 向上和镜头变换的 Canvas2D 上绘制区域或网格。编辑器的网格顶点和权重使用 FWE 原生字段；选择骨骼控制点或 Shift 点击网格顶点，在整项权重/拓扑通过统一验证之后才更新草稿，撤销重做及保存仍由 FWE 处理。

Canvas 绘制按实际变换处理三角形：完整网格使用同一仿射映射时只绘制一次纹理，避免半透明像素在共享边重复叠加。只有 UV 三角形在每个水平区间都能证明连续覆盖整个单位矩形时，才省略几何裁切；凹形、孔洞及覆盖不确定的网格保留裁切。覆盖缓存同时核对 UV 和三角形索引的内容，因此原地编辑拓扑不会沿用过期结论。

变形网格仅合并绘制顺序中连续且具有相同仿射映射的三角形，不越过其他面重排遮挡。共享边使用小于一个输出像素的补偿填平独立裁切产生的抗锯齿裂线，同时由真实姿态的轮廓裁切限制外沿。轮廓通过有向边组成闭环，保留孔洞和折叠面的重叠绕数；不把数千个内部三角形重复作为外轮廓裁切路径。该机制解决绘制接缝，不补绘源图片中的缺失部件，也不修正不合理的骨骼权重或关节位置。

## 编辑器与命令行

整数像素对齐、实际尺寸为原图 1:1 的贴图绘制保留原始像素，避免部分 Canvas 后端在高质量模式下再次滤波。实际缩放、旋转和亚像素位置继续使用调用方的平滑设置；区域附件与网格共用这一判断。

每个网格面或同变换面组只提交自身 UV 包围框内的贴图区域，并保留两个源像素的滤波余量。精确轮廓仍由原有几何裁切控制；这样可避免部分原生 Canvas 后端在嵌套复杂裁切时，将整张纹理上远处的半透明边缘重复叠加为白边。完整仿射矩形继续一次绘制整图。

整片是否共享仿射变换通过 UV 映射后的顶点残差判断，使用面积最大的面确定变换；不比较极细三角形反解出的矩阵。这样可避免加权坐标的浮点舍入被细长面放大，导致静止纹理错误地进入逐面重复采样。实际顶点变形仍使用独立的逐面映射。

完整矩形覆盖证明只容忍不超过 `1e-6 UV` 且小于 `0.001` 输出像素的数值接缝，放大时同步收紧并重新证明；可见孔洞和凹轮廓仍必须裁切。该容差用于退化面清理后的浮点残差，不能填补动画姿态中的部件缺口。

同源且受保护的 `GET /api/fwv/skeleton2d?assetId=…&revisionId=…` 返回确切文档及 `textureData:{fileName:{mime,base64}}`。全部 PNG 来自同一不可变修订，复用已经验证 SHA-256、大小和 PNG 解码的 Buffer；单次请求只加载一次已核对项目身份的索引，不逐张纹理重新读取整个资源库。文件总量和字节数仍遵守修订的 64 文件、128 MiB 上限，接口不接受任意文件路径。CLI 检查默认不返回纹理数据。

`GET /api/fwv/skeleton2d-runtime` 只提供固定验证与采样模块，不接受文件路径或任意模块名。写操作走已有 CSRF 命令入口的 `skeleton2d.import/save/export`；FWE 草稿和不可变资产修订仍然分离。

```text
fwv skeleton2d-import --project <project> --file <skeleton2d.json> --name <name>
fwv skeleton2d-inspect --project <project> --asset <id> --revision <id>
fwv skeleton2d-save --project <project> --asset <id> --revision <id> --file <edited.json>
fwv skeleton2d-export --project <project> --asset <id> --revision <id>
```

导入 CLI 从文档所在目录读取已验证的 PNG basenames。保存 CLI 以传入版本作为并发前提。版本回选、通用检查、导出历史继续复用现有命令。

## 无宿主复用样例与验证

`node tools/create-skeleton2d-demo.mjs <project>` 创建独立的风车示例，包括真实 PNG、父级骨骼、360 度动画、事件与 socket；无需任何游戏源码或角色约定。源文档位于 `examples/skeleton2d/windmill.json`，使用完全相同的应用层、编辑器和导出协议。

`node --test test/skeleton2d.test.mjs` 覆盖采样语义、非法文档、不可变历史、并发双写、文件篡改、通用导出绕过、应用命令、固定模块路径和独立样例 CLI 往返。浏览器预览与宿主实际运行的验收应分别记录，技术测试不代表动画美术已经人工认可。

`test/skeleton2d-canvas.test.mjs` 在真实 Canvas 上检查仿射区域的半透明像素一致性、分区 T 接点、孔洞、相反绕序、变形与刚性面混合、折叠重叠和外轮廓泄漏。`npm ci` 安装固定的 `@napi-rs/canvas` 开发依赖；也可用 `FWV_CANVAS_MODULE` 指向已有模块。缺少 Canvas 实现会使测试失败，不跳过像素验收。像素回归只保证所覆盖的绘制情形，不保证所有变形网格的半透明边缘逐像素相同，也不代表复杂宿主角色达到目标帧率；后两项须在实际素材、画布尺寸和浏览器中测量。
