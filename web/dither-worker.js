// Dithers off the main thread, so sliders stay smooth while a picture is being worked out.
import { ditherToPalette } from "./dither.js";

self.onmessage = ({ data: { id, rgba, w, h, opts } }) => {
  const idx = ditherToPalette(rgba, w, h, opts);
  self.postMessage({ id, idx }, [idx.buffer]);
};
