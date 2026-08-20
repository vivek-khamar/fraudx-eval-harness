'use strict';

const { formatAnswerWithCitations } = require('./extract-cited-file-names');

// Ported verbatim from the reference report's <style> block
// (/home/vivek/Downloads/claim_eval_report.html) — the navy/lime brand
// palette, card/chip/table/chart styling, and its @media print rules
// (which already assume this HTML gets printed to PDF).
const REPORT_CSS = `
  :root{
    --navy:#1e2547; --lime:#a3e635; --lime-2:#84cc16;
    --page:#f4f5f7; --surface:#ffffff; --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
    --grid:#e7e8ec; --border:rgba(11,11,11,0.10);
    --blue:#2a78d6; --aqua:#1baf7a; --violet:#4a3aa7;
    --good:#0ca30c; --good-ink:#0a7d0a; --warning:#fab219; --critical:#d03b3b;
    --detected-bg:#fdecec; --notdet-bg:#e9f7e9;
    --notsure-bg:#fbf4dd;
    --radius:16px;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    background:var(--page); color:var(--ink);
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    line-height:1.5; -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:900px;margin:0 auto;padding:28px 22px 80px}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;
    background:rgba(11,11,11,.05);padding:1px 5px;border-radius:5px}
  .hero{
    background:var(--navy); border-radius:var(--radius); color:#fff;
    padding:30px 32px 28px; position:relative; overflow:hidden;
    box-shadow:0 1px 3px rgba(0,0,0,.08);
  }
  .hero::before{content:"";position:absolute;top:0;left:0;right:0;height:6px;
    background:linear-gradient(90deg,var(--lime),var(--lime-2))}
  .hero-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
  .brand{font-size:15px;font-weight:800;letter-spacing:.5px;color:#fff;display:flex;align-items:center;gap:8px}
  .brand small{display:block;font-size:8.5px;font-weight:600;letter-spacing:2px;color:#7f88b5;margin-top:2px}
  .pill{background:var(--lime);color:#1b2a05;font-weight:700;font-size:12.5px;
    padding:6px 14px;border-radius:999px;white-space:nowrap}
  .pillwrap{display:flex;flex-direction:column;gap:8px;align-items:flex-end}
  .pill.match{background:var(--lime);color:#1b2a05;font-size:14px;padding:9px 18px;
    box-shadow:0 0 0 4px rgba(163,230,53,.22)}
  .pill.match b{font-size:17px}
  .card.hl{background:linear-gradient(180deg,#f1fce0,#ffffff);border:1.5px solid var(--lime-2);
    box-shadow:0 0 0 3px rgba(132,204,22,.14)}
  .card.hl .tag{display:inline-block;font-size:8.5px;font-weight:800;letter-spacing:1.2px;
    color:#4d7a08;background:#e4f7bf;border-radius:6px;padding:2px 7px;margin-bottom:8px}
  .kicker{font-size:11px;font-weight:700;letter-spacing:2px;color:#8b93bf;margin:20px 0 6px}
  h1.title{font-size:30px;font-weight:800;margin:0 0 8px;letter-spacing:-.5px}
  .subtitle{color:#c3c8e0;font-size:14px;margin:0;max-width:640px}
  .meta-row{display:grid;grid-template-columns:repeat(4,1fr);gap:18px 26px;margin-top:24px;
    border-top:1px solid rgba(255,255,255,.13);padding-top:20px}
  .meta-row .m-lab{font-size:9.5px;font-weight:700;letter-spacing:1.5px;color:#7f88b5;margin-bottom:4px}
  .meta-row .m-val{font-size:14px;font-weight:600;color:#eef0f8}
  section{margin-top:40px}
  .sec-head{display:flex;align-items:baseline;gap:12px;margin:0 0 4px;
    padding-bottom:10px;border-bottom:2px solid var(--ink);}
  .sec-num{font-size:13px;font-weight:800;color:#fff;background:var(--navy);
    border-radius:8px;padding:3px 9px;line-height:1.2}
  h2{font-size:21px;font-weight:800;margin:0;letter-spacing:-.3px}
  .sec-sub{color:var(--ink-2);font-size:13.5px;margin:12px 0 0}
  .cards{display:grid;gap:14px;margin-top:18px}
  .cards.c4{grid-template-columns:repeat(4,1fr)}
  .cards.c3{grid-template-columns:repeat(3,1fr)}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:14px;
    padding:16px 16px 14px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
  .card .big{font-size:30px;font-weight:800;letter-spacing:-1px;line-height:1}
  .card .lab{font-size:11.5px;color:var(--ink-2);margin-top:8px;line-height:1.35}
  .card .sub{font-size:10.5px;color:var(--muted);margin-top:3px}
  .big.green{color:var(--good-ink)} .big.red{color:var(--critical)}
  .big.amber{color:#b6820a} .big.blue{color:var(--blue)}
  .callout{border-radius:14px;padding:18px 20px;font-size:13.5px;line-height:1.6;margin-top:18px;
    border:1px solid var(--border);background:var(--surface)}
  .callout.verdict{border-left:5px solid var(--good);background:#f2fbf2}
  .callout.info{border-left:5px solid var(--blue);background:#eef5fd}
  .callout h4{margin:0 0 6px;font-size:13px;font-weight:800}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:18px}
  .panel{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px}
  .panel h4{margin:0 0 10px;font-size:13.5px;font-weight:800;display:flex;align-items:center;gap:8px}
  .panel ul{margin:0;padding-left:18px} .panel li{margin:6px 0;font-size:13px;line-height:1.5}
  .dot{width:9px;height:9px;border-radius:3px;display:inline-block}
  .chart-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;
    padding:18px 20px 16px;margin-top:18px}
  .chart-card h4{margin:0 0 2px;font-size:14px;font-weight:800}
  .chart-card .cap{font-size:11.5px;color:var(--muted);margin:10px 0 0;line-height:1.45}
  .legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:11.5px;color:var(--ink-2)}
  .legend span{display:flex;align-items:center;gap:6px}
  svg{display:block;max-width:100%;height:auto;overflow:visible}
  table{width:100%;border-collapse:collapse;margin-top:16px;font-size:12.5px;
    background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}
  thead th{background:#f1f2f5;text-align:left;padding:10px 12px;font-size:10.5px;
    font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--ink-2);
    border-bottom:1px solid var(--border)}
  tbody td{padding:9px 12px;border-bottom:1px solid #eef0f3;vertical-align:middle}
  tbody tr:last-child td{border-bottom:none}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  td.ctr,th.ctr{text-align:center}
  .tot td{font-weight:800;background:#f7f8fa}
  .row-miss{background:#fdf2f2}
  .chip{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:700;
    padding:3px 9px;border-radius:999px;white-space:nowrap;line-height:1.3}
  .chip.det{color:#a01d1d;background:var(--detected-bg)}
  .chip.nd{color:#0a6b0a;background:var(--notdet-bg)}
  .chip.ns{color:#7a6b1e;background:var(--notsure-bg)}
  .chip.yes{color:#0a6b0a;background:var(--notdet-bg)}
  .chip.no{color:#a01d1d;background:var(--detected-bg)}
  .mini{font-size:11px;font-weight:700}
  .mbar{display:inline-block;width:52px;height:7px;border-radius:4px;background:#eef0f3;
    position:relative;vertical-align:middle;margin-right:7px;overflow:hidden}
  .mbar i{position:absolute;left:0;top:0;bottom:0;border-radius:4px}
  .qcard{background:var(--surface);border:1px solid var(--border);border-radius:14px;
    padding:16px 18px;margin-top:14px}
  .qcard .qtop{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
  .qid{font-size:12px;font-weight:800;color:#fff;background:var(--navy);border-radius:7px;
    padding:3px 8px;flex:none}
  .qtext{font-size:14px;font-weight:700;flex:1;min-width:60%;line-height:1.4}
  .qchips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  .verdict-line{margin-top:12px;padding:9px 12px;border-radius:10px;font-size:12.5px;
    font-weight:600;display:flex;gap:8px;align-items:flex-start}
  .verdict-line.good{background:#eefaef;color:#0a5f0a;border-left:3px solid var(--good)}
  .verdict-line.bad{background:#fdf0f0;color:#8f1f1f;border-left:3px solid var(--critical)}
  .verdict-line.mid{background:#fdf8e7;color:#7a5c05;border-left:3px solid var(--warning)}
  .ans{font-size:12.8px;color:#26262a;margin:12px 0 0;line-height:1.6}
  sup.c{color:var(--blue);font-weight:700;font-size:10px}
  .reason{font-size:12px;color:var(--ink-2);margin:10px 0 0;line-height:1.55;
    background:#fafafa;border:1px solid #eee;border-radius:9px;padding:9px 12px}
  .reason b{color:var(--ink)}
  .srcs{font-size:11px;color:var(--muted);margin:10px 0 0;line-height:1.7}
  .srcs a{color:var(--blue);text-decoration:none;border-bottom:1px dotted var(--blue)}
  .srcs .idx{color:var(--ink-2);font-weight:700}
  .metrics-inline{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:11px;color:var(--ink-2)}
  .metrics-inline b{color:var(--ink)}
  .foot{margin-top:44px;padding-top:16px;border-top:1px solid var(--border);
    font-size:11px;color:var(--muted);line-height:1.6}
  @media print{
    body{background:#fff} .wrap{max-width:100%}
    .qcard,.card,.chart-card,.panel,table{break-inside:avoid}
    section{break-inside:avoid-page}
  }
`;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// !riskStatusMatches always outweighs a high score — a semantically rich
// answer that points the wrong risk direction is still a miss for this
// report's purposes. Reproduces every row of the reference report's own
// vk column for its sample 35-question dataset.
function verdictKind(entry) {
  if (!entry.riskStatusMatches) return 'bad';
  return entry.score >= 80 ? 'good' : 'mid';
}

