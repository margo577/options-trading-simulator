const storageKey = 'options_trading_static_workflow_v1';

const scenarios = [
  { code: 'SCN-A', label: 'Scenario A', description: 'Moderately bullish market with volatility rising later.', underlying: 'ABC plc', spot: 100, rate: 0.03, vol: 0.24, daysToExpiry: 42, contractSize: 100, startingCash: 20000, maxTrades: 10, strikes: [85,90,95,100,105,110,115] },
  { code: 'SCN-B', label: 'Scenario B', description: 'Softer market with mixed spot moves and shifting volatility.', underlying: 'XYZ plc', spot: 92, rate: 0.025, vol: 0.22, daysToExpiry: 35, contractSize: 100, startingCash: 20000, maxTrades: 10, strikes: [75,80,85,90,95,100,105] },
  { code: 'SCN-C', label: 'Scenario C', description: 'Higher-volatility environment testing response to volatility shocks.', underlying: 'QRS plc', spot: 108, rate: 0.035, vol: 0.30, daysToExpiry: 30, contractSize: 100, startingCash: 20000, maxTrades: 10, strikes: [90,95,100,105,110,115,120] }
];

const state = {
  student: { name: '', number: '' },
  mode: 'practice',
  screen: 'dashboard',
  savedSessions: [],
  selectedFinalIds: [],
  finalSubmitted: false,
  activeScenarioCode: scenarios[0].code,
  current: null,
};

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
function formatMoney(x) { return new Intl.NumberFormat('en-GB', { style:'currency', currency:'GBP', maximumFractionDigits: 2 }).format(x || 0); }
function formatNum(x, d=2) { return Number(x || 0).toFixed(d); }
function csvEscape(value) { const s = String(value ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; }

function normCdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * absX);
  const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
  return 0.5 * (1 + sign * erf);
}

function blackScholes({ S, K, T, r, sigma, type }) {
  if (T <= 0) {
    const intrinsic = type === 'call' ? Math.max(S-K, 0) : Math.max(K-S, 0);
    return { price: intrinsic, delta: 0, gamma: 0, theta: 0, vega: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S/K) + (r + 0.5*sigma*sigma)*T) / (sigma*sqrtT);
  const d2 = d1 - sigma*sqrtT;
  const callPrice = S*normCdf(d1) - K*Math.exp(-r*T)*normCdf(d2);
  const putPrice = K*Math.exp(-r*T)*normCdf(-d2) - S*normCdf(-d1);
  const pdf = Math.exp(-0.5*d1*d1)/Math.sqrt(2*Math.PI);
  const delta = type === 'call' ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = pdf / (S*sigma*sqrtT);
  const vega = (S*pdf*sqrtT)/100;
  const thetaCall = (-S*pdf*sigma/(2*sqrtT) - r*K*Math.exp(-r*T)*normCdf(d2))/365;
  const thetaPut = (-S*pdf*sigma/(2*sqrtT) + r*K*Math.exp(-r*T)*normCdf(-d2))/365;
  return { price: type === 'call' ? callPrice : putPrice, delta, gamma, theta: type === 'call' ? thetaCall : thetaPut, vega };
}

function activeScenario() {
  return scenarios.find(s => s.code === state.activeScenarioCode) || scenarios[0];
}

function emptyCurrent(scenario) {
  return {
    scenarioCode: scenario.code,
    marketState: { volShift: 0, spotShift: 0, elapsedTrades: 0, currentVol: scenario.vol, currentSpot: scenario.spot },
    cash: scenario.startingCash,
    positions: [],
    activity: [],
    latestTradeInsight: '',
    volatilityEvents: [],
    started: false,
    finished: false,
    timerMinutes: 45,
  };
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify({
    student: state.student,
    mode: state.mode,
    savedSessions: state.savedSessions,
    selectedFinalIds: state.selectedFinalIds,
    finalSubmitted: state.finalSubmitted,
    activeScenarioCode: state.activeScenarioCode,
  }));
}

function loadState() {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    state.student = parsed.student || state.student;
    state.mode = parsed.mode || state.mode;
    state.savedSessions = parsed.savedSessions || [];
    state.selectedFinalIds = parsed.selectedFinalIds || [];
    state.finalSubmitted = !!parsed.finalSubmitted;
    state.activeScenarioCode = parsed.activeScenarioCode || state.activeScenarioCode;
  } catch {}
}

