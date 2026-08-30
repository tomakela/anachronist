import { useEffect, useMemo, useRef, useState } from "react";
import { loadBitmaps } from "../../engine/bitmaps.js";
import { entityHotspot, parseScalingStops } from "../../engine/interaction.js";
import { parseIniDocument } from "../../engine/ini.js";
import { drawRoomScene, entityBounds } from "../../engine/renderer.js";
import { editIniProperty } from "./roomSource";
import type { EditorProjectService } from "./projectService";

type Props = { path: string; source: string; service: EditorProjectService; onChange: (source: string) => void };
const nums = (value = "") => value.split(",").map(Number);

export function RoomDocument({ path, source, service, onChange }: Props) {
  const scene = useRef<HTMLCanvasElement>(null), overlay = useRef<HTMLCanvasElement>(null);
  const [assets, setAssets] = useState<any>(), [assetError, setAssetError] = useState(""), [zoom, setZoom] = useState(2), [pan, setPan] = useState([0, 0]), [cursor, setCursor] = useState([0, 0]);
  const [selected, setSelected] = useState<string>(), [snap, setSnap] = useState(1);
  const [layers, setLayers] = useState({ hotspots: true, triggers: true, walk: false, origins: true, perspective: true });
  const history = useRef<string[]>([]), future = useRef<string[]>([]), drag = useRef<any>(null);
  const room = useMemo(() => parseIniDocument(source, path).value, [source, path]);
  const dimensions = assets?.dimensions || [320, 200];
  const entities = useMemo(() => Object.fromEntries(Object.entries(room).filter(([key]) => key.startsWith("entity.")).map(([key, value]: any) => [key.slice(7), { ...value, id: key.slice(7), position: nums(value.position) }])), [room]);

  useEffect(() => { let live = true; (async () => {
    const gamePath = service.entries.find(entry => /(^|\/)game\/game\.ini$/.test(entry.path))?.path;
    if (!gamePath) throw new Error("game/game.ini was not found");
    const game = parseIniDocument(await service.readProjectText(gamePath), gamePath).value;
    const base = gamePath.slice(0, gamePath.lastIndexOf("/") + 1), graphicsPath = base + game.package.graphics;
    const graphics = parseIniDocument(await service.readProjectText(graphicsPath), graphicsPath).value;
    const resourceBase = graphicsPath.slice(0, graphicsPath.lastIndexOf("/") + 1);
    const fetcher = async (input: RequestInfo | URL) => { const url = String(input); if (url.startsWith("data:")) return fetch(url); try { return new Response(await service.readProjectBlob(url), { status: 200 }); } catch { return new Response(null, { status: 404 }); } };
    const bitmaps = await loadBitmaps(graphics, resourceBase, fetcher);
    if (live) { setAssets({ graphics, bitmaps, dimensions: [Number(game.display.logical_width), Number(game.display.logical_height)] }); setAssetError(""); }
  })().catch(error => { if (live) setAssetError(error instanceof Error ? error.message : String(error)); }); return () => { live = false; }; }, [service]);

  useEffect(() => {
    if (!assets || !scene.current || !overlay.current) return;
    const [width, height] = dimensions;
    for (const canvas of [scene.current, overlay.current]) { canvas.width = width; canvas.height = height; }
    const stops = (() => { try { return parseScalingStops(room.room?.player_scaling); } catch { return null; } })();
    drawRoomScene(scene.current.getContext("2d")!, { width, height, room, entities, graphics: assets.graphics, bitmaps: assets.bitmaps, scalingStops: stops });
    const c = overlay.current.getContext("2d")!; c.clearRect(0, 0, width, height); c.font = "7px monospace"; c.lineWidth = 1;
    if (layers.walk && room.room?.walk_mask && assets.bitmaps[room.room.walk_mask]) { c.save(); c.globalAlpha = .28; c.drawImage(assets.bitmaps[room.room.walk_mask], 0, 0, width, height); c.restore(); }
    for (const entity of Object.values(entities) as any[]) {
      const hot = entityHotspot(entity);
      if (layers.hotspots && hot) { c.strokeStyle = "#00e5ff"; c.fillStyle = "#00e5ff"; c.beginPath(); if (hot.kind === "rect") c.rect(hot.points[0], hot.points[1], hot.points[2], hot.points[3]); else hot.points.forEach(([x, y]: number[], i: number) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath(); c.stroke(); }
      if (layers.origins) { c.strokeStyle = entity.id === selected ? "#fff" : "#ffca55"; c.beginPath(); c.moveTo(entity.position[0] - 4, entity.position[1]); c.lineTo(entity.position[0] + 4, entity.position[1]); c.moveTo(entity.position[0], entity.position[1] - 4); c.lineTo(entity.position[0], entity.position[1] + 4); c.stroke(); }
      if (entity.id === selected) { const b = entityBounds(entity, assets.graphics); c.strokeStyle = "#fff"; c.setLineDash([3, 2]); c.strokeRect(b[0], b[1], b[2], b[3]); c.setLineDash([]); }
    }
    for (const [key, value] of Object.entries(room) as any[]) {
      if (layers.triggers && key.startsWith("trigger.")) { const r = nums(value.rect); c.strokeStyle = "#ff5470"; c.strokeRect(r[0], r[1], r[2], r[3]); c.fillStyle = "#ff5470"; c.fillText(key, r[0], r[1] - 2); }
      if (key.startsWith("spawn.")) { const p = nums(value.position); c.fillStyle = "#72f1a1"; c.beginPath(); c.arc(p[0], p[1], 3, 0, Math.PI * 2); c.fill(); c.fillText(key, p[0] + 4, p[1]); }
    }
    if (layers.perspective && stops) { c.strokeStyle = "#c78cff"; for (const [y, scale] of stops) { c.beginPath(); c.moveTo(0, y); c.lineTo(width, y); c.stroke(); c.fillStyle = "#c78cff"; c.fillText(`${scale}×`, 2, y - 2); } }
  }, [assets, dimensions, entities, layers, room, selected]);

  const logical = (event: React.PointerEvent) => { const rect = overlay.current!.getBoundingClientRect(); return [Math.round((event.clientX - rect.left) * dimensions[0] / rect.width), Math.round((event.clientY - rect.top) * dimensions[1] / rect.height)]; };
  const down = (event: React.PointerEvent) => { const point = logical(event); let hit: any;
    for (const [key, value] of Object.entries(room) as any[]) if ((key.startsWith("trigger.") || key.startsWith("entity.")) && (value.rect || value.hotspot_rect)) { const prop = value.rect ? "rect" : "hotspot_rect", r = nums(value[prop]); if (Math.hypot(point[0] - r[0] - r[2], point[1] - r[1] - r[3]) < 8) hit = { section: key, key: prop, start: r, resize: true }; }
    for (const [key, value] of Object.entries(room) as any[]) if (key.startsWith("spawn.") && Math.hypot(...nums(value.position).map((n, i) => n - point[i]) as [number, number]) < 7) hit = { section: key, key: "position", start: nums(value.position) };
    if (!hit) for (const entity of Object.values(entities) as any[]) { const b = entityBounds(entity, assets.graphics); if (point[0] >= b[0] && point[1] >= b[1] && point[0] <= b[0] + b[2] && point[1] <= b[1] + b[3]) hit = { section: `entity.${entity.id}`, key: "position", start: entity.position }, setSelected(entity.id); }
    drag.current = hit && { ...hit, point, source }; overlay.current!.setPointerCapture(event.pointerId);
  };
  const move = (event: React.PointerEvent) => { const point = logical(event); setCursor(point); if (!drag.current) return; const d = drag.current, round = (n: number) => Math.round(n / snap) * snap, dx = point[0] - d.point[0], dy = point[1] - d.point[1]; const value = d.resize ? [d.start[0], d.start[1], Math.max(0, round(d.start[2] + dx)), Math.max(0, round(d.start[3] + dy))] : [round(d.start[0] + dx), round(d.start[1] + dy)]; onChange(editIniProperty(d.source, d.section, d.key, value.join(","))); };
  const up = () => { if (drag.current) { history.current.push(drag.current.source); future.current = []; } drag.current = null; };
  const undo = () => { const value = history.current.pop(); if (value !== undefined) { future.current.push(source); onChange(value); } }, redo = () => { const value = future.current.pop(); if (value !== undefined) { history.current.push(source); onChange(value); } };

  const selectGraphic = (graphic: string) => selected && onChange(editIniProperty(source, `entity.${selected}`, "graphic", graphic));
  return <div className="room-document"><div className="room-tools"><button onClick={undo}>↶ Undo</button><button onClick={redo}>↷ Redo</button><label>Zoom <input type="range" min="1" max="6" step=".25" value={zoom} onChange={e => setZoom(+e.target.value)} /></label><label>Grid <input type="number" min="1" max="64" value={snap} onChange={e => setSnap(Math.max(1, +e.target.value))} /></label>{Object.keys(layers).map(key => <label key={key}><input type="checkbox" checked={(layers as any)[key]} onChange={e => setLayers({ ...layers, [key]: e.target.checked })} />{key}</label>)}<span>{cursor[0]}, {cursor[1]}</span></div>{assetError && <div className="warning">Room graphics could not be loaded: {assetError}</div>}<div className="room-body"><aside className="room-objects"><h2>ROOM OBJECTS</h2>{Object.values(entities).map((entity: any) => <button key={entity.id} className={selected === entity.id ? "selected" : ""} onClick={() => setSelected(entity.id)}><span>◆</span>{entity.id}</button>)}{selected && <div className="graphic-picker"><label htmlFor="entity-graphic">Graphic</label><select id="entity-graphic" value={(entities as any)[selected]?.graphic || ""} onChange={event => selectGraphic(event.target.value)}>{Object.keys(assets?.graphics || {}).filter(key => key.startsWith("graphic.")).map(key => key.slice(8)).map(id => <option key={id}>{id}</option>)}</select><small>Select an object here or click its sprite, then choose any project graphic.</small></div>}</aside><div className="room-viewport" onWheel={e => { if (e.ctrlKey) setZoom(Math.max(.5, Math.min(8, zoom - Math.sign(e.deltaY) * .25))); else setPan([pan[0] - e.deltaX, pan[1] - e.deltaY]); }}><div className="room-stage" style={{ width: dimensions[0] * zoom, height: dimensions[1] * zoom, transform: `translate(${pan[0]}px,${pan[1]}px)` }}><canvas ref={scene} /><canvas className="author-overlay" ref={overlay} onPointerDown={down} onPointerMove={move} onPointerUp={up} /></div></div></div></div>;
}
