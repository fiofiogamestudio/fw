# 本地 Agent 模式

角色换皮支持 `local` 和 `api` 两种执行方式。新建方案默认本地；旧方案保留 API 设置。

本地指任务、参考图、分析和结果保存在当前电脑，由当前 Codex 对话领取任务并调用可用的内置图像工具。FWV 不需要 API Key；理解由当前 Agent 完成，生图使用 Codex 内置能力及其额度。模型不在本机离线运行。工作台创建任务不会自行唤醒对话，也不会把 ChatGPT 登录态变成通用 HTTP API。

在工作台选择「本地 Agent」，填写需求并建立任务，复制任务指令到当前对话即可让 Agent 执行。Agent 应先看参考图，提交部件分析，再登记一次调用并生成；返回图自动装配，页面持续显示进度和候选。

API 模式仍通过用户配置的 Images 服务执行，适合独立运行与批量生产。两种模式共用布局、图像校验、局部重做、版本和 Spine 装配。

## Agent 执行接口

CLI 在 FWV 目录运行，所有命令显式使用同一 `--project`。以下尖括号内容替换为真实 ID 和路径，不要直接照抄。

```powershell
node bin/fwv.mjs local-claim --project <project> --workflow <workflowId> --attempt <attemptId> --worker codex-current --out <task-bundles-directory>
```

输出独立目录中的 `task.json`、`reference.png` 和 `prompt.txt`，参考图通过项目原始哈希校验。领取凭据只交给 worker，不出现在普通查询或复制指令中。同一 worker 重试返回同一凭据，其他 worker 不可抢占。

先查看参考图，再写分析 JSON，包含 `summary` 字符串、以部件区域名为键的 `partNotes` 对象和 `risks` 字符串数组。它们是生产判断和提示词输入，不是额外模型的虚构调用记录。

```powershell
node bin/fwv.mjs local-analyze --project <project> --task <task.json> --analysis-file <analysis.json>
node bin/fwv.mjs local-dispatch --project <project> --task <task.json>
```

使用 `local-analyze` 返回的新 `promptPath` 及原 `reference.png` 调用图像工具。`local-dispatch` 必须紧挨真实调用之前执行；重复调用登记会拒绝，不能据此再次生图。所需结果为保持布局的 1024×1024 图片。先保存工具原文件，再导入：

```powershell
node bin/fwv.mjs import --project <project> --file <actual-generated.png> --name <result-name>
node bin/fwv.mjs local-complete --project <project> --task <task.json> --image-asset <importedAssetId> --image-revision <importedRevisionId> --provider codex-builtin --model gpt-image-2 --tool image_gen
```

执行来源必须填写实际服务、模型与工具；自动测试明确记录 `test-fixture` 等模拟来源。完成命令校验领取凭据、输入版本、尺寸和哈希，保存生成来源与参考图并自动装配。相同结果再次完成是幂等的；不能覆盖成另一张图。API 同名命令为 `reskin.localClaim/localAnalyze/localDispatch/localComplete/localFail`，普通读取为 `GET /api/fwv/reskin/local-task?workflowId=...&attemptId=...`。

如果内置工具未遵守尺寸，回填仍拒绝错误画布。先保留原图并检查布局；仅在确认整个画布可等比归一时，显式使用现有 `process --width 1024 --height 1024 --padding 0 --fit contain` 生成派生版本，再提交该版本。不要使用 `--trim` 或把非方形输出拉伸成方形。记录原始尺寸及此处理步骤；整体缩放不能修复模型产生的局部位置漂移，原 RGB 图也不会因此自动去掉背景。确定性处理无需再次调用模型。

## 中断与验收

等待、领取、分析、派发和输出身份均持久保存。重启不会自动重发生图。已经派发但未确定结果时保留 `unknown` 或等待结果状态，应找回原工具输出；不要自动重试模型。显式取消后，晚到的图片可独立导入素材库，但不得自动复活取消任务或选用候选。

worker 中断可运行 `local-fail --project <project> --task <task.json> --message <实际原因>`。派发前标记终止，派发后标记未知；后者允许原 worker 确认原输出并完成，仍禁止重新派发。

返回图已经入库但装配失败时，可重试本地装配；不需要再次生图。任务包和已导入图片不自动删除。模型是否守住位置、轮廓、关节和一致画风仍需查看真实动画；技术校验不能代替美术验收。
