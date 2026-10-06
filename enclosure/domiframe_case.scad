// domiframe case: frame for a 7.3" e-paper panel driven by a
// Seeed XIAO ePaper Display Board, with a 603449 LiPo inside.
//
// Outer size follows hextheboy's "7.3 inch E-ink Paper Frame" on MakerWorld
// (191.2 x 132.2 x 16 mm); here it is 1 mm deeper and, with equal_bezels,
// 5 mm wider. The back is redone for the Seeed board: it sits
// against the top wall with its buttons, slide switch and USB-C facing up.
// The USB-C gets its own opening, and each button gets a hole with a
// printed cap that presses onto the switch's plunger. The slide switch gets a
// slot and a press-on cap with a bigger tab to push.
//
// Hanging: a sawtooth bracket screws through the back plate into the solid frame
// down either side for portrait, or onto a rail across the top for landscape.
// Standing: two slip-on feet hold any edge, so they work either way round.
//
// Coordinates: X across, Y up (top of the frame is +Y), Z into the frame.
// Z = 0 is the front face. The back plate sits flush at Z = D.
//
// Pick a part from the dropdown in Window > Customizer, render (F6) and
// export (F7). ./export.sh writes every part to stl/ in one go.

/* [Part] */
part = "assembly"; // [assembly, frame, back, buttons, fit_test, rail, stand, section, hanging, standing]

/* [Outside] */
H = 132.2;          // frame height
D = 17;             // frame depth (back plate flush with the back)
R = 4;              // corner radius
front_chamfer = 1;

/* [Panel] */
panel_w = 169;      // glass outline
panel_h = 111;
panel_t = 1.2;
panel_clr = 0.4;    // per side
pocket_extra_w = 2; // extra width on the panel pocket, split across both sides
aa_w = 160;         // active area
aa_h = 96;
aa_top = 5;         // glass edge to active area on the side away from the FPC; the FPC side is 10
fpc_top = true;     // FPC tail (the panel's wide border) at the top, by the board and buttons
win_overlap = 0.5;  // bezel covers this much of the active area per side
lip = 2;            // front bezel thickness
panel_pocket = panel_t + 0.3;

// Centre the window and widen the frame so the bezel is the same on all four
// sides. Off: reference width, panel centred, wider bottom bezel.
equal_bezels = true;
W = equal_bezels ? H - (aa_h - 2 * win_overlap) + (aa_w - 2 * win_overlap) : 191.2;

fpc_w = 0;          // width of the FPC notch; 0 = as wide as the board pocket
fpc_notch = 3;

/* [Driver board] */
board_len = 80;          // along the button edge
board_wid = 41.2;
pcb_t = 1.6;
hole_dx = 75;            // mounting holes, centre to centre
hole_dy = 36;
edge_to_hole = 2.5;      // button edge -> nearest hole row (measure yours)
standoff_h = 2.5;
board_clearance = 6;     // free space above the board's top face (battery connector)
standoff_d = 5;
screw_pilot = 1.9;       // M2 self-tapping into the board standoffs
frame_pilot = 2.1;       // M2 self-tapping into the frame, for the back plate screws
frame_pilot_depth = 11;  // from the back rebate toward the front
screw_clear = 2.5;       // M2 clearance through the back plate
screw_head = 4.6;        // countersink diameter for the back plate screws
top_wall = 3;            // wall left between the board and the outside
board_gap = 0.3;         // board edge to that wall

/* [USB-C] */
usb_x = -25;             // USB-C centre, model X (mirror if it lands wrong)
usb_above_pcb = 3.0;     // USB-C centre above the PCB top
usb_hole_w = 12.5;       // opening in the top wall, sized for the plug's overmold,
usb_hole_h = 7;          // which has to go partway into the 3 mm wall
usb_overhang = 0;        // how far the socket sticks out past the board edge; past board_gap
usb_body_w = 9.2;        // this cuts a groove up the inside of the wall so it can slide in
usb_body_h = 3.3;

