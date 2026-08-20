'use strict';

// Ported verbatim from the reference report's <style> block
// (/home/vivek/Downloads/claim_eval_report.html) — the navy/lime brand
// palette, card/chip/table/chart styling, and its @media print rules
// (which already assume this HTML gets printed to PDF).
const REPORT_CSS = `
  :root{
    --navy:#1e2547; --navy-2:#252d54; --lime:#a3e635; --lime-2:#84cc16;
    --page:#f4f5f7; --surface:#ffffff; --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
    --grid:#e7e8ec; --border:rgba(11,11,11,0.10);
    --blue:#2a78d6; --orange:#eb6834; --aqua:#1baf7a; --yellow:#eda100; --violet:#4a3aa7;
    --good:#0ca30c; --good-ink:#0a7d0a; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
    --detected:#d03b3b; --detected-bg:#fdecec; --notdet:#0ca30c; --notdet-bg:#e9f7e9;
    --notsure:#8a7d3a; --notsure-bg:#fbf4dd;
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
  .subtitle b{color:#fff}
  .meta-row{display:grid;grid-template-columns:repeat(3,1fr);gap:18px 26px;margin-top:24px;
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
    if (code) scoresByCode[code].push(entry.score);
  }
  return GOLD_CATEGORY_ORDER.map(({ code, label }) => {
    const scores = scoresByCode[code];
    const avgScore = scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : 0;
    return { label, count: scores.length, avgScore };
  });
}

module.exports = {
  REPORT_CSS,
  escapeHtml,
  verdictKind,
  computeRiskStatusMatchCounts,
  computeRiskDistribution,
  computeSemanticBuckets,
  computeSemanticByGoldCategory,
};