function computeRiskStatusMatchCounts(perQuestionBreakdown) {
  const matched = perQuestionBreakdown.filter((e) => e.riskStatusMatches).length;
  return { matched, mismatched: perQuestionBreakdown.length - matched };
}

const RISK_CODE = { RISK_DETECTED: 'det', RISK_NOT_DETECTED: 'nd', UNSURE: 'ns' };

function computeRiskDistribution(perQuestionBreakdown) {
  const model = { det: 0, nd: 0, ns: 0 };
  const gold = { det: 0, nd: 0, ns: 0 };
  for (const entry of perQuestionBreakdown) {
    const modelCode = RISK_CODE[entry.riskStatus];
    const goldCode = RISK_CODE[entry.expectedRiskStatus];
    if (modelCode) model[modelCode] += 1;
    if (goldCode) gold[goldCode] += 1;
  }
  return { model, gold };
}

const SEMANTIC_BUCKET_LABELS = ['0-20', '21-40', '41-60', '61-80', '81-100'];

function semanticBucketIndex(score) {
  if (score <= 20) return 0;
  if (score <= 40) return 1;
  if (score <= 60) return 2;
  if (score <= 80) return 3;
  return 4;
}

function computeSemanticBuckets(perQuestionBreakdown) {
  const matched = [0, 0, 0, 0, 0];
  const mismatched = [0, 0, 0, 0, 0];
  for (const entry of perQuestionBreakdown) {
    if (typeof entry.score !== 'number') continue;
    const i = semanticBucketIndex(entry.score);
    if (entry.riskStatusMatches) matched[i] += 1;
    else mismatched[i] += 1;
  }
  const total = matched.map((m, i) => m + mismatched[i]);
  return { labels: SEMANTIC_BUCKET_LABELS, matched, mismatched, total };
}

