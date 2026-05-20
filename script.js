/* ================================================================
   NAVAL STRIKE — script.js
   Complete game logic: placement, 1P vs AI, 2P Pass&Play
   ================================================================ */
'use strict';

/* ── CONFIG ─────────────────────────────────────────────────────── */
const GRID = 10;
const SHIP_DEFS = [
  { id: 'carrier',    name: 'Portaaviones', size: 5 },
  { id: 'battleship', name: 'Acorazado',    size: 4 },
  { id: 'cruiser',    name: 'Crucero',       size: 3 },
  { id: 'submarine',  name: 'Submarino',     size: 3 },
  { id: 'destroyer',  name: 'Destructores',    size: 2 },
];

/* Grid values */
const V = { WATER: 0, SHIP: 1, MISS: -1, HIT: -2, SUNK: -3 };

/* ── GAME STATE ─────────────────────────────────────────────────── */
const G = {
  mode:      null,    // '1p' | '2p'
  phase:     'menu',  // menu | placement | handoff | battle | gameover
  names:     { 1: 'Jugador 1', 2: 'Jugador 2' }, // player names

  /* Placement */
  placing:   1,             // player being placed (1 or 2)
  placed:    { 1: [], 2: [] },
  selShip:   null,          // { id, name, size }
  editingShip: null,        // index of ship being edited in G.placed[G.placing]
  vertical:  false,

  /* Battle */
  attacker:  1,             // current attacker
  boards:    { 1: null, 2: null }, // Board instances
  stats:     { hits: 0, misses: 0, sunk: 0 },
  locked:    false,         // block input during AI turn

  /* AI */
  ai: {
    mode:    'hunt',   // 'hunt' | 'target'
    hits:    [],       // consecutive hit cells for current ship
    queue:   [],       // candidate cells to try next
    tried:   new Set(),
  },

  /* 2P handoff context */
  nextHandoffAction: null,
};

/* ── BOARD CLASS ─────────────────────────────────────────────────── */
class Board {
  constructor(ships) {
    this.grid  = Array.from({ length: GRID }, () => new Array(GRID).fill(V.WATER));
    this.ships = ships.map(s => ({ ...s, hits: 0, sunk: false }));
    for (const s of this.ships)
      for (const [r, c] of shipCells(s))
        this.grid[r][c] = V.SHIP;
  }

  /**
   * Fire at (row, col).
   * Returns: 'already' | 'miss' | 'hit' | 'sunk'
   */
  fire(row, col) {
    const v = this.grid[row][col];
    if (v === V.MISS || v === V.HIT || v === V.SUNK) return 'already';

    if (v === V.WATER) {
      this.grid[row][col] = V.MISS;
      return 'miss';
    }

    /* Hit a ship cell */
    this.grid[row][col] = V.HIT;
    const ship = this.ships.find(s =>
      shipCells(s).some(([r, c]) => r === row && c === col));

    ship.hits++;
    if (ship.hits >= ship.size) {
      ship.sunk = true;
      for (const [r, c] of shipCells(ship)) this.grid[r][c] = V.SUNK;
      return 'sunk';
    }
    return 'hit';
  }

  /** Returns the sunk ship that contains (row,col), or null */
  sunkShipAt(row, col) {
    if (this.grid[row][col] !== V.SUNK) return null;
    return this.ships.find(s => s.sunk &&
      shipCells(s).some(([r, c]) => r === row && c === col)) || null;
  }

  isDefeated()  { return this.ships.every(s => s.sunk) }
  aliveCount()  { return this.ships.filter(s => !s.sunk).length }
}

/* ── PURE HELPERS ────────────────────────────────────────────────── */
function shipCells({ row, col, size, vertical }) {
  return Array.from({ length: size }, (_, i) =>
    vertical ? [row + i, col] : [row, col + i]);
}

function inBounds(r, c) { return r >= 0 && r < GRID && c >= 0 && c < GRID }

/** True if ship doesn't overlap with existing ships (can touch sides and diagonals) */
function canPlace(placed, ship) {
  const newCells = shipCells(ship);
  for (const [r, c] of newCells)
    if (!inBounds(r, c)) return false;

  /* Only forbid exact cell overlap - allow touching on all sides */
  const occupied = new Set();
  for (const s of placed)
    for (const [r, c] of shipCells(s))
      occupied.add(`${r},${c}`);

  return newCells.every(([r, c]) => !occupied.has(`${r},${c}`));
}

/** Generate a valid random placement for all ships */
function randomPlacement() {
  const placed = [];
  for (const def of SHIP_DEFS) {
    let ship, attempts = 0;
    do {
      const v   = Math.random() < 0.5;
      const maxR = v ? GRID - def.size : GRID - 1;
      const maxC = v ? GRID - 1 : GRID - def.size;
      ship = {
        id: def.id, name: def.name, size: def.size,
        row: rand(maxR), col: rand(maxC), vertical: v,
        hits: 0, sunk: false,
      };
    } while (!canPlace(placed, ship) && ++attempts < 1000);
    placed.push(ship);
  }
  return placed;
}

function rand(max) { return Math.floor(Math.random() * (max + 1)) }

/* ── DOM HELPERS ─────────────────────────────────────────────────── */
const $  = id  => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls)  e.className   = cls;
  if (html) e.innerHTML   = html;
  return e;
};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  G.phase = id.replace('screen-', '');
}

function toast(msg, type = '') {
  const t = el('div', `toast ${type}`, msg);
  $('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function setLog(text, cls = '') {
  const el = $('battle-message');
  el.className = `log-text ${cls}`;
  el.textContent = text;
}

function showExplosion(name) {
  $('exp-text').textContent = `¡${name} HUNDIDO!`;
  const ov = $('exp-overlay');
  ov.classList.add('show');
  setTimeout(() => ov.classList.remove('show'), 900);
}

/* ── BOARD DOM ───────────────────────────────────────────────────── */
function buildBoardDOM(id) {
  const board = $(id);
  board.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const d = el('div', 'cell');
      d.dataset.row = r;
      d.dataset.col = c;
      frag.appendChild(d);
    }
  }
  board.appendChild(frag);
}

function getCell(boardId, r, c) {
  return $(boardId).querySelector(`[data-row="${r}"][data-col="${c}"]`);
}

