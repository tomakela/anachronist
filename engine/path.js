const resolutionOrigin = "https://game.invalid/";

export function resolvePackagePath(base, path) {
  const baseUrl = new URL(base, resolutionOrigin);
  return new URL(path, baseUrl).pathname.replace(/^\//, "");
}
