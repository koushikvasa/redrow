// Inline CSS and JS for the HTML report. Nothing here may reach out: the page's CSP forbids
// it, and the report has to work offline, on a projector, from a single file.

export const REPORT_CSS = `
:root {
  --ink: #e8e6df; --dim: #8b8d91; --faint: #4a4d54; --line: #24272d; --panel: #111317; --bg: #0a0b0d;
  --leak: #ff3b30; --ok: #4ade80; --amber: #f5b53d; --info: #5ac8e8;
  --mono: "Cascadia Code", "JetBrains Mono", "SF Mono", "IBM Plex Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html { background: var(--bg); color-scheme: dark; }
body {
  margin: 0; padding: 40px 56px 32px; color: var(--ink); font: 18px/1.5 var(--mono);
  background:
    linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px) 0 0 / 100% 40px,
    linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px) 0 0 / 40px 100%,
    var(--bg);
  min-height: 100vh;
}
.band-bad { --band: var(--leak); } .band-mid { --band: var(--amber); } .band-good { --band: var(--ok); }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 32px;
  border-bottom: 1px solid var(--line); padding-bottom: 14px; }
.brand { font-weight: 700; letter-spacing: .32em; font-size: 20px; }
.brand b { color: var(--leak); font-weight: 700; }
.target { color: var(--dim); font-size: 16px; text-align: right; overflow-wrap: anywhere; }
.hero { display: grid; grid-template-columns: 380px 1fr; gap: 56px; align-items: center; padding: 26px 0 24px; }
.dial { position: relative; width: 380px; height: 380px; }
.dial svg { width: 100%; height: 100%; display: block; }
.tick { stroke: var(--faint); stroke-width: 3; stroke-linecap: round; opacity: .5; }
.tick.lit { stroke: var(--band); opacity: 1; filter: drop-shadow(0 0 3px var(--band));
  animation: light .35s both; animation-delay: calc(var(--i) * 11ms); }
@keyframes light { from { stroke: var(--faint); opacity: .5; filter: none; } }
.readout { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.score-value { font-size: 124px; line-height: 1; font-weight: 700; color: var(--band); font-variant-numeric: tabular-nums; }
.score-max { color: var(--dim); font-size: 18px; letter-spacing: .2em; margin-top: 4px; }
.grade { margin-top: 10px; font-size: 26px; font-weight: 700; border: 2px solid var(--band); color: var(--band);
  padding: 0 14px; letter-spacing: .08em; }
.verdict { font-size: 58px; line-height: 1.06; font-weight: 700; margin: 0 0 26px; letter-spacing: -.01em; }
.verdict em { font-style: normal; color: var(--band); }
.counts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.count { background: var(--panel); border: 1px solid var(--line); border-top: 3px solid var(--faint); padding: 14px 18px; }
.count b { display: block; font-size: 56px; line-height: 1.05; font-variant-numeric: tabular-nums; }
.count span { color: var(--dim); text-transform: uppercase; letter-spacing: .14em; font-size: 15px; }
.count.critical.on { border-top-color: var(--leak); } .count.critical.on b { color: var(--leak); }
.count.high.on { border-top-color: #ff7a59; } .count.high.on b { color: #ff7a59; }
.count.medium.on { border-top-color: var(--amber); } .count.medium.on b { color: var(--amber); }
.count.low.on { border-top-color: var(--dim); }
.count:not(.on) b { color: var(--faint); }
.meta { margin: 16px 0 0; color: var(--dim); font-size: 16px; }
.notice { margin: 10px 0 0; color: var(--amber); font-size: 16px; }
h2 { font-size: 16px; letter-spacing: .3em; text-transform: uppercase; color: var(--dim); font-weight: 600;
  margin: 28px 0 14px; display: flex; justify-content: space-between; gap: 24px; align-items: baseline; }
.legend { letter-spacing: 0; text-transform: none; font-weight: 400; display: flex; gap: 20px; flex-wrap: wrap; font-size: 15px; }
.legend i { display: inline-block; width: 12px; height: 12px; margin-right: 7px; vertical-align: -1px; }
.key-leak { background: var(--leak); } .key-denied { background: rgba(74,222,128,.28); }
.key-own { background: var(--ok); }
.key-na { background: #1b1d22; border: 1px solid var(--line); } .key-declared { background: var(--info); }
.matrix-wrap { overflow-x: auto; overflow-y: hidden; }
table.matrix { border-collapse: separate; border-spacing: 3px; width: 100%; table-layout: fixed; min-width: 1100px; }
.matrix th { font-weight: 500; color: var(--dim); font-size: 15px; padding: 4px 6px; text-align: center; }
.matrix th.group { color: var(--ink); letter-spacing: .14em; font-size: 14px; text-transform: uppercase;
  border-bottom: 1px solid var(--line); padding-bottom: 8px; }
.matrix th.corner { width: 340px; }
.matrix th.row { text-align: left; color: var(--ink); font-size: 18px; overflow-wrap: anywhere; font-weight: 500; }
.cell { height: 52px; text-align: center; font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums;
  animation: cell .4s both; animation-delay: calc(var(--n) * 14ms + 500ms); }
@keyframes cell { from { opacity: 0; transform: translateY(4px); } }
.cell.leak { color: #fff; background: rgba(255,59,48,calc(.32 + .68 * var(--heat))); box-shadow: inset 0 0 0 1px rgba(255,59,48,.8); }
.cell.denied { color: rgba(74,222,128,.7); background: rgba(74,222,128,.09); font-weight: 400; }
.cell.own { color: var(--ok); background: rgba(74,222,128,.16); }
.cell.declared { color: #06222b; background: var(--info); }
.cell.na { color: var(--faint); background: #15171b; font-weight: 400; }
.group-title { font-size: 22px; font-weight: 700; margin: 30px 0 10px; display: flex; gap: 14px; align-items: baseline; }
.group-title small { color: var(--dim); font-weight: 400; font-size: 16px; }
.sev-critical .group-title { color: var(--leak); } .sev-high .group-title { color: #ff7a59; }
.sev-medium .group-title { color: var(--amber); } .sev-low .group-title { color: var(--dim); }
.sev-info .group-title { color: var(--info); }
.finding { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--faint); padding: 14px 20px; margin-bottom: 8px; }
.sev-critical .finding { border-left-color: var(--leak); } .sev-high .finding { border-left-color: #ff7a59; }
.sev-medium .finding { border-left-color: var(--amber); } .sev-info .finding { border-left-color: var(--info); }
.finding-head { display: flex; gap: 16px; flex-wrap: wrap; align-items: baseline; }
.rule { font-weight: 700; } .where { color: var(--ink); overflow-wrap: anywhere; }
.proof { margin-left: auto; color: var(--dim); font-size: 15px; overflow-wrap: anywhere; }
.impact { margin: 8px 0 10px; color: #c9c8c2; overflow-wrap: anywhere; }
.policy { color: var(--dim); font-size: 15px; margin: 0 0 8px; overflow-wrap: anywhere; }
.fix { display: flex; gap: 12px; align-items: flex-start; }
.fix code { flex: 1; display: block; background: #07080a; border: 1px solid var(--line); padding: 8px 12px; color: #a9d5b5;
  font: 15px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.copy { background: none; border: 1px solid var(--faint); color: var(--dim); font: 14px var(--mono); padding: 8px 12px; cursor: pointer; }
.copy:hover, .copy:focus-visible { color: var(--ink); border-color: var(--ink); }
.none { color: var(--ok); font-size: 22px; padding: 18px 0; }
footer { margin-top: 36px; padding-top: 16px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; gap: 24px;
  flex-wrap: wrap; color: var(--dim); font-size: 15px; }
footer strong { color: var(--ink); font-weight: 600; }
@media (max-width: 1100px) {
  body { padding: 24px 20px; }
  .hero { grid-template-columns: 1fr; justify-items: center; }
  .verdict { font-size: 40px; text-align: center; }
  .counts { width: 100%; grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (prefers-reduced-motion: reduce) { .tick.lit, .cell { animation: none; } }
`

// Counts up to the number already in the markup, so the page is correct before and without this.
export const REPORT_JS = `
(function () {
  var value = document.querySelector('.score-value');
  var target = Number(value.getAttribute('data-score'));
  var calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!calm && target > 0) {
    var start = performance.now();
    var duration = target * 11 + 350;
    var step = function (now) {
      var done = Math.min(1, (now - start) / duration);
      value.textContent = String(Math.round(target * done));
      if (done < 1) requestAnimationFrame(step);
    };
    value.textContent = '0';
    requestAnimationFrame(step);
  }
  document.addEventListener('click', function (event) {
    var button = event.target.closest('.copy');
    if (!button) return;
    var code = button.parentElement.querySelector('code');
    navigator.clipboard.writeText(code.textContent).then(function () {
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = 'Copy'; }, 1500);
    });
  });
})();
`
