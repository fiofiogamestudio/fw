# Fw Use

## 接入
- 前提：工程根目录已有 `project.godot`，并把 `fw/` 放在根目录。
- 空目录也可由默认模板创建最小 `project.godot`；已有文件默认不会覆盖。
- 初始化：`powershell -ExecutionPolicy Bypass -File fw/tools/new.ps1 -ProjectRoot . -Name MyGame`。
- Linux/macOS：`bash fw/tools/new.sh --project-root . --name MyGame`。
- 项目名必须以字母开头，只使用字母、数字和下划线；C# namespace 会自动转换成 PascalCase。
- `fw.toml` 只写模板列出的 section/key，路径使用工程根目录内的相对路径；未知字段、重复字段、空值或 `../` 越界路径会直接失败。
- `new` 会生成 system/bridge/config，随后运行配置检查和整体检查；失败不会报告创建成功。
- `project.godot` 必须包含 `[dotnet] project/assembly_name="<project name>"`；`fw check` 会在运行前发现不一致。

## 日常命令
- 生成 system：`fw/tools/gen.ps1 system`。
- 生成 bridge：`fw/tools/gen.ps1 bridge`。
- 生成 config：`fw/tools/gen.ps1 config`。
- 检查配置：`fw/tools/gen.ps1 config_check`。
- 打包配置：`fw/tools/gen.ps1 config_pack`。
- 检查工程：`fw/tools/check.ps1`。
- 完整构建：`fw/tools/build.ps1`。
- 完整测试：`fw/tools/test.ps1`。
- Unix 使用同名 `.sh` 脚本；Windows/Unix 默认 build 流程一致。

## 修改 System
1. 修改 `schema/systems.toml`。
2. Godot system 声明 phase、script、context 和 context refs。
3. C# core system 声明 phase 和 type。
4. 运行 `fw/tools/gen.ps1 system`。
5. 不手改 `_godot_systems.gd` 或 `_core_systems.cs`。

## 修改 Bridge
1. 按语义修改 `schema/bridge/value.proto`、`intent.proto`、`view.proto`、`event.proto` 或 `packet.proto`。
2. 只使用 `fw/docs/spec.md` 声明的 proto3 子集。
3. 运行 `fw/tools/gen.ps1 bridge`。
4. 任意未知语法或重复字段都会阻止生成，先修 schema，不绕过 parser。
5. 五个 proto 必须保留固定语义与共享 package；不要新建第六类 bridge proto。

## 修改 Config
1. 只改数据值：修改 `data/config/*.csv.txt` 或 `.json`，运行 `config_check`，发布前运行 `config_pack`。
2. 改字段/schema 或切换 CSV/JSON 文件布局：同步 schema/data，再运行 `config`、`config_check`、`config_pack`。
3. 使用小数定点时在 schema 声明一次空 `message Fixed32 {}`，字段类型写 `Fixed32`；不要给 marker 添加字段。

## C# Node
- GDScript 需要创建 C# bridge Node 时调用 `FCSharp.create_node("res://csharp/bridge/<name>_bridge.cs")`。
- C# 文件名、类名必须大小写完全一致，类型必须继承 `Godot.Node`。
- 若创建失败，先检查 Godot .NET、Debug 构建和 `project.godot` assembly name，不回退到裸 `script.new()`。

## 表现对象
- Pool 创建：`pool.spawn(key, parent, owner, props)`。
- Pool 回收：`pool.recycle(node)`。
- UI 打开：`ui.open(layer, id, scene, context, props)`。
- UI 关闭：`ui.close(id)`。
- 状态对象由 logic 调用 `apply(vm, dt)`。
- 一次性 fx 由 logic 调用 `play(payload)`，监听 `finished` 后回收。
- logic 通过 context 数据入口或 intent 提交操作，不保存 system 本体。

## 验证
- 最小验证：`fw/tools/check.ps1`。
- 提交前验证：`fw/tools/test.ps1`。
- 测试会创建并清理临时项目，不写入宿主工程。
- 本机安装 Godot .NET 时，测试会额外执行 headless 脚本扫描和主场景启动；可用 `GODOT_BIN` 指定版本，或用 `-SkipGodot` 跳过。
- 正式提交不应使用 `-SkipGodot`；该参数只用于明确缺少 Godot 的临时环境。

## Hook
- 框架维护者可显式启用：`git -C fw config core.hooksPath hooks`。
- hook 只同步 `fw` 自己的 skill/docs 到默认模板。
- 若同步产生差异，提交会停止；检查并暂存派生文件后再次提交。
- 普通 `new/gen/build` 不会修改 Git hook 配置。
