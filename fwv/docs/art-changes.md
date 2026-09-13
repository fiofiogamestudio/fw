# 素材问题、候选和人工评审

素材中心以确切资产版本建立修改请求，保存问题、保持范围、像素选区、对象名称、动作时刻及视图条件。原素材、修改候选、人工评审和采用版本分开记录；顶层 FWE 保存仍只保存编辑参数。

`fwv.project.json` 的可选 `changes` 数组是持久真值。旧项目没有该字段时按空列表读取。创建候选、追加评审以及采用均复用项目写锁和原子索引替换；候选文件仍属于原来的不可覆盖资产版本。读取接口不自动发起生成、挂接候选或采用版本。

## 2D 工作流

1. 固定原素材 ID 和版本，填写问题与保持范围，可框选原图像素区域。
2. 确定性加工创建独立候选；图像服务使用原始图片和完整请求；本地 Agent 通过任务说明读取确切文件并回填已导入的候选版本。
3. 生成任务返回图片后可继续“保存候选”。生成任务和精确输出已落盘时，重启后可以继续入库；相同请求编号不再次调用模型。尚无可恢复结果的未知任务不自动重发。
4. 人工接受或驳回候选并保留意见。技术检查只说明文件/图片/Spine 结构检查结果，不替代人工决定。
5. 采用前重新检查候选文件身份、完整性和原素材当前选择版本。候选复制为原素材的新版本并切换选择；原版及独立候选保留。其他操作已改变原素材版本时拒绝采用，避免覆盖用户后来作出的选择。

带选区的图像生成/外部回填默认使用 `preserve-outside`：完整候选画面按两个轴映射到原图尺寸，然后只替换选区内 RGBA 像素。选区外保持原图解码后的精确像素，半透明/擦除也在选区内直接替换，不能通过 alpha-over 残留原像素。记录原始输入、归一尺寸、选区和合成配方，保留模型原始结果及参考文件。候选尺寸不同会改变选区内图像比例，仍须检查构图与边缘；该方法不提供语义分割。显式 `regionMode: "reference"` 才只保存选区约束而不合成。本地整体尺寸/边距加工不使用局部合成。

## 应用与 HTTP 合同

所有写操作经 `POST /api/fwv/commands`，请求为 `{type, payload}`，成功为 `{ok:true,result}`。除了 `change.prepare`，下表命令的 `result` 都是更新后的单条 change。来源/CSRF 和项目身份检查沿用现有工作台服务。

| 命令 | payload |
| --- | --- |
| `change.create` | `sourceAssetId, sourceRevisionId, title, request`；可选 `preserve, anchors` |
| `change.prepare` | `changeId`；返回 `prompt, source, sourceFiles, anchors, change, completion`，不执行模型 |
| `change.candidate.process` | `changeId, recipe`；可选 `requestId, note`；从问题固定原版加工 |
| `change.candidate.generate` | `changeId, requestId`；可选补充 `prompt, size, quality, background` |
| `change.candidate.recover` | `changeId, jobId`；保存原生成结果并登记候选 |
| `change.candidate.attach` | `changeId, assetId, revisionId`；可选 `note, execution, regionMode` |
| `change.candidate.validate` | `changeId, candidateId` |
| `change.review` | `changeId, candidateId, decision`；`accepted` 可附 `comment`，`rejected` 必须附意见 |
| `change.adopt` | `changeId, candidateId` |

读取 `GET /api/fwv/changes` 返回 `{changes:[]}`；指定 `?changeId=...` 返回 `{change}`。

`anchors` 可含 `region:{x,y,width,height}`（像素整数）、`objects:string[]`、`animation:{name,time}`（秒）和 `view`（有限 JSON）。对象/动作锚点允许未来专业域扩展，保存这些字段不表示当前已实现 3D 编辑。

候选包含 `id, assetId, revisionId, input, scope, validation, review, reviews, execution`。`review.decision` 为 `pending/accepted/rejected`；`status` 另外反映当前采用状态。`validation.humanAcceptance` 始终维持技术检查原有的 `not-reviewed` 语义，独立 `review` 才记录该问题上的人工决定。采用版元数据保存人工评审快照，导出包可追溯。

生成记录位于 `change.generations`，每项包含用户请求编号、精确生成输入、服务身份、`jobId/status/canRecover` 和候选关联。图像生成服务凭据仍由既有配置管理，不放进修改请求。

## CLI 与外部 Agent

```powershell
node bin/fwv.mjs changes --project D:/Art/Game
node bin/fwv.mjs change-prepare --project D:/Art/Game --change <change-id>
node bin/fwv.mjs change --project D:/Art/Game --file command.json
```

`command.json` 直接包含同一 `{type,payload}`，CLI 调用 `executeChangeCommand`，没有第二套修改逻辑。API 生图由 CLI 发起时等待该任务结束再退出；结果恢复/候选评审仍是显式命令。外部 Agent 先导入自己的真实结果，再用 `change.candidate.attach` 回填确切资产/版本及实际执行来源；不会把发出任务说明显示成模型已执行。

## 验证边界

`test/changes.test.mjs` 覆盖完整采用、拒绝、源版冲突、文件损坏、跨实例并发、选区外逐像素保留、真实任务服务重启与暂存恢复、CLI/HTTP 同真值及 CSRF。生成部分用测试 provider，不证明真实模型的美术质量。目标引擎内效果仍须在相应宿主验收。
