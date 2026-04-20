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
  finalSubmissionRecord: null,
  activeScenarioCode: scenarios[0].code,
  current: null,
};

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
function formatMoney(x) { return new Intl.NumberFormat('en-GB', { style:'currency', currency:'GBP', maximumFractionDigits: 2 }).format(x || 0); }
function formatNum(x, d=2) { return Number(x || 0).toFixed(d); }
function csvEscape(value) { const s = String(value ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; }
function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

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
    orderLots: 1,
    positions: [],
    activity: [],
    auditLog: [],
    rejectionLog: [],
    latestTradeInsight: '',
    volatilityEvents: [],
    started: false,
    finished: false,
    timerMinutes: 45,
  };
}

function normalizeCurrentSession(current, scenario) {
  if (!current) return emptyCurrent(scenario);
  return {
    ...emptyCurrent(scenario),
    ...current,
    marketState: { ...emptyCurrent(scenario).marketState, ...(current.marketState || {}) },
    orderLots: Math.max(1, Number(current.orderLots || 1)),
    positions: current.positions || [],
    activity: current.activity || [],
    auditLog: current.auditLog || [],
    rejectionLog: current.rejectionLog || [],
    volatilityEvents: current.volatilityEvents || [],
  };
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify({
    student: state.student,
    mode: state.mode,
    savedSessions: state.savedSessions,
    selectedFinalIds: state.selectedFinalIds,
    finalSubmitted: state.finalSubmitted,
    finalSubmissionRecord: state.finalSubmissionRecord,
    activeScenarioCode: state.activeScenarioCode,
    current: state.current,
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
    state.finalSubmissionRecord = parsed.finalSubmissionRecord || null;
    state.activeScenarioCode = parsed.activeScenarioCode || state.activeScenarioCode;
    state.current = parsed.current ? normalizeCurrentSession(parsed.current, activeScenario()) : state.current;
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
  let callContracts = 0, putContracts = 0;
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
    if (p.type === 'call') callContracts += p.qty;
    if (p.type === 'put') putContracts += p.qty;
    return { ...p, market: m.mid, value, pnl };
  });
  return {
    rows,
    mtm,
    equity: current.cash + mtm,
    pnl: current.cash + mtm - scenario.startingCash,
    delta,
    gamma,
    theta,
    vega,
    optionChain: chain,
    positionSummary: {
      callContracts,
      putContracts,
      netContracts: callContracts + putContracts,
      openLines: rows.length,
      underlyingEquivalent: (callContracts + putContracts) * scenario.contractSize,
    },
  };
}

function computeMarginRequirement(positions, scenario, marketState) {
  const chain = buildOptionChain(scenario, marketState);
  const byId = Object.fromEntries(chain.map(o => [o.id, o]));
  const spot = scenario.spot * (1 + marketState.spotShift);

  return positions.reduce((total, position) => {
    if (position.qty >= 0) return total;

    const option = byId[position.id];
    const shortContracts = Math.abs(position.qty);
    const otmAmount = option.type === 'call'
      ? Math.max(option.strike - spot, 0)
      : Math.max(spot - option.strike, 0);
    const baseRequirement = option.type === 'call'
      ? Math.max((0.2 * spot) - otmAmount, 0.1 * spot)
      : Math.max((0.2 * spot) - otmAmount, 0.1 * option.strike);
    const perContractRequirement = (option.mid + baseRequirement) * scenario.contractSize;

    return total + (perContractRequirement * shortContracts);
  }, 0);
}

function previewTrade(current, scenario, option, side, lots) {
  const tradeLots = Math.max(1, Number(lots || 1));
  const signedQty = side === 'buy' ? tradeLots : -tradeLots;
  const premium = side === 'buy' ? option.ask : option.bid;
  const next = clone(current);

  next.cash += -signedQty * premium * scenario.contractSize;

  const idx = next.positions.findIndex(p => p.id === option.id);
  if (idx === -1) {
    next.positions.push({ id: option.id, type: option.type, strike: option.strike, qty: signedQty, avgPremium: premium });
  } else {
    const result = applyTradeToPosition(next.positions[idx], signedQty, premium, option);
    if (result.remove) next.positions.splice(idx, 1);
    else next.positions[idx] = result.nextPosition;
  }

  const portfolio = computePortfolio(next, scenario);
  const marginRequirement = computeMarginRequirement(next.positions, scenario, next.marketState);
  return {
    next,
    signedQty,
    tradeLots,
    premium,
    portfolio,
    marginRequirement,
    buyingPower: portfolio.equity - marginRequirement,
  };
}

