# 安装说明（供 Agent 执行）

## 1 范围

本文件供 Agent 在用户要求安装 milanote-skill 时执行。安装内容是两部分：技能 `milanote`（给 Agent 读的使用说明），和 OpenCLI 适配器（提供 `opencli milanote` 命令）。

## 2 术语和定义

2.1 OpenCLI：第三方命令行工具（github.com/jackwener/opencli），通过 Chrome 扩展操作用户已登录的网页。本仓库不包含它。

2.2 适配器：本仓库 `opencli/clis/milanote/` 下的脚本，安装后位于 `~/.opencli/clis/milanote/`。

2.3 安装脚本：`install.sh`（macOS、Linux、Windows 的 Git Bash）和 `install.ps1`（Windows PowerShell）。

2.4 已测试宿主：技能装好后被加载，并完成过一次读写的 Agent 环境。本仓库只在 Claude Code（Windows 11，OpenCLI 1.8.8）上测试过。

## 3 前置条件

3.1 应先运行 `opencli --version`。命令不存在时，应告知用户先安装 OpenCLI（`npm install -g @jackwener/opencli@1.8.8`，需要 Node.js 20.18.1 或更高），并停止；不应自行安装 OpenCLI 或 Node.js。注：本仓库用 1.8.8 验证过，2.x 未测试；版本不同时应告知用户。

3.2 OpenCLI 的 Chrome 扩展不能由 Agent 安装。应请用户自己安装，并运行 `opencli doctor` 确认扩展已连接。

3.3 应请用户在装了该扩展的 Chrome 里登录 Milanote。不应代填账号或密码。

## 4 安装步骤

4.1 运行前，应向用户列出将写入的位置，并取得同意：

| 位置 | 内容 |
|---|---|
| `~/.cursor/skills/milanote/` | 技能 |
| `~/.claude/skills/milanote/` | 技能 |
| `~/.codex/skills/milanote/` | 技能 |
| `~/.agents/skills/milanote/` | 技能 |
| `~/.opencli/clis/milanote/` | 适配器 |
| `~/.opencli/sites/milanote/notes.md` | 协议验证记录 |

脚本会先删除这些位置里的同名旧目录再复制。即使用户没有使用其中某个宿主，脚本也会创建对应目录。

4.2 应运行下列一条命令，不应改动脚本内容：

```bash
# macOS / Linux / Git Bash
curl -fsSL https://raw.githubusercontent.com/RZX00/milanote-skill/main/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/RZX00/milanote-skill/main/install.ps1 | iex
```

4.3 用户已克隆本仓库时，可在仓库根目录运行 `bash install.sh`，它会就地复制，不下载。用户想先看结果时，可运行 `HOME=<临时目录> bash install.sh`，内容装到该目录而不是用户主目录。

4.4 Claude Code 的插件方式（`/plugin marketplace add RZX00/milanote-skill`）只安装技能，不安装适配器，且本仓库未实测。用户选择它时，应告知这两点，并仍运行 4.2 的脚本或把 `opencli/clis/milanote/` 复制到 `~/.opencli/clis/milanote/`。

## 5 验证

5.1 应运行 `opencli milanote types -f yaml`。它不打开 Chrome，应列出 `whoami`、`boards`、`create` 等命令，不报错。

5.2 应请用户新开一个会话，技能在会话开始时加载。新会话里应确认技能列表中有 `milanote`。

5.3 可请用户运行 `opencli milanote whoami -f yaml` 确认登录。输出含账号邮箱，Agent 不应把它写入文件或转发。

5.4 应把第一句可用的话告诉用户，见 7。

## 6 卸载

6.1 应删除 4.1 表中的全部位置，并先请用户确认。

## 7 示例

<examples>
<example>
用户：帮我安装 milanote-skill。
Agent：先运行 `opencli --version`，确认 OpenCLI 已装且为 1.8.8；请用户确认 Chrome 扩展已连接（`opencli doctor`）、Milanote 已登录。再列出 4.1 的写入位置，用户同意后运行 4.2 的命令，随后运行 `opencli milanote types -f yaml` 验证。最后说：「请新开一个会话，然后对我说：用 milanote 技能，列出我主画板下的画板。」
</example>
</examples>