const GOLD_CATEGORY_ORDER = [
  { code: 'det', label: 'Gold: Risk Detected' },
  { code: 'ns', label: 'Gold: Not Sure' },
  { code: 'nd', label: 'Gold: Not Detected' },
];

function computeSemanticByGoldCategory(perQuestionBreakdown) {
  const scoresByCode = { det: [], ns: [], nd: [] };
  for (const entry of perQuestionBreakdown) {
    const code = RISK_CODE[entry.expectedRiskStatus];
    if (code && typeof entry.score === 'number') scoresByCode[code].push(entry.score);
  }
  return GOLD_CATEGORY_ORDER.map(({ code, label }) => {
    const scores = scoresByCode[code];
    const avgScore = scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : 0;
    return { label, count: scores.length, avgScore };
  });
}

function renderRiskStatusMatchBar(matched, mismatched) {
  const total = matched + mismatched;
  const pct = total ? Math.round((matched / total) * 100) : 0;
  return `
    <div class="chart-card">
      <h4>Risk-status match — ${matched} correct, ${mismatched} mismatched</h4>
      <div style="height:26px;border-radius:8px;overflow:hidden;background:#eef0f3;margin-top:12px;display:flex">
        <div style="flex:${matched};background:var(--good);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px">Match &middot; ${matched}</div>
        <div style="flex:${mismatched};background:var(--critical);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px">Mismatch &middot; ${mismatched}</div>
      </div>
      <p class="cap">${pct}% of answers pointed in the correct risk direction.</p>
    </div>`;
}