function buildOptionChain(scenario, marketState) {
  const effectiveVol = Math.max(0.08, scenario.vol + marketState.volShift);
  const effectiveSpot = scenario.spot * (1 + marketState.spotShift);
  const T = Math.max(1, scenario.daysToExpiry - marketState.elapsedTrades) / 365;
  return scenario.strikes.flatMap(K => ['call','put'].map(type => {
    const g = blackScholes({ S: effectiveSpot, K, T, r: scenario.rate, sigma: effectiveVol, type });
    const spread = Math.max(0.04, g.price*0.04);
    return { id: `${type}-${K}`, type, strike: K, bid: Math.max(0.01, g.price-spread/2), ask: g.price+spread/2, mid: g.price, ...g };
  }));
}

function computePortfolio(current, scenario) {
  const chain = buildOptionChain(scenario, current.marketState);
  const byId = Object.fromEntries(chain.map(o => [o.id, o]));
  let mtm=0, delta=0, gamma=0, theta=0, vega=0;
  const rows = current.positions.map(p => {
    const m = byId[p.id];
    const value = p.qty * m.mid * scenario.contractSize;
    const cost = p.qty * p.avgPremium * scenario.contractSize;
    const pnl = value - cost;
    mtm += value;
    delta += p.qty * m.delta * scenario.contractSize;
    gamma += p.qty * m.gamma * scenario.contractSize;
    theta += p.qty * m.theta * scenario.contractSize;
    vega += p.qty * m.vega * scenario.contractSize;
    return { ...p, market: m.mid, value, pnl };
  });
  return { rows, mtm, equity: current.cash + mtm, pnl: current.cash + mtm - scenario.startingCash, delta, gamma, theta, vega, optionChain: chain };
}

function computeTargetScore(delta) {
  if (delta >= 20 && delta <= 120) return 35;
  const gap = Math.min(Math.abs(delta - 70), 120);
  return Math.max(0, 35 - gap*0.35);
}
function computePnlScore(pnl) {
  if (pnl >= 1500) return 20;
  if (pnl <= -1500) return 0;
  return ((pnl + 1500)/3000)*20;
}
function computeDisciplineScore(trades, maxTrades) { return trades === maxTrades ? 10 : 0; }
function computeVolatilityResponseScore(events) {
  if (!events.length) return 0;
  const scores = events.map(ev => {
    const volDirection = Math.sign(ev.volChange);
    const vegaAdjustment = ev.vegaAfter - ev.vegaBefore;
    const desiredAdjustment = volDirection > 0 ? -1 : 1;
    const directionalMatch = Math.sign(vegaAdjustment) === desiredAdjustment ? 1 : 0;
    const magnitude = Math.min(1, Math.abs(vegaAdjustment)/25);
    return directionalMatch * (0.6 + 0.4*magnitude);
  });
  return Number(((scores.reduce((a,b)=>a+b,0)/scores.length)*5).toFixed(1));
}
function computeInstrumentCoverageScore(callTrades, putTrades) { return callTrades>0 && putTrades>0 ? 5 : 0; }
function computeRiskScore(gamma, vega, volScore=0) {
  const gammaPenalty = Math.max(0, Math.abs(gamma)-18)*1.2;
  const vegaPenalty = Math.max(0, Math.abs(vega)-140)*0.12;
  const base = Math.max(0, 20-gammaPenalty-vegaPenalty);
  return Math.min(25, base+volScore);
}

function generateSessionFeedback(portfolio, tradeCount, scenario, scorecard, callTrades, putTrades) {
  return [
    portfolio.delta >= 20 && portfolio.delta <= 120 ? 'Directional outcome: the portfolio finished inside the target delta band.' : 'Directional outcome: the portfolio did not finish inside the target delta band.',
    scorecard.volatilityResponseScore >= 3 ? 'Volatility handling: the session adjusted vega in a way broadly consistent with volatility shocks.' : 'Volatility handling: the session showed limited adaptation to volatility changes.',
    tradeCount === scenario.maxTrades ? 'Trading discipline: the session used exactly 10 trades as required.' : 'Trading discipline: the session did not use exactly 10 trades.',
    callTrades > 0 && putTrades > 0 ? 'Instrument coverage: both calls and puts were used.' : 'Instrument coverage: both calls and puts were not used.',
    Math.abs(portfolio.vega) <= 140 ? 'Risk control: final vega stayed inside the preferred band.' : 'Risk control: final vega exceeded the preferred band.'
  ];
}