/* [Buttons] */
// Right-angle switches on the board's top edge. Each gets a hole in the top wall and a cap that
// presses onto its plunger from outside, after the back plate is in.
btn_names = ["RESET", "1 CHECK", "2 NEXT", "3 SETUP"];   // starting from the USB-C end
btn_first = 16.87;       // USB-C centre to the first button
btn_pitch = 9.16;        // button to button
btn_dir = 1;             // which way they run from the USB-C (model X); flip with usb_x
btn_from_back = 8.15;    // plunger centre to the back face of the frame
btn_tip = 0;             // plunger tip past the board edge; negative if it stops short of it
btn_post_len = 1.5;      // plunger length out of the switch body
btn_post_d = 2.3;        // plunger at the tip (2.35 at the base)
btn_bore = 2.3;          // socket in the cap; printed holes come out ~0.1 small, which is the grip
btn_grip = 1.0;          // how far the cap goes onto the plunger; the socket is blind so it stops there
btn_travel = 0.3;        // switch travel, kept clear between the cap and the switch body
btn_wall = 0.5;          // sleeve around the plunger
btn_head_d = 4.4;        // the part in the wall
btn_clr = 0.25;          // per side, head to hole
btn_proud = 1;           // how far the cap stands out of the wall

/* [Slide switch] */
// Past the last button, ON toward the outside. Its 1.55 mm square knob gets a cap with a
// bigger tab, sliding in a slot that is taller than it needs to be because the knob's
// distance from the back isn't quite repeatable.
sw_on_from_btn = 10.75;  // last button to the knob in the ON position
sw_window = 3.84;        // opening in the switch body; the knob slides this less its own width
sw_from_back = 8.15;     // knob centre to the back face of the frame
sw_z_play = 0.75;        // extra slot height on each side, front and back
sw_knob = 1.55;          // square knob
sw_socket = 1.55;        // square socket in the cap; prints a little small, which is the grip
sw_tip = 0;              // knob tip past the board edge; negative if it stops short of it
sw_post_len = 1.5;       // knob length out of the switch body
sw_grip = 1.0;           // how far the cap goes onto the knob; the socket is blind
sw_wall = 0.6;           // stem around the knob
sw_clr = 0.25;           // per side, stem to slot
sw_tab = [8, 6.5, 1.5];  // the part you push: along the wall, front to back, thickness
sw_tab_gap = 0.3;        // tab to wall

// What each button does, engraved into the back plate right under it, reading down from the top edge.
button_labels = true;
label_size = 2.6;
label_depth = 0.6;

/* [Battery] */
// Space is sized for the larger pack planned later (80 x 55 x 9). The current
// 50 x 32 x 6 one sits in a corner of the same fence on foam tape.
bat_l = 80;
bat_w = 55;
bat_t = 9;
bat_x = -38.3;           // centre; fence runs from the left pads to just past X = 0
bat_y = -8.8;            // fence top stops just under the board
fence_t = 1.2;           // fence walls run all the way up to the panel
ribbon_wall_h = 7;       // the fence wall on the ribbon side stops at this height so the ribbon can cross it
ribbon_cut_len = 15;     // length of the lowered part, from the fence's right edge
ribbon_round = 2;        // radius on the step down into the lowered part
lead_gap = true;         // opening for the leads in the board-side wall
lead_gap_side = -1;      // which half it goes in: -1 left, 1 right (model X)

/* [Back plate] */
plate_t = 2;
rim = 3;                 // frame wall around the back plate
plate_clr = 0.2;
retainer_gap = 0.3;      // pads, fence and posts stop this short of the panel (add foam)
pad_t = 5;               // how far the edge pads reach in from the glass edge
pad_len = 12;            // length of each pad leg
ribbon_gap = 35;         // clear channel right of the battery for the ribbon
post_size = 6;           // square posts under the panel on the other side
post_rows = [-34, -8, 16];   // post centres, model Y

/* [Wall hanging] */
// Sawtooth bracket with two screws. Portrait: through the back plate into the solid frame
// down either long side. Landscape: the board is in the way at the top, so the bracket goes
// on a rail held by the two top corner screws, with spacers on the bottom two.
hang_pitch = 32.22;      // bracket holes, centre to centre
hang_pilot = 1.8;        // for the bracket's 2.34 mm screws
hang_pilot_depth = 10;   // into the frame, from the back rebate
hang_clear = 2.8;        // through the back plate
hang_portrait_y = 0;     // centre of the bracket along the side (model Y)
rail_t = 6;              // rail and spacer thickness; adds this much behind the frame
rail_h = 10;

/* [Stand] */
// Two identical feet; slide one onto the bottom edge near each end.
stand_lean = 15;         // degrees back from upright
stand_fit = 0.3;         // slot width over the frame depth
stand_front_h = 7;       // lip over the front bezel (the bezel is 18.6)
stand_back_h = 22;       // support up the back
stand_floor = 3;         // under the edge
stand_wall = 2.5;
stand_len = 65;          // front of the foot to the end of the tail
stand_w = 16;            // along the edge
stand_base = 4;