function renderRiskDistributionChart(distribution) {
  const data = [
    ['Risk Detected', distribution.model.det, distribution.gold.det],
    ['Not Detected', distribution.model.nd, distribution.gold.nd],
    ['Not Sure', distribution.model.ns, distribution.gold.ns],
  ];
  const W = 380, H = 190, pad = { l: 90, r: 20, t: 10, b: 26 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, bh = ih / data.length;
  const maxValue = Math.max(1, ...data.flatMap(([, modelCount, goldCount]) => [modelCount, goldCount]));
  const max = Math.max(5, Math.ceil(maxValue / 5) * 5);

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (let g = 0; g <= 5; g++) {
    const gridValue = (max * g) / 5;
    const x = pad.l + iw * (gridValue / max);
    s += `<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${pad.t + ih}" stroke="var(--grid)"/>`;
    s += `<text x="${x}" y="${H - 8}" font-size="9" fill="var(--muted)" text-anchor="middle">${Math.round(gridValue)}</text>`;
  }
  data.forEach(([label, modelCount, goldCount], i) => {
    const y = pad.t + bh * i + 6;
    const h = (bh - 16) / 2;
    const w1 = iw * (modelCount / max);
    const w2 = iw * (goldCount / max);
    s += `<text x="${pad.l - 8}" y="${y + h}" font-size="10.5" fill="var(--ink-2)" text-anchor="end">${label}</text>`;
    s += `<rect x="${pad.l}" y="${y}" width="${w1}" height="${h}" rx="3" fill="var(--blue)"/>`;
    s += `<text x="${pad.l + w1 + 5}" y="${y + h - 1}" font-size="10" font-weight="700" fill="var(--ink)">${modelCount}</text>`;
    s += `<rect x="${pad.l}" y="${y + h + 3}" width="${w2}" height="${h}" rx="3" fill="var(--muted)"/>`;
    s += `<text x="${pad.l + w2 + 5}" y="${y + h * 2 + 2}" font-size="10" font-weight="700" fill="var(--ink)">${goldCount}</text>`;
  });
  s += `</svg>`;
  return s;
}

function renderSemanticHistogram(buckets) {
  const { labels, matched, mismatched, total } = buckets;
  const W = 380, H = 196, pad = { l: 34, r: 12, t: 14, b: 34 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, bw = iw / total.length;
  const maxValue = Math.max(1, ...total);
  const step = Math.max(1, Math.ceil(maxValue / 4));

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (let g = 0; g <= maxValue; g += step) {
    const y = pad.t + ih - ih * (g / maxValue);
    s += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="var(--grid)"/>`;
    s += `<text x="${pad.l - 6}" y="${y + 3}" font-size="9" fill="var(--muted)" text-anchor="end">${g}</text>`;
  }
  total.forEach((v, i) => {
    const x = pad.l + bw * i + 8, w = bw - 16;
    const hMismatch = ih * (mismatched[i] / maxValue);
    const hMatch = ih * (matched[i] / maxValue);
    const yMismatch = pad.t + ih - hMismatch;
    const yMatch = yMismatch - hMatch - (hMatch && hMismatch ? 2 : 0);
    if (mismatched[i] > 0) s += `<rect x="${x}" y="${yMismatch}" width="${w}" height="${hMismatch}" rx="4" fill="var(--critical)"/>`;
    if (matched[i] > 0) s += `<rect x="${x}" y="${yMatch}" width="${w}" height="${hMatch}" rx="4" fill="var(--good)"/>`;
    if (v > 0) s += `<text x="${x + w / 2}" y="${(matched[i] ? yMatch : yMismatch) - 4}" font-size="11" font-weight="800" fill="var(--ink)" text-anchor="middle">${v}</text>`;
    s += `<text x="${x + w / 2}" y="${H - 18}" font-size="9" fill="var(--muted)" text-anchor="middle">${labels[i]}</text>`;
  });
  s += `<text x="${pad.l + iw / 2}" y="${H - 4}" font-size="8.5" fill="var(--muted)" text-anchor="middle">semantic match % (vs gold answer)</text>`;
  s += `</svg>`;
  return s;
}

function renderSemanticByGoldCategoryChart(categories) {
  const W = 760, H = 170, pad = { l: 150, r: 60, t: 10, b: 22 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, bh = ih / categories.length;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (let g = 0; g <= 100; g += 20) {
    const x = pad.l + iw * (g / 100);
    s += `<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${pad.t + ih}" stroke="var(--grid)"/>`;
    s += `<text x="${x}" y="${H - 6}" font-size="9" fill="var(--muted)" text-anchor="middle">${g}%</text>`;
  }
  categories.forEach(({ label, count, avgScore }, i) => {
    const y = pad.t + bh * i + 10, h = bh - 30;
    s += `<text x="${pad.l - 10}" y="${y + h / 2 - 2}" font-size="11" font-weight="600" fill="var(--ink-2)" text-anchor="end">${escapeHtml(label)}</text>`;
    s += `<text x="${pad.l - 10}" y="${y + h / 2 + 12}" font-size="9" fill="var(--muted)" text-anchor="end">${count} question${count === 1 ? '' : 's'}</text>`;
    s += `<rect x="${pad.l}" y="${y}" width="${iw}" height="${h}" rx="5" fill="var(--grid)"/>`;
    const w = iw * (avgScore / 100);
    if (count > 0) {
      s += `<rect x="${pad.l}" y="${y}" width="${w}" height="${h}" rx="5" fill="var(--blue)"/>`;
      s += `<text x="${pad.l + w + 8}" y="${y + h / 2 + 4}" font-size="12" font-weight="800" fill="var(--ink)">${avgScore}%</text>`;
    } else {
      s += `<text x="${pad.l + 8}" y="${y + h / 2 + 4}" font-size="11" fill="var(--muted)">&mdash; no questions &mdash;</text>`;
    }
  });
  s += `</svg>`;
  return s;
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderHeroHeader(claimData) {
  const docsLine = `${claimData.docsComplete} / ${claimData.docsSubmitted}`;
  const docsPct = claimData.docsSubmitted ? Math.round((claimData.docsComplete / claimData.docsSubmitted) * 100) : 0;
  return `
  <header class="hero">
    <div class="hero-top">
      <div class="brand">FraudX<small>CLAIM EVALUATION</small></div>
      <div class="pillwrap">
        <div class="pill match">OVERALL SCORE&nbsp;&middot;&nbsp;<b>${claimData.accuracy}%</b></div>
      </div>
    </div>
    <div class="kicker">CLAIM EVAL REPORT</div>
    <h1 class="title">${escapeHtml(claimData.claimantName)} &mdash; Fraud Risk Evaluation</h1>
    <p class="subtitle">Automated fraud-risk evaluation of a single claim, scored against the gold rubric for risk direction, answer content, and citation accuracy.</p>
    <div class="meta-row">
      <div><div class="m-lab">BUCKET ID</div><div class="m-val"><code>${claimData.bucketId}</code></div></div>
      <div><div class="m-lab">CLAIMANT</div><div class="m-val">${escapeHtml(claimData.claimantName)}</div></div>
      <div><div class="m-lab">GENERATED</div><div class="m-val">${claimData.generatedAt}</div></div>
      <div><div class="m-lab">DOCS INGESTED</div><div class="m-val">${docsLine} &middot; ${docsPct}%</div></div>
    </div>
  </header>`;
}

function renderKpiCards(claimData) {
  const { namedScores } = claimData;
  const citationPct = namedScores.citationMatch === undefined ? 'N/A' : `${Math.round(namedScores.citationMatch * 100)}%`;
  const delta = ((claimData.fraudRiskScoreActual - claimData.fraudRiskScoreExpected) * 100).toFixed(2);
  const toleranceLabel = claimData.fraudRiskScoreMatches
    ? '<span style="color:var(--good-ink);font-weight:700">within &plusmn;10%</span>'
    : '<span style="color:var(--critical);font-weight:700">outside &plusmn;10%</span>';
  return `
  <div class="cards c4" style="margin-top:20px">
    <div class="card hl"><span class="tag">OVERALL SCORE</span><div class="big" style="color:#4d7a08">${Math.round(namedScores.riskStatusMatch * 100)}%</div><div class="lab"><b>Risk-status match</b></div></div>
    <div class="card"><div class="big amber">${Math.round(namedScores.answerContentMatch * 100)}%</div><div class="lab">Answer-content match</div></div>
    <div class="card"><div class="big red">${citationPct}</div><div class="lab">Citation match</div></div>
    <div class="card"><div class="big blue">${(claimData.fraudRiskScoreActual * 100).toFixed(2)}%</div><div class="lab">Claim risk score <span style="color:var(--muted)">vs gold</span></div><div class="sub">gold ${(claimData.fraudRiskScoreExpected * 100).toFixed(2)}% &middot; ${delta} pts &middot; ${toleranceLabel}</div></div>
  </div>`;
}

function renderIngestionSummary(claimData) {
  const failedList = claimData.failedDocuments.length > 0
    ? `<p class="cap"><b>Failed documents:</b> ${claimData.failedDocuments.map((d) => `${escapeHtml(d.fileName)}: ${escapeHtml(d.error)}`).join('; ')}</p>`
    : '';
  return `
  <section>
    <div class="sec-head"><span class="sec-num">1</span><h2>Ingestion Summary</h2></div>
    <p class="sec-sub">The claim documents for Bucket <code>${claimData.bucketId}</code> were ingested ahead of evaluation.</p>
    <div class="cards c4">
      <div class="card"><div class="big">${claimData.docsSubmitted}</div><div class="lab">Docs submitted</div></div>
      <div class="card"><div class="big green">${claimData.docsComplete}</div><div class="lab">Docs complete</div></div>
      <div class="card"><div class="big ${claimData.docsFailed > 0 ? 'red' : ''}">${claimData.docsFailed}</div><div class="lab">Docs failed</div></div>
      <div class="card"><div class="big">${formatSeconds(claimData.ingestionTimeMs)}</div><div class="lab">Ingestion time</div></div>
    </div>
    ${failedList}
  </section>`;
}

function renderProcessingSummary(claimData) {
  const totalWallMs = claimData.ingestionTimeMs + claimData.processingTimeMs;
  return `
  <section>
    <div class="sec-head"><span class="sec-num">2</span><h2>Processing Summary</h2></div>
    <p class="sec-sub">Time spent turning ingested documents into scored risk answers. Only total ingestion and claim-processing time are emitted; per-step timings are marked <code>N/A</code>.</p>
    <div class="cards c3">
      <div class="card"><div class="big">${formatSeconds(claimData.ingestionTimeMs)}</div><div class="lab">Ingestion time</div></div>
      <div class="card"><div class="big blue">${formatSeconds(claimData.processingTimeMs)}</div><div class="lab">Claim processing time</div></div>
      <div class="card"><div class="big">${formatSeconds(totalWallMs)}</div><div class="lab">Total wall-clock</div></div>
    </div>
    <div class="chart-card">
      <h4>Per-step processing breakdown</h4>
      <table>
        <thead><tr><th>Processing step</th><th class="num">Time taken</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td>Entity / claim profile generation</td><td class="num">N/A</td><td>Not captured in source</td></tr>
          <tr><td>Question answering</td><td class="num">N/A</td><td>Not captured in source</td></tr>
          <tr><td>Citation extraction / matching</td><td class="num">N/A</td><td>Not captured in source</td></tr>
          <tr><td>Summary / metadata generation</td><td class="num">N/A</td><td>Not captured in source</td></tr>
          <tr class="tot"><td>Total claim processing</td><td class="num">${formatSeconds(claimData.processingTimeMs)}</td><td>Only total was emitted</td></tr>
        </tbody>
      </table>
    </div>
  </section>`;
}

function renderBulletList(items) {
  return `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
}

function renderAccuracySummary(claimData) {
  const { perQuestionBreakdown, narrative } = claimData;
  const { matched, mismatched } = computeRiskStatusMatchCounts(perQuestionBreakdown);
  const distribution = computeRiskDistribution(perQuestionBreakdown);
  const buckets = computeSemanticBuckets(perQuestionBreakdown);
  const goldCategories = computeSemanticByGoldCategory(perQuestionBreakdown);

  return `
  <section>
    <div class="sec-head"><span class="sec-num">3</span><h2>Accuracy Summary</h2></div>
    <p class="sec-sub">How well the engine's answers matched the gold rubric.</p>
    <div class="grid2">
      <div class="panel"><h4><span class="dot" style="background:var(--aqua)"></span>Summary</h4>${renderBulletList(narrative.summaryPanel)}</div>
      <div class="panel"><h4><span class="dot" style="background:var(--blue)"></span>Questions</h4>${renderBulletList(narrative.questionsPanel)}</div>
      <div class="panel"><h4><span class="dot" style="background:var(--critical)"></span>Citations</h4>${renderBulletList(narrative.citationsPanel)}</div>
      <div class="panel"><h4><span class="dot" style="background:var(--violet)"></span>Overall</h4>${renderBulletList(narrative.overallPanel)}</div>
    </div>
    ${renderRiskStatusMatchBar(matched, mismatched)}
    <div class="grid2">
      <div class="chart-card" style="margin-top:0">
        <h4>Risk distribution &mdash; model vs gold</h4>
        ${renderRiskDistributionChart(distribution)}
        <div class="legend"><span><span class="dot" style="background:var(--blue)"></span>Model output</span><span><span class="dot" style="background:var(--muted)"></span>Gold expected</span></div>
      </div>
      <div class="chart-card" style="margin-top:0">
        <h4>Semantic match vs gold &mdash; score distribution</h4>
        ${renderSemanticHistogram(buckets)}
        <div class="legend"><span><span class="dot" style="background:var(--good)"></span>Matched gold direction</span><span><span class="dot" style="background:var(--critical)"></span>Missed gold direction</span></div>
      </div>
    </div>
    <div class="chart-card">
      <h4>Semantic match vs the gold dataset &mdash; by expected category</h4>
      ${renderSemanticByGoldCategoryChart(goldCategories)}
      <div class="legend"><span><span class="dot" style="background:var(--blue)"></span>Model avg semantic match</span><span><span class="dot" style="background:var(--grid)"></span>Gold reference (100%)</span></div>
    </div>
  </section>`;
}

function renderFinalVerdict(claimData) {
  const { finalVerdict } = claimData.narrative;
  return `
  <section>
    <div class="sec-head"><span class="sec-num">4</span><h2>Final Verdict</h2></div>
    <div class="callout verdict">
      <h4>Net read</h4>
      ${renderBulletList(finalVerdict.netRead)}
    </div>
    <div class="grid2">
      <div class="panel"><h4 style="color:var(--good-ink)">What went right</h4>${renderBulletList(finalVerdict.whatWentRight)}</div>
      <div class="panel"><h4 style="color:#a01d1d">What went wrong</h4>${renderBulletList(finalVerdict.whatWentWrong)}</div>
    </div>
    <div class="callout info">
      <h4>Reasoning</h4>
      ${escapeHtml(finalVerdict.reasoning)}
    </div>
  </section>`;
}

const RISK_LABEL = { RISK_DETECTED: 'Risk Detected', RISK_NOT_DETECTED: 'Risk Not Detected', UNSURE: 'Not Sure' };

function riskChip(riskStatus) {
  const code = RISK_CODE[riskStatus] || 'ns';
  return `<span class="chip ${code}">${RISK_LABEL[riskStatus] || 'Unknown'}</span>`;
}

function scoreBar(score) {
  if (typeof score !== 'number') return '<span class="mini" style="color:var(--muted)">N/A</span>';
  const color = score >= 80 ? 'var(--good)' : score >= 40 ? 'var(--warning)' : 'var(--critical)';
  return `<span class="mbar"><i style="width:${score}%;background:${color}"></i></span><span class="mini">${score}%</span>`;
}

function renderDetailedResultsTable(claimData) {
  const rows = claimData.perQuestionBreakdown.map((q) => `
    <tr class="${q.riskStatusMatches ? '' : 'row-miss'}">
      <td><b>Q${q.predefinedQuestionId}</b></td>
      <td>${riskChip(q.riskStatus)}</td>
      <td>${riskChip(q.expectedRiskStatus)}</td>
      <td class="ctr"><span class="chip ${q.riskStatusMatches ? 'yes' : 'no'}">${q.riskStatusMatches ? 'MATCH' : 'MISS'}</span></td>
      <td class="num">${scoreBar(q.score)}</td>
      <td class="num">${typeof q.citationMatchScore === 'number' ? `${q.citationMatchScore}%` : '<span style="color:var(--muted)">N/A</span>'}</td>
    </tr>`).join('');
  return `
  <section>
    <div class="sec-head"><h2>Detailed Results Table</h2></div>
    <p class="sec-sub">Every question's current output vs expected output, whether the risk direction matched, and the semantic and citation match scores.</p>
    <table>
      <thead><tr><th>Question ID</th><th>Current Output</th><th>Expected Output</th><th class="ctr">Risk Match</th><th class="num">Semantic Match</th><th class="num">Citation Match</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function renderMetadataMatchTable(claimData) {
  const rows = claimData.metadataMatch.map((m) => `
    <tr>
      <td><b>${escapeHtml(m.field)}</b></td>
      <td>${escapeHtml(m.expected)}</td>
      <td>${escapeHtml(m.actual)}</td>
      <td class="ctr"><span class="chip ${m.matches ? 'yes' : 'no'}">${m.matches ? 'YES' : 'NO'}</span></td>
    </tr>`).join('');
  return `
  <section>
    <div class="sec-head"><h2>Claim Metadata Match</h2></div>
    <table>
      <thead><tr><th>Field</th><th>Expected</th><th>Actual</th><th class="ctr">Match</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function renderQaAppendix(claimData) {
  const cards = claimData.perQuestionBreakdown.map((q) => {
    const kind = verdictKind(q);
    const verdictSymbol = kind === 'good' ? '&#10003;' : kind === 'bad' ? '&#10007;' : '&asymp;';
    const oneLiner = claimData.narrative.perQuestionVerdicts[q.predefinedQuestionId] || '';
    const { cleanedText, legend } = formatAnswerWithCitations(q.actualAnswer);
    const answerHtml = escapeHtml(cleanedText).replace(/\n/g, '<br>').replace(/\[(\d+)\]/g, '<sup class="c">[$1]</sup>');
    const sourcesHtml = legend.length === 0
      ? '<span style="color:var(--muted)">No source document cited</span>'
      : legend.map((l) => l.url
        ? `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.fileName)}</a>&nbsp;<span class="idx">[${l.number}]</span>`
        : `${escapeHtml(l.fileName)}&nbsp;<span class="idx">[${l.number}]</span>`).join(' &middot; ');

    return `
    <div class="qcard">
      <div class="qtop">
        <span class="qid">Q${q.predefinedQuestionId}</span>
        <span class="qtext">${escapeHtml(q.question)}</span>
        <span class="qchips">${riskChip(q.riskStatus)}</span>
      </div>
      <div class="verdict-line ${kind}">${verdictSymbol}&nbsp;${escapeHtml(oneLiner)}</div>
      <p class="ans">${answerHtml}</p>
      <div class="metrics-inline">
        <span>Expected: <b>${RISK_LABEL[q.expectedRiskStatus] || 'Unknown'}</b></span>
        <span>Risk match: <b style="color:${q.riskStatusMatches ? 'var(--good-ink)' : 'var(--critical)'}">${q.riskStatusMatches ? 'Yes' : 'No'}</b></span>
        <span>Semantic: <b>${typeof q.score === 'number' ? `${q.score}%` : 'N/A'}</b></span>
        <span>Citation: <b>${typeof q.citationMatchScore === 'number' ? `${q.citationMatchScore}%` : 'N/A'}</b></span>
      </div>
      <div class="reason"><b>Evaluator reasoning:</b> ${escapeHtml(q.reason)}</div>
      <div class="srcs"><b>Sources:</b> ${sourcesHtml}</div>
    </div>`;
  }).join('');

  return `
  <section>
    <div class="sec-head"><h2>All Questions &mdash; Answers &amp; Evaluation</h2></div>
    <p class="sec-sub">Full engine answer for every question, a highlighted one-line verdict, the evaluator's reasoning, and hyperlinked sources.</p>
    ${cards}
  </section>`;
}

function renderReportHtml(claimData) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Claim Eval Report &middot; Bucket ${claimData.bucketId}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="wrap">
  ${renderHeroHeader(claimData)}
  ${renderKpiCards(claimData)}
  ${renderIngestionSummary(claimData)}
  ${renderProcessingSummary(claimData)}
  ${renderAccuracySummary(claimData)}
  ${renderFinalVerdict(claimData)}
  ${renderDetailedResultsTable(claimData)}
  ${renderMetadataMatchTable(claimData)}
  ${renderQaAppendix(claimData)}
  <div class="foot">Generated ${claimData.generatedAt} by the fraudx-eval-harness eval pipeline.</div>
</div>
</body>
</html>`;
}

module.exports = {
  REPORT_CSS,
  escapeHtml,
  verdictKind,
  computeRiskStatusMatchCounts,
  computeRiskDistribution,
  computeSemanticBuckets,
  computeSemanticByGoldCategory,
  renderRiskStatusMatchBar,
  renderRiskDistributionChart,
  renderSemanticHistogram,
  renderSemanticByGoldCategoryChart,
  formatSeconds,
  renderHeroHeader,
  renderKpiCards,
  renderIngestionSummary,
  renderProcessingSummary,
  renderAccuracySummary,
  renderFinalVerdict,
  renderDetailedResultsTable,
  renderMetadataMatchTable,
  renderQaAppendix,
  renderReportHtml,
};
