'use strict';

/*
 * ZFS I/O Flow viewer.
 *
 * The page contains no ZFS knowledge of its own: everything it shows comes
 * from the JSON block #graph-data, generated from the spec by build_graph.py.
 *
 * Function list (spec section 12, step 3). Inputs -> outputs; side effects.
 *
 * Data
 *   loadGraph()                 #graph-data -> state.graph and lookup maps. No DOM.
 *   sourceUrl(ref)              {file,line} -> GitHub URL at meta.commit.
 *   computePlayed(path, sel)    path + option selection -> played steps
 *                               [{index, n, wire, step, side}]. Pure.
 *   defaultSelection(path)      path -> {group: first option}. Pure.
 *   traceClosure(id, dir, depth, ignoreCtl) -> {nodes:Set, wires:Set}. Pure.
 *
 * Layout and geometry
 *   socketTypes(id, wires)      node id + wire list -> {ins:[type], outs:[type]}. Pure.
 *   layoutDefault()             -> {nodeId: {x,y}} from groups and node order (spec 7). Pure.
 *   computeDisplay()            filters, collapse state, positions -> state.disp
 *                               (display nodes, visible wires, sockets, sizes).
 *   groupFrames()               state.disp -> {groupId: {x,y,w,h}}. Pure.
 *   socketPoint(dn, side, type) display node + side + type -> {x,y}. Pure.
 *   wireGeometry(dw)            display wire -> SVG path string. Pure.
 *   worldBounds()               -> {x,y,w,h} enclosing every frame. Pure.
 *
 * Rendering
 *   renderAll()                 rebuilds groups, nodes, wires, then highlight + minimap.
 *   renderGroups()              draws group frames and titles into #layer-groups.
 *   renderNodes()               draws node boxes into #layer-nodes.
 *   renderWires()               draws wires and hit paths; fills state.wireEls.
 *   updatePositions()           moves node boxes, recomputes wire paths and frames.
 *   applyHighlight()            sets CSS classes on nodes and wires from the
 *                               current path / selection / trace / filters.
 *   renderBadges()              step-number badges for the active path.
 *   renderLegend(), renderGroupFilters(), renderPathList(), renderAbout()
 *                               build the static panels.
 *   renderDetails()             fills the right panel for the selection or path.
 *   renderMinimap()             draws groups and the viewport into the minimap.
 *   updateGroupLabels()         screen-space group titles when zoomed far out.
 *
 * View
 *   setViewTransform()          state.view -> root transform, grid, labels, minimap.
 *   fitView(bounds)             zooms and pans so bounds fill the canvas.
 *   screenToWorld(x, y)         canvas pixel -> graph coordinates. Pure.
 *
 * Interaction
 *   selectNode(id, center), selectWire(id, center), clearSelection()
 *   activatePath(id, sel, stepN), clearPath(), gotoStep(k), playPath(on)
 *   followStep(), showCaption(), animateDot(k)
 *   runSearch(text)             text -> result list in the left panel.
 *   showTooltip(evt, el), hideTooltip()
 *
 * Persistence
 *   saveLayout(), loadLayout(), saveView(), loadView()  browser storage, in try/catch.
 *   exportLayout(), importLayout(file)
 *   readHash(), writeHash()     URL hash <-> path/alt/step, node or wire.
 *
 * Suite (specs/zfs-viewer-suite-spec.md)
 *   pageFile(pageId)            page id -> its HTML file name, or null. Pure.
 *   renderSuiteNav()            fills the Graphs menu when the page is part of a suite.
 *   alsoInLinks(nodeId)         -> link elements to the same node on other pages.
 *
 * Timeline view (suite spec section 5)
 *   setView(mode)               'graph' | 'timeline'; shows the matching view.
 *   renderTimelineList()        scenario list in the left panel.
 *   activateTimeline(id, stepN) selects a scenario and a step (1-based).
 *   gotoTimelineStep(k)         moves to step index k; re-renders and animates.
 *   playTimeline(on)            starts or stops automatic stepping.
 *   renderTimelineStep()        draws strip, caption, dataset rows and tiles.
 *   timelineColour(birth)       birth txg -> tile colour (old dark, new bright). Pure.
 *   renderTimelineDetails(panel) right panel for the active scenario.
 *
 * init()                        wires everything together on load.
 */

// ---------------------------------------------------------------- constants

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_W = 300;
const TITLE_H = 28;
const ROW_H = 22;
const FOOT_H = 22;
const NODE_PAD = 6;
const COL_W = 400;
const NODE_GAP = 28;
const GROUP_PAD = 28;
const GROUP_PAD_TOP = 42;
const BAND_GAP = 90;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 2.5;

// One plain state object holds everything that changes.
const state = {
  graph: null,
  nodesById: {},
  wiresById: {},
  groupsById: {},
  typesById: {},
  ctxById: {},
  pathsById: {},
  typeOrder: [],
  groupNodes: {},
  pathsByWire: {},
  stagesByNode: {},
  defaultPos: {},
  pos: {},
  collapsed: {},
  groupMode: {},
  typeOn: {},
  ctxFilter: '',
  view: { x: 0, y: 0, k: 1 },
  disp: null,
  nodeEls: {},
  wireEls: {},
  select: null,
  trace: null,
  path: null,
  compare: '',
  storageKey: '',
  playTimer: null,
  dotFrame: null,
  mode: 'graph',
  timeline: null,
  tlDataset: null,
  tlTimer: null,
};

// ---------------------------------------------------------------- helpers

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const name in attrs) {
    el.setAttribute(name, attrs[name]);
  }
  if (parent) {
    parent.appendChild(el);
  }
  return el;
}

function htmlEl(tag, attrs, children) {
  const el = document.createElement(tag);
  for (const name in attrs || {}) {
    if (name === 'text') {
      el.textContent = attrs[name];
    } else if (name === 'className') {
      el.className = attrs[name];
    } else {
      el.setAttribute(name, attrs[name]);
    }
  }
  for (const child of children || []) {
    if (child === null || child === undefined) {
      continue;
    }
    if (typeof child === 'string') {
      el.appendChild(document.createTextNode(child));
    } else {
      el.appendChild(child);
    }
  }
  return el;
}

// Text from the spec may contain `code` spans; render them as <code>.
function richText(tag, text, className) {
  const el = htmlEl(tag, className ? { className: className } : {});
  const parts = text.split('`');
  parts.forEach((part, i) => {
    // `<page id>:<path id>` names a path on another page of the suite.
    const cross = i % 2 === 1 ? part.match(/^([a-z0-9-]+):(\w+)$/) : null;
    const file = cross && state.graph && state.graph.suite ? pageFile(cross[1]) : null;
    if (file) {
      el.appendChild(htmlEl('a', { href: file + '#path=' + cross[2], text: pageTitle(cross[1]) + ': ' + cross[2] }));
    } else if (i % 2 === 1) {
      el.appendChild(htmlEl('code', { text: part }));
    } else if (part) {
      el.appendChild(document.createTextNode(part));
    }
  });
  return el;
}

function byId(id) {
  return document.getElementById(id);
}