function computeCurrentSessionSummary() {
  const scenario = activeScenario();
  const current = state.current || emptyCurrent(scenario);
  const portfolio = computePortfolio(current, scenario);
  const tradeCount = current.activity.length;
  const callTrades = current.activity.filter(a => a.instrument.startsWith('CALL')).length;
  const putTrades = current.activity.filter(a => a.instrument.startsWith('PUT')).length;
  const volScore = computeVolatilityResponseScore(current.volatilityEvents);
  const scorecard = {
    targetFit: computeTargetScore(portfolio.delta),
    volatilityResponseScore: volScore,
    riskControl: computeRiskScore(portfolio.gamma, portfolio.vega, volScore),
    pnlScore: computePnlScore(portfolio.pnl),
    discipline: computeDisciplineScore(tradeCount, scenario.maxTrades),
    instrumentCoverageScore: computeInstrumentCoverageScore(callTrades, putTrades),
  };
  scorecard.total = scorecard.targetFit + scorecard.riskControl + scorecard.pnlScore + scorecard.discipline + scorecard.instrumentCoverageScore;
  return { portfolio, tradeCount, callTrades, putTrades, scorecard, scenario, current };
}

function setScreen(screen) {
  state.screen = screen;
  document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
  document.getElementById(screen).classList.remove('hidden');
  render();
}

