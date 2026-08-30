import { useEffect, useMemo, useRef, useState } from "react";
import { loadBitmaps } from "../../engine/bitmaps.js";
import { parseIni } from "../../engine/ini.js";
import { loadProject } from "../../engine/project.js";
import { Runtime } from "../../engine/runtime.js";
import type { EditorProjectService } from "./projectService";

type AnyRuntime = Runtime & Record<string, any>;
type StartSelection = { mode: "game" } | { mode: "room"; room: string; spawn: string };

/** SaveStorage-compatible, deliberately ephemeral storage for editor previews. */
export class PlaytestStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

class PreviewScheduler {
  callback?: FrameRequestCallback;
  requestFrame = (callback: FrameRequestCallback) => { this.callback = callback; return 1; };
  setTimeout = (callback: TimerHandler, delay?: number) => window.setTimeout(callback, delay);
  clearTimeout = (id: number) => window.clearTimeout(id);
}

const pretty = (value: unknown) => JSON.stringify(value ?? null, null, 2);

export function PlaytestHost({ service, onClose }: { service: EditorProjectService; onClose(): void }) {
  const host = useRef<HTMLDivElement>(null), runtime = useRef<AnyRuntime | undefined>(undefined), scheduler = useRef<PreviewScheduler | undefined>(undefined), animation = useRef<number | undefined>(undefined);
  const [rooms, setRooms] = useState<Record<string, string[]>>({}), [selection, setSelection] = useState<StartSelection>({ mode: "game" });
  const [status, setStatus] = useState<"stopped" | "playing" | "paused">("stopped"), [error, setError] = useState(""), [, refresh] = useState(0);
  const [startedRevision, setStartedRevision] = useState<number>(), [events, setEvents] = useState<any[]>([]), [handler, setHandler] = useState<any>(null);
  const stale = startedRevision !== undefined && service.contentRevision !== startedRevision;

  useEffect(() => { let cancelled = false; (async () => {
    const result: Record<string, string[]> = {};
    for (const entry of service.entries.filter(item => /rooms\/[^/]+\/room\.ini$/.test(item.path))) {
      const room = entry.path.match(/rooms\/([^/]+)\//)![1], ini = parseIni(await service.readProjectText(entry.path), entry.path);
      result[room] = Object.keys(ini).filter(key => key.startsWith("spawn.")).map(key => key.slice(6));
    }
    if (!cancelled) setRooms(result);
  })().catch(reason => setError(String(reason))); return () => { cancelled = true; }; }, [service.project?.name]);

  const entryPath = useMemo(() => service.entries.find(entry => entry.path === "game/game.ini")?.path
    || service.entries.find(entry => entry.path.endsWith("/game.ini"))?.path || "game.ini", [service.project?.name]);

  const stopLoop = () => { if (animation.current) cancelAnimationFrame(animation.current); animation.current = undefined; };
  const drawState = () => { const active = runtime.current; if (active) { active.draw(active.sceneSnapshot()); refresh(value => value + 1); } };
  const playLoop = () => { stopLoop(); const loop = (now: number) => { if (!runtime.current || status === "stopped") return; scheduler.current?.callback?.(now); drawState(); animation.current = requestAnimationFrame(loop); }; animation.current = requestAnimationFrame(loop); };
  useEffect(() => { if (status === "playing") playLoop(); else stopLoop(); return stopLoop; }, [status]);
  useEffect(() => { const changed = () => refresh(value => value + 1); service.addEventListener("change", changed); return () => service.removeEventListener("change", changed); }, []);

  const start = async () => {
    stopLoop(); setError(""); host.current?.replaceChildren();
    try {
      const snapshotRevision = service.contentRevision;
      const loadText = async (path: string, options: { optional?: boolean } = {}) => {
        if (options.optional && !service.entries.some(entry => entry.path === path)) return null;
        return service.readProjectText(path);
      };
      const fetcher: typeof fetch = async (input) => {
        const path = String(input);
        if (path.startsWith("data:")) return fetch(path);
        if (!service.entries.some(entry => entry.path === path)) return new Response(null, { status: 404 });
        return new Response(await service.readProjectBlob(path), { status: 200 });
      };
      const project = await (loadProject as any)(entryPath, { loadText, loadAssets: (graphics: any, base: string) => loadBitmaps(graphics, base, fetcher) });
      const frameScheduler = new PreviewScheduler(); scheduler.current = frameScheduler;
      const active: AnyRuntime = new (Runtime as any)(project, { host: host.current!, storage: new PlaytestStorage(), scheduler: frameScheduler,
        initialRoom: selection.mode === "room" ? { room: selection.room, spawn: selection.spawn } : undefined }) as AnyRuntime;
      const originalDispatch = active.dispatch.bind(active), originalExecute = active.execute.bind(active);
      active.dispatch = (name: string, args: unknown[]) => { const matched = active.matchingHandler(name, args); setHandler(matched ? { event: matched.event, args: matched.args, roomId: matched.roomId, itemId: matched.itemId } : null); setEvents(old => [...old, { tick: active.tick, event: name, args }].slice(-30)); return originalDispatch(name, args); };
      active.execute = (command: unknown) => { const result = originalExecute(command); setHandler(null); return result; };
      runtime.current = active; setEvents([]); active.start(); setStartedRevision(snapshotRevision); setStatus("playing"); drawState();
    } catch (reason) { runtime.current = undefined; setStatus("stopped"); setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const stop = () => { stopLoop(); runtime.current = undefined; scheduler.current = undefined; host.current?.replaceChildren(); setStartedRevision(undefined); setStatus("stopped"); setHandler(null); };
  const tick = () => { if (!runtime.current) return; runtime.current.step(); drawState(); };
  const active = runtime.current;
  const roomOptions = Object.keys(rooms), selectedRoom = selection.mode === "room" ? selection.room : roomOptions[0] || "";
  const debug = active && [{ label: "Globals", value: active.globals }, { label: "Per-room state", value: active.roomState }, { label: "Entities", value: active.entities }, { label: "Inventory", value: active.inventory }, { label: "Queued commands", value: active.queue }, { label: "Background tasks", value: active.backgroundTasks?.tasks }, { label: "Current handler", value: handler }, { label: "Recent dispatched events", value: events }];

  return <div className="playtest-document">
    <div className="playtest-tools"><b>PLAYTEST</b><select disabled={status !== "stopped"} value={selection.mode} onChange={event => event.target.value === "game" ? setSelection({ mode: "game" }) : setSelection({ mode: "room", room: roomOptions[0] || "", spawn: rooms[roomOptions[0]]?.[0] || "" })}><option value="game">Full game</option><option value="room">Direct room</option></select>
      {selection.mode === "room" && <><select disabled={status !== "stopped"} value={selectedRoom} onChange={event => setSelection({ mode: "room", room: event.target.value, spawn: rooms[event.target.value]?.[0] || "" })}>{roomOptions.map(room => <option key={room}>{room}</option>)}</select><select disabled={status !== "stopped"} value={selection.spawn} onChange={event => setSelection({ ...selection, spawn: event.target.value })}>{(rooms[selectedRoom] || []).map(spawn => <option key={spawn}>{spawn}</option>)}</select></>}
      <button disabled={!service.project || status !== "stopped"} onClick={start}>▶ Play</button><button disabled={status !== "playing"} onClick={() => setStatus("paused")}>Ⅱ Pause</button><button disabled={status === "stopped"} onClick={start}>↻ Restart</button><button disabled={status === "stopped"} onClick={stop}>■ Stop</button><button disabled={status !== "paused"} onClick={tick}>› Tick</button><button onClick={onClose}>Close</button>
      <span className={stale ? "stale" : "fresh"}>{stale ? "Preview is stale — restart to apply changed files" : status === "stopped" ? "Ready" : "Using editor snapshot"}</span></div>
    {error && <div className="warning">Cannot start playtest: {error}</div>}
    <div className="playtest-body"><div className="engine-preview" ref={host} /><aside className="debugger"><h2>READ-ONLY DEBUGGER</h2><div className="debug-summary"><b>Tick {active?.tick ?? 0}</b><span>Room: {active?.room || "—"}</span></div>{debug?.map(section => <details open key={section.label}><summary>{section.label}</summary><pre>{pretty(section.value)}</pre></details>)}</aside></div>
  </div>;
}
