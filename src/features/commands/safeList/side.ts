import type { SideFeature } from "../../../build/sideContracts.js";
export const sideFeature: SideFeature = {
  label: "Safe list",
  renderTools: (settings, toggle) => toggle("commandToolsEnabled", "Activate commands", settings.commandToolsEnabled !== false),
  render: (settings, toggle) => toggle("autoapproveSafeCommands", "Auto-approve safe commands", settings.autoapproveSafeCommands === true, settings.commandToolsEnabled === false),
  bind(root, send) {
    root.querySelector<HTMLInputElement>("#autoapproveSafeCommands")?.addEventListener("change", event => {
      send({ type: "saveSetting", key: "autoapproveSafeCommands", value: (event.target as HTMLInputElement).checked });
    });
  }
};
