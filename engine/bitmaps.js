import { resolvePackagePath } from "./path.js";

const base64Suffix = ".base64";

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

export async function loadBitmaps(catalogue, base, fetcher = fetch, decode = createImageBitmap) {
  const bitmaps = Object.create(null);
  await Promise.all(Object.entries(catalogue).filter(([section]) => section.startsWith("graphic.")).map(async ([section, spec]) => {
    const path = resolvePackagePath(base, spec.path);
    const source = await fetchBitmapSource(path, spec, fetcher);
    if (!source) return;
    const blob = source.base64
      ? await fetcher(`data:${spec.mime_type || "image/png"};base64,${(await source.response.text()).replace(/\s/g, "")}`).then((encoded) => encoded.blob())
      : await source.response.blob();
    bitmaps[section.slice(8)] = await decode(blob);
  }));
  return bitmaps;
}
