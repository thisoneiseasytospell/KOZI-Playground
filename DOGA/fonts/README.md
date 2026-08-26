# Fonts

DOGA renders captions and labels in **Graphik**, loaded from the files in this folder and
registered at runtime as the family `DOGA Graphik` (see `loadFonts()` in `app.js`).

| File | Registered as |
| --- | --- |
| `Graphik-Regular.otf` | weight 400, normal — caption body, per the design spec |
| `Graphik-RegularItalic.otf` | weight 400, italic — available, not yet used by any control |
| `Graphik-Medium.otf` | weight 500, normal — label first line |
| `Graphik-MediumItalic.otf` | weight 500, italic — available, not yet used by any control |

Licensed from Commercial Type. These files are for local use — do not publish this folder
to a public host without checking the licence terms.

If a file is missing, the stack in `render.js` falls back to a Graphik installed on the
machine, then to Helvetica Neue.