/* [Hidden] */
$fn = 48;
eps = 0.01;

/* ---------- derived ---------- */
pocket_w = panel_w + 2 * panel_clr + pocket_extra_w;
pocket_h = panel_h + 2 * panel_clr;
panel_back_z = lip + panel_pocket;
plate_in_z = D - plate_t;
rebate_w = W - 2 * rim;
rebate_h = H - 2 * rim;

fpc_side = fpc_top ? 1 : -1;
aa_cy = -fpc_side * (panel_h / 2 - aa_top - aa_h / 2);   // active area centre, relative to the glass
panel_y = equal_bezels ? -aa_cy : 0;         // glass centre in the frame
win_y = panel_y + aa_cy;
fpc_y = panel_y + fpc_side * (pocket_h / 2 + fpc_notch);   // outer edge of the FPC notch
fpc_notch_w = fpc_w > 0 ? fpc_w : board_len + 2;
win_w = aa_w - 2 * win_overlap;
win_h = aa_h - 2 * win_overlap;

board_top_y = H / 2 - top_wall - board_gap;   // button edge
board_cy = board_top_y - board_wid / 2;
pcb_back_z = plate_in_z - standoff_h;
pcb_front_z = pcb_back_z - pcb_t;
holes_y0 = board_top_y - edge_to_hole;
board_holes = [for (sx = [-1, 1], y = [holes_y0, holes_y0 - hole_dy]) [sx * hole_dx / 2, y]];

pad_z = panel_back_z + retainer_gap;
fence_right = bat_x + bat_l / 2 + 0.5 + fence_t;
post_x0 = fence_right + ribbon_gap + post_size / 2;
post_x1 = panel_w / 2 - 0.5 - pad_t - 1 - post_size / 2;
support_posts = [for (x = [post_x0, (post_x0 + post_x1) / 2, post_x1], y = post_rows) [x, y]];

usb_z = pcb_front_z - usb_above_pcb;
wall_in_y = H / 2 - top_wall;

btn_x = [for (i = [0 : len(btn_names) - 1]) usb_x + btn_dir * (btn_first + i * btn_pitch)];
btn_z = D - btn_from_back;
btn_above_pcb = pcb_front_z - btn_z;
btn_hole_d = btn_head_d + 2 * btn_clr;
btn_sleeve_d = btn_bore + 2 * btn_wall;
btn_tip_y = board_top_y + btn_tip;              // plunger tip = bottom of the socket
btn_out_y = H / 2 + btn_proud;                  // outer face of the cap
cap_len = btn_out_y - (btn_tip_y - btn_grip);
cap_head_len = btn_out_y - (wall_in_y + 0.5);   // head stays in the wall even when pressed

sw_travel = sw_window - sw_knob;                 // ON to OFF, toward the buttons
sw_on_x = btn_x[len(btn_x) - 1] + btn_dir * sw_on_from_btn;
sw_off_x = sw_on_x - btn_dir * sw_travel;
sw_mid_x = (sw_on_x + sw_off_x) / 2;
sw_z = D - sw_from_back;
sw_stem = sw_socket + 2 * sw_wall;
sw_slot_l = sw_travel + sw_stem + 2 * sw_clr;
sw_slot_h = sw_stem + 2 * sw_clr + 2 * sw_z_play;
sw_tip_y = board_top_y + sw_tip;
sw_out_y = H / 2 + sw_tab_gap + sw_tab[2];       // outer face of the tab
sw_cap_len = sw_out_y - (sw_tip_y - sw_grip);

frame_screw = [
    for (sx = [-1, 1], sy = [-1, 1]) [sx * (pocket_w + rebate_w) / 4, (panel_y + sy * pocket_h / 2 + sy * rebate_h / 2) / 2],
    for (sx = [-1, 1]) [sx * (pocket_w + rebate_w) / 4, panel_y]
];

hang_x = (pocket_w + rebate_w) / 4;             // middle of the solid frame down each side
hang_pts = [for (sx = [-1, 1], sy = [-1, 1]) [sx * hang_x, hang_portrait_y + sy * hang_pitch / 2]];
screw_y_top = (panel_y + pocket_h / 2 + rebate_h / 2) / 2;
screw_y_bot = (panel_y - pocket_h / 2 - rebate_h / 2) / 2;

