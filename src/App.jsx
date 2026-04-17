import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  PlayCircle,
  Save,
  Wallet,
  Lock,
} from 'lucide-react'

function normCdf(x) {
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x) / Math.sqrt(2.0)
  const t = 1.0 / (1.0 + p * absX)
  const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX))
  return 0.5 * (1.0 + sign * erf)
}

function blackScholes({ S, K, T, r, sigma, type }) {
  if (T <= 0) {
    const intrinsic = type === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0)
    return { price: intrinsic, delta: 0, gamma: 0, theta: 0, vega: 0 }
  }
  const sqrtT = Math.sqrt(T)
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  const callPrice = S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2)
  const putPrice = K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1)
  const pdf = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI)
  const delta = type === 'call' ? normCdf(d1) : normCdf(d1) - 1
  const gamma = pdf / (S * sigma * sqrtT)
  const vega = (S * pdf * sqrtT) / 100
  const thetaCall = (-S * pdf * sigma / (2 * sqrtT) - r * K * Math.exp(-r * T) * normCdf(d2)) / 365
  const thetaPut = (-S * pdf * sigma / (2 * sqrtT) + r * K * Math.exp(-r * T) * normCdf(-d2)) / 365
  return {
    price: type === 'call' ? callPrice : putPrice,
    delta,
    gamma,
    theta: type === 'call' ? thetaCall : thetaPut,
    vega,
  }
}

function formatMoney(x) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 2,
  }).format(Number(x || 0))
}

function formatNum(x, digits = 2) {
  return Number(x || 0).toFixed(digits)
}

const scenarios = [
  {
    assessmentCode: 'SCN-A',
    label: 'Scenario A',
    description: 'Moderately bullish market with rising volatility later in the session.',
    underlying: 'ABC plc',
    spot: 100,
    rate: 0.03,
    vol: 0.24,
    daysToExpiry: 42,
    contractSize: 100,
    startingCash: 20000,
    maxTrades: 10,
    strikes: [85, 90, 95, 100, 105, 110, 115],
  },
  {
    assessmentCode: 'SCN-B',
    label: 'Scenario B',
    description: 'Softer market with mixed spot moves and changing volatility.',
    underlying: 'XYZ plc',
    spot: 92,
    rate: 0.025,
    vol: 0.22,
    daysToExpiry: 35,
    contractSize: 100,
    startingCash: 20000,
    maxTrades: 10,
    strikes: [75, 80, 85, 90, 95, 100, 105],
  },
  {
    assessmentCode: 'SCN-C',
    label: 'Scenario C',
    description: 'Higher-volatility environment designed to test adaptation to volatility shocks.',
    underlying: 'QRS plc',
    spot: 108,
    rate: 0.035,
    vol: 0.30,
    daysToExpiry: 30,
    contractSize: 100,
    startingCash: 20000,
    maxTrades: 10,
    strikes: [90, 95, 100, 105, 110, 115, 120],
  },
]

function buildOptionChain(scenario, marketState) {
  const effectiveVol = Math.max(0.08, scenario.vol + marketState.volShift)
  const effectiveSpot = scenario.spot * (1 + marketState.spotShift)
  const T = Math.max(1, scenario.daysToExpiry - marketState.elapsedTrades) / 365
  return scenario.strikes.flatMap((K) => ['call', 'put'].map((type) => {
    const greeks = blackScholes({ S: effectiveSpot, K, T, r: scenario.rate, sigma: effectiveVol, type })
    const spread = Math.max(0.04, greeks.price * 0.04)
    return {
      id: `${type}-${K}`,
      type,
      strike: K,
      bid: Math.max(0.01, greeks.price - spread / 2),
      ask: greeks.price + spread / 2,
      mid: greeks.price,
      ...greeks,
    }
  }))
}

function computeTargetScore(delta) {
  if (delta >= 20 && delta <= 120) return 35
  const gap = Math.min(Math.abs(delta - 70), 120)
  return Math.max(0, 35 - gap * 0.35)
}

