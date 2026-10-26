export function toolbarIcon(bookmarked, count, size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.scale(size / 32, size / 32);
  ctx.lineJoin = "round";
  ctx.lineWidth = bookmarked ? 2 : 2.5;
  ctx.strokeStyle = "#bdc1c6";
  if (bookmarked) {
    const glow = ctx.createLinearGradient(5, 2, 27, 30);
    glow.addColorStop(0, "#ffb74d");
    glow.addColorStop(1, "#ff9800");
    ctx.strokeStyle = glow;
    ctx.shadowColor = "#ff9800";
    ctx.shadowBlur = 0.75;
  }
  const left = bookmarked ? 5 : 8, right = bookmarked ? 27 : 24;
  const top = bookmarked ? 2 : 4, bottom = bookmarked ? 30 : 28, notch = bookmarked ? 24 : 22;
  ctx.beginPath();
  ctx.moveTo(left, top); ctx.lineTo(right, top); ctx.lineTo(right, bottom);
  ctx.lineTo(16, notch); ctx.lineTo(left, bottom); ctx.closePath(); ctx.stroke();
  if (bookmarked) {
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffcc80";
    ctx.font = '600 18px "Segoe UI", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const text = String(Math.min(9, count));
    const bounds = ctx.measureText(text);
    ctx.fillText(text, 16 + (bounds.actualBoundingBoxLeft - bounds.actualBoundingBoxRight) / 2,
      14 + (bounds.actualBoundingBoxAscent - bounds.actualBoundingBoxDescent) / 2, 12);
  }
  return ctx.getImageData(0, 0, size, size);
}
