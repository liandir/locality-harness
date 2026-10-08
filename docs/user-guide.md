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

- **Server URL** — the address of your `llama.cpp` server, e.g.
  `http://127.0.0.1:8080/v1` or `http://192.168.1.50:8080/v1`. It must be
  `localhost` or a private IP literal; DNS hostnames such as `nas.local` are
  refused. Click **Set** to validate the endpoint, list `/v1/models`, and read
  `/props` metadata. Choose the model below the URL; its reported alias and
  context length are shown alongside it.
- **Tool calling** — choose **Native server only** when the server reliably
  returns OpenAI-compatible structured calls. The Gemma 4, Qwen 3, Muse
  Glimmer, and GPT-OSS compatibility profiles still prefer structured calls,
  but can recover that family's exact syntax when it leaks into text. Gemma,
  Qwen, and GPT-OSS can also fall back to their legacy adapters when the server
  rejects native tools.
  Start `llama-server` with `--jinja` and a tool-aware chat template.

The other settings (sampling, auto-approve toggles, safe
commands) have sensible defaults and can be revisited later.

For edition-specific features, see [Safe-list configuration](tools.md#safe-list-configuration)
and [Advanced web search](tools.md#advanced-web-search).

### Muse Glimmer server requirements

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
`reasoningEfforts` setting and send its configured value as llama.cpp
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
  local `llama.cpp` endpoint and write the generated message into Git's commit
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
| `endpoint` | `http://localhost:8080/v1` | URL of your llama.cpp server. Use `localhost` or a private IP literal such as `http://127.0.0.1:8080/v1` or `http://192.168.1.50:8080/v1`. |
| `model` | `local` | Model id sent with requests. The Settings view replaces this fallback with a selection from llama.cpp's `/v1/models` response. |
| `toolCallingMode` | `compat-gemma4` | Select `native`, `compat-gemma4`, `compat-qwen3`, `compat-muse-glimmer`, or `compat-gpt-oss`. Compatibility profiles are native-first and add only the selected family's recovery behavior. |
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
request, so they override whatever `--temp`, `--top-k`, or `--top-p` flags the
`llama.cpp` server was started with. Commit-message generation also uses the
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

Enable **Settings → Workspace memory → Use workspace memories** to let the
agent search and recall active summaries from other chats in the same workspace. It is off by
default and is stored in workspace settings (`locality.memoryEnabled`);
user-level activation is ignored. This switch controls memory tool availability
and automatic memory creation and updates. Manual generation and editing remain
available when it is off.

After a final response in **Act** or **Review** mode, the harness checks the current
workspace switch and queues a short memory summary only if it is enabled. Turning
the switch off during a response prevents that turn from creating or updating a
memory; turning it on before the response finishes allows it. This decision is
made at turn completion, and skipped turns are not queued for later generation.
Summaries use the configured local model. **Plan** responses and plan
revisions do not create or update memories automatically. After accepting a
plan, memory generation waits for the Act implementation response to finish.
New generated memories are active automatically; existing
individual exclusions are preserved. The workspace switch still controls whether
the agent can search and recall them.

A **Creating memory** card appears after the answer and becomes **Created memory**
when finished. If the chat already has a memory, the card shows **Updating memory**
and then **Updated memory**. Expand it to see the same full contents and date shown by recall.
Completed cards remain available when reopening the chat. A new message sent
during generation appears immediately beneath the active memory card;
the model request proceeds once that summary finishes. Compaction and commit-message
inference can interrupt generation; interrupted work resumes when idle.
In **Recent Chats** (the Chats tab), **Re-generate all memories** sits below
**Start new chat** and processes existing chats on request.
Use **Cancel generation** to clear queued work and cancel the current summary.

Select the **cloud icon** beside a chat’s delete button to inspect, edit, include/exclude, and
regenerate its summary. Saving an edit makes the summary manually maintained, so background
updates cannot overwrite it. **Regenerate** replaces it with an automatically
maintained summary. Failed generation can be retried without affecting the chat.
Summaries are limited to 384 tokens. Raw tool messages, hidden reasoning, and
imported memories are excluded from summarization input; common credential
formats are redacted, and the model is instructed to omit secrets.

Memories are retrieved only when the agent calls a tool; no summaries are
inserted automatically into the system prompt. When enabled, the system prompt
suggests considering memory retrieval at the beginning of a request:

- **`search_memories`** takes a `query` and returns matching `name`, `id`, and
  `date` fields, plus the total match count and whether results were truncated.
  Local BM25 keyword ranking includes title and phrase boosts, recognizes paths
  and camelCase/snake_case symbols, and breaks ties by date and source ID.
  It uses no embeddings, network requests, or retrieval model. Search covers all
  active, usable memories in the current workspace, excluding the current chat.
- **`recall_memory`** takes the exact `name` and `id` from search and returns
  those fields, the full UTC `date`, and `contents`. IDs are 16 hexadecimal
  characters from SHA-256 of the source chat ID, name, and contents. Identical
  names are disambiguated; renaming or editing a memory changes its ID. Recall
  checks the current source again, so stale IDs and inactive or deleted sources
  fail with a request to search again.

Both tools return full UTC dates with minute precision, such as
`2026-09-11T14:05Z`. **Maximum search results** sets the per-search limit from
1 to 100, defaulting to 10 (`locality.memoryMaxCount`). The agent chooses
which matches to recall. The tools work in Act, Plan, and Review modes and follow
the read-approval setting. When workspace memories are off, both tools and their
system-prompt guidance are omitted, and attempted calls cannot retrieve content.

**Recalled memories** shows the sources read through the tool, with links to
their editors in Recent Chats. Recalled contents are ordinary tool results in
chat history and are subject to normal context limits and compaction. Turning
memories off prevents new retrieval; it does not erase existing tool results.
Summary generation excludes
raw tool results and asks the model to omit facts merely copied from memories.
Current instructions and inspected code take precedence over historical memory.

Chat-card timestamps adapt to when you view them: time only today, day and short
month on other days in the same year, and the year for dates in another year.
They use local time without seconds; hover retains the full local date and time.
The latest saved user-message timestamp remains in system context only to place
the request relative to memory dates. Assistant timestamps are display-only.

For a reproducible, synthetic memory-on/off probe against a running local server:

```bash
npm run eval:memory -- http://localhost:8080 your-model-id /tmp/memory-eval.json
```

This records summary size, retrieval selections, recall/override checks, server
prompt/completion tokens, and elapsed response time. It is a small functional
probe, not a coding benchmark or a statistically reliable speed comparison.
