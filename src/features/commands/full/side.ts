import type { SideFeature } from "../../../build/sideContracts.js";
export const sideFeature: SideFeature = {
  label: "Commands",
  renderTools: (settings, toggle) => toggle("commandToolsEnabled", "Activate commands", settings.commandToolsEnabled !== false),
  render: (settings, toggle) => toggle("autoapproveCommands", "Auto-approve commands", settings.autoapproveCommands === true, settings.commandToolsEnabled === false),
  bind(root, send) {
    root.querySelector<HTMLInputElement>("#autoapproveCommands")?.addEventListener("change", event => {
      send({ type: "saveSetting", key: "autoapproveCommands", value: (event.target as HTMLInputElement).checked });
    });
  }
};