function applyTradeToPosition(existingPosition, signedQty, premium, option) {
  if (!existingPosition) {
    return {
      nextPosition: { id: option.id, type: option.type, strike: option.strike, qty: signedQty, avgPremium: premium },
      remove: false,
    };
  }

  const oldQty = existingPosition.qty;
  const newQty = oldQty + signedQty;

  if (newQty === 0) {
    return { nextPosition: null, remove: true };
  }

  if (Math.sign(oldQty) === Math.sign(signedQty)) {
    const totalContracts = Math.abs(oldQty) + Math.abs(signedQty);
    const weightedPremium = ((existingPosition.avgPremium * Math.abs(oldQty)) + (premium * Math.abs(signedQty))) / totalContracts;
    return {
      nextPosition: { ...existingPosition, qty: newQty, avgPremium: weightedPremium },
      remove: false,
    };
  }

  if (Math.sign(oldQty) === Math.sign(newQty)) {
    return {
      nextPosition: { ...existingPosition, qty: newQty, avgPremium: existingPosition.avgPremium },
      remove: false,
    };
  }

  return {
    nextPosition: { ...existingPosition, qty: newQty, avgPremium: premium },
    remove: false,
  };
}

function computeTargetScore(delta) {
  if (delta >= 20 && delta <= 120) return 10;
  const gap = Math.min(Math.abs(delta - 70), 100);
  return Math.max(0, 10 - 0.1 * gap);
}

function hasMeaningfulActivity(tradeCount, portfolio) {
  return (
    tradeCount >= 1 &&
    (Math.abs(portfolio.delta) > 1 ||
     Math.abs(portfolio.gamma) > 0.01 ||
     Math.abs(portfolio.theta) > 0.01 ||
     Math.abs(portfolio.vega) > 1 ||
     Math.abs(portfolio.pnl) > 1)
  );
}

function computePnlScore(pnl) {
  if (pnl <= 0) return 0;
  if (pnl >= 1500) return 20;
  return (pnl / 1500) * 20;
}

function computeDisciplineSatisfied(trades, maxTrades) {
  return trades === maxTrades;
}

function computeVolatilityResponseScore(events) {
  if (!events.length) return 0;
  const scores = events.map(ev => {
    const volDirection = Math.sign(ev.volChange);
    const vegaAdjustment = ev.vegaAfter - ev.vegaBefore;
    const desiredAdjustment = volDirection > 0 ? -1 : 1;
    const directionalMatch = Math.sign(vegaAdjustment) === desiredAdjustment ? 1 : 0;
    const magnitude = Math.min(1, Math.abs(vegaAdjustment) / 25);
    return directionalMatch * (0.6 + 0.4 * magnitude);
  });
  return Number(((scores.reduce((a, b) => a + b, 0) / scores.length) * 35).toFixed(1));
}

function computeInstrumentCoverageSatisfied(callTrades, putTrades) {
  return callTrades > 0 && putTrades > 0;
}

function computeRiskControlScore(gamma, vega) {
  const gammaPenalty = Math.max(0, Math.abs(gamma) - 18) * 1.5;
  const vegaPenalty = Math.max(0, Math.abs(vega) - 140) * 0.15;
  return Number(Math.max(0, 35 - gammaPenalty - vegaPenalty).toFixed(1));
}

function generateSessionFeedback(portfolio, tradeCount, scenario, scorecard, callTrades, putTrades, requirements) {
  return [
    portfolio.delta >= 20 && portfolio.delta <= 120 ? 'Directional outcome: the portfolio finished inside the target delta band.' : 'Directional outcome: the portfolio did not finish inside the target delta band.',
    scorecard.volatilityResponseScore >= 20 ? 'Volatility handling: the session adjusted vega in a way broadly consistent with volatility shocks.' : 'Volatility handling: the session showed limited adaptation to volatility changes.',
    requirements.disciplineSatisfied ? 'Trading discipline requirement met: the session used exactly 10 trades.' : 'Trading discipline requirement not met: the session did not use exactly 10 trades.',
    requirements.instrumentCoverageSatisfied ? 'Instrument coverage requirement met: both calls and puts were used.' : 'Instrument coverage requirement not met: both calls and puts were not used.',
    scorecard.riskControl >= 25 ? 'Risk control: the final portfolio exposures remained well controlled.' : 'Risk control: the final portfolio exposures were not sufficiently controlled.'
  ];
}

