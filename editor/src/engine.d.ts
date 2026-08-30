declare module "../../engine/ini.js" { export function parseIni(source: string, url?: string): Record<string, Record<string, string>>; }
declare module "../../engine/script.js" { export function compile(source: string, context?: object): unknown[]; }
