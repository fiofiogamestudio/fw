# Fw Use

## 新建项目
```powershell
.\fw\tools\new.ps1 --name MyGame
```

生成后检查：
```powershell
.\fw\tools\build.ps1
godot --headless --path . --quit-after 3
```

## 生成
```powershell
.\fw\tools\gen.ps1 system
.\fw\tools\gen.ps1 bridge
.\fw\tools\gen.ps1 config
```

生成内容：
- `system`：生成 GD system graph/register，并在存在 `schema/core_system.toml` 时生成 C# core system 注册表和 phase 常量。
- `bridge`：生成 GD bridge wrapper 和 C# bridge 合同，合同包含字段、事件、输入和网络包类型常量。
- `config`：生成 C# typed config 和配置字段常量，并保留现有 GD config 入口。

## 修改模板
- 改规范文档模板：`fw/templates/fw_new/default/docs/fw/*.md.tpl`
- 改 Godot 模板：`fw/templates/fw_new/default/scripts`
- 改 C# 模板：`fw/templates/fw_new/default/csharp`

## 提交前同步模板
`fw/hooks/pre-commit` 会在提交 `fw` 仓库时自动同步：

- 宿主 `docs/fw/*.md` -> `fw/templates/fw_new/default/docs/fw/*.md.tpl`

`fw/tools/build.*`、`fw/tools/gen.*` 和 `fw/tools/new.*` 会自动设置：

```powershell
git -C fw config core.hooksPath hooks
```

## 验证
```powershell
dotnet build .\fw\csharp\FwGen\FwGen.csproj
.\fw\tools\build.ps1
godot --headless --path . --quit-after 3
```