function indexBy(list) {
  const map = {};
  for (const item of list) {
    map[item.id] = item;
  }
  return map;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function hexToRgb(hex) {
  const value = parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function mixColor(hex, baseHex, amount) {
  const a = hexToRgb(hex);
  const b = hexToRgb(baseHex);
  const mixed = a.map((v, i) => Math.round(v * amount + b[i] * (1 - amount)));
  return 'rgb(' + mixed.join(',') + ')';
}

function lighten(hex, amount) {
  return mixColor('#ffffff', hex, amount);
}

function rgba(hex, alpha) {
  const c = hexToRgb(hex);
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
}

const measureCtx = document.createElement('canvas').getContext('2d');

function fitText(text, font, width) {
  measureCtx.font = font;
  if (measureCtx.measureText(text).width <= width) {
    return text;
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measureCtx.measureText(text.slice(0, mid) + '…').width <= width) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low) + '…';
}

function baseName(path) {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

function storageGet(key) {
  try {
    const text = window.localStorage.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch (err) {
    return null;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Storage unavailable: the page works without it.
  }
}

// ---------------------------------------------------------------- data

function loadGraph() {
  const graph = JSON.parse(byId('graph-data').textContent);
  state.graph = graph;
  state.nodesById = indexBy(graph.nodes);
  state.wiresById = indexBy(graph.wires);
  state.groupsById = indexBy(graph.groups);
  state.typesById = indexBy(graph.types);
  state.ctxById = indexBy(graph.contexts);
  state.pathsById = indexBy(graph.paths);
  state.typeOrder = graph.types.map((t) => t.id);
  for (const group of graph.groups) {
    state.groupNodes[group.id] = [];
    state.groupMode[group.id] = 'show';
  }
  for (const node of graph.nodes) {
    state.groupNodes[node.group].push(node.id);
  }
  for (const type of graph.types) {
    state.typeOn[type.id] = true;
  }
  for (const path of graph.paths) {
    for (const step of path.steps) {
      const list = state.pathsByWire[step.wire] || [];
      if (list.indexOf(path.id) < 0) {
        list.push(path.id);
      }
      state.pathsByWire[step.wire] = list;
    }
  }
  for (const stage of graph.stages) {
    if (stage.node) {
      const list = state.stagesByNode[stage.node] || [];
      list.push(stage);
      state.stagesByNode[stage.node] = list;
    }
  }
  // The page id keeps each suite page's layout separate; the I/O page keeps
  // its original key ("zfs-io-flow:<commit>").
  state.storageKey = (graph.page ? graph.page.id : 'zfs-io-flow') + ':' + graph.meta.commit;
}

// ---------------------------------------------------------------- suite

function pageFile(pageId) {
  const suite = state.graph.suite;
  if (!suite) {
    return null;
  }
  const page = suite.pages.find((p) => p.id === pageId);
  return page ? page.file : null;
}

function pageTitle(pageId) {
  const page = state.graph.suite.pages.find((p) => p.id === pageId);
  return page ? page.title : pageId;
}

function renderSuiteNav() {
  const suite = state.graph.suite;
  if (!suite) {
    return;
  }
  byId('suite-nav').hidden = false;
  const menu = byId('graph-menu');
  for (const page of suite.pages) {
    menu.appendChild(htmlEl('option', { value: page.file, text: page.title }));
  }
  menu.value = state.graph.page.file;
  menu.addEventListener('change', () => {
    window.location.href = menu.value;
  });
}

function alsoInLinks(nodeId) {
  const suite = state.graph.suite;
  if (!suite || !suite.alsoIn[nodeId]) {
    return [];
  }
  return suite.alsoIn[nodeId].map((pageId) => htmlEl('a', {
    className: 'also-link',
    href: pageFile(pageId) + '#node=' + encodeURIComponent(nodeId),
    text: pageTitle(pageId),
  }));
}

function sourceUrl(ref) {
  const meta = state.graph.meta;
  return meta.repo + '/blob/' + meta.commit + '/' + ref.file + '#L' + ref.line;
}

function defaultSelection(path) {
  const sel = {};
  for (const group of path.alts) {
    sel[group.id] = group.options[0].id;
  }
  return sel;
}

function stepMatches(step, sel) {
  for (const tag of step.when || []) {
    if (tag.options.indexOf(sel[tag.group]) < 0) {
      return false;
    }
  }
  return true;
}

function computePlayed(path, sel) {
  const played = [];
  const visited = new Set();
  path.steps.forEach((step, index) => {
    if (!stepMatches(step, sel)) {
      return;
    }
    const wire = state.wiresById[step.wire];
    const side = played.length > 0 && !visited.has(wire.from);
    played.push({ index: index, n: index + 1, wire: wire, step: step, side: side });
    visited.add(wire.from);
    visited.add(wire.to);
  });
  return played;
}

function traceClosure(startId, direction, depth, ignoreCtl) {
  const nodes = new Set([startId]);
  const wires = new Set();
  let frontier = [startId];
  let level = 0;
  while (frontier.length > 0 && (depth === 0 || level < depth)) {
    const next = [];
    for (const nodeId of frontier) {
      for (const wire of state.graph.wires) {
        if (ignoreCtl && wire.type === 'ctl') {
          continue;
        }
        if (!state.typeOn[wire.type]) {
          continue;
        }
        const near = direction === 'down' ? wire.from : wire.to;
        const far = direction === 'down' ? wire.to : wire.from;
        if (near !== nodeId) {
          continue;
        }
        wires.add(wire.id);
        if (!nodes.has(far)) {
          nodes.add(far);
          next.push(far);
        }
      }
    }
    frontier = next;
    level += 1;
  }
  return { nodes: nodes, wires: wires };
}

// ---------------------------------------------------------------- layout

function sortTypes(list) {
  return list.sort((a, b) => state.typeOrder.indexOf(a) - state.typeOrder.indexOf(b));
}

function socketTypes(nodeId, wires) {
  const ins = new Set();
  const outs = new Set();
  for (const wire of wires) {
    if (wire.to === nodeId) {
      ins.add(wire.type);
    }
    if (wire.from === nodeId) {
      outs.add(wire.type);
    }
  }
  return { ins: sortTypes(Array.from(ins)), outs: sortTypes(Array.from(outs)) };
}

function bodyHeight(socketRows) {
  return TITLE_H + Math.max(socketRows, 1) * ROW_H + FOOT_H + NODE_PAD;
}

function layoutDefault() {
  const pos = {};
  const bottoms = {};
  const groups = state.graph.groups.slice();
  groups.sort((a, b) => (a.band === 'bottom') - (b.band === 'bottom'));
  for (const group of groups) {
    let startY = 0;
    if (group.band === 'bottom') {
      const top = groups.find((g) => g.band === 'top' && g.col === group.col);
      if (top) {
        startY = bottoms[top.id] + GROUP_PAD + BAND_GAP + GROUP_PAD_TOP;
      }
    }
    const nextY = {};
    let bottom = startY;
    for (const nodeId of state.groupNodes[group.id]) {
      const node = state.nodesById[nodeId];
      const sockets = socketTypes(nodeId, state.graph.wires);
      const height = bodyHeight(Math.max(sockets.ins.length, sockets.outs.length));
      const y = nextY[node.sub] === undefined ? startY : nextY[node.sub];
      pos[nodeId] = { x: (group.col + node.sub) * COL_W, y: y };
      nextY[node.sub] = y + height + NODE_GAP;
      bottom = Math.max(bottom, y + height);
    }
    bottoms[group.id] = bottom;
  }
  return pos;
}

function computeDisplay() {
  const disp = { nodes: {}, list: [], map: {}, wires: [] };
  for (const node of state.graph.nodes) {
    const mode = state.groupMode[node.group];
    if (mode === 'hide') {
      disp.map[node.id] = null;
      continue;
    }
    if (mode === 'collapse') {
      const proxyId = 'group:' + node.group;
      disp.map[node.id] = proxyId;
      if (!disp.nodes[proxyId]) {
        const group = state.groupsById[node.group];
        disp.nodes[proxyId] = { id: proxyId, proxy: true, group: node.group, title: group.title, members: [] };
        disp.list.push(disp.nodes[proxyId]);
      }
      disp.nodes[proxyId].members.push(node.id);
      continue;
    }
    disp.map[node.id] = node.id;
    disp.nodes[node.id] = { id: node.id, proxy: false, group: node.group, title: node.title, node: node };
    disp.list.push(disp.nodes[node.id]);
  }
  for (const wire of state.graph.wires) {
    if (!state.typeOn[wire.type]) {
      continue;
    }
    const a = disp.map[wire.from];
    const b = disp.map[wire.to];
    if (!a || !b || a === b) {
      continue;
    }
    disp.wires.push({ id: wire.id, from: a, to: b, type: wire.type });
  }
  for (const dn of disp.list) {
    const sockets = socketTypes(dn.id, disp.wires);
    dn.ins = sockets.ins;
    dn.outs = sockets.outs;
    dn.collapsed = Boolean(state.collapsed[dn.id]);
    dn.w = NODE_W;
    dn.h = dn.collapsed ? TITLE_H : bodyHeight(Math.max(dn.ins.length, dn.outs.length));
    placeDisplayNode(dn);
  }
  state.disp = disp;
}

function placeDisplayNode(dn) {
  if (!dn.proxy) {
    dn.x = state.pos[dn.id].x;
    dn.y = state.pos[dn.id].y;
    return;
  }
  dn.x = Infinity;
  dn.y = Infinity;
  for (const memberId of dn.members) {
    dn.x = Math.min(dn.x, state.pos[memberId].x);
    dn.y = Math.min(dn.y, state.pos[memberId].y);
  }
}

function groupFrames() {
  const frames = {};
  for (const dn of state.disp.list) {
    const box = frames[dn.group] || { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    box.x1 = Math.min(box.x1, dn.x);
    box.y1 = Math.min(box.y1, dn.y);
    box.x2 = Math.max(box.x2, dn.x + dn.w);
    box.y2 = Math.max(box.y2, dn.y + dn.h);
    frames[dn.group] = box;
  }
  const result = {};
  for (const groupId in frames) {
    const box = frames[groupId];
    result[groupId] = {
      x: box.x1 - GROUP_PAD,
      y: box.y1 - GROUP_PAD_TOP,
      w: box.x2 - box.x1 + 2 * GROUP_PAD,
      h: box.y2 - box.y1 + GROUP_PAD + GROUP_PAD_TOP,
    };
  }
  return result;
}

function worldBounds() {
  const frames = groupFrames();
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const id in frames) {
    const f = frames[id];
    x1 = Math.min(x1, f.x);
    y1 = Math.min(y1, f.y);
    x2 = Math.max(x2, f.x + f.w);
    y2 = Math.max(y2, f.y + f.h);
  }
  if (x1 === Infinity) {
    return { x: 0, y: 0, w: 100, h: 100 };
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function socketPoint(dn, side, type) {
  const list = side === 'in' ? dn.ins : dn.outs;
  const row = Math.max(list.indexOf(type), 0);
  const x = side === 'in' ? dn.x : dn.x + dn.w;
  if (dn.collapsed) {
    return { x: x, y: dn.y + TITLE_H / 2 };
  }
  return { x: x, y: dn.y + TITLE_H + row * ROW_H + ROW_H / 2 };
}

// Fan index of each wire among wires sharing the same socket, so that
// parallel wires leave and arrive with slightly different tangents.
function computeFans() {
  const outGroups = {};
  const inGroups = {};
  for (const dw of state.disp.wires) {
    const outKey = dw.from + '|' + dw.type;
    const inKey = dw.to + '|' + dw.type;
    (outGroups[outKey] = outGroups[outKey] || []).push(dw);
    (inGroups[inKey] = inGroups[inKey] || []).push(dw);
  }
  const nodes = state.disp.nodes;
  for (const key in outGroups) {
    const list = outGroups[key].sort((a, b) => nodes[a.to].y - nodes[b.to].y);
    list.forEach((dw, i) => { dw.fanOut = i - (list.length - 1) / 2; });
  }
  for (const key in inGroups) {
    const list = inGroups[key].sort((a, b) => nodes[a.from].y - nodes[b.from].y);
    list.forEach((dw, i) => { dw.fanIn = i - (list.length - 1) / 2; });
  }
}

function wireGeometry(dw) {
  const source = state.disp.nodes[dw.from];
  const target = state.disp.nodes[dw.to];
  const s = socketPoint(source, 'out', dw.type);
  const t = socketPoint(target, 'in', dw.type);
  const fanOut = dw.fanOut || 0;
  const fanIn = dw.fanIn || 0;
  const dx = t.x - s.x;
  if (dx >= 40) {
    const off = clamp(Math.abs(dx) * 0.5, 60, 320);
    return 'M' + s.x + ',' + s.y +
      ' C' + (s.x + off) + ',' + (s.y + fanOut * 5) +
      ' ' + (t.x - off) + ',' + (t.y + fanIn * 5) +
      ' ' + t.x + ',' + t.y;
  }
  // Backward wire: leave to the right, run along a lane above or below
  // both nodes, and enter from the left, so it does not cross the boxes.
  const below = t.y >= s.y;
  const lane = below
    ? Math.max(source.y + source.h, target.y + target.h) + 26 + Math.abs(fanOut) * 6
    : Math.min(source.y, target.y) - 26 - Math.abs(fanOut) * 6;
  const k = 70;
  return 'M' + s.x + ',' + s.y +
    ' C' + (s.x + k) + ',' + s.y + ' ' + (s.x + k) + ',' + lane + ' ' + s.x + ',' + lane +
    ' L' + t.x + ',' + lane +
    ' C' + (t.x - k) + ',' + lane + ' ' + (t.x - k) + ',' + t.y + ' ' + t.x + ',' + t.y;
}

// ---------------------------------------------------------------- rendering

function clearLayer(id) {
  const layer = byId(id);
  while (layer.firstChild) {
    layer.removeChild(layer.firstChild);
  }
  return layer;
}

function renderAll() {
  computeDisplay();
  computeFans();
  renderGroups();
  renderWires();
  renderNodes();
  applyHighlight();
  renderMinimap();
  updateGroupLabels();
}

function renderGroups() {
  const layer = clearLayer('layer-groups');
  const frames = groupFrames();
  state.frameEls = {};
  for (const group of state.graph.groups) {
    const frame = frames[group.id];
    if (!frame) {
      continue;
    }
    const g = svgEl('g', { 'data-group': group.id }, layer);
    const rect = svgEl('rect', {
      class: 'group-frame', rx: 12,
      fill: rgba(group.color, 0.12), stroke: rgba(group.color, 0.45),
    }, g);
    const title = svgEl('text', { class: 'group-title', fill: lighten(group.color, 0.45) }, g);
    title.textContent = group.title;
    const summary = svgEl('text', { class: 'group-summary' }, g);
    summary.textContent = fitText(group.summary, '11px ' + getComputedStyle(document.body).fontFamily, frame.w - 24);
    title.addEventListener('mousedown', (evt) => startGroupDrag(evt, group.id));
    title.addEventListener('dblclick', (evt) => {
      evt.stopPropagation();
      fitView(groupFrames()[group.id]);
    });
    state.frameEls[group.id] = { rect: rect, title: title, summary: summary, g: g };
    placeFrame(group.id, frame);
  }
}

function placeFrame(groupId, frame) {
  const els = state.frameEls[groupId];
  if (!els || !frame) {
    return;
  }
  els.rect.setAttribute('x', frame.x);
  els.rect.setAttribute('y', frame.y);
  els.rect.setAttribute('width', frame.w);
  els.rect.setAttribute('height', frame.h);
  els.title.setAttribute('x', frame.x + 12);
  els.title.setAttribute('y', frame.y + 22);
  els.summary.setAttribute('x', frame.x + 12);
  els.summary.setAttribute('y', frame.y + 36);
}

function titleBarPath(collapsed) {
  if (collapsed) {
    return 'M0,8 a8,8 0 0 1 8,-8 h' + (NODE_W - 16) + ' a8,8 0 0 1 8,8 v' + (TITLE_H - 16) +
      ' a8,8 0 0 1 -8,8 h-' + (NODE_W - 16) + ' a8,8 0 0 1 -8,-8 z';
  }
  return 'M0,8 a8,8 0 0 1 8,-8 h' + (NODE_W - 16) + ' a8,8 0 0 1 8,8 v' + (TITLE_H - 8) +
    ' h-' + NODE_W + ' z';
}

function renderNodes() {
  const layer = clearLayer('layer-nodes');
  const font = getComputedStyle(document.body).fontFamily;
  const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono');
  state.nodeEls = {};
  for (const dn of state.disp.list) {
    const group = state.groupsById[dn.group];
    const g = svgEl('g', { class: 'node' + (dn.proxy ? ' proxy' : ''), 'data-id': dn.id }, layer);
    svgEl('rect', { class: 'body', width: dn.w, height: dn.h, rx: 8, filter: 'url(#shadow)' }, g);
    svgEl('path', { d: titleBarPath(dn.collapsed), fill: mixColor(group.color, '#2b2b2b', 0.55) }, g);

    // Context pill
    const pillText = dn.proxy ? 'group' : dn.node.ctx;
    measureCtx.font = '10px ' + mono;
    const pillW = measureCtx.measureText(pillText).width + 12;
    const pill = svgEl('g', {}, g);
    svgEl('rect', { class: 'pill', x: dn.w - pillW - 8, y: 6, width: pillW, height: 16, rx: 8 }, pill);
    const pt = svgEl('text', { class: 'pill-text', x: dn.w - pillW / 2 - 8, y: 17.5, 'text-anchor': 'middle' }, pill);
    pt.textContent = pillText;
    if (!dn.proxy) {
      const tip = svgEl('title', {}, pill);
      const ctx = state.ctxById[dn.node.ctx];
      tip.textContent = ctx ? ctx.id + ': ' + ctx.name : dn.node.ctx;
    }

    // Chain-link marker for nodes that also appear on other suite pages.
    let markerW = 0;
    const others = !dn.proxy && state.graph.suite ? state.graph.suite.alsoIn[dn.id] : null;
    if (others) {
      markerW = 22;
      const cx = dn.w - pillW - 22;
      const mark = svgEl('g', { class: 'shared-mark' }, g);
      svgEl('rect', { x: cx - 9, y: 6, width: 18, height: 16, fill: 'transparent' }, mark);
      svgEl('circle', { cx: cx - 3, cy: 14, r: 3.6, fill: 'none', stroke: '#eee', 'stroke-width': 1.6 }, mark);
      svgEl('circle', { cx: cx + 3, cy: 14, r: 3.6, fill: 'none', stroke: '#eee', 'stroke-width': 1.6 }, mark);
      const tip = svgEl('title', {}, mark);
      tip.textContent = 'Also in: ' + others.map(pageTitle).join(', ');
    }

    const title = svgEl('text', { class: 'title-text', x: 10, y: 18.5 }, g);
    title.textContent = fitText(dn.title, '600 13px ' + font, dn.w - pillW - 26 - markerW);

    if (!dn.collapsed) {
      renderSockets(g, dn);
      renderFoot(g, dn, mono);
    }
    svgEl('rect', { class: 'outline', width: dn.w, height: dn.h, rx: 8 }, g);
    g.setAttribute('transform', 'translate(' + dn.x + ',' + dn.y + ')');
    g.addEventListener('mousedown', (evt) => startNodeDrag(evt, dn.id));
    g.addEventListener('dblclick', (evt) => {
      const point = screenToWorld(evt.clientX, evt.clientY);
      if (point.y - dn.y <= TITLE_H) {
        evt.stopPropagation();
        toggleCollapsed(dn.id);
      }
    });
    state.nodeEls[dn.id] = g;
  }
}

function renderSockets(g, dn) {
  dn.ins.forEach((type, row) => {
    const y = TITLE_H + row * ROW_H + ROW_H / 2;
    svgEl('circle', { cx: 0, cy: y, r: 5, fill: state.typesById[type].color, stroke: '#111', 'stroke-width': 1 }, g);
    const label = svgEl('text', { class: 'sock-label', x: 11, y: y + 3.5 }, g);
    label.textContent = type;
  });
  dn.outs.forEach((type, row) => {
    const y = TITLE_H + row * ROW_H + ROW_H / 2;
    svgEl('circle', { cx: dn.w, cy: y, r: 5, fill: state.typesById[type].color, stroke: '#111', 'stroke-width': 1 }, g);
    const label = svgEl('text', { class: 'sock-label', x: dn.w - 11, y: y + 3.5, 'text-anchor': 'end' }, g);
    label.textContent = type;
  });
}

function renderFoot(g, dn, mono) {
  const rows = Math.max(dn.ins.length, dn.outs.length, 1);
  const y = TITLE_H + rows * ROW_H + 15;
  const foot = svgEl('text', { class: 'foot', x: 10, y: y }, g);
  let text;
  if (dn.proxy) {
    text = dn.members.length + ' nodes (group collapsed)';
  } else if (dn.node.fns.length > 0) {
    const first = dn.node.fns[0];
    text = first.name + '()  ' + baseName(dn.node.src || (first.ref ? first.ref.file : ''));
    if (first.ref) {
      foot.classList.add('link');
      foot.addEventListener('mouseenter', (evt) => showTooltip(evt, refTooltip(first.name + '()', [first.ref])));
      foot.addEventListener('mousemove', moveTooltip);
      foot.addEventListener('mouseleave', hideTooltip);
      foot.dataset.url = sourceUrl(first.ref);
    }
  } else {
    text = dn.node.role;
  }
  foot.textContent = fitText(text, '11px ' + mono, dn.w - 20);
}

function renderWires() {
  const layer = clearLayer('layer-wires');
  const hits = clearLayer('layer-hits');
  state.wireEls = {};
  for (const dw of state.disp.wires) {
    const type = state.typesById[dw.type];
    const d = wireGeometry(dw);
    const line = svgEl('path', { class: 'wire ' + dw.type, d: d, stroke: type.color }, layer);
    const hit = svgEl('path', { class: 'hit', d: d, 'data-id': dw.id }, hits);
    hit.addEventListener('mouseenter', (evt) => showTooltip(evt, wireTooltip(dw.id)));
    hit.addEventListener('mousemove', moveTooltip);
    hit.addEventListener('mouseleave', hideTooltip);
    hit.addEventListener('click', (evt) => {
      evt.stopPropagation();
      selectWire(dw.id, false);
    });
    state.wireEls[dw.id] = { line: line, hit: hit, dw: dw };
  }
}

function updatePositions() {
  for (const dn of state.disp.list) {
    placeDisplayNode(dn);
    const g = state.nodeEls[dn.id];
    if (g) {
      g.setAttribute('transform', 'translate(' + dn.x + ',' + dn.y + ')');
    }
  }
  computeFans();
  for (const id in state.wireEls) {
    const els = state.wireEls[id];
    const d = wireGeometry(els.dw);
    els.line.setAttribute('d', d);
    els.hit.setAttribute('d', d);
  }
  const frames = groupFrames();
  for (const groupId in frames) {
    placeFrame(groupId, frames[groupId]);
  }
  renderBadges();
  updateGroupLabels();
  renderMinimap();
}

// ---------------------------------------------------------------- highlight

function displayIdOf(nodeId) {
  return state.disp.map[nodeId];
}

function highlightSets() {
  // Returns {nodes, wires} that stay at full strength, or null for no dimming.
  if (state.path) {
    const nodes = new Set();
    const wires = new Set();
    for (const p of state.path.played) {
      wires.add(p.wire.id);
      nodes.add(displayIdOf(p.wire.from));
      nodes.add(displayIdOf(p.wire.to));
    }
    return { nodes: nodes, wires: wires };
  }
  if (state.trace) {
    const nodes = new Set();
    for (const id of state.trace.result.nodes) {
      nodes.add(displayIdOf(id));
    }
    return { nodes: nodes, wires: state.trace.result.wires };
  }
  if (state.select && state.select.kind === 'node') {
    const id = state.select.id;
    const nodes = new Set([id]);
    const wires = new Set();
    for (const dw of state.disp.wires) {
      if (dw.from === id || dw.to === id) {
        wires.add(dw.id);
        nodes.add(dw.from);
        nodes.add(dw.to);
      }
    }
    return { nodes: nodes, wires: wires };
  }
  if (state.select && state.select.kind === 'wire') {
    const els = state.wireEls[state.select.id];
    const nodes = new Set();
    if (els) {
      nodes.add(els.dw.from);
      nodes.add(els.dw.to);
    }
    return { nodes: nodes, wires: new Set([state.select.id]) };
  }
  if (state.ctxFilter) {
    const nodes = new Set();
    for (const dn of state.disp.list) {
      if (!dn.proxy && dn.node.ctx === state.ctxFilter) {
        nodes.add(dn.id);
      }
    }
    const wires = new Set();
    for (const dw of state.disp.wires) {
      if (nodes.has(dw.from) && nodes.has(dw.to)) {
        wires.add(dw.id);
      }
    }
    return { nodes: nodes, wires: wires };
  }
  return null;
}

function currentStep() {
  if (!state.path || state.path.cur < 0) {
    return null;
  }
  return state.path.played[state.path.cur];
}

function applyHighlight() {
  const sets = highlightSets();
  const step = currentStep();
  const currentNodes = new Set();
  if (step) {
    currentNodes.add(displayIdOf(step.wire.from));
    currentNodes.add(displayIdOf(step.wire.to));
  }
  const selectedNode = state.select && state.select.kind === 'node' ? state.select.id : null;
  for (const dn of state.disp.list) {
    const g = state.nodeEls[dn.id];
    const lit = sets ? sets.nodes.has(dn.id) : false;
    g.classList.toggle('dim', Boolean(sets) && !lit && dn.id !== selectedNode);
    g.classList.toggle('onpath', Boolean(state.path) && lit);
    g.classList.toggle('current', currentNodes.has(dn.id));
    g.classList.toggle('selected', dn.id === selectedNode);
    g.classList.toggle('ctxmark', Boolean(state.ctxFilter) && !dn.proxy && dn.node.ctx === state.ctxFilter);
  }

  const altWires = new Set();
  if (state.path) {
    const path = state.pathsById[state.path.id];
    for (const s of path.steps) {
      if (!sets.wires.has(s.wire)) {
        altWires.add(s.wire);
      }
    }
  }
  const compare = compareSets();
  const layer = byId('layer-wires');
  const raised = [];
  for (const id in state.wireEls) {
    const line = state.wireEls[id].line;
    const lit = sets ? sets.wires.has(id) : false;
    line.classList.toggle('lit', lit);
    line.classList.toggle('dim', Boolean(sets) && !lit && !altWires.has(id));
    line.classList.toggle('alt', altWires.has(id));
    line.classList.toggle('current', Boolean(step) && step.wire.id === id);
    line.classList.toggle('cmp-both', Boolean(compare) && compare.both.has(id));
    line.classList.toggle('cmp-a', Boolean(compare) && compare.onlyA.has(id));
    line.classList.toggle('cmp-b', Boolean(compare) && compare.onlyB.has(id));
    if (lit) {
      raised.push(line);
    }
  }
  for (const line of raised) {
    layer.appendChild(line);
  }
  if (step && state.wireEls[step.wire.id]) {
    layer.appendChild(state.wireEls[step.wire.id].line);
  }
  renderAltOutlines(altWires);
  renderBadges();
}

function renderAltOutlines(altWires) {
  const layer = byId('layer-wires');
  for (const old of Array.from(layer.querySelectorAll('.alt-outline'))) {
    layer.removeChild(old);
  }
  for (const id of altWires) {
    const els = state.wireEls[id];
    if (!els) {
      continue;
    }
    const outline = svgEl('path', { class: 'alt-outline', d: els.line.getAttribute('d') }, null);
    layer.insertBefore(outline, layer.firstChild);
  }
}

function compareSets() {
  if (!state.path || !state.compare) {
    return null;
  }
  const a = new Set(state.path.played.map((p) => p.wire.id));
  const other = state.pathsById[state.compare];
  const b = new Set(computePlayed(other, defaultSelection(other)).map((p) => p.wire.id));
  const both = new Set();
  const onlyA = new Set();
  const onlyB = new Set();
  for (const id of a) {
    (b.has(id) ? both : onlyA).add(id);
  }
  for (const id of b) {
    if (!a.has(id)) {
      onlyB.add(id);
    }
  }
  return { both: both, onlyA: onlyA, onlyB: onlyB };
}

function wireMidpoint(id) {
  const els = state.wireEls[id];
  if (!els) {
    return null;
  }
  const length = els.line.getTotalLength();
  return els.line.getPointAtLength(length / 2);
}

function renderBadges() {
  const layer = clearLayer('layer-badges');
  if (!state.path) {
    return;
  }
  const seen = new Set();
  for (const p of state.path.played) {
    if (seen.has(p.wire.id)) {
      continue;
    }
    seen.add(p.wire.id);
    const mid = wireMidpoint(p.wire.id);
    if (!mid) {
      continue;
    }
    const g = svgEl('g', { class: 'badge', transform: 'translate(' + mid.x + ',' + mid.y + ')' }, layer);
    const label = String(p.n);
    svgEl('circle', { r: label.length > 1 ? 10 : 8 }, g);
    const text = svgEl('text', {}, g);
    text.textContent = label;
  }
}

// ---------------------------------------------------------------- view

function canvasSize() {
  const rect = byId('canvas').getBoundingClientRect();
  return { w: rect.width, h: rect.height, left: rect.left, top: rect.top };
}

function screenToWorld(clientX, clientY) {
  const size = canvasSize();
  return {
    x: (clientX - size.left - state.view.x) / state.view.k,
    y: (clientY - size.top - state.view.y) / state.view.k,
  };
}

function setViewTransform() {
  const v = state.view;
  const canvas = byId('canvas');
  canvas.style.setProperty('--wire-idle', clamp(2 * v.k, 0.7, 2) + 'px');
  canvas.style.setProperty('--wire-lit', clamp(3 * v.k, 2, 3) + 'px');
  byId('root').setAttribute('transform', 'translate(' + v.x + ',' + v.y + ') scale(' + v.k + ')');
  byId('grid').setAttribute('patternTransform', 'translate(' + v.x + ',' + v.y + ') scale(' + v.k + ')');
  updateGroupLabels();
  renderMinimap();
  saveViewSoon();
}

function fitView(bounds) {
  if (!bounds) {
    return;
  }
  const size = canvasSize();
  const margin = 30;
  const k = clamp(Math.min((size.w - 2 * margin) / bounds.w, (size.h - 2 * margin) / bounds.h), ZOOM_MIN, ZOOM_MAX);
  state.view.k = k;
  state.view.x = size.w / 2 - (bounds.x + bounds.w / 2) * k;
  state.view.y = size.h / 2 - (bounds.y + bounds.h / 2) * k;
  setViewTransform();
}

function boundsOfNodes(ids) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const id of ids) {
    const dn = state.disp.nodes[id];
    if (!dn) {
      continue;
    }
    x1 = Math.min(x1, dn.x);
    y1 = Math.min(y1, dn.y);
    x2 = Math.max(x2, dn.x + dn.w);
    y2 = Math.max(y2, dn.y + dn.h);
  }
  if (x1 === Infinity) {
    return null;
  }
  return { x: x1 - 40, y: y1 - 40, w: x2 - x1 + 80, h: y2 - y1 + 80 };
}

function centerOn(ids) {
  const box = boundsOfNodes(ids);
  if (!box) {
    return;
  }
  const size = canvasSize();
  if (box.w * state.view.k > size.w || box.h * state.view.k > size.h || state.view.k < 0.5) {
    fitView(box);
    if (state.view.k > 1) {
      state.view.k = 1;
      state.view.x = size.w / 2 - (box.x + box.w / 2);
      state.view.y = size.h / 2 - (box.y + box.h / 2);
      setViewTransform();
    }
    return;
  }
  state.view.x = size.w / 2 - (box.x + box.w / 2) * state.view.k;
  state.view.y = size.h / 2 - (box.y + box.h / 2) * state.view.k;
  setViewTransform();
}

function isVisible(box) {
  const size = canvasSize();
  const v = state.view;
  const x1 = box.x * v.k + v.x;
  const y1 = box.y * v.k + v.y;
  const x2 = (box.x + box.w) * v.k + v.x;
  const y2 = (box.y + box.h) * v.k + v.y;
  return x1 >= 0 && y1 >= 0 && x2 <= size.w && y2 <= size.h;
}

function updateGroupLabels() {
  let overlay = byId('group-labels');
  if (!overlay) {
    overlay = htmlEl('div', { id: 'group-labels' });
    overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    byId('canvas-wrap').insertBefore(overlay, byId('caption'));
  }
  while (overlay.firstChild) {
    overlay.removeChild(overlay.firstChild);
  }
  const small = state.view.k * 18 < 12;
  for (const groupId in state.frameEls || {}) {
    const els = state.frameEls[groupId];
    els.title.style.visibility = small ? 'hidden' : 'visible';
    els.summary.style.visibility = small ? 'hidden' : 'visible';
  }
  if (!small || !state.disp) {
    return;
  }
  // Zoomed far out the frames are too narrow for their titles, so the titles
  // are drawn in screen space and stacked in rows above (or, for a group that
  // sits under another one, below) their frame, with a short leader line.
  const frames = groupFrames();
  const v = state.view;
  measureCtx.font = '700 12px ' + getComputedStyle(document.body).fontFamily;
  let topmost = Infinity;
  for (const id in frames) {
    topmost = Math.min(topmost, frames[id].y);
  }
  const groups = state.graph.groups.filter((g) => frames[g.id]);
  groups.sort((a, b) => frames[a.id].x - frames[b.id].x);
  const rowsAbove = [];
  const rowsBelow = [];
  for (const group of groups) {
    const frame = frames[group.id];
    const frameLeft = frame.x * v.k + v.x;
    const frameRight = (frame.x + frame.w) * v.k + v.x;
    const frameTop = frame.y * v.k + v.y;
    const frameBottom = (frame.y + frame.h) * v.k + v.y;
    const view = canvasSize();
    if (frameRight < 0 || frameLeft > view.w || frameBottom < 0 || frameTop > view.h) {
      continue;
    }
    const width = measureCtx.measureText(group.title).width + 8;
    const left = Math.max(2, Math.min(frameLeft, canvasSize().w - width - 4));
    const above = frame.y <= topmost + 1;
    const rows = above ? rowsAbove : rowsBelow;
    let row = rows.findIndex((right) => left >= right + 6);
    if (row < 0) {
      row = rows.length;
      rows.push(0);
    }
    rows[row] = left + width;
    const edge = above ? frame.y * v.k + v.y : (frame.y + frame.h) * v.k + v.y;
    const top = above ? edge - 18 - row * 17 : edge + 4 + row * 17;
    const color = lighten(group.color, 0.55);
    const label = htmlEl('div', { text: group.title, title: group.summary + ' (drag to move the group, double-click to fit it)' });
    label.style.cssText = 'position:absolute;white-space:nowrap;font-weight:700;font-size:12px;line-height:15px;' +
      'pointer-events:auto;cursor:move;user-select:none;' +
      'color:' + color + ';text-shadow:0 1px 2px #000;left:' + (left + 2) + 'px;top:' + top + 'px;';
    label.addEventListener('mousedown', (evt) => startGroupDrag(evt, group.id));
    label.addEventListener('dblclick', (evt) => {
      evt.stopPropagation();
      fitView(groupFrames()[group.id]);
    });
    overlay.appendChild(label);
    const leaderTop = above ? top + 15 : edge;
    const leaderBottom = above ? edge : top;
    const leader = htmlEl('div', {});
    const leaderX = Math.max(left + 2, Math.min(frameLeft + 2, left + width - 4));
    leader.style.cssText = 'position:absolute;width:1px;background:' + rgba(group.color, 0.8) + ';' +
      'left:' + leaderX + 'px;top:' + leaderTop + 'px;height:' + Math.max(leaderBottom - leaderTop, 0) + 'px;';
    overlay.appendChild(leader);
  }
}

function fitAll() {
  // Leaves room above and below the frames for the stacked group titles.
  const bounds = worldBounds();
  const size = canvasSize();
  const k = clamp(Math.min((size.w - 60) / bounds.w, (size.h - 160) / bounds.h), ZOOM_MIN, ZOOM_MAX);
  state.view.k = k;
  state.view.x = size.w / 2 - (bounds.x + bounds.w / 2) * k;
  state.view.y = size.h / 2 - (bounds.y + bounds.h / 2) * k;
  setViewTransform();
}

function renderMinimap() {
  const canvas = byId('minimap');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.disp) {
    return;
  }
  const world = worldBounds();
  const scale = Math.min((canvas.width - 12) / world.w, (canvas.height - 12) / world.h);
  const ox = (canvas.width - world.w * scale) / 2 - world.x * scale;
  const oy = (canvas.height - world.h * scale) / 2 - world.y * scale;
  state.minimap = { scale: scale, ox: ox, oy: oy };
  const frames = groupFrames();
  for (const group of state.graph.groups) {
    const f = frames[group.id];
    if (!f) {
      continue;
    }
    ctx.fillStyle = rgba(group.color, 0.55);
    ctx.fillRect(f.x * scale + ox, f.y * scale + oy, f.w * scale, f.h * scale);
  }
  const size = canvasSize();
  const v = state.view;
  // Viewport rectangle, clamped to the minimap so its border stays visible
  // when the view shows more than the whole graph.
  const x1 = clamp((-v.x / v.k) * scale + ox, 1, canvas.width - 1);
  const y1 = clamp((-v.y / v.k) * scale + oy, 1, canvas.height - 1);
  const x2 = clamp(((size.w - v.x) / v.k) * scale + ox, 1, canvas.width - 1);
  const y2 = clamp(((size.h - v.y) / v.k) * scale + oy, 1, canvas.height - 1);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
}

function minimapMove(evt) {
  const m = state.minimap;
  if (!m) {
    return;
  }
  const rect = byId('minimap').getBoundingClientRect();
  const wx = (evt.clientX - rect.left - m.ox) / m.scale;
  const wy = (evt.clientY - rect.top - m.oy) / m.scale;
  const size = canvasSize();
  state.view.x = size.w / 2 - wx * state.view.k;
  state.view.y = size.h / 2 - wy * state.view.k;
  setViewTransform();
}

// ---------------------------------------------------------------- dragging

let drag = null;

function startPan(evt) {
  if (evt.button !== 0 || evt.target.classList.contains('hit')) {
    return;
  }
  drag = { kind: 'pan', sx: evt.clientX, sy: evt.clientY, vx: state.view.x, vy: state.view.y, moved: false };
  byId('canvas').classList.add('panning');
}

function startNodeDrag(evt, displayId) {
  if (evt.button !== 0) {
    return;
  }
  evt.stopPropagation();
  const dn = state.disp.nodes[displayId];
  const members = dn.proxy ? dn.members : [displayId];
  const start = {};
  for (const id of members) {
    start[id] = { x: state.pos[id].x, y: state.pos[id].y };
  }
  drag = { kind: 'node', id: displayId, members: members, start: start, sx: evt.clientX, sy: evt.clientY, moved: false, target: evt.target };
}

function startGroupDrag(evt, groupId) {
  if (evt.button !== 0) {
    return;
  }
  evt.stopPropagation();
  const members = state.groupNodes[groupId].filter((id) => state.disp.map[id]);
  const start = {};
  for (const id of members) {
    start[id] = { x: state.pos[id].x, y: state.pos[id].y };
  }
  drag = { kind: 'group', members: members, start: start, sx: evt.clientX, sy: evt.clientY, moved: false };
}

function onMouseMove(evt) {
  if (!drag) {
    return;
  }
  const dx = evt.clientX - drag.sx;
  const dy = evt.clientY - drag.sy;
  if (Math.abs(dx) + Math.abs(dy) > 3) {
    drag.moved = true;
  }
  if (!drag.moved) {
    return;
  }
  if (drag.kind === 'pan') {
    state.view.x = drag.vx + dx;
    state.view.y = drag.vy + dy;
    setViewTransform();
    return;
  }
  if (drag.kind === 'minimap') {
    minimapMove(evt);
    return;
  }
  for (const id of drag.members) {
    state.pos[id] = { x: drag.start[id].x + dx / state.view.k, y: drag.start[id].y + dy / state.view.k };
  }
  updatePositions();
}

function onMouseUp(evt) {
  if (!drag) {
    return;
  }
  const finished = drag;
  drag = null;
  byId('canvas').classList.remove('panning');
  if (finished.kind === 'pan' && !finished.moved) {
    // Click on empty canvas: clear the selection (the path stays).
    if (state.select || state.trace) {
      clearSelection();
    }
    return;
  }
  if ((finished.kind === 'node' || finished.kind === 'group') && finished.moved) {
    saveLayout();
    return;
  }
  if (finished.kind === 'node' && !finished.moved) {
    const url = finished.target && finished.target.dataset ? finished.target.dataset.url : null;
    if (url) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    selectNode(finished.id, false);
  }
}

function onWheel(evt) {
  evt.preventDefault();
  const size = canvasSize();
  const mx = evt.clientX - size.left;
  const my = evt.clientY - size.top;
  const factor = Math.exp(-evt.deltaY * (evt.deltaMode === 1 ? 0.05 : 0.0015));
  const k = clamp(state.view.k * factor, ZOOM_MIN, ZOOM_MAX);
  const wx = (mx - state.view.x) / state.view.k;
  const wy = (my - state.view.y) / state.view.k;
  state.view.k = k;
  state.view.x = mx - wx * k;
  state.view.y = my - wy * k;
  setViewTransform();
}

function toggleCollapsed(displayId) {
  if (displayId.indexOf('group:') === 0) {
    return;
  }
  state.collapsed[displayId] = !state.collapsed[displayId];
  if (!state.collapsed[displayId]) {
    delete state.collapsed[displayId];
  }
  saveLayout();
  renderAll();
}

// ---------------------------------------------------------------- tooltip

function refTooltip(heading, refs, extra) {
  const box = htmlEl('div', {}, [htmlEl('div', { text: heading })]);
  if (extra) {
    box.appendChild(htmlEl('div', { className: 'muted', text: extra }));
  }
  const shown = refs.slice(0, 3);
  for (const ref of shown) {
    const code = ref.code.length > 120 ? ref.code.slice(0, 119) + '…' : ref.code;
    box.appendChild(htmlEl('div', { className: 't-ref' }, [
      htmlEl('span', { className: 'loc', text: ref.file + ':' + ref.line }),
      '  ' + ref.symbol,
      htmlEl('span', { className: 'code', text: code }),
    ]));
  }
  if (refs.length > shown.length) {
    box.appendChild(htmlEl('div', { className: 'muted', text: '+' + (refs.length - shown.length) + ' more' }));
  }
  return box;
}

function wireTooltip(id) {
  const wire = state.wiresById[id];
  return refTooltip(wire.id + '  ' + wire.from + ' → ' + wire.to, wire.refs, wire.label);
}

function showTooltip(evt, content) {
  const tip = byId('tooltip');
  while (tip.firstChild) {
    tip.removeChild(tip.firstChild);
  }
  tip.appendChild(content);
  tip.hidden = false;
  moveTooltip(evt);
}

function moveTooltip(evt) {
  const tip = byId('tooltip');
  if (tip.hidden) {
    return;
  }
  const pad = 14;
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  const rect = tip.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - 6) {
    x = evt.clientX - rect.width - pad;
  }
  if (y + rect.height > window.innerHeight - 6) {
    y = evt.clientY - rect.height - pad;
  }
  tip.style.left = Math.max(4, x) + 'px';
  tip.style.top = Math.max(4, y) + 'px';
}

function hideTooltip() {
  byId('tooltip').hidden = true;
}

// ---------------------------------------------------------------- selection

function selectNode(id, center) {
  state.select = { kind: 'node', id: id };
  state.trace = null;
  if (center) {
    centerOn([id]);
  }
  applyHighlight();
  renderDetails();
  writeHash();
}

function selectWire(id, center) {
  state.select = { kind: 'wire', id: id };
  state.trace = null;
  const els = state.wireEls[id];
  if (center && els) {
    centerOn([els.dw.from, els.dw.to]);
  }
  applyHighlight();
  renderDetails();
  writeHash();
}

function clearSelection() {
  state.select = null;
  state.trace = null;
  applyHighlight();
  renderDetails();
  writeHash();
}

function startTrace(nodeId, direction) {
  const depth = parseInt(byId('trace-depth').value, 10);
  const ignoreCtl = byId('trace-ctl').checked;
  state.trace = { id: nodeId, direction: direction, depth: depth, ignoreCtl: ignoreCtl, result: traceClosure(nodeId, direction, depth, ignoreCtl) };
  applyHighlight();
  renderDetails();
}

// ---------------------------------------------------------------- paths

function activatePath(id, sel, stepN, fit) {
  const path = state.pathsById[id];
  if (!path) {
    return;
  }
  playPath(false);
  const selection = Object.assign(defaultSelection(path), sel || {});
  const previous = state.path;
  state.path = {
    id: id,
    sel: selection,
    played: computePlayed(path, selection),
    cur: -1,
    playing: false,
    follow: previous ? previous.follow : true,
    speed: previous ? previous.speed : 1,
  };
  state.select = null;
  state.trace = null;
  if (stepN) {
    const k = state.path.played.findIndex((p) => p.n === stepN);
    state.path.cur = k;
  }
  if (state.compare === id) {
    state.compare = '';
  }
  renderPathList();
  applyHighlight();
  renderDetails();
  if (fit) {
    const ids = new Set();
    for (const p of state.path.played) {
      ids.add(displayIdOf(p.wire.from));
      ids.add(displayIdOf(p.wire.to));
    }
    fitView(boundsOfNodes(Array.from(ids)));
  }
  if (state.path.cur >= 0) {
    gotoStep(state.path.cur);
  } else {
    showCaption();
    writeHash();
  }
}

function clearPath() {
  playPath(false);
  state.path = null;
  state.compare = '';
  stopDot();
  renderPathList();
  showCaption();
  applyHighlight();
  renderDetails();
  writeHash();
}

function gotoStep(k) {
  if (!state.path || state.path.played.length === 0) {
    return;
  }
  state.path.cur = clamp(k, 0, state.path.played.length - 1);
  applyHighlight();
  showCaption();
  animateDot(state.path.cur);
  if (state.path.follow) {
    followStep();
  }
  markCurrentStep();
  writeHash();
}

function followStep() {
  const step = currentStep();
  if (!step) {
    return;
  }
  const ids = [displayIdOf(step.wire.from), displayIdOf(step.wire.to)];
  const box = boundsOfNodes(ids);
  // Pan when the step is off screen; also zoom in when the view is so far
  // out that a single step cannot be read.
  if (box && (!isVisible(box) || state.view.k < 0.35)) {
    centerOn(ids);
  }
}

function playPath(on) {
  if (state.playTimer) {
    clearInterval(state.playTimer);
    state.playTimer = null;
  }
  if (!state.path) {
    return;
  }
  state.path.playing = Boolean(on);
  const button = byId('btn-play');
  if (button) {
    button.textContent = on ? 'Pause' : 'Play';
    button.classList.toggle('active', Boolean(on));
  }
  if (!on) {
    return;
  }
  if (state.path.cur >= state.path.played.length - 1) {
    gotoStep(0);
  } else {
    gotoStep(state.path.cur + 1);
  }
  state.playTimer = setInterval(() => {
    if (!state.path || state.path.cur >= state.path.played.length - 1) {
      playPath(false);
      return;
    }
    gotoStep(state.path.cur + 1);
  }, 1000 / state.path.speed);
}

function stopDot() {
  if (state.dotFrame) {
    cancelAnimationFrame(state.dotFrame);
    state.dotFrame = null;
  }
  clearLayer('layer-dot');
}

function animateDot(k) {
  stopDot();
  const step = state.path.played[k];
  const els = state.wireEls[step.wire.id];
  if (!els) {
    return;
  }
  const layer = byId('layer-dot');
  const dot = svgEl('circle', { class: 'dot', r: 7 }, layer);
  const length = els.line.getTotalLength();
  const duration = Math.min(900, 800 / state.path.speed);
  const begin = performance.now();
  function frame(now) {
    const t = clamp((now - begin) / duration, 0, 1);
    const point = els.line.getPointAtLength(length * t);
    dot.setAttribute('cx', point.x);
    dot.setAttribute('cy', point.y);
    dot.setAttribute('opacity', step.side ? Math.min(1, t * 4) : 1);
    if (t < 1) {
      state.dotFrame = requestAnimationFrame(frame);
    } else {
      state.dotFrame = null;
    }
  }
  state.dotFrame = requestAnimationFrame(frame);
}

function nodeTitle(id) {
  const node = state.nodesById[id];
  return node ? node.title : id;
}

function showCaption() {
  const caption = byId('caption');
  const step = currentStep();
  while (caption.firstChild) {
    caption.removeChild(caption.firstChild);
  }
  if (!step) {
    caption.hidden = true;
    return;
  }
  caption.hidden = false;
  caption.appendChild(htmlEl('div', {}, [
    htmlEl('b', { text: step.n + '. ' + nodeTitle(step.wire.from) + ' → ' + nodeTitle(step.wire.to) }),
    step.side ? htmlEl('span', { className: 'muted', text: '  (side input)' }) : null,
  ]));
  caption.appendChild(htmlEl('div', { text: step.wire.label }));
  if (step.step.note) {
    caption.appendChild(htmlEl('div', { className: 'muted', text: step.step.note }));
  }
  const ref = step.wire.refs[0];
  if (ref) {
    const link = htmlEl('a', { href: sourceUrl(ref), target: '_blank', rel: 'noopener', text: ref.file + ':' + ref.line });
    caption.appendChild(htmlEl('span', { className: 'ref' }, [link, '  ' + ref.code.slice(0, 110)]));
  }
}

function markCurrentStep() {
  const list = byId('step-list');
  if (!list || !state.path) {
    return;
  }
  const step = currentStep();
  for (const el of Array.from(list.children)) {
    const on = Boolean(step) && Number(el.dataset.n) === step.n;
    el.classList.toggle('cur', on);
    if (on) {
      el.scrollIntoView({ block: 'nearest' });
    }
  }
}

function selectionFor(step, baseSel) {
  // Option selection, starting from baseSel, that makes the step play.
  const sel = Object.assign({}, baseSel);
  for (const tag of step.when || []) {
    if (tag.options.indexOf(sel[tag.group]) < 0) {
      sel[tag.group] = tag.options[0];
    }
  }
  return sel;
}

// ---------------------------------------------------------------- details panel

function refRow(name, ref, showCode) {
  if (!ref) {
    return htmlEl('div', { className: 'ref-row' }, [htmlEl('span', { className: 'sym', text: name })]);
  }
  const link = htmlEl('a', { href: sourceUrl(ref), target: '_blank', rel: 'noopener', text: ref.file + ':' + ref.line });
  const copy = htmlEl('button', { className: 'copy', title: 'Copy file:line', text: 'copy' });
  copy.addEventListener('click', () => {
    try {
      navigator.clipboard.writeText(ref.file + ':' + ref.line).catch(() => {});
    } catch (err) {
      // Clipboard unavailable: nothing visible happens.
    }
  });
  const row = htmlEl('div', { className: 'ref-row' }, [htmlEl('span', { className: 'sym', text: name }), link, copy]);
  row.addEventListener('mouseenter', (evt) => showTooltip(evt, refTooltip(name, [ref])));
  row.addEventListener('mousemove', moveTooltip);
  row.addEventListener('mouseleave', hideTooltip);
  const box = htmlEl('div', {}, [row]);
  if (showCode) {
    box.appendChild(htmlEl('div', { className: 'ref-code', text: ref.code }));
  }
  return box;
}

function typeChip(typeId) {
  const chip = htmlEl('span', { className: 'chip', title: state.typesById[typeId].name });
  chip.style.background = state.typesById[typeId].color;
  return chip;
}

function section(title, children) {
  return htmlEl('section', {}, [htmlEl('h2', { text: title })].concat(children));
}

function renderDetails() {
  const panel = byId('details');
  while (panel.firstChild) {
    panel.removeChild(panel.firstChild);
  }
  hideTooltip();
  if (state.mode === 'timeline') {
    renderTimelineDetails(panel);
    return;
  }
  if (state.select && state.path) {
    const back = htmlEl('button', { text: '← Back to path' });
    back.addEventListener('click', clearSelection);
    panel.appendChild(back);
  }
  if (state.select && state.select.kind === 'node') {
    renderNodeDetails(panel, state.select.id);
  } else if (state.select && state.select.kind === 'wire') {
    renderWireDetails(panel, state.select.id);
  } else if (state.path) {
    renderPathDetails(panel);
  } else {
    panel.appendChild(htmlEl('p', { className: 'muted', text: 'Select a node, a wire or a path. Hover any function, wire or step for its source line; click to open it on GitHub.' }));
  }
}

function renderNodeDetails(panel, displayId) {
  const dn = state.disp.nodes[displayId];
  if (!dn) {
    return;
  }
  if (dn.proxy) {
    const group = state.groupsById[dn.group];
    panel.appendChild(htmlEl('h3', { text: group.title }));
    panel.appendChild(htmlEl('p', { text: group.summary }));
    panel.appendChild(section('Members (group collapsed)', dn.members.map((id) => {
      const row = htmlEl('div', { className: 'io-row', text: state.nodesById[id].title });
      row.addEventListener('click', () => {
        state.groupMode[dn.group] = 'show';
        renderGroupFilters();
        renderAll();
        selectNode(id, true);
      });
      return row;
    })));
    return;
  }
  const node = dn.node;
  const group = state.groupsById[node.group];
  const ctx = state.ctxById[node.ctx];
  panel.appendChild(htmlEl('h3', { text: node.title }));
  panel.appendChild(htmlEl('div', { className: 'sub' }, [
    group.title + '  ·  ', htmlEl('span', { className: 'mono', text: node.ctx }), ctx ? ': ' + ctx.name : '',
  ]));
  panel.appendChild(htmlEl('p', { text: node.role }));
  const also = alsoInLinks(node.id);
  if (also.length > 0) {
    panel.appendChild(section('Also in', also));
  }

  if (node.fns.length > 0) {
    panel.appendChild(section('Functions', node.fns.map((fn) => refRow(fn.name + '()', fn.ref, false))));
  }
  if (node.tunables.length > 0) {
    panel.appendChild(section('Tunables', node.tunables.map((t) => refRow(t.name, t.ref, false))));
  }
  if (node.props.length > 0) {
    panel.appendChild(section('Dataset properties', node.props.map((p) => refRow(p.name, p.ref, false))));
  }
  renderPipelineInfo(panel, node.id);

  // Free trace controls
  const depth = htmlEl('select', { id: 'trace-depth' });
  for (const value of ['1', '2', '3', '4', '6', '8', '0']) {
    depth.appendChild(htmlEl('option', { value: value, text: value === '0' ? 'unlimited' : value }));
  }
  depth.value = state.trace ? String(state.trace.depth) : '3';
  const ctl = htmlEl('input', { id: 'trace-ctl', type: 'checkbox' });
  ctl.checked = Boolean(state.trace && state.trace.ignoreCtl);
  const down = htmlEl('button', { text: 'Trace downstream' });
  const up = htmlEl('button', { text: 'Trace upstream' });
  down.addEventListener('click', () => startTrace(node.id, 'down'));
  up.addEventListener('click', () => startTrace(node.id, 'up'));
  const controls = [htmlEl('div', { className: 'transport' }, [down, up]),
    htmlEl('label', { className: 'row' }, ['Depth', depth]),
    htmlEl('label', { className: 'row' }, ['Ignore ctl wires', ctl])];
  if (state.trace) {
    const clear = htmlEl('button', { text: 'Clear trace' });
    clear.addEventListener('click', () => { state.trace = null; applyHighlight(); renderDetails(); });
    controls.push(htmlEl('div', { className: 'muted', text: 'Tracing ' + (state.trace.direction === 'down' ? 'downstream' : 'upstream') + ': ' + state.trace.result.nodes.size + ' nodes, ' + state.trace.result.wires.size + ' wires.' }));
    controls.push(clear);
  }
  panel.appendChild(section('Free trace', controls));

  const incoming = state.graph.wires.filter((w) => w.to === node.id);
  const outgoing = state.graph.wires.filter((w) => w.from === node.id);
  panel.appendChild(section('Inputs (' + incoming.length + ')', incoming.map((w) => ioRow(w, w.from))));
  panel.appendChild(section('Outputs (' + outgoing.length + ')', outgoing.map((w) => ioRow(w, w.to))));
}

function ioRow(wire, otherId) {
  const row = htmlEl('div', { className: 'io-row' }, [
    typeChip(wire.type),
    htmlEl('span', { className: 'other', text: nodeTitle(otherId) }),
    htmlEl('span', { className: 'muted mono', text: '  ' + wire.id }),
    htmlEl('span', { className: 'lbl', text: wire.label }),
  ]);
  row.addEventListener('click', () => {
    selectWire(wire.id, false);
    centerOn([displayIdOf(otherId)]);
  });
  row.addEventListener('mouseenter', (evt) => showTooltip(evt, wireTooltip(wire.id)));
  row.addEventListener('mousemove', moveTooltip);
  row.addEventListener('mouseleave', hideTooltip);
  return row;
}

function renderPipelineInfo(panel, nodeId) {
  const graph = state.graph;
  if (nodeId === graph.meta.pipelineNode) {
    const table = htmlEl('table', { className: 'tbl' });
    table.appendChild(htmlEl('tr', {}, [htmlEl('th', { text: 'Pipeline' }), htmlEl('th', { text: 'Stages' })]));
    for (const pipe of graph.pipelines) {
      table.appendChild(htmlEl('tr', {}, [
        htmlEl('td', {}, [htmlEl('span', { className: 'mono', text: pipe.name }), htmlEl('div', { className: 'muted', text: pipe.usedFor })]),
        htmlEl('td', { text: pipe.stages.join(', ') + (pipe.note ? ' (' + pipe.note + ')' : '') }),
      ]));
    }
    panel.appendChild(section('zio pipelines', [table, htmlEl('p', { className: 'muted', text: graph.pipelineRuntimeNote })]));
  }
  const stages = state.stagesByNode[nodeId];
  if (stages) {
    const names = stages.map((s) => s.name);
    const items = stages.map((s) => htmlEl('div', { className: 'mono', text: s.name + '  (' + s.fn + ')' }));
    const using = graph.pipelines.filter((p) => p.stages.some((name) => names.indexOf(name) >= 0));
    const list = using.map((p) => htmlEl('div', {}, [htmlEl('span', { className: 'mono', text: p.name }), htmlEl('span', { className: 'muted', text: '  ' + p.usedFor })]));
    panel.appendChild(section('Pipeline stage', items.concat([htmlEl('div', { className: 'muted', text: 'Pipelines that include it:' })], list)));
  }
}

function renderWireDetails(panel, id) {
  const wire = state.wiresById[id];
  const type = state.typesById[wire.type];
  panel.appendChild(htmlEl('h3', { text: wire.id }));
  const from = htmlEl('a', { href: '#node=' + wire.from, text: nodeTitle(wire.from) });
  const to = htmlEl('a', { href: '#node=' + wire.to, text: nodeTitle(wire.to) });
  from.addEventListener('click', (evt) => { evt.preventDefault(); selectNode(displayIdOf(wire.from), true); });
  to.addEventListener('click', (evt) => { evt.preventDefault(); selectNode(displayIdOf(wire.to), true); });
  panel.appendChild(htmlEl('div', { className: 'sub' }, [from, ' → ', to]));
  panel.appendChild(htmlEl('div', {}, [typeChip(wire.type), type.name + ' (' + type.id + '): ' + type.desc]));
  panel.appendChild(htmlEl('p', { text: wire.label }));
  panel.appendChild(section('Source (' + wire.refs.length + ')', wire.refs.map((ref) => refRow(ref.symbol, ref, true))));
  const paths = (state.pathsByWire[id] || []).map((pathId) => {
    const row = htmlEl('div', { className: 'io-row' }, [
      htmlEl('span', { className: 'mono', text: pathId }), '  ', state.pathsById[pathId].title,
    ]);
    row.addEventListener('click', () => {
      const path = state.pathsById[pathId];
      const index = path.steps.findIndex((s) => s.wire === id);
      const sel = selectionFor(path.steps[index], defaultSelection(path));
      activatePath(pathId, sel, index + 1, false);
    });
    return row;
  });
  panel.appendChild(section('On paths (' + paths.length + ')', paths));
}

function renderPathDetails(panel) {
  const path = state.pathsById[state.path.id];
  panel.appendChild(htmlEl('h3', { text: path.title }));
  panel.appendChild(htmlEl('div', { className: 'sub' }, [htmlEl('span', { className: 'mono', text: path.id }), '  ·  ' + path.category]));
  panel.appendChild(richText('p', path.summary));
  const ends = richText('p', path.ends);
  ends.insertBefore(htmlEl('b', { text: 'Ends: ' }), ends.firstChild);
  panel.appendChild(ends);

  for (const group of path.alts) {
    const select = htmlEl('select', {});
    for (const option of group.options) {
      select.appendChild(htmlEl('option', { value: option.id, text: option.label }));
    }
    select.value = state.path.sel[group.id];
    select.addEventListener('change', () => {
      const sel = Object.assign({}, state.path.sel);
      sel[group.id] = select.value;
      activatePath(path.id, sel, null, false);
    });
    panel.appendChild(htmlEl('label', { className: 'alt-select' }, [htmlEl('span', { className: 'muted', text: 'Alternative: ' + group.id }), select]));
  }

  const first = htmlEl('button', { title: 'First step (Home)', text: '|◀' });
  const prev = htmlEl('button', { title: 'Previous step (Left)', text: '◀' });
  const play = htmlEl('button', { id: 'btn-play', title: 'Play or pause (Space)', text: 'Play' });
  const next = htmlEl('button', { title: 'Next step (Right)', text: '▶' });
  const last = htmlEl('button', { title: 'Last step (End)', text: '▶|' });
  first.addEventListener('click', () => gotoStep(0));
  prev.addEventListener('click', () => gotoStep(state.path.cur - 1));
  play.addEventListener('click', () => playPath(!state.path.playing));
  next.addEventListener('click', () => gotoStep(state.path.cur + 1));
  last.addEventListener('click', () => gotoStep(state.path.played.length - 1));
  const speed = htmlEl('input', { type: 'range', min: '0.25', max: '4', step: '0.25', title: 'Steps per second' });
  speed.value = String(state.path.speed);
  const speedLabel = htmlEl('span', { className: 'muted', text: state.path.speed + '/s' });
  speed.addEventListener('input', () => {
    state.path.speed = Number(speed.value);
    speedLabel.textContent = state.path.speed + '/s';
    if (state.path.playing) {
      playPath(false);
      playPath(true);
    }
  });
  const follow = htmlEl('input', { type: 'checkbox' });
  follow.checked = state.path.follow;
  follow.addEventListener('change', () => { state.path.follow = follow.checked; });
  const close = htmlEl('button', { title: 'Clear the path (Esc)', text: 'Clear' });
  close.addEventListener('click', clearPath);
  panel.appendChild(htmlEl('div', { className: 'transport' }, [first, prev, play, next, last, close]));
  panel.appendChild(htmlEl('div', { className: 'transport' }, ['Speed', speed, speedLabel, htmlEl('label', {}, [follow, ' Follow'])]));

  const compare = htmlEl('select', {});
  compare.appendChild(htmlEl('option', { value: '', text: '(none)' }));
  for (const other of state.graph.paths) {
    if (other.id !== path.id) {
      compare.appendChild(htmlEl('option', { value: other.id, text: other.id }));
    }
  }
  compare.value = state.compare;
  compare.addEventListener('change', () => {
    state.compare = compare.value;
    applyHighlight();
    renderDetails();
  });
  const compareRow = [htmlEl('label', { className: 'row' }, ['Compare with', compare])];
  if (state.compare) {
    compareRow.push(htmlEl('div', { className: 'muted' }, [
      'White: both. ', htmlEl('span', { text: 'Yellow: ' + path.id + ' only. ' }), 'Blue: ' + state.compare + ' only.',
    ]));
  }
  panel.appendChild(htmlEl('div', {}, compareRow));

  const playedByIndex = {};
  for (const p of state.path.played) {
    playedByIndex[p.index] = p;
  }
  const list = htmlEl('div', { className: 'steps', id: 'step-list' });
  path.steps.forEach((step, index) => {
    const wire = state.wiresById[step.wire];
    const p = playedByIndex[index];
    const children = [];
    if (!p) {
      const labels = (step.when || []).map((tag) => {
        const group = path.alts.find((g) => g.id === tag.group);
        return tag.options.map((o) => group.options.find((opt) => opt.id === o).label).join(' / ');
      });
      children.push(htmlEl('span', { className: 'alt-head', text: 'alternative: ' + labels.join('; ') }));
    }
    children.push(htmlEl('span', { className: 'n', text: (index + 1) + '.' }));
    children.push(wire.from + ' → ' + wire.to + ': ' + wire.label);
    if (p && p.side) {
      children.push(htmlEl('span', { className: 'side', text: 'side input' }));
    }
    if (step.note) {
      children.push(htmlEl('span', { className: 'note', text: step.note }));
    }
    const row = htmlEl('div', { className: 'step' + (p ? '' : ' skip'), 'data-n': String(index + 1) }, children);
    row.addEventListener('click', () => {
      if (p) {
        gotoStep(state.path.played.indexOf(p));
      } else {
        activatePath(path.id, selectionFor(step, state.path.sel), index + 1, false);
      }
    });
    row.addEventListener('mouseenter', (evt) => showTooltip(evt, wireTooltip(wire.id)));
    row.addEventListener('mousemove', moveTooltip);
    row.addEventListener('mouseleave', hideTooltip);
    list.appendChild(row);
  });
  panel.appendChild(section('Steps (' + state.path.played.length + ' played of ' + path.steps.length + ')', [list]));
  markCurrentStep();
}

// ---------------------------------------------------------------- left panel, legend, about

function renderPathList() {
  const box = byId('path-list');
  while (box.firstChild) {
    box.removeChild(box.firstChild);
  }
  let category = null;
  for (const path of state.graph.paths) {
    if (path.category !== category) {
      category = path.category;
      box.appendChild(htmlEl('div', { className: 'path-cat', text: category }));
    }
    const active = state.path && state.path.id === path.id;
    const item = htmlEl('button', { className: 'path-item' + (active ? ' active' : ''), title: path.summary }, [
      path.title, htmlEl('span', { className: 'pid', text: path.id }),
    ]);
    item.addEventListener('click', () => {
      if (active) {
        clearPath();
      } else {
        activatePath(path.id, null, null, true);
      }
    });
    box.appendChild(item);
  }
}

function renderGroupFilters() {
  const box = byId('group-filters');
  while (box.firstChild) {
    box.removeChild(box.firstChild);
  }
  for (const group of state.graph.groups) {
    const swatch = htmlEl('span', { className: 'swatch' });
    swatch.style.background = group.color;
    const select = htmlEl('select', { title: 'Show, hide or collapse this group' });
    for (const mode of ['show', 'collapse', 'hide']) {
      select.appendChild(htmlEl('option', { value: mode, text: mode }));
    }
    select.value = state.groupMode[group.id];
    select.addEventListener('change', () => {
      state.groupMode[group.id] = select.value;
      if (state.select && !state.disp.nodes[state.select.id] && state.select.kind === 'node') {
        state.select = null;
      }
      renderAll();
      renderDetails();
    });
    box.appendChild(htmlEl('div', { className: 'gfilter' }, [swatch, htmlEl('span', { className: 'name', text: group.title, title: group.summary }), select]));
  }
}

function renderLegend() {
  const box = byId('legend');
  while (box.firstChild) {
    box.removeChild(box.firstChild);
  }
  const head = htmlEl('div', { className: 'head', title: 'Click to fold or unfold. Click a wire type to show or hide it.', text: 'Wire types ▾' });
  head.addEventListener('click', () => {
    box.classList.toggle('folded');
    head.textContent = box.classList.contains('folded') ? 'Wire types ▸' : 'Wire types ▾';
  });
  box.appendChild(head);
  for (const type of state.graph.types) {
    const sw = htmlEl('span', { className: 'sw' + (type.id === 'ctl' ? ' dashed' : '') });
    sw.style.borderTopColor = type.color;
    const item = htmlEl('div', { className: 'item' + (state.typeOn[type.id] ? '' : ' off'), title: type.desc + ' (click to show or hide)' }, [
      sw, htmlEl('span', { className: 'mono', text: type.id }), htmlEl('span', { className: 'muted', text: type.name }),
    ]);
    item.addEventListener('click', () => {
      state.typeOn[type.id] = !state.typeOn[type.id];
      renderLegend();
      renderAll();
    });
    box.appendChild(item);
  }
}

function renderAbout() {
  const body = byId('about-body');
  const graph = state.graph;
  body.appendChild(htmlEl('h2', { text: (graph.page ? graph.page.title : 'ZFS I/O Flow') + ': how to read this diagram' }));
  body.appendChild(htmlEl('p', { className: 'muted', text: 'OpenZFS ' + graph.meta.version + ' at commit ' + graph.meta.commit + '. Boxes are code areas; wires show what is handed over and are coloured by what they carry. Pick a path on the left and step through it.' }));
  body.appendChild(htmlEl('h3', { text: 'What the diagram shows' }));
  body.appendChild(htmlEl('ol', {}, graph.about.model.map((t) => richText('li', t))));
  body.appendChild(htmlEl('h3', { text: 'Simplifications' }));
  body.appendChild(htmlEl('ol', {}, graph.about.simplifications.map((t) => richText('li', t))));
  body.appendChild(htmlEl('h3', { text: 'Execution contexts (the pill on each node)' }));
  body.appendChild(htmlEl('ul', {}, graph.contexts.map((c) => htmlEl('li', {}, [htmlEl('span', { className: 'mono', text: c.id }), ': ' + c.name]))));
  body.appendChild(htmlEl('h3', { text: 'Keys' }));
  body.appendChild(htmlEl('ul', {}, [
    'Wheel: zoom. Drag canvas: pan. F: fit everything. /: search.',
    'Drag a node or a group title to move it; double-click a node title to collapse it; double-click a group title to fit it.',
    'With a path active: Left / Right step, Space play or pause, Home / End jump, Esc clear.',
    'Hover a function, tunable, wire or step for its source line; click the file:line to open it on GitHub at the pinned commit.',
  ].map((t) => htmlEl('li', { text: t }))));
}

// ---------------------------------------------------------------- timeline view

const BLOCK_STATE_TEXT = {
  live: 'live',
  freed: 'freed',
  deferred: 'freed; the space is not reusable yet (deferred)',
  async: 'queued for background freeing',
};

function hasTimelines() {
  return Boolean(state.graph.timelines && state.graph.timelines.length > 0);
}

function currentScenario() {
  if (!state.timeline) {
    return null;
  }
  return state.graph.timelines.find((t) => t.id === state.timeline.id) || null;
}

function setView(mode) {
  if (mode === 'timeline' && !hasTimelines()) {
    return;
  }
  state.mode = mode;
  const timeline = mode === 'timeline';
  byId('timeline-view').hidden = !timeline;
  byId('btn-view-graph').classList.toggle('active', !timeline);
  byId('btn-view-timeline').classList.toggle('active', timeline);
  hideTooltip();
  if (timeline) {
    playPath(false);
    byId('caption').hidden = true;
    if (!state.timeline) {
      activateTimeline(state.graph.timelines[0].id, 1);
    } else {
      renderTimelineStep(true);
    }
  } else {
    playTimeline(false);
    showCaption();
    renderMinimap();
    updateGroupLabels();
  }
  renderTimelineList();
  renderDetails();
  writeHash();
}

function renderTimelineList() {
  const box = byId('timeline-list');
  while (box.firstChild) {
    box.removeChild(box.firstChild);
  }
  for (const scenario of state.graph.timelines || []) {
    const active = state.mode === 'timeline' && state.timeline && state.timeline.id === scenario.id;
    const item = htmlEl('button', { className: 'path-item' + (active ? ' active' : ''), title: scenario.summary }, [
      scenario.title, htmlEl('span', { className: 'pid', text: scenario.id }),
    ]);
    item.addEventListener('click', () => {
      activateTimeline(scenario.id, 1);
      if (state.mode !== 'timeline') {
        setView('timeline');
      }
    });
    box.appendChild(item);
  }
}

function activateTimeline(id, stepN) {
  const scenario = state.graph.timelines.find((t) => t.id === id);
  if (!scenario) {
    return;
  }
  playTimeline(false);
  let low = Infinity;
  let high = -Infinity;
  for (const step of scenario.steps) {
    for (const block of step.blocks) {
      low = Math.min(low, block.birth);
      high = Math.max(high, block.birth);
    }
  }
  const index = stepN ? scenario.steps.findIndex((s) => s.n === stepN) : 0;
  state.timeline = { id: id, k: Math.max(index, 0), range: [low, high], playing: false };
  state.tlDataset = null;
  renderTimelineList();
  if (state.mode === 'timeline') {
    renderTimelineStep(true);
    renderDetails();
    writeHash();
  }
}

function gotoTimelineStep(k) {
  const scenario = currentScenario();
  if (!scenario) {
    return;
  }
  state.timeline.k = clamp(k, 0, scenario.steps.length - 1);
  renderTimelineStep(false);
  renderDetails();
  writeHash();
}

function playTimeline(on) {
  if (state.tlTimer) {
    clearInterval(state.tlTimer);
    state.tlTimer = null;
  }
  if (state.timeline) {
    state.timeline.playing = Boolean(on);
  }
  const button = byId('tl-play');
  button.textContent = on ? 'Pause' : 'Play';
  button.classList.toggle('active', Boolean(on));
  if (!on || !state.timeline) {
    return;
  }
  const scenario = currentScenario();
  gotoTimelineStep(state.timeline.k >= scenario.steps.length - 1 ? 0 : state.timeline.k + 1);
  state.tlTimer = setInterval(() => {
    const current = currentScenario();
    if (!current || state.timeline.k >= current.steps.length - 1) {
      playTimeline(false);
      return;
    }
    gotoTimelineStep(state.timeline.k + 1);
  }, 1800);
}

function timelineColour(birth) {
  const range = state.timeline.range;
  const t = range[1] > range[0] ? (birth - range[0]) / (range[1] - range[0]) : 1;
  const light = 30 + Math.round(t * 42);
  return { fill: 'hsl(205, 65%, ' + light + '%)', text: light > 52 ? '#111' : '#f1f1f1' };
}

function blockTooltip(block) {
  const lines = [
    'Block ' + block.id,
    'Born in txg ' + block.birth,
    block.in.length > 0 ? 'Referenced by ' + block.in.join(', ') : 'Referenced by no dataset',
    block.dead ? 'On the deadlist of ' + block.dead : null,
    'State: ' + (BLOCK_STATE_TEXT[block.state] || block.state),
  ];
  return htmlEl('div', {}, lines.filter((t) => t).map((t) => htmlEl('div', { text: t })));
}

function blockChange(block, previous) {
  if (!previous) {
    return '';
  }
  const old = previous[block.id];
  if (!old) {
    return 'new';
  }
  if (old.in.join(',') !== block.in.join(',') || old.dead !== block.dead || old.state !== block.state) {
    return 'changed';
  }
  return '';
}

function timelineTile(block, small, change) {
  const colour = timelineColour(block.birth);
  const classes = ['tl-tile'];
  if (small) {
    classes.push('small');
  }
  if (block.state !== 'live') {
    classes.push(block.state);
  }
  if (change) {
    classes.push(change);
  }
  const tile = htmlEl('div', { className: classes.join(' '), 'data-block': block.id }, [
    htmlEl('span', { text: block.id }),
    htmlEl('span', { className: 'birth', text: 'txg ' + block.birth }),
  ]);
  tile.style.background = colour.fill;
  tile.style.color = colour.text;
  tile.addEventListener('mouseenter', (evt) => showTooltip(evt, blockTooltip(block)));
  tile.addEventListener('mousemove', moveTooltip);
  tile.addEventListener('mouseleave', hideTooltip);
  return tile;
}

function timelineLane(tag, blocks, className, previous) {
  const lane = htmlEl('div', { className: 'tl-lane' + (className ? ' ' + className : '') }, [
    htmlEl('span', { className: 'lane-tag', text: tag }),
  ]);
  for (const block of blocks) {
    lane.appendChild(timelineTile(block, className === 'dead', blockChange(block, previous)));
  }
  return lane;
}

function datasetDescription(ds) {
  const parts = [ds.kind];
  if (ds.txg !== null && ds.txg !== undefined) {
    parts.push('created in txg ' + ds.txg);
  }
  if (ds.prev) {
    parts.push('previous snapshot ' + ds.prev);
  }
  if (ds.origin) {
    parts.push('origin ' + ds.origin);
  }
  return parts.join(', ');
}

function showPathFromTimeline(step) {
  const path = state.pathsById[step.path];
  if (!path) {
    return;
  }
  setView('graph');
  if (step.pathStep) {
    const sel = selectionFor(path.steps[step.pathStep - 1], defaultSelection(path));
    activatePath(path.id, sel, step.pathStep, false);
  } else {
    activatePath(path.id, null, null, true);
  }
}

function renderTimelineCaption(step) {
  const caption = byId('tl-caption');
  while (caption.firstChild) {
    caption.removeChild(caption.firstChild);
  }
  caption.appendChild(htmlEl('div', { className: 'cap', text: step.n + '. txg ' + step.txg + ': ' + step.caption }));
  for (const note of step.notes) {
    caption.appendChild(htmlEl('span', { className: 'note', text: note }));
  }
  const links = htmlEl('div', { className: 'links' });
  if (step.path && state.pathsById[step.path]) {
    const label = 'Show in graph: ' + state.pathsById[step.path].title + (step.pathStep ? ', step ' + step.pathStep : '');
    const link = htmlEl('a', { href: '#path=' + step.path, text: label });
    link.addEventListener('click', (evt) => {
      evt.preventDefault();
      showPathFromTimeline(step);
    });
    links.appendChild(link);
  }
  for (const wireId of step.wires) {
    const wire = state.wiresById[wireId];
    if (!wire) {
      continue;
    }
    const link = htmlEl('a', { href: '#wire=' + wireId, text: wireId });
    link.addEventListener('click', (evt) => {
      evt.preventDefault();
      setView('graph');
      selectWire(wireId, true);
    });
    link.addEventListener('mouseenter', (evt) => showTooltip(evt, wireTooltip(wireId)));
    link.addEventListener('mousemove', moveTooltip);
    link.addEventListener('mouseleave', hideTooltip);
    links.appendChild(link);
  }
  if (links.firstChild) {
    caption.appendChild(links);
  }
}

function renderTimelineStep(fresh) {
  const scenario = currentScenario();
  if (!scenario) {
    return;
  }
  const step = scenario.steps[state.timeline.k];
  const prevStep = state.timeline.k > 0 ? scenario.steps[state.timeline.k - 1] : null;
  const previous = prevStep ? indexByKey(prevStep.blocks, 'id') : null;
  const panel = byId('tl-panel');

  // Remember where each block's first tile was, to slide it to its new place.
  const before = {};
  if (!fresh) {
    for (const tile of panel.querySelectorAll('.tl-tile')) {
      if (!before[tile.dataset.block]) {
        before[tile.dataset.block] = tile.getBoundingClientRect();
      }
    }
  }

  byId('tl-title').textContent = scenario.title;
  if (fresh) {
    renderTimelineLegend();
  }
  const strip = byId('tl-strip');
  while (strip.firstChild) {
    strip.removeChild(strip.firstChild);
  }
  scenario.steps.forEach((s, i) => {
    const shortCaption = s.caption.length > 58 ? s.caption.slice(0, 57) + '…' : s.caption;
    const chip = htmlEl('button', { className: 'tl-chip' + (i === state.timeline.k ? ' cur' : ''), title: s.caption }, [
      htmlEl('span', { className: 'txg', text: 'txg ' + s.txg }), shortCaption,
    ]);
    chip.addEventListener('click', () => gotoTimelineStep(i));
    strip.appendChild(chip);
  });
  renderTimelineCaption(step);

  while (panel.firstChild) {
    panel.removeChild(panel.firstChild);
  }
  for (const ds of step.datasets) {
    const label = htmlEl('div', { className: 'tl-label', title: 'Show this dataset in the details panel' }, [
      htmlEl('span', { className: 'name', text: ds.name }),
      htmlEl('span', { className: 'kind', text: datasetDescription(ds) }),
    ]);
    label.addEventListener('click', () => {
      state.tlDataset = ds.name;
      renderDetails();
    });
    const lanes = htmlEl('div', { className: 'tl-lanes' });
    if (ds.kind === 'bookmark') {
      lanes.appendChild(htmlEl('div', { className: 'tl-lane' }, [
        htmlEl('span', { className: 'lane-tag', text: 'keeps only its creation txg and guid; references no blocks' }),
      ]));
    } else {
      lanes.appendChild(timelineLane('blocks', step.blocks.filter((b) => b.in.indexOf(ds.name) >= 0), '', previous));
      lanes.appendChild(timelineLane('deadlist', step.blocks.filter((b) => b.dead === ds.name), 'dead', previous));
    }
    panel.appendChild(htmlEl('div', { className: 'tl-row' }, [label, lanes]));
  }
  const pool = step.blocks.filter((b) => b.in.length === 0 && !b.dead);
  if (pool.length > 0) {
    const label = htmlEl('div', { className: 'tl-label' }, [
      htmlEl('span', { className: 'name', text: 'pool' }),
      htmlEl('span', { className: 'kind', text: 'blocks no dataset references any more' }),
    ]);
    const lanes = htmlEl('div', { className: 'tl-lanes' }, [timelineLane('freeing / freed', pool, '', previous)]);
    panel.appendChild(htmlEl('div', { className: 'tl-row' }, [label, lanes]));
  }

  if (!fresh) {
    const moved = {};
    for (const tile of panel.querySelectorAll('.tl-tile')) {
      const id = tile.dataset.block;
      if (moved[id] || !before[id]) {
        continue;
      }
      moved[id] = true;
      const after = tile.getBoundingClientRect();
      const dx = before[id].left - after.left;
      const dy = before[id].top - after.top;
      if (dx === 0 && dy === 0) {
        continue;
      }
      tile.style.transition = 'none';
      tile.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          tile.style.transition = 'transform 450ms ease';
          tile.style.transform = '';
        });
      });
    }
  }
}

