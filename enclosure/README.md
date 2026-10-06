# Frame case

A 3D-printable case for the 7.3" panel, the Seeed XIAO ePaper Display Board and a LiPo battery. The screen glass is 169 × 111 mm, with a 160 × 96 mm image area. The battery space fits an 80 × 55 × 9 mm pack, so there's room for the larger battery you plan to use later.

The size starts from hextheboy's [7.3 inch E-ink Paper Frame](https://makerworld.com/en/models/1710103-7-3-inch-e-ink-paper-frame) on MakerWorld (191.2 × 132.2 × 16 mm). This version is 196.2 × 132.2 × 17 mm:

- **1 mm deeper**, so there's 7.4 mm of free space above the board for the battery connector. The model refuses to render if that drops below `board_clearance` (6 mm) plus 0.5 mm.
- **5 mm wider**, so the bezel is 18.6 mm on all four sides. The screen's image area isn't centred on its glass, so the glass sits 4 mm low in the frame to centre the window. Set `equal_bezels = false` to go back to the reference width with a wider bottom bezel.

Everything fits inside that depth, so the back is a flat plate with no lid sticking out. The board sits against the top wall, with its buttons, slide switch and USB-C facing up. The top wall has an opening for the USB-C plug and a round hole over each button. A small printed cap goes through each hole and presses onto the switch's plunger. The slide switch has a slot, and its cap has a wider tab outside so it's easier to push.

| File | Print orientation |
| --- | --- |
| `stl/frame.stl` | front face down |
| `stl/back.stl` | outside face down |
| `stl/buttons.stl` | four button caps and the switch cap, outer face down |
| `stl/fit_test.stl` | fit test caps, see below |
| `stl/rail.stl` | landscape hanging rail and two spacers, back face down |
| `stl/stand.stl` | two stand feet, flat on their side |

The source is `domiframe_case.scad`. All the dimensions are parameters at the top of the file.

## Check these before printing

Most of these numbers came from a photo, so measure your parts first:

- **`edge_to_hole`** (now 2.5 mm): the distance from the button edge of the board to the centres of the nearest mounting holes. The standoffs set where the board sits, so if this number is wrong, the buttons won't line up with the slot.
- **`board_len` / `board_wid`** (now 80 × 41.2 mm): the outline of the board.
- **`usb_x`** (now −25): where the USB-C sits along the top wall. The buttons are placed from it: the first is `btn_first` (16.87 mm) away, then every `btn_pitch` (9.16 mm). If they all end up on the wrong end, flip the sign of `usb_x` and set `btn_dir = -1`.
- **`usb_above_pcb`** (3.0 mm): how far the centre of the USB-C port sits above the top of the PCB. The opening is centred on this height. It's 12.5 × 7 mm (`usb_hole_w`, `usb_hole_h`) so the plug's overmold can go partway into the wall. If your cable's overmold is bigger, make the opening bigger.
- **`usb_overhang`** (0): if the USB-C socket sticks out past the board edge by more than 0.3 mm, set this to how far. It cuts a groove up the inside of the wall so the socket can slide in when the back plate goes in.
- **`btn_from_back`** (8.15 mm, measured): how far the centre of each plunger sits from the back face of the frame. The holes and caps are centred on this height.
- **`sw_window`** (3.84 mm, measured): the opening in the switch body. The knob slides 3.84 − 1.55 = 2.29 mm in it. `sw_on_from_btn` (10.75 mm, measured) places it in the ON position, counted from the last button, and OFF is `sw_travel` back toward the buttons. The slot is also 1.5 mm taller than it needs to be (`sw_z_play`, 0.75 mm on each side), because the knob's distance from the back (`sw_from_back`, 8.15 mm) doesn't seem to be exactly the same each time.
- **`sw_post_len`** (1.5 mm): how far the knob sticks out of the switch body. The cap goes `sw_grip` (1 mm) onto it.
- **`btn_tip`** (0): where the tip of each plunger sits relative to the board edge. It's negative if the tip stops short of the edge. Each cap's sleeve reaches in to the plunger, so this sets how long the caps are.
- **`btn_post_len`** (1.5 mm): how far each plunger sticks out of the switch body. Each cap goes `btn_grip` (1 mm) onto the plunger and no further, because its socket is closed at the end. The model refuses to render unless `btn_travel` (0.3 mm) plus 0.1 mm is left between the cap and the switch body, so the cap doesn't hold the button down.
- **`aa_top`** (5 mm): the gap between the top edge of the glass and the top of the image area. The bottom border, on the FPC side, works out to 10 mm, and each side to 4.5 mm.

