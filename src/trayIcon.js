// Draws the tray meter as a raw bitmap: five segments that fill left to right
// and bottom to top as utilization climbs. One pixel is 1% at the 2x scale.
// Pure code with no window, so it costs no renderer process and it can be tested.

const SIZE_PT = 22;
const SEGMENTS = 5;
const SEG_W_PT = 3;
const GAP_PT = 1;
const SEG_H_PT = 10;
const STROKE_PT = 1;

// Returns { buffer, width, height, scaleFactor } in 32-bit pixels. Colour is a
// single grey level, so the result is the same in BGRA and RGBA byte order.
function drawTrayIcon(percent, { scaleFactor = 2, level = 0 } = {}) {
  const width = SIZE_PT * scaleFactor;
  const height = SIZE_PT * scaleFactor;
  const buffer = Buffer.alloc(width * height * 4);

  const fillRect = (x, y, w, h) => {
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) {
        const i = (py * width + px) * 4;
        buffer[i] = level;
        buffer[i + 1] = level;
        buffer[i + 2] = level;
        buffer[i + 3] = 255;
      }
    }
  };

  const segW = SEG_W_PT * scaleFactor;
  const segH = SEG_H_PT * scaleFactor;
  const gap = GAP_PT * scaleFactor;
  const stroke = STROKE_PT * scaleFactor;
  const x0 = Math.round((width - (SEGMENTS * segW + (SEGMENTS - 1) * gap)) / 2);
  const y0 = Math.round((height - segH) / 2);

  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = (pct / 100) * SEGMENTS;

  for (let s = 0; s < SEGMENTS; s++) {
    const x = x0 + s * (segW + gap);
    // Outline.
    fillRect(x, y0, segW, stroke);
    fillRect(x, y0 + segH - stroke, segW, stroke);
    fillRect(x, y0, stroke, segH);
    fillRect(x + segW - stroke, y0, stroke, segH);
    // Fill, rising from the bottom edge.
    const fillPx = Math.round(segH * Math.max(0, Math.min(1, filled - s)));
    if (fillPx > 0) fillRect(x, y0 + segH - fillPx, segW, fillPx);
  }

  return { buffer, width, height, scaleFactor };
}

module.exports = { drawTrayIcon };
