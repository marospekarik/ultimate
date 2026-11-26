# Foldable phones (Pixel 10 Pro Fold)

How Ultimate behaves on a foldable Android phone in Chrome or installed as a PWA, the edge cases found on the device,
and how to reproduce and check each one with the browser tool. Read it before changing the shell, the composer, a
surface's layout or anything sized for touch.

## The device

| State              | CSS viewport                                             | Usable with Chrome's bars | `useViewport()` | Tailwind |
| ------------------ | -------------------------------------------------------- | ------------------------- | --------------- | -------- |
| Folded (cover)     | 412×901 (DPR ≈ 2.6)                                      | about 412×800             | `phone`         | below sm |
| Unfolded portrait  | 755×783, crease down the middle                          | about 755×700             | `tablet`        | md       |
| Unfolded landscape | 783×755                                                  | about 783×680             | `tablet`        | md       |
| Keyboard open      | width unchanged, height ≈ 450 folded, ≈ 320–400 unfolded |                           | as above        |          |

The pointer is `coarse` in every state, so every `pointer-coarse:` style applies, folded or not.

## Checking with the browser tool

- Always pass `touch: true` with a phone or fold size. Without it the page reports `pointer: fine`, every touch style
  is off, and a too-wide page does not widen the layout viewport, so the worst bug below cannot show.
- `resize: [w, h]` changes the viewport without a reload: a fold, an unfold, a rotation or the keyboard.
- One `eval` that measures the frame after every step:

```js
;({
  layout: [innerWidth, innerHeight],
  visual: [visualViewport.width, visualViewport.height],
  root: (({ width, height }) => [width, height])(
    document.querySelector('.safe-area').getBoundingClientRect(),
  ),
  scrollX,
  pageWidth: document.documentElement.scrollWidth,
})
```

`layout`, `visual` and `root` must be equal, `scrollX` 0 and `pageWidth` equal to the width.

## Edge cases

### 1. The app zooms out and stays stuck short and narrow

**Seen:** unfolded, the app filled only the top-left part of the screen: the header ended at about 60 % of the width, a
black band filled the bottom third, and sometimes the rail was cut off on the left. It stayed like that after the
keyboard closed.

**Cause:** not the keyboard. Android Chrome widens the layout viewport to fit any content wider than the screen and
zooms the page out to show it. One pane without `min-w-0` (the Inbox reading pane next to its fixed 24rem list) made
the page 1348 px wide on a 783 px screen, so the app was drawn at 783/1348 = 58 %.

**Fix:** `html, body { overflow-x: clip }` in `web/src/index.css`, so no overflow can reach the viewport; and fix the
overflowing element too (`min-w-0` on flex children that hold text). `test/e2e/phone-width.test.ts` guards it.

**Check:** `browser {url, width: 783, height: 680, touch: true, steps: [{press: 'Control+2'}, {eval: <frame>}]}`, then
the same on every surface (`Control+1` … `Control+7`) and at 412×800.

### 2. The keyboard leaves no room for the transcript

**Seen:** unfolded with the keyboard open, the header, the context bar, the composer and the status line filled the
whole visible height: 0 px of transcript at 783×320.

**Fix:** on a touch screen at least 45rem wide and under 30rem tall, a focused field hides the conversation header and the status line (`web/src/index.css`); the transcript gets about 130 px
back. The title bar stays: it holds the surface tabs, and hiding it left no way to switch to the Inbox while typing.

**Check:** `width: 783, height: 320, touch: true`, focus the composer, measure the transcript scroller's height.

### 3. Unfolded portrait got the phone layout

At 755 px `useViewport()` was `phone` (tablet started at 768): the list overlaid instead of docking and lines ran to
about 98 characters. **Fix:** `tablet` and Tailwind's `md` both start at 45rem (720 px), the docked list takes at most
32 % of a tablet's width, and on touch the reading width is 38rem (about 70 characters a line).

### 6. Folding loses the reading position

A width change rewraps every paragraph, so the same `scrollTop` lands far from what the reader was looking at (2689 px
off after 412 → 755 → 412). The transcript notes the element under its top edge on every scroll and puts it back at
the same offset when the width changes. `test/e2e/phone-width.test.ts` guards it.

### 4. The status bar strip

An installed PWA with `display: standalone` cannot draw under Android's status bar: only `display: fullscreen` does,
and that hides the clock and the status icons. The strip takes `theme-color`, so `theme-color` must equal the top
bar's colour in each theme; that is the whole fix, not a shortfall. The top bar is `--sidebar`, which renders
`#0e0e10` dark and `#f2f3f5` light: `web/index.html`, `web/src/sdk/client.ts` and the manifest's `theme_color` carry
those values and must change with it.

`display: fullscreen` was tried and dropped: on the unfolded inner screen Android letterboxes the camera cutout in
black (default cutout mode; Chrome draws into it only behind `chrome://flags/#web-app-short-edges-cutout-mode`, off by
default, Chromium issue 407420295), and no page or manifest setting colours it.

### 7. The Inbox squeezed its reading pane

Unfolded, the docked list (about 250 px) and the Inbox's own 24rem item list left the question about 80 px, one word a
line. **Fix:** below `desktop` the Inbox shows its list or the open item, as on a phone.

### 8. Desktop density on a finger

One `@media (pointer: coarse)` block in `web/src/index.css` maps the px type classes to rem: meta 13 px, body, prose
and fields 16 px (a field under 16 px makes the browser zoom in on focus). The title bar and conversation header grow
to 44 px, and their buttons and the prompt box's reach 44×44. Touch-only sizes in components use `pointer-coarse:`,
not `max-md:`, since `md` now covers an unfolded fold.

### 5. Text cut off on the right

The status line and the surface tabs were wider than the unfolded screen and clipped without an ellipsis ("Han",
"revie"). **Fix:** below `desktop` the status line keeps its phone items and moves the rest behind ⋯; the surface tabs
scroll sideways.

## Before you land a layout change

Run the frame `eval` at 412×800, 755×700, 783×680 and 783×320 with `touch: true`, on agent, inbox, docs, review and
memory, then `resize` 412 → 755 → 412 and check the open conversation, the draft and the scroll position.
