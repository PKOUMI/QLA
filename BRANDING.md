# Changing the branding

Three places, and only one of them is likely to matter to you.

## 1. The app's colours — `css/styles.css`

Everything is at the top of the file, in the block marked **BRANDING LIVES
HERE**. Nothing below it names a colour directly; it all refers to these.

```css
--brand-50  #eef2ff   /* palest wash: badges, hovers */
--brand-500 #6366f1   /* logo gradient start */
--brand-600 #4f46e5   /* buttons, links, focus rings */
--brand-700 #4338ca   /* hover, logo gradient end */
--brand-900 #312e81   /* email header band */
```

Change those five and the whole app follows: buttons, links, focus outlines,
the step navigation, badges, the logo tile.

The neutrals (`--ink`, `--body`, `--line`, `--canvas`) are a cool grey chosen
to sit with indigo. If you move to a warm brand colour, warm these very
slightly too, or the greys will look like they belong to the old palette.

Chart colours sit in the same block (`--viz-fill`, `--viz-ramp-0` to `-4`).
They are deliberately a separate blue rather than your brand hue: charts have
their own contrast requirements, and a brand colour picked to look good on a
button often fails as a data colour. Change them if you like, but check
contrast against a white card afterwards.

## 2. The email's colours — `shared/email-template.js`

One `COLOURS` object at the top. It has to be separate: email clients strip
`<style>` blocks and do not support CSS variables, so every colour is inlined
on the element. Match the same five brand values by hand.

## 3. The logo

Currently a letter in a rounded tile, defined in three spots:

| Where | What |
|---|---|
| `index.html` | The `<link rel="icon">` data URI, and `.brand-mark` |
| `marketing/index.html` | The same two, plus `<meta name="theme-color">` |
| `css/styles.css` | `.brand-mark` gradient |

For a real logo, replace the `.brand-mark` span with an `<img>` or inline SVG
and export a PNG favicon. Fifteen minutes, once you have artwork.

## The marketing site

`marketing/index.html` carries its own copy of the tokens, because it is a
standalone file with no shared stylesheet. Same names, same values — change
both together, or the site and the app will drift apart.

## A quick check

After a rebrand, look at these four, which are where mismatches show up:

1. The grade pills on the marksheet
2. A sent email, in the preview
3. The Analyse charts against their white cards
4. Focus outlines when tabbing through the marksheet