function renderTimelineLegend() {
  const box = byId('tl-legend');
  const sample = (birth, extra, text) => {
    const colour = timelineColour(birth);
    const tile = htmlEl('div', { className: 'tl-tile' + (extra ? ' ' + extra : '') }, [htmlEl('span', { text: text })]);
    tile.style.background = colour.fill;
    tile.style.color = colour.text;
    return tile;
  };
  while (box.firstChild) {
    box.removeChild(box.firstChild);
  }
  const range = state.timeline.range;
  box.appendChild(htmlEl('span', { text: 'Tiles are blocks, labelled with their birth txg:' }));
  box.appendChild(sample(range[0], '', 'old'));
  box.appendChild(sample(range[1], '', 'new'));
  box.appendChild(sample(range[1], 'new', 'added'));
  box.appendChild(sample(range[1], 'changed', 'moved'));
  box.appendChild(sample(range[1], 'deferred', 'defer'));
  box.appendChild(sample(range[1], 'async', 'queue'));
  box.appendChild(sample(range[1], 'freed', 'freed'));
  box.appendChild(htmlEl('span', { text: 'added / moved: changed in this step. defer: freed, space not reusable yet. queue: waiting for background freeing.' }));
}

function renderTimelineDetails(panel) {
  const scenario = currentScenario();
  if (!scenario) {
    return;
  }
  const step = scenario.steps[state.timeline.k];
  panel.appendChild(htmlEl('h3', { text: scenario.title }));
  panel.appendChild(htmlEl('div', { className: 'sub' }, [htmlEl('span', { className: 'mono', text: scenario.id }), '  ·  timeline']));
  panel.appendChild(richText('p', scenario.summary));

  if (state.tlDataset) {
    const ds = step.datasets.find((d) => d.name === state.tlDataset);
    if (ds) {
      const refs = step.blocks.filter((b) => b.in.indexOf(ds.name) >= 0).map((b) => b.id + ' (txg ' + b.birth + ')');
      const dead = step.blocks.filter((b) => b.dead === ds.name).map((b) => b.id + ' (txg ' + b.birth + ')');
      panel.appendChild(section('Dataset ' + ds.name + ' at step ' + step.n, [
        htmlEl('div', { text: datasetDescription(ds) }),
        htmlEl('div', { text: 'References: ' + (refs.length ? refs.join(', ') : 'nothing') }),
        htmlEl('div', { text: 'Deadlist: ' + (dead.length ? dead.join(', ') : 'empty') }),
      ]));
    }
  }

  const list = htmlEl('div', { className: 'steps' });
  scenario.steps.forEach((s, i) => {
    const row = htmlEl('div', { className: 'step' + (i === state.timeline.k ? ' cur' : '') }, [
      htmlEl('span', { className: 'n', text: s.n + '.' }), 'txg ' + s.txg + ': ' + s.caption,
    ]);
    row.addEventListener('click', () => gotoTimelineStep(i));
    list.appendChild(row);
  });
  panel.appendChild(section('Steps (' + scenario.steps.length + ')', [list]));

  const sources = [];
  for (const wireId of step.wires) {
    const wire = state.wiresById[wireId];
    if (!wire) {
      continue;
    }
    sources.push(htmlEl('div', { className: 'muted', text: wireId + ': ' + wire.label }));
    for (const ref of wire.refs) {
      sources.push(refRow(ref.symbol, ref, true));
    }
  }
  if (sources.length > 0) {
    panel.appendChild(section('Code behind this step', sources));
  }
}

