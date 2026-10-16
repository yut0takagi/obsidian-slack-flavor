# Slack Flavor

![Downloads](https://raw.githubusercontent.com/yut0takagi/obsidian-slack-flavor/main/.github/stats/badge.svg)

![Download history](https://raw.githubusercontent.com/yut0takagi/obsidian-slack-flavor/main/.github/stats/downloads.svg)

Write Slack-formatted messages in Obsidian and see them the way Slack shows them, with your workspace's custom emoji.

- **`slack` code blocks** render Slack mrkdwn (`*bold*` `_italic_` `~strike~` `` `code` `` quotes, links, mentions, `:emoji:`) and whole conversations with threads and reactions.
- **Custom emoji from your workspaces.** Register one or more Slack workspaces; `:party_parrot:` shows that workspace's image in code blocks, reading view and live preview. Type `:pa` to pick from a list. Emoji lists refresh themselves, and images you have seen are kept locally so they also show offline.
- **Copy as Slack text.** Turn a note or selection into mrkdwn that formats correctly when pasted into Slack.
- **Import a thread.** Paste a message link and get the thread as a `slack` block (or as a Markdown callout). Refresh the block later to pick up new replies and reactions.

## Installation

- **Community plugins**: in Obsidian, open **Settings → Community plugins → Browse**, search for **Slack Flavor**, then **Install** and **Enable**.
- **Manually**: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/yut0takagi/obsidian-slack-flavor/releases/latest) into `<vault>/.obsidian/plugins/slack-flavor/`, then enable **Slack Flavor** in Settings → Community plugins.

Requires Obsidian 1.11.4 or later.

## `slack` code blocks

````markdown
```slack
workspace: acme
channel: #general
source: https://acme.slack.com/archives/C0123ABCD/p1790731800000100

@田中 10:30
明日の *定例* は14時からです :party_parrot:
+:tada: 3 :eyes: 1

↳ @山田 太郎 10:32
了解です
```
````

| Line | Meaning |
| --- | --- |
| `workspace:` / `channel:` / `title:` / `source:` at the top | Optional. `workspace:` picks whose custom emoji to use. `source:` is the thread's Slack link, written on import; it shows as **Open in Slack** in the header and lets the block be refreshed. |
| `@name [time]` at the top or after a blank line | Starts a message. Time is `HH:MM` or `YYYY-MM-DD HH:MM`. Without a time the name must be one word. |
| `↳ @name` or `>> @name` | A thread reply to the previous message. |
| `+:emoji: count …` as the last line of a message | Reactions. |

A block without any `@name` line is rendered as a single piece of mrkdwn, handy for previewing a message before you send it.

Messages in the body use Slack's syntax: `<https://example.com|label>`, `<@U123|name>`, `<#C123|channel>`, `<!here>`, `:emoji::skin-tone-3:`.

Mentions are shown and copied as text. The formatted copy (see below) turns `<@U123|name>` into the plain text “@name” and `<#C123|channel>` into “#channel”, so pasting a block into Slack **does not create a mention or notify anyone**. The plain-text copy keeps the block's text exactly as written.

### Slack's formatting rule

Slack only formats `*` `_` `~` when the character before the opening marker and after the closing marker is a space, punctuation or a line edge. `これは*太字*です` is **not** bold in Slack; `これは *太字* です` is. The preview follows the same rule so it matches what people will see. Turn off **Slack's formatting rules** in settings to format them anyway.

## Workspaces and custom emoji

The workspace used for emoji is chosen in this order:

1. the block's `workspace:` line (name, domain like `acme` / `acme.slack.com`, or team id)
2. the note's `slack-workspace` property
3. the default workspace (click the status bar item or run **Switch Slack workspace**)

### Getting a token

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**, pick the workspace and paste:

   ```yaml
   display_information:
     name: Obsidian Slack Flavor
   oauth_config:
     scopes:
       user:
         - emoji:read
         - channels:history
         - groups:history
         - im:history
         - mpim:history
         - users:read
         - channels:read
         - groups:read
   ```

   Only `emoji:read` is needed if you do not import threads. Your workspace may require admin approval to install apps.
2. **Install to Workspace**, then copy the **User OAuth Token** (`xoxp-…`).
3. In Obsidian: **Settings → Slack Flavor → Add workspace**, give it a name, click the token field and create a secret with the token, then **Fetch emoji**.

The token is kept in Obsidian's secret storage (Obsidian 1.11.4+); the plugin's `data.json` only stores the secret's name. Emoji lists are saved per workspace in the plugin folder (`emoji/<id>.json`).

### Keeping emoji up to date

- **Emoji lists** are fetched again a few seconds after Obsidian starts once they are older than **Refresh emoji lists automatically** (default: every 7 days; can be turned off). If that fails, the saved list stays in use. Being offline is not reported; a Slack error such as a revoked token shows one notice. **Fetch emoji** in the settings and **Refresh custom emoji for all workspaces** still refresh on demand.
- **Emoji images** are saved the first time they are displayed and shown from the saved copy afterwards, also offline. **Emoji image cache** in the settings sets the size limit (default 50 MB; the oldest images are removed first; Off disables it) and has a **Clear cache** button.

## Copy as Slack text

Run **Copy selection or note as Slack text** (also in the editor's right-click menu), then paste into Slack.

The clipboard gets three formats at once:

| Type | Used by |
| --- | --- |
| `slack/texty` | Slack's message box (a Quill editor). Bold, italic, strike, code, links, nested lists, quotes and code blocks paste as real Slack formatting, **whether or not "Format messages with markup" is on**. |
| `text/html` | Other apps (docs, mail). |
| `text/plain` | Plain Slack mrkdwn, for plain-text fields and the Web API. |

`slack/texty` is written through a copy event so Chromium stores it the way Slack does (as web custom data). The format is Slack's internal one, found via [slackfmt](https://github.com/cauethenorio/slackfmt); if Slack changes it, pastes fall back to the HTML.

Some platforms (mobile ones in particular) do not accept the formatted copy. The plugin then copies the plain mrkdwn only and says so in a notice; it still pastes formatted in Slack when **Format messages with markup** is on in Slack's preferences.

The plain-text version is converted like this:

| Obsidian | Slack |
| --- | --- |
| `**bold**` `__bold__` `==highlight==` | `*bold*` |
| `*italic*` `_italic_` | `_italic_` |
| `~~strike~~` | `~strike~` |
| `# Heading` | `*Heading*` |
| `- item` (nested) | `• item` / `◦ item` / `▪ item` |
| `- [ ] task` / `- [x] task` | `☐ task` / `☑ task` |
| `[text](url)` | `<url\|text>` |
| `[[note\|alias]]` | `alias` |
| tables | wrapped in a code block |
| `> [!note] Title` | `> *Title*` |
| frontmatter, `%%comments%%`, `![[embeds]]`, `^block-ids` | removed |
| `slack` code blocks | pasted as-is |

In the plain-text version, markers next to Japanese text get a half-width space (`これは *太字* です`) so Slack formats them. You can turn this off. The rich format needs no spaces.

## Importing a thread

In Slack, choose **Copy link** on a message or a reply, then run **Import Slack thread from link** in the note. The workspace is picked from the link's domain when it matches a registered one. User names and `#channel` mentions are resolved; the result is inserted at the cursor.

**Insert as** picks the format (the default is in the settings under **Importing threads**):

- **Slack block**: a `slack` block that looks like Slack, with a `source:` line linking the thread.
- **Markdown (callout)**: an ordinary `> [!quote]` callout with each message's author and time in bold, Slack formatting converted to Markdown and the channel linked to the thread. It reads fine in any Markdown app; custom emoji in it use the note's workspace.

To update an imported block with new replies and reactions, put the cursor in it and run **Refresh Slack thread in block** (if the note has only one imported block, the cursor can be anywhere). The block is rewritten from Slack, keeping its `workspace:` and `title:` lines; anything else you edited inside it is replaced. Blocks imported before 0.2.0 have no `source:` line; import them again to make them refreshable.

## Network use and privacy

- Requests with your token go only to `https://slack.com/api/` (`auth.test`, `emoji.list`, `conversations.replies`, `conversations.info`, `users.info`): when you fetch emoji, import or refresh a thread, and at startup for emoji lists older than the refresh interval.
- Custom emoji images are loaded from the URLs Slack returns (`emoji.slack-edge.com`). The first time an image is displayed, the plugin also downloads it once with a plain request (no token or other credentials) and saves it in `<vault>/.obsidian/plugins/slack-flavor/emoji-cache/` (inside your configuration folder, not among your notes). From then on it is shown from that copy. Only images are stored there, under hashed file names.
- Nothing is sent anywhere else. There is no telemetry.

## Development

```bash
npm install
npm test            # vitest
npm run build       # main.js
npm run gen:emoji   # regenerate src/emoji/standard.json from emoji-datasource
npm run check       # type check + tests + production build (what CI runs)
```

Releases: bump `version` in `manifest.json`, `package.json` and `versions.json`, merge, then push a tag with the bare version (e.g. `0.1.0`). The release workflow builds and attaches `main.js`, `manifest.json` and `styles.css`.

Standard emoji names come from [iamcal/emoji-data](https://github.com/iamcal/emoji-data) (`emoji-datasource`), the data set Slack's names are based on.

---

## 日本語

Obsidian で Slack の書式を書いてプレビューし、ワークスペースのカスタム絵文字を使うためのプラグインです。

- ```` ```slack ```` ブロックに Slack 記法（mrkdwn）や会話を書くと、Slack と同じ見た目で表示します
- ワークスペースを登録すると、そのカスタム絵文字（`:承知:` など）をブロック・閲覧モード・ライブプレビューで画像表示します。`:` のあとに2文字打つと候補が出ます
- ノートや選択範囲を Slack 用の書式に変換してコピーします。日本語に隣接する装飾記号には半角スペースを補います
- Slack のメッセージリンクからスレッドを取り込み、```` ```slack ```` ブロック（または Markdown のコールアウト）として挿入します。取り込んだブロックは **Refresh Slack thread in block** で最新の返信・リアクションに更新できます
- 絵文字の一覧は一定期間（既定 7 日）ごとに起動時に自動で更新します。一度表示した絵文字の画像はプラグインのフォルダに保存し、オフラインでも表示します
- ブロック内のメンション（`<@U123|name>`）は書式付きコピーでは「@name」という文字になり、Slack に貼ってもメンションにはなりません

Slack では `これは*太字*です` のように日本語に直接くっついた記号は装飾されません。プレビューもこれに合わせています（設定で変更できます）。
