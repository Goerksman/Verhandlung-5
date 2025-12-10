/* ========================================================================== */
/* Konfiguration via URL                                                     */
/* ========================================================================== */
const Q = new URLSearchParams(location.search);
const CONFIG = {
  INITIAL_OFFER: Number(Q.get('i')) || 5500,
  MIN_PRICE: Q.has('min') ? Number(Q.get('min')) : undefined,
  MIN_PRICE_FACTOR: Number(Q.get('mf')) || 0.70,
  ACCEPT_MARGIN: Number(Q.get('am')) || 0.12,

  ROUNDS_MIN: parseInt(Q.get('rmin') || '8', 10),
  ROUNDS_MAX: parseInt(Q.get('rmax') || '12', 10),

  THINK_DELAY_MS_MIN: parseInt(Q.get('tmin') || '1200', 10),
  THINK_DELAY_MS_MAX: parseInt(Q.get('tmax') || '2800', 10),

  ACCEPT_RANGE_MIN: Number(Q.get('armin')) || 4700,
  ACCEPT_RANGE_MAX: Number(Q.get('armax')) || 4800
};
CONFIG.MIN_PRICE = Number.isFinite(CONFIG.MIN_PRICE)
  ? CONFIG.MIN_PRICE
  : Math.round(CONFIG.INITIAL_OFFER * CONFIG.MIN_PRICE_FACTOR);

/* ========================================================================== */
/* Spieler-ID / Probandencode initialisieren                                  */
/* ========================================================================== */
if (!window.playerId) {
  const fromUrl =
    Q.get('player_id') ||
    Q.get('playerId') ||
    Q.get('pid') ||
    Q.get('id');
  window.playerId = fromUrl || ('P_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
}

if (!window.probandCode) {
  const fromUrlCode =
    Q.get('proband_code') ||
    Q.get('probandCode') ||
    Q.get('code');
  window.probandCode = fromUrlCode || window.playerId;
}

/* ========================================================================== */
/* Konstanten                                                                 */
/* ========================================================================== */
const UNACCEPTABLE_LIMIT = 2250;
const EXTREME_BASE = 1500;
const ABSOLUTE_FLOOR = 3500;

const DIMENSION_FACTORS = [1.0, 1.3, 1.5];
let dimensionQueue = [];
function refillDimensionQueue() {
  dimensionQueue = [...DIMENSION_FACTORS];
  for (let i = dimensionQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [dimensionQueue[i], dimensionQueue[j]] = [dimensionQueue[j], dimensionQueue[i]];
  }
}
function nextDimensionFactor() {
  if (dimensionQueue.length === 0) refillDimensionQueue();
  return dimensionQueue.pop();
}

const app = document.getElementById('app');
const randInt = (a,b) => Math.floor(a + Math.random()*(b-a+1));
const eur = n => new Intl.NumberFormat('de-DE', {style:'currency', currency:'EUR'}).format(n);
const roundToNearest50 = v => Math.round(v / 50) * 50;

/* ========================================================================== */
/* Zustand                                                                    */
/* ========================================================================== */
function newState() {
  const factor = nextDimensionFactor();

  const floorRaw  = ABSOLUTE_FLOOR * factor;
  const offer     = roundToNearest50(floorRaw);

  return {
    participant_id: crypto.randomUUID?.() || ('x_'+Date.now()+Math.random().toString(36).slice(2)),
    runde: 1,
    max_runden: randInt(CONFIG.ROUNDS_MIN, CONFIG.ROUNDS_MAX),

    scale_factor: factor,

    min_price: offer,
    max_price: offer,
    initial_offer: offer,
    current_offer: offer,

    history: [],
    last_concession: null,

    finished: false,
    accepted: false,

    patternMessage: '',
    deal_price: null,
    finish_reason: null,

    last_abort_chance: null
  };
}
let state = newState();

/* ========================================================================== */
/* Logging                                                                    */
/* ========================================================================== */
function logRound(row) {
  const payload = {
    participant_id: state.participant_id,
    player_id: window.playerId,
    proband_code: window.probandCode,

    scale_factor: state.scale_factor,

    runde: row.runde,
    algo_offer: row.algo_offer,
    proband_counter: row.proband_counter,
    accepted: row.accepted,
    finished: row.finished,
    deal_price: row.deal_price
  };
  if (window.sendRow) window.sendRow(payload);
  else console.log('[sendRow fallback]', payload);
}

/* ========================================================================== */
/* Auto-Accept                                                                */
/* ========================================================================== */
function shouldAutoAccept(initialOffer, minPrice, prevOffer, counter) {
  const c = Number(counter);
  if (!Number.isFinite(c)) return false;

  const f = state.scale_factor;

  if (Math.abs(prevOffer - c) <= prevOffer * 0.05) return true;

  const accMin = CONFIG.ACCEPT_RANGE_MIN * f;
  const accMax = CONFIG.ACCEPT_RANGE_MAX * f;
  if (c >= accMin && c <= accMax) return true;

  const threshold = Math.max(minPrice, initialOffer * (1 - CONFIG.ACCEPT_MARGIN));
  return c >= threshold;
}

/* ========================================================================== */
/* Abbruchwahrscheinlichkeit – Modell A                                       */
/* ========================================================================== */
function abortProbability(userOffer) {
  const f = state.scale_factor;
  const seller = state.current_offer;
  const buyer = Number(userOffer);
  const diff = Math.abs(seller - buyer);

  if (diff >= 1000 * f) return 40;
  if (diff >= 750  * f) return 30;
  if (diff >= 500  * f) return 20;
  if (diff >= 250  * f) return 10;
  if (diff >= 100  * f) return 5;

  return 0;
}

function maybeAbort(userOffer) {
  const f = state.scale_factor;
  const val = Number(userOffer);

  if (val < 1500 * f) {
    state.last_abort_chance = 100;

    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: val,
      accepted: false,
      finished: true,
      deal_price: ""
    });

    state.finished = true;
    state.accepted = false;
    state.finish_reason = 'abort';
    viewAbort(100);
    return true;
  }

  const chance = abortProbability(val);
  state.last_abort_chance = chance;

  if (randInt(1,100) <= chance) {

    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: val,
      accepted: false,
      finished: true,
      deal_price: ""
    });

    state.finished = true;
    state.accepted = false;
    state.finish_reason = 'abort';
    viewAbort(chance);
    return true;
  }
  return false;
}

