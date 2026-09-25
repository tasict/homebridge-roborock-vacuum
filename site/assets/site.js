// Project site: language choice and the hero's vacuum demo.

// Remember an explicit language choice so the English root page stops redirecting to the browser language.
for (const a of document.querySelectorAll("a[hreflang]")) {
  a.addEventListener("click", () => {
    try {
      localStorage.setItem("lang", a.hreflang);
    } catch {
      /* storage blocked: the choice just isn't remembered */
    }
  });
}

// Close the language menu when clicking elsewhere.
const langMenu = document.querySelector(".lang");
document.addEventListener("click", (e) => {
  if (langMenu?.open && !langMenu.contains(e.target)) langMenu.open = false;
});

// Vacuum demo: pick rooms (none means the whole home), and the vacuum leaves its dock, drives through the doors to
// each room, sweeps it in rows and comes back to charge, the way a Matter room clean looks in the Home app. The
// floor plan and its doors come from the SVG built by scripts/build_site.js.
const stage = document.querySelector("[data-demo]");
if (stage) {
  const text = JSON.parse(stage.dataset.t);
  const svg = stage.querySelector(".plan");
  const bot = svg.querySelector(".bot");
  const trail = svg.querySelector(".trail");
  const goBtn = stage.querySelector("[data-go]");
  const homeBtn = stage.querySelector("[data-home]");
  const chips = [...stage.querySelectorAll("[data-pick]")];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

  const rooms = {};
  for (const g of svg.querySelectorAll("[data-room]")) {
    const [x, y, w, h] = g.dataset.rect.split(" ").map(Number);
    rooms[g.dataset.room] = { x, y, w, h, g };
  }
  const links = {};
  for (const d of svg.querySelectorAll("[data-door]")) {
    const [a, b, x, y] = d.dataset.door.split(" ");
    (links[a] ??= []).push({ to: b, at: [+x, +y] });
    (links[b] ??= []).push({ to: a, at: [+x, +y] });
  }
  const dock = bot.dataset.dock.split(" ").map(Number);
  const DOCK_ROOM = "living";
  const SPEED = 170; // plan units per second
  const PAD = 17; // keeps the vacuum's 12-unit body off the walls
  const ROW = 22;

  // The doors to drive through from one room to another (breadth-first over the door graph).
  function route(from, to) {
    const prev = { [from]: null };
    const queue = [from];
    while (queue.length) {
      const r = queue.shift();
      if (r === to) break;
      for (const l of links[r]) {
        if (!(l.to in prev)) {
          prev[l.to] = { r, at: l.at };
          queue.push(l.to);
        }
      }
    }
    const points = [];
    for (let r = to; prev[r]; r = prev[r].r) points.unshift(prev[r].at);
    return points;
  }

  // Back-and-forth rows across a room, as a vacuum covers it.
  function sweep({ x, y, w, h }) {
    const left = x + PAD,
      right = x + w - PAD,
      top = y + PAD,
      bottom = y + h - PAD;
    const rows = Math.max(1, Math.ceil((bottom - top) / ROW));
    const points = [];
    for (let i = 0; i <= rows; i++) {
      const ry = top + ((bottom - top) * i) / rows;
      points.push(
        ...(i % 2
          ? [
              [right, ry],
              [left, ry],
            ]
          : [
              [left, ry],
              [right, ry],
            ])
      );
    }
    return points;
  }

  function roomAt([px, py]) {
    for (const [k, { x, y, w, h }] of Object.entries(rooms)) {
      if (px >= x - 6 && px <= x + w + 6 && py >= y - 6 && py <= y + h + 6)
        return k;
    }
    return DOCK_ROOM;
  }

  function homeLeg(from) {
    return { kind: "return", points: [...route(from, DOCK_ROOM), dock] };
  }

  let state = "docked"; // docked | cleaning | paused | returning
  let resume = "cleaning";
  let legs = [];
  let leg = 0;
  let step = 0;
  let pos = [...dock];
  let battery = 100;
  let strokes = [];
  const picked = new Set();
  const done = new Set();

  function plan() {
    const targets = Object.keys(rooms).filter(
      (k) => !picked.size || picked.has(k)
    );
    const out = [];
    let at = DOCK_ROOM;
    for (const k of targets) {
      const rows = sweep(rooms[k]);
      out.push({ kind: "travel", room: k, points: [...route(at, k), rows[0]] });
      out.push({ kind: "clean", room: k, points: rows.slice(1) });
      at = k;
    }
    out.push(homeLeg(at));
    return out;
  }

  function status() {
    if (state === "docked")
      return battery < 100 ? text.st.charging : text.st.docked;
    if (state === "cleaning")
      return fill(text.st.cleaning, { room: text.rooms[legs[leg].room] });
    return text.st[state];
  }

  function render() {
    stage.dataset.state = state;
    const moving = state === "cleaning" || state === "returning";
    stage.querySelector("[data-status]").textContent = status();
    stage.querySelector("[data-battery]").textContent = fill(text.battery, {
      b: `${Math.round(battery)}%`,
    });
    stage.querySelector("[data-summary]").textContent = picked.size
      ? fill(text.some, { n: picked.size })
      : text.all;
    goBtn.textContent = moving ? text.pause : text.start;
    homeBtn.disabled = state === "docked" || state === "returning";
    const current = state === "cleaning" ? legs[leg].room : null;
    for (const [k, r] of Object.entries(rooms)) {
      r.g.classList.toggle("sel", picked.has(k));
      r.g.classList.toggle("doing", k === current);
      r.g.classList.toggle("done", done.has(k));
    }
    for (const c of chips) {
      c.setAttribute("aria-pressed", String(picked.has(c.dataset.pick)));
      c.disabled = state !== "docked";
    }
  }

  function draw() {
    bot.setAttribute(
      "transform",
      `translate(${pos[0].toFixed(1)} ${pos[1].toFixed(1)})`
    );
    const live = legs[leg]?.kind === "clean" && state !== "docked";
    trail.setAttribute(
      "d",
      strokes
        .map((s, i) => {
          const pts = i === strokes.length - 1 && live ? [...s, pos] : s;
          return (
            "M" + pts.map((p) => p.map((n) => n.toFixed(1)).join(" ")).join("L")
          );
        })
        .join("")
    );
  }

  // Moves the vacuum up to `dist` along the plan. Returns false once the plan is finished.
  function advance(dist) {
    while (dist > 0) {
      const current = legs[leg];
      const target = current.points[step];
      const dx = target[0] - pos[0],
        dy = target[1] - pos[1];
      const d = Math.hypot(dx, dy);
      if (d > dist) {
        pos = [pos[0] + (dx * dist) / d, pos[1] + (dy * dist) / d];
        return true;
      }
      pos = [...target];
      dist -= d;
      if (current.kind === "clean") strokes[strokes.length - 1].push(pos);
      if (++step < current.points.length) {
        if (reduce.matches) return true;
        continue;
      }
      if (current.kind === "clean") done.add(current.room);
      if (++leg >= legs.length) return false;
      step = 0;
      if (legs[leg].kind === "clean") strokes.push([pos]);
      if (legs[leg].kind === "return") state = "returning";
      render();
      if (reduce.matches) return true;
    }
    return true;
  }

  let last = 0;
  let timer = 0;
  function tick(now) {
    if (state !== "cleaning" && state !== "returning") return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // Reduced motion: hop from point to point instead of gliding.
    const going = advance(reduce.matches ? Infinity : dt * SPEED);
    draw();
    if (!going) {
      state = "docked";
      legs = [];
      render();
      return;
    }
    schedule();
  }
  function schedule() {
    if (reduce.matches) timer = setTimeout(() => tick(performance.now()), 450);
    else timer = requestAnimationFrame(tick);
  }
  function run() {
    clearTimeout(timer);
    cancelAnimationFrame(timer);
    last = performance.now();
    schedule();
  }

  goBtn.addEventListener("click", () => {
    if (state === "cleaning" || state === "returning") {
      resume = state;
      state = "paused";
    } else if (state === "paused") {
      state = resume;
      run();
    } else {
      legs = plan();
      leg = 0;
      step = 0;
      strokes = [];
      done.clear();
      state = "cleaning";
      run();
    }
    render();
    draw();
  });

  homeBtn.addEventListener("click", () => {
    if (state !== "cleaning" && state !== "paused") return;
    legs = [homeLeg(roomAt(pos))];
    leg = 0;
    step = 0;
    state = "returning";
    run();
    render();
  });

  const toggle = (k) => {
    if (state !== "docked") return;
    if (picked.has(k)) picked.delete(k);
    else picked.add(k);
    render();
  };
  for (const c of chips)
    c.addEventListener("click", () => toggle(c.dataset.pick));
  for (const [k, r] of Object.entries(rooms))
    r.g.addEventListener("click", () => toggle(k));

  // Battery: drains while the vacuum is out, charges on the dock.
  setInterval(() => {
    const before = Math.round(battery);
    if (state === "cleaning" || state === "returning")
      battery = Math.max(5, battery - 0.8);
    else if (state === "docked" && battery < 100)
      battery = Math.min(100, battery + 4);
    if (Math.round(battery) !== before) render();
  }, 1000);

  render();
  draw();
}