function computePnlScore(pnl) {
  if (pnl >= 1500) return 20
  if (pnl <= -1500) return 0
  return ((pnl + 1500) / 3000) * 20
}

function computeDisciplineScore(trades, maxTrades) {
  return trades === maxTrades ? 10 : 0
}

function computeVolatilityResponseScore(events) {
  if (events.length === 0) return 0
  const eventScores = events.map((event) => {
    const volDirection = Math.sign(event.volChange)
    const vegaAdjustment = event.vegaAfter - event.vegaBefore
    const desiredAdjustment = volDirection > 0 ? -1 : 1
    const directionalMatch = Math.sign(vegaAdjustment) === desiredAdjustment ? 1 : 0
    const magnitude = Math.min(1, Math.abs(vegaAdjustment) / 25)
    return directionalMatch * (0.6 + 0.4 * magnitude)
  })
  const avg = eventScores.reduce((a, b) => a + b, 0) / eventScores.length
  return Number((avg * 5).toFixed(1))
}

function computeRiskScore(gamma, vega, volatilityResponseScore = 0) {
  const gammaPenalty = Math.max(0, Math.abs(gamma) - 18) * 1.2
  const vegaPenalty = Math.max(0, Math.abs(vega) - 140) * 0.12
  const baseScore = Math.max(0, 20 - gammaPenalty - vegaPenalty)
  return Math.min(25, baseScore + volatilityResponseScore)
}

function computeInstrumentCoverageScore(callTrades, putTrades) {
  return callTrades > 0 && putTrades > 0 ? 5 : 0
}

function csvEscape(value) {
  const str = String(value ?? '')
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function rowsToCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n')
}

function buildExportRows({ student, sessions, selectedIds }) {
  const header = [
    'candidate_name', 'candidate_number', 'session_id', 'scenario_code', 'submitted_in_final_four',
    'score', 'volatility_response_score', 'instrument_coverage_score', 'trade_count',
    'call_trades', 'put_trades', 'final_delta', 'final_gamma', 'final_theta', 'final_vega',
    'final_pnl', 'created_at'
  ]
  const rows = sessions.map((s) => [
    student.name,
    student.number,
    s.sessionId,
    s.scenarioCode,
    selectedIds.includes(s.sessionId) ? 'yes' : 'no',
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
  ])
  return [header, ...rows]
}

function generateSessionFeedback({ portfolio, tradeCount, scenario, scorecard, callTrades, putTrades }) {
  return [
    portfolio.delta >= 20 && portfolio.delta <= 120
      ? 'Directional outcome: the portfolio finished inside the target delta band.'
      : 'Directional outcome: the portfolio did not finish inside the target delta band.',
    scorecard.volatilityResponseScore >= 3
      ? 'Volatility handling: the student adjusted vega in a way broadly consistent with volatility shocks.'
      : 'Volatility handling: the student showed limited adaptation to volatility changes.',
    tradeCount === scenario.maxTrades
      ? 'Trading discipline: the session used exactly 10 trades as required.'
      : 'Trading discipline: the session did not use exactly 10 trades.',
    callTrades > 0 && putTrades > 0
      ? 'Instrument coverage: both calls and puts were used.'
      : 'Instrument coverage: both calls and puts were not used.',
    Math.abs(portfolio.vega) <= 140
      ? 'Risk control: final vega stayed inside the preferred band.'
      : 'Risk control: final vega exceeded the preferred band.',
  ]
}

const storageKey = 'options_trading_sessions_v1'

