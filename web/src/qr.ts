import qrcode from "qrcode-generator";

const SVG = "http://www.w3.org/2000/svg";

// Draws the QR code as SVG elements (no innerHTML), black on white with the 4-module quiet zone scanners need.
export function drawQr(svg: SVGSVGElement, text: string) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  }
  const size = n + 8;
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  const bg = document.createElementNS(SVG, "rect");
  bg.setAttribute("width", String(size));
  bg.setAttribute("height", String(size));
  bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000");
  svg.replaceChildren(bg, path);
}
