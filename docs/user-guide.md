# User guide

[Back to Locality](../README.md) · [Tools reference](tools.md) · [Build editions](build-editions.md)

Start with the [installation and quick start](../README.md#install) in the README.
This guide covers model setup, everyday use, settings, and saved chats.

- [First-time setup](#first-time-setup)
- [Starting a chat and attachments](#starting-a-chat)
- [Chat modes](#chat-modes)
- [Commit message generation](#commit-message-generation)
- [Project instructions](#project-instructions-agentsmd)
- [Managing context](#managing-context)
- [Settings reference](#settings-reference)
- [Chat storage](#where-chats-are-stored)
- [Workspace memory](#workspace-memory)

## First-time setup

Click the Locality icon in the Activity Bar, then switch to the **Settings**
tab in the side panel. Configure the server and tool calling before chatting:

- **Server URL** — the address of your llama.cpp or vLLM server, e.g.
  `http://127.0.0.1:8080/v1` or `http://192.168.1.50:8080/v1`. It must be
  `localhost` or a private IP literal; DNS hostnames such as `nas.local` are
  refused. Click **Set** to validate the endpoint, list `/v1/models`, and read
  backend-specific metadata. Choose the model below the URL; its reported alias and
  context length are shown alongside it.
- **Tool calling** — defaults to **Native server only**, which requires
  OpenAI-compatible structured calls from the server. The Gemma 4, Qwen 3, Muse
  Glimmer, and GPT-OSS compatibility profiles still prefer structured calls,
  but can recover that family's exact syntax when it leaks into text. Gemma,
  Qwen, and GPT-OSS can also fall back to their legacy adapters when the server
  rejects native tools.
  Start `llama-server` with `--jinja` and a tool-aware chat template.

The other settings (sampling, auto-approve toggles, safe
commands) have sensible defaults and can be revisited later.

For edition-specific features, see [Safe-list configuration](tools.md#safe-list-configuration)
and [Advanced web search](tools.md#advanced-web-search).

### vLLM setup (v2.2.0)

Enter a local/LAN vLLM URL such as `http://127.0.0.1:8000/v1`, then click **Set**.
Locality automatically detects llama.cpp or vLLM and shows the detected server.
Proxies must expose the server's discovery and tokenizer endpoints. Root URLs,
`/v1` URLs, and proxy prefixes are supported. Choose the advertised model ID;
served aliases and LoRA entries are supported.

For a reasoning and tool-capable Qwen3 server, the vLLM 0.32.0 setup is:

```bash
vllm serve Qwen/Qwen3-4B --host 127.0.0.1 --port 8000 \
  --max-model-len 32768 --enable-auto-tool-choice \
  --tool-call-parser hermes --reasoning-parser qwen3
```

Choose **Native server only** in Locality. Other models need their corresponding
[tool parser](https://docs.vllm.ai/en/v0.32.0/features/tool_calling/) and
[reasoning configuration](https://docs.vllm.ai/en/v0.32.0/features/reasoning_outputs/).
Reasoning effort values must be supported by the served model. Finite reasoning
budgets use `thinking_token_budget` and require a configured reasoning parser or
reasoning boundaries; leave the budget empty for unlimited reasoning. Models
whose templates cannot disable thinking may still reason when the switch is off.

If the server uses `--api-key`, enter its key in the masked **API key** field and
click **Set** beside **Server URL**. A successful connection saves the new or replacement key
in VS Code SecretStorage. An empty field keeps the saved key. Keys are scoped to
the server URL and proxy prefix and are not stored in settings or chat history.

When connecting or selecting a model, Locality sends a tiny test image generated
entirely in memory and reports image input as **Supported** or **Unavailable**.
No test image file is created. vLLM only preprocesses the image; llama.cpp's check
generates at most one token. Authentication, invalid responses and server outages
remain connection errors instead of marking the model as text-only. Clicking
**Set** checks again. Actual vLLM image prompts are also preprocessed before generation.
The complete vLLM prompt, tools and image tokens are counted on the server for
the context guard, reserving up to 4,096 tokens (at most a quarter of the context)
for the answer. Auxiliary requests reserve their explicit output limits.
vLLM uses the normal waiting indicator without llama.cpp's
prompt-progress percentage.

Chat, planning, tools, compaction, memory, titles, and commit messages use the
same configured connection in every edition. Changing the connection applies
to subsequent turns; background memory work suspends and resumes with compatible
checkpoints. The [developer guide](developer-guide.md#live-server-validation)
records the compatibility baseline and how to run live acceptance tests.

Connection troubleshooting:

- **401/403:** set or replace the API key for this server.
- **Could not identify:** check the server URL and proxy routing. llama.cpp must
  expose `/props`; vLLM must expose `/v1/models` and `/tokenize`. A missing
  `/props` alone does not identify a server as vLLM.
- **Native tools rejected:** enable automatic tool choice and the model's parser.
- **Reasoning budget rejected:** configure reasoning boundaries/parser or clear
  the budget. Locality does not silently discard an explicit finite budget.
- **Context exceeded:** compact the chat or increase the server's `--max-model-len`.

### Muse Glimmer with llama.cpp

Muse Glimmer requires llama.cpp build `b10353` or newer and `--jinja`. Its
template emits `to=self` reasoning, `to=user` answers, and ATEM tool calls;
current llama.cpp converts those into `reasoning_content`, `content`, and
structured `tool_calls` before the harness receives them. Do not add `<|eom|>`
as a stop string: it ends one message within a turn, while `<|eot|>` ends the
turn. The model's trained context is 131,072 tokens, and llama.cpp divides `-c`
across `-np` slots, so size `-c` accordingly. Muse always opens a reasoning
channel; the harness can cap it, but the template does not fully disable it.

For Muse image input, also load the matching perception projector:

```bash
llama-server \
  -m Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf \
  --mmproj mmproj-Muse-Glimmer-30B-Q4_K_M.gguf \
  --jinja -c 131072
```

The text GGUF is text-only without `--mmproj`. The projector must match the
loaded model build.

## Starting a chat

Open the Locality panel and either:

- Click **+ New chat** on the Welcome page, or
- Click any past chat in the list to reopen it.

Type your question in the composer at the bottom of the chat panel and press
**Enter** to send. Use **Shift+Enter** for a newline. While the assistant is
responding, the send button turns into a stop button — click it (or the
cancel icon) to interrupt the current turn.

A new chat is saved and appears in Recent Chats only after its first prompt is
sent. Typing a draft, attaching files, renaming the tab, or changing its mode
does not save it. Closing an unused tab discards its draft and staged attachments.

Chats open in tabs at the top of the chat panel. Switching tabs or reopening the
current chat preserves its running response, tool approvals, queued messages,
and attachments. Multiple chats can run at once; the local server determines
how their requests are scheduled. A blue dot marks running chats in the tabs
and Recent Chats.

Right-click a tab or a Recent Chats entry and choose **Rename** to change its
title. The **×** closes a tab without stopping its chat: reopen it from Recent
Chats to see its progress or use Stop. Closing VS Code or changing workspaces
stops running chats.

The brain button selects reasoning behavior per chat. **None** sends
`chat_template_kwargs.enable_thinking: false`; **Default** sends no
`reasoning_effort` or thinking override. Additional choices come from the
`reasoningEfforts` setting and send its configured value as the server's
`reasoning_effort`. This is independent of the numeric reasoning budget.

For example, the default `settings.json` mapping is:

```json
"locality.reasoningEfforts": {
  "Low": "low",
  "Medium": "medium",
  "High": "high"
}
```

### File attachments

Click **Attach files** (the paperclip) to choose images or text/code files.
You can attach up to eight files, mix images with code, send files with or
without a message, remove them before sending, and queue them while another
turn is running. Click an image thumbnail to enlarge it or a text-file icon
to open the stored copy in the editor.

**Ctrl+V** attaches files supplied by the clipboard, including explicit local
file URI lists. File names and suffixes are preserved; a clipboard MIME label
is not trusted to identify code (for example, a `.ts` file is TypeScript text).
Ordinary short text pastes into the composer. Text of at least **10,000
characters or 200 lines** becomes a **Pasted text** attachment with no filename
suffix or claimed programming language. Copying a path as plain text does not
read the file automatically; copy the file itself or use the picker.

Text/code files support UTF-8 and UTF-16 with a byte-order mark, up to **1 MiB**
each. Binary documents such as PDF, Word, and ZIP are not supported. The harness
synthesizes a model-only prompt containing your message plus each file's name,
optional suffix, and exact decoded contents. This works in native and legacy
tool modes. The visible chat retains your original message and attachment cards.
Text contents count toward context limits and normal compaction; the original
stored files are preserved when model context is shortened.

JPEG, PNG, and WebP images support up to **10 MiB** each. Images are copied into
chat-owned local storage and replayed as native OpenAI-compatible `image_url`
parts, with their names and file types included as text metadata. The loaded
model must support vision and `llama-server` must use its matching `--mmproj`.
Each retained image conservatively reserves 4,096 context tokens. If a
compatibility chat switches to a legacy tool adapter, image messages require
restarting the server with `--jinja` and native tool support, then retrying in a
new chat. Text-only attachments do not require a vision model.

The assistant streams its response as it goes. If the model supports a
"thinking" mode, you'll see a collapsible **Thinking…** row above the
response — click it to read the reasoning. When the thought is done, the
label becomes **Thought for N seconds**.

Workspace files mentioned by the assistant can appear as clickable file links.
Click one to open it in the editor, or hover it to see the full workspace path.

The **Edited files** summary includes **Undo** for responses with saved file
snapshots. After confirmation, Undo restores the contents from before that
response and removes files it created. It preserves the conversation and marks
the edits **Undone**. Later file changes or unsaved editor contents prevent Undo;
older responses without snapshots show an unavailable Undo action. This applies
to the harness's file-edit tools, not changes made by shell commands.

History disclosures support Tab, Enter, and Space. Pending decisions say
**Awaiting approval** or **Awaiting your answer**; activity animation indicates
ongoing work. Completed todos use checkmarks, and cloud icons identify
workspace-local memories.

## Chat modes

The mode menu in the chat composer offers three ways to work:

- **Act mode** is the normal coding mode. The assistant can inspect the workspace,
  propose commands, and request approval for file changes.
- **Plan mode** restricts the assistant to read-only tools. It can browse and read
  files but cannot write or run commands, and it finishes with an implementation
  plan.
- **Review mode** uses read-only tools to gather evidence and provide answers and
  review findings. It cannot edit files or run commands.

Each message uses the mode selected when you send or queue it. Its bubble shows
the mode's icon and label beneath an inset divider. Changing the composer mode
affects future submissions; it does not change a running turn or messages already
in the queue. Editing or reordering queued messages preserves their modes.
Editing and resending a previously sent message uses the current composer mode.

Questions from the assistant appear in the composer with **A, B, C…** choices.
Click a choice to answer immediately, or write your own response and click
**Send** (Enter sends; Shift+Enter adds a line).

After each completed Plan response, a matching composer with the **Plan** icon
asks how to continue:

- **Accept plan** switches to Act and sends “I accept your plan. Please implement.”
  as an Act message, with the Act icon, and starts implementation in Act mode.
- **Request changes** submits the feedback you type directly in the approval field.
  Click the button or press Enter; Shift+Enter adds a new line. Your
  feedback appears as a Plan message, and the revised plan needs acceptance again.
- **Cancel planning** ends planning without implementing the plan and releases
  queued messages. The composer returns to Act mode.

Queued messages wait through the entire planning exchange, including all change
requests. Accepting the plan runs its Act implementation turn first, then resumes
the queue. Cancelling planning or stopping an active planning turn resumes the
queue without sending an acceptance message. Queued messages retain their
original modes and order. Planning and pending approval survive reopening the
chat; submitting revisions keeps the same read-only restrictions.

Use plan mode for anything non-trivial. It gives you a chance to redirect
before files are touched.

## Commit message generation

Open VS Code's **Source Control** view after staging changes. The Locality
button in the Source Control title bar can generate a commit message
from the staged diff.

- If staged changes exist, hover text reads **Generate commit message with
  Locality**. Click the button to send the staged diff to your configured
  local model endpoint and write the generated message into Git's commit
  input box.
- If nothing is staged, hover text reads **Please stage changes before
  generating a commit message.** Clicking the button briefly wiggles the icon.
- While the model is working, the icon gently jumps like an active tool. The extension only drafts the
  message; it does not commit anything.

By default, the prompt asks for an imperative, concise subject line and a short
body only when it adds useful context. You can replace those instructions under
**Settings → User settings → Edit User Settings**—for example, to require
Conventional Commits, scopes, issue identifiers, or a particular body format.
The staged diff is always appended automatically.

## Project instructions (`AGENTS.md`)

Create an `AGENTS.md` file in the root of the folder you open in VS Code. Use it
for project context, coding conventions, build/test commands, and instructions
you want the assistant to follow across conversations. Locality Harness loads it
automatically in every edition and in Act, Plan, and Review modes; no setting or
file attachment is needed.

For example, adapt this to your project:

```markdown
# Project instructions

- This is a TypeScript application. Keep strict typing enabled.
- Reuse existing components and follow the surrounding code style.
- Run `npm run typecheck` and the relevant tests after changing code.
- Keep changes focused on the current request.
```

Save the file and send your next message. Changes take effect without reloading
VS Code or creating a new chat. Delete the file or leave it empty to stop supplying
project instructions. Keep the contents focused: they use part of the model's
context window on each request.

### How the harness loads instructions

1. **Find the root file.** The extension host looks for `AGENTS.md` in the active
   workspace root. In a workspace with multiple folders, Locality uses the first
   folder. It does not search parent folders or load nested `AGENTS.md` files.
2. **Refresh before building the prompt.** The harness checks the file's
   modification time and reuses cached contents while that timestamp is unchanged.
   A changed file is read as UTF-8. Missing, unreadable, non-file, and empty entries
   are ignored. Loading is handled by the host, so the assistant does not need a
   `read_file` call or a read-approval prompt to receive these instructions.
3. **Include a bounded instruction block.** Leading and trailing whitespace is
   trimmed. Content exceeding **16 KiB of UTF-8 bytes** is truncated without
   splitting a character, then marked with `[AGENTS.md truncated]`. The text is
   inserted into the system prompt between `begin AGENTS.md` and `end AGENTS.md`
   markers, with a reminder that your chat messages take precedence.
4. **Account for context usage.** The instruction block is included in the system
   prompt's token count. It is rebuilt with the prompt, rather than stored as a
   chat message, so it remains available after conversation compaction.

The project block follows the harness's general and mode-specific instructions.
It is included with both native and text-based tool calling. Instructions can
guide the assistant's work, but cannot enable unavailable tools, bypass approval
settings, or change the workspace and network boundaries. Listing a test command
in `AGENTS.md` does not execute it automatically or give No commands an executor.

The implementation is in the [AGENTS.md loader](../src/llm/agentsMd.ts),
[system-prompt builder](../src/llm/prompt.ts), and
[chat session's prompt and context handling](../src/chat/session.ts).

## Managing context

A small ring on the composer toggle bar shows how full the model's context
window is. It updates during streaming with an estimate for incoming thinking,
text, and tool content, then uses server-reported usage when available. These
live estimates do not trigger compaction. When it gets close to full:

- **Auto-compact** (on by default) summarizes older parts of the
  conversation when context reaches the configured threshold (80% by
  default).
- If auto-compact is off, the context ring turns red at that threshold so
  you can compact manually before the next request gets too large.
- You can also click the context ring at any time to compact immediately.

With **Auto-compact** enabled, a response cut short by a generation limit gets
one recovery attempt per turn. The harness discards that unfinished response,
compacts the saved context when enough history is available, and continues with
a request for a shorter response or smaller edits. Completed tool results and
file changes are retained. If compaction fails or the retry reaches the limit
again, the error remains visible. A server output limit or excessive reasoning
can still cause this failure even when context has room.

Compaction summarizes older details in the model's context so it has room to
keep working. The saved chat and visible history retain the original messages
and file attachments. The model receives the summary and recent context;
if an older detail matters, quote it in a new message. Resending an edited
message asks for confirmation before removing later messages, tool results,
and thinking from both the chat and model context. Canceling keeps your edit
draft. Workspace file changes remain.

Editing or deleting a message preserves any compacted context preceding it.
If the message was itself summarized, context is rebuilt from the retained
transcript so the discarded messages cannot survive in a summary. Context
usage is recalculated before the next request; compaction can still occur if
the retained history and system instructions reach the configured threshold.

## Settings reference

All keys below use the `locality.` prefix in VS Code settings JSON.
Only settings supported by the installed edition are available.

| Setting | Default | What it does |
| --- | --- | --- |
| `endpoint` | `http://localhost:8080/v1` | URL of your llama.cpp or vLLM server. Use `localhost` or a private IP literal such as `http://127.0.0.1:8080/v1` or `http://192.168.1.50:8080/v1`. |
| `model` | `local` | Model id sent with requests. Choose a served model or alias from `/v1/models`. |
| `toolCallingMode` | `native` | Select `native`, `compat-gemma4`, `compat-qwen3`, `compat-muse-glimmer`, or `compat-gpt-oss`. Compatibility profiles are native-first and add only the selected family's recovery behavior. |
| `temperature` | `0.8` | Sampling temperature for chat requests. Lower is more deterministic, higher more varied. |
| `topK` | `40` | Top-k sampling: keep only the K most likely tokens at each step (`0` disables). |
| `topP` | `0.95` | Top-p (nucleus) sampling: keep the smallest token set whose cumulative probability reaches p (`1` disables). |
| `reasoningBudget` | `-1` | Per-request reasoning budget: `-1` is unlimited, `0` ends reasoning immediately, and a positive number is the token threshold. |
| `reasoningEfforts` | `{ "Low": "low", "Medium": "medium", "High": "high" }` | Additional chat-menu choices. Keys are display labels and values are sent as `reasoning_effort`; built-in None and Default remain available. |
| `titlePrompt` | `Summarize the user message…` | Instructions for generating chat titles. The first user message is appended automatically. |
| `commitMessagePrompt` | `Write a concise Git commit message…` | Instructions for generated commit messages. The staged diff is appended automatically, so this can enforce formats such as Conventional Commits. |
| `autoCompact` | `true` | Summarize old turns automatically near the context limit. |
| `autoCompactThresholdPercent` | `80` | Context usage percentage that triggers auto-compaction. |
| `autoapproveReads` | `true` | Skip approval for read-only file tools. |
| `autoapproveWrites` | `false` | Skip approval for file-edit tool calls. Off by default. |
| `autoapproveCommands` | `false` | Commands and Advanced: skip command approval in Act mode. |
| `autoapproveSafeCommands` | `false` | Safe list: skip approval for every matching command in Act mode. |
| `safeCommandPatterns` | Built-in regex list | Safe list: whole-command patterns in user settings; empty means deny all. |
| `webSearchEndpoint` | `https://api.search.brave.com/res/v1/web/search` | Advanced: Brave Web Search URL or SearXNG base URL, configured and tested in Settings. Empty or unverified omits both web tools. |
| `autoapproveWebSearch` | `false` | Advanced: auto-approve searches and page reads in Act, Plan, and Review modes. User settings only. |

The generated-text settings are instruction strings, not templates, so they do
not need variables. The harness constructs the requests as follows:

```text
<titlePrompt>

User message: "<first user message>"
```

```text
<commitMessagePrompt>

<staged_diff>
<staged Git diff>
</staged_diff>
```

The **Reset** section at the bottom of the Settings tab has a **Restore all
defaults** button that returns every setting above — including the server URL —
to its default. It asks for confirmation first.

The sampling settings (`temperature`, `topK`, `topP`) are sent with every chat
request, so they override the server's sampling defaults for either backend.
Commit-message generation also uses the
configured temperature. Titles, memories, and context compaction keep their own
fixed low-temperature settings.

## Where chats are stored

Chats are saved in your home folder under `~/.locality/`, not inside the
workspace. Each chat record stores the workspace folder it belongs to, and the
Recent Chats list only shows records whose folder matches the currently open
workspace. This keeps chat transcripts out of recursive workspace commands such
as `grep`. Image attachments are stored beside the chat records in a restricted
attachment directory and are removed when their chat or source message is
deleted, including when editing an earlier message discards later turns.
Compaction alone does not delete saved attachments.

Chat and memory lists load a small workspace index from `~/.locality/indexes/`.
They do not load conversation transcripts. Each chat file also has a versioned
metadata header, so its listing can be recovered independently of the transcript.
The index is updated when chats change, and changes from other windows are
reconciled in the background. Existing chat files are converted once, preserving
their contents and attachments, when their workspace index is first built.

Use **Locality: Rebuild Chat Index** from the Command Palette to recreate the
current workspace's index from the chat headers. Missing or invalid indexes are
also rebuilt automatically. This repairs listings; it does not repair damaged
transcript contents. A chat with a readable header remains listed even if its
transcript cannot be opened, and its saved file is kept.

You can delete a chat by hovering its row in the Welcome list and clicking the
trash icon. Deleting cannot be undone.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Enter` | Send message |
| `Shift+Enter` | Newline in composer |

## Privacy & isolation

- The model endpoint validator refuses DNS hostnames other than exact `localhost`;
  use loopback, link-local, CGNAT, or RFC 1918 private IP literals.
- File tools cannot read or write outside the workspace root.
- Commit-message generation reads only staged changes (`git diff --cached`)
  and sends that diff to the configured local/LAN endpoint.
- Search results display compact URL links. Approved searches may also fetch each
  result site's `/favicon.ico` through the public-web network guard, without cookies
  or API credentials. Missing icons use a globe; titles and snippets still reach the model.
- Only Advanced includes search and webpage reading, with approval per request by default.
  **Auto-approve web requests** skips those prompts when enabled. General commands run with your normal
  permissions and can fetch URLs, call APIs, install packages, or access files
  outside the workspace. Command approval is required by default; enabling
  **Auto-approve commands** permits these actions without a prompt in Act mode.

## Workspace memory

Memories are independent workspace notes stored as versioned JSON files in
`.locality/memories/<uuid>.json`. Each record has a name, Markdown contents,
creation/update dates, and an enabled flag. Notes belong to the workspace;
deleting or clearing chats does not delete them. Git ignore rules are unchanged.
Old chat summaries remain readable in historical chats and are not imported.

Two independent workspace switches are off by default:

- **Tools > Activate memories** (`locality.memoryEnabled`) exposes
  `create_memory`, `search_memories`, and `recall_memory`, independently of
  file tools. Saving notes is automatic in Act, Plan, and Review, without an edit
  approval prompt. Search and recall retain the read-approval setting.
- **Chat > Auto-load memories** (`locality.memoryAutoLoad`) ranks enabled notes
  for every new user query, including queued messages and steering. The old
  chat-start preference is preserved under this setting. Selected notes go into
  one reference-data section of the system prompt; each new query replaces the
  previous selection. Tool continuations keep the current selection.

**Maximum memories / search results** (`locality.memoryMaxCount`) caps both
automatic loading and search results: default 10, range 1-100. Local keyword
ranking recognizes paths and camelCase/snake_case symbols, with name and phrase
boosts. Unrelated notes are omitted. Loading uses no model or embedding service.
Notes count toward the prompt budget; the lowest-ranked whole notes are removed
if needed before normal compaction. Each loaded note appears as **Recalled <memory-name>**
in the normal working session, with expandable contents. When the response finishes,
these activities collapse inside **Worked for…** with the other tools. Only notes
sent in an accepted model request appear; batched steering uses the latest query's
selection. Historical snapshots remain readable after edits or deletion.

Ask the agent to remember a specific durable fact or preference. The agent uses
`create_memory({ name, contents, id? })`: omit the ID to create an enabled note,
or recall the current note first and supply its ID to update it. Names alone
never overwrite notes. Exact duplicate creations reuse the existing record.
Updates preserve the stable ID, creation date, and enabled flag. A stale update
fails with instructions to recall again. Names have a 200-character limit and
contents a 20,000-character limit. Common credential patterns are redacted;
avoid putting secrets in notes. Saving makes no additional model request.

`search_memories({ query })` returns enabled matches with stable UUIDs, names,
and full UTC dates. `recall_memory({ name, id })` reads a live note and its
Markdown contents. Search-result links open notes, rather than chats. Memories
are historical reference data: current user instructions, project instructions,
and inspected workspace evidence take precedence.

The **Memories** sidebar uses the same compact rows and context menu as Chats.
An active note has a foreground-colored dot. Click a row to expand its Markdown
contents in place; the context menu offers View, Edit, Enable/Disable, Rename,
and Delete. Deleting a saved note requires confirmation. **Clear all memories**
below the list clears saved notes and unsaved new drafts after confirmation,
including memories hidden by the current search. Chats remain untouched.

**Create new memory** adds a draft row: confirm its name first, then enter its
contents. The checkmark saves and the cross cancels editing. The Edit button
under an expanded note opens the same inline editor. Named drafts remain in the
list until saved or discarded, and in-progress edits survive sidebar reloads.
A new note is written when its contents are saved. If another window or external
editor changed a note, cancel and reopen the editor to use the current version.
Disabling/deleting a note affects
future automatic retrieval and search. Existing tool results and historical
recall activities remain in the chat.

There is no background memory generation, generation queue, or retry setting.
Malformed memory files are excluded individually with a warning; repair or remove
the named file to resolve it. They are never overwritten automatically.

Run the offline keyword-retrieval evaluation with `npm run eval:memory`.
