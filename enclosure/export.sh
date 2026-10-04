#!/bin/sh
# Export every printable part of the case to stl/.
#   ./export.sh              frame, back and door
#   ./export.sh back door    only the parts named
set -e
cd "$(dirname "$0")"
OPENSCAD=${OPENSCAD:-/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD}
[ $# -gt 0 ] || set -- frame back door
mkdir -p stl
for part in "$@"; do
  echo "exporting $part"
  "$OPENSCAD" -q -D "part=\"$part\"" -o "stl/$part.stl" domiframe_case.scad
done
