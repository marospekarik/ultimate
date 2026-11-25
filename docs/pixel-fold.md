# Foldable phones (Pixel 10 Pro Fold)

How Ultimate behaves on a foldable Android phone in Chrome or installed as a PWA, the edge cases found on the device,
and how to reproduce and check each one with the browser tool. Read it before changing the shell, the composer, a
surface's layout or anything sized for touch.

## The device

| State              | CSS viewport                                             | Usable with Chrome's bars | `useViewport()` | Tailwind |
| ------------------ | -------------------------------------------------------- | ------------------------- | --------------- | -------- |
| Folded (cover)     | 412×901 (DPR ≈ 2.6)                                      | about 412×800             | `phone`         | below sm |
| Unfolded portrait  | 755×783, crease down the middle                          | about 755×700             | `phone` (< 768) | sm       |
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
whole visible height.

**Check:** `width: 783, height: 320, touch: true`, focus the composer, measure the transcript scroller's height.

### 3. Unfolded portrait gets the phone layout

At 755 px `useViewport()` is `phone` (tablet starts at 768): the list overlays instead of docking and lines run to about
98 characters.

### 4. The status bar strip

An installed PWA with `display: standalone` cannot draw under Android's status bar: only `display: fullscreen` does,
and that hides the clock and the status icons. The strip takes `theme-color`, so `theme-color` must equal the top
bar's colour in each theme; that is the whole fix, not a shortfall.

### 5. Text cut off on the right

The status line and the surface tabs are wider than the unfolded screen; they clip without an ellipsis ("Han", "revie").

## Before you land a layout change

Run the frame `eval` at 412×800, 755×700, 783×680 and 783×320 with `touch: true`, on agent, inbox, docs, review and
memory, then `resize` 412 → 755 → 412 and check the open conversation, the draft and the scroll position.