function computeCurrentSessionSummary() {
  const scenario = activeScenario();
  const current = state.current || emptyCurrent(scenario);
  const portfolio = computePortfolio(current, scenario);
  const tradeCount = current.activity.length;
  const callTrades = current.activity.filter(a => a.instrument.startsWith('CALL')).length;
  const putTrades = current.activity.filter(a => a.instrument.startsWith('PUT')).length;
  const grossLotsTraded = current.activity.reduce((total, trade) => total + Math.abs(Number(trade.lots || 1)), 0);
  const averageLotsPerTrade = tradeCount ? grossLotsTraded / tradeCount : 0;

  const requirements = {
    disciplineSatisfied: computeDisciplineSatisfied(tradeCount, scenario.maxTrades),
    instrumentCoverageSatisfied: computeInstrumentCoverageSatisfied(callTrades, putTrades)
  };

  const meaningfulActivity = hasMeaningfulActivity(tradeCount, portfolio);
  const completionFactor = Math.min(1, tradeCount / scenario.maxTrades);
  const disciplineFactor = requirements.disciplineSatisfied ? 1 : 0.35;
  const coverageFactor = requirements.instrumentCoverageSatisfied ? 1 : 0.6;
  const sizingFactor = meaningfulActivity ? Number(Math.min(1, 0.95 + Math.max(0, averageLotsPerTrade - 1) * 0.05).toFixed(3)) : 0;
  const assessmentReadinessFactor = Number((completionFactor * disciplineFactor * coverageFactor * sizingFactor).toFixed(3));

const baseScorecard = {
  targetFit: meaningfulActivity ? Number(computeTargetScore(portfolio.delta).toFixed(1)) : 0,
  volatilityResponseScore: meaningfulActivity ? computeVolatilityResponseScore(current.volatilityEvents) : 0,
  riskControl: meaningfulActivity ? computeRiskControlScore(portfolio.gamma, portfolio.vega) : 0,
  pnlScore: meaningfulActivity ? Number((computePnlScore(portfolio.pnl) * 1.5).toFixed(1)) : 0
};

const scorecard = {
  targetFit: Number((baseScorecard.targetFit * assessmentReadinessFactor).toFixed(1)),
  volatilityResponseScore: Number((baseScorecard.volatilityResponseScore * assessmentReadinessFactor).toFixed(1)),
  riskControl: Number((baseScorecard.riskControl * assessmentReadinessFactor).toFixed(1)),
  pnlScore: Number((baseScorecard.pnlScore * assessmentReadinessFactor).toFixed(1)),
  completionFactor,
  sizingFactor,
  grossLotsTraded,
  averageLotsPerTrade,
  assessmentReadinessFactor
};

  scorecard.total = Number((
    scorecard.targetFit +
    scorecard.volatilityResponseScore +
    scorecard.riskControl +
    scorecard.pnlScore
  ).toFixed(1));

  const marginRequirement = computeMarginRequirement(current.positions, scenario, current.marketState);
  const buyingPower = portfolio.equity - marginRequirement;

  return { portfolio, tradeCount, callTrades, putTrades, scorecard, requirements, scenario, current, marginRequirement, buyingPower };
}

function setScreen(screen) {
  state.screen = screen;
  document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
  document.getElementById(screen).classList.remove('hidden');
  render();
}
window.setScreen = setScreen;
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
        <div class="note">
          <strong>Assessment model</strong><br>
          Option prices use Black-Scholes with scenario-specific spot, rate, volatility, and time decay. Short options require simplified margin based on premium plus an underlying exposure buffer. Scores combine target delta fit, volatility-response handling, risk control, and P&amp;L under the published rubric.
        </div>
        <div class="actions">
          <button class="secondary" onclick="setScreen('instructions')">Read instructions</button>
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

