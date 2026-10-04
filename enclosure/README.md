# Frame case

A 3D-printable case for the 7.3" panel, the Seeed XIAO ePaper Display Board and a LiPo battery. The screen glass is 169 × 111 mm, with a 160 × 96 mm image area. The battery space fits an 80 × 55 × 9 mm pack, so there's room for the larger battery you plan to use later.

The size starts from hextheboy's [7.3 inch E-ink Paper Frame](https://makerworld.com/en/models/1710103-7-3-inch-e-ink-paper-frame) on MakerWorld (191.2 × 132.2 × 16 mm). This version is 196.2 × 132.2 × 17 mm:

- **1 mm deeper**, so there's 7.4 mm of free space above the board for the battery connector. The model refuses to render if that drops below `board_clearance` (6 mm) plus 0.5 mm.
- **5 mm wider**, so the bezel is 18.6 mm on all four sides. The screen's image area isn't centred on its glass, so the glass sits 4 mm low in the frame to centre the window. Set `equal_bezels = false` to go back to the reference width with a wider bottom bezel.

Everything fits inside that depth, so the back is a flat plate with no lid sticking out. The board sits against the top wall, with its buttons, slide switch and USB-C facing up through a slot. A small door snaps into the slot and has a hole so the USB cable still fits when the door is shut.

| File | Print orientation |
| --- | --- |
| `stl/frame.stl` | front face down |
| `stl/back.stl` | outside face down |
| `stl/door.stl` | outside face down |

The source is `domiframe_case.scad`. All the dimensions are parameters at the top of the file.

## Check these before printing

Most of these numbers came from a photo, so measure your parts first:

- **`edge_to_hole`** (now 2.5 mm): the distance from the button edge of the board to the centres of the nearest mounting holes. The standoffs set where the board sits, so if this number is wrong, the buttons won't line up with the slot.
- **`board_len` / `board_wid`** (now 80 × 41.2 mm): the outline of the board.
- **`usb_x`** (now −25): where the USB-C sits along the slot. This only affects the hole in the door. If the hole ends up on the wrong end, flip the sign.
- **`usb_above_pcb`** (3.0 mm): how far the centre of the USB-C port sits above the top of the PCB. The slot is centred on this height.
- **`aa_top`** (5 mm): the gap between the top edge of the glass and the top of the image area. The bottom border, on the FPC side, works out to 10 mm, and each side to 4.5 mm.

The quickest check is to print only a strip of the top wall and hold your board against it.

## Rendering

Export all three parts to `stl/`:

```bash
./export.sh
```

Name parts to export only those, for example `./export.sh back door`.

In the OpenSCAD app, open **Window → Customizer** and pick a part from the **Part** dropdown. Press F6 to render it and F7 to save it as an STL. `assembly` shows everything together with placeholder blocks for the panel, board and battery. `section` cuts the assembly in half at X = 0 so you can see the inside. The measurements are grouped into tabs in the same panel.

## Assembly

1. Put the panel face-down in the frame, with its FPC tail at the bottom in the notch.
2. Screw the board onto the back plate's standoffs with 4 × M2 × 4 screws, components facing out. The button edge goes toward the top.
3. Put the battery in its fence with double-sided foam tape, leads toward the board. The fence is sized for an 80 × 55 × 9 mm pack, so tape a smaller battery into the corner nearest the board. The fence sits left of centre, seen from the back, which leaves the right half free for the ribbon. If the board's ribbon connector is on the other side, move it with `bat_x`. Stick the antenna flat on the plate, away from the battery.
4. Connect the extension ribbon from the board to the panel tail, then plug in the battery.
5. Lower the plate into the back of the frame, top edge first, so the buttons and USB-C slide under the slot. Fix it with 6 × M2 × 6 countersunk self-tapping screws.
6. Press the door into the slot.

The pads in the corners and on the sides stop 0.3 mm short of the panel. A thin strip of foam on each pad keeps the panel from rattling.

## Print notes

- 0.2 mm layers, 3 walls, 15% infill. PLA or PETG.
- The top of the slot is an 80 mm bridge. Bambu printers handle it fine at default bridge settings.
- No supports needed on any part.
