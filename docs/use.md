# Fw Use

## 用户
- 开发 Godot + C# 游戏工程的人。
- 需要维护表现层、核心规则、bridge、config 或 fw 模板的人。

## 操作
- 改长期规则：先确认用户明确要求，再改 `docs/fw/rule.md`。
- 改当前结构或原理：同步 `docs/fw/spec.md`。
- 改操作方式：同步 `docs/fw/use.md`。
- 改 Godot 或 C# system：先看 `schema/systems.toml`，再运行 `fw/tools/gen.ps1 system`。
- 改 bridge 协议或网络包字段：先改 `schema/bridge/*.proto`，再运行 `fw/tools/gen.ps1 bridge`。
- 改配置 schema 或配置字段：先改 `schema/config/*.proto` 和 `data/config/*`，再运行 `fw/tools/gen.ps1 config`。
- 需要检查配置源：运行 `fw/tools/gen.ps1 config_check`。
- 需要生成发布配置包：运行 `fw/tools/gen.ps1 config_pack`，产物放到 `pack/config`。
- 改 C# core：先看 `csharp/core` 的 `system / rules / state / config`，保持 bridge 对外接口稳定。
- 改 Godot 表现层：优先看 `scripts/mode/<mode>` 下的 `system / feature / shared`。
- 改 fw 模板：同步 `fw/templates/fw_new/default`。

## 新建
```powershell
.\fw\tools\new.ps1 -Name MyGame
```

```bash
./fw/tools/new.sh --name MyGame
```

生成后运行验证：
```powershell
.\fw\tools\build.ps1
godot --headless --path . --quit-after 3
```

## 生成
```powershell
.\fw\tools\gen.ps1 system
.\fw\tools\gen.ps1 bridge
.\fw\tools\gen.ps1 config
.\fw\tools\gen.ps1 config_check
.\fw\tools\gen.ps1 config_pack
```

- `system`：读取 `schema/systems.toml`，生成 Godot system 入口和 C# core system 入口。
- `bridge`：读取 `schema/bridge/*.proto`，生成 Godot bridge wrapper、C# bridge types、基础 codec 和 packet codec。
- `config`：读取 `schema/config/*.proto`，生成 Godot config 入口、C# typed config、配置字段/路径常量和配置 codec。
- `config_check`：检查 `schema/config` 与 `data/config` 的基本一致性。
- `config_pack`：读取 `schema/config` 与 `data/config`，生成 `pack/config/*.bin`。

## 验证
```powershell
.\fw\tools\build.ps1
godot --headless --path . --quit-after 3
```

`fw/tools/build.*`、`fw/tools/gen.*` 和 `fw/tools/new.*` 会在检测到 `git` 时自动设置 fw hook：
```powershell
git -C fw config core.hooksPath hooks
```

## 新增 Core System
1. 新增 `csharp/core/system/<name>_system.cs`，实现 `ISystem<CoreContext>`。
2. 只通过 `CoreContext` 访问 `Refs / Config / State`。
3. 在 `schema/systems.toml` 的 `core.system.<id>` 声明 system、phase 和 type。
4. 运行 `fw/tools/gen.ps1 system` 生成 `csharp/_gen/_core_systems.cs`。
5. `GameCore.Step()` 交给 `CoreRuntime.Tick()` 按生成顺序推进，不手写 phase 顺序。
6. 同步 `docs/fw/spec.md`。

## 模板
- 改 `fw/` 框架后，同步 `fw/docs` 与 `fw/templates/fw_new/default`。
- `fw/hooks/pre-commit` 会在提交 fw 仓库时同步宿主 `docs/fw/*.md` 到 `fw/docs/*.md` 与模板文档。
