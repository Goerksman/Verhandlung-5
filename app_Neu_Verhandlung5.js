/* ========================================================================== */
/* Konfiguration via URL                                                     */
/* ========================================================================== */
const Q = new URLSearchParams(location.search);
const CONFIG = {
  INITIAL_OFFER: Number(Q.get('i')) || 5500,
  MIN_PRICE: Q.has('min') ? Number(Q.get('min')) : undefined,
  MIN_PRICE_FACTOR: Number(Q.get('mf')) || 0.70,
  ROUNDS_MIN: parseInt(Q.get('rmin') || '8', 10),
  ROUNDS_MAX: parseInt(Q.get('rmax') || '12', 10),
  THINK_DELAY_MS_MIN: parseInt(Q.get('tmin') || '1200', 10),
  THINK_DELAY_MS_MAX: parseInt(Q.get('tmax') || '2800', 10),
  ACCEPT_MARGIN: Number(Q.get('am')) || 0.12,
  ACCEPT_RANGE_MIN: Number(Q.get('armin')) || 4700,
  ACCEPT_RANGE_MAX: Number(Q.get('armax')) || 4800
};
CONFIG.MIN_PRICE = Number.isFinite(CONFIG.MIN_PRICE)
  ? CONFIG.MIN_PRICE
  : Math.round(CONFIG.INITIAL_OFFER * CONFIG.MIN_PRICE_FACTOR);

