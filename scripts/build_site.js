// Builds the project site pages (site/index.html, site/<lang>/index.html) from scripts/site_text.json.
// Usage: node scripts/build_site.js
// Page copy lives in site_text.json (a \n in the headline marks where it breaks). Shared CSS/JS and images are in
// site/assets/ and are edited directly. Published to GitHub Pages by .github/workflows/pages.yml.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const T = JSON.parse(
  fs.readFileSync(path.join(__dirname, "site_text.json"), "utf8")
);

const BASE = "https://tasict.github.io/homebridge-roborock-vacuum/";
const REPO = "https://github.com/tasict/homebridge-roborock-vacuum";
const NPM = "https://www.npmjs.com/package/homebridge-roborock-vacuum";
const UPSTREAM = "https://github.com/copystring/ioBroker.roborock";
const PAYPAL = "https://paypal.me/tasict";
const BOBA = "https://tasict.bobaboba.me";

// [hreflang, directory, html lang, native name, og locale]
const LANGS = [
  ["en", "", "en", "English", "en_US"],
  ["zh-TW", "zh-TW/", "zh-Hant-TW", "繁體中文", "zh_TW"],
  ["ja", "ja/", "ja", "日本語", "ja_JP"],
];

const GLOBE =
  '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="7.5"/><path d="M2.5 10h15M10 2.5c2.2 2.3 3.2 4.8 3.2 7.5s-1 5.2-3.2 7.5c-2.2-2.3-3.2-4.8-3.2-7.5s1-5.2 3.2-7.5z"/></svg>';
// A robot vacuum seen from above: bumper, body and the laser turret, as in the plugin icon.
const ROBOT =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12.5" r="8"/><path d="M5.2 6.6a9.6 9.6 0 0 1 13.6 0"/><circle cx="12" cy="9.2" r="2.2"/></svg>';
const PHONE =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M9.5 12 12 9.8l2.5 2.2M10.3 11.3v3.2h3.4v-3.2"/></svg>';
const HUB =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="6" rx="1.5"/><rect x="3" y="13" width="18" height="6" rx="1.5"/><path d="M7 8h.01M7 16h.01"/></svg>';

// The hero's floor plan. Rooms are separated by 10-unit walls; doors are gaps the vacuum drives through. site.js reads
// the same geometry back from the data attributes, so the plan and the vacuum's route stay in one place.
const ROOMS = [
  // [key, x, y, width, height]
  ["living", 20, 20, 255, 145],
  ["kitchen", 285, 20, 175, 120],
  ["bedroom", 285, 150, 175, 130],
  ["study", 20, 175, 255, 105],
];
const DOORS = [
  // [room, room, door centre x, y, door rect x, y, width, height]
  ["living", "kitchen", 280, 105, 275, 85, 10, 40],
  ["living", "study", 215, 170, 190, 165, 50, 10],
  ["kitchen", "bedroom", 372, 145, 347, 140, 50, 10],
  ["study", "bedroom", 280, 228, 275, 208, 10, 40],
];
const DOCK = [42, 62];

