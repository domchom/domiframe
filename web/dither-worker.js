// Dithers off the main thread, so sliders stay smooth while a picture is being worked out.
import { ditherWithPreview } from "./dither.js";

self.onmessage = ({ data: { id, rgba, w, h, opts } }) => {
  const { idx, shown } = ditherWithPreview(rgba, w, h, opts);
  self.postMessage({ id, idx, shown }, [idx.buffer, shown.buffer]);
};
