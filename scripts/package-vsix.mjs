import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rm, cp, readdir, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import esbuild from "esbuild";
import { buildProfile } from "../esbuild.config.mjs";
import { root, profiles, assertProfile } from "./build-profiles.mjs";
import { auditStage, auditArchive } from "./verify-build-isolation.mjs";

const require = createRequire(import.meta.url);
const base = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const artifactName = `${base.name}-harness`;
const selected = process.argv.find(arg => arg.startsWith("--profile="))?.slice(10);
if (selected) assertProfile(selected);
const targets = selected ? [selected] : profiles;
const labels = { "no-commands": "No commands", "safe-list": "Safe list", commands: "Commands", advanced: "Advanced" };
const output = path.join(root, "artifacts");
const pending = path.join(root, ".build", "packages");
await mkdir(pending, { recursive: true });
await mkdir(output, { recursive: true });

async function defaultPatterns() {
  const result = await esbuild.build({ entryPoints: [path.join(root, "src/features/commands/safeList/defaults.ts")], bundle: true, write: false, platform: "node", format: "cjs" });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
  return module.exports.DEFAULT_SAFE_PATTERNS;
}

function runVsce(cwd, out) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve("@vscode/vsce/vsce"), "package", "--no-dependencies", "--allow-missing-repository", "--skip-license", "--out", out], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`VSCE exited with ${code}`)));
  });
}

for (const profile of targets) {
  const stage = path.join(root, ".build", "staging", profile);
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.join(stage, "media"), { recursive: true });
  const metadata = await buildProfile(profile, path.join(stage, "dist"));
  const reportDir = path.join(root, ".build", "reports");
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, `${profile}.json`), JSON.stringify(metadata));
  for (const name of await readdir(path.join(root, "media"))) {
    if (profile === "no-commands" && name === "commands.css") continue;
    if (profile !== "advanced" && name === "webTools.css") continue;
    await cp(path.join(root, "media", name), path.join(stage, "media", name), { recursive: true });
  }
  const manifest = structuredClone(base);
  manifest.displayName = `${base.displayName} — ${labels[profile]}`;
  manifest.localityEdition = profile;
  manifest.description = `${labels[profile]} edition of ${base.displayName}: a local/LAN model with workspace tools.`;
  delete manifest.scripts;
  delete manifest.devDependencies;
  delete manifest.dependencies;
  delete manifest.overrides;
  delete manifest.allowScripts;
  const properties = manifest.contributes.configuration.properties;
  if (profile === "no-commands") delete properties["locality.commandToolsEnabled"];
  if (profile === "no-commands" || profile === "safe-list") delete properties["locality.autoapproveCommands"];
  if (profile === "safe-list") {
    properties["locality.autoapproveSafeCommands"] = { type: "boolean", default: false, scope: "application", description: "Auto-approve all matching safe commands in Act mode, including deletion. User settings only." };
    properties["locality.safeCommandPatterns"] = { type: "array", items: { type: "string", maxLength: 2048 }, maxItems: 128, default: await defaultPatterns(), scope: "application", description: "Whole-command regexes over executable and literal arguments separated by spaces. Arguments needing quoting use shell-style single quotes. Built-in workspace restrictions also apply. An empty list denies all commands. User settings only." };
  }
  if (profile === "advanced") {
    properties["locality.webSearchMaxResults"] = { type: "integer", default: 10, minimum: 1, maximum: 20, description: "Maximum number of results returned by each web search. The model can request fewer; searches default to 5 results, capped by this setting." };
    properties["locality.webRequestsEnabled"] = { type: "boolean", default: true, description: "Enable web search and webpage reads after the search connection has been verified." };
    properties["locality.webSearchEndpoint"] = { type: "string", default: "https://api.search.brave.com/res/v1/web/search", scope: "application", description: "Web search endpoint: Brave Web Search URL (https://api.search.brave.com/res/v1/web/search) or SearXNG base URL with JSON search enabled. Queries are sent to this service and its upstream engines. Public instances may be unavailable or rate limited. Use HTTPS, or HTTP on localhost/private IP. Blank or unverified disables both web tools. Configure and verify with Set in the Locality Settings tab; API keys are kept in secret storage. Brave requires a key; SearXNG keys are optional." };
    properties["locality.autoapproveWebSearch"] = { type: "boolean", default: false, scope: "application", description: "Auto-approve web requests (searches and webpage reads) in Act, Plan, and Review modes. Off by default. User settings only." };
  }
  await writeFile(path.join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const instructions = profile === "safe-list"
    ? "Commands require approval by default. Enable Auto-approve safe commands to approve all matching commands uniformly. Use Edit User Settings to configure safeCommandPatterns. Patterns match the entire normalized command; shell expansion and compound commands are unsupported. Paths for built-in filesystem commands are restricted to the workspace. Custom programs may access the network or run further code; this is not an OS sandbox."
    : profile === "no-commands" ? "Workspace file tools are available. This package contains no model command execution or web search implementation."
    : "Commands require approval by default. Auto-approve commands applies in Act mode. Commands inherit the editor's OS permissions.";
  const search = profile === "advanced" ? `\n\nConfigure https://api.search.brave.com/res/v1/web/search and your Brave Search API-key, or a SearXNG base URL and optional key, in Settings. Click Set to test a JSON search and save. The endpoint defaults to Brave Search; enter its API key and verify the connection to enable web tools. Brave uses X-Subscription-Token; SearXNG uses optional Bearer authentication. Keys are stored in VS Code secret storage and sent only to the saved endpoint. A blank key sends no authentication for SearXNG; Brave requires a key. Searches and page reads require approval unless Auto-approve web requests is enabled. A blank or unverified endpoint disables both web tools. Public instances may reject or rate-limit requests. Queries go to the configured service and its upstream engines. Search results contain source URLs and snippets. read_webpage reads public HTML/text pages with validated redirects and bounded excerpts; it does not execute JavaScript or read PDFs. Both web tools are exposed only after Set verifies the connection.` : "";
  await writeFile(path.join(stage, "README.md"), `# ${manifest.displayName}\n\n${instructions}${search}\n\nConfigure the local/LAN model endpoint in Settings. Commit-message generation uses the same VS Code Git integration in every edition. Installing another Locality edition replaces this extension while preserving chats and shared preferences.\n\nChats and attachments are stored in ~/.locality/.\n`);
  await cp(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
  await auditStage(profile, stage, metadata);
  const filename = `${artifactName}-${base.version}-${profile}.vsix`;
  const candidate = path.join(pending, filename);
  await rm(candidate, { force: true });
  await runVsce(stage, candidate);
  await auditArchive(profile, candidate);
}
// Promote only when every requested package has passed its archive audit.
if (!selected) {
  for (const filename of await readdir(output)) {
    if (filename.startsWith(`${base.name}-`) && filename.endsWith(".vsix")) await rm(path.join(output, filename));
  }
}
for (const profile of targets) {
  const filename = `${artifactName}-${base.version}-${profile}.vsix`;
  await rm(path.join(output, filename), { force: true });
  await rename(path.join(pending, filename), path.join(output, filename));
}
console.log(`Packaged and verified ${targets.length} editions in artifacts/.`);