/** Apply the full Board.grid state to a DOM board */
function renderBoard(board, boardId, hideShips = false) {
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const cell = getCell(boardId, r, c);
      const v    = board.grid[r][c];
      cell.className = 'cell';
      delete cell.dataset.shipType;
      delete cell.dataset.shipIndex;
      delete cell.dataset.shipSize;
      delete cell.dataset.shipVertical;
      if      (v === V.SHIP && !hideShips) cell.classList.add('ship');
      else if (v === V.MISS)               cell.classList.add('miss');
      else if (v === V.HIT)                cell.classList.add('ship', 'hit');
      else if (v === V.SUNK)               cell.classList.add('sunk');
    }
  }
  // Assign ship types to cells
  for (const ship of board.ships) {
    const cells = shipCells(ship);
    cells.forEach(([ r, c ], idx) => {
      const cell = getCell(boardId, r, c);
      if (cell) {
        cell.dataset.shipType = ship.id;
        cell.dataset.shipIndex = idx;
        cell.dataset.shipSize = ship.size;
        cell.dataset.shipVertical = ship.vertical ? 'true' : 'false';
      }
    });
  }
}

/** Update a single cell (incremental — much faster than full re-render) */
function setCellState(boardId, r, c, state) {
  const cell = getCell(boardId, r, c);
  if (!cell) return;
  const shipType = cell.dataset.shipType; // Preserve ship type
  cell.className = 'cell';
  if (shipType) cell.dataset.shipType = shipType;
  if (state === 'miss') cell.classList.add('miss');
  if (state === 'hit')  cell.classList.add('ship', 'hit');
  if (state === 'sunk') cell.classList.add('sunk');
  if (state === 'ship') cell.classList.add('ship');
}

/* ── PLACEMENT SCREEN ────────────────────────────────────────────── */
function initPlacement(player) {
  G.placing  = player;
  G.selShip  = null;
  G.vertical = false;

  $('placement-title').textContent =
    G.mode === '2p' ? `POSICIONAR FLOTA — ${G.names[player]}` : 'POSICIONAR FLOTA';
  $('placement-player-badge').textContent =
    G.mode === '2p' ? G.names[player] : 'TU FLOTA';
  $('orient-badge').textContent  = '→ HORIZONTAL';
  $('rotate-icon').textContent   = '↻';
  $('hint-text').textContent     = 'Selecciona un barco y haz clic en el tablero';

  buildBoardDOM('placement-board');
  renderShipList();
  redrawPlacement();
  updateReadyBtn();
  showScreen('screen-placement');
}

function renderShipList() {
  const ul  = $('ship-list');
  ul.innerHTML = '';
  const frag = document.createDocumentFragment();

  for (const def of SHIP_DEFS) {
    const placed = G.placed[G.placing].some(s => s.id === def.id);
    const li = el('li', `ship-item${placed ? ' placed' : ''}`);
    li.dataset.id = def.id;

    const dots = Array.from({ length: def.size },
      () => '<span class="si-dot"></span>').join('');
    li.innerHTML = `
      <div class="si-dots">${dots}</div>
      <span class="si-name">${def.name}</span>
      ${placed ? '<span class="si-check">✓</span>' : ''}`;

    if (!placed) li.addEventListener('click', () => selectShip(def));
    frag.appendChild(li);
  }
  ul.appendChild(frag);

  const n = G.placed[G.placing].length;
  const t = SHIP_DEFS.length;
  $('progress-count').textContent = `${n} / ${t}`;
  $('progress-bar').style.width   = `${(n / t) * 100}%`;
  $('pf-status').textContent = n === t
    ? '✓ ¡Flota lista! Pulsa LISTO para continuar'
    : `Coloca todos los barcos para continuar (${n}/${t})`;
}

function selectShip(def) {
  G.selShip = def;
  document.querySelectorAll('.ship-item').forEach(li =>
    li.classList.toggle('selected', li.dataset.id === def.id));
  $('hint-text').textContent =
    `Colocando: ${def.name} (${def.size} celdas) — Clic en el tablero`;
}

function redrawPlacement() {
  // Clear all
  $('placement-board').querySelectorAll('.cell').forEach(c => {
    c.className = 'cell';
    delete c.dataset.shipType;
    delete c.dataset.shipIndex;
    delete c.dataset.shipSize;
    delete c.dataset.shipVertical;
    delete c.dataset.shipPlacedIndex;
  });
  // Draw placed ships
  for (let shipIdx = 0; shipIdx < G.placed[G.placing].length; shipIdx++) {
    const s = G.placed[G.placing][shipIdx];
    const cells = shipCells(s);
    cells.forEach(([r, c], idx) => {
      const cell = getCell('placement-board', r, c);
      if (cell) {
        cell.classList.add('ship');
        if (shipIdx === G.editingShip) cell.classList.add('editing');
        cell.dataset.shipType = s.id;
        cell.dataset.shipIndex = idx;
        cell.dataset.shipSize = s.size;
        cell.dataset.shipVertical = s.vertical ? 'true' : 'false';
        cell.dataset.shipPlacedIndex = shipIdx;
      }
    });
  }
}

function clearHover() {
  $('placement-board').querySelectorAll('.hover-ok, .hover-bad').forEach(c =>
    c.classList.remove('hover-ok', 'hover-bad'));
}

function selectShipForEdit(shipIndex) {
  G.editingShip = shipIndex;
  const ship = G.placed[G.placing][shipIndex];
  G.vertical = ship.vertical;
  $('rotate-icon').textContent  = G.vertical ? '↺' : '↻';
  $('orient-badge').textContent = G.vertical ? '↑ VERTICAL' : '→ HORIZONTAL';
  $('hint-text').textContent = 'Editando: ' + ship.name + ' — Haz clic para mover o Eliminar para cancelar';
  redrawPlacement();
}

function previewPlacement(r, c) {
  clearHover();
  let ship;
  
  if (G.editingShip !== null) {
    /* Preview for editing existing ship */
    const existing = G.placed[G.placing][G.editingShip];
    ship = { ...existing, row: r, col: c, vertical: G.vertical };
    const others = G.placed[G.placing].filter((_, idx) => idx !== G.editingShip);
    const ok = canPlace(others, ship);
    for (const [sr, sc] of shipCells(ship)) {
      if (!inBounds(sr, sc)) continue;
      getCell('placement-board', sr, sc)?.classList.add(ok ? 'hover-ok' : 'hover-bad');
    }
  } else if (G.selShip) {
    /* Preview for placing new ship */
    ship = { ...G.selShip, row: r, col: c, vertical: G.vertical };
    const ok = canPlace(G.placed[G.placing], ship);
    for (const [sr, sc] of shipCells(ship)) {
      if (!inBounds(sr, sc)) continue;
      getCell('placement-board', sr, sc)?.classList.add(ok ? 'hover-ok' : 'hover-bad');
    }
  }
}

