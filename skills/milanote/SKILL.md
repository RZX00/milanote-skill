---
name: milanote
description: >-
  通过 opencli milanote 读写已登录的 Milanote 网页：画板、便签、分栏、链接、待办、连线、草图、批注、文档、表格、图片、文件和评论。用户提到 Milanote、mailnote、milanote-CLI、opencli milanote、米兰笔记、画板，或要求查看、创建、修改、移动、上传、评论、删除 Milanote 内容时使用。
---

# Milanote

只用 `opencli milanote` 操作已登录的 Milanote。不要在页面里执行脚本，不要另开 Socket.IO，不要读取 Chrome cookie 或把 permission token 写进文件。

命令以 `opencli milanote --help` 和 `opencli milanote <command> --help` 为准。本文件和 CLI 不一致时，以 CLI 为准。

## 开始

每次会话的第一次 Milanote 调用前先跑。`<本技能目录>` 是这份 SKILL.md 所在的目录：

```bash
export PATH="$HOME/.hermes/node/bin:$HOME/.local/bin:$PATH"
export OPENCLI_BROWSER_COMMAND_TIMEOUT=120
bash <本技能目录>/scripts/preflight.sh
opencli milanote whoami -f yaml
```

Windows 上用 PowerShell：先 `$env:OPENCLI_BROWSER_COMMAND_TIMEOUT='120'`，用 `opencli milanote types -f json` 代替 preflight，再 `whoami`。

`whoami` 给出 `homeBoardId`。之后的 `--parent` 用画板 id，不要用用户 id。用户 id 是 24 位十六进制。元素 id 是 16 位字母和数字，并且以 `1` 开头。

输出始终加 `-f yaml`。要交给程序解析时用 `-f json`。写操作退出码为 0 表示当前打开的编辑器已经把它放进画布，并且没有把它记成已删除。接口里能查到还不够。退出码不是 0 就不要再发一次同样的创建。

## 命令

| 意图 | 命令 |
|---|---|
| 当前用户和主画板 | `opencli milanote whoami -f yaml` |
| 主画板下的画板 | `opencli milanote boards --limit 100 -f yaml` |
| 一层子元素 | `opencli milanote board <id> -f yaml` |
| 单个元素 | `opencli milanote get <id> -f yaml` |
| 嵌套结构 | `opencli milanote tree --id <id> --depth 2 -f yaml` |
| 按文字查找 | `opencli milanote search --query "文字" --parent <id> -f yaml` |
| 评论 | `opencli milanote comments <id> -f yaml` |
| 画板 | `opencli milanote create --type board --title "标题" --parent <id> -f yaml` |
| 分栏 | `opencli milanote create --type column --title "标题" --parent <boardId> -f yaml` |
| 便签 | `opencli milanote create --type note --text "正文" --parent <id> -f yaml` |
| 链接 | `opencli milanote create --type link --url "https://..." --title "标题" --parent <id> -f yaml` |
| 待办清单 | `opencli milanote create --type checklist --title "标题" --text $'一项\n二项' --parent <id> -f yaml` |
| 待办项 | `opencli milanote create --type task --text "一项" --parent <checklistId> -f yaml` |
| 色块 | `opencli milanote create --type swatch --color "#336699" --parent <id> -f yaml` |
| 图片 URL | `opencli milanote create --type image --url "https://..." --parent <id> -f yaml` |
| 连线 | `opencli milanote create --type line --parent <boardId> -f yaml` |
| 带笔画的草图 | `opencli milanote draw --parent <boardId> -f yaml` |
| 批注 | `opencli milanote create --type annotation --text "正文" --parent <boardId> -f yaml` |
| 文档 | `opencli milanote create --type document --title "标题" --text "正文" --parent <boardId> -f yaml` |
| 表格 | `opencli milanote create --type table --parent <boardId> -f yaml` |
| 别名 | `opencli milanote create --type alias --target <elementId> --parent <boardId> -f yaml` |
| 本地文件 | `opencli milanote upload --file ./a.png --parent <id> -f yaml` |
| 评论 | `opencli milanote comment --text "评论" --parent <id> -f yaml` |
| 修改 | `opencli milanote update <id> --text "新正文" -f yaml` |
| 复制 | `opencli milanote duplicate <id> -f yaml` |
| 表格单元格 | `opencli milanote cell --id <tableId> --row 0 --col 0 --text "值" -f yaml` |
| 移动 | `opencli milanote move <id> --parent <id> -f yaml` |
| 删除 | `opencli milanote delete <id> --yes true -f yaml` |

便签正文支持 `**粗体**`、`*斜体*`、`~~删除线~~`、`` `代码` ``、`[文字](https://...)`。`2 * 3` 保持原文。

位置：画布用 `--x` 和 `--y`（必须同时给），分栏和清单用 `--index`。都不给就按节点占地找空位，不会压到已经在画布上的元素。指定的坐标如果会重叠，命令会失败。清单里只能创建待办。

连线：接口不返回连线的起止元素和标签，`create --type line` 也不能指定连到哪两张卡片。要看箭头关系，用 `opencli browser <会话> open <画板URL> --window background` 打开画板，`opencli browser <会话> screenshot <路径>` 截图，看完 `opencli browser <会话> close`。要把线连到卡片上，按「写不进时：改走界面」操作。