function renderMetric(label, value) {
  return `<div class="metric"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}

function renderDashboard() {
  const distinctSelectedScenarios = [...new Set(state.savedSessions.filter(s => state.selectedFinalIds.includes(s.sessionId)).map(s => s.scenarioCode))];
  const savedByScenario = scenarios.map(s => {
    const related = state.savedSessions.filter(x => x.scenarioCode === s.code);
    return { code: s.code, count: related.length, best: related.reduce((m, x) => Math.max(m, x.scorecard.total), 0) };
  });
  document.getElementById('dashboard').innerHTML = `
    <div class="grid two">
      <div class="card stack">
        <div class="metric-grid">
          ${renderMetric('Saved sessions', state.savedSessions.length)}
          ${renderMetric('Selected for submission', `${state.selectedFinalIds.length} / 4`)}
          ${renderMetric('Distinct selected scenarios', distinctSelectedScenarios.length)}
          ${renderMetric('Submission status', state.finalSubmitted ? 'Submitted' : 'Open')}
        </div>
        <div class="note">
          <strong>Rules reminder</strong><br>
          Submit exactly four completed sessions. Use at least two different scenarios across the final four. Each selected session should contain exactly 10 trades and include both calls and puts. The written rationale is submitted separately on SurreyLearn.
        </div>
        <div class="actions">
          <button onclick="setScreen('scenarios')">Start new session</button>
          <button class="secondary" onclick="setScreen('library')">View saved sessions</button>
          <button class="secondary" onclick="setScreen('submit')">Select best four</button>
        </div>
      </div>
      <div class="card stack">
        <strong>Scenario progress</strong>
        ${savedByScenario.map(s => `<div class="summary-box"><div class="label">${s.code}</div><div class="small subtle">Saved attempts: ${s.count}</div><div class="small subtle">Best score: ${formatNum(s.best,1)}</div></div>`).join('')}
      </div>
    </div>`;
}

function renderScenarios() {
  document.getElementById('scenarios').innerHTML = `
    <div class="card stack">
      <strong>Scenario selection</strong>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Scenario</th><th>Description</th><th>Initial vol</th><th>Previous attempts</th><th>Best score</th><th>Action</th></tr></thead>
          <tbody>
            ${scenarios.map(s => {
              const prior = state.savedSessions.filter(x => x.scenarioCode === s.code);
              const best = prior.reduce((m,x)=>Math.max(m,x.scorecard.total),0);
              return `<tr><td><strong>${s.label}</strong></td><td>${s.description}</td><td>${(s.vol*100).toFixed(1)}%</td><td>${prior.length}</td><td>${formatNum(best,1)}</td><td><button onclick="beginScenario('${s.code}')">Start</button></td></tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="warning">To satisfy final submission rules, remember that the selected best four must include at least two different scenarios.</div>
    </div>`;
}

function renderSession() {
  const { portfolio, tradeCount, callTrades, putTrades, scenario, current } = computeCurrentSessionSummary();
  document.getElementById('session').innerHTML = `
    <div class="grid two">
      <div class="card stack">
        <strong>Live trading session</strong>
        <div class="metric-grid">
          ${renderMetric('Scenario', scenario.code)}
          ${renderMetric('Spot', formatMoney(current.marketState.currentSpot))}
          ${renderMetric('Implied vol', `${(current.marketState.currentVol*100).toFixed(1)}%`)}
          ${renderMetric('Time to expiry', `${Math.max(1, scenario.daysToExpiry - current.marketState.elapsedTrades)} days`)}
        </div>
        <div class="actions">
          ${!current.started && !current.finished ? '<button onclick="startSession()">Start session</button>' : ''}
          <button class="secondary" onclick="finishSession()" ${tradeCount===0 ? 'disabled' : ''}>Finish session</button>
          <button class="secondary" onclick="setScreen('summary')">Session summary</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Type</th><th>Strike</th><th>Bid</th><th>Ask</th><th>Delta</th><th>Gamma</th><th>Theta</th><th>Vega</th><th>Trade</th></tr></thead>
            <tbody>
            ${portfolio.optionChain.map(o => `<tr>
              <td><span class="badge ${o.type === 'put' ? 'secondary' : ''}">${o.type.toUpperCase()}</span></td>
              <td>${o.strike}</td>
              <td>${formatNum(o.bid,3)}</td>
              <td>${formatNum(o.ask,3)}</td>
              <td>${formatNum(o.delta,3)}</td>
              <td>${formatNum(o.gamma,3)}</td>
              <td>${formatNum(o.theta,3)}</td>
              <td>${formatNum(o.vega,3)}</td>
              <td>
                <button ${(!current.started || current.finished || tradeCount>=scenario.maxTrades) ? 'disabled' : ''} onclick="tradeOption('${o.id}','buy')">Buy</button>
                <button class="secondary" ${(!current.started || current.finished || tradeCount>=scenario.maxTrades) ? 'disabled' : ''} onclick="tradeOption('${o.id}','sell')">Sell</button>
              </td>
            </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="stack">
        <div class="card stack">
          <strong>Session status</strong>
          <div class="small"><div class="flex-between"><span>Trades used</span><strong>${tradeCount} / ${scenario.maxTrades}</strong></div>
          <div class="flex-between"><span>Call trades</span><strong>${callTrades}</strong></div>
          <div class="flex-between"><span>Put trades</span><strong>${putTrades}</strong></div>
          <div class="flex-between"><span>Cash</span><strong>${formatMoney(current.cash)}</strong></div>
          <div class="flex-between"><span>Equity</span><strong>${formatMoney(portfolio.equity)}</strong></div>
          <div class="flex-between"><span>P&L</span><strong>${formatMoney(portfolio.pnl)}</strong></div>
          <div class="flex-between"><span>Delta</span><strong>${formatNum(portfolio.delta,1)}</strong></div>
          <div class="flex-between"><span>Gamma</span><strong>${formatNum(portfolio.gamma,2)}</strong></div>
          <div class="flex-between"><span>Theta</span><strong>${formatNum(portfolio.theta,2)}</strong></div>
          <div class="flex-between"><span>Vega</span><strong>${formatNum(portfolio.vega,1)}</strong></div></div>
        </div>
        <div class="card stack">
          <strong>Live feedback</strong>
          <div class="feedback-box">${current.latestTradeInsight || 'Trade feedback appears here after each trade.'}</div>
          <div class="note">${state.mode === 'practice' ? 'Practice mode is active. Students can experiment, save, and later decide which completed sessions are strong enough to submit.' : 'Assessment mode is active. The final selected four should include at least two different scenarios.'}</div>
        </div>
      </div>
    </div>`;
}

function renderSummary() {
  const { portfolio, tradeCount, callTrades, putTrades, scorecard, scenario } = computeCurrentSessionSummary();
  const feedback = generateSessionFeedback(portfolio, tradeCount, scenario, scorecard, callTrades, putTrades);
  document.getElementById('summary').innerHTML = `
    <div class="card stack">
      <strong>Session summary and save</strong>
      <div class="metric-grid">
        ${renderMetric('Scenario', scenario.code)}
        ${renderMetric('Trades', `${tradeCount} / ${scenario.maxTrades}`)}
        ${renderMetric('Call / Put', `${callTrades} / ${putTrades}`)}
        ${renderMetric('Score', `${formatNum(scorecard.total,1)} / 100`)}
      </div>
      <div class="metric-grid">
        ${renderMetric('Volatility response', `${formatNum(scorecard.volatilityResponseScore,1)} / 5`)}
        ${renderMetric('Instrument coverage', `${formatNum(scorecard.instrumentCoverageScore,1)} / 5`)}
        ${renderMetric('Final P&L', formatMoney(portfolio.pnl))}
      </div>
      <div class="summary-box"><div class="label">End-of-session feedback</div><div class="stack top-gap">${feedback.map(msg => `<div>${msg}</div>`).join('')}</div></div>
      <div class="actions">
        <button onclick="saveCompletedSession()">Save completed session</button>
        <button class="secondary" onclick="setScreen('session')">Return to session</button>
        <button class="secondary" onclick="setScreen('dashboard')">Return to dashboard</button>
      </div>
    </div>`;
}

function renderLibrary() {
  const distinctSelectedScenarios = [...new Set(state.savedSessions.filter(s => state.selectedFinalIds.includes(s.sessionId)).map(s => s.scenarioCode))];
  document.getElementById('library').innerHTML = `
    <div class="card stack">
      <div class="flex-between"><strong>Saved sessions library</strong><div class="actions"><button class="secondary" onclick="downloadCsv()">Download session CSV</button><button class="secondary" onclick="setScreen('submit')">Go to final submission</button></div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Select</th><th>Session</th><th>Scenario</th><th>Date</th><th>Score</th><th>Vol score</th><th>P&L</th><th>Calls/Puts</th><th>Status</th></tr></thead>
          <tbody>
            ${state.savedSessions.length ? state.savedSessions.map(s => `<tr>
              <td><input type="checkbox" ${state.selectedFinalIds.includes(s.sessionId)?'checked':''} ${state.finalSubmitted?'disabled':''} onchange="toggleSelectedFinal('${s.sessionId}')"></td>
              <td class="mono">${s.sessionId}</td>
              <td>${s.scenarioCode}</td>
              <td>${s.createdAt}</td>
              <td>${formatNum(s.scorecard.total,1)}</td>
              <td>${formatNum(s.scorecard.volatilityResponseScore,1)}</td>
              <td>${formatMoney(s.portfolio.pnl)}</td>
              <td>${s.callTrades}/${s.putTrades}</td>
              <td><span class="badge ${state.selectedFinalIds.includes(s.sessionId)?'':'secondary'}">${state.selectedFinalIds.includes(s.sessionId)?'Selected':'Saved'}</span></td>
            </tr>`).join('') : '<tr><td colspan="9" class="subtle">No saved sessions yet.</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="note">Currently selected: ${state.selectedFinalIds.length} sessions. Distinct scenarios among selected sessions: ${distinctSelectedScenarios.length}.</div>
    </div>`;
}

function renderSubmit() {
  const selectedSessions = state.savedSessions.filter(s => state.selectedFinalIds.includes(s.sessionId));
  const distinctSelectedScenarios = [...new Set(selectedSessions.map(s => s.scenarioCode))];
  const canSubmitFinal = state.selectedFinalIds.length === 4 && distinctSelectedScenarios.length >= 2 && !state.finalSubmitted;
  document.getElementById('submit').innerHTML = `
    <div class="card stack">
      <strong>Final submission screen</strong>
      <div class="metric-grid">
        ${renderMetric('Selected sessions', `${state.selectedFinalIds.length} / 4`)}
        ${renderMetric('Distinct scenarios', distinctSelectedScenarios.length)}
        ${renderMetric('Rule satisfied', (canSubmitFinal || state.finalSubmitted) ? 'Yes' : 'No')}
        ${renderMetric('Rationale', 'Submit separately')}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Session</th><th>Scenario</th><th>Score</th><th>Vol score</th><th>P&L</th><th>Calls/Puts</th></tr></thead>
          <tbody>
            ${selectedSessions.length ? selectedSessions.map(s => `<tr><td class="mono">${s.sessionId}</td><td>${s.scenarioCode}</td><td>${formatNum(s.scorecard.total,1)}</td><td>${formatNum(s.scorecard.volatilityResponseScore,1)}</td><td>${formatMoney(s.portfolio.pnl)}</td><td>${s.callTrades}/${s.putTrades}</td></tr>`).join('') : '<tr><td colspan="6" class="subtle">No sessions selected yet.</td></tr>'}
          </tbody>
        </table>
      </div>
      ${state.selectedFinalIds.length !== 4 ? '<div class="warning">You must select exactly four sessions before final submission.</div>' : ''}
      ${distinctSelectedScenarios.length < 2 ? '<div class="warning">Your selected sessions must include at least two different scenarios.</div>' : ''}
      ${state.finalSubmitted ? '<div class="success"><strong>Final submission locked.</strong><br>The selected four sessions are now locked for marking.</div>' : ''}
      <div class="actions"><button onclick="confirmFinalFour()" ${canSubmitFinal ? '' : 'disabled'}>Confirm selected four</button><button class="secondary" onclick="setScreen('library')">Return to saved sessions</button></div>
    </div>`;
}

function render() {
  document.getElementById('studentName').value = state.student.name;
  document.getElementById('studentNumber').value = state.student.number;
  document.getElementById('modeSelect').value = state.mode;
  renderDashboard();
  renderScenarios();
  renderSession();
  renderSummary();
  renderLibrary();
  renderSubmit();
}

function beginScenario(code) {
  state.activeScenarioCode = code;
  state.current = emptyCurrent(activeScenario());
  setScreen('session');
}
window.beginScenario = beginScenario;

function startSession() {
  if (!state.current) state.current = emptyCurrent(activeScenario());
  state.current.started = true;
  render();
}
window.startSession = startSession;

function finishSession() {
  if (!state.current) return;
  state.current.finished = true;
  state.current.started = false;
  setScreen('summary');
}
window.finishSession = finishSession;

function tradeOption(optionId, side) {
  const scenario = activeScenario();
  if (!state.current) state.current = emptyCurrent(scenario);
  const current = state.current;
  if (!current.started || current.finished || current.activity.length >= scenario.maxTrades) return;
  const portfolio = computePortfolio(current, scenario);
  const option = portfolio.optionChain.find(o => o.id === optionId);
  const premium = side === 'buy' ? option.ask : option.bid;
  const signedQty = side === 'buy' ? 1 : -1;
  current.cash += -signedQty * premium * scenario.contractSize;
  const idx = current.positions.findIndex(p => p.id === option.id);
  if (idx === -1) {
    current.positions.push({ id: option.id, type: option.type, strike: option.strike, qty: signedQty, avgPremium: premium });
  } else {
    const old = current.positions[idx];
    const newQty = old.qty + signedQty;
    if (newQty === 0) current.positions.splice(idx,1);
    else {
      const weightedCost = old.avgPremium * old.qty + premium * signedQty;
      current.positions[idx] = { ...old, qty: newQty, avgPremium: weightedCost / newQty };
    }
  }
  const tradeNumber = current.activity.length + 1;
  const deltaEffect = signedQty * option.delta * scenario.contractSize;
  const gammaEffect = signedQty * option.gamma * scenario.contractSize;
  const vegaEffect = signedQty * option.vega * scenario.contractSize;
  const previousVega = portfolio.vega;
  const volShock = tradeNumber % 3 === 0 ? 0.015 : tradeNumber % 2 === 0 ? -0.01 : 0.005;
  const spotShock = tradeNumber % 4 === 0 ? -0.01 : tradeNumber % 2 === 1 ? 0.006 : 0;
  current.marketState.volShift += volShock;
  current.marketState.spotShift += spotShock;
  current.marketState.elapsedTrades += 1;
  current.marketState.currentVol = Math.max(0.08, scenario.vol + current.marketState.volShift);
  current.marketState.currentSpot = scenario.spot * (1 + current.marketState.spotShift);
  if (Math.abs(volShock) >= 0.009) {
    current.volatilityEvents.push({ tradeNumber, volChange: volShock, vegaBefore: previousVega, vegaAfter: previousVega + vegaEffect });
  }
  current.latestTradeInsight = `${side === 'buy' ? 'Buying' : 'Selling'} this ${option.type} at strike ${option.strike} changes delta by about ${formatNum(deltaEffect,1)}, gamma by ${formatNum(gammaEffect,2)}, and vega by ${formatNum(vegaEffect,1)}. Market update: spot ${spotShock >= 0 ? '+' : ''}${(spotShock*100).toFixed(1)}%, vol ${volShock >= 0 ? '+' : ''}${(volShock*100).toFixed(1)} pts.`;
  current.activity.unshift({ time: String(tradeNumber).padStart(2,'0'), action: side.toUpperCase(), instrument: `${option.type.toUpperCase()} ${option.strike}`, premium, marketNote: `Spot ${spotShock >= 0 ? '+' : ''}${(spotShock*100).toFixed(1)}%, vol ${volShock >= 0 ? '+' : ''}${(volShock*100).toFixed(1)} pts` });
  render();
}
window.tradeOption = tradeOption;

function saveCompletedSession() {
  if (!state.current) return;
  const { portfolio, tradeCount, callTrades, putTrades, scorecard, scenario, current } = computeCurrentSessionSummary();
  const sessionId = `S${String(state.savedSessions.length + 1).padStart(3,'0')}`;
  state.savedSessions.unshift({
    sessionId,
    scenarioCode: scenario.code,
    scenarioLabel: scenario.label,
    createdAt: new Date().toLocaleString('en-GB'),
    tradeCount,
    callTrades,
    putTrades,
    portfolio,
    scorecard,
    activity: clone(current.activity),
    marketPath: clone(current.marketState),
    feedback: generateSessionFeedback(portfolio, tradeCount, scenario, scorecard, callTrades, putTrades),
  });
  saveState();
  setScreen('library');
}
window.saveCompletedSession = saveCompletedSession;

function toggleSelectedFinal(sessionId) {
  if (state.finalSubmitted) return;
  if (state.selectedFinalIds.includes(sessionId)) state.selectedFinalIds = state.selectedFinalIds.filter(id => id !== sessionId);
  else if (state.selectedFinalIds.length < 4) state.selectedFinalIds.push(sessionId);
  saveState();
  render();
}
window.toggleSelectedFinal = toggleSelectedFinal;

function confirmFinalFour() {
  const selectedSessions = state.savedSessions.filter(s => state.selectedFinalIds.includes(s.sessionId));
  const distinct = [...new Set(selectedSessions.map(s => s.scenarioCode))];
  if (state.selectedFinalIds.length !== 4 || distinct.length < 2) return;
  state.finalSubmitted = true;
  saveState();
  render();
}
window.confirmFinalFour = confirmFinalFour;

function downloadCsv() {
  const header = ['candidate_name','candidate_number','session_id','scenario_code','submitted_in_final_four','score','volatility_response_score','instrument_coverage_score','trade_count','call_trades','put_trades','final_delta','final_gamma','final_theta','final_vega','final_pnl','created_at'];
  const rows = state.savedSessions.map(s => [
    state.student.name,
    state.student.number,
    s.sessionId,
    s.scenarioCode,
    state.selectedFinalIds.includes(s.sessionId) ? 'yes' : 'no',
    s.scorecard.total,
    s.scorecard.volatilityResponseScore,
    s.scorecard.instrumentCoverageScore,
    s.tradeCount,
    s.callTrades,
    s.putTrades,
    s.portfolio.delta,
    s.portfolio.gamma,
    s.portfolio.theta,
    s.portfolio.vega,
    s.portfolio.pnl,
    s.createdAt,
  ]);
  const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.student.number || 'candidate'}_options_sessions.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
window.downloadCsv = downloadCsv;

function bindTopControls() {
  document.querySelectorAll('[data-screen]').forEach(btn => btn.addEventListener('click', () => setScreen(btn.dataset.screen)));
  document.getElementById('studentName').addEventListener('input', e => { state.student.name = e.target.value; saveState(); });
  document.getElementById('studentNumber').addEventListener('input', e => { state.student.number = e.target.value; saveState(); });
  document.getElementById('modeSelect').addEventListener('change', e => { state.mode = e.target.value; saveState(); render(); });
  document.getElementById('resetAllBtn').addEventListener('click', () => {
    localStorage.removeItem(storageKey);
    state.student = { name:'', number:'' };
    state.mode = 'practice';
    state.savedSessions = [];
    state.selectedFinalIds = [];
    state.finalSubmitted = false;
    state.activeScenarioCode = scenarios[0].code;
    state.current = null;
    setScreen('dashboard');
  });
}

loadState();
state.current = emptyCurrent(activeScenario());
bindTopControls();
render();