function placeShip(r, c) {
  /* If editing existing ship */
  if (G.editingShip !== null) {
    const ship = G.placed[G.placing][G.editingShip];
    const newShip = { ...ship, row: r, col: c, vertical: G.vertical };
    
    /* Check placement without current ship */
    const others = G.placed[G.placing].filter((_, idx) => idx !== G.editingShip);
    if (!canPlace(others, newShip)) {
      toast('No se puede mover ahí', 'err');
      return;
    }
    
    G.placed[G.placing][G.editingShip] = newShip;
    G.editingShip = null;
    $('hint-text').textContent = 'Selecciona un barco y haz clic en el tablero';
    redrawPlacement();
    clearHover();
    return;
  }
  
  /* Place new ship */
  if (!G.selShip) { toast('Selecciona un barco primero', 'err'); return }
  const ship = { ...G.selShip, row: r, col: c, vertical: G.vertical, hits: 0, sunk: false };
  if (!canPlace(G.placed[G.placing], ship)) { toast('No se puede colocar ahí', 'err'); return }

  G.placed[G.placing].push(ship);
  G.selShip = null;
  document.querySelectorAll('.ship-item').forEach(li => li.classList.remove('selected'));
  $('hint-text').textContent = 'Selecciona un barco y haz clic en el tablero';
  redrawPlacement();
  renderShipList();
  updateReadyBtn();
  clearHover();
}

function updateReadyBtn() {
  $('btn-ready').disabled = G.placed[G.placing].length < SHIP_DEFS.length;
}

/* ── BATTLE INIT ─────────────────────────────────────────────────── */
function startBattle() {
  G.attacker  = 1;
  G.stats     = { hits: 0, misses: 0, sunk: 0 };
  G.locked    = false;
  G.boards[1] = new Board(G.placed[1]);
  G.boards[2] = new Board(G.placed[2]);
  resetAI();

  buildBoardDOM('enemy-board');
  buildBoardDOM('own-board');
  fullRefreshBattleView();
  updateScoreDOM();
  updateTurnDOM();
  setLog('Haz clic en el radar enemigo para disparar');
  setActiveBattleTab('enemy');
  showScreen('screen-battle');
}

/**
 * Re-render both boards from scratch for the current attacker.
 * Used when returning from handoff or on battle init.
 */
function fullRefreshBattleView() {
  const atk  = G.attacker;
  const def  = atk === 1 ? 2 : 1;
  const is2P = G.mode === '2p';

  renderBoard(G.boards[def], 'enemy-board', true);   // attacker's target: always hide ships
  renderBoard(G.boards[atk], 'own-board',   is2P);   // own board: hide ships in 2P

  buildFleetTracker('enemy-fleet-tracker', G.boards[def]);
  buildFleetTracker('own-fleet-tracker',   G.boards[atk]);

  $('enemy-ships-left').textContent = G.boards[def].aliveCount();
  $('own-ships-left').textContent   = G.boards[atk].aliveCount();

  /* 2P: fixed visual positions + labels */
  const screen = $('screen-battle');
  if (is2P) {
    screen.classList.toggle('p1-turn', atk === 1);
    screen.classList.toggle('p2-turn', atk === 2);

    /* Labels: enemy panel = DEFENDER, own panel = ATTACKER */
    const atkName = G.names[atk];
    const defName = G.names[def];
    $('enemy-panel-icon').textContent = '⊕';
    $('enemy-panel-title').textContent = defName;
    $('enemy-panel-sub').textContent   = `← Disparar aquí`;
    $('own-panel-icon').textContent    = '◉';
    $('own-panel-title').textContent   = atkName;
    $('own-panel-sub').textContent     = 'Zona de defensa';
  } else {
    screen.classList.remove('p1-turn', 'p2-turn');
    $('enemy-panel-title').textContent = 'RADAR ENEMIGO';
    $('enemy-panel-sub').textContent   = 'Clic para disparar';
    $('own-panel-title').textContent   = 'MI FLOTA';
    $('own-panel-sub').textContent     = 'Zona de defensa';
  }
}

function buildFleetTracker(containerId, board) {
  const cont = $(containerId);
  cont.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const s of board.ships) {
    const div = el('div', `fti${s.sunk ? ' sunk' : ''}`);
    div.id = `fti-${containerId}-${s.id}`;
    for (let i = 0; i < s.size; i++) div.appendChild(el('span'));
    frag.appendChild(div);
  }
  cont.appendChild(frag);
}

function markTrackerSunk(containerId, shipId) {
  $(`fti-${containerId}-${shipId}`)?.classList.add('sunk');
}

function updateTurnDOM() {
  const name = G.mode === '2p'
    ? G.names[G.attacker]
    : (G.attacker === 1 ? 'JUGADOR' : 'IA');
  $('turn-player-name').textContent = name;
}

function updateScoreDOM() {
  $('stat-hits').textContent   = G.stats.hits;
  $('stat-misses').textContent = G.stats.misses;
  $('stat-sunk').textContent   = G.stats.sunk;
}

/* ── FIRE / SHOOT ────────────────────────────────────────────────── */
function playerFire(row, col) {
  if (G.locked) return;
  if (G.mode === '1p' && G.attacker !== 1) return;

  const def   = G.attacker === 1 ? 2 : 1;
  const board = G.boards[def];
  const res   = board.fire(row, col);
  if (res === 'already') { toast('Ya disparaste aquí', 'err'); return }

  processShot(res, row, col, board, 'enemy-board', 'enemy-fleet-tracker');
}

function processShot(res, row, col, board, boardId, trackerId) {
  const isEnemy = (boardId === 'enemy-board');

  /* ── Update cell ── */
  setCellState(boardId, row, col, res === 'miss' ? 'miss' : res === 'hit' ? 'hit' : 'sunk');

  /* ── If sunk: reveal all cells of that ship ── */
  let sunkShip = null;
  if (res === 'sunk') {
    sunkShip = board.sunkShipAt(row, col);
    if (sunkShip) {
      for (const [r, c] of shipCells(sunkShip))
        setCellState(boardId, r, c, 'sunk');
      markTrackerSunk(trackerId, sunkShip.id);
    }
    if (G.mode === '1p') { G.stats.hits++; G.stats.sunk++ }
  } else if (res === 'hit') {
    if (G.mode === '1p') G.stats.hits++;
  } else {
    if (G.mode === '1p') G.stats.misses++;
  }

  /* Update alive badges */
  const def = G.attacker === 1 ? 2 : 1;
  $('enemy-ships-left').textContent = G.boards[def].aliveCount();
  $('own-ships-left').textContent   = G.boards[G.attacker].aliveCount();

  updateScoreDOM();

  /* ── SFX ── */
  if      (res === 'miss') SFX.playMiss();
  else if (res === 'hit')  SFX.playHit();
  else                     SFX.playSunk();

  /* ── Log + icon ── */
  const isHuman = G.attacker === 1 || G.mode === '2p';
  if (res === 'miss') {
    setLog(isHuman ? '— Agua. Turno del enemigo.' : '— La IA falló. ¡Tu turno!', 'miss');
    $('log-icon').textContent = '💧';
  } else if (res === 'hit') {
    setLog(isHuman ? '¡IMPACTO! Vuelves a disparar.' : '¡La IA tocó uno de tus barcos!', 'hit');
    $('log-icon').textContent = '💥';
  } else {
    const sn = sunkShip?.name || 'Barco';
    setLog(isHuman ? `¡${sn} ENEMIGO HUNDIDO!` : `¡La IA hundió tu ${sn}!`, 'sunk');
    $('log-icon').textContent = '🔥';
    setTimeout(() => showExplosion(sn), 80);
  }

  /* ── Check victory ── */
  if (board.isDefeated()) {
    setTimeout(() => endGame(G.attacker), 850);
    return;
  }

  /* ── Turn management ── */
  if (res === 'miss') {
    const wasAI = (G.mode === '1p' && G.attacker === 2);
    G.attacker = G.attacker === 1 ? 2 : 1;
    updateTurnDOM();
    if (G.mode === '2p') {
      setTimeout(() => showTurnBanner(() => {
        fullRefreshBattleView();
        updateTurnDOM();
        setActiveBattleTab('enemy');
      }), 650);
    } else if (!wasAI) {
      /* 1P: Only AI takes its turn if the PLAYER missed */
      G.locked = true;
      $('enemy-board').classList.add('waiting');
      setTimeout(() => aiTurn(), 1050);
    }
  } else {
    /* hit or sunk → same player fires again */
    updateTurnDOM();
    if (G.mode === '1p' && G.attacker === 2) {
      G.locked = true;
      $('enemy-board').classList.add('waiting');
      setTimeout(() => aiTurn(), 1050);
    }
  }
}