function plan(t) {
  const rooms = ROOMS.map(
    ([k, x, y, w, h]) =>
      `<g class="area" data-room="${k}" data-rect="${x} ${y} ${w} ${h}">` +
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>` +
      `<text x="${x + w / 2}" y="${y + h / 2}">${e(t.rooms[k])}</text></g>`
  ).join("\n        ");
  const doors = DOORS.map(
    ([a, b, cx, cy, x, y, w, h]) =>
      `<rect class="door" data-door="${a} ${b} ${cx} ${cy}" x="${x}" y="${y}" width="${w}" height="${h}"/>`
  ).join("\n        ");
  return `<svg class="plan" viewBox="0 0 480 300" role="img" aria-label="${e(t.map_alt)}">
      <rect class="walls" x="10" y="10" width="460" height="280" rx="14"/>
      <g class="areas">
        ${rooms}
      </g>
      <g class="doors">
        ${doors}
      </g>
      <path class="trail" d=""/>
      <rect class="dock" x="20" y="46" width="9" height="32" rx="3"/>
      <g class="bot" data-dock="${DOCK.join(" ")}" transform="translate(${DOCK.join(" ")})">
        <circle class="bot-body" r="12"/>
        <path class="bot-bumper" d="M-9.5 -6.5a11.5 11.5 0 0 1 19 0"/>
        <circle class="bot-eye" cy="-4" r="3.4"/>
      </g>
    </svg>`;
}

// Root page only: send first-time visitors to their browser language; an explicit choice (saved by site.js) wins.
const REDIRECT = `<script>
try {
  if (!localStorage.getItem('lang')) {
    const pick = tag => {
      const t = tag.toLowerCase();
      if (t.startsWith('zh')) return 'zh-TW';
      return ['ja', 'en'].find(l => t.startsWith(l));
    };
    const lang = (navigator.languages || [navigator.language]).map(pick).find(Boolean);
    if (lang && lang !== 'en') location.replace(lang + '/' + location.search + location.hash);
  }
} catch { /* storage blocked: stay on English */ }
</script>
`;

const ESC = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};
function e(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

function page([code, dir, htmlLang, native, og]) {
  const t = T[code];
  const up = dir ? "../" : "";
  const a = `${up}assets/`;

  const alts = LANGS.map(
    ([c, d]) => `<link rel="alternate" hreflang="${c}" href="${BASE}${d}">`
  ).join("\n");
  const menu = LANGS.map(
    ([c, d, hl, nm]) =>
      `<li><a href="${up + d || "./"}" hreflang="${c}" lang="${hl}"${c === code ? ' aria-current="page"' : ""}>${e(nm)}</a></li>`
  ).join("");
  const pairs = (items, tag = "li") =>
    items
      .map(([h, p]) => `<${tag}><h3>${e(h)}</h3><p>${e(p)}</p></${tag}>`)
      .join("");

  // Demo strings for site.js.
  const demoText = {
    rooms: t.rooms,
    st: {
      docked: t.st_docked,
      charging: t.st_charging,
      cleaning: t.st_cleaning,
      returning: t.st_returning,
      paused: t.st_paused,
    },
    start: t.start,
    pause: t.pause,
    all: t.rooms_all,
    some: t.rooms_some,
    battery: t.battery,
  };
  const chips = ROOMS.map(
    ([k]) =>
      `<button type="button" class="chip-btn" data-pick="${k}" aria-pressed="false">${e(t.rooms[k])}</button>`
  ).join("\n            ");

  const flowIcons = [PHONE, HUB, ROBOT];
  const flow = t.flow
    .map(
      ([name, sub], i) =>
        `<li class="node"><span class="node-icon">${flowIcons[i]}</span><strong>${e(name)}</strong><small>${e(sub)}</small></li>` +
        (i < t.flow_links.length
          ? `<li class="link" aria-hidden="true"><span>${e(t.flow_links[i])}</span></li>`
          : "")
    )
    .join("\n        ");

  return `<!doctype html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(t.title)}</title>
<meta name="description" content="${e(t.desc)}">
<link rel="canonical" href="${BASE}${dir}">
${alts}
<link rel="alternate" hreflang="x-default" href="${BASE}">
<meta property="og:type" content="website">
<meta property="og:title" content="${e(t.title)}">
<meta property="og:description" content="${e(t.desc)}">
<meta property="og:url" content="${BASE}${dir}">
<meta property="og:image" content="${BASE}assets/og.png">
<meta property="og:locale" content="${og}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#faf6f4" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1a1413" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${a}icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${a}icon.png">
<link rel="stylesheet" href="${a}site.css">
${dir ? "" : REDIRECT}</head>
<body>
<header class="wrap masthead">
  <a class="wordmark" href="./"><img src="${a}icon.svg" alt="" width="30" height="30">Roborock Vacuum</a>
  <a href="${REPO}">${e(t.source)}</a>
  <a class="tip head-tip" href="${BOBA}" aria-label="${e(t.boba)}"><img src="${a}boba.png" alt="" width="24" height="24"><span>${e(t.boba)}</span></a>
  <details class="lang">
    <summary aria-label="${e(t.lang_menu)}">${GLOBE}<span>${e(native)}</span></summary>
    <ul>${menu}</ul>
  </details>
</header>

<main>
<div class="wrap">
  <section class="hero" aria-labelledby="hero-title">
    <div class="hero-copy">
      <h1 id="hero-title">${e(t.h1).replace(/\n/g, "<br>")}</h1>
      <p class="lede">${e(t.lede)}</p>
      <div class="actions">
        <a class="btn" href="#start">${e(t.cta)}</a>
        <a href="${REPO}">${e(t.github)}</a>
      </div>
      <p class="fine">${e(t.fine)}</p>
    </div>
    <div class="stage" data-demo data-state="docked" data-t='${e(JSON.stringify(demoText))}'>
      ${plan(t)}
      <div class="tile">
        <div class="tile-head">
          <span class="tile-icon">${ROBOT}</span>
          <div class="tile-name"><strong>${e(t.vac)}</strong><span data-status aria-live="polite"></span></div>
          <span class="tile-battery" data-battery></span>
        </div>
        <fieldset class="picks">
          <legend>${e(t.rooms_legend)}<span data-summary></span></legend>
          <div class="chips">
            ${chips}
          </div>
        </fieldset>
        <div class="controls">
          <button type="button" class="go" data-go>${e(t.start)}</button>
          <button type="button" class="home" data-home>${e(t.dock)}</button>
        </div>
      </div>
      <p class="hint">${e(t.demo_hint)}</p>
    </div>
  </section>

  <section class="band" aria-labelledby="h-local">
    <div class="intro">
      <h2 id="h-local">${e(t.local_h2)}</h2>
      <p>${e(t.local_p)}</p>
    </div>
    <ol class="flow">
        ${flow}
    </ol>
    <p class="fine note">${e(t.local_note)}</p>
  </section>

  <section class="band" aria-labelledby="h-feat">
    <div class="intro">
      <h2 id="h-feat">${e(t.feat_h2)}</h2>
      <p>${e(t.feat_p)}</p>
    </div>
    <ul class="feats">${pairs(t.feats)}</ul>
  </section>

  <section class="band" aria-labelledby="h-matter">
    <div class="split">
      <div class="intro">
        <h2 id="h-matter">${e(t.matter_h2)} <span class="chip">${e(t.beta)}</span></h2>
        <p>${e(t.matter_p)}</p>
        <p>${e(t.matter_p2)}</p>
      </div>
      <div class="panel">
        <h3>${e(t.choose_h3)}</h3>
        <p class="panel-p">${e(t.choose_p)}</p>
        <ul class="choices">${pairs(t.choices)}</ul>
        <p class="back">${e(t.switch_note)}</p>
      </div>
    </div>
  </section>

  <section class="band" aria-labelledby="h-dev">
    <div class="intro">
      <h2 id="h-dev">${e(t.dev_h2)}</h2>
      <p>${e(t.dev_p)}</p>
    </div>
    <ul class="models">${t.models.map((m) => `<li>${e(m)}</li>`).join("")}</ul>
    <div class="aside">
      <h3>${e(t.mihome_h3)}</h3>
      <p>${e(t.mihome_p)}</p>
    </div>
  </section>

  <section class="band" id="start" aria-labelledby="h-start">
    <h2 id="h-start">${e(t.start_h2)}</h2>
    <ol class="steps">${pairs(t.steps)}</ol>
    <p class="fine">${e(t.start_note)} <a href="${REPO}#readme">${e(t.docs)}</a></p>
  </section>

  <section class="band" aria-labelledby="h-support">
    <div class="tipjar">
      <img src="${a}boba.png" alt="" width="120" height="120">
      <div>
        <h2 id="h-support">${e(t.support_h2)}</h2>
        <p>${e(t.support_p)}</p>
        <div class="actions">
          <a class="btn" href="${BOBA}"><img src="${a}boba.png" alt="" width="22" height="22">${e(t.boba)}</a>
          <a class="tip" href="${PAYPAL}">${e(t.paypal)}</a>
        </div>
        <p class="fine">${e(t.support_card)}</p>
      </div>
    </div>
  </section>
</div>
</main>

<footer>
  <div class="wrap">
    <div class="foot">
      <div>
        <p>${e(t.made)}</p>
        <ul>
          <li><a href="${REPO}">${e(t.source)}</a></li>
          <li><a href="${NPM}">${e(t.npm)}</a></li>
          <li><a href="${REPO}/blob/master/CHANGELOG.md">${e(t.changelog)}</a></li>
          <li><a href="${REPO}/issues">${e(t.issues)}</a></li>
          <li><a href="${UPSTREAM}">ioBroker.roborock</a></li>
        </ul>
      </div>
      <ul class="langs">${menu}</ul>
    </div>
    <p class="tm">${e(t.tm)}</p>
  </div>
</footer>
<script src="${a}site.js"></script>
</body>
</html>
`;
}

for (const lang of LANGS) {
  const file = path.join(ROOT, "site", lang[1], "index.html");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, page(lang));
  console.log("wrote", path.relative(ROOT, file));
}
