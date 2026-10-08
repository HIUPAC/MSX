---
description: CloudBase AI 开发工具包规则 - 支持 Web、小程序、CloudRun、NoSQL/MySQL 数据库、AI Agent 等全栈开发场景
alwaysApply: true
enabled: true
updatedAt: 2026-03-27T00:00:00.000Z
---

# CloudBase 规则加载入口

**🔒 MUST [ENTRY-LOAD]**：开始任何任务前，必须实际读取本目标项目根目录的 [CODEBUDDY.md](../../CODEBUDDY.md)，然后按其 A 部分执行契约及 B 部分专项路由工作。Markdown 链接不代表内容已经自动加载。

**🔒 MUST [ENTRY-SOURCE]**：`CODEBUDDY.md` 是统一主文档；本入口不保存执行阶段、UI、鉴权或部署流程的副本。已在当前会话读取时可复用，主文档被修改后必须重新读取。

**🔒 MUST [ENTRY-GAP]**：以本入口的相对链接定位主文档，并核对目标项目配置；读取失败时报告 `Gap：无法加载主契约 CODEBUDDY.md`，列出尝试路径及错误，停止业务代码生成。禁止回退到旧摘要或凭记忆猜规则。

**⚠️ [ENTRY-PACKAGE]**：入口跨目录使用或插件独立分发时，必须同时提供主契约及其引用文件，并保持链接可解析；缺失时执行上述 Gap 规则。

维护执行契约只修改 `CODEBUDDY.md`；部署流程只修改 `rules/cloudbase-execution/deployment.md`；专项接口按主文档的规则解析策略读取真实文件。