/* ── AI ──────────────────────────────────────────────────────────── */
function resetAI() {
  G.ai = { mode: 'hunt', hits: [], queue: [], tried: new Set() };
}

function aiTurn() {
  const board = G.boards[1];
  const [r, c] = aiPickCell(board);
  G.ai.tried.add(`${r},${c}`);

  const res = board.fire(r, c);

  /* Update AI state machine */
  if (res === 'hit') {
    G.ai.mode = 'target';
    G.ai.hits.push([r, c]);
    enqueueAITargets(r, c, board);
  } else if (res === 'sunk') {
    /* Ship destroyed — back to hunt */
    G.ai.mode  = 'hunt';
    G.ai.hits  = [];
    G.ai.queue = [];
  }

  $('enemy-board').classList.remove('waiting');
  G.locked = false;

  /* Re-use processShot logic */
  processShot(res, r, c, board, 'own-board', 'own-fleet-tracker');
}

function aiPickCell(board) {
  /* TARGET mode: drain the candidate queue */
  if (G.ai.mode === 'target') {
    while (G.ai.queue.length > 0) {
      const [r, c] = G.ai.queue.shift();
      const v = board.grid[r][c];
      if (!G.ai.tried.has(`${r},${c}`) && (v === V.WATER || v === V.SHIP))
        return [r, c];
    }
    /* Queue exhausted without finding a valid cell — fall through to hunt */
    G.ai.mode = 'hunt';
    G.ai.hits = [];
  }

  /* HUNT mode: checkerboard pattern (most efficient) */
  const cands = [];
  for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++) {
      const v = board.grid[r][c];
      if (!G.ai.tried.has(`${r},${c}`) && (v === V.WATER || v === V.SHIP)
          && (r + c) % 2 === 0)
        cands.push([r, c]);
    }

  if (cands.length > 0) return cands[Math.floor(Math.random() * cands.length)];

  /* Fallback: any untried cell */
  for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++) {
      const v = board.grid[r][c];
      if (!G.ai.tried.has(`${r},${c}`) && (v === V.WATER || v === V.SHIP))
        return [r, c];
    }

  return [0, 0]; /* Should never happen */
}

function enqueueAITargets(r, c, board) {
  const ai = G.ai;

  /* With 2+ hits we can infer direction → prioritise axis extremes */
  if (ai.hits.length >= 2) {
    const sameRow = ai.hits.every(([hr]) => hr === ai.hits[0][0]);
    let candidates;
    if (sameRow) {
      const sorted = [...ai.hits].sort((a, b) => a[1] - b[1]);
      const row    = ai.hits[0][0];
      candidates = [
        [row, sorted[0][1] - 1],
        [row, sorted[sorted.length - 1][1] + 1],
      ];
    } else {
      const sorted = [...ai.hits].sort((a, b) => a[0] - b[0]);
      const col    = ai.hits[0][1];
      candidates = [
        [sorted[0][0] - 1, col],
        [sorted[sorted.length - 1][0] + 1, col],
      ];
    }
    /* Prepend (highest priority) */
    for (const [nr, nc] of candidates.reverse())
      queueCell(nr, nc, true);
    return;
  }

  /* First hit: add all 4 orthogonal neighbours */
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]])
    queueCell(r + dr, c + dc, false);
}

function queueCell(r, c, prepend) {
  if (!inBounds(r, c)) return;
  if (G.ai.tried.has(`${r},${c}`)) return;
  if (G.ai.queue.some(([qr, qc]) => qr === r && qc === c)) return;
  const v = G.boards[1].grid[r][c];
  if (v !== V.WATER && v !== V.SHIP) return;
  prepend ? G.ai.queue.unshift([r, c]) : G.ai.queue.push([r, c]);
}

/* ── TURN BANNER (reemplaza handoff en batalla 2P) ──────────────── */
function showTurnBanner(onDone) {
  const atk    = G.attacker;
  const banner = document.getElementById('turn-banner');
  document.getElementById('turn-banner-player').textContent  = G.names[atk];
  document.getElementById('turn-banner-emblem').textContent  = atk === 1 ? '⚔️' : '🛡️';

  banner.classList.remove('hide');
  banner.classList.add('show');

  setTimeout(() => {
    banner.classList.add('hide');
    banner.addEventListener('animationend', function handler() {
      banner.classList.remove('show', 'hide');
      banner.removeEventListener('animationend', handler);
      onDone();
    });
  }, 500);
}

/* ── HANDOFF (2P) — solo para posicionamiento ───────────────────── */
function showHandoff(action = 'battle') {
  G.nextHandoffAction = action;

  let nextPlayer, eyebrow, shield, desc, btnLabel, btnSub;
  if (action === 'placement2') {
    nextPlayer = 2;
    eyebrow    = 'POSICIONAMIENTO —';
    shield     = '⚓';
    desc       = `El <strong>${G.names[1]}</strong> ya colocó su flota.<br/>
                  Pulsa cuando <strong>${G.names[2]}</strong> esté listo para posicionar.`;
    btnLabel   = 'POSICIONAR MI FLOTA';
    btnSub     = `${G.names[2]} · Colocar barcos`;
  } else {
    nextPlayer = G.attacker;
    const prev = nextPlayer === 1 ? 2 : 1;
    eyebrow    = 'TURNO DE';
    shield     = '🛡️';
    desc       = `El tablero del <strong>${G.names[prev]}</strong> ha sido ocultado.<br/>
                  Pulsa cuando <strong>${G.names[nextPlayer]}</strong> esté listo.`;
    btnLabel   = 'ESTOY LISTO';
    btnSub     = 'Continuar al juego';
  }

  $('handoff-shield').textContent        = shield;
  $('handoff-eyebrow').textContent       = eyebrow;
  $('handoff-player-name').textContent   = G.names[nextPlayer];
  $('handoff-desc').innerHTML            = desc;
  $('handoff-btn-label').textContent     = btnLabel;
  $('handoff-btn-sub').textContent       = btnSub;
  showScreen('screen-handoff');
}