/* ========================================================================== */
/* Mustererkennung                                                            */
/* ========================================================================== */
function getThresholdForAmount(prev) {
  const f = state.scale_factor;

  const A = 2250 * f;
  const B = 3000 * f;
  const C = 4000 * f;
  const D = 5000 * f;

  if (prev >= A && prev < B) return 0.05;
  if (prev >= B && prev < C) return 0.04;
  if (prev >= C && prev < D) return 0.03;
  return null;
}

function updatePatternMessage(){
  const f = state.scale_factor;
  const limit = UNACCEPTABLE_LIMIT * f;

  const counters = state.history
    .map(h => h.proband_counter)
    .filter(v => v && v >= limit);

  if (counters.length < 3) {
    state.patternMessage = '';
    return;
  }

  let chain = 1;
  for (let i = 1; i < counters.length; i++) {
    const diff = counters[i] - counters[i - 1];
    if (diff < 0) { chain = 1; continue; }

    const threshold = getThresholdForAmount(counters[i - 1]);
    if (threshold && diff <= counters[i - 1] * threshold) chain++;
    else chain = 1;
  }

  state.patternMessage =
    chain >= 3
      ? "Mit solchen kleinen Erhöhungen wird das schwierig. Geh bitte ein Stück näher an deine Schmerzgrenze."
      : "";
}

/* ========================================================================== */
/* Angebotslogik – Verkäufer bewegt sich nicht                               */
/* ========================================================================== */
function computeNextOffer(prevOffer, minPrice) {
  return Math.max(minPrice, prevOffer);
}

