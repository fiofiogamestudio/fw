# 已有 Spine 骨骼与单项权重修复

素材中心的骨骼修复读取确切已有 Spine 版本。与模板换皮保留骨骼 JSON 不同，这项操作确实修改指定骨骼或既有权重，产出独立候选；只有人工接受并采用后才成为原素材的新版本。

格式限于现有 Spine 4.2 JSON + 文本 Atlas + PNG 合同。解析依据 [Spine JSON 格式](https://esotericsoftware.com/spine-json-format) 和本地官方 `@esotericsoftware/spine-core` 4.2.120 `SkeletonJson.readVertices`：weighted mesh 为每个顶点记录 influence 数量，随后依次为骨骼索引、绑定 X/Y、权重。该实现不通过更改版本标记兼容其他版本。

## 可检查的内容

- 骨骼父级、子级、setup pose 的 x/y/rotation/scaleX/scaleY/shearX/shearY/length。
- 每根骨骼参与的动画属性与约束、动画已有时间范围、零缩放提示。
- 独立 mesh 的顶点数、influence 数、权重未归一的顶点，以及指定顶点的骨骼名称/绑定坐标/权重。
- linkedmesh，以及官方 4.2 同样支持的 `type:mesh` 带 `parent` 形式，均标记共享几何，不能在该工具中单独改权重。

## 有界修改

骨骼操作仅修改指定 setup pose 字段或父级。父级必须是骨骼数组中更早的现有骨骼，不能为自己、后代或未知名称；根骨骼不更改父级。保持原骨骼数组顺序使权重的骨骼索引继续有效。父级变化保留该骨骼的局部数值，不保持其世界空间姿势，因此后代的世界姿势也会变化。

单项权重操作仅调整独立 weighted mesh 某顶点已经存在的 influence。所选权重设为指定值，其余既有 influence 按比例分配剩余权重；不增加骨骼，不改变绑定坐标、其他顶点或拓扑。若其他 influence 都为零且需要分配剩余权重，直接拒绝，不推断新的绑定。存在关联网格的源 mesh 也拒绝此操作，避免未说明的跨附件影响。

未知字段、非有限/过大数值、父子环、需重新排序的父级、非法顶点结构、超界骨骼索引和不完整权重编码在登记候选前拒绝。JSON 重新序列化；未选中骨骼的字段、slot、动画与约束内容不改，Atlas 和贴图维持原始字节。JSON 序列化后的文件哈希自然会变化。

## 命令

读取使用 `change.spine.inspect`，可在创建问题前传 `{assetId,revisionId}`；创建问题后传 `{changeId}` 固定基线。可追加 `mesh:{skin,slot,attachment},vertexIndex` 查询某个权重顶点。结果包含 `bones,meshes,vertex,animations,diagnostics,capabilities,limits`，不会生成候选。

写入使用 `change.candidate.spine-repair`：

```json
{
  "changeId": "change_...",
  "requestId": "fix-body-parent-1",
  "boneEdits": [
    {"boneName": "body", "parent": "pelvis", "local": {"x": 8, "y": 53}}
  ],
  "weightEdits": [
    {"skin": "default", "slot": "body-slot", "attachment": "body", "vertexIndex": 0, "boneName": "body", "weight": 0.75}
  ]
}
```

两类 edits 均可省略，但至少一项实际修改。相同 `requestId` 与相同修改幂等；不同修改不得复用编号。命令返回更新后的 change，新增候选包含 `metadata.spineRepair.edits` 的 before/after 明细。评审和采用使用已有 `change.review`、`change.adopt`；CLI 用 `fwv change --file` 执行完全相同的命令。

本机测试使用官方 4.2 Runtime 读取修复前后骨骼，核对父级变换后的实际世界坐标，并采样 idle/wave 的 0/0.3/0.6 秒。权重测试核对仅指定顶点权重数值改变，以及官方 Runtime 计算的网格世界顶点保持有限。测试不代表任意商业素材、动作自然度或目标游戏引擎已验收。