/* ── END GAME ────────────────────────────────────────────────────── */
function endGame(winner) {
  const is1P   = G.mode === '1p';
  const isWin  = !is1P || winner === 1;
  const emblem = isWin ? '🏆' : '💀';
  const eyebrow = isWin ? '— VICTORIA —' : '— DERROTA —';
  const title  = is1P
    ? (isWin ? '¡Misión Cumplida!' : 'Misión Fallida')
    : `¡${G.names[winner]} Gana!`;
  const desc   = is1P
    ? (isWin
        ? 'Has hundido toda la flota enemiga. ¡Excelente táctica!'
        : 'La IA ha hundido tu flota. Inténtalo de nuevo.')
    : `${G.names[winner]} ha hundido toda la flota enemiga.`;

  $('go-emblem').textContent  = emblem;
  $('go-eyebrow').textContent = eyebrow;
  $('go-title').textContent   = title;
  $('go-title').className     = `go-title${isWin ? '' : ' defeat'}`;
  $('go-desc').textContent    = desc;

  const statsEl = $('go-stats');
  statsEl.innerHTML = '';
  if (is1P) {
    [
      { v: G.stats.hits,   l: 'IMPACTOS' },
      { v: G.stats.misses, l: 'FALLOS' },
      { v: G.stats.sunk,   l: 'HUNDIDOS' },
    ].forEach(({ v, l }) => {
      const d = el('div', 'gos-item');
      d.innerHTML = `<div class="gos-val">${v}</div><div class="gos-lbl">${l}</div>`;
      statsEl.appendChild(d);
    });
  }

  /* ── Save score ── */
  saveScore({
    date:   Date.now(),
    mode:   G.mode,
    result: isWin ? 'win' : 'loss',
    winner,
    hits:   G.stats.hits,
    misses: G.stats.misses,
    sunk:   G.stats.sunk,
  });

  /* ── Populate end-game boards ── */
  const leftLabel  = is1P ? 'Flota Enemiga (IA)' : `${G.names[2]}${winner === 2 ? ' 🏆' : ''}`;
  const rightLabel = is1P ? 'Tu Flota'           : `${G.names[1]}${winner === 1 ? ' 🏆' : ''}`;
  $('go-board-1-title').textContent = leftLabel;
  $('go-board-2-title').textContent = rightLabel;

  buildBoardDOM('go-board-1');
  buildBoardDOM('go-board-2');
  renderBoard(G.boards[2], 'go-board-1', false);
  renderBoard(G.boards[1], 'go-board-2', false);

  showScreen('screen-gameover');
}

/* ── TABS (mobile) ───────────────────────────────────────────────── */
function setActiveBattleTab(tab) {
  $('tab-enemy').classList.toggle('active', tab === 'enemy');
  $('tab-own').classList.toggle('active',   tab === 'own');
  const mobile = window.innerWidth <= 860;
  $('container-enemy').classList.toggle('hidden', mobile && tab !== 'enemy');
  $('container-own').classList.toggle('hidden',   mobile && tab !== 'own');
}

/* ── FULL RESET ──────────────────────────────────────────────────── */
function fullReset() {
  G.mode    = null;
  G.phase   = 'menu';
  G.placing = 1;
  G.placed  = { 1: [], 2: [] };
  G.selShip = null;
  G.vertical = false;
  G.attacker = 1;
  G.boards   = { 1: null, 2: null };
  G.stats    = { hits: 0, misses: 0, sunk: 0 };
  G.locked   = false;
  G.nextHandoffAction = null;
  resetAI();
}

/* ── POPULATE FLEET PREVIEW IN MENU ─────────────────────────────── */
function buildMenuFleetPreviews() {
  /* fp-ship elements need their child spans created by JS */
  document.querySelectorAll('.fp-ship, .ft-ship').forEach(div => {
    if (div.children.length > 0) return; /* already built */
    const cls = div.className;
    let size = 2;
    if (cls.includes('s5')) size = 5;
    else if (cls.includes('s4')) size = 4;
    else if (cls.includes('s3')) size = 3;
    for (let i = 0; i < size; i++) div.appendChild(el('span'));
  });
}

/* ================================================================
   EVENT LISTENERS
   ================================================================ */