function indexByKey(list, key) {
  const map = {};
  for (const item of list) {
    map[item[key]] = item;
  }
  return map;
}

// ---------------------------------------------------------------- search

function searchIndex() {
  if (state.searchItems) {
    return state.searchItems;
  }
  const items = [];
  for (const node of state.graph.nodes) {
    const words = [node.id, node.title, node.src, node.role];
    for (const fn of node.fns) {
      words.push(fn.name);
      if (fn.ref) {
        words.push(fn.ref.file);
      }
    }
    for (const t of node.tunables.concat(node.props)) {
      words.push(t.name);
    }
    items.push({ kind: 'node', id: node.id, title: node.title, text: words.join(' ').toLowerCase() });
  }
  for (const wire of state.graph.wires) {
    const words = [wire.id, wire.label].concat(wire.refs.map((r) => r.file + ' ' + r.symbol));
    items.push({ kind: 'wire', id: wire.id, title: wire.id + ' ' + wire.from + ' → ' + wire.to, text: words.join(' ').toLowerCase() });
  }
  state.searchItems = items;
  return items;
}

function runSearch(text) {
  const list = byId('search-results');
  while (list.firstChild) {
    list.removeChild(list.firstChild);
  }
  const terms = text.toLowerCase().split(/\s+/).filter((t) => t);
  state.searchHits = [];
  if (terms.length === 0) {
    return;
  }
  for (const item of searchIndex()) {
    if (terms.every((t) => item.text.indexOf(t) >= 0)) {
      state.searchHits.push(item);
    }
  }
  state.searchHits.sort((a, b) => (a.kind === 'node' ? 0 : 1) - (b.kind === 'node' ? 0 : 1));
  state.searchHits.slice(0, 60).forEach((item, i) => {
    const li = htmlEl('li', { className: i === 0 ? 'first' : '' }, [htmlEl('span', { className: 'kind', text: item.kind }), item.title]);
    li.addEventListener('click', () => openSearchHit(item));
    list.appendChild(li);
  });
  if (state.searchHits.length === 0) {
    list.appendChild(htmlEl('li', { className: 'muted', text: 'No matches' }));
  }
}