assert(H / 2 - rim - (pocket_h / 2 + fpc_side * panel_y) - fpc_notch > -0.5, "FPC notch breaks into the outer wall");
assert(bat_t + 1 <= plate_in_z - panel_back_z, "battery too thick for the frame depth");
assert(bat_y + bat_w / 2 + fence_t + 0.5 < board_top_y - board_wid, "battery fence runs into the board");
assert(bat_x - bat_l / 2 - 0.5 >= -(panel_w / 2 - 0.5 - pad_t), "battery space runs into the side pads");
assert(bat_y - bat_w / 2 - fence_t - 0.5 > panel_y - pocket_h / 2, "battery fence runs past the panel");
assert(max([for (p = support_posts) p[1]]) + post_size / 2 < board_top_y - board_wid - 0.5, "support posts run into the board");
assert(post_x1 > post_x0, "no room for support posts");
assert(plate_in_z - frame_pilot_depth >= 1.5, "back plate screw holes come too close to the front face");
assert(min([for (p = hang_pts) min([for (f = frame_screw) norm(p - f)])]) > screw_head / 2 + hang_clear / 2 + 1, "bracket holes run into the back plate screws");
assert(abs(hang_portrait_y) + hang_pitch / 2 + 2 < rebate_h / 2, "bracket holes run off the side");
assert(screw_y_top + rail_h / 2 < H / 2, "rail sticks out past the top");
assert(usb_z - usb_hole_h / 2 > lip, "USB-C opening runs into the front bezel");
assert(usb_z + usb_hole_h / 2 < plate_in_z, "USB-C opening runs into the back rebate");
assert(btn_z - btn_hole_d / 2 > lip && btn_z + btn_hole_d / 2 < plate_in_z, "button holes run out of the top wall");
assert(btn_dir * (btn_x[0] - usb_x) - btn_hole_d / 2 - usb_hole_w / 2 > 1, "first button hole runs into the USB-C opening");
assert(max([for (x = btn_x) abs(x)]) + btn_hole_d / 2 < board_len / 2, "buttons run past the board");
assert(btn_post_len - btn_grip >= btn_travel + 0.1, "cap would sit on the switch body; shorten btn_grip");
assert(btn_tip_y < wall_in_y, "plungers stick into the wall; the back plate won't go in");
assert(abs(sw_off_x - btn_x[len(btn_x) - 1]) - sw_tab[0] / 2 > btn_head_d / 2 + 0.5, "switch tab runs into the last button cap");
assert(abs(sw_on_x) + sw_tab[0] / 2 < W / 2 - R, "switch tab runs off the end of the wall");
assert(abs(sw_on_x) + sw_slot_l / 2 < board_len / 2 + 1, "switch slot runs past the board pocket");
assert(sw_z - sw_slot_h / 2 > lip && sw_z + sw_slot_h / 2 < plate_in_z, "switch slot runs out of the top wall");
assert(sw_z - sw_tab[1] / 2 > front_chamfer && sw_z + sw_tab[1] / 2 < D, "switch tab sticks out past the frame");
assert(sw_tip_y < wall_in_y, "switch knob sticks into the wall; the back plate won't go in");
assert(sw_post_len - sw_grip >= 0.2, "switch cap would rub on the switch body; shorten sw_grip");
assert(pcb_front_z - sw_z - sw_stem / 2 >= 0.15, str("switch cap only clears the PCB by ", pcb_front_z - sw_z - sw_stem / 2, " mm"));
assert(btn_above_pcb - btn_sleeve_d / 2 >= 0.15, str("cap sleeve only clears the PCB by ", btn_above_pcb - btn_sleeve_d / 2, " mm"));
assert(pcb_front_z - panel_back_z >= board_clearance + 0.5, str("only ", pcb_front_z - panel_back_z, " mm above the board"));

/* ---------- helpers ---------- */
module rrect(w, h, r) {
    offset(r) square([w - 2 * r, h - 2 * r], center = true);
}

module box(x0, x1, y0, y1, z0, z1) {
    translate([x0, y0, z0]) cube([x1 - x0, y1 - y0, z1 - z0]);
}

// box with its corners rounded as seen along Y (for openings in the top wall)
module ybox(x0, x1, y0, y1, z0, z1, r) {
    rr = min(r, (x1 - x0) / 2 - eps, (z1 - z0) / 2 - eps);
    translate([0, y1, 0]) rotate([90, 0, 0]) linear_extrude(y1 - y0)
        translate([x0, z0]) offset(rr) offset(delta = -rr) square([x1 - x0, z1 - z0]);
}

