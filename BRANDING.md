# EveryPupil branding

## The palette

A desaturated teal on a ground that is never pure white.

| Token | Day | Night | Used for |
|---|---|---|---|
| `--brand-600` | `#0f6f6c` | `#4ebfb7` | Buttons, links, focus rings, the logo |
| `--brand-500` | `#17847f` | `#68d3cb` | Hover |
| `--brand-700` | `#0a5957` | `#8fe0da` | Pressed, headings on a wash |
| `--brand-50` | `#eaf3f2` | `#0d2624` | Palest wash: badges, chips |
| `--canvas` | `#f1f4f3` | `#101615` | The page behind the cards |
| `--surface` | `#fbfcfc` | `#1a2322` | Cards |
| `--ink` | `#16211f` | `#e9f0ee` | Headings |
| `--body` | `#3a4744` | `#c7d3d0` | Body text |
| `--muted` | `#5f6d6a` | `#93a19d` | Secondary text |

### Why these, and not something brighter

The people using this will sit with it for two hours entering ninety pupils'
marks. Three decisions follow from that:

- **The canvas is 90% luminance, not 100%.** A pure white background is a lamp
  pointed at the reader. Ten per cent off is invisible as a choice and
  noticeable as an hour.
- **The strongest contrast on the page is 16:1, not 21:1.** Black on white is
  past the comfortable range for continuous reading; the text is a very dark
  green-grey instead.
- **The hue sits mid-spectrum.** Deep blues and reds focus at slightly
  different depths inside the eye, so a saturated blue interface makes the eye
  hunt. Teal is where it works least hard.

Night is not an inversion. Inverting a light theme gives white text on black,
which haloes and smears at length. Night uses a very dark green-grey ground
(0.7% luminance, not 0%) with off-white text (`#e9f0ee`, not `#ffffff`) —
the gap between pure black and pure white is the part that hurts.

**Every pair meets WCAG AA.** Comfortable is not the same as washed out, and a
misread digit is a mark entered wrong. Re-check with the numbers above if you
change anything: body text needs 4.5:1 against its background.

## The logo

`brand/` holds the lot.

| File | For |
|---|---|
| `everypupil-mark.svg` | The tile. Anywhere square: favicon, app icon, avatar |
| `everypupil-mark-mono.svg` | One colour, inherited. Print, embroidery, black and white |
| `everypupil-lockup.svg` | Mark plus wordmark, for a light background |
| `everypupil-lockup-dark.svg` | The same for a dark background |
| `everypupil-mark-{32,64,180,512,1024}.png` | Where SVG is not accepted |

Four bars, deliberately uneven. A neat ascending ramp is the chart cliché and
says "numbers went up"; these are four different heights because the product
is about noticing that every pupil in the room did something different.

Clear space: half the tile's width on every side. Smallest use: 20px — it was
drawn to survive 32 and checked at 32, which is where legibility is decided,
not at 512.

Do not: re-colour the bars, stretch it, add a shadow, or set the wordmark in
another typeface.

## Changing it

**1. The app — `css/styles.css`.** Both palettes are in the two blocks at the
top (`:root` and `[data-theme="dark"]`). Nothing below names a colour
directly. Change those and the whole app follows.

Charts sit in the same blocks (`--viz-fill`, `--viz-ramp-0` to `-4`). They now
use the brand hue rather than a separate one, because a single-hue chart on a
single-hue interface reads as one system. If you change the brand, check the
ramp still separates into five distinguishable steps.

**2. The feedback email — `shared/email-template.js`.** Mail clients strip
`<style>`, so every colour is inline hex in the `COLOURS` block at the top.
It has to be changed by hand to match.

**3. The marketing site — `marketing/index.html`.** Its own `:root` block, the
same values.

**4. The logo files — `brand/`.** The mark's teal is written into each SVG.

## Night mode

The button in the app header cycles: match my computer → day → night. The
choice is kept per browser, not per account: a teacher on a bright
classroom machine and the same teacher at home at 9pm want different answers,
and syncing it would force one on both.

The theme is applied by a small script in `<head>` before the stylesheet
loads, so a night user never gets a white flash on the way in.
