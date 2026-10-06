/** Preserve an in-progress field and its focus across a sidebar refresh. */
export function preserveFormFocus(root: HTMLElement, preserveValue = true): () => void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active) || !active.id) return () => undefined;
  const id = active.id;
  const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
  const editing = preserveValue && field && !["checkbox", "radio", "range", "button", "submit"].includes(active.type);
  const value = editing ? active.value : undefined;
  const start = editing ? active.selectionStart : null;
  const end = editing ? active.selectionEnd : null;
  const scrollTop = active.scrollTop;
  return () => {
    const replacement = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!replacement) return;
    if (value !== undefined && (replacement instanceof HTMLInputElement || replacement instanceof HTMLTextAreaElement)) {
      replacement.value = value;
      if (start !== null && end !== null) replacement.setSelectionRange(start, end);
    }
    replacement.focus({ preventScroll: true });
    replacement.scrollTop = scrollTop;
  };
}
