# Tools reference

[Back to Locality](../README.md) · [User guide](user-guide.md) · [Build editions](build-editions.md)

Locality exposes tools according to the installed edition, chat mode, model
capabilities, and settings. Tools act on the currently open workspace unless
otherwise noted below.

- [Read tools](#read-tools)
- [Edit tools](#edit-tools)
- [Command tools](#command-tools)
- [Web tools](#web-tools)
- [Chat modes](#chat-modes)
- [Tool cards and approvals](#how-tool-calls-work)
- [Safe-list configuration](#safe-list-configuration)
- [Advanced web search](#advanced-web-search)

## Read tools

Gather context from workspace files, images, saved memories, or the user.
These tools are included in every edition and available in all chat modes,
subject to the requirements below. File paths are relative to the workspace root.
File, image, and memory reads are auto-approved by default; questions wait for
the user's answer.

| Tool | Purpose | Availability |
| --- | --- | --- |
| `list_dir` | List entries in a workspace directory | All modes |
| `glob` | Find files by pattern, such as `src/**/*.ts` | All modes |
| `read_file` | Read a text file or a range of numbered lines | All modes |
| `view_image` | Inspect a workspace JPEG, PNG, or WebP image | All modes; vision model and native tool calling required |
| `create_memory` | Save a specific Markdown note, or update a recalled current note by stable ID | All modes; workspace memory must be enabled; saves automatically |
| `search_memories` | Find relevant enabled workspace notes by local keywords | All modes; workspace memory must be enabled |
| `recall_memory` | Read a live note using the name and ID returned by memory search | All modes; workspace memory must be enabled |
| `ask_user_question` | Ask for a decision with suggested answers and a free-text option | All modes; gathers user input without accessing files |

Search and recall follow the read-approval setting. Memory creation/updates save automatically, including in Plan and Review; other file writes remain restricted. See [workspace memory](user-guide.md#workspace-memory)
to enable them and manage workspace notes.

## Edit tools

Create or change workspace files and maintain task progress. These tools are
included in every edition and available in Act mode. File edits require
approval by default and offer a diff preview. `update_todos` changes only the
chat's checklist and needs no approval.

| Tool | Purpose | Availability |
| --- | --- | --- |
| `create_file` | Create a new text file; refuse to overwrite an existing file | Act; native tool calling |
| `edit_file` | Apply exact text replacements atomically, checking the file revision first | Act; native tool calling |
| `write_file` | Write the complete contents of a text file | Act; legacy tool calling |
| `insert_text` | Insert text before a line, checking the expected current line | Act |
| `replace_range` | Replace a line range, checking its expected current contents | Act |
| `update_todos` | Maintain a visible checklist for a task without changing files | Act |

Native tool calling uses structured calls returned by the server. Some model
compatibility profiles can fall back to a legacy text format; Locality adjusts
the tool set automatically. See [model setup](user-guide.md#first-time-setup).

## Command tools

Available in **Safe list**, **Commands**, and **Advanced**, in Act mode, with the
same command-string interface in native and legacy tool calling.
No commands contains no command executor. Safe list applies its configured rules
in both calling formats.

| Tool | Purpose |
| --- | --- |
| `run_command` | Run a command string. Commands and Advanced use a shell; Safe list accepts one program with literal arguments |
| `wait_process` | Wait for new output from a running job, for up to 30 seconds per call |
| `stop_process` | Stop a process tree owned by the current chat |

Long-running commands return a job ID so the assistant can check their output or
stop them. Output is shown in the chat, and the process card also offers a Stop
button. See [command approval](#command-approval) for permissions.

In Commands and Advanced, command strings can contain pipelines, redirects,
and multiline scripts. They use the system shell (`/bin/sh` on Unix or the
configured command shell on Windows); Bash-specific syntax requires invoking
`bash` explicitly. Safe list does not interpret shell operators or multiline
scripts; it parses the command into a program and literal arguments before
applying its policy.

## Web tools

Available only in **Advanced**, in all three chat modes, after a search
connection has been configured and verified with **Set** in Settings.

| Tool | Purpose |
| --- | --- |
| `web_search` | Search the configured Brave Search or SearXNG service and return titles, URLs, and snippets |
| `read_webpage` | Read a public HTML or plain-text page and return bounded text excerpts |

Both tools require approval by default. Search does not automatically read result
pages; the assistant can request a separate page read. See [Advanced web search](#advanced-web-search)
for connection setup, credentials, and request limits.

## Chat modes

| Mode | Read files, images, and enabled memories | Edit files and update task checklists | Run commands | Configured web tools |
| --- | --- | --- | --- | --- |
| Act | Yes | Yes | In command-capable editions; approval by default | Advanced; approval by default |
| Plan | Yes | No | No | Advanced; approval by default |
| Review | Yes | No | No | Advanced; approval by default |

Image and memory prerequisites still apply. The web-request approval setting
applies in every mode. File-edit and command approval settings apply only in
Act mode; Plan and Review do not expose these tools.

## How tool calls work

When the assistant wants to interact with your workspace, it emits a tool
call which appears as a small card in the chat. Cards are color-coded:

- **Read tools** (`read_file`, `list_dir`, `glob`) — gray. Auto-approved by
  default; flip off **Auto-approve reads** in settings if you'd rather
  confirm each one.
- **File edit tools** (`create_file`, revision-checked atomic `edit_file`, and
  line-addressed `insert_text` / `replace_range` in native mode; line-addressed
  tools and `write_file` in legacy mode) — gray, with
  a unified diff preview when expanded. Requires your approval by default.
  Click **Accept changes** to apply, or **Reject changes and suggest
  changes** to refuse and leave feedback in the composer.
- **Commands** (`run_command` in command-capable editions) —
  purple. Each approved command runs as a background child process;
  no VS Code terminal is opened, and bounded stdout/stderr appear in the
  expanded tool card. Commands and Advanced use a shell; Safe list runs one
  permitted program directly. The assistant can decide when a command would help
  and propose it directly. Every command requires manual approval by default. Turning on
  **Auto-approve commands** (or **Auto-approve safe commands**) skips the prompt
  in Act mode for commands permitted by that edition.
  **Checking process** cards show the original command and offer the same Stop
  control as **Running command** while the process is running. The command also
  remains visible in saved **Checked process** cards.
- **Errors** — if a tool fails (e.g. file not found, write permission
  denied), the card turns red and the error is fed back to the assistant so
  it can self-correct without ending the chat. Click any card to expand it
  and inspect arguments, raw output, or the diff.

## Command approval

In Commands and Advanced, **Auto-approve commands** controls approval for all
`run_command` calls in Act mode. It is off by default, so each command waits for
you to approve or reject it. Turning it on lets commands run without an approval
prompt. Plan and Review modes cannot run commands.

Safe list uses **Auto-approve safe commands** with the same approval behavior
for every matching command. Nonmatching commands always fail. No commands
contains neither setting nor executor.

General commands run with the permissions and environment of the VS Code extension
host. They may access the network, start other programs, or reach files outside
the workspace; the file tools' workspace restrictions do not sandbox commands.

## Safe-list configuration

Choose **Edit User Settings** in the Settings tab.
`locality.safeCommandPatterns` is an array of regex strings matched against
the entire normalized command. Executable and arguments are separated by single
spaces; arguments needing quoting use shell-style single quotes. Patterns have no
flags. An empty array denies all commands; invalid patterns fail closed. The
list is included in the model's prompt. Workspace overrides are ignored.

Defaults include workspace searches, directory creation, and selected read-only
Git forms. `rm` and `rmdir` require a matching user-added pattern; neither is
included by default. Existing saved lists retain their configured entries.
Built-in path checks still protect the workspace boundary, root, and Git
metadata. Shell operators, redirection, expansion, and compound commands are unsupported. Safe list runs
executables outside the workspace from absolute PATH entries; on Windows, only
native executables are supported. The named Unix commands must be installed.
Safe Git currently requires a `.git` directory inside the workspace; linked
worktrees and parent-repository discovery are not supported. Narrow recursive
searches if the checked tree exceeds 10,000 entries.

## Advanced web search

In the Advanced edition, open **Settings → Web search**. The endpoint defaults to
Brave Search. Add its API key, or replace the endpoint with your SearXNG instance:

- **Brave Search:** `https://api.search.brave.com/res/v1/web/search` and your
  Brave Search **API-key**. The official base URL `https://api.search.brave.com`
  also works. Locality detects Brave from its exact official host.
- **SearXNG:** your instance's base URL and an optional **API-key**.

Click **Set** to run a test JSON search for `Locality` and save the connection if
successful. Authentication, subscription, quota, and format errors use the red
error box. Brave requires a Search API subscription; its other API endpoints
are not supported by this adapter.

The Web search settings section sits between Chat and Automation.
Both `web_search` and `read_webpage` are omitted from tool definitions and system
prompts until the current endpoint is verified. Verification survives reloads;
a changed endpoint must be verified with Set. The host stores verification
separately from editable settings.
A blank or unverified endpoint disables both web tools, including the default
Brave endpoint until you verify it. Connection,
authentication, rate-limit, and response-format errors appear in red.

SearXNG sends no authentication header with a blank key, or
`Authorization: Bearer …` when supplied (supported by PrivAU). Brave requires
a key and sends it in `X-Subscription-Token`. Keys are kept in VS Code secret
storage, bound to the saved endpoint, and are never included in prompts, chat
history, or settings JSON. For SearXNG, clearing the key and pressing Set removes
it after a successful connection test. A blank endpoint clears the key and disables
both web tools without a network request. Changing the endpoint in user JSON does not send
an existing key to the new destination; use Set to configure its credentials.
The adapter supports Brave Web Search and the SearXNG JSON API, not arbitrary search-provider APIs.

Each search and page read requires approval unless you enable **Auto-approve web requests**.
This switch applies in Act, Plan, and Review modes and is off by default.
`locality.webSearchEndpoint` and the approval switch are user settings;
workspace overrides are ignored. These features are available only in Advanced.

The search service must support JSON responses. Public endpoints require HTTPS;
HTTP is allowed for localhost/private IP addresses. Public instances may reject
or rate-limit API requests. Queries go to the configured service and its upstream
search engines. Search results provide URLs and snippets. `read_webpage` reads
public HTTP/HTTPS pages directly, returning a title, source URL, and readable
text. It strips scripts and navigation, follows up to five validated redirects,
and never sends the search key to websites. Responses are capped at 2 MiB and
20 seconds. Text excerpts default to 20,000 characters; `start`, `max_chars`
(up to 50,000), and `next_start` support reading more. It supports HTML and plain
text, without executing JavaScript, logging in, or parsing PDFs. Private/local
and reserved addresses are blocked, including redirects and DNS changes.

**Auto-approve web requests** (`locality.autoapproveWebSearch`) covers both tools.
Brave queries use the same bounded result format as SearXNG: title, URL, snippet,
and optional page date. Queries are limited to 500 characters and 75 words for
Brave. Search credentials are never sent by `read_webpage`.