/* ---------- frame ---------- */
module frame() {
    difference() {
        hull() {
            translate([0, 0, front_chamfer]) linear_extrude(D - front_chamfer) rrect(W, H, R);
            linear_extrude(eps) rrect(W - 2 * front_chamfer, H - 2 * front_chamfer, R - front_chamfer);
        }

        // window, chamfered toward the front
        translate([0, win_y, 0]) hull() {
            translate([0, 0, -eps]) linear_extrude(eps) square([win_w + 2 * lip, win_h + 2 * lip], center = true);
            translate([0, 0, lip]) linear_extrude(eps) square([win_w, win_h], center = true);
        }
        translate([0, win_y, lip - eps]) linear_extrude(1) square([win_w, win_h], center = true);

        // panel pocket and the cavity behind it
        translate([0, panel_y, lip]) linear_extrude(D) square([pocket_w, pocket_h], center = true);

        // back plate rebate
        translate([0, 0, plate_in_z]) linear_extrude(D) rrect(rebate_w, rebate_h, max(R - rim, 0.5));

        // FPC tail notch
        box(-fpc_notch_w / 2, fpc_notch_w / 2, min(0, fpc_y), max(0, fpc_y), lip, D + eps);

        // board pocket in the top wall so the buttons sit near the outside
        box(-board_len / 2 - 1, board_len / 2 + 1, 0, H / 2 - top_wall, panel_back_z, D + eps);

        // USB-C opening, plus a groove up the inside if the socket overhangs the board
        ybox(usb_x - usb_hole_w / 2, usb_x + usb_hole_w / 2, wall_in_y - 1, H / 2 + 1, usb_z - usb_hole_h / 2, usb_z + usb_hole_h / 2, usb_hole_h / 2);
        if (board_top_y + usb_overhang > wall_in_y - 0.1)
            box(usb_x - usb_body_w / 2 - 0.3, usb_x + usb_body_w / 2 + 0.3, wall_in_y - 1, board_top_y + usb_overhang + 0.3, usb_z - usb_body_h / 2 - 0.3, D + eps);

        // slide switch slot
        ybox(sw_mid_x - sw_slot_l / 2, sw_mid_x + sw_slot_l / 2, wall_in_y - 1, H / 2 + 1, sw_z - sw_slot_h / 2, sw_z + sw_slot_h / 2, 0.8);

        // button holes
        for (x = btn_x) translate([x, H / 2 + 1, btn_z]) rotate([90, 0, 0]) cylinder(d = btn_hole_d, h = top_wall + 2);

        // pilot holes for the back plate screws
        for (p = frame_screw) translate([p[0], p[1], plate_in_z - frame_pilot_depth]) cylinder(d = frame_pilot, h = frame_pilot_depth + eps);

        // portrait bracket screws
        for (p = hang_pts) translate([p[0], p[1], plate_in_z - hang_pilot_depth]) cylinder(d = hang_pilot, h = hang_pilot_depth + eps);
    }
}

/* ---------- back plate (modelled in frame coordinates) ---------- */
module back() {
    pw = rebate_w - 2 * plate_clr;
    ph = rebate_h - 2 * plate_clr;
    difference() {
        union() {
            translate([0, 0, plate_in_z]) linear_extrude(plate_t) rrect(pw, ph, max(R - rim - plate_clr, 0.5));

            // board standoffs
            for (p = board_holes) translate([p[0], p[1], pcb_back_z]) cylinder(d = standoff_d, h = standoff_h + eps);

            // battery fence up to the panel, optionally open toward the board for the leads
            difference() {
                translate([bat_x, bat_y, pad_z]) linear_extrude(plate_in_z - pad_z + eps) difference() {
                    square([bat_l + 2 * fence_t + 1, bat_w + 2 * fence_t + 1], center = true);
                    square([bat_l + 1, bat_w + 1], center = true);
                    if (lead_gap) translate([lead_gap_side * bat_l / 4, bat_w / 2]) square([bat_l / 2, 4 * fence_t], center = true);
                }
                ribbon_cut();
            }
            ribbon_bullnose();

            // pads that hold the panel against the bezel
            px = panel_w / 2 - 0.5;
            py = panel_h / 2 - 0.5;
            for (sx = [-1, 1], sy = [-1, 1]) translate([0, panel_y, pad_z]) linear_extrude(plate_in_z - pad_z + eps) {
                translate([sx * (px - pad_len / 2), sy * (py - pad_t / 2)]) square([pad_len, pad_t], center = true);
                translate([sx * (px - pad_t / 2), sy * (py - pad_len / 2)]) square([pad_t, pad_len], center = true);
            }
            for (sx = [-1, 1]) translate([sx * (px - pad_t / 2), panel_y, pad_z]) linear_extrude(plate_in_z - pad_z + eps) square([pad_t, pad_len], center = true);

            // posts under the panel on the other side of the ribbon channel
            for (p = support_posts) translate([p[0], p[1], pad_z]) linear_extrude(plate_in_z - pad_z + eps) square(post_size, center = true);
        }

        for (p = board_holes) translate([p[0], p[1], pcb_back_z - eps]) cylinder(d = screw_pilot, h = standoff_h + plate_t - 0.6);

        // button labels on the outside, each with a mark pointing up at its button
        if (button_labels) for (i = [0 : len(btn_x) - 1]) translate([btn_x[i], ph / 2, D - label_depth]) linear_extrude(label_depth + eps) {
            translate([0, -1.5]) polygon([[-1.2, -1.6], [1.2, -1.6], [0, 0]]);
            translate([0, -4.6]) rotate(-90) text(btn_names[i], size = label_size, font = "Liberation Sans:style=Bold", halign = "left", valign = "center");
        }

        // portrait bracket screws pass through
        for (p = hang_pts) translate([p[0], p[1], plate_in_z - eps]) cylinder(d = hang_clear, h = plate_t + 1);

        // countersunk M2 holes into the frame
        for (p = frame_screw) translate([p[0], p[1], plate_in_z - eps]) {
            cylinder(d = screw_clear, h = plate_t + 1);
            translate([0, 0, plate_t - (screw_head - screw_clear) / 2]) cylinder(d1 = screw_clear, d2 = screw_head, h = (screw_head - screw_clear) / 2 + 2 * eps);
        }
    }
}

