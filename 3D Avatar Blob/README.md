# Maggie Studio

A 3D avatar generator with iOS exports.

Inspired by [orb-pg.vercel.app](https://orb-pg.vercel.app/) and
[avatars.bible-strong.app](https://avatars.bible-strong.app/).

A head is built from a shape, a face and an animated surface, then exported as a
self-contained component you can drop into a product. Everything is procedural —
the avatar is drawn as flat 2D SVG from an orthographic projection of 3D
geometry, with spring-driven motion and no runtime dependencies.

## Running it

`index.html` uses `<script type="module">` and an import map, so **double-clicking
the file will not work** — `file://` blocks module loading and the `.glb` fetch.
Serve it over HTTP:

```bash
python3 -m http.server 8000
```

- Main avatar sketch: <http://localhost:8000>
- Phone screen prototypes: <http://localhost:8000/prototype-tests.html>
- Chess sketch: <http://localhost:8000/3D%20Chess%20Pieces/>

three.js loads from a CDN at runtime. Nothing to install, nothing to build.

## The four tabs

**Manual** — head dimensions and rotation, eye size and position, the plane mesh,
and the face editor.

**Expressions** — 22 presets. Ten of them are traced from the reference face
sheet and carry the artwork's own cubic paths; the rest are the original capsule
presets. Clicking a tile morphs eyes and mouth together on springs.

**States** — Idle, Nervous, Curious, Excited, Disappointed, Alert and Shocked.
A state picks an expression, a palette, a gaze rhythm, a blink interval and a
head-motion profile, and chains them while motion is running.

**Surface** — the animated gradient (the Orb Editor's controls) or flat ink.

## Shapes

Sphere, Mickey, Cube, Plane (the default), and the six chess pieces — Pawn,
Rook, Knight, Bishop, Queen, King.

## The face

Each expression carries a left eye, a right eye and a mouth. A mark is either a
capsule described by width, height, tilt, lid and bend, or a **traced outline** —
a closed cubic path in fractions of the mark's own box, with as many nodes as
the artwork needs (14 for a round-capped stroke, 8 for a rounded rect, 4 for a
circle). Traced marks go to the SVG as real curves rather than sampled
polylines, so they stay smooth at any size.

The mouth rides the same surface placement as the eyes — it lifts, tilts and
fades with them — but chases the gaze on a much softer spring, so it arrives a
beat late instead of tracking in lockstep. It never blinks.

### Face editor

A head-on view of the face with all three marks where they actually sit on the
head. Drag a handle to reshape a mark; click a point to expose its curve
handles, Alt to break the pair. Drag a box on empty canvas to pick several
points and move them together (Shift-drag adds to the picked set, Escape
clears). A preset's traced outline shows until you touch it — the first drag
seeds this state's own copy, so you nudge the artwork rather than snapping back
to a capsule. **Restore preset face** puts it back.

Figma SVG can be pasted straight in via **Apply SVG**.

## Keyboard

| Key | Does |
| --- | --- |
| `1`–`9`, `0` | Select expression 00–09 of the current bank |
| `` ` `` | Stick the number pad on the next ten presets |
| `Shift` + digit | Reach the next ten without moving the bank |
| `P` | Save the profile and open the phone previews |
| `E` | Toggle mouse follow |
| `Space` | Preview the plane mesh target (Plane shape only) |
| `/` | Developer inspector |
| Hold `R` 1s | Reset |

## Exporting

The Developer panel exports the current state and expression as a `.zip`:

- **React / TypeScript** — component plus a Vite preview
- **JavaScript module** — HTML plus a dependency-free module

Both carry the configuration that was active at export time and render the same
geometry the editor does, springs and all.

> The export formats shipping today are React and a plain JS module. An iOS
> target is not implemented yet.

## Previews

`prototype-tests.html` frames three phone screens, each embedding `index.html`
in mirror mode so they render the live avatar rather than a copy of it.
`gyro-tilt.js` feeds device tilt into the same channel the mouse uses on
desktop, so the head leans with the phone.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole editor — CSS and most of the JS inline |
| `avatar-export.js` | The exported runtime and the `.zip` builder |
| `chess-model.js`, `chess-pieces (1).glb` | Chess piece geometry |
| `gyro-tilt.js` | Device tilt → look vector |
| `prototype-tests.html`, `mobile-*.html` | Phone screen prototypes |
| `CONTRIBUTING.md`, `CLAUDE.md` | Working agreement for this repo |

## Credits

Development — [KOZI Studio · Albert Kozikowski](https://www.kozi.studio/)

Made for Studio Blunt / Take Take Take in 2026.
