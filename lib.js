/* ResizeKB helpers: CRC32, stored ZIP packaging and print-DPI metadata patching.
   No dependencies. Exposed as window.ResizeKBLib and usable from Node for testing. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ResizeKBLib = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* Write a JFIF density in dots-per-inch. Patches the existing APP0 when present,
     otherwise inserts a fresh APP0 segment straight after SOI. */
  function setJpegDpi(bytes, dpi) {
    if (!bytes || bytes.length < 4) return bytes;
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes;
    var d = Math.max(1, Math.min(65535, Math.round(dpi)));

    if (bytes[2] === 0xFF && bytes[3] === 0xE0 && bytes.length > 18 &&
        bytes[6] === 0x4A && bytes[7] === 0x46 && bytes[8] === 0x49 && bytes[9] === 0x46) {
      var patched = new Uint8Array(bytes);
      patched[13] = 1; // units: dots per inch
      patched[14] = (d >> 8) & 0xFF;
      patched[15] = d & 0xFF;
      patched[16] = (d >> 8) & 0xFF;
      patched[17] = d & 0xFF;
      return patched;
    }

    var app0 = new Uint8Array([
      0xFF, 0xE0, 0x00, 0x10,             // marker + segment length (16)
      0x4A, 0x46, 0x49, 0x46, 0x00,       // "JFIF\0"
      0x01, 0x01,                         // version 1.1
      0x01,                               // units: dots per inch
      (d >> 8) & 0xFF, d & 0xFF,          // X density
      (d >> 8) & 0xFF, d & 0xFF,          // Y density
      0x00, 0x00                          // no thumbnail
    ]);
    var out = new Uint8Array(bytes.length + app0.length);
    out[0] = 0xFF;
    out[1] = 0xD8;
    out.set(app0, 2);
    out.set(bytes.subarray(2), 2 + app0.length);
    return out;
  }

  /* Insert a pHYs chunk after IHDR so PNG readers see the intended print DPI. */
  function setPngDpi(bytes, dpi) {
    if (!bytes || bytes.length < 33) return bytes;
    var signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (var i = 0; i < 8; i++) if (bytes[i] !== signature[i]) return bytes;

    var perMetre = Math.max(1, Math.min(0x7FFFFFFF, Math.round(dpi / 0.0254)));
    var chunk = new Uint8Array(21); // length(4) + type(4) + data(9) + crc(4)
    var view = new DataView(chunk.buffer);
    view.setUint32(0, 9);
    chunk.set([0x70, 0x48, 0x59, 0x73], 4); // pHYs
    view.setUint32(8, perMetre);
    view.setUint32(12, perMetre);
    chunk[16] = 1; // unit: metre
    view.setUint32(17, crc32(chunk.subarray(4, 17)));

    var out = new Uint8Array(bytes.length + chunk.length);
    out.set(bytes.subarray(0, 33), 0);   // signature + IHDR
    out.set(chunk, 33);
    out.set(bytes.subarray(33), 54);
    return out;
  }

  function dosDateTime(date) {
    var time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() / 2) & 0x1F);
    var day = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F);
    return { time: time & 0xFFFF, date: day & 0xFFFF };
  }

  /* Build a ZIP archive using the stored (uncompressed) method. Entries accept
     either { name, blob } or { name, bytes }. Images are already compressed, so
     storing them keeps the archive small in effort and exact in content. */
  async function makeZip(entries) {
    var encoder = new TextEncoder();
    var stamp = dosDateTime(new Date());
    var locals = [];
    var centrals = [];
    var offset = 0;

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var data = entry.bytes ? entry.bytes : new Uint8Array(await entry.blob.arrayBuffer());
      var name = encoder.encode(entry.name);
      var crc = crc32(data);

      var local = new Uint8Array(30 + name.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034B50, true);
      lv.setUint16(4, 20, true);        // version needed
      lv.setUint16(6, 0x0800, true);    // UTF-8 file names
      lv.setUint16(8, 0, true);         // stored
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);

      var central = new Uint8Array(46 + name.length);
      var cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014B50, true);
      cv.setUint16(4, 20, true);        // version made by
      cv.setUint16(6, 20, true);        // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);        // stored
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);   // local header offset
      central.set(name, 46);

      locals.push(local, data);
      centrals.push(central);
      offset += local.length + data.length;
    }

    var centralSize = centrals.reduce(function (sum, c) { return sum + c.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054B50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return new Blob(locals.concat(centrals, [end]), { type: 'application/zip' });
  }

  return { crc32: crc32, setJpegDpi: setJpegDpi, setPngDpi: setPngDpi, makeZip: makeZip };
});
