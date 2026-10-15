import { historyIcon, pencilIcon, readFileIcon, memoryIcon, trashIcon } from "./icons.js";
import type { ChatContextMessage, ChatMenuMemory } from "./messaging.js";

export interface ChatContextAction {
  label: string;
  icon: () => string;
  run: (id: string) => void;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
}

export function chatContextActions(memory: ChatMenuMemory | undefined, send: (message: ChatContextMessage) => void): ChatContextAction[] {
  return [
    { label: "Open chat", icon: historyIcon, run: id => send({ type: "openChat", id }) },
    { label: "Rename chat", icon: pencilIcon, run: id => send({ type: "renameChat", id }) },
    { label: "Edit memory", icon: pencilIcon, separatorBefore: true, run: id => send({ type: "openMemory", id, readonly: false }) },
    { label: "View memory", icon: readFileIcon, run: id => send({ type: "openMemory", id, readonly: true }), disabled: !memory?.hasMemory },
    { label: memory?.hasMemory ? "Regenerate memory" : "Generate memory", icon: memoryIcon,
      run: id => send({ type: "regenerateMemory", id }), disabled: memory?.status === "queued" || memory?.status === "generating" },
    { label: "Delete chat", icon: trashIcon, destructive: true, separatorBefore: true, run: id => send({ type: "deleteChat", id }) }
  ];
}

/** Identical menu geometry and keyboard navigation in both webviews. */
export function installChatContextMenu(
  root: HTMLElement,
  actionsForChat: (id: string) => ChatContextAction[]
): void {
  let menu: HTMLDivElement | undefined;
  let owner: HTMLElement | undefined;
  const close = (restoreFocus = false): void => {
    menu?.remove();
    menu = undefined;
    if (restoreFocus) (owner?.querySelector<HTMLElement>("button") ?? owner)?.focus();
  };
  const open = (target: HTMLElement, x: number, y: number): void => {
    close();
    owner = target;
    const id = target.dataset.chatContext;
    if (!id) return;
    menu = document.createElement("div");
    menu.className = "context-menu chat-context-menu";
    menu.setAttribute("role", "menu");
    for (const action of actionsForChat(id)) {
      if (action.separatorBefore) {
        const separator = document.createElement("div");
        separator.className = "context-menu-separator";
        separator.setAttribute("role", "separator");
        menu.append(separator);
      }
      const button = document.createElement("button");
      button.className = `context-menu-item quiet-btn${action.destructive ? " delete" : ""}`;
      const icon = document.createElement("span");
      icon.className = "context-menu-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = action.icon();
      const label = document.createElement("span");
      label.textContent = action.label;
      button.append(icon, label);
      button.setAttribute("role", "menuitem");
      button.disabled = action.disabled ?? false;
      button.addEventListener("click", event => { event.stopPropagation(); close(true); action.run(id); });
      menu.append(button);
    }
    menu.addEventListener("keydown", event => {
      const buttons = Array.from(menu!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "ArrowDown" ? (current + 1) % buttons.length
        : event.key === "ArrowUp" ? (current + buttons.length - 1) % buttons.length
        : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : undefined;
      if (index !== undefined) { event.preventDefault(); buttons[index]?.focus(); }
      else if (event.key === "Tab") close(true);
    });
    document.body.append(menu);
    menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight))}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  };
  root.addEventListener("contextmenu", event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-chat-context]");
    if (!target) return;
    event.preventDefault();
    open(target, event.clientX, event.clientY);
  });
  root.addEventListener("keydown", event => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-chat-context]");
    if (!target) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    open(target, rect.left, rect.bottom);
  });
  document.addEventListener("pointerdown", event => { if (!menu?.contains(event.target as Node)) close(); });
  document.addEventListener("keydown", event => { if (menu && event.key === "Escape") { event.preventDefault(); close(true); } });
  window.addEventListener("blur", () => close());
}