/* ========================================================================== */
/* Spieler-ID / Probandencode initialisieren                                 */
/* ========================================================================== */
if (!window.playerId) {
  const fromUrl =
    Q.get('player_id') ||
    Q.get('playerId') ||
    Q.get('pid') ||
    Q.get('id');

  window.playerId =
    fromUrl || ('P_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
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
const EXTREME_BASE       = 1500;
const ABSOLUTE_FLOOR     = 3500;
const BASE_INITIAL_OFFER = CONFIG.INITIAL_OFFER;
const BASE_MIN_PRICE     = CONFIG.MIN_PRICE;
const BASE_STEP_AMOUNT   = 0;

/*
   Verhandlungs-Dimensionen (Multiplikatoren):
   1x, 2x, 3x, 4x, 5x
*/
const DIMENSION_FACTORS = [1, 2, 3, 4, 5];
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

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */
const app = document.getElementById('app');
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const eur = n =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(
    Math.round(Number(n))
  );

/* ========================================================================== */
/* Zustand                                                                    */
/* ========================================================================== */
function newState() {
  const factor  = nextDimensionFactor();
  const floorRaw = ABSOLUTE_FLOOR * factor;
  const offer    = Math.round(floorRaw);   // keine 50er-Rundung mehr

  return {
    participant_id: crypto.randomUUID?.() || ('x_' + Date.now() + Math.random().toString(36).slice(2)),
    runde: 1,
    max_runden: randInt(CONFIG.ROUNDS_MIN, CONFIG.ROUNDS_MAX),
    scale_factor: factor,

    min_price: offer,
    max_price: offer,
    initial_offer: offer,
    current_offer: offer,

    step_amount: BASE_STEP_AMOUNT * factor,
    last_concession: null,

    history: [],
    patternMessage: '',
    warningRounds: 0,   // wie viele Runden nacheinander der Warnhinweis aktiv war
    finished: false,
    accepted: false,
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

    // Exit-Flags
    proband_exit: row.proband_exit ?? '',
    algo_exit: row.algo_exit ?? '',

    deal_price: row.deal_price
  };

  if (window.sendRow) window.sendRow(payload);
  else console.log('[sendRow fallback]', payload);
}

/* ========================================================================== */
/* Auto-Accept (Verhandlungsstil)                                            */
/* ========================================================================== */
function shouldAutoAccept(initialOffer, minPrice, prevOffer, counter) {
  const c = Number(counter);
  if (!Number.isFinite(c)) return false;

  const f = state.scale_factor || 1.0;

  // sehr nah am aktuellen Angebot (±5 %)
  if (Math.abs(prevOffer - c) <= prevOffer * 0.05) return true;

  // Angebotsbereich [ACCEPT_RANGE_MIN*f, ACCEPT_RANGE_MAX*f]
  const accMin = CONFIG.ACCEPT_RANGE_MIN * f;
  const accMax = CONFIG.ACCEPT_RANGE_MAX * f;
  if (c >= accMin && c <= accMax) return true;

  // nahe an der Mindestgrenze (unter Berücksichtigung der Marge)
  const margin = CONFIG.ACCEPT_MARGIN;
  const threshold = Math.max(minPrice, initialOffer * (1 - margin));
  return c >= threshold;
}

/* ========================================================================== */
/* Abbruchwahrscheinlichkeit: Diff 3000 * Multiplikator → 25 %               */
/* ========================================================================== */
function abortProbability(userOffer) {
  const seller = state.current_offer;
  const buyer  = Number(userOffer);
  const f      = state.scale_factor || 1.0;

  if (!Number.isFinite(buyer)) return 0;

  // Extrem-Lowball-Basisrisiko (für Anzeige),
  // tatsächlicher Abbruch ist durch maybeAbort (Rundengrenze) geregelt
  if (buyer < EXTREME_BASE * f) return 100;

  const diff = Math.abs(seller - buyer);

  const BASE_DIFF = 3000 * f;   // bei dieser Differenz sollen 25 % entstehen
  let chance = (diff / BASE_DIFF) * 25;

  if (chance < 0)   chance = 0;
  if (chance > 100) chance = 100;

  return Math.round(chance);
}

/* ========================================================================== */
/* Mustererkennung + Warnhinweis-Steuerung                                   */
/* ========================================================================== */
function updatePatternMessage(currentBuyerOffer) {
  const f           = state.scale_factor || 1.0;
  const limit       = 2250 * f;          // relevante Offerschwelle
  const SMALL_STEP  = 100 * f;          // 100 × Multiplikator

  const counters = [];

  // Bisherige relevanten Gegenangebote sammeln
  for (let h of state.history) {
    let c = h.proband_counter;
    if (c == null || c === '') continue;
    c = Number(c);
    if (!Number.isFinite(c)) continue;
    if (c < limit) continue;
    counters.push(c);
  }

  // aktuelles Angebot berücksichtigen
  if (currentBuyerOffer != null) {
    const cNow = Number(currentBuyerOffer);
    if (Number.isFinite(cNow) && cNow >= limit) {
      counters.push(cNow);
    }
  }

  if (counters.length < 2) {
    state.patternMessage = '';
    state.warningRounds = 0;
    return;
  }

  let chain = 1;
  for (let i = 1; i < counters.length; i++) {
    const prev = counters[i - 1];
    const curr = counters[i];
    const diff = curr - prev;

    if (diff < 0) {
      chain = 1;
      continue;
    }

    // kleiner Schritt: kein Unterschied oder Erhöhung ≤ 100 × Multiplikator
    if (diff === 0 || (diff > 0 && diff <= SMALL_STEP)) {
      chain++;
    } else {
      chain = 1;
    }
  }

  const wasActive = state.warningRounds > 0;

  if (chain >= 2) {
    // Muster aktiv
    if (wasActive) {
      state.warningRounds = (state.warningRounds || 0) + 1;
    } else {
      state.warningRounds = 1;
    }
    state.patternMessage =
      'Mit derart kleinen Erhöhungen kommen wir eher unwahrscheinlich zu einer Einigung.';
  } else {
    state.patternMessage = '';
    state.warningRounds = 0;
  }
}

/* ========================================================================== */
/* Angebotslogik – unverändert (kein Nachgeben)                              */
/* ========================================================================== */
function computeNextOffer(prevOffer, minPrice) {
  return Math.max(minPrice, prevOffer);
}

/* ========================================================================== */
/* Abbruchentscheidung mit Rundengrenze + Warnbonus                          */
/*  - kein Abbruch vor Runde 3                                               */
/*  - Basischance aus Differenz (3000*f → 25 %)                              */
/*  - +2 %-Punkte pro Warnrunde, solange Warnung aktiv ist                   */
/* ========================================================================== */
function maybeAbort(userOffer) {
  const buyer = Number(userOffer);

  // Basischance aus Differenz und Extrem-Lowball
  let chance = abortProbability(userOffer);

  // Zusatzanteil durch Warnung: +2 % je Warnrunde
  if (state.warningRounds && state.warningRounds > 0) {
    chance = Math.min(100, chance + state.warningRounds * 2);
  }

  state.last_abort_chance = chance;

  // Kein Abbruch vor Runde 3 – nur Anzeige
  if (state.runde < 3) {
    return false;
  }

  const roll = randInt(1, 100);

  if (roll <= chance) {
    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: userOffer,
      accepted: false,
      finished: true,
      proband_exit: '',
      algo_exit: 'yes',
      deal_price: ''
    });

    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: userOffer,
      accepted: false
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
/* Rendering                                                                  */
/* ========================================================================== */

function viewVignette() {
  app.innerHTML = `
    <h1>Designer-Verkaufsmesse</h1>
    <p class="muted">Stelle dir folgende Situation vor:</p>
    <p>
      Ein Verkäufer bietet eine <b>hochwertige Designer-Ledercouch</b> auf einer Möbelmesse an.
      Solche Möbel werden üblicherweise im <b>gehobenen Preissegment €</b> gehandelt, da sie aus wertvollem 
      Material bestehen und in der Regel Einzelstücke sind. Den Rahmen des Preises siehst du in der Verhandlung. 
    </p>
    <p>
      Du verhandelst mit dem Verkäufer über den endgültigen Verkaufspreis. 
    </p>
    <p class="muted"> 
      <b>Hinweis:</b> Die Verhandlung dauert zufällig ${CONFIG.ROUNDS_MIN}–${CONFIG.ROUNDS_MAX} Runden.
      Dein Verhalten beeinflusst das <b>Abbruchrisiko</b>: unangemessen niedrige oder kaum veränderte
      Angebote können zu einem vorzeitigen Abbruch führen.
    </p>
    <div class="grid">
      <label class="consent">
        <input id="consent" type="checkbox" />
        <span>Ich stimme zu, dass meine Eingaben anonym gespeichert werden.</span>
      </label>
      <div><button id="startBtn" disabled>Verhandlung starten</button></div>
    </div>`;

  document.getElementById('consent').onchange =
    () => document.getElementById('startBtn').disabled =
      !document.getElementById('consent').checked;

  document.getElementById('startBtn').onclick = () => {
    state = newState();
    viewNegotiate();
  };
}

function viewThink(next) {
  const delay = randInt(CONFIG.THINK_DELAY_MS_MIN, CONFIG.THINK_DELAY_MS_MAX);
  app.innerHTML = `
    <h1>Die Verkäuferseite überlegt<span class="pulse">…</span></h1>
    <p class="muted">Bitte warten.</p>
  `;
  setTimeout(next, delay);
}

function historyTable() {
  if (!state.history.length) return '';
  const rows = state.history
    .map(h => `
      <tr>
        <td>${h.runde}</td>
        <td>${eur(h.algo_offer)}</td>
        <td>${h.proband_counter != null && h.proband_counter !== '' ? eur(h.proband_counter) : '-'}</td>
        <td>${h.accepted ? 'Ja' : 'Nein'}</td>
      </tr>
    `)
    .join('');

  return `
    <h2>Verlauf</h2>
    <table>
      <thead>
        <tr><th>Runde</th><th>Angebot Verkäufer</th><th>Gegenangebot</th><th>Angenommen?</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/* ========================================================================== */
/* Abbruch-Screen (Algo)                                                     */
/* ========================================================================== */
function viewAbort(chance) {
  app.innerHTML = `
    <h1>Verhandlung abgebrochen</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Die Verkäuferseite hat die Verhandlung beendet, da er mit Ihrem Gegenangebot nicht zufrieden war.</strong>
      <p class="muted">Abbruchwahrscheinlichkeit in dieser Runde: ${chance}%</p>
    </div>

    <p><b>Du kannst nun entweder eine neue Runde spielen oder die Umfrage beantworten.</b></p>

    <button id="restartBtn">Neue Verhandlung</button>
    <button id="surveyBtn"
      style="
        margin-top:8px;
        display:inline-block;
        padding:8px 14px;
        border-radius:9999px;
        border:1px solid #d1d5db;
        background:#e5e7eb;
        color:#374151;
        font-size:0.95rem;
        cursor:pointer;
      ">
      Zur Umfrage
    </button>

    ${historyTable()}
  `;

  document.getElementById('restartBtn').onclick = () => {
    state = newState();
    viewVignette();
  };

  const surveyBtn = document.getElementById('surveyBtn');
  if (surveyBtn) {
    surveyBtn.onclick = () => {
      window.location.href =
        'https://docs.google.com/forms/d/e/1FAIpQLSdwa6nkhEkT6tMBedmWgaGSgvUWamDJpqRQLGdp7vkjS0Hb7g/viewform?usp=publish-editor';
    };
  }
}

/* ========================================================================== */
/* Abbruch-Screen (Proband)                                                  */
/* ========================================================================== */
function viewProbandAbort() {
  app.innerHTML = `
    <h1>Verhandlung abgebrochen</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Du hast die Verhandlung beendet.</strong>
      <p class="muted">Es wurde keine Einigung erzielt.</p>
    </div>

    <p><b>Du kannst nun entweder eine neue Runde spielen oder die Umfrage beantworten.</b></p>

    <button id="restartBtn">Neue Verhandlung</button>
    <button id="surveyBtn"
      style="
        margin-top:8px;
        display:inline-block;
        padding:8px 14px;
        border-radius:9999px;
        border:1px solid #d1d5db;
        background:#e5e7eb;
        color:#374151;
        font-size:0.95rem;
        cursor:pointer;
      ">
      Zur Umfrage
    </button>

    ${historyTable()}
  `;

  document.getElementById('restartBtn').onclick = () => {
    state = newState();
    viewVignette();
  };

  const surveyBtn = document.getElementById('surveyBtn');
  if (surveyBtn) {
    surveyBtn.onclick = () => {
      window.location.href =
        'https://docs.google.com/forms/d/e/1FAIpQLSdwa6nkhEkT6tMBedmWgaGSgvUWamDJpqRQLGdp7vkjS0Hb7g/viewform?usp=publish-editor';
    };
  }
}

/* ========================================================================== */
/* Hauptscreen der Verhandlung (Risikoanzeige inkl. Pattern-Effekt)          */
/* ========================================================================== */

function viewNegotiate(errorMsg) {
  let displayBuyer;
  const last = state.history[state.history.length - 1];

  if (last && last.proband_counter != null && last.proband_counter !== '') {
    displayBuyer = Number(last.proband_counter);
  } else {
    displayBuyer = state.current_offer;
  }

  // Basischance für Anzeige
  let abortChance = abortProbability(displayBuyer);

  // +2 %-Punkte je Warnrunde
  if (state.warningRounds && state.warningRounds > 0) {
    abortChance = Math.min(100, abortChance + state.warningRounds * 2);
  }

  state.last_abort_chance = abortChance;

  // Farbskala: ≤20% grün, >20–40% orange, >40% rot
  let color = '#16a34a'; // grün
  if (abortChance > 40) {
    color = '#dc2626'; // rot
  } else if (abortChance > 20) {
    color = '#f97316'; // orange
  }

  app.innerHTML = `
    <h1>Verkaufsverhandlung</h1>
    <p class="muted">Spieler-ID: ${window.playerId ?? '-'}</p>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="grid">

      <div class="card" style="padding:16px;border:1px dashed var(--accent);">
        <strong>Aktuelles Angebot:</strong> ${eur(state.current_offer)}
      </div>

      <div style="
        background:${color}22;
        border-left:6px solid ${color};
        padding:10px;
        border-radius:8px;
        margin-bottom:10px;">
        <b style="color:${color};">Abbruchwahrscheinlichkeit:</b>
        <span style="color:${color}; font-weight:600;">
          ${abortChance}%
        </span>
      </div>

      ${state.patternMessage ? `<p class="info">${state.patternMessage}</p>` : ''}

      <label for="counter">Dein Gegenangebot (€)</label>
      <div class="row">
        <input id="counter" type="number" step="0.01" min="0" />
        <button id="sendBtn">Gegenangebot senden</button>
      </div>

      <div class="row">
        <button id="acceptBtn" class="ghost">Angebot annehmen</button>
        <button id="abortBtn"
          style="
            background:#e5e7eb;
            color:#374151;
            border:1px solid #d1d5db;
          ">
          Verhandlung abbrechen
        </button>
      </div>
    </div>

    ${historyTable()}
    ${errorMsg ? `<p class="error">${errorMsg}</p>` : ''}
  `;

  const inputEl = document.getElementById('counter');
  inputEl.onkeydown = e => { if (e.key === 'Enter') handleSubmit(inputEl.value); };
  document.getElementById('sendBtn').onclick = () => handleSubmit(inputEl.value);

  document.getElementById('acceptBtn').onclick = () => {
    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted: true
    });

    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: true,
      finished: true,
      proband_exit: '',
      algo_exit: '',
      deal_price: state.current_offer
    });

    state.accepted = true;
    state.finished = true;
    state.deal_price = state.current_offer;

    viewThink(() => viewFinish(true));
  };

  // Proband bricht ab
  document.getElementById('abortBtn').onclick = () => {
    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted: false
    });

    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: false,
      finished: true,
      proband_exit: 'yes',
      algo_exit: '',
      deal_price: ''
    });

    state.finished = true;
    state.accepted = false;
    state.deal_price = null;
    state.finish_reason = 'proband_abort';

    viewThink(() => viewProbandAbort());
  };
}

/* ========================================================================== */
/* Handle Submit                                                              */
/* ========================================================================== */
function handleSubmit(raw) {
  const val = String(raw ?? '').trim().replace(',', '.');
  const num = Number(val);

  if (!Number.isFinite(num) || num < 0) {
    return viewNegotiate('Bitte eine gültige Zahl ≥ 0 eingeben.');
  }

  const prevOffer = state.current_offer;

  // keine niedrigeren Angebote als in der Vorrunde erlauben
  const last = state.history[state.history.length - 1];
  if (last && last.proband_counter != null && last.proband_counter !== '') {
    const lastBuyer = Number(last.proband_counter);
    if (Number.isFinite(lastBuyer) && num < lastBuyer) {
      return viewNegotiate(
        `Dein Gegenangebot darf nicht niedriger sein als in der Vorrunde (${eur(lastBuyer)}).`
      );
    }
  }

  // Auto-Accept (Verhandlungsstil)
  if (shouldAutoAccept(state.initial_offer, state.min_price, prevOffer, num)) {
    state.history.push({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: true
    });

    logRound({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: true,
      finished: true,
      proband_exit: '',
      algo_exit: '',
      deal_price: num
    });

    state.accepted = true;
    state.finished = true;
    state.deal_price = num;

    return viewThink(() => viewFinish(true));
  }

  // Pattern-/Warnzustand mit dem aktuellen Angebot aktualisieren
  updatePatternMessage(num);

  // Abbruchentscheidung (inkl. Warnbonus; ab Runde 3 wirksam)
  if (maybeAbort(num)) return;

  // Normale Runde: Verhandlungsstil – kein Preisnachlass
  const next = computeNextOffer(prevOffer, state.min_price);
  const concession = prevOffer - next;

  logRound({
    runde: state.runde,
    algo_offer: prevOffer,
    proband_counter: num,
    accepted: false,
    finished: false,
    proband_exit: '',
    algo_exit: '',
    deal_price: ''
  });

  state.history.push({
    runde: state.runde,
    algo_offer: prevOffer,
    proband_counter: num,
    accepted: false
  });

  state.current_offer = next;
  state.last_concession = concession;

  if (state.runde >= state.max_runden) {
    state.finished = true;
    state.finish_reason = 'max_rounds';
    return viewThink(() => viewDecision());
  }

  state.runde++;
  viewThink(() => viewNegotiate());
}

/* ========================================================================== */
/* Entscheidung – letzte Runde                                                */
/* ========================================================================== */
function viewDecision() {
  app.innerHTML = `
    <h1>Letzte Runde</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Letztes Angebot:</strong> ${eur(state.current_offer)}</strong>
    </div>

    <button id="takeBtn">Annehmen</button>
    <button id="noBtn" class="ghost">Ablehnen</button>

    ${historyTable()}
  `;

  document.getElementById('takeBtn').onclick = () => {
    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted:true
    });

    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: true,
      finished: true,
      proband_exit: '',
      algo_exit: '',
      deal_price: state.current_offer
    });

    state.accepted = true;
    state.finished = true;
    state.deal_price = state.current_offer;

    viewThink(() => viewFinish(true));
  };

  document.getElementById('noBtn').onclick = () => {
    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted:false
    });

    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: '',
      accepted: false,
      finished: true,
      proband_exit: '',
      algo_exit: '',
      deal_price: ''
    });

    state.finished = true;
    state.accepted = false;
    state.finish_reason = 'max_rounds';

    viewThink(() => viewFinish(false));
  };
}

/* ========================================================================== */
/* Finish-Screen                                                              */
/* ========================================================================== */
function viewFinish(accepted) {
  const dealPrice = state.deal_price ?? state.current_offer;

  let text;
  if (accepted) {
    text = `Einigung in Runde ${state.runde} bei ${eur(dealPrice)}.`;
  } else if (state.finish_reason === 'abort') {
    text = `Verhandlung vom Verkäufer abgebrochen.`;
  } else if (state.finish_reason === 'proband_abort') {
    text = `Verhandlung von dir abgebrochen.`;
  } else {
    text = `Maximale Runden erreicht.`;
  }

  app.innerHTML = `
    <h1>Verhandlung abgeschlossen</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Ergebnis:</strong> ${text}</strong>
    </div>

    <p><b>Du kannst nun entweder eine neue Runde spielen oder die Umfrage beantworten.</b></p>

    <button id="restartBtn">Neue Verhandlung</button>
    <button id="surveyBtn"
      style="
        margin-top:8px;
        display:inline-block;
        padding:8px 14px;
        border-radius:9999px;
        border:1px solid #d1d5db;
        background:#e5e7eb;
        color:#374151;
        font-size:0.95rem;
        cursor:pointer;
      ">
      Zur Umfrage
    </button>

    ${historyTable()}
  `;

  document.getElementById('restartBtn').onclick = () => {
    state = newState();
    viewVignette();
  };

  const surveyBtn = document.getElementById('surveyBtn');
  if (surveyBtn) {
    surveyBtn.onclick = () => {
      window.location.href =
        'https://docs.google.com/forms/d/e/1FAIpQLSdwa6nkhEkT6tMBedmWgaGSgvUWamDJpqRQLGdp7vkjS0Hb7g/viewform?usp=publish-editor';
    };
  }
}

/* ========================================================================== */
/* Start                                                                      */
/* ========================================================================== */
viewVignette();