document.addEventListener('DOMContentLoaded', () => {
  buildMenuFleetPreviews();

  /* ── MENU ── */
  $('btn-1p').addEventListener('click', () => {
    fullReset();
    G.mode = '1p';
    G.placed[2] = randomPlacement(); /* AI places its ships immediately */
    initPlacement(1);
  });

  $('btn-2p').addEventListener('click', () => {
    fullReset();
    G.mode = '2p';
    showScreen('screen-names');
    $('player1-name').value = '';
    $('player2-name').value = '';
    $('player1-name').focus();
  });

  /* ── NAMES (2P) ── */
  $('btn-names-continue').addEventListener('click', () => {
    const p1 = $('player1-name').value.trim() || 'Jugador 1';
    const p2 = $('player2-name').value.trim() || 'Jugador 2';
    G.names[1] = p1;
    G.names[2] = p2;
    initPlacement(1);
  });

  /* ── PLACEMENT ── */
  $('back-from-placement').addEventListener('click', () => {
    fullReset();
    showScreen('screen-menu');
  });

  $('btn-rotate').addEventListener('click', () => {
    G.vertical = !G.vertical;
    $('rotate-icon').textContent  = G.vertical ? '↺' : '↻';
    $('orient-badge').textContent = G.vertical ? '↑ VERTICAL' : '→ HORIZONTAL';
  });

  $('btn-random').addEventListener('click', () => {
    G.placed[G.placing] = randomPlacement();
    G.selShip = null;
    document.querySelectorAll('.ship-item').forEach(li => li.classList.remove('selected'));
    $('hint-text').textContent = 'Posición aleatoria aplicada.';
    redrawPlacement();
    renderShipList();
    updateReadyBtn();
    clearHover();
  });

  $('btn-clear').addEventListener('click', () => {
    G.placed[G.placing] = [];
    G.selShip = null;
    document.querySelectorAll('.ship-item').forEach(li => li.classList.remove('selected'));
    $('hint-text').textContent = 'Tablero limpio. Selecciona un barco para empezar.';
    redrawPlacement();
    renderShipList();
    updateReadyBtn();
    clearHover();
  });

  /* Hover preview */
  $('placement-board').addEventListener('mousemove', e => {
    const c = e.target.closest('.cell');
    if (!c) { clearHover(); return }
    previewPlacement(+c.dataset.row, +c.dataset.col);
  });
  $('placement-board').addEventListener('mouseleave', clearHover);

  /* Place ship or select for edit on click */
  $('placement-board').addEventListener('click', e => {
    const c = e.target.closest('.cell');
    if (!c) return;
    
    /* If clicking on placed ship, select for edit or change selection */
    if (c.classList.contains('ship')) {
      const shipPlacedIndex = +c.dataset.shipPlacedIndex;
      /* Deselect ship from list and switch to edit mode */
      G.selShip = null;
      document.querySelectorAll('.ship-item').forEach(li => li.classList.remove('selected'));
      selectShipForEdit(shipPlacedIndex);
    } else {
      /* Clicking on empty water */
      if (G.editingShip !== null || G.selShip) {
        /* Try to place/move ship */
        placeShip(+c.dataset.row, +c.dataset.col);
      } else {
        /* No selection, deselect any editing */
        G.editingShip = null;
        $('hint-text').textContent = 'Selecciona un barco y haz clic en el tablero';
        redrawPlacement();
        clearHover();
      }
    }
  });

  /* Touch support for placement */
  $('placement-board').addEventListener('touchend', e => {
    e.preventDefault();
    const t   = e.changedTouches[0];
    const hit = document.elementFromPoint(t.clientX, t.clientY)?.closest('.cell');
    if (hit) placeShip(+hit.dataset.row, +hit.dataset.col);
  }, { passive: false });

  /* Keyboard shortcuts: R (rotate), A (random), Delete (clear) */
  document.addEventListener('keydown', e => {
    if (G.phase !== 'placement') return;
    if (e.key === 'r' || e.key === 'R') {
      G.vertical = !G.vertical;
      $('rotate-icon').textContent  = G.vertical ? '↺' : '↻';
      $('orient-badge').textContent = G.vertical ? '↑ VERTICAL' : '→ HORIZONTAL';
    } else if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      $('btn-random').click();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      /* Cancel edit or clear all */
      if (G.editingShip !== null) {
        G.editingShip = null;
        $('hint-text').textContent = 'Selecciona un barco y haz clic en el tablero';
        redrawPlacement();
        clearHover();
      } else {
        $('btn-clear').click();
      }
    }
  });

  /* Ready button */
  $('btn-ready').addEventListener('click', () => {
    if ($('btn-ready').disabled) return;
    if (G.mode === '2p' && G.placing === 1) {
      showHandoff('placement2');
    } else {
      G.attacker = 1;
      startBattle();
    }
  });

  /* ── HANDOFF ── */
  $('btn-handoff-ready').addEventListener('click', () => {
    if (G.nextHandoffAction === 'placement2') {
      G.nextHandoffAction = null;
      initPlacement(2);
    } else {
      /* Return to battle for the current attacker */
      G.nextHandoffAction = null;
      fullRefreshBattleView();
      updateTurnDOM();
      setActiveBattleTab('enemy');
      setLog(`Turno de ${G.names[G.attacker]} — Haz clic para disparar`);
      showScreen('screen-battle');
    }
  });

  /* ── BATTLE: fire ── */
  $('enemy-board').addEventListener('click', e => {
    if (G.phase !== 'battle' || G.locked) return;
    if (G.mode === '1p' && G.attacker !== 1) return;
    const c = e.target.closest('.cell');
    if (c) playerFire(+c.dataset.row, +c.dataset.col);
  });

  /* Touch fire */
  $('enemy-board').addEventListener('touchend', e => {
    if (G.phase !== 'battle' || G.locked) return;
    if (G.mode === '1p' && G.attacker !== 1) return;
    e.preventDefault();
    const t   = e.changedTouches[0];
    const hit = document.elementFromPoint(t.clientX, t.clientY)?.closest('.cell');
    if (hit) playerFire(+hit.dataset.row, +hit.dataset.col);
  }, { passive: false });

  /* ── TABS ── */
  $('tab-enemy').addEventListener('click', () => setActiveBattleTab('enemy'));
  $('tab-own').addEventListener('click',   () => setActiveBattleTab('own'));
  window.addEventListener('resize', () => {
    if (G.phase === 'battle') {
      const tab = $('tab-enemy').classList.contains('active') ? 'enemy' : 'own';
      setActiveBattleTab(tab);
    }
  });

  /* ── SURRENDER ── */
  $('btn-surrender').addEventListener('click', () => {
    showConfirm({
      icon:    '⚑',
      title:   '¿RENDIRSE?',
      desc:    'Perderás la partida. Esta acción no se puede deshacer.',
      okLabel: 'RENDIRSE',
      onOk:    () => endGame(G.attacker === 1 ? 2 : 1),
    });
  });

  /* ── GAME OVER ── */
  $('btn-play-again').addEventListener('click', () => {
    const m = G.mode;
    fullReset();
    G.mode = m;
    if (m === '1p') G.placed[2] = randomPlacement();
    initPlacement(1);
  });

  $('btn-main-menu').addEventListener('click', () => {
    fullReset();
    showScreen('screen-menu');
  });

  /* ── INIT ── */
  showScreen('screen-menu');
});

/* ── CUSTOM CONFIRM ─────────────────────────────────────────────── */
function showConfirm({ icon = '⚑', title, desc, okLabel = 'CONFIRMAR', onOk }) {
  const overlay = document.getElementById('confirm-overlay');
  document.getElementById('confirm-icon').textContent  = icon;
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-desc').textContent  = desc;
  document.getElementById('confirm-ok').textContent    = okLabel;

  overlay.classList.add('open');

  function close() { overlay.classList.remove('open'); }

  const okBtn     = document.getElementById('confirm-ok');
  const cancelBtn = document.getElementById('confirm-cancel');

  const handleOk = () => { close(); cleanup(); onOk(); };
  const handleCancel = () => { close(); cleanup(); };
  const handleKey = (e) => { if (e.key === 'Escape') handleCancel(); };

  function cleanup() {
    okBtn.removeEventListener('click', handleOk);
    cancelBtn.removeEventListener('click', handleCancel);
    document.removeEventListener('keydown', handleKey);
  }

  okBtn.addEventListener('click', handleOk);
  cancelBtn.addEventListener('click', handleCancel);
  document.addEventListener('keydown', handleKey);
}

/* ── SCORES ─────────────────────────────────────────────────────── */
const SCORES_KEY = 'navalStrike_scores';
const MAX_SCORES = 20;