/* ========================================================================== */
/* Screens                                                                    */
/* ========================================================================== */
function historyTable(){
  if (!state.history.length) return '';
  return `
    <h2>Verlauf</h2>
    <table>
      <thead><tr>
        <th>Runde</th><th>Angebot Verkäufer</th><th>Gegenangebot</th><th>Ang.</th>
      </tr></thead>
      <tbody>
        ${state.history.map(h => `
          <tr>
            <td>${h.runde}</td>
            <td>${eur(h.algo_offer)}</td>
            <td>${h.proband_counter != null ? eur(h.proband_counter) : '-'}</td>
            <td>${h.accepted ? 'Ja' : 'Nein'}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function viewAbort(chance){
  app.innerHTML = `
    <h1>Verhandlung abgebrochen</h1>
    <p>Abbruchwahrscheinlichkeit in dieser Runde: <b>${chance}%</b></p>
    <button id="restartBtn">Neue Verhandlung</button>
    ${historyTable()}
  `;
  document.getElementById('restartBtn').onclick = () => { state = newState(); viewVignette(); };
}

function viewVignette() {
  app.innerHTML = `
    <h1>Designer-Verkaufsmesse</h1>
    <label class="consent">
      <input id="consent" type="checkbox">
      <span>Ich stimme der anonymen Speicherung zu.</span>
    </label>
    <button id="startBtn" disabled>Starten</button>
  `;

  const c = document.getElementById("consent");
  const b = document.getElementById("startBtn");
  c.onchange = () => b.disabled = !c.checked;
  b.onclick = () => { state = newState(); viewNegotiate(); };
}

function updateAbortUI(ch) {
  const box = document.getElementById("abortBoxValue");
  if (box) box.textContent = ch + "%";
}

function viewNegotiate(errorMsg){
  const abortChance = state.last_abort_chance ?? "--";

  app.innerHTML = `
    <h1>Verkaufsverhandlung</h1>

    <div class="card">
      <strong>Aktuelles Angebot:</strong> ${eur(state.current_offer)}
    </div>

    <div class="card" style="border-left:6px solid #444;">
      <b>Abbruchwahrscheinlichkeit:</b>
      <span id="abortBoxValue">${abortChance}%</span>
    </div>

    <label>Dein Gegenangebot:</label>
    <input id="counter" type="number">

    <button id="sendBtn">Senden</button>
    <button id="acceptBtn" class="ghost">Annehmen</button>

    ${state.patternMessage ? `<p>${state.patternMessage}</p>` : ''}
    ${errorMsg ? `<p style="color:red">${errorMsg}</p>` : ''}

    ${historyTable()}
  `;

  const inputEl = document.getElementById("counter");
  inputEl.oninput = () => {
    const f = state.scale_factor;
    let val = Number(inputEl.value);

    if (!inputEl.value.trim()) {
      updateAbortUI(state.last_abort_chance ?? 0);
      return;
    }

    if (val < 1500 * f) {
      updateAbortUI(100);
      return;
    }

    updateAbortUI(abortProbability(val));
  };

  document.getElementById("sendBtn").onclick =
    () => handleSubmit(document.getElementById("counter").value);

  document.getElementById("acceptBtn").onclick = () => finish(true, state.current_offer);
}

/* ========================================================================== */
/* Handle Submit                                                              */
/* ========================================================================== */
function handleSubmit(raw){
  const num = Number(raw);
  const prev = state.current_offer;
  const f = state.scale_factor;

  if (!Number.isFinite(num) || num < 0)
    return viewNegotiate("Bitte eine gültige Zahl eingeben.");

  if (shouldAutoAccept(state.initial_offer, state.min_price, prev, num)) {
    finish(true, num);
    return;
  }

  if (maybeAbort(num)) return;

  logRound({
    runde: state.runde,
    algo_offer: prev,
    proband_counter: num,
    accepted: false,
    finished: false,
    deal_price: ""
  });

  state.history.push({ runde: state.runde, algo_offer: prev, proband_counter: num, accepted: false });

  updatePatternMessage();

  state.current_offer = computeNextOffer(prev, state.min_price);
  state.runde++;

  if (state.runde > state.max_runden)
    return viewDecision();

  viewNegotiate();
}

/* ========================================================================== */
/* Entscheidung – letzte Runde                                                */
/* ========================================================================== */
function viewDecision(){
  app.innerHTML = `
    <h1>Letzte Runde</h1>
    <p>Letztes Angebot: ${eur(state.current_offer)}</p>

    <button id="takeBtn">Annehmen</button>
    <button id="declineBtn" class="ghost">Ablehnen</button>

    ${historyTable()}
  `;

  document.getElementById("takeBtn").onclick =
    () => finish(true, state.current_offer);

  document.getElementById("declineBtn").onclick =
    () => finish(false, null);
}

/* ========================================================================== */
/* Finish                                                                     */
/* ========================================================================== */
function finish(accepted, dealPrice){
  state.accepted = accepted;
  state.finished = true;
  state.deal_price = dealPrice;

  logRound({
    runde: state.runde,
    algo_offer: state.current_offer,
    proband_counter: dealPrice,
    accepted,
    finished: true,
    deal_price: dealPrice
  });

  app.innerHTML = `
    <h1>Verhandlung beendet</h1>
    <p>${accepted ? "Einigung bei " + eur(dealPrice) : "Keine Einigung."}</p>

    ${historyTable()}
    <button id="restartBtn">Neu starten</button>
  `;

  document.getElementById("restartBtn").onclick = () => {
    state = newState();
    viewVignette();
  };
}

/* ========================================================================== */
/* Start                                                                      */
/* ========================================================================== */
viewVignette();
