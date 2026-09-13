# 从立绘制作骨骼角色

这条流程让没有 Spine 模板的项目从一张角色图片开始：建立拆件草稿 → 校正部件轮廓和关节点 → 生成骨骼与基础动作 → 预览、导出，或继续整套换皮。裁切、绑定和动作预设均为本地操作，不调用图像模型。

## 工作台操作

1. 在「立绘拆件与骨骼」中选择图片和确切版本，建立六部件人形草稿。默认分区只是标注起点，需要对照角色修正；优先使用透明背景、四肢舒展的正面立绘。
2. 选择头、躯干或四肢，用多边形标出部件轮廓，设置关节点。调整父子关系与前后绘制顺序；配饰可以另加部件。
3. 选择需要的基础动作，点击「创建拆件版本」，然后生成骨骼候选。顶部保存或 Ctrl+S 只保留编辑参数和工作进度；仍有待应用参数时不能构建。切换工作页会保留这些参数，撤销、重做仍由 FWE 提供。
4. 检查实际 Spine 动画，必要时返回草稿调整关节点或分区，再创建新候选。候选保存对原草稿版本的引用，原图与旧候选保持不变。
5. 导出候选的 JSON、Atlas 和 PNG，或把它作为「角色换皮流程」的新模板，继续调用已配置模型生成新外观。

一张扁平立绘只包含可见像素。抬手后露出的腋下、被头遮住的颈部等内容不会自动补全；分区互相覆盖时也可能出现重复像素。该版本提供可校正的裁切与刚性部件绑定，不宣称自动语义分割、遮挡补画或加权网格变形。基础动作使用规则预设，复杂动作仍需专门制作。

## 坐标与版本

拆件草稿为 `kind=rig` 的资产。`rig.json` 与 `metadata.rig` 保存同一份文档，原图字节作为参考文件随版本保存。加载时验证文件完整性及文档一致性。

每个部件包含稳定 ID、名称、语义角色、父部件 ID、多边形与关节点。所有点均采用源图左上角为原点的像素坐标。`parts` 数组从后到前决定绘制顺序，父子关系单独决定骨骼层级；重新排列绘制顺序不会改变绑定关系。

构建时将关节点转换成 Spine 父骨骼局部坐标，并设置部件相对于骨骼的偏移，使静止姿势保留源图位置。裁切保留原透明度，使用独立图集区域，生成 Spine 4.2 的 region 附件。结构参考 [Spine JSON 格式](https://esotericsoftware.com/spine-json-format)，以匹配的本地 4.2 运行时解析与浏览器播放为实际验证。

保存以预期版本进行并发检查。另一窗口先保存时，旧窗口的写入会被拒绝，不能静默覆盖。构建读取指定草稿版本并产生新的 Spine 资产；相同草稿可以生成多个候选，不能把候选误当成后续草稿版本。

历史拆件版本在编辑器中只读。「从此版本继续制作」创建独立的拆件副本，复制该版本的原图字节、部件和动作，并在文档及配方中记录 `forkedFrom: {assetId, revisionId}`。原拆件的所有版本及当前选择保持不变。历史缓存或并发冲突留下的有效编辑参数也会带入副本；无效标注仍须通过生产验证。副本创建后可以继续调整、创建版本和构建候选，它自身也遵守预期版本检查。

## 应用接口

Node 导入 `fwv/rig`，所有函数第一个参数为 `FwvProject`：

| 函数 / HTTP 命令 | 参数 |
| --- | --- |
| `createRigDraft` / `rig.create` | `sourceAssetId, sourceRevisionId, name, preset: "humanoid6"` |
| `saveRigDraft` / `rig.save` | `assetId, revisionId, parts, motion` |
| `forkRigDraft` / `rig.fork` | `assetId, revisionId`，可选 `name, parts, motion` |
| `buildRigCandidate` / `rig.build` | `assetId, revisionId` |
| `loadRigDraft` / GET `/api/fwv/rig/draft` | `assetId, revisionId` |

写操作返回 `{asset, revision}`，读取还返回 `document`。HTTP 命令经现有 `/api/fwv/commands` 派发，沿用工作台来源及 CSRF 校验。

CLI 使用相同应用函数：

```powershell
node bin/fwv.mjs rig-create --project D:/Art/Game --source-asset <image-id> --source-revision <revision-id> --name "角色拆件"
node bin/fwv.mjs rig-inspect --project D:/Art/Game --asset <draft-id> --revision <draft-revision-id>
node bin/fwv.mjs rig-save --project D:/Art/Game --asset <draft-id> --revision <draft-revision-id> --file annotations.json
node bin/fwv.mjs rig-build --project D:/Art/Game --asset <draft-id> --revision <saved-revision-id>
```

`annotations.json` 只能包含 `parts` 与 `motion`，不能通过该文件修改源图引用。`motion` 为 `{ "idle": true, "walk": true, "wave": true }` 形式的动作开关。

## 验证边界

草稿允许预设部件暂时落在透明区域，以便继续编辑；实际构建时空部件会被拒绝。无效多边形、越界坐标、父子环、源图损坏和超出尺寸预算均在候选写入前检查。

技术检查与运行时播放不等于美术验收。模型生成效果、关节接缝、遮挡关系、动作自然度，以及目标 Godot/Unity 项目中的效果需要另外验证。最终测试结果见[验收记录](validation.md)。