The quickest check is to print only a strip of the top wall and hold your board against it.

### Button caps

The plungers taper from 2.35 mm at the base to 2.3 mm at the tip. The socket in each cap is drawn at 2.3 mm (`btn_bore`). Small printed holes usually come out about 0.1 mm undersize, and that gives the press fit. Print `fit_test.stl` first. It has four button caps with sockets of 2.2, 2.3, 2.4 and 2.5 mm, marked with 1 to 4 dots on the outer face. Push each one onto a plunger, and set `btn_bore` to the socket size of the one that holds firmly without splitting.

The switch knob is a 1.55 mm square, and its cap's socket is drawn at that size (`sw_socket`). The fit test also has three switch caps with sockets of 1.45, 1.55 and 1.65 mm, marked with 1 to 3 dots. Set `sw_socket` the same way.

## Rendering

Export all the parts to `stl/`:

```bash
./export.sh
```

Name parts to export only those, for example `./export.sh back buttons`.

In the OpenSCAD app, open **Window → Customizer** and pick a part from the **Part** dropdown. Press F6 to render it and F7 to save it as an STL. `assembly` shows everything together with placeholder blocks for the panel, board and battery. `section` cuts the assembly in half at X = 0 so you can see the inside. The measurements are grouped into tabs in the same panel.

## Assembly

1. Put the panel face-down in the frame, with its FPC tail at the bottom in the notch.
2. Screw the board onto the back plate's standoffs with 4 × M2 × 4 screws, components facing out. The button edge goes toward the top.
3. Put the battery in its fence with double-sided foam tape, leads toward the board. The fence is sized for an 80 × 55 × 9 mm pack, so tape a smaller battery into the corner nearest the board. The fence sits left of centre, seen from the back, which leaves the right half free for the ribbon. If the board's ribbon connector is on the other side, move it with `bat_x`. Stick the antenna flat on the plate, away from the battery.
4. Connect the extension ribbon from the board to the panel tail, then plug in the battery.
5. Lower the plate into the back of the frame, top edge first, so the buttons and USB-C line up with their holes. Fix it with 6 countersunk M2 self-tapping screws. The holes in the frame are 2.1 mm across and 11 mm deep (`frame_pilot`, `frame_pilot_depth`), so screws up to M2 × 12 fit.
6. Push a cap into each button hole from outside until it stops on the plunger. Push the switch cap through its slot onto the knob in the same way. Each cap stands 1 mm proud of the wall. To take the back plate out again, pull the caps first.

The back plate says what each button does, under the button: **RESET**, **1 CHECK** (check for pictures now; hold it while pressing reset to show the frame code), **2 NEXT** (the next picture now; hold it while pressing reset for the frame's status) and **3 SETUP** (hold it while pressing reset to open Wi-Fi setup).

The pads in the corners and on the sides stop 0.3 mm short of the panel. A thin strip of foam on each pad keeps the panel from rattling.

## Hanging and standing

Both work in portrait or landscape.

**On the wall** with a sawtooth bracket (two screws, 32.22 mm apart, `hang_pitch`):

- **Portrait:** there are two holes through the back plate on each long side, into the solid part of the frame. Screw the bracket to whichever side you want at the top. It sits flush with the back.
- **Landscape:** the board fills the top of the case, so the bracket can't screw in there. Instead it goes on `rail.stl`, which runs across the top. Swap the two top corner screws for M2 × 12 so they go through the rail, and screw the bracket into the two holes in the middle of the rail. The two small spacers go on the bottom corner screws, also M2 × 12, so the frame hangs straight. The rail and spacers add 6 mm behind the frame (`rail_t`). The bracket's screws go up to 5 mm into the rail. If yours are longer than the bracket's thickness plus 5 mm, they'll bottom out.

**On a table**, slide the two feet in `stand.stl` onto the bottom edge, one near each end. They hold the frame leaning back 15° (`stand_lean`). They grip any edge, so the same feet work in portrait and landscape. The slot is 0.3 mm wider than the frame (`stand_fit`). Lower this if the feet are loose.

Open `hanging` or `standing` in the Customizer to see either setup.

## Print notes

- 0.2 mm layers, 3 walls, 15% infill. PLA or PETG.
- The top of the USB-C opening is a short bridge, and the button holes are small enough to print round.
- Print the feet flat on their side as exported, so the slot needs no supports.
- Print the caps at 0.12 mm layers or finer. Their sleeve walls are only 0.5 mm.
- No supports needed on any part.