// Lowered, rounded section of the battery fence where the ribbon crosses.
// Fence corners, for the two modules below.
fence_left = bat_x - bat_l / 2 - 0.5 - fence_t;
fence_y0 = bat_y - bat_w / 2 - 0.5 - fence_t;
fence_y1 = bat_y + bat_w / 2 + 0.5 + fence_t;
ribbon_x0 = fence_right - ribbon_cut_len;
ribbon_zt = plate_in_z - ribbon_wall_h + fence_t / 2;   // wall top before the bullnose

// The step is drawn in the XZ plane and swept across the fence in Y.
module ribbon_cut() {
    r = ribbon_round;
    xa = ribbon_x0 - 4 * r - 2;
    xb = fence_right + 4 * r + 2;
    zb = plate_in_z + 4 * r + 2;
    translate([0, fence_y1 + 1, 0]) rotate([90, 0, 0]) linear_extrude(fence_y1 - fence_y0 + 2)
        intersection() {
            translate([xa + 2 * r, pad_z - 5]) square([xb - xa - 2 * r, zb - 2 * r - pad_z + 5]);
            difference() {
                translate([xa - 1, pad_z - 10]) square([xb - xa + 2, zb - pad_z + 20]);
                // fence material in this window, with the step rounded both ways
                offset(r = -r) offset(delta = r) offset(r = r) offset(delta = -r) difference() {
                    translate([xa, pad_z]) square([xb - xa, zb - pad_z]);
                    translate([ribbon_x0, pad_z - 1]) square([xb - ribbon_x0 + 1, ribbon_zt - pad_z + 1]);
                }
            }
        }
}

// Round over the tops of the lowered walls.
module ribbon_bullnose() {
    d = fence_t;
    xr = fence_right - d / 2;
    ys = [fence_y0 + d / 2, fence_y1 - d / 2];
    translate([xr, ys[0], ribbon_zt]) rotate([-90, 0, 0]) cylinder(d = d, h = ys[1] - ys[0], $fn = 16);
    for (y = ys) {
        translate([ribbon_x0 + ribbon_round, y, ribbon_zt]) rotate([0, 90, 0]) cylinder(d = d, h = xr - ribbon_x0 - ribbon_round, $fn = 16);
        translate([xr, y, ribbon_zt]) sphere(d = d, $fn = 16);
    }
}

