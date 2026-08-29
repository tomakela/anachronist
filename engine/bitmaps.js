import { resolvePackagePath } from "./path.js";

const base64Suffix = ".base64";
const pixelCache = new WeakMap();

/** Decode and cache bitmap pixels once for alpha-aware pointer hit testing. */
export function bitmapPixels(bitmap, canvasFactory = () => document.createElement("canvas")) {
  if (pixelCache.has(bitmap)) return pixelCache.get(bitmap);
  const canvas = canvasFactory(); canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true }); context.drawImage(bitmap, 0, 0);
  const result = { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
  pixelCache.set(bitmap, result); return result;
}

export function transparentBitmap(bitmap, color, canvasFactory = () => document.createElement("canvas")) {
  if (!color) return bitmap;
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})(?:[\da-f]{2})?$/i.exec(color.trim());
  if (!match) throw new Error(`transparent_color: expected #RRGGBB or #RRGGBBAA, got ${color}`);
  const key = match.slice(1, 4).map((part) => parseInt(part, 16));
  const canvas = canvasFactory(); canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i] === key[0] && image.data[i + 1] === key[1] && image.data[i + 2] === key[2]) image.data[i + 3] = 0;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

async function fetchBitmapSource(path, spec, fetcher) {
  const response = await fetcher(path);
  if (response.ok) return { response, base64: spec.encoding === "base64" || path.endsWith(base64Suffix) };

  if (path.toLowerCase().endsWith(".png")) {
    const encoded = await fetcher(`${path}${base64Suffix}`);
    if (encoded.ok) return { response: encoded, base64: true };
  }

  if (spec.optional === "true") return null;
  throw new Error(`${spec.path}: HTTP ${response.status}`);
}

export async function loadBitmaps(catalogue, base, fetcher = fetch, decode = createImageBitmap, canvasFactory) {
  const bitmaps = Object.create(null);
  await Promise.all(Object.entries(catalogue).filter(([section]) => section.startsWith("graphic.")).map(async ([section, spec]) => {
    const path = resolvePackagePath(base, spec.path);
    const source = await fetchBitmapSource(path, spec, fetcher);
    if (!source) return;
    const blob = source.base64
      ? await fetcher(`data:${spec.mime_type || "image/png"};base64,${(await source.response.text()).replace(/\s/g, "")}`).then((encoded) => encoded.blob())
      : await source.response.blob();
    bitmaps[section.slice(8)] = transparentBitmap(await decode(blob), spec.transparent_color, canvasFactory);
  }));
  return bitmaps;
}
