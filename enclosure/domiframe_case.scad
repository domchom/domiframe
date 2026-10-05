// domiframe case: frame for a 7.3" e-paper panel driven by a
// Seeed XIAO ePaper Display Board, with a 603449 LiPo inside.
//
// Outer size follows hextheboy's "7.3 inch E-ink Paper Frame" on MakerWorld
// (191.2 x 132.2 x 16 mm); here it is 1 mm deeper and, with equal_bezels,
// 5 mm wider. The back is redone for the Seeed board: it sits
// against the top wall with its buttons, slide switch and USB-C facing up
// through a slot, and a small snap-in door covers the slot.
//
// Coordinates: X across, Y up (top of the frame is +Y), Z into the frame.
// Z = 0 is the front face. The back plate sits flush at Z = D.
//
// Pick a part from the dropdown in Window > Customizer, render (F6) and
// export (F7). ./export.sh writes every part to stl/ in one go.

/* [Part] */
part = "assembly"; // [assembly, frame, back, door, section]

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
screw_pilot = 1.9;       // M2 self-tapping: frame and standoff holes
screw_clear = 2.5;       // M2 clearance through the back plate
screw_head = 4.6;        // countersink diameter for the back plate screws
top_wall = 3;            // wall left between the board and the outside
board_gap = 0.3;         // board edge to that wall

usb_x = -25;             // USB-C centre, model X (mirror if it lands wrong)
usb_above_pcb = 3.0;     // USB-C centre above the PCB top
slot_len = 80;
slot_h = 8.5;

door_margin = 2.5;       // recess around the slot
door_margin_front = 1.5; // less on the front side, the bezel is close
door_t = 1;
door_clr = 0.15;
door_usb_cut = false;    // leave a hole so the cable fits with the door shut
slot_round = 2;          // corner radius on the slot, door and USB hole

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
slot_z0 = usb_z - slot_h / 2;
slot_z1 = usb_z + slot_h / 2;
door_x = slot_len / 2 + door_margin;
door_z0 = slot_z0 - door_margin_front;
door_z1 = slot_z1 + door_margin;

frame_screw = [
    for (sx = [-1, 1], sy = [-1, 1]) [sx * (pocket_w + rebate_w) / 4, (panel_y + sy * pocket_h / 2 + sy * rebate_h / 2) / 2],
    for (sx = [-1, 1]) [sx * (pocket_w + rebate_w) / 4, panel_y]
];

assert(H / 2 - rim - (pocket_h / 2 + fpc_side * panel_y) - fpc_notch > -0.5, "FPC notch breaks into the outer wall");
assert(bat_t + 1 <= plate_in_z - panel_back_z, "battery too thick for the frame depth");
assert(bat_y + bat_w / 2 + fence_t + 0.5 < board_top_y - board_wid, "battery fence runs into the board");
assert(bat_x - bat_l / 2 - 0.5 >= -(panel_w / 2 - 0.5 - pad_t), "battery space runs into the side pads");
assert(bat_y - bat_w / 2 - fence_t - 0.5 > panel_y - pocket_h / 2, "battery fence runs past the panel");
assert(max([for (p = support_posts) p[1]]) + post_size / 2 < board_top_y - board_wid - 0.5, "support posts run into the board");
assert(post_x1 > post_x0, "no room for support posts");
assert(slot_z0 > lip, "slot runs into the front bezel");
assert(door_z0 > front_chamfer, "door recess breaks through the front chamfer");
assert(door_z1 < plate_in_z, "door recess runs into the back rebate");
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

        // button / USB slot through the top wall
        ybox(-slot_len / 2, slot_len / 2, 0, H / 2 + eps, slot_z0, slot_z1, slot_round);

        // door recess and a pry notch at one end
        ybox(-door_x, door_x, H / 2 - door_t, H / 2 + eps, door_z0, door_z1, slot_round + door_margin_front);
        box(door_x - eps, door_x + 3, H / 2 - door_t, H / 2 + eps, usb_z - 2.5, usb_z + 2.5);

        // pilot holes for the back plate screws
        for (p = frame_screw) translate([p[0], p[1], plate_in_z - 8]) cylinder(d = screw_pilot, h = 8 + eps);
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

/* ---------- door (modelled in frame coordinates) ---------- */
module door() {
    sx = slot_len / 2 - door_clr;
    z0 = slot_z0 + door_clr;
    z1 = slot_z1 - door_clr;
    ring = 1;
    depth = top_wall - door_t - 0.4;
    difference() {
        union() {
            ybox(-door_x + door_clr, door_x - door_clr, H / 2 - door_t, H / 2 - 0.05, door_z0 + door_clr, door_z1 - door_clr, slot_round + door_margin_front - door_clr);
            difference() {
                ybox(-sx, sx, H / 2 - door_t - depth, H / 2 - door_t + eps, z0, z1, slot_round - door_clr);
                ybox(-sx + ring, sx - ring, H / 2 - door_t - depth - eps, H / 2 - door_t + 2 * eps, z0 + ring, z1 - ring, slot_round - door_clr - ring);
            }
            // friction bumps on the long sides
            for (x = [-sx * 0.6, 0, sx * 0.6], z = [z0, z1])
                translate([x, H / 2 - door_t - depth / 2, z]) rotate([0, 90, 0]) cylinder(r = 0.25, h = 6, center = true, $fn = 12);
        }
        if (door_usb_cut) ybox(usb_x - 7, usb_x + 7, H / 2 - 5, H / 2 + 1, usb_z - 4, usb_z + 4, slot_round);
    }
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
        color("black") for (i = [0:3]) translate([-5 + i * 10.5, board_wid / 2 - 2.5, -1.8]) cube([6, 3.5, 3.6], center = true);
        color("black") translate([33, board_wid / 2 - 2.5, -1.5]) cube([8, 4, 3], center = true);
    }
}

module battery_dummy() {
    color("gold") translate([bat_x, bat_y, plate_in_z - bat_t / 2]) cube([bat_l, bat_w, bat_t], center = true);
}

module assembly() {
    color("tan") frame();
    color("steelblue") back();
    color("white") door();
    panel_dummy();
    board_dummy();
    battery_dummy();
}

/* ---------- print orientations ---------- */
if (part == "frame") frame();                                          // front face down
if (part == "back") translate([0, 0, D]) rotate([180, 0, 0]) back();   // outside face down
if (part == "door") translate([0, 0, H / 2 - 0.05]) rotate([-90, 0, 0]) door();  // outside face down
if (part == "assembly") assembly();

// single pieces in frame coordinates, for viewers
if (part == "v_frame") frame();
if (part == "v_back") back();
if (part == "v_door") door();
if (part == "v_panel") panel_dummy();
if (part == "v_board") board_dummy();
if (part == "v_battery") battery_dummy();
if (part == "section") difference() {
    assembly();
    translate([-W, -H, -1]) cube([W, 2 * H, D + 10]);   // cut at X = 0, keep +X
}
