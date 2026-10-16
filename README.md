# Milanote Skill

![Milanote Skill banner](assets/banner.jpg)

让 AI agent 读写你已经登录的 [Milanote](https://app.milanote.com/) 画板。

An agent skill plus an [OpenCLI](https://github.com/jackwener/opencli) adapter. It reads and writes the Milanote account that is already signed in inside Chrome. It does not ask for a password, and it does not copy cookies into the skill.

## 能做什么 / What it does

画板、分栏、便签、链接、待办、连线、草图、批注、文档、表格、图片、文件和评论。创建、读取、修改、移动、复制、上传和删除都走 `opencli milanote`。

Boards, columns, notes, links, tasks, lines, sketches, annotations, documents, tables, images, files, and comments. Create, read, update, move, copy, upload, and delete go through `opencli milanote`.

## 安装 / Install

先装好 OpenCLI，并在 Chrome 里装上 [OpenCLI 扩展](https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk)。然后在浏览器里登录 Milanote。

Install OpenCLI first, install the Chrome extension, and sign in to Milanote in that browser.

```bash
# macOS / Linux。可以先打开脚本看一遍再运行。
curl -fsSL https://raw.githubusercontent.com/RZX00/milanote-skill/main/install.sh | bash
opencli doctor
opencli milanote whoami -f yaml
```

```powershell
irm https://raw.githubusercontent.com/RZX00/milanote-skill/main/install.ps1 | iex
```

### Claude Code plugin

```text
/plugin marketplace add RZX00/milanote-skill
/plugin install milanote@milanote-skill
```

插件只带上 Skill 说明。真正读写画板的命令在 `opencli/clis/milanote/`，仍要跑上面的安装脚本，或把那个目录复制到 `~/.opencli/clis/milanote/`。

The plugin ships the skill instructions. The commands that actually touch a board live in `opencli/clis/milanote/`. Run the install script, or copy that directory to `~/.opencli/clis/milanote/`.

脚本会把 Skill 装到这些位置，并把适配器装到 `~/.opencli/clis/milanote/`：

- Cursor: `~/.cursor/skills/milanote/`
- Claude Code: `~/.claude/skills/milanote/`
- Codex: `~/.codex/skills/milanote/`
- Agent skills: `~/.agents/skills/milanote/`

装好后重启 agent，或新开一个会话。然后直接说：「读一下我的 Milanote 画板。」

## 使用 / Usage

```bash
opencli milanote boards -f yaml
opencli milanote board <画板id> -f yaml
opencli milanote create --type note --text "记下这一点" --parent <画板id> -f yaml
```

完整命令表在 [`skills/milanote/SKILL.md`](skills/milanote/SKILL.md)。协议里已经验证过的限制在 [`opencli/sites/milanote/notes.md`](opencli/sites/milanote/notes.md)。

## 它不会做的事

- 不读取 Chrome cookie，也不把登录令牌写进仓库。
- 不删除、不复制你的主画板。
- 文档标题只能在创建时设定。之后改的是正文。
- 草图的第一笔必须在创建时写上。空草图不能事后补第一笔。
- 每个人用自己已经登录的 Milanote。这个仓库里没有账号。

## License

[MIT](./LICENSE) © rzx00
