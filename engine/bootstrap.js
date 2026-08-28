import { parseIni, integer, tuple, list } from "./ini.js";
import { compile, instantiate } from "./script.js";

const root = document.querySelector("#engine-host");
const entry = document.querySelector('meta[name="game-entry"]')?.content;
const fetchText = async (path) => { const response = await fetch(path); if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`); return response.text(); };
const relative = (base, path) => new URL(path, new URL(base, location.href)).pathname.replace(/^\//, "");

async function boot() {
  const game = parseIni(await fetchText(entry), entry);
  const base = entry.slice(0, entry.lastIndexOf("/") + 1);
  const ui = parseIni(await fetchText(relative(base, game.package.interface)), game.package.interface);
  const roomsIndex = parseIni(await fetchText(relative(base, game.package.room_catalogue)));
  const graphics = parseIni(await fetchText(relative(base, game.package.graphics)));
  const script = compile(await fetchText(relative(base, game.package.entry_script)));
  const rooms = Object.create(null);
  for (const id of list(roomsIndex.catalogue.rooms)) rooms[id] = parseIni(await fetchText(relative(base, roomsIndex[`room.${id}`].path)));
  new Runtime(game, ui, rooms, graphics, script).start();
}

class Runtime {
  constructor(game, ui, rooms, graphics, handlers) {
    this.game = game; this.ui = ui; this.rooms = rooms; this.graphics = graphics; this.handlers = handlers;
    this.entities = Object.create(null); this.inventory = []; this.inventoryEntities = Object.create(null); this.activeVerb = null; this.firstObject = null; this.queue = []; this.message = ""; this.sentence = "";
    this.width = integer(game.display.logical_width, "logical_width"); this.height = integer(game.display.logical_height, "logical_height");
    this.canvas = document.createElement("canvas"); this.canvas.width = this.width; this.canvas.height = this.height;
    this.canvas.setAttribute("aria-label", ui.interface.accessible_label); this.canvas.tabIndex = 0; this.ctx = this.canvas.getContext("2d"); this.ctx.imageSmoothingEnabled = false;
    root.replaceChildren(this.canvas); root.ariaBusy = "false";
  }
  start() {
    this.dispatch("game.start", []); this.canvas.addEventListener("pointerdown", (event) => this.pointer(event));
    this.canvas.addEventListener("keydown", (event) => { if (event.key === "Escape") this.clearSelection(); });
    this.last = performance.now(); requestAnimationFrame((now) => this.frame(now));
  }
  dispatch(event, args) { const handler = this.handlers.find((candidate) => candidate.event === event && candidate.args.length === args.length); if (handler) this.queue.push(...instantiate(handler, args)); }
  enter(id, spawn) {
    const room = this.rooms[id]; if (!room) throw new Error(`Unknown room ${id}`); this.room = id; this.entities = Object.create(null);
    for (const [section, values] of Object.entries(room)) if (section.startsWith("entity.")) this.entities[section.slice(7)] = { id: section.slice(7), ...values, position: tuple(values.position, 2, `${section}.position`) };
    const point = tuple(room[`spawn.${spawn}`].position, 2, "spawn"); this.entities.player = { id: "player", position: point, graphic: "placeholder.actor", size: "16,32", label: "player", visible: "true" };
  }
  pointer(event) {
    if (this.queue.length) return;
    const rect = this.canvas.getBoundingClientRect(), x = (event.clientX - rect.left) * this.width / rect.width, y = (event.clientY - rect.top) * this.height / rect.height;
    for (const verb of list(this.ui.verb_panel.verbs)) { const box = tuple(this.ui[`verb.${verb}`].rect, 4, verb); if (inside(x,y,box)) { this.activeVerb = verb; this.firstObject = null; return; } }
    const inv = this.inventory.find((id, i) => inside(x,y,[...tuple(this.ui.inventory_panel.origin,2,"inventory"), integer(this.ui.inventory_panel.item_width,"item width"),integer(this.ui.inventory_panel.item_height,"item height")].map((v,n)=>n===0?v+i*integer(this.ui.inventory_panel.item_width,"item width"):v)));
    const target = inv || Object.values(this.entities).reverse().find((entity) => entity.id !== "player" && entity.visible !== "false" && inside(x,y,this.bounds(entity)))?.id;
    if (!this.activeVerb) { this.queue.push({ op: "walk", actor: "player", point: [Math.round(x), Math.round(y)] }); return; }
    if (this.activeVerb === "use") {
      if (!this.firstObject && target) { this.firstObject = target; return; }
      if (target) { this.sentence = `Use ${this.label(this.firstObject)} on ${this.label(target)}`; this.dispatch("entity.use_item", [this.firstObject, target]); }
    } else if (target) { this.sentence = `${title(this.activeVerb)} ${this.label(target)}`; this.dispatch(`entity.${this.activeVerb}`, [target]); }
    this.clearSelection();
  }
  clearSelection() { this.activeVerb = null; this.firstObject = null; }
  bounds(entity) { const size = tuple(entity.size || this.graphics[`graphic.${entity.graphic}`]?.width + "," + this.graphics[`graphic.${entity.graphic}`]?.height,2,entity.id); return [entity.position[0], entity.position[1], ...size]; }
  step() {
    const command = this.queue[0]; if (!command) return;
    if (command.op === "walk") { const actor = this.entities[command.actor], target = command.point || this.entities[command.target]?.position; if (!actor || !target) return void this.queue.shift(); const dx=target[0]-actor.position[0],dy=target[1]-actor.position[1],distance=Math.hypot(dx,dy); actor.facing=Math.abs(dx)>Math.abs(dy)?(dx<0?"left":"right"):(dy<0?"up":"down"); if(distance<=1.5) {actor.position=[...target];this.queue.shift();} else actor.position=[actor.position[0]+dx/distance*1.5,actor.position[1]+dy/distance*1.5]; return; }
    this.queue.shift();
    if (command.op === "enter") this.enter(command.room, command.spawn);
    else if (command.op === "say" || command.op === "narrate") this.message = command.value;
    else if (command.op === "take") { const entity=this.entities[command.target]; if(entity&&!this.inventory.includes(command.target)){entity.visible="false";this.inventoryEntities[command.target]={...entity};this.inventory.push(command.target);} }
    else if (command.op === "hide" || command.op === "show") this.entities[command.target].visible = command.op === "show" ? "true" : "false";
    else if (command.op === "set") { const [id,field]=command.target.split("."); if(id==="game") this[id] ??= {}, this[id][field]=command.value; else this.entities[id][field]=String(command.value); }
    else if (command.op === "wait") this.queue.unshift(...Array(command.ticks).fill({op:"pause"}));
    else if (command.op === "pause") return;
    else if (command.op === "face") this.entities[command.actor].facing=command.direction;
  }
  frame(now) { if(now-this.last>=1000/integer(this.game.runtime.ticks_per_second,"tick rate")){this.step();this.last=now;} this.draw(); requestAnimationFrame((time)=>this.frame(time)); }
  draw() {
    const c=this.ctx, room=this.rooms[this.room]; c.fillStyle=room?.room.background_color||"#000";c.fillRect(0,0,this.width,this.height);
    if(room) for(const entity of Object.values(this.entities)) if(entity.visible!=="false") this.rectangle(entity);
    for(const [i,id] of this.inventory.entries()){const entity=this.inventoryEntities[id], origin=tuple(this.ui.inventory_panel.origin,2,"inventory");this.rectangle({...entity,visible:"true",position:[origin[0]+i*integer(this.ui.inventory_panel.item_width,"item width"),origin[1]],size:`${this.ui.inventory_panel.item_width},${this.ui.inventory_panel.item_height}`});}
    this.textRegion(this.ui.message_region.rect,this.message);
    const composing=this.activeVerb ? [title(this.activeVerb),this.firstObject&&this.label(this.firstObject),this.activeVerb==="use"&&this.firstObject&&"on"].filter(Boolean).join(" ") : ""; this.textRegion(this.ui.sentence_region.rect,this.queue.length ? this.sentence : composing);
    for(const verb of list(this.ui.verb_panel.verbs)){const spec=this.ui[`verb.${verb}`];this.panel(spec.rect,spec.label,this.activeVerb===verb);}
  }
  label(id){return this.entities[id]?.label||id.replaceAll("_"," ");}
  rectangle(entity){const [x,y,w,h]=this.bounds(entity),graphic=this.graphics[`graphic.${entity.graphic}`];this.ctx.fillStyle=graphic?.missing_color||"#ff00ffff";this.ctx.fillRect(Math.round(x),Math.round(y),w,h);this.ctx.strokeStyle="#000";this.ctx.strokeRect(Math.round(x)+.5,Math.round(y)+.5,w-1,h-1);}
  textRegion(rect,text){const [x,y,w,h]=tuple(rect,4,"text region");this.ctx.fillStyle=this.ui.palette.panel;this.ctx.fillRect(x,y,w,h);this.ctx.fillStyle=this.ui.palette.text;this.ctx.font=this.ui.interface.font;this.ctx.textAlign="center";this.ctx.textBaseline="middle";this.ctx.fillText(text||"",x+w/2,y+h/2,w-4);}
  panel(rect,label,active){const [x,y,w,h]=tuple(rect,4,"panel");this.ctx.fillStyle=active?this.ui.palette.active:this.ui.palette.panel;this.ctx.fillRect(x,y,w,h);this.ctx.strokeStyle=this.ui.palette.border;this.ctx.strokeRect(x+.5,y+.5,w-1,h-1);this.ctx.fillStyle=this.ui.palette.text;this.ctx.font=this.ui.interface.font;this.ctx.textAlign="center";this.ctx.textBaseline="middle";this.ctx.fillText(label,x+w/2,y+h/2);}
}
const inside=(x,y,[bx,by,bw,bh])=>x>=bx&&y>=by&&x<bx+bw&&y<by+bh;
const title=(value)=>value[0].toUpperCase()+value.slice(1);
boot().catch((error)=>{root.textContent=`Cannot start game: ${error.message}`;root.ariaBusy="false";console.error(error);});
