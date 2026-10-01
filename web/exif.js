// The date a photo was taken, from the EXIF data in a JPEG (DateTimeOriginal, else DateTime).
// Only the first 128 KB is read: EXIF sits at the start of the file. Photos without it (most
// PNGs, screenshots, pictures saved from chats) have no date.

/** A File or Blob -> "YYYY-MM-DD", or null. */
export async function dateTaken(file) {
  try {
    return exifDate(new DataView(await file.slice(0, 128 * 1024).arrayBuffer()));
  } catch {
    return null;
  }
}

const DATE_TIME = 0x0132, EXIF_IFD = 0x8769, DATE_TIME_ORIGINAL = 0x9003;

/** The start of a JPEG as a DataView -> "YYYY-MM-DD", or null. */
export function exifDate(v) {
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null; // not a JPEG
  let off = 2;
  while (off + 4 <= v.byteLength) {
    const marker = v.getUint16(off), size = v.getUint16(off + 2);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null; // image data: no EXIF before it
    // APP1 starting "Exif\0\0"
    if (marker === 0xffe1 && size >= 8 && v.getUint32(off + 4) === 0x45786966 && v.getUint16(off + 8) === 0) {
      return fromTiff(v, off + 10, Math.min(v.byteLength, off + 2 + size));
    }
    off += 2 + size;
  }
  return null;
}

function fromTiff(v, base, end) {
  const order = v.getUint16(base);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const le = order === 0x4949; // "II": little-endian
  const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);

  /** The entries of the IFD at `at` (offset from the TIFF header), as tag -> entry offset. */
  const ifd = (at) => {
    const tags = new Map();
    const start = base + at;
    if (!at || start + 2 > end) return tags;
    const n = u16(start);
    for (let i = 0; i < n && start + 2 + i * 12 + 12 <= end; i++) {
      const e = start + 2 + i * 12;
      tags.set(u16(e), e);
    }
    return tags;
  };
  /** An ASCII date entry ("YYYY:MM:DD HH:MM:SS") -> "YYYY-MM-DD". */
  const date = (e) => {
    if (e === undefined || u16(e + 2) !== 2 || u32(e + 4) < 10) return null; // type 2 = ASCII
    const at = base + u32(e + 8);
    if (at + 10 > end) return null;
    let s = "";
    for (let i = 0; i < 10; i++) s += String.fromCharCode(v.getUint8(at + i));
    const m = s.match(/^(\d{4}):(\d{2}):(\d{2})$/);
    return m && m[1] !== "0000" ? `${m[1]}-${m[2]}-${m[3]}` : null;
  };

  const ifd0 = ifd(u32(base + 4));
  const exif = ifd0.has(EXIF_IFD) ? ifd(u32(ifd0.get(EXIF_IFD) + 8)) : new Map();
  return date(exif.get(DATE_TIME_ORIGINAL)) || date(ifd0.get(DATE_TIME));
}
