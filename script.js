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
    G.mode === '2p' ? `POSICIONAR FLOTA — JUGADOR ${player}` : 'POSICIONAR FLOTA';
  $('placement-player-badge').textContent =
    G.mode === '2p' ? `JUGADOR ${player}` : 'TU FLOTA';
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
  const atk = G.attacker;
  const def = atk === 1 ? 2 : 1;

  renderBoard(G.boards[def], 'enemy-board', true);  // enemy = hide ships
  renderBoard(G.boards[atk], 'own-board',   false); // own   = show ships

  buildFleetTracker('enemy-fleet-tracker', G.boards[def]);
  buildFleetTracker('own-fleet-tracker',   G.boards[atk]);

  $('enemy-ships-left').textContent = G.boards[def].aliveCount();
  $('own-ships-left').textContent   = G.boards[atk].aliveCount();
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
    ? `JUGADOR ${G.attacker}`
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
      setTimeout(() => showHandoff(), 650);
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

/* ── HANDOFF (2P) ────────────────────────────────────────────────── */
function showHandoff(action = 'battle') {
  G.nextHandoffAction = action;
  const next = G.attacker;
  const prev = next === 1 ? 2 : 1;
  $('handoff-player-name').textContent = `JUGADOR ${next}`;
  $('handoff-desc').innerHTML =
    `El tablero del <strong>Jugador ${prev}</strong> ha sido ocultado.<br/>
     Pulsa cuando el Jugador ${next} esté listo.`;
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
    : `¡Jugador ${winner} Gana!`;
  const desc   = is1P
    ? (isWin
        ? 'Has hundido toda la flota enemiga. ¡Excelente táctica!'
        : 'La IA ha hundido tu flota. Inténtalo de nuevo.')
    : `El Jugador ${winner} ha hundido toda la flota enemiga.`;

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
    
    /* If clicking on placed ship and not in editing mode, select for edit */
    if (c.classList.contains('ship') && G.editingShip === null && !G.selShip) {
      const shipPlacedIndex = +c.dataset.shipPlacedIndex;
      selectShipForEdit(shipPlacedIndex);
    } else {
      placeShip(+c.dataset.row, +c.dataset.col);
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
      setLog(`Turno de Jugador ${G.attacker} — Haz clic para disparar`);
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
    if (!confirm('¿Seguro que quieres rendirte? Perderás la partida.')) return;
    endGame(G.attacker === 1 ? 2 : 1);
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
