# Paint by Numbers Generator

A single-page site where you upload a photo, choose how many colours you want, and get back a simplified colour preview plus a numbered outline you can print and paint.

## What the visitor does

1. Drops or selects an image (JPG/PNG) from their device.
2. Moves a slider to pick the number of colours (roughly 4 to 30, default 12).
3. Presses Generate and watches a short progress indicator.
4. Sees two results side by side: the colour preview and the black-and-white numbered outline.
5. Sees the colour key underneath: each number with its paint swatch.
6. Downloads either result as a PNG.

Everything happens in the visitor's own browser. No sign-in, no uploads to a server, nothing stored.

## Controls

- Colour count slider.
- Detail level: how much small speckle gets smoothed away before the outline is drawn.
- Optional output size cap so very large photos stay fast.
- Regenerate after changing any setting, without re-uploading.

## Look and feel

Before building I will show three design directions to pick from, so the site does not look generic. The layout centres on a big upload area that turns into a before/after workspace once an image is loaded.

## Technical notes

- All processing client-side on `<canvas>`, no backend.
- Colour reduction: k-means quantisation in Lab-ish space over a sampled pixel subset, then map every pixel to its nearest centroid.
- Noise cleanup: median/majority filter passes on the label map, plus a minimum-region size merge so tiny specks get absorbed into neighbours.
- Region labelling: connected-component pass over the label map; each region gets its palette index as its number.
- Outline: draw boundaries where neighbouring pixels differ in label; place the number at each region's pole-of-inaccessibility-ish centroid, skipping regions too small for legible text.
- Work runs in a Web Worker with progress messages so the UI stays responsive; heavy images are downscaled first.
- Downloads via `canvas.toBlob` and an anchor click.
- Single route at `/` with its own title, description, and social tags.

## Out of scope for now

Printable PDF, saved history/accounts, and vector (SVG) export. Easy to add later if wanted.