export default function App() {
  const [screen, setScreen] = useState('dashboard')
  const [student, setStudent] = useState({ name: '', number: '' })
  const [practiceMode, setPracticeMode] = useState(true)
  const [selectedScenarioCode, setSelectedScenarioCode] = useState(scenarios[0].assessmentCode)
  const [savedSessions, setSavedSessions] = useState([])
  const [selectedFinalIds, setSelectedFinalIds] = useState([])
  const [finalSubmitted, setFinalSubmitted] = useState(false)

  const activeScenario = useMemo(
    () => scenarios.find((s) => s.assessmentCode === selectedScenarioCode) || scenarios[0],
    [selectedScenarioCode]
  )

  const [marketState, setMarketState] = useState({
    volShift: 0,
    spotShift: 0,
    elapsedTrades: 0,
    currentVol: scenarios[0].vol,
    currentSpot: scenarios[0].spot,
  })
  const [cash, setCash] = useState(scenarios[0].startingCash)
  const [positions, setPositions] = useState([])
  const [activity, setActivity] = useState([])
  const [attemptStarted, setAttemptStarted] = useState(false)
  const [sessionFinished, setSessionFinished] = useState(false)
  const [latestTradeInsight, setLatestTradeInsight] = useState('')
  const [volatilityEvents, setVolatilityEvents] = useState([])

  useEffect(() => {
    const saved = localStorage.getItem(storageKey)
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        setSavedSessions(parsed.sessions || [])
        setSelectedFinalIds(parsed.selected || [])
        setFinalSubmitted(parsed.submitted || false)
        setStudent(parsed.student || { name: '', number: '' })
      } catch {}
    }
  }, [])

  useEffect(() => {
    const payload = {
      sessions: savedSessions,
      selected: selectedFinalIds,
      submitted: finalSubmitted,
      student,
    }
    localStorage.setItem(storageKey, JSON.stringify(payload))
  }, [savedSessions, selectedFinalIds, finalSubmitted, student])

  const optionChain = useMemo(() => buildOptionChain(activeScenario, marketState), [activeScenario, marketState])
  const marketById = useMemo(() => Object.fromEntries(optionChain.map((o) => [o.id, o])), [optionChain])

  const portfolio = useMemo(() => {
    let mtm = 0
    let delta = 0
    let gamma = 0
    let theta = 0
    let vega = 0
    const rows = positions.map((p) => {
      const mkt = marketById[p.id]
      if (!mkt) return { ...p, market: 0, value: 0, pnl: 0 }
      const value = p.qty * mkt.mid * activeScenario.contractSize
      const cost = p.qty * p.avgPremium * activeScenario.contractSize
      const pnl = value - cost
      mtm += value
      delta += p.qty * mkt.delta * activeScenario.contractSize
      gamma += p.qty * mkt.gamma * activeScenario.contractSize
      theta += p.qty * mkt.theta * activeScenario.contractSize
      vega += p.qty * mkt.vega * activeScenario.contractSize
      return { ...p, market: mkt.mid, value, pnl }
    })
    const equity = cash + mtm
    const pnl = equity - activeScenario.startingCash
    return { rows, mtm, equity, pnl, delta, gamma, theta, vega }
  }, [positions, marketById, cash, activeScenario.contractSize, activeScenario.startingCash])

  const tradeCount = activity.length
  const callTrades = activity.filter((a) => a.instrument.startsWith('CALL')).length
  const putTrades = activity.filter((a) => a.instrument.startsWith('PUT')).length

  const scorecard = useMemo(() => {
    const targetFit = computeTargetScore(portfolio.delta)
    const volatilityResponseScore = computeVolatilityResponseScore(volatilityEvents)
    const riskControl = computeRiskScore(portfolio.gamma, portfolio.vega, volatilityResponseScore)
    const pnlScore = computePnlScore(portfolio.pnl)
    const discipline = computeDisciplineScore(tradeCount, activeScenario.maxTrades)
    const instrumentCoverageScore = computeInstrumentCoverageScore(callTrades, putTrades)
    const total = targetFit + riskControl + pnlScore + discipline + instrumentCoverageScore
    return { targetFit, volatilityResponseScore, riskControl, pnlScore, discipline, instrumentCoverageScore, total }
  }, [portfolio, volatilityEvents, tradeCount, activeScenario.maxTrades, callTrades, putTrades])

  const savedByScenario = useMemo(() => scenarios.map((s) => {
    const subset = savedSessions.filter((x) => x.scenarioCode === s.assessmentCode)
    return {
      code: s.assessmentCode,
      count: subset.length,
      best: subset.reduce((m, x) => Math.max(m, x.scorecard.total), 0),
    }
  }), [savedSessions])

  const distinctSelectedScenarios = [...new Set(savedSessions.filter((s) => selectedFinalIds.includes(s.sessionId)).map((s) => s.scenarioCode))]
  const canSubmitFinal = selectedFinalIds.length === 4 && distinctSelectedScenarios.length >= 2 && !finalSubmitted
  const selectedSessions = savedSessions.filter((s) => selectedFinalIds.includes(s.sessionId))

  function resetSessionState(scenario = activeScenario) {
    setMarketState({
      volShift: 0,
      spotShift: 0,
      elapsedTrades: 0,
      currentVol: scenario.vol,
      currentSpot: scenario.spot,
    })
    setCash(scenario.startingCash)
    setPositions([])
    setActivity([])
    setAttemptStarted(false)
    setSessionFinished(false)
    setLatestTradeInsight('')
    setVolatilityEvents([])
  }

  function beginScenario(code) {
    const scenario = scenarios.find((s) => s.assessmentCode === code) || scenarios[0]
    setSelectedScenarioCode(code)
    resetSessionState(scenario)
    setScreen('session')
  }

  function startSession() {
    setAttemptStarted(true)
    setSessionFinished(false)
  }

  function trade(instrument, side) {
    if (!attemptStarted || sessionFinished || tradeCount >= activeScenario.maxTrades) return
    const premium = side === 'buy' ? instrument.ask : instrument.bid
    const signedQty = side === 'buy' ? 1 : -1
    const cashFlow = -signedQty * premium * activeScenario.contractSize
    const previousVega = portfolio.vega

    setCash((c) => c + cashFlow)
    setPositions((prev) => {
      const idx = prev.findIndex((p) => p.id === instrument.id)
      if (idx === -1) return [...prev, { id: instrument.id, type: instrument.type, strike: instrument.strike, qty: signedQty, avgPremium: premium }]
      const next = [...prev]
      const old = next[idx]
      const newQty = old.qty + signedQty
      if (newQty === 0) {
        next.splice(idx, 1)
        return next
      }
      const weightedCost = old.avgPremium * old.qty + premium * signedQty
      next[idx] = { ...old, qty: newQty, avgPremium: weightedCost / newQty }
      return next
    })

    const tradeNumber = activity.length + 1
    const deltaEffect = signedQty * instrument.delta * activeScenario.contractSize
    const gammaEffect = signedQty * instrument.gamma * activeScenario.contractSize
    const vegaEffect = signedQty * instrument.vega * activeScenario.contractSize
    const volShock = tradeNumber % 3 === 0 ? 0.015 : tradeNumber % 2 === 0 ? -0.01 : 0.005
    const spotShock = tradeNumber % 4 === 0 ? -0.01 : tradeNumber % 2 === 1 ? 0.006 : 0

    setMarketState((prev) => ({
      volShift: prev.volShift + volShock,
      spotShift: prev.spotShift + spotShock,
      elapsedTrades: prev.elapsedTrades + 1,
      currentVol: Math.max(0.08, activeScenario.vol + prev.volShift + volShock),
      currentSpot: activeScenario.spot * (1 + prev.spotShift + spotShock),
    }))

    if (Math.abs(volShock) >= 0.009) {
      setVolatilityEvents((prev) => [...prev, {
        tradeNumber,
        volChange: volShock,
        vegaBefore: previousVega,
        vegaAfter: previousVega + vegaEffect,
      }])
    }

    setLatestTradeInsight(
      `${side === 'buy' ? 'Buying' : 'Selling'} this ${instrument.type} at strike ${instrument.strike} changes delta by about ${formatNum(deltaEffect, 1)}, gamma by ${formatNum(gammaEffect, 2)}, and vega by ${formatNum(vegaEffect, 1)}. Market update: spot ${spotShock >= 0 ? '+' : ''}${(spotShock * 100).toFixed(1)}%, vol ${volShock >= 0 ? '+' : ''}${(volShock * 100).toFixed(1)} pts.`
    )

    setActivity((prev) => [{
      time: String(tradeNumber).padStart(2, '0'),
      action: side.toUpperCase(),
      instrument: `${instrument.type.toUpperCase()} ${instrument.strike}`,
      premium,
      marketNote: `Spot ${(spotShock >= 0 ? '+' : '')}${(spotShock * 100).toFixed(1)}%, vol ${(volShock >= 0 ? '+' : '')}${(volShock * 100).toFixed(1)} pts`,
    }, ...prev])
  }

  function finishSession() {
    setSessionFinished(true)
    setAttemptStarted(false)
    setScreen('summary')
  }

  function saveCompletedSession() {
    const sessionId = `S${String(savedSessions.length + 1).padStart(3, '0')}`
    const record = {
      sessionId,
      scenarioCode: activeScenario.assessmentCode,
      scenarioLabel: activeScenario.label,
      createdAt: new Date().toLocaleString('en-GB'),
      tradeCount,
      callTrades,
      putTrades,
      portfolio: { ...portfolio },
      scorecard: { ...scorecard },
      activity: [...activity],
      feedback: generateSessionFeedback({ portfolio, tradeCount, scenario: activeScenario, scorecard, callTrades, putTrades }),
    }
    setSavedSessions((prev) => [record, ...prev])
    setScreen('library')
  }

  function toggleSelectedFinal(sessionId) {
    if (finalSubmitted) return
    setSelectedFinalIds((prev) => {
      if (prev.includes(sessionId)) return prev.filter((id) => id !== sessionId)
      if (prev.length >= 4) return prev
      return [...prev, sessionId]
    })
  }

  function confirmFinalFour() {
    if (!canSubmitFinal) return
    setFinalSubmitted(true)
    setScreen('submit')
  }

  function downloadCsv() {
    const rows = buildExportRows({ student, sessions: savedSessions, selectedIds: selectedFinalIds })
    const csv = rowsToCsv(rows)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `${student.number || 'candidate'}_options_sessions.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  function resetAllSessions() {
    localStorage.removeItem(storageKey)
    setSavedSessions([])
    setSelectedFinalIds([])
    setFinalSubmitted(false)
  }

  return (
    <div className="page-shell">
      <div className="container">
        <div className="header-grid">
          <Card className="span-2">
            <div className="title-xl">Options Trading Workflow</div>
            <div className="badge-row">
              <span className="badge">Saved sessions model</span>
              <span className="badge muted">Submit best four</span>
              <span className="badge muted">At least two scenarios</span>
            </div>
            <div className="grid-2">
              <Field label="Candidate name">
                <input className="input" value={student.name} onChange={(e) => setStudent((s) => ({ ...s, name: e.target.value }))} />
              </Field>
              <Field label="Candidate number">
                <input className="input" value={student.number} onChange={(e) => setStudent((s) => ({ ...s, number: e.target.value }))} />
              </Field>
            </div>
            <div className="button-row wrap">
              <select className="input select-sm" value={practiceMode ? 'practice' : 'assessment'} onChange={(e) => setPracticeMode(e.target.value === 'practice')}>
                <option value="practice">Practice mode</option>
                <option value="assessment">Assessment mode</option>
              </select>
              <button className="button secondary" onClick={() => setScreen('dashboard')}>Dashboard</button>
              <button className="button secondary" onClick={() => setScreen('scenarios')}>Scenario selection</button>
              <button className="button secondary" onClick={() => setScreen('library')}>Saved sessions</button>
              <button className="button secondary" onClick={() => setScreen('submit')}>Final submission</button>
            </div>
          </Card>
          <StatCard title="Saved sessions" value={String(savedSessions.length)} icon={<Save size={18} />} />
          <StatCard title="Selected final" value={`${selectedFinalIds.length} / 4`} icon={<CheckCircle2 size={18} />} />
        </div>

        {screen === 'dashboard' && (
          <div className="main-grid">
            <Card className="span-2">
              <div className="title-lg">Student dashboard</div>
              <div className="metric-grid four">
                <Metric label="Saved sessions" value={String(savedSessions.length)} />
                <Metric label="Selected for submission" value={`${selectedFinalIds.length} / 4`} />
                <Metric label="Distinct selected scenarios" value={String(distinctSelectedScenarios.length)} />
                <Metric label="Submission status" value={finalSubmitted ? 'Submitted' : 'Open'} />
              </div>
              <div className="panel">
                <div className="panel-title">Rules reminder</div>
                <div className="panel-list">
                  <div>Submit exactly four completed sessions.</div>
                  <div>Use at least two different scenarios across the final four.</div>
                  <div>Each selected session should contain exactly 10 trades and include both calls and puts.</div>
                  <div>The written rationale is submitted separately on SurreyLearn.</div>
                </div>
              </div>
              <div className="button-row wrap">
                <button className="button" onClick={() => setScreen('scenarios')}><PlayCircle size={16} /> Start new session</button>
                <button className="button secondary" onClick={() => setScreen('library')}>View saved sessions</button>
                <button className="button secondary" onClick={() => setScreen('submit')}>Select best four</button>
                <button className="button secondary" onClick={resetAllSessions}>Reset all sessions</button>
              </div>
            </Card>
            <Card>
              <div className="title-lg">Scenario progress</div>
              <div className="stack">
                {savedByScenario.map((s) => (
                  <div key={s.code} className="panel small">
                    <div className="panel-title">{s.code}</div>
                    <div>Saved attempts: {s.count}</div>
                    <div>Best score: {formatNum(s.best, 1)}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        {screen === 'scenarios' && (
          <Card>
            <div className="title-lg">Scenario selection</div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Scenario</th><th>Description</th><th>Initial vol</th><th>Previous attempts</th><th>Best score</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {scenarios.map((s) => {
                    const prior = savedSessions.filter((x) => x.scenarioCode === s.assessmentCode)
                    return (
                      <tr key={s.assessmentCode}>
                        <td><strong>{s.label}</strong></td>
                        <td>{s.description}</td>
                        <td>{(s.vol * 100).toFixed(1)}%</td>
                        <td>{prior.length}</td>
                        <td>{formatNum(prior.reduce((m, x) => Math.max(m, x.scorecard.total), 0), 1)}</td>
                        <td><button className="button small" onClick={() => beginScenario(s.assessmentCode)}>Start</button></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Warning text="To satisfy final submission rules, the selected best four must include at least two different scenarios." />
          </Card>
        )}

        {screen === 'session' && (
          <div className="main-grid">
            <Card className="span-2">
              <div className="title-lg">Live trading session</div>
              <div className="metric-grid four">
                <Metric label="Scenario" value={activeScenario.assessmentCode} />
                <Metric label="Spot" value={formatMoney(marketState.currentSpot)} />
                <Metric label="Implied vol" value={`${(marketState.currentVol * 100).toFixed(1)}%`} />
                <Metric label="Time to expiry" value={`${Math.max(1, activeScenario.daysToExpiry - marketState.elapsedTrades)} days`} />
              </div>
              <div className="button-row wrap">
                {!attemptStarted && !sessionFinished && <button className="button" onClick={startSession}>Start session</button>}
                <button className="button secondary" onClick={finishSession} disabled={activity.length === 0}>Finish session</button>
                <button className="button secondary" onClick={() => setScreen('summary')}>Session summary</button>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Type</th><th>Strike</th><th>Bid</th><th>Ask</th><th>Delta</th><th>Gamma</th><th>Theta</th><th>Vega</th><th>Trade</th>
                    </tr>
                  </thead>
                  <tbody>
                    {optionChain.map((o) => (
                      <tr key={o.id}>
                        <td><span className={`pill ${o.type === 'call' ? 'pill-call' : 'pill-put'}`}>{o.type.toUpperCase()}</span></td>
                        <td>{o.strike}</td>
                        <td>{formatNum(o.bid, 3)}</td>
                        <td>{formatNum(o.ask, 3)}</td>
                        <td>{formatNum(o.delta, 3)}</td>
                        <td>{formatNum(o.gamma, 3)}</td>
                        <td>{formatNum(o.theta, 3)}</td>
                        <td>{formatNum(o.vega, 3)}</td>
                        <td>
                          <div className="button-row">
                            <button className="button small" onClick={() => trade(o, 'buy')} disabled={!attemptStarted || sessionFinished || tradeCount >= activeScenario.maxTrades}>Buy</button>
                            <button className="button secondary small" onClick={() => trade(o, 'sell')} disabled={!attemptStarted || sessionFinished || tradeCount >= activeScenario.maxTrades}>Sell</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <div className="stack">
              <Card>
                <div className="title-lg">Session status</div>
                <InfoRow label="Trades used" value={`${tradeCount} / ${activeScenario.maxTrades}`} />
                <InfoRow label="Call trades" value={String(callTrades)} />
                <InfoRow label="Put trades" value={String(putTrades)} />
                <InfoRow label="Cash" value={formatMoney(cash)} />
                <InfoRow label="Equity" value={formatMoney(portfolio.equity)} />
                <InfoRow label="P&L" value={formatMoney(portfolio.pnl)} />
                <InfoRow label="Delta" value={formatNum(portfolio.delta, 1)} />
                <InfoRow label="Gamma" value={formatNum(portfolio.gamma, 2)} />
                <InfoRow label="Theta" value={formatNum(portfolio.theta, 2)} />
                <InfoRow label="Vega" value={formatNum(portfolio.vega, 1)} />
              </Card>
              <Card>
                <div className="title-lg">Live feedback</div>
                <div className="panel small">{latestTradeInsight || 'Trade feedback appears here after each trade.'}</div>
                <div className="panel small muted-panel">
                  {practiceMode
                    ? 'Practice mode is active. Students can experiment, save, and later decide which completed sessions are strong enough to submit.'
                    : 'Assessment mode is active. The final selected four should include at least two different scenarios.'}
                </div>
              </Card>
            </div>
          </div>
        )}

        {screen === 'summary' && (
          <Card>
            <div className="title-lg">Session summary and save</div>
            <div className="metric-grid four">
              <Metric label="Scenario" value={activeScenario.assessmentCode} />
              <Metric label="Trades" value={`${tradeCount} / ${activeScenario.maxTrades}`} />
              <Metric label="Call / Put" value={`${callTrades} / ${putTrades}`} />
              <Metric label="Score" value={`${formatNum(scorecard.total, 1)} / 100`} />
            </div>
            <div className="metric-grid three">
              <Metric label="Volatility response" value={`${formatNum(scorecard.volatilityResponseScore, 1)} / 5`} />
              <Metric label="Instrument coverage" value={`${formatNum(scorecard.instrumentCoverageScore, 1)} / 5`} />
              <Metric label="Final P&L" value={formatMoney(portfolio.pnl)} />
            </div>
            <div className="panel">
              <div className="panel-title">End-of-session feedback</div>
              <div className="panel-list">
                {generateSessionFeedback({ portfolio, tradeCount, scenario: activeScenario, scorecard, callTrades, putTrades }).map((msg, idx) => <div key={idx}>{msg}</div>)}
              </div>
            </div>
            <div className="button-row wrap">
              <button className="button" onClick={saveCompletedSession}><Save size={16} /> Save completed session</button>
              <button className="button secondary" onClick={() => setScreen('session')}>Return to session</button>
              <button className="button secondary" onClick={() => setScreen('dashboard')}>Return to dashboard</button>
            </div>
          </Card>
        )}

        {screen === 'library' && (
          <Card>
            <div className="title-lg">Saved sessions library</div>
            <div className="button-row wrap">
              <button className="button secondary" onClick={downloadCsv}><Download size={16} /> Download session CSV</button>
              <button className="button secondary" onClick={() => setScreen('submit')}>Go to final submission</button>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Select</th><th>Session</th><th>Scenario</th><th>Date</th><th>Score</th><th>Vol score</th><th>P&L</th><th>Calls/Puts</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {savedSessions.length === 0 ? (
                    <tr><td colSpan="9">No saved sessions yet.</td></tr>
                  ) : savedSessions.map((s) => (
                    <tr key={s.sessionId}>
                      <td><input type="checkbox" checked={selectedFinalIds.includes(s.sessionId)} onChange={() => toggleSelectedFinal(s.sessionId)} /></td>
                      <td><strong>{s.sessionId}</strong></td>
                      <td>{s.scenarioCode}</td>
                      <td>{s.createdAt}</td>
                      <td>{formatNum(s.scorecard.total, 1)}</td>
                      <td>{formatNum(s.scorecard.volatilityResponseScore, 1)}</td>
                      <td>{formatMoney(s.portfolio.pnl)}</td>
                      <td>{s.callTrades}/{s.putTrades}</td>
                      <td>{selectedFinalIds.includes(s.sessionId) ? <span className="pill pill-call">Selected</span> : <span className="pill">Saved</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel small muted-panel">
              Currently selected: {selectedFinalIds.length} sessions. Distinct scenarios among selected sessions: {distinctSelectedScenarios.length}.
            </div>
          </Card>
        )}

        {screen === 'submit' && (
          <Card>
            <div className="title-lg">Final submission screen</div>
            <div className="metric-grid four">
              <Metric label="Selected sessions" value={`${selectedFinalIds.length} / 4`} />
              <Metric label="Distinct scenarios" value={String(distinctSelectedScenarios.length)} />
              <Metric label="Rule satisfied" value={canSubmitFinal || finalSubmitted ? 'Yes' : 'No'} />
              <Metric label="Rationale" value="Submit separately" />
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Session</th><th>Scenario</th><th>Score</th><th>Vol score</th><th>P&L</th><th>Calls/Puts</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedSessions.length === 0 ? (
                    <tr><td colSpan="6">No sessions selected yet.</td></tr>
                  ) : selectedSessions.map((s) => (
                    <tr key={s.sessionId}>
                      <td><strong>{s.sessionId}</strong></td>
                      <td>{s.scenarioCode}</td>
                      <td>{formatNum(s.scorecard.total, 1)}</td>
                      <td>{formatNum(s.scorecard.volatilityResponseScore, 1)}</td>
                      <td>{formatMoney(s.portfolio.pnl)}</td>
                      <td>{s.callTrades}/{s.putTrades}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {selectedFinalIds.length !== 4 && <Warning text="You must select exactly four sessions before final submission." />}
            {distinctSelectedScenarios.length < 2 && <Warning text="Your selected sessions must include at least two different scenarios." />}
            {finalSubmitted && (
              <div className="success-box"><Lock size={16} /> The selected four sessions are now locked for marking.</div>
            )}
            <div className="button-row wrap">
              <button className="button" onClick={confirmFinalFour} disabled={!canSubmitFinal}>Confirm selected four</button>
              <button className="button secondary" onClick={() => setScreen('library')}>Return to saved sessions</button>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}

function Card({ children, className = '' }) {
  return <div className={`card ${className}`}>{children}</div>
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
    </label>
  )
}

function StatCard({ title, value, icon }) {
  return (
    <Card>
      <div className="title-sm with-icon">{icon}{title}</div>
      <div className="big-number">{value}</div>
    </Card>
  )
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  )
}

function InfoRow({ label, value }) {
  return <div className="info-row"><span>{label}</span><strong>{value}</strong></div>
}

function Warning({ text }) {
  return (
    <div className="warning-box"><AlertTriangle size={16} /> {text}</div>
  )
}
