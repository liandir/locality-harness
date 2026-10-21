<p align="center">
  <img src="media/locality-mark.svg" alt="Locality mark" width="112" height="112">
</p>
<h1 align="center">Locality Harness</h1>
<p align="center"><strong>A coding assistant in VS Code, powered by your local model.</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPLv3-blue" alt="License: GPLv3"></a>
  <a href="https://github.com/liandir/locality/releases/latest"><img src="https://img.shields.io/github/v/release/liandir/locality?label=release&amp;color=green" alt="Latest release"></a>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#install">Install</a> ·
  <a href="#four-levels-of-locality">Compare editions</a> ·
  <a href="docs/tools.md">Tools</a> ·
  <a href="docs/user-guide.md">User guide</a>
</p>

Locality connects VS Code to a **llama.cpp server on your computer or local
network**. Chat about your code, plan changes, review diffs, and let the assistant
edit workspace files with your approval. Choose from four editions to control
whether it can also run commands or search the web.

## Features

- **[Local model connection](docs/user-guide.md#first-time-setup)** — Use a llama.cpp server on your computer or local network, with model-specific tool-calling profiles.
- **[Act, Plan, and Review modes](docs/user-guide.md#chat-modes)** — Make changes, prepare an implementation plan, or inspect your code.
- **[Saved chats and parallel conversations](docs/user-guide.md#starting-a-chat)** — Switch between chat tabs while work continues and reopen conversations later.
- **[File and image attachments](docs/user-guide.md#file-attachments)** — Add code, pasted text, or images to your messages; image input requires a vision model.
- **[Workspace editing](docs/tools.md#edit-tools)** — Create and edit files with approval controls and diff previews.
- **[Project instructions](docs/user-guide.md#project-instructions-agentsmd)** — Apply your project's conventions through AGENTS.md.
- **[Workspace memory](docs/user-guide.md#workspace-memory)** — Optionally search and recall useful summaries from earlier chats in the same project.
- **[Context management](docs/user-guide.md#managing-context)** — Track context usage and compact longer conversations automatically or on demand.
- **[Git commit messages](docs/user-guide.md#commit-message-generation)** — Draft a commit message from your staged changes using your local model.

Command execution and web research are available in selected editions; see the
[edition comparison](#four-levels-of-locality) and [tools overview](#tools-at-a-glance).

## Install

You need **VS Code 1.90 or newer** and a running **llama.cpp server** with a
model that supports tool calling. The server can run on the same computer or
another machine on your local network. Installing the extension does not install
a model or server, and does not require Node.js.

1. Choose an edition from the table below and download its `.vsix` file from the
   [latest release](https://github.com/liandir/locality/releases/latest).
2. In VS Code, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run
   **Extensions: Install from VSIX…**. Select the downloaded file.
3. Reload VS Code if prompted, then open **Locality** from the Activity Bar.

You can also install from the terminal, using your downloaded filename:

```bash
code --install-extension locality-harness-safe-list.vsix
```

Downloads use stable names such as `locality-harness-safe-list.vsix`. The links below
always follow the release marked **Latest** on GitHub; the release tag and the
extension's version identify the version you are installing.

## Four levels of Locality

All four editions use the same local/LAN model connection and include workspace
file reading and editing. The level determines the assistant's additional tools.

| Edition | Command execution | Built-in web tools | Latest download |
| --- | --- | --- | --- |
| **No commands** | None; work through workspace file tools | None | [Download VSIX](https://github.com/liandir/locality/releases/latest/download/locality-harness-no-commands.vsix) |
| **Safe list** | Only commands matching your configured rules, with workspace checks for built-ins | None | [Download VSIX](https://github.com/liandir/locality/releases/latest/download/locality-harness-safe-list.vsix) |
| **Commands** | General command execution for builds, tests, and other programs | None | [Download VSIX](https://github.com/liandir/locality/releases/latest/download/locality-harness-commands.vsix) |
| **Advanced** | Same as Commands | Brave Search or SearXNG, plus public webpage reading | [Download VSIX](https://github.com/liandir/locality/releases/latest/download/locality-harness-advanced.vsix) |

File edits and commands require approval by default; file reads are auto-approved.
General commands and custom safe-list programs run with your OS permissions and
may access files or the network beyond the workspace. Safe list is a command
policy, not an OS sandbox. See the [tools reference](docs/tools.md) for approval
settings and edition limits.

To switch editions, install the other `.vsix`. Editions share the same extension
ID, so the new one replaces the installed edition while keeping chats and shared
settings. The installed edition is shown in Locality's Settings tab.

## Connect your model

1. Start `llama-server` with your model, `--jinja`, and a tool-aware chat template.
2. Open **Locality → Settings**. Set **Server URL** to an address such as
   `http://127.0.0.1:8080/v1` or `http://192.168.1.50:8080/v1`, then click **Set**
   and select the model. Use `localhost` or a private IP address; other DNS names
   such as `nas.local` are not accepted.
3. **Tool calling** defaults to **Native server only**. Choose your model family's
   compatibility profile if it needs recovery for tool calls leaked into text.
4. Open a project folder, click **+ New chat**, and describe what you want to do.

Use **Act** to make changes, **Plan** to explore a solution before editing, and
**Review** to inspect code and answer questions. Plan and Review are read-only:
they cannot edit files or run commands.

See the [user guide](docs/user-guide.md#first-time-setup) for model compatibility,
image attachments, context management, and settings. Advanced users can configure
[web search](docs/tools.md#advanced-web-search) in Settings.

## Tools at a glance

The assistant selects tools as it works. You can expand a tool card to inspect
its arguments, output, or proposed file diff before approving a change.

| Capability | What it provides | Availability |
| --- | --- | --- |
| Workspace files | List and find files, read code, create files, and apply edits with diff previews | All editions |
| Images | Inspect workspace images with `view_image` | All editions, with a vision model and native tool calling |
| Questions and task progress | Ask for a decision and track a task checklist | All editions; checklists in Act mode |
| Workspace memory | Search and recall summaries from earlier chats in the same workspace | All editions, when enabled in workspace settings |
| Commands | Start a process, read its output, and stop it | Safe list, Commands, and Advanced; Act mode |
| Web research | Search through Brave or SearXNG and read public webpages | Advanced, after configuring and verifying a search connection |

The [tools reference](docs/tools.md) lists individual tools, mode availability,
approval behavior, safe-list configuration, and web-search setup.

## Your data

Model requests go to your configured local/LAN endpoint. Workspace file tools
stay inside the open project. Chats and attachments are saved locally under
`~/.locality/`, with conversations separated by workspace.

Advanced web requests send queries to your configured search provider and read
pages from public websites; they require approval by default. Commands use the
permissions of the VS Code extension host. See [privacy and isolation](docs/user-guide.md#privacy--isolation)
for details.

## Documentation

- [User guide](docs/user-guide.md) — setup, chat modes, attachments, settings, and memory.
- [Tools reference](docs/tools.md) — available tools and how to configure them.
- [Build editions](docs/build-editions.md) — compare the four editions and their capabilities.
- [Developer guide](docs/developer-guide.md) — develop, build, test, package, and release Locality.
- [Issues](https://github.com/liandir/locality/issues) — report a bug or request a feature.

## License

[GNU General Public License v3](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md)
for bundled dependencies.