function openSearchHit(item) {
  if (item.kind === 'node') {
    const id = displayIdOf(item.id);
    if (id) {
      selectNode(id, true);
    }
  } else if (state.wireEls[item.id]) {
    selectWire(item.id, true);
  }
}

// ---------------------------------------------------------------- persistence

function saveLayout() {
  storageSet(state.storageKey + ':layout', { pos: state.pos, collapsed: state.collapsed });
}

function loadLayout() {
  const saved = storageGet(state.storageKey + ':layout');
  state.pos = JSON.parse(JSON.stringify(state.defaultPos));
  state.collapsed = {};
  if (!saved) {
    return false;
  }
  applyLayoutData(saved);
  return true;
}

function applyLayoutData(data) {
  for (const id in data.pos || {}) {
    const p = data.pos[id];
    if (state.nodesById[id] && p && isFinite(p.x) && isFinite(p.y)) {
      state.pos[id] = { x: p.x, y: p.y };
    }
  }
  state.collapsed = {};
  for (const id in data.collapsed || {}) {
    if (state.nodesById[id] && data.collapsed[id]) {
      state.collapsed[id] = true;
    }
  }
}

let saveViewTimer = null;

function saveViewSoon() {
  if (saveViewTimer) {
    clearTimeout(saveViewTimer);
  }
  saveViewTimer = setTimeout(() => storageSet(state.storageKey + ':view', state.view), 400);
}