function saveScore(entry) {
  const list = getScores();
  list.unshift(entry);
  if (list.length > MAX_SCORES) list.length = MAX_SCORES;
  try { localStorage.setItem(SCORES_KEY, JSON.stringify(list)); } catch (_) {}
}

function getScores() {
  try { return JSON.parse(localStorage.getItem(SCORES_KEY) || '[]'); } catch (_) { return []; }
}

function renderScoresHTML() {
  const list = getScores();
  if (!list.length) {
    return '<p style="color:var(--muted-b);text-align:center;padding:1rem;font-size:.8rem">Aún no hay partidas registradas.</p>';
  }
  const rows = list.map((s, i) => {
    const d    = new Date(s.date);
    const fecha = d.toLocaleDateString('es', { day:'2-digit', month:'2-digit', year:'2-digit' });
    const hora  = d.toLocaleTimeString('es', { hour:'2-digit', minute:'2-digit' });
    const modo  = s.mode === '1p' ? '1P' : '2P';
    const res   = s.result === 'win'
      ? '<span style="color:var(--green)">VICTORIA</span>'
      : '<span style="color:var(--red)">DERROTA</span>';
    const stats = s.mode === '1p'
      ? `<span title="Impactos">${s.hits}💥</span> <span title="Fallos">${s.misses}💧</span> <span title="Hundidos">${s.sunk}🚢</span>`
      : `J${s.winner} gana`;
    return `<tr class="${i % 2 === 0 ? 'sc-row-even' : ''}">
      <td class="sc-rank">#${i + 1}</td>
      <td>${fecha}<br/><span style="color:var(--muted);font-size:.6rem">${hora}</span></td>
      <td><span class="sc-mode">${modo}</span></td>
      <td>${res}</td>
      <td class="sc-stats">${stats}</td>
    </tr>`;
  }).join('');
  return `
    <div style="display:flex;justify-content:flex-end;margin-bottom:.5rem">
      <button id="btn-clear-scores" style="
        background:transparent;border:1px solid var(--red);border-radius:4px;
        color:var(--red);font-family:var(--font-hud);font-size:.55rem;
        letter-spacing:.08em;padding:.25rem .6rem;cursor:pointer">
        🗑 BORRAR TODO
      </button>
    </div>
    <table class="scores-table">
      <thead><tr><th>#</th><th>FECHA</th><th>MODO</th><th>RESULTADO</th><th>STATS</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function openScoresModal() {
  const overlay = document.getElementById('info-modal-overlay');
  const body    = document.getElementById('info-modal-body');
  body.innerHTML = `<div class="info-head"><span class="info-dot cyan"></span>PUNTUACIONES</div>` + renderScoresHTML();
  overlay.classList.add('open');
  const clearBtn = body.querySelector('#btn-clear-scores');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      showConfirm({
        icon:    '🗑',
        title:   '¿BORRAR HISTORIAL?',
        desc:    'Se eliminarán todas las partidas guardadas.',
        okLabel: 'BORRAR TODO',
        onOk:    () => {
          localStorage.removeItem(SCORES_KEY);
          body.innerHTML = `<div class="info-head"><span class="info-dot cyan"></span>PUNTUACIONES</div>` + renderScoresHTML();
        },
      });
    });
  }
}

/* ── INFO MODALS ────────────────────────────────────────────────── */
(function () {
  const overlay = document.getElementById('info-modal-overlay');
  const body    = document.getElementById('info-modal-body');
  const closeBtn= document.getElementById('info-modal-close');

  function openModal(tplId) {
    const tpl = document.getElementById(tplId);
    body.innerHTML = '';
    body.appendChild(tpl.content.cloneNode(true));
    overlay.classList.add('open');
  }

  document.getElementById('btn-info-specs')   .addEventListener('click', () => openModal('tpl-specs'));
  document.getElementById('btn-info-controls').addEventListener('click', () => openModal('tpl-controls'));
  document.getElementById('btn-info-fleet')   .addEventListener('click', () => openModal('tpl-fleet'));
  document.getElementById('btn-info-preview') .addEventListener('click', () => openModal('tpl-preview'));
  document.getElementById('btn-info-scores')  .addEventListener('click', openScoresModal);
  document.getElementById('btn-go-scores')    .addEventListener('click', openScoresModal);

  closeBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.classList.remove('open'); });
}());

/* ── SFX ────────────────────────────────────────────────────────── */
const SFX = (() => {
  let ctx = null;

  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /* Helpers */
  function makeNoise(c, dur, stereo = false) {
    const ch  = stereo ? 2 : 1;
    const buf = c.createBuffer(ch, Math.ceil(c.sampleRate * dur), c.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    return src;
  }

  function makeReverb(c, dur = 1.2, decay = 2) {
    const sr  = c.sampleRate;
    const len = Math.ceil(sr * dur);
    const buf = c.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++)
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    const conv = c.createConvolver();
    conv.buffer = buf;
    return conv;
  }

  function lpf(c, freq, q = 1) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = freq; f.Q.value = q;
    return f;
  }

  function hpf(c, freq) {
    const f = c.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = freq;
    return f;
  }

  function gain(c, v) {
    const g = c.createGain(); g.gain.value = v; return g;
  }

  /* ── MISS: agua — torpedo cae al mar ── */
  function playMiss() {
    const c = getCtx();
    const t = c.currentTime;
    const master = gain(c, 0.7);
    master.connect(c.destination);
    const reverb = makeReverb(c, 0.8, 3);
    reverb.connect(master);

    /* Plop inicial: sine breve descendente */
    const plop = c.createOscillator();
    plop.type = 'sine';
    plop.frequency.setValueAtTime(320, t);
    plop.frequency.exponentialRampToValueAtTime(60, t + 0.08);
    const plopG = gain(c, 0);
    plopG.gain.setValueAtTime(0, t);
    plopG.gain.linearRampToValueAtTime(0.6, t + 0.005);
    plopG.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    plop.connect(plopG); plopG.connect(reverb);
    plop.start(t); plop.stop(t + 0.12);

    /* Burbujeo: ruido bandpass que baja */
    const bubbleNoise = makeNoise(c, 0.45, true);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1200, t);
    bp.frequency.exponentialRampToValueAtTime(180, t + 0.45);
    bp.Q.value = 2.5;
    const bubbleG = gain(c, 0);
    bubbleG.gain.setValueAtTime(0, t);
    bubbleG.gain.linearRampToValueAtTime(0.35, t + 0.01);
    bubbleG.gain.setValueAtTime(0.35, t + 0.05);
    bubbleG.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    bubbleNoise.connect(bp); bp.connect(bubbleG); bubbleG.connect(reverb);
    bubbleNoise.start(t);

    /* Spray suave: ruido highpass tenue */
    const spray = makeNoise(c, 0.3, true);
    const sprayLP = lpf(c, 3500);
    const sprayHP = hpf(c, 2000);
    const sprayG  = gain(c, 0);
    sprayG.gain.setValueAtTime(0, t);
    sprayG.gain.linearRampToValueAtTime(0.15, t + 0.02);
    sprayG.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    spray.connect(sprayHP); sprayHP.connect(sprayLP); sprayLP.connect(sprayG);
    sprayG.connect(master);
    spray.start(t);
  }

  /* ── HIT: impacto — explosión media ── */
  function playHit() {
    const c = getCtx();
    const t = c.currentTime;
    const master = gain(c, 0.85);
    master.connect(c.destination);
    const reverb = makeReverb(c, 1.4, 2.2);
    reverb.connect(master);

    /* Sub-boom: sine grave que cae */
    const sub = c.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(140, t);
    sub.frequency.exponentialRampToValueAtTime(22, t + 0.55);
    const subG = gain(c, 0);
    subG.gain.setValueAtTime(0, t);
    subG.gain.linearRampToValueAtTime(1.0, t + 0.004);
    subG.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    sub.connect(subG); subG.connect(master); subG.connect(reverb);
    sub.start(t); sub.stop(t + 0.6);

    /* Mid boom: sine 2a armónica */
    const mid = c.createOscillator();
    mid.type = 'sine';
    mid.frequency.setValueAtTime(280, t);
    mid.frequency.exponentialRampToValueAtTime(45, t + 0.3);
    const midG = gain(c, 0);
    midG.gain.setValueAtTime(0, t);
    midG.gain.linearRampToValueAtTime(0.5, t + 0.003);
    midG.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    mid.connect(midG); midG.connect(reverb);
    mid.start(t); mid.stop(t + 0.35);

    /* Transiente: crack de ruido con LP */
    const crack = makeNoise(c, 0.06, true);
    const crackLP = lpf(c, 4000);
    const crackG  = gain(c, 0);
    crackG.gain.setValueAtTime(0, t);
    crackG.gain.linearRampToValueAtTime(0.9, t + 0.002);
    crackG.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    crack.connect(crackLP); crackLP.connect(crackG); crackG.connect(master);
    crack.start(t);

    /* Cuerpo: ruido de explosión con LP que baja */
    const body = makeNoise(c, 0.5, true);
    const bodyLP = c.createBiquadFilter();
    bodyLP.type = 'lowpass';
    bodyLP.frequency.setValueAtTime(3500, t);
    bodyLP.frequency.exponentialRampToValueAtTime(300, t + 0.5);
    const bodyG = gain(c, 0);
    bodyG.gain.setValueAtTime(0, t);
    bodyG.gain.linearRampToValueAtTime(0.55, t + 0.005);
    bodyG.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    body.connect(bodyLP); bodyLP.connect(bodyG);
    bodyG.connect(reverb); bodyG.connect(master);
    body.start(t);
  }

  /* ── SUNK: hundido — explosión grande + estructuras ── */
  function playSunk() {
    const c = getCtx();
    const t = c.currentTime;
    const master = gain(c, 0.9);
    master.connect(c.destination);
    const reverb = makeReverb(c, 2.5, 1.6);
    reverb.connect(master);

    /* Sub-boom profundo */
    const sub = c.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(100, t);
    sub.frequency.exponentialRampToValueAtTime(14, t + 1.0);
    const subG = gain(c, 0);
    subG.gain.setValueAtTime(0, t);
    subG.gain.linearRampToValueAtTime(1.2, t + 0.004);
    subG.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
    sub.connect(subG); subG.connect(master); subG.connect(reverb);
    sub.start(t); sub.stop(t + 1.1);

    /* 2do boom ligeramente desfasado */
    const sub2 = c.createOscillator();
    sub2.type = 'sine';
    sub2.frequency.setValueAtTime(60, t + 0.05);
    sub2.frequency.exponentialRampToValueAtTime(18, t + 0.85);
    const sub2G = gain(c, 0);
    sub2G.gain.setValueAtTime(0, t + 0.05);
    sub2G.gain.linearRampToValueAtTime(0.75, t + 0.055);
    sub2G.gain.exponentialRampToValueAtTime(0.001, t + 0.85);
    sub2.connect(sub2G); sub2G.connect(master); sub2G.connect(reverb);
    sub2.start(t + 0.05); sub2.stop(t + 0.9);

    /* Crack inicial fuerte */
    const crack = makeNoise(c, 0.08, true);
    const crackLP = lpf(c, 5000);
    const crackG  = gain(c, 0);
    crackG.gain.setValueAtTime(0, t);
    crackG.gain.linearRampToValueAtTime(1.1, t + 0.002);
    crackG.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    crack.connect(crackLP); crackLP.connect(crackG); crackG.connect(master);
    crack.start(t);

    /* Cuerpo de explosión largo */
    const body = makeNoise(c, 1.2, true);
    const bodyLP = c.createBiquadFilter();
    bodyLP.type = 'lowpass';
    bodyLP.frequency.setValueAtTime(4000, t);
    bodyLP.frequency.exponentialRampToValueAtTime(200, t + 1.2);
    const bodyG = gain(c, 0);
    bodyG.gain.setValueAtTime(0, t);
    bodyG.gain.linearRampToValueAtTime(0.7, t + 0.006);
    bodyG.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
    body.connect(bodyLP); bodyLP.connect(bodyG);
    bodyG.connect(reverb); bodyG.connect(master);
    body.start(t);

    /* Escombros: ruido tenue de alta frecuencia largo */
    const debris = makeNoise(c, 1.8, true);
    const debrisHP = hpf(c, 1500);
    const debrisLP = lpf(c, 6000);
    const debrisG  = gain(c, 0);
    debrisG.gain.setValueAtTime(0, t + 0.05);
    debrisG.gain.linearRampToValueAtTime(0.18, t + 0.12);
    debrisG.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
    debris.connect(debrisHP); debrisHP.connect(debrisLP); debrisLP.connect(debrisG);
    debrisG.connect(reverb);
    debris.start(t + 0.05);
  }

  return { playMiss, playHit, playSunk };
})();

/* ── BACKGROUND MUSIC ───────────────────────────────────────────── */
(function () {
  const music  = document.getElementById('bg-music');
  const btn    = document.getElementById('btn-music');
  let started  = false;
  let muted    = false;

  music.volume = 0.18;

  function tryPlay() {
    if (started) return;
    started = true;
    music.play().catch(() => {});
  }

  /* Start on first user interaction (browser autoplay policy) */
  document.addEventListener('click', tryPlay, { once: true });
  document.addEventListener('keydown', tryPlay, { once: true });

  btn.addEventListener('click', (e) => {
    e.stopPropagation(); /* don't re-trigger tryPlay via document */
    tryPlay();
    muted = !muted;
    music.muted = muted;
    btn.textContent = muted ? '🔇' : '🔊';
    btn.classList.toggle('muted', muted);
  });
}());
