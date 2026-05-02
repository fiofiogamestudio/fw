---
name: fw
description: 按 fw 规范维护 Godot + C# 游戏工程。
---

# Fw

## 输入
- 先读 `docs/fw/rule.md`。
- 再读 `docs/fw/spec.md`。
- 需要说明操作方式时读 `docs/fw/use.md`。
- 处理 Godot 表现层、C# core、bridge、config、system graph、fw 模板和生成链。

## 流程
1. 先判断改动属于规则、结构、操作还是具体实现。
2. 长期原则只同步 `docs/fw/rule.md`，除非用户明确要求，否则不要擅自改规则。
3. 当前结构、链路、事实源变化同步 `docs/fw/spec.md`。
4. 操作流程、命令、开发步骤变化同步 `docs/fw/use.md`。
5. 修改 `fw/` 框架或模板后，同步 `fw/docs` 与 `fw/templates/fw_new/default`。
6. 涉及生成链时运行对应生成命令，再运行构建验证。

## 输出
- 代码、配置、文档或模板改动。
- 必要的验证结果。