function loadView() {
  const view = storageGet(state.storageKey + ':view');
  if (view && isFinite(view.x) && isFinite(view.y) && isFinite(view.k)) {
    state.view = { x: view.x, y: view.y, k: clamp(view.k, ZOOM_MIN, ZOOM_MAX) };
    return true;
  }
  return false;
}

function exportLayout() {
  const data = { commit: state.graph.meta.commit, pos: state.pos, collapsed: state.collapsed };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const link = htmlEl('a', { href: URL.createObjectURL(blob), download: 'zfs-io-flow-layout.json' });
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function importLayout(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyLayoutData(JSON.parse(reader.result));
      saveLayout();
      renderAll();
    } catch (err) {
      byId('details').prepend(htmlEl('p', { className: 'muted', text: 'Could not read that layout file.' }));
    }
  };
  reader.readAsText(file);
}

function resetLayout() {
  state.pos = JSON.parse(JSON.stringify(state.defaultPos));
  state.collapsed = {};
  saveLayout();
  renderAll();
  fitAll();
}

function writeHash() {
  let hash = '';
  if (state.mode === 'timeline' && state.timeline) {
    const scenario = currentScenario();
    hash = 'timeline=' + state.timeline.id + '&step=' + scenario.steps[state.timeline.k].n;
  } else if (state.select && state.select.kind === 'node' && state.select.id.indexOf('group:') !== 0) {
    hash = 'node=' + state.select.id;
  } else if (state.select && state.select.kind === 'wire') {
    hash = 'wire=' + state.select.id;
  } else if (state.path) {
    const path = state.pathsById[state.path.id];
    const defaults = defaultSelection(path);
    hash = 'path=' + path.id;
    const alts = [];
    for (const group in state.path.sel) {
      if (state.path.sel[group] !== defaults[group]) {
        alts.push(group + ':' + state.path.sel[group]);
      }
    }
    if (alts.length > 0) {
      hash += '&alt=' + alts.join(',');
    }
    const step = currentStep();
    if (step) {
      hash += '&step=' + step.n;
    }
  }
  const url = window.location.pathname + window.location.search + (hash ? '#' + hash : '');
  try {
    history.replaceState(null, '', url);
  } catch (err) {
    // Some file:// contexts refuse replaceState; the page still works.
  }
}