## 写入怎样才算成功

编辑器只画出自己接受的元素。下面三种写法会被接口保存，但画布上看不见，客户端还会把 id 记成已删除：

- 元素 id 不是 16 位、或不以 `1` 开头。
- `creationSource` 用了 `opencli` 这种编辑器不认识的值。要用编辑器自己的值，默认是 `DOUBLE_CLICK`。
- `versionId` 写成 `msid-...`。它必须是元素 id 的前 11 位再加 `-1`。

命令已经按这三条发送，并在发送后检查编辑器状态。不要自己另写一套 `dispatch` 绕过命令。接口返回了元素、但画布上没有，就是这次写入失败。

## 必须遵守的限制

- 草图的第一笔用 `draw`，或 `create --type sketch --svg '<svg ...>'`。SVG 必须有正的 `width`、`height` 和一个 `<path>`。空草图之后不能补上第一笔。已有笔画的草图用 `update <id> --svg '...'` 整段替换。
- 文档标题只能在创建时设置。之后改正文用 `update <id> --text`，它写入描述。读回的 `text` 优先是描述。
- 便签和批注用 `--text`，不用 `--title`。分栏用 `--title`。
- 上传上限 4MB。文件卡片的 `url` 出现即可，标题可以仍是空的。
- `duplicate` 是一份内容副本，不是会跟着原件更新的克隆。
- 表格单元格是字符串。行和列从 0 开始。
- 搜索最多展开 500 个元素。超出时缩小 `--depth` 或 `--parent`。
- 不要删除或复制主画板。自己建的、标题以 `opencli-probe` 开头的画板，结束前删掉。

到期日、反应、指派、分享和回收站恢复没有命令。写入走 `~/.opencli/clis/milanote/` 里的命令。不要在页面里另写 `dispatch`。

## 失败时

同一条命令最多重试一次。

- 扩展未连接：`opencli doctor`。扩展只在装了它的那个 Chrome 配置里连得上；Chrome 没开时，用那个配置打开 `https://app.milanote.com/`，约 10 秒后再查。仍失败就停，请用户连上 OpenCLI Chrome 扩展。不要改用 cookie。
- 创建报 `did not persist`，或删除报 `did not delete`：这块画板不收命令写入，重试也没用。读命令照常可用。写入改走下一节。
- `SESSION_BUSY`，或报错里的进程已经不在：`opencli daemon restart`，等 `opencli doctor` 正常，再重试。
- 超时：确认 `OPENCLI_BROWSER_COMMAND_TIMEOUT=120`。创建超时后先 `board <parent>`，元素已经在就不要再建。
- 页面在 `/maintenance`：停。Milanote 维护时写不进去。
- 未登录：`opencli milanote login`，等用户在打开的 Chrome 里登录，然后再 `whoami`。

## 写不进时：改走界面

共享画板，以及主画板下的一块普通画板，曾拒收命令写入：创建报 `did not persist`，删除报 `did not delete`，原因未查明（2026-10-19）。同一块画板用编辑器界面写入可以保存。

1. 不应往页面里注入脚本或派发合成事件（`paste`、`dblclick` 等）来绕过。注：这违背本技能「不在页面里执行脚本」的约定，Claude Code 的自动权限检查也会拦下。
2. 应改用能按坐标点击和拖拽的浏览器工具，以真实输入操作画布，例如 Claude 桌面版的内置浏览器。该浏览器未登录 Milanote 时，应请用户自己登录；Agent 不应代填账号密码。
3. 定位前宜做只读查询：`.CanvasViewport` 的 `scrollLeft`、`scrollTop`，以及 `.CanvasElement[data-element-id]` 的屏幕矩形。屏幕位置 = 画布左上角 + 格坐标 × 每格像素 − 滚动量。每格像素随缩放变化（见过 8 和 10 CSS 像素），应拿一张已知格坐标的元素反算。截图像素与 CSS 像素之比，按截图宽度 ÷ `innerWidth` 换算。
4. 建便签：在空白处双击，点击位置即便签左上角，并对齐到网格；新便签直接处于编辑状态。可用 `ctrl+b` 开关粗体、`Return` 分段、`Escape` 结束编辑，再单击空白处取消选中。
5. 连线：把左栏 Line 拖到画布上，生成一根斜线，起点在落点左下、终点（箭头）在右上，各距落点约四分之一张便签宽。随后分两次把两端拖到目标卡片中部，松手即附着，线端停在卡片边缘。落点应选在两个端点都不压卡片的位置。注：端点压在卡片上时，下一次拖拽会拖走卡片，而不是端点。
6. 删除：可把元素拖到左栏 Trash。
7. 撤销（`ctrl+z`）可能留下一根宽高为 0 的空连线，画布上看不见。读回时多出的 LINE，宜先查它的屏幕尺寸再判断。
8. 完成后应用 `opencli milanote board <画板id> -f yaml` 读回，核对新元素的数量、坐标和文字。
9. 便签处于编辑状态时，也可用 `opencli browser <会话> type '.Element[data-element-id="<id>"] .ProseMirror' "<文字>"` 输入文字。注：`.ProseMirror` 匹配画布上的每张便签，应以元素 id 限定。