/* ---------- button caps ---------- */
// Upright, outer face at Z = 0: a head that rides in the wall hole, then a thin sleeve with a
// blind socket that presses onto the plunger. dots marks the size in the fit test.
module button_cap(bore = btn_bore, dots = 0) {
    ch = 0.4;
    difference() {
        union() {
            cylinder(d1 = btn_head_d - 2 * ch, d2 = btn_head_d, h = ch);
            translate([0, 0, ch - eps]) cylinder(d = btn_head_d, h = cap_head_len - ch);
            cylinder(d = btn_sleeve_d, h = cap_len);
        }
        translate([0, 0, cap_len - btn_grip]) cylinder(d = bore, h = btn_grip + eps, $fn = 32);
        translate([0, 0, cap_len - 0.3]) cylinder(d1 = bore, d2 = bore + 0.6, h = 0.3 + eps, $fn = 32);
        if (dots > 0) for (i = [0 : dots - 1]) rotate(i * 360 / dots) translate([1.1, 0, -eps]) cylinder(d = 0.7, h = 0.4, $fn = 12);
    }
}

// Upright, outer face of the tab at Z = 0: the tab you push, then a square stem through the slot
// with a blind socket that presses onto the knob. Grooves across the tab for a thumbnail.
module switch_cap(socket = sw_socket, dots = 0) {
    t = sw_tab[2];
    difference() {
        union() {
            translate([0, 0, t / 2]) linear_extrude(t, center = true) rrect(sw_tab[0], sw_tab[1], 1);
            translate([0, 0, sw_cap_len / 2]) cube([sw_stem, sw_stem, sw_cap_len], center = true);
        }
        translate([0, 0, sw_cap_len - sw_grip]) linear_extrude(sw_grip + eps) square(socket, center = true);
        translate([0, 0, sw_cap_len - 0.3]) linear_extrude(0.3 + eps, scale = (socket + 0.6) / socket) square(socket, center = true);
        for (x = [-2, 0, 2]) translate([x, 0, 0]) cube([0.6, sw_tab[1] + 1, 0.8], center = true);
        if (dots > 0) for (i = [0 : dots - 1]) translate([(i - (dots - 1) / 2) * 1.6, -sw_tab[1] / 2 + 1, -eps]) cylinder(d = 0.7, h = 0.4, $fn = 12);
    }
}

// in frame coordinates, pushed home onto the plungers, switch ON
module caps() {
    for (x = btn_x) translate([x, btn_out_y, btn_z]) rotate([90, 0, 0]) button_cap();
    translate([sw_on_x, sw_out_y, sw_z]) rotate([90, 0, 0]) switch_cap();
}

/* ---------- landscape hanging rail (frame coordinates, on the back face) ---------- */
// Across the top, held by the two top corner screws (use M2 x 12 there); the bracket screws
// into its middle. Two spacers of the same thickness go on the bottom corner screws so the
// frame hangs straight.
module countersink(t) {
    translate([0, 0, -1]) cylinder(d = screw_clear, h = t + 2);
    translate([0, 0, t - (screw_head - screw_clear) / 2]) cylinder(d1 = screw_clear, d2 = screw_head, h = (screw_head - screw_clear) / 2 + eps);
}

module rail() {
    translate([0, 0, D]) {
        difference() {
            translate([0, screw_y_top, 0]) linear_extrude(rail_t) rrect(2 * hang_x + 10, rail_h, 3);
            for (sx = [-1, 1]) translate([sx * hang_x, screw_y_top, 0]) countersink(rail_t);
            for (sx = [-1, 1]) translate([sx * hang_pitch / 2, screw_y_top, 1]) cylinder(d = hang_pilot, h = rail_t);
        }
        for (sx = [-1, 1]) difference() {
            translate([sx * hang_x, screw_y_bot, 0]) linear_extrude(rail_t) rrect(10, rail_h, 3);
            translate([sx * hang_x, screw_y_bot, 0]) countersink(rail_t);
        }
    }
}

/* ---------- stand foot ---------- */
// Side profile, x toward the back, y up from the table. The frame's edge sits in a slot
// tilted back by stand_lean, with a short lip in front and a taller brace behind.
stand_slot = D + stand_fit;
stand_h0 = stand_floor * cos(stand_lean) + (stand_slot + stand_wall) * sin(stand_lean);
module stand_place() {
    translate([0, stand_h0]) rotate(-stand_lean) children();
}

module foot_profile() {
    x0 = -stand_wall * cos(stand_lean) - stand_floor * sin(stand_lean) - 1;
    difference() {
        hull() {
            translate([x0, 0]) square([stand_len - x0, stand_base]);
            stand_place() {
                translate([-stand_wall, -stand_floor]) square([stand_wall, stand_floor + stand_front_h]);
                translate([stand_slot, -stand_floor]) square([stand_wall, stand_floor + stand_back_h]);
            }
        }
        stand_place() square([stand_slot, 200]);
    }
}

