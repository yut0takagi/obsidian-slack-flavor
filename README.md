# Slack Flavor

Write Slack-formatted messages in Obsidian and see them the way Slack shows them, with your workspace's custom emoji.

- **`slack` code blocks** render Slack mrkdwn (`*bold*` `_italic_` `~strike~` `` `code` `` quotes, links, mentions, `:emoji:`) and whole conversations with threads and reactions.
- **Custom emoji from your workspaces.** Register one or more Slack workspaces; `:party_parrot:` shows that workspace's image in code blocks, reading view and live preview. Type `:pa` to pick from a list.
- **Copy as Slack text.** Turn a note or selection into mrkdwn that formats correctly when pasted into Slack.
- **Import a thread.** Paste a message link and get the thread as a `slack` block.

## Installation

Until the plugin is listed in Community plugins:

- **BRAT**: install [Obsidian42 - BRAT](https://github.com/TfTHacker/obsidian42-brat), then *Add beta plugin* with `yut0takagi/obsidian-slack-flavor`.
- **Manually**: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/yut0takagi/obsidian-slack-flavor/releases/latest) into `<vault>/.obsidian/plugins/slack-flavor/`, then enable **Slack Flavor** in Settings → Community plugins.

Requires Obsidian 1.11.4 or later.

## `slack` code blocks

````markdown
```slack
workspace: acme
channel: #general

@田中 10:30
明日の *定例* は14時からです :party_parrot:
+:tada: 3 :eyes: 1

↳ @山田 太郎 10:32
了解です
```
````

| Line | Meaning |
| --- | --- |
| `workspace:` / `channel:` / `title:` at the top | Optional. `workspace:` picks whose custom emoji to use. |
| `@name [time]` at the top or after a blank line | Starts a message. Time is `HH:MM` or `YYYY-MM-DD HH:MM`. Without a time the name must be one word. |
| `↳ @name` or `>> @name` | A thread reply to the previous message. |
| `+:emoji: count …` as the last line of a message | Reactions. |

A block without any `@name` line is rendered as a single piece of mrkdwn, handy for previewing a message before you send it.

Messages in the body use Slack's syntax: `<https://example.com|label>`, `<@U123|name>`, `<#C123|channel>`, `<!here>`, `:emoji::skin-tone-3:`.

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

## Copy as Slack text

Run **Copy selection or note as Slack text** (also in the editor's right-click menu), then paste into Slack.

The clipboard gets three formats at once:

| Type | Used by |
| --- | --- |
| `slack/texty` | Slack's message box (a Quill editor). Bold, italic, strike, code, links, nested lists, quotes and code blocks paste as real Slack formatting, **whether or not "Format messages with markup" is on**. |
| `text/html` | Other apps (docs, mail). |
| `text/plain` | Plain Slack mrkdwn, for plain-text fields and the Web API. |

`slack/texty` is written through a copy event so Chromium stores it the way Slack does (as web custom data). The format is Slack's internal one, found via [slackfmt](https://github.com/cauethenorio/slackfmt); if Slack changes it, pastes fall back to the HTML.

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

## Network use and privacy

- Requests go only to `https://slack.com/api/` (`auth.test`, `emoji.list`, `conversations.replies`, `conversations.info`, `users.info`) and only when you fetch emoji or import a thread.
- Custom emoji images are loaded from the URLs Slack returns (`emoji.slack-edge.com`) whenever they are displayed.
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
- Slack のメッセージリンクからスレッドを取り込み、```` ```slack ```` ブロックとして挿入します

Slack では `これは*太字*です` のように日本語に直接くっついた記号は装飾されません。プレビューもこれに合わせています（設定で変更できます）。
