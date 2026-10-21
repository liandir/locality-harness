const OPEN = "<proposed_plan>";
const CLOSE = "</proposed_plan>";
const MARKERS = [OPEN, CLOSE];

/** A final-answer boundary, independent of tool protocols. Contents stream as normal text. */
export class PlanResponse {
  private buffer = "";
  private opened = 0;
  private closed = 0;
  private inside = false;
  private invalid = false;
  private markdown = "";
  private line = "";
  private fence?: string;

  get complete(): boolean {
    return this.opened === 1 && this.closed === 1 && !this.invalid && !!this.markdown.trim();
  }
  feed(text: string): string {
    this.buffer += text;
    let output = "";
    while (this.buffer) {
      const markers = MARKERS.map(marker => ({ marker, index: this.buffer.indexOf(marker) }))
        .filter(item => item.index >= 0).sort((a, b) => a.index - b.index);
      const next = markers[0];
      if (!next) {
        // Withhold only a possible marker prefix, never a line or the plan body.
        let held = 0;
        for (const marker of MARKERS) for (let size = 1; size < marker.length; size++) {
          if (this.buffer.endsWith(marker.slice(0, size))) held = Math.max(held, size);
        }
        output += this.take(this.buffer.slice(0, this.buffer.length - held));
        this.buffer = this.buffer.slice(this.buffer.length - held);
        break;
      }
      output += this.take(this.buffer.slice(0, next.index));
      this.buffer = this.buffer.slice(next.index + next.marker.length);
      if (this.line.trim() || this.fence) {
        output += this.take(next.marker);
        continue;
      }
      if (next.marker === OPEN) {
        if (++this.opened !== 1 || this.closed) this.invalid = true;
        this.inside = true;
      } else {
        if (!this.inside || ++this.closed !== 1) this.invalid = true;
        this.inside = false;
      }
    }
    return output;
  }
  end(): string {
    const partialMarker = !!this.buffer && !this.line.trim() && !this.fence
      && MARKERS.some(marker => marker.startsWith(this.buffer));
    if (partialMarker) this.invalid = true;
    const tail = partialMarker ? "" : this.take(this.buffer);
    this.buffer = "";
    return tail;
  }
  private take(text: string): string {
    if (this.inside) this.markdown += text;
    else if (this.closed && text.trim()) this.invalid = true;
    const lines = text.split("\n");
    this.line += lines[0];
    for (const line of lines.slice(1)) {
      const fence = this.line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (!this.fence) this.fence = fence[1];
        else if (fence[1][0] === this.fence[0] && fence[1].length >= this.fence.length && !fence[2].trim()) this.fence = undefined;
      }
      this.line = line;
    }
    return text;
  }
}

export const PLAN_CONTINUATION_NOTE = "Planning is still active: the previous reply did not finish a complete plan. "
  + "Continue the task now. If a material user choice is missing, call ask_user_question and wait for the answer. "
  + "Otherwise finish with the complete actionable implementation plan and verification steps as ordinary response text, "
  + "between <proposed_plan> and </proposed_plan> on their own lines. These delimiters identify the final answer and are hidden by the editor. "
  + "Do not call a plan submission tool or end with commentary or an offer to plan later.";