function renderInstructions() {
  document.getElementById('instructions').innerHTML = `
    <div class="card stack">
      <strong>Student instructions</strong>
      <div class="summary-box">
        <div class="label">Assessment purpose</div>
        <div>This simulator is a coursework trading exercise. You are expected to manage option risk across changing scenarios, not simply chase raw profit.</div>
      </div>
      <div class="grid two">
        <div class="card stack">
          <strong>How the simulator works</strong>
          <div>Each trade is one option contract on the scenario underlying.</div>
          <div>Option prices use Black-Scholes with the scenario spot, rate, implied volatility, and remaining time to expiry.</div>
          <div>After each accepted trade, the scenario market path updates automatically through spot and volatility shocks.</div>
          <div>Short options consume simplified margin. A trade will be rejected if it would leave negative buying power or negative equity.</div>
        </div>
        <div class="card stack">
          <strong>What marks are based on</strong>
          <div>Target fit: ending portfolio delta relative to the target band.</div>
          <div>Volatility response: whether your vega adjustments respond sensibly to volatility shocks.</div>
          <div>Risk control: whether final gamma and vega remain controlled.</div>
          <div>P&amp;L: positive contribution after meaningful trading activity has taken place.</div>
          <div>Position sizing: using more than one lot can improve your result mainly if it leads to stronger P&amp;L and controlled risk. The scoring model applies only a light adjustment for repeated one-lot trading, so larger size is not rewarded on its own.</div>
        </div>
      </div>
      <div class="grid two">
        <div class="card stack">
          <strong>What counts as a valid submission</strong>
          <div>Complete exactly 10 trades in a saved session.</div>
          <div>Use both calls and puts within each selected session.</div>
          <div>Select exactly four saved sessions for final submission.</div>
          <div>Your final four must include at least two different scenarios.</div>
        </div>
        <div class="card stack">
          <strong>What to do if a trade is rejected</strong>
          <div>Read the rejection message in the live feedback panel.</div>
          <div>Check available buying power and current margin usage.</div>
          <div>Reduce risk, close exposure, or choose a cheaper contract before trying again.</div>
          <div>Rejected trades are logged as part of the session audit trail.</div>
        </div>
      </div>
      <div class="grid two">
        <div class="card stack">
          <strong>How practice mode helps</strong>
          <div>Use practice mode to learn how the scoring model reacts to your decisions before you try to produce submission-quality sessions.</div>
          <div>It is the best place to test how delta, gamma, theta, and vega change after different call and put trades.</div>
          <div>Practice mode also helps you see how the scenario path evolves after each accepted trade, including volatility shocks and rejected trades caused by margin limits.</div>
          <div>A strong use of practice mode is to compare several trade sequences, review the saved-session scores and audit trail, and identify which patterns produce controlled risk rather than random outcomes.</div>
        </div>
        <div class="card stack">
          <strong>How to progress to assessment mode</strong>
          <div>Progress to assessment mode once you can reliably complete a full 10-trade session in practice mode without relying on random trades.</div>
          <div>You should already understand how to keep both calls and puts in the session, manage buying power, and finish with a portfolio that fits the scoring rubric.</div>
          <div>A good rule is to switch only when your practice attempts are consistently producing valid completed sessions that you would be comfortable saving and comparing for final selection.</div>
          <div>If your practice scores remain provisional, heavily penalised, or highly inconsistent between attempts, do not progress yet. Stay in practice mode until your decision-making is more deliberate and repeatable.</div>
        </div>
      </div>
      <div class="card stack">
        <strong>Submission checklist</strong>
        <div>Enter your candidate name and candidate number before you begin.</div>
        <div>Save each completed session to the library.</div>
        <div>Review the saved-session scores, audit hash, and requirements status.</div>
        <div>Confirm your final four on the Final submission screen.</div>
        <div>Download the session CSV and submit the required outputs for marking as instructed by your module team.</div>
      </div>
      <div class="note">
        <strong>Important note</strong><br>
        This is a teaching simulator with a simplified margin model. The saved session data, audit hash, and final submission fingerprint form the local record of your work from this browser.
      </div>
      <div class="actions">
        <button onclick="setScreen('scenarios')">Go to scenarios</button>
        <button class="secondary" onclick="setScreen('dashboard')">Return to dashboard</button>
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
  const { portfolio, tradeCount, callTrades, putTrades, scenario, current, marginRequirement, buyingPower } = computeCurrentSessionSummary();
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
        <div class="note">
          <strong>Trading rules</strong><br>
          Choose the lot size before trading. Each option contract controls ${scenario.contractSize} units of the underlying. Buys must leave non-negative equity. Short option positions consume margin, and trades are rejected if post-trade buying power would be negative. The market path updates after each accepted trade.
        </div>
        <div class="actions">
          <label for="orderLotsInput"><strong>Lots per trade</strong></label>
          <input id="orderLotsInput" type="number" min="1" step="1" value="${current.orderLots || 1}" onchange="updateOrderLots(this.value)" style="width: 96px;" />
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
          <div class="flex-between"><span>Contract size</span><strong>${scenario.contractSize} underlying units</strong></div>
          <div class="flex-between"><span>Call trades</span><strong>${callTrades}</strong></div>
          <div class="flex-between"><span>Put trades</span><strong>${putTrades}</strong></div>
          <div class="flex-between"><span>Cash</span><strong>${formatMoney(current.cash)}</strong></div>
          <div class="flex-between"><span>Equity</span><strong>${formatMoney(portfolio.equity)}</strong></div>
          <div class="flex-between"><span>Margin used</span><strong>${formatMoney(marginRequirement)}</strong></div>
          <div class="flex-between"><span>Buying power</span><strong>${formatMoney(buyingPower)}</strong></div>
          <div class="flex-between"><span>P&L</span><strong>${formatMoney(portfolio.pnl)}</strong></div>
          <div class="flex-between"><span>Delta</span><strong>${formatNum(portfolio.delta,1)}</strong></div>
          <div class="flex-between"><span>Gamma</span><strong>${formatNum(portfolio.gamma,2)}</strong></div>
          <div class="flex-between"><span>Theta</span><strong>${formatNum(portfolio.theta,2)}</strong></div>
          <div class="flex-between"><span>Vega</span><strong>${formatNum(portfolio.vega,1)}</strong></div></div>
        </div>
        <div class="card stack">
          <strong>Portfolio summary</strong>
          <div class="small">
            <div class="flex-between"><span>Open lines</span><strong>${portfolio.positionSummary.openLines}</strong></div>
            <div class="flex-between"><span>Net call contracts</span><strong>${formatNum(portfolio.positionSummary.callContracts,0)}</strong></div>
            <div class="flex-between"><span>Net put contracts</span><strong>${formatNum(portfolio.positionSummary.putContracts,0)}</strong></div>
            <div class="flex-between"><span>Net contracts</span><strong>${formatNum(portfolio.positionSummary.netContracts,0)}</strong></div>
            <div class="flex-between"><span>Underlying equivalent</span><strong>${formatNum(portfolio.positionSummary.underlyingEquivalent,0)} units</strong></div>
            <div class="flex-between"><span>Portfolio delta</span><strong>${formatNum(portfolio.delta,1)}</strong></div>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Strike</th><th>Qty</th><th>Avg premium</th><th>Market</th><th>Value</th><th>P&amp;L</th></tr></thead>
              <tbody>
                ${portfolio.rows.length ? portfolio.rows.map(row => `<tr>
                  <td>${row.type.toUpperCase()}</td>
                  <td>${row.strike}</td>
                  <td>${formatNum(row.qty,0)}</td>
                  <td>${formatNum(row.avgPremium,3)}</td>
                  <td>${formatNum(row.market,3)}</td>
                  <td>${formatMoney(row.value)}</td>
                  <td>${formatMoney(row.pnl)}</td>
                </tr>`).join('') : '<tr><td colspan="7" class="subtle">No open option positions yet.</td></tr>'}
              </tbody>
            </table>
          </div>
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
  const { portfolio, tradeCount, callTrades, putTrades, scorecard, requirements, scenario, current, marginRequirement, buyingPower } = computeCurrentSessionSummary();
  const feedback = generateSessionFeedback(portfolio, tradeCount, scenario, scorecard, callTrades, putTrades, requirements);
  const isProvisional = !requirements.disciplineSatisfied || !requirements.instrumentCoverageSatisfied;
  const scoreLabel = isProvisional ? 'Provisional score' : 'Assessment score';
  document.getElementById('summary').innerHTML = `
  <div class="card stack">
    <strong>Session summary and save</strong>
    <div class="metric-grid">
      ${renderMetric('Scenario', scenario.code)}
      ${renderMetric('Trades', `${tradeCount} / ${scenario.maxTrades}`)}
      ${renderMetric('Call / Put', `${callTrades} / ${putTrades}`)}
      ${renderMetric(scoreLabel, `${formatNum(scorecard.total,1)} / 100`)}
    </div>
    <div class="metric-grid">
      ${renderMetric('Target fit', `${formatNum(scorecard.targetFit,1)} / 10`)}
      ${renderMetric('Volatility response', `${formatNum(scorecard.volatilityResponseScore,1)} / 35`)}
      ${renderMetric('Risk control', `${formatNum(scorecard.riskControl,1)} / 35`)}
      ${renderMetric('P&L score', `${formatNum(scorecard.pnlScore,1)} / 30`)}
    </div>
    <div class="metric-grid">
      ${renderMetric('10 trades requirement', requirements.disciplineSatisfied ? 'Met' : 'Not met')}
      ${renderMetric('Calls and puts requirement', requirements.instrumentCoverageSatisfied ? 'Met' : 'Not met')}
    </div>
    <div class="metric-grid">
      ${renderMetric('Ending equity', formatMoney(portfolio.equity))}
      ${renderMetric('Ending margin used', formatMoney(marginRequirement))}
      ${renderMetric('Ending buying power', formatMoney(buyingPower))}
      ${renderMetric('Rejected trades', current.rejectionLog?.length || 0)}
    </div>
    <div class="metric-grid">
      ${renderMetric('Completion factor', `${formatNum(scorecard.completionFactor * 100, 0)}%`)}
      ${renderMetric('Sizing factor', `${formatNum(scorecard.sizingFactor * 100, 0)}%`)}
      ${renderMetric('Avg lots / trade', formatNum(scorecard.averageLotsPerTrade, 2))}
      ${renderMetric('Readiness factor', `${formatNum(scorecard.assessmentReadinessFactor * 100, 0)}%`)}
    </div>
    ${isProvisional ? '<div class="warning">This is a provisional score only. The session does not yet satisfy the assessment submission requirements, so the score has been scaled down and should not be compared with completed attempts.</div>' : '<div class="success">This session currently satisfies the core assessment submission requirements.</div>'}
    ${current.saved ? '<div class="success">This session has already been saved to the library.</div>' : ''}
    <div class="note">
      <strong>Scoring rubric</strong><br>
      Target fit rewards ending delta inside the published band. Volatility response rewards vega adjustments that move against volatility shocks. Risk control penalises extreme gamma and vega. P&amp;L contributes only after meaningful trading activity has taken place. Incomplete sessions are scaled down by completion and submission-readiness factors. Position sizing matters mainly through the portfolio outcomes it creates, with only a light sizing adjustment to discourage purely mechanical one-lot trading.
    </div>
    <div class="summary-box"><div class="label">End-of-session feedback</div><div class="stack top-gap">${feedback.map(msg => `<div>${msg}</div>`).join('')}</div></div>
    <div class="actions">
      <button onclick="saveCompletedSession()" ${(!current.finished || current.saved) ? 'disabled' : ''}>Save completed session</button>
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
          <thead><tr><th>Select</th><th>Session</th><th>Scenario</th><th>Date</th><th>Score</th><th>Vol score</th><th>Risk score</th><th>P&L score</th><th>P&amp;L</th><th>Rejected</th><th>Audit hash</th><th>Reqs</th><th>Status</th></tr></thead>
          <tbody>
            ${state.savedSessions.length ? state.savedSessions.map(s => `<tr>
              <td><input type="checkbox" ${state.selectedFinalIds.includes(s.sessionId)?'checked':''} ${state.finalSubmitted?'disabled':''} onchange="toggleSelectedFinal('${s.sessionId}')"></td>
              <td class="mono">${s.sessionId}</td>
              <td>${s.scenarioCode}</td>
              <td>${s.createdAt}</td>
              <td>${formatNum(s.scorecard.total,1)}</td>
              <td>${formatNum(s.scorecard.volatilityResponseScore,1)}</td>
              <td>${formatNum(s.scorecard.riskControl,1)}</td>
              <td>${formatNum(s.scorecard.pnlScore,1)}</td>
              <td>${formatMoney(s.portfolio.pnl)}</td>
              <td>${s.rejectionCount || 0}</td>
              <td class="mono">${s.auditHash || '-'}</td>
              <td>${s.requirements.disciplineSatisfied && s.requirements.instrumentCoverageSatisfied ? 'Met' : 'Not met'}</td>
              <td><span class="badge ${state.selectedFinalIds.includes(s.sessionId)?'':'secondary'}">${state.selectedFinalIds.includes(s.sessionId)?'Selected':'Saved'}</span></td>
</tr>`).join('') : '<tr><td colspan="13" class="subtle">No saved sessions yet.</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="note">Currently selected: ${state.selectedFinalIds.length} sessions. Distinct scenarios among selected sessions: ${distinctSelectedScenarios.length}.</div>
    </div>`;
}

function renderSubmit() {
  const selectedSessions = state.savedSessions.filter(s => state.selectedFinalIds.includes(s.sessionId));
  const distinctSelectedScenarios = [...new Set(selectedSessions.map(s => s.scenarioCode))];

  const requirementsSatisfied = 
  selectedSessions.length > 0 &&
  selectedSessions.every(
    s => s.requirements?.disciplineSatisfied && s.requirements?.instrumentCoverageSatisfied
  );

  const canSubmitFinal =
  state.selectedFinalIds.length === 4 &&
  distinctSelectedScenarios.length >= 2 &&
  requirementsSatisfied &&
  !state.finalSubmitted;

  const submissionRecord = state.finalSubmissionRecord;

  document.getElementById('submit').innerHTML = `
    <div class="card stack">
      <strong>Final submission screen</strong>
      <div class="metric-grid">
        ${renderMetric('Selected sessions', `${state.selectedFinalIds.length} / 4`)}
        ${renderMetric('Distinct scenarios', distinctSelectedScenarios.length)}
        ${renderMetric('Requirements met', requirementsSatisfied ? 'Yes' : 'No')}
        ${renderMetric('Rule satisfied', (canSubmitFinal || state.finalSubmitted) ? 'Yes' : 'No')}
      </div>
      <div class="note">
        <strong>Submission lock</strong><br>
        Final confirmation stores a snapshot of the selected four sessions, their scores, and an audit fingerprint. This is not server-side invigilation, but it gives markers a fixed local record of what was submitted from this browser.
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Session</th><th>Scenario</th><th>Score</th><th>Target</th><th>Vol score</th><th>Risk</th><th>P&amp;L score</th><th>P&amp;L</th><th>Audit hash</th><th>Requirements</th></tr></thead>
          <tbody>
            ${selectedSessions.length ? selectedSessions.map(s => `<tr>
              <td class="mono">${s.sessionId}</td>
              <td>${s.scenarioCode}</td>
              <td>${formatNum(s.scorecard.total,1)}</td>
              <td>${formatNum(s.scorecard.targetFit,1)}</td>
              <td>${formatNum(s.scorecard.volatilityResponseScore,1)}</td>
              <td>${formatNum(s.scorecard.riskControl,1)}</td>
              <td>${formatNum(s.scorecard.pnlScore,1)}</td>
              <td>${formatMoney(s.portfolio.pnl)}</td>
              <td class="mono">${s.auditHash || '-'}</td>
              <td>${s.requirements.disciplineSatisfied && s.requirements.instrumentCoverageSatisfied ? 'Met' : 'Not met'}</td>
            </tr>`).join('') : '<tr><td colspan="10" class="subtle">No sessions selected yet.</td></tr>'}
          </tbody>
        </table>
      </div>
      ${state.selectedFinalIds.length !== 4 ? '<div class="warning">You must select exactly four sessions before final submission.</div>' : ''}
      ${distinctSelectedScenarios.length < 2 ? '<div class="warning">Your selected sessions must include at least two different scenarios.</div>' : ''}
      ${!requirementsSatisfied && selectedSessions.length ? '<div class="warning">All selected sessions must use exactly 10 trades and include both calls and puts.</div>' : ''}
      ${state.finalSubmitted ? '<div class="success"><strong>Final submission locked.</strong><br>The selected four sessions are now locked for marking.</div>' : ''}
      ${submissionRecord ? `<div class="summary-box"><div class="label">Recorded submission</div><div>Submitted at: ${submissionRecord.submittedAt}</div><div>Candidate: ${submissionRecord.studentNumber || 'Not entered'}</div><div class="mono">Fingerprint: ${submissionRecord.fingerprint}</div></div>` : ''}
      <div class="actions">
        <button onclick="confirmFinalFour()" ${canSubmitFinal ? '' : 'disabled'}>Confirm selected four</button>
        <button class="secondary" onclick="setScreen('library')">Return to saved sessions</button>
      </div>
    </div>`;
}

function render() {
  document.getElementById('studentName').value = state.student.name;
  document.getElementById('studentNumber').value = state.student.number;
  document.getElementById('modeSelect').value = state.mode;
  renderDashboard();
  renderInstructions();
  renderScenarios();
  renderSession();
  renderSummary();
  renderLibrary();
  renderSubmit();
}

function beginScenario(code) {
  state.activeScenarioCode = code;
  state.current = normalizeCurrentSession(null, activeScenario());
  saveState();
  setScreen('session');
}
window.beginScenario = beginScenario;

function startSession() {
  state.current = normalizeCurrentSession(state.current, activeScenario());
  state.current.started = true;
  saveState();
  render();
}
window.startSession = startSession;

function finishSession() {
  if (!state.current) return;
  state.current.finished = true;
  state.current.started = false;
  saveState();
  setScreen('summary');
}
window.finishSession = finishSession;

function tradeOption(optionId, side) {
  const scenario = activeScenario();
  state.current = normalizeCurrentSession(state.current, scenario);
  if (!state.current.started || state.current.finished || state.current.activity.length >= scenario.maxTrades) return;
  const portfolio = computePortfolio(state.current, scenario);
  const option = portfolio.optionChain.find(o => o.id === optionId);
  const preview = previewTrade(state.current, scenario, option, side, state.current.orderLots);

  if (preview.portfolio.equity < 0 || preview.buyingPower < 0) {
    const rejectionMessage = `Trade rejected: this ${side} order for ${preview.tradeLots} lot${preview.tradeLots === 1 ? '' : 's'} would leave equity at ${formatMoney(preview.portfolio.equity)} with margin required of ${formatMoney(preview.marginRequirement)}. Reduce size or close risk before adding this trade.`;
    state.current.latestTradeInsight = rejectionMessage;
    state.current.rejectionLog.unshift({
      order: state.current.rejectionLog.length + 1,
      action: side.toUpperCase(),
      instrument: `${option.type.toUpperCase()} ${option.strike}`,
      lots: preview.tradeLots,
      premium: preview.premium,
      equityAfter: preview.portfolio.equity,
      marginRequirement: preview.marginRequirement,
      buyingPower: preview.buyingPower,
      reason: rejectionMessage,
    });
    saveState();
    render();
    return;
  }

  const premium = preview.premium;
  const signedQty = preview.signedQty;
  const tradeLots = preview.tradeLots;
  state.current = preview.next;
  const current = state.current;
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
    const postShockPortfolio = computePortfolio(current, scenario);
    current.volatilityEvents.push({ tradeNumber, volChange: volShock, vegaBefore: previousVega, vegaAfter: postShockPortfolio.vega });
  }
  current.latestTradeInsight = `${side === 'buy' ? 'Buying' : 'Selling'} ${tradeLots} lot${tradeLots === 1 ? '' : 's'} of this ${option.type} at strike ${option.strike} changes delta by about ${formatNum(deltaEffect,1)}, gamma by ${formatNum(gammaEffect,2)}, and vega by ${formatNum(vegaEffect,1)}. Market update: spot ${spotShock >= 0 ? '+' : ''}${(spotShock*100).toFixed(1)}%, vol ${volShock >= 0 ? '+' : ''}${(volShock*100).toFixed(1)} pts.`;
  current.activity.unshift({ time: String(tradeNumber).padStart(2,'0'), action: side.toUpperCase(), instrument: `${option.type.toUpperCase()} ${option.strike}`, lots: tradeLots, premium, marketNote: `Spot ${spotShock >= 0 ? '+' : ''}${(spotShock*100).toFixed(1)}%, vol ${volShock >= 0 ? '+' : ''}${(volShock*100).toFixed(1)} pts` });
  current.auditLog.unshift({
    tradeNumber,
    action: side.toUpperCase(),
    instrument: `${option.type.toUpperCase()} ${option.strike}`,
    lots: tradeLots,
    premium,
    deltaEffect: Number(deltaEffect.toFixed(2)),
    gammaEffect: Number(gammaEffect.toFixed(4)),
    vegaEffect: Number(vegaEffect.toFixed(2)),
    spotAfter: Number(current.marketState.currentSpot.toFixed(4)),
    volAfter: Number(current.marketState.currentVol.toFixed(4)),
    cashAfter: Number(current.cash.toFixed(2)),
  });
  saveState();
  render();
}
window.tradeOption = tradeOption;

function updateOrderLots(value) {
  const scenario = activeScenario();
  state.current = normalizeCurrentSession(state.current, scenario);
  state.current.orderLots = Math.max(1, Math.floor(Number(value) || 1));
  saveState();
  render();
}
window.updateOrderLots = updateOrderLots;

function saveCompletedSession() {
  if (!state.current || !state.current.finished || state.current.saved) return;
  const { portfolio, tradeCount, callTrades, putTrades, scorecard, requirements, scenario, current, marginRequirement, buyingPower } = computeCurrentSessionSummary();
  const sessionId = `S${String(state.savedSessions.length + 1).padStart(3,'0')}`;
  const auditHash = hashString(JSON.stringify({
    scenarioCode: scenario.code,
    studentNumber: state.student.number,
    tradeCount,
    activity: current.activity,
    auditLog: current.auditLog,
    rejectionLog: current.rejectionLog,
    marketState: current.marketState,
    scorecard,
  }));
  state.savedSessions.unshift({
    sessionId,
    scenarioCode: scenario.code,
    scenarioLabel: scenario.label,
    sessionMode: state.mode,
    createdAt: new Date().toLocaleString('en-GB'),
    tradeCount,
    callTrades,
    putTrades,
    portfolio,
    scorecard,
    requirements,
    activity: clone(current.activity),
    auditLog: clone(current.auditLog),
    rejectionLog: clone(current.rejectionLog),
    rejectionCount: current.rejectionLog.length,
    marketPath: clone(current.marketState),
    marginRequirement,
    buyingPower,
    auditHash,
    feedback: generateSessionFeedback(portfolio, tradeCount, scenario, scorecard, callTrades, putTrades, requirements),
  });
  state.current.saved = true;
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
  const requirementsSatisfied = selectedSessions.every(s => s.requirements.disciplineSatisfied && s.requirements.instrumentCoverageSatisfied);
  if (state.selectedFinalIds.length !== 4 || distinct.length < 2 || !requirementsSatisfied) return;
  const submissionSnapshot = selectedSessions.map(s => ({
    sessionId: s.sessionId,
    scenarioCode: s.scenarioCode,
    score: s.scorecard.total,
    auditHash: s.auditHash,
  }));
  state.finalSubmissionRecord = {
    submittedAt: new Date().toLocaleString('en-GB'),
    studentName: state.student.name,
    studentNumber: state.student.number,
    sessions: submissionSnapshot,
    fingerprint: hashString(JSON.stringify(submissionSnapshot)),
  };
  state.finalSubmitted = true;
  saveState();
  render();
}
window.confirmFinalFour = confirmFinalFour;

function downloadCsv() {
  const header = ['candidate_name','candidate_number','session_id','scenario_code','session_mode','submitted_in_final_four','score','target_fit_score','volatility_response_score','risk_control_score','pnl_score','trade_count','call_trades','put_trades','discipline_requirement_met','calls_puts_requirement_met','final_delta','final_gamma','final_theta','final_vega','final_pnl','margin_requirement','buying_power','rejection_count','audit_hash','submission_fingerprint','contract_size','created_at'];
  const rows = state.savedSessions.map(s => [
    state.student.name,
    state.student.number,
    s.sessionId,
    s.scenarioCode,
    s.sessionMode || 'assessment',
    state.selectedFinalIds.includes(s.sessionId) ? 'yes' : 'no',
    s.scorecard.total,
    s.scorecard.targetFit,
    s.scorecard.volatilityResponseScore,
    s.scorecard.riskControl,
    s.scorecard.pnlScore,
    s.tradeCount,
    s.callTrades,
    s.putTrades,
    s.requirements?.disciplineSatisfied ? 'yes' : 'no',
    s.requirements?.instrumentCoverageSatisfied ? 'yes' : 'no',
    s.portfolio.delta,
    s.portfolio.gamma,
    s.portfolio.theta,
    s.portfolio.vega,
    s.portfolio.pnl,
    s.marginRequirement,
    s.buyingPower,
    s.rejectionCount || 0,
    s.auditHash || '',
    state.finalSubmissionRecord?.fingerprint || '',
    scenarios.find(x => x.code === s.scenarioCode)?.contractSize || '',
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
    state.finalSubmissionRecord = null;
    state.activeScenarioCode = scenarios[0].code;
    state.current = null;
    setScreen('dashboard');
  });
}

loadState();
state.current = normalizeCurrentSession(state.current, activeScenario());
bindTopControls();
render();
