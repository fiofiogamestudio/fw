# Fw Use

## 用户
- 维护 `fw/` 框架的人。
- 在 Godot 工程里接入 `fw/` 的人。

## 操作
常用生成：

```powershell
.\fw\tools\gen.ps1 system
.\fw\tools\gen.ps1 bridge
.\fw\tools\gen.ps1 config
```

常用构建：

```powershell
.\fw\tools\build.ps1
```

Release 构建：

```powershell
.\fw\tools\build.ps1 -Release
```

新项目骨架：

```powershell
.\fw\tools\new.ps1 -ProjectRoot . -Name MyGame
```

## 配置
宿主项目通过 `fw.toml` 指定 C# 项目和生成器：

```toml
[csharp]
project = "wdc.csproj"
core_dir = "csharp/core"
bridge_dir = "csharp/bridge"

[generator]
project = "fw/csharp/FwGen/FwGen.csproj"
```

## 验证
框架或工具链改完后，优先执行：

```powershell
dotnet build .\fw\csharp\FwGen\FwGen.csproj
.\fw\tools\gen.ps1 system
.\fw\tools\build.ps1
godot --headless --path . --quit-after 3
```