module foot() {
    linear_extrude(stand_w) offset(r = 1) offset(delta = -1) foot_profile();   // flat on the bed
}

/* ---------- stand-ins for the assembly view ---------- */
module panel_dummy() {
    color("whitesmoke") translate([0, panel_y, lip]) linear_extrude(panel_t) square([panel_w, panel_h], center = true);
    color("orange") translate([0, panel_y + fpc_side * panel_h / 2, lip]) box(-14, 14, min(0, fpc_side * 2), max(0, fpc_side * 2), 0, 0.2);
}

module board_dummy() {
    translate([0, board_cy, pcb_front_z]) {
        color("darkslategray") linear_extrude(pcb_t) difference() {
            square([board_len, board_wid], center = true);
            for (p = board_holes) translate([p[0], p[1] - board_cy]) circle(d = 2.4);
        }
        color("silver") translate([usb_x, board_wid / 2 - 2.5, -usb_above_pcb - 1.6]) cube([9, 7.5, 3.2], center = true);
        for (x = btn_x) translate([x, board_wid / 2 + btn_tip, -btn_above_pcb]) {
            color("black") translate([0, -btn_post_len - 1.75, 0]) cube([6, 3.5, 2 * btn_above_pcb], center = true);
            color("dimgray") rotate([90, 0, 0]) cylinder(d = btn_post_d, h = btn_post_len);
        }
        translate([0, board_wid / 2 + sw_tip, sw_z - pcb_front_z]) {
            color("black") translate([sw_mid_x, -sw_post_len - 2, 0]) cube([8.5, 4, 3.4], center = true);
            color("dimgray") translate([sw_on_x, -sw_post_len / 2, 0]) cube([sw_knob, sw_post_len, sw_knob], center = true);
        }
    }
}

module battery_dummy() {
    color("gold") translate([bat_x, bat_y, plate_in_z - bat_t / 2]) cube([bat_l, bat_w, bat_t], center = true);
}

module assembly() {
    color("tan") frame();
    color("steelblue") back();
    color("white") caps();
    panel_dummy();
    board_dummy();
    battery_dummy();
}

/* ---------- print orientations ---------- */
if (part == "frame") frame();                                          // front face down
if (part == "back") translate([0, 0, D]) rotate([180, 0, 0]) back();   // outside face down
// outer faces down
if (part == "buttons") {
    for (i = [0 : len(btn_x) - 1]) translate([i * (btn_head_d + 4), 0, 0]) button_cap();
    translate([len(btn_x) * (btn_head_d + 4) + sw_tab[0] / 2 - 1, 0, 0]) switch_cap();
}
// button caps with sockets 0.1 under to 0.2 over btn_bore (1 to 4 dots), and switch caps
// 0.1 under to 0.1 over sw_socket (1 to 3 dots)
if (part == "fit_test") {
    for (i = [0 : 3]) translate([i * (btn_head_d + 4), 0, 0]) button_cap(btn_bore - 0.1 + i * 0.1, i + 1);
    for (i = [0 : 2]) translate([i * (sw_tab[0] + 3), -(btn_head_d / 2 + sw_tab[1] / 2 + 3), 0]) switch_cap(sw_socket - 0.1 + i * 0.1, i + 1);
}
if (part == "assembly") assembly();
if (part == "rail") translate([0, 0, -D]) rail();                       // back face down, countersinks up
if (part == "stand") for (i = [0, 1]) translate([0, i * (stand_back_h + 15), 0]) foot();
if (part == "hanging") { assembly(); color("white") rail(); }
// landscape on the table: frame coordinates turned so the bottom edge sits in the feet
if (part == "standing") {
    translate([0, 0, stand_h0]) rotate([0, stand_lean, 0]) multmatrix([[0, 0, 1, 0], [1, 0, 0, 0], [0, 1, 0, H / 2], [0, 0, 0, 1]]) assembly();
    for (sy = [-1, 1]) color("white") translate([0, sy * (W / 2 - 30) + stand_w / 2, 0]) rotate([90, 0, 0]) linear_extrude(stand_w) offset(r = 1) offset(delta = -1) foot_profile();
}

// single pieces in frame coordinates, for viewers
if (part == "v_frame") frame();
if (part == "v_back") back();
if (part == "v_caps") caps();
if (part == "v_panel") panel_dummy();
if (part == "v_board") board_dummy();
if (part == "v_battery") battery_dummy();
if (part == "section") difference() {
    assembly();
    translate([-W, -H, -1]) cube([W, 2 * H, D + 10]);   // cut at X = 0, keep +X
}