function readHash() {
  const params = {};
  for (const part of window.location.hash.replace(/^#/, '').split('&')) {
    const pair = part.split('=');
    if (pair[0]) {
      params[pair[0]] = decodeURIComponent(pair[1] || '');
    }
  }
  if (params.timeline && hasTimelines() && state.graph.timelines.some((t) => t.id === params.timeline)) {
    activateTimeline(params.timeline, params.step ? Number(params.step) : 1);
    if (state.mode !== 'timeline') {
      setView('timeline');
    }
    return true;
  }
  if (state.mode === 'timeline' && (params.path || params.node || params.wire)) {
    setView('graph');
  }
  if (params.path && state.pathsById[params.path]) {
    const sel = {};
    for (const item of (params.alt || '').split(',')) {
      const pair = item.split(':');
      if (pair.length === 2) {
        sel[pair[0]] = pair[1];
      }
    }
    activatePath(params.path, sel, params.step ? Number(params.step) : null, !params.step);
    return true;
  }
  if (params.node && state.nodesById[params.node] && displayIdOf(params.node)) {
    selectNode(displayIdOf(params.node), true);
    return true;
  }
  if (params.wire && state.wireEls[params.wire]) {
    selectWire(params.wire, true);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- keyboard

function onKeyDown(evt) {
  const tag = evt.target.tagName;
  const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  if (evt.key === 'Escape') {
    if (!byId('about').hidden) {
      byId('about').hidden = true;
    } else if (typing) {
      evt.target.blur();
    } else if (state.select || state.trace) {
      clearSelection();
    } else if (state.path) {
      clearPath();
    }
    return;
  }
  if (typing || evt.ctrlKey || evt.metaKey || evt.altKey) {
    return;
  }
  if (evt.key === '/') {
    evt.preventDefault();
    byId('search').focus();
    return;
  }
  if (state.mode === 'timeline') {
    onTimelineKey(evt);
    return;
  }
  if (evt.key === 'f' || evt.key === 'F') {
    fitAll();
    return;
  }
  if (!state.path) {
    return;
  }
  if (evt.key === 'ArrowRight') {
    evt.preventDefault();
    gotoStep(state.path.cur + 1);
  } else if (evt.key === 'ArrowLeft') {
    evt.preventDefault();
    gotoStep(state.path.cur - 1);
  } else if (evt.key === ' ') {
    evt.preventDefault();
    playPath(!state.path.playing);
  } else if (evt.key === 'Home') {
    evt.preventDefault();
    gotoStep(0);
  } else if (evt.key === 'End') {
    evt.preventDefault();
    gotoStep(state.path.played.length - 1);
  }
}

function onTimelineKey(evt) {
  const scenario = currentScenario();
  if (!scenario) {
    return;
  }
  const keys = {
    ArrowRight: () => gotoTimelineStep(state.timeline.k + 1),
    ArrowLeft: () => gotoTimelineStep(state.timeline.k - 1),
    Home: () => gotoTimelineStep(0),
    End: () => gotoTimelineStep(scenario.steps.length - 1),
    ' ': () => playTimeline(!state.timeline.playing),
  };
  if (keys[evt.key]) {
    evt.preventDefault();
    keys[evt.key]();
  }
}

// ---------------------------------------------------------------- init

function init() {
  loadGraph();
  const meta = state.graph.meta;
  const commitLink = byId('commit-link');
  commitLink.href = meta.repo + '/tree/' + meta.commit;
  commitLink.textContent = meta.version + ' @ ' + meta.commit.slice(0, 10);
  commitLink.title = 'OpenZFS ' + meta.version + ' at commit ' + meta.commit;

  state.defaultPos = layoutDefault();
  loadLayout();

  const ctxSelect = byId('ctx-filter');
  for (const ctx of state.graph.contexts) {
    ctxSelect.appendChild(htmlEl('option', { value: ctx.id, text: ctx.id + ': ' + ctx.name }));
  }
  ctxSelect.addEventListener('change', () => {
    state.ctxFilter = ctxSelect.value;
    applyHighlight();
  });

  renderLegend();
  renderGroupFilters();
  renderPathList();
  renderAbout();
  renderSuiteNav();
  renderAll();

  if (hasTimelines()) {
    byId('view-switch').hidden = false;
    byId('timeline-section').hidden = false;
    renderTimelineList();
    byId('btn-view-graph').addEventListener('click', () => setView('graph'));
    byId('btn-view-timeline').addEventListener('click', () => setView('timeline'));
    byId('tl-first').addEventListener('click', () => gotoTimelineStep(0));
    byId('tl-prev').addEventListener('click', () => gotoTimelineStep(state.timeline.k - 1));
    byId('tl-play').addEventListener('click', () => playTimeline(!state.timeline.playing));
    byId('tl-next').addEventListener('click', () => gotoTimelineStep(state.timeline.k + 1));
    byId('tl-last').addEventListener('click', () => gotoTimelineStep(currentScenario().steps.length - 1));
  }

  const svg = byId('canvas');
  svg.addEventListener('mousedown', startPan);
  svg.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', () => { renderMinimap(); updateGroupLabels(); });
  window.addEventListener('hashchange', readHash);

  const minimap = byId('minimap');
  minimap.addEventListener('mousedown', (evt) => {
    evt.stopPropagation();
    drag = { kind: 'minimap', sx: evt.clientX, sy: evt.clientY, moved: true };
    minimapMove(evt);
  });

  byId('btn-fit').addEventListener('click', () => fitAll());
  byId('btn-reset').addEventListener('click', resetLayout);
  byId('btn-export').addEventListener('click', exportLayout);
  byId('file-import').addEventListener('change', (evt) => {
    if (evt.target.files[0]) {
      importLayout(evt.target.files[0]);
    }
    evt.target.value = '';
  });
  byId('btn-about').addEventListener('click', () => { byId('about').hidden = false; });
  byId('about-close').addEventListener('click', () => { byId('about').hidden = true; });
  byId('about').addEventListener('click', (evt) => {
    if (evt.target === byId('about')) {
      byId('about').hidden = true;
    }
  });
  byId('toggle-left').addEventListener('click', () => {
    document.body.classList.toggle('hide-left');
    renderMinimap();
    updateGroupLabels();
  });
  byId('toggle-right').addEventListener('click', () => {
    document.body.classList.toggle('hide-right');
    renderMinimap();
    updateGroupLabels();
  });

  const search = byId('search');
  search.addEventListener('input', () => runSearch(search.value));
  search.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter' && state.searchHits && state.searchHits.length > 0) {
      openSearchHit(state.searchHits[0]);
    }
  });

  if (!loadView()) {
    fitAll();
  } else {
    setViewTransform();
  }
  readHash();
  renderDetails();
}

init();
