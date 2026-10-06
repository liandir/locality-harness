# Locality contributor guide

This file applies to the entire repository.

## Visual language

- Use the chat composer as the reference for interactive surfaces: a subtle filled surface, no visible gray/white border, and no blue focus ring.
- Buttons, tabs, text fields, selects, switches, queued messages, and inline editors use the shared `--control-radius` (10px) and transparent borders so focus or state changes do not alter layout. The main chat composer and its Send/Stop actions share that radius. Keep tab typography and dimensions unchanged between active and inactive states.
- Communicate hover, focus, active, and selected states through `--surface-fill` / `--surface-fill-strong`, foreground color, and existing semantic fills. Do not introduce outline strokes for those states.
- Use the shared `icon-btn` geometry for icon-only actions: 28px square by default, or the explicit `icon-btn-compact` 20px square variant for dense rows and card headers. Both use the same 8% hover/focus fill. Keep status dots and progress indicators circular. Use checkmarks for completion, a cloud for local memory, and static waiting labels for approval; reserve activity animation for ongoing work. Destructive actions use the existing translucent error fill and error foreground, without a colored border.
- Filled text actions use the shared `action-btn` class (7% resting fill, 16% hover/focus fill). Keep action appearance and disabled states in `media/chatControls.css`; component rules should only supply layout or a semantic state, never a button-specific hover color.
- Colored actions retain their semantic foreground on hover/focus. Set `--button-foreground` and `--button-hover-fill` for that state; the shared interaction rule adds or strengthens the tinted background without neutralizing the icon.
- Tool output surfaces, file diff cards, summaries, and notices share the same card base: `--surface-fill`, `--control-radius`, and transparent borders. Use `renderToolOutputSurface` for expanded tool cards, including diffs, with internal separators and no nested card backgrounds or outer outlines. Keep diff line colors and the translucent error fill for failed/rejected cards.
- Commands, process checks, and file diffs use the shared `tool-output-header` layout for matching height, padding, typography, and vertically centered text/actions. Inset internal separators from both edges on all cards, including questions and change summaries; diff rows and change markers still reach the card edges.
- Visible borders are reserved for structural content boundaries where grouping matters, such as section separators, diffs, and timelines. Do not use them as decoration around controls or tool output boxes.
- Prefer VS Code theme variables and `color-mix()` over fixed colors. Check both light and dark themes when changing UI styles.
- Keep shared visual behavior consistent between `media/chat.css` and `media/side.css`.
- Use the shared `--scrollbar-size` (4px) for horizontal and vertical scrollbars throughout both webviews. A horizontally scrolling card header keeps the same text/action row height as a non-scrolling header, including the text's 1px optical downshift. Place the scrollbar below that row with a 2px gap before the inset separator.
- Manual chat scrolling takes precedence over streaming renders. Pause following immediately on scroll input; resume only when the user scrolls to the bottom or clicks “Scroll to latest”. New turns, tool activity, compaction, and programmatic scroll events must not re-enable following. Leave the paused viewport to native scrolling and anchoring.
- All text links, including link-styled buttons such as “View all”, have no underline at rest and show a 1px dashed underline on hover or keyboard focus. Underline only the label, leaving icons undecorated. Reuse the shared link styles in `media/chatControls.css` across both webviews.

## Coding guidelines

- Keep TypeScript strict and update the shared protocol types in `src/ui/messaging.ts` whenever webviews and extension-host providers exchange a new message.
- Treat the extension host as the source of truth for state that must survive webview rerenders or reloads; webview state may be used for immediate optimistic feedback.
- Scope chat storage operations to the active workspace. Confirm destructive bulk operations and refresh every affected view afterward.
- Preserve the guarded network boundary: use `src/network/safeFetch.ts`; do not call `fetch` or import another HTTP client directly.
- Edit source files under `src/` and styles under `media/`. Do not hand-edit generated files in `dist/`.
- Reuse existing icons, surface variables, rendering helpers, and storage methods before adding parallel implementations.
- Keep unrelated user changes intact and avoid broad formatting rewrites.
- Select optional capabilities through the build resolver in `scripts/build-profiles.mjs`. Shared code must not import another edition's executors, settings, prompt fragments, or UI handlers. Keep the fixed VS Code Git integration shared across editions.
- Run all-profile packaging and its bundle/archive isolation audits after changing optional tools or build wiring. No commands must contain no subprocess implementation; Safe list must contain no unchecked shell runner; only Advanced includes search networking.

## Verification

- Run `npm run typecheck`, `npm run lint`, and `npm run build` after implementation changes.
- Run the relevant targeted Vitest file for changed behavior; run `npm test` when the change crosses multiple subsystems.
- Run `git diff --check` before handoff.
