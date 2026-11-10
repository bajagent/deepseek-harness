/**
 * The self-contained Sims-style team view page. It polls the view server's
 * JSON snapshots and draws each agent as a character whose plumbob color and
 * room show its state.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code-team/view-page
 */

/** Complete HTML document served at `/`. */
export const TEAM_VIEW_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Team House</title>
<style>
:root {
  --bg: #e9f1e4; --panel: #ffffff; --ink: #1f2a24; --muted: #66756c; --line: #d3ddd0;
  --grass: #9fd18b; --wall: #c9b79c; --wood: #e8c9a0; --wood2: #dfbd90; --tile: #f3efe6; --tile2: #e7e1d3;
  --carpet: #c8d7ef; --carpet2: #bccde9; --rug: #f0c7c7;
  --working: #2fd158; --coordinating: #2f9bff; --waiting: #ffc928; --idle: #a3adb6; --error: #ff4b4b;
  --lead: #8a5cf6; --claude: #e8743b; --dsh: #1aa39a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141a17; --panel: #1d2420; --ink: #e8efe9; --muted: #95a39a; --line: #2f3933;
    --grass: #2c4a2a; --wall: #5d5141; --wood: #6b5338; --wood2: #634c32; --tile: #3a3833; --tile2: #34322d;
    --carpet: #2f3b52; --carpet2: #2b364b; --rug: #5a3a3a;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 12px 16px; }
h1 { margin: 0; font-size: 20px; letter-spacing: .2px; }
h1 small { color: var(--muted); font-weight: 500; font-size: 13px; margin-left: 6px; }
select { font: inherit; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); }
.legend { display: flex; gap: 12px; flex-wrap: wrap; color: var(--muted); font-size: 12px; }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.gem { width: 10px; height: 10px; transform: rotate(45deg); border-radius: 2px; display: inline-block; }
main { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; padding: 0 16px 16px; }
@media (max-width: 980px) { main { grid-template-columns: 1fr; } }
.house { position: relative; width: 100%; aspect-ratio: 16 / 10; border-radius: 14px; overflow: hidden;
  background: var(--grass); border: 8px solid var(--wall); box-shadow: inset 0 0 0 2px rgba(0,0,0,.08); }
.room { position: absolute; border: 4px solid var(--wall); }
.room h2 { position: absolute; left: 10px; top: 6px; margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
.office { left: 0; top: 0; width: 55%; height: 52%; background: repeating-linear-gradient(90deg, var(--wood) 0 22px, var(--wood2) 22px 24px); }
.meeting { left: 55%; top: 0; width: 45%; height: 52%; background: repeating-linear-gradient(45deg, var(--carpet) 0 12px, var(--carpet2) 12px 24px); }
.lounge { left: 0; top: 52%; width: 55%; height: 48%; background: var(--carpet2); }
.kitchen { left: 55%; top: 52%; width: 45%; height: 48%; background: repeating-conic-gradient(var(--tile) 0 25%, var(--tile2) 0 50%) 0 0 / 28px 28px; }
.prop { position: absolute; border-radius: 6px; box-shadow: 0 2px 0 rgba(0,0,0,.15); }
.desk { width: 10%; height: 8%; background: #8b6a45; }
.desk::after { content: ""; position: absolute; left: 30%; top: -35%; width: 40%; height: 55%; background: #2b3440; border-radius: 3px; box-shadow: inset 0 0 0 2px #56708f; }
.table { width: 22%; height: 30%; border-radius: 50%; background: #7d5a3a; left: 67%; top: 14%; }
.couch { width: 30%; height: 10%; background: #b65a5a; left: 6%; top: 62%; border-radius: 10px 10px 4px 4px; }
.tv { width: 18%; height: 3%; background: #222; left: 12%; top: 94%; }
.rugp { width: 34%; height: 22%; background: var(--rug); left: 4%; top: 72%; border-radius: 50%; opacity: .7; box-shadow: none; }
.cooler { width: 4%; height: 12%; background: linear-gradient(#8fd3ff 0 45%, #e5e9ee 45%); left: 92%; top: 60%; border-radius: 6px; }
.counter { width: 30%; height: 6%; background: #9aa7b3; left: 60%; top: 90%; }
.plant { width: 4%; height: 7%; background: radial-gradient(circle at 50% 40%, #3e9b4f 0 55%, transparent 56%), #7a5a3a; border-radius: 50% 50% 4px 4px; }
.sim { position: absolute; width: 56px; margin-left: -28px; margin-top: -84px; text-align: center;
  transition: left 1.8s ease-in-out, top 1.8s ease-in-out; z-index: 2; }
.sim.walking .body { animation: walk .35s infinite alternate; }
.plumbob { width: 16px; height: 22px; margin: 0 auto 2px; position: relative; animation: bob 1.6s ease-in-out infinite; }
.plumbob::before { content: ""; position: absolute; inset: 0; clip-path: polygon(50% 0, 100% 45%, 50% 100%, 0 45%);
  background: linear-gradient(135deg, rgba(255,255,255,.75), var(--c) 40%, rgba(0,0,0,.25)); filter: drop-shadow(0 0 6px var(--c)); }
.head { width: 22px; height: 22px; border-radius: 50%; margin: 0 auto; background: var(--skin); position: relative; box-shadow: inset 0 -2px 0 rgba(0,0,0,.08); }
.head::before { content: ""; position: absolute; left: -1px; right: -1px; top: -2px; height: 10px; border-radius: 11px 11px 4px 4px; background: var(--hair); }
.head::after { content: ""; position: absolute; left: 6px; top: 12px; width: 10px; height: 4px; border-bottom: 2px solid #3a2a20; border-radius: 0 0 6px 6px; }
.sim.error .head::after { top: 15px; border-bottom: 0; border-top: 2px solid #3a2a20; border-radius: 6px 6px 0 0; }
.body { width: 28px; height: 26px; margin: 1px auto 0; border-radius: 10px 10px 6px 6px; background: var(--shirt); position: relative; }
.body::after { content: ""; position: absolute; left: 6px; right: 6px; bottom: -7px; height: 8px; background: linear-gradient(90deg, #3d4a63 0 42%, transparent 42% 58%, #3d4a63 58%); border-radius: 0 0 3px 3px; }
.tag { margin-top: 9px; font-size: 11px; font-weight: 600; background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 0 7px;
  display: inline-block; max-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bubble { position: absolute; bottom: 100%; left: 50%; transform: translate(-50%, -6px); background: var(--panel); color: var(--ink);
  border: 1px solid var(--line); border-radius: 12px; padding: 3px 8px; font-size: 11px; white-space: nowrap; max-width: 200px; overflow: hidden; text-overflow: ellipsis;
  box-shadow: 0 2px 6px rgba(0,0,0,.12); }
.bubble::after { content: ""; position: absolute; left: 50%; top: 100%; width: 8px; height: 8px; background: var(--panel); border-right: 1px solid var(--line); border-bottom: 1px solid var(--line);
  transform: translate(-50%, -4px) rotate(45deg); }
.sim.idle .bubble { opacity: .65; }
.flyer { position: absolute; z-index: 5; font-size: 20px; transition: left 1.2s ease-in, top 1.2s ease-in, opacity .3s; pointer-events: none; }
.pop { position: absolute; z-index: 6; font-size: 12px; font-weight: 700; background: #fff7c2; color: #3b3200; border-radius: 8px; padding: 2px 6px; animation: rise 2.4s ease-out forwards; pointer-events: none; }
@keyframes bob { 0%, 100% { transform: translateY(0) rotateY(0deg); } 50% { transform: translateY(-4px) rotateY(180deg); } }
@keyframes walk { from { transform: translateY(0) rotate(-3deg); } to { transform: translateY(-2px) rotate(3deg); } }
@keyframes rise { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(-36px); } }
aside { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
.card h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .8px; color: var(--muted); }
.who { display: grid; grid-template-columns: 14px 1fr auto; gap: 4px 8px; align-items: center; padding: 6px 0; border-top: 1px solid var(--line); }
.who:first-of-type { border-top: 0; }
.who b { font-weight: 600; }
.who .meta { grid-column: 2 / 4; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kind { font-size: 11px; border-radius: 999px; padding: 0 6px; color: #fff; }
.cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.col h4 { margin: 0 0 4px; font-size: 11px; color: var(--muted); }
.task { font-size: 12px; border: 1px solid var(--line); border-radius: 8px; padding: 4px 6px; margin-bottom: 4px; }
.task .owner { color: var(--muted); font-size: 11px; }
.feed { max-height: 280px; overflow: auto; margin: 0; padding: 0; list-style: none; }
.feed li { padding: 5px 0; border-top: 1px solid var(--line); font-size: 12px; }
.feed li:first-child { border-top: 0; }
.feed time { color: var(--muted); font-size: 11px; margin-right: 4px; }
.empty { color: var(--muted); font-size: 12px; }
.banner { position: absolute; inset: auto 0 0 0; padding: 8px; text-align: center; color: var(--muted); font-size: 12px; z-index: 4; }
</style>
</head>
<body>
<header>
  <h1>🏠 Team House <small id="sub">waiting for a team…</small></h1>
  <div class="legend">
    <span><i class="gem" style="background:var(--working)"></i>Working</span>
    <span><i class="gem" style="background:var(--coordinating)"></i>Coordinating</span>
    <span><i class="gem" style="background:var(--waiting)"></i>Waiting</span>
    <span><i class="gem" style="background:var(--idle)"></i>Idle</span>
    <span><i class="gem" style="background:var(--error)"></i>Stuck</span>
  </div>
  <select id="team" aria-label="Team"></select>
</header>
<main>
  <section class="house" id="house" aria-label="Team house">
    <div class="room office"><h2>Office</h2></div>
    <div class="room meeting"><h2>Meeting room</h2></div>
    <div class="room lounge"><h2>Lounge</h2></div>
    <div class="room kitchen"><h2>Kitchen</h2></div>
    <div class="prop desk" style="left:5%;top:18%"></div><div class="prop desk" style="left:20%;top:18%"></div><div class="prop desk" style="left:35%;top:18%"></div>
    <div class="prop desk" style="left:5%;top:38%"></div><div class="prop desk" style="left:20%;top:38%"></div><div class="prop desk" style="left:35%;top:38%"></div>
    <div class="prop table"></div>
    <div class="prop rugp"></div><div class="prop couch"></div><div class="prop tv"></div>
    <div class="prop cooler"></div><div class="prop counter"></div>
    <div class="prop plant" style="left:50%;top:3%"></div><div class="prop plant" style="left:2%;top:88%"></div>
    <div class="banner" id="banner">No team yet — spawn an agent to move someone in.</div>
  </section>
  <aside>
    <div class="card"><h3>Household</h3><div id="people"><p class="empty">Nobody home.</p></div></div>
    <div class="card"><h3>Task board</h3><div id="tasks"><p class="empty">Turn on agent teamwork to use the shared board.</p></div></div>
    <div class="card"><h3>Neighborhood news</h3><ul class="feed" id="feed"><li class="empty">Quiet so far.</li></ul></div>
  </aside>
</main>
<script>
(function () {
  var token = new URLSearchParams(location.search).get('token') || '';
  var house = document.getElementById('house');
  var picker = document.getElementById('team');
  var sims = {};
  var lastEvent = 0;
  var currentRoot = '';
  var ZONES = {
    working: { x: [8, 23, 38, 8, 23, 38, 15, 30, 45], y: [30, 30, 30, 50, 50, 50, 14, 14, 14], w: 1 },
    coordinating: { x: [64, 78, 92, 64, 92, 71, 85], y: [20, 14, 20, 44, 44, 48, 48], w: 1 },
    waiting: { x: [86, 76, 66, 86, 76, 66], y: [72, 72, 72, 86, 86, 86], w: 1 },
    idle: { x: [10, 22, 34, 46, 16, 28, 40], y: [70, 70, 70, 70, 88, 88, 88], w: 1 },
    error: { x: [48, 48, 44], y: [92, 80, 86], w: 1 }
  };
  var STATE_COLOR = { working: 'var(--working)', coordinating: 'var(--coordinating)', waiting: 'var(--waiting)', idle: 'var(--idle)', error: 'var(--error)' };
  var KIND_COLOR = { lead: 'var(--lead)', claude: 'var(--claude)', dsh: 'var(--dsh)' };
  var KIND_LABEL = { lead: 'Lead', claude: 'Claude', dsh: 'dsh' };
  var SKINS = ['#f2d0b1', '#e0ac85', '#c68a62', '#8d5a3b', '#f7dcc6', '#a8704b'];
  var HAIRS = ['#2b1d14', '#5a3a1e', '#c9a14a', '#8a3b1d', '#1c1c1c', '#b9b9b9', '#6b2f6b'];
  var ICON = { working: '💻 ', coordinating: '💬 ', waiting: '⏳ ', idle: '☕ ', error: '⚠️ ' };

  function hash(text) { var h = 0; for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0; return Math.abs(h); }
  function api(path) {
    return fetch(path + (path.indexOf('?') < 0 ? '?' : '&') + 'token=' + encodeURIComponent(token), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  function ago(ms) { var s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function short(name) { var parts = name.split('/'); return parts[parts.length - 1]; }

  function makeSim(agent) {
    var h = hash(agent.name);
    var node = el('div', 'sim');
    node.style.setProperty('--skin', SKINS[h % SKINS.length]);
    node.style.setProperty('--hair', HAIRS[(h >> 3) % HAIRS.length]);
    node.style.setProperty('--shirt', KIND_COLOR[agent.kind]);
    var bubble = el('div', 'bubble');
    var gem = el('div', 'plumbob');
    node.append(bubble, gem, el('div', 'head'), el('div', 'body'), el('div', 'tag', short(agent.name)));
    node.title = agent.name;
    house.appendChild(node);
    return { node: node, bubble: bubble, gem: gem, slot: '' };
  }

  function place(agents) {
    var byZone = {};
    agents.forEach(function (a) { (byZone[a.state] = byZone[a.state] || []).push(a); });
    var seen = {};
    Object.keys(byZone).forEach(function (state) {
      var zone = ZONES[state] || ZONES.idle;
      byZone[state].sort(function (a, b) { return a.name < b.name ? -1 : 1; }).forEach(function (a, i) {
        var sim = sims[a.name] || (sims[a.name] = makeSim(a));
        seen[a.name] = true;
        var k = i % zone.x.length, ring = Math.floor(i / zone.x.length);
        var x = zone.x[k] + ring * 3, y = zone.y[k] + ring * 3;
        var slot = state + ':' + x + ':' + y;
        if (sim.slot !== slot) {
          if (sim.slot) { sim.node.classList.add('walking'); setTimeout(function () { sim.node.classList.remove('walking'); }, 1800); }
          sim.node.style.left = x + '%';
          sim.node.style.top = y + '%';
          sim.slot = slot;
        }
        sim.node.className = 'sim ' + a.state + (sim.node.classList.contains('walking') ? ' walking' : '');
        sim.gem.style.setProperty('--c', STATE_COLOR[a.state]);
        sim.bubble.textContent = (ICON[a.state] || '') + a.detail;
        sim.pos = { x: x, y: y };
      });
    });
    Object.keys(sims).forEach(function (name) {
      if (!seen[name]) { sims[name].node.remove(); delete sims[name]; }
    });
  }

  function center(name) {
    var sim = sims[name] || sims[short(name)];
    if (!sim) Object.keys(sims).forEach(function (n) { if (short(n) === short(name)) sim = sims[n]; });
    return sim && sim.pos ? sim.pos : null;
  }

  function fly(from, to, symbol) {
    var a = center(from), b = center(to);
    if (!a || !b) return;
    var f = el('div', 'flyer', symbol);
    f.style.left = a.x + '%'; f.style.top = (a.y - 8) + '%';
    house.appendChild(f);
    requestAnimationFrame(function () { requestAnimationFrame(function () { f.style.left = b.x + '%'; f.style.top = (b.y - 8) + '%'; }); });
    setTimeout(function () { f.style.opacity = '0'; }, 1300);
    setTimeout(function () { f.remove(); }, 1700);
  }

  function pop(name, text) {
    var at = center(name);
    if (!at) return;
    var p = el('div', 'pop', text);
    p.style.left = at.x + '%'; p.style.top = (at.y - 14) + '%';
    house.appendChild(p);
    setTimeout(function () { p.remove(); }, 2500);
  }

  function animate(events) {
    // On first load, show history in the feed without replaying it.
    if (lastEvent === 0 && events.length > 0) { lastEvent = events[events.length - 1].id; return; }
    events.forEach(function (e) {
      if (e.id <= lastEvent) return;
      lastEvent = e.id;
      if (e.kind === 'message' && e.to) fly(e.from, e.to, '✉️');
      else if (e.kind === 'answer' && e.to) fly(e.from, e.to, '📦');
      else if (e.kind === 'spawn' && e.to) { fly(e.from, e.to, '🎉'); setTimeout(function () { pop(e.to, 'Moved in!'); }, 1200); }
      else if (e.kind === 'task') pop(e.from, '📋 ' + e.text.split(' ')[0]);
    });
  }

  function renderPeople(agents, now) {
    var box = document.getElementById('people');
    box.textContent = '';
    agents.forEach(function (a) {
      var row = el('div', 'who');
      var gem = el('i', 'gem'); gem.style.background = STATE_COLOR[a.state];
      var name = el('b', '', short(a.name));
      var kind = el('span', 'kind', KIND_LABEL[a.kind]); kind.style.background = KIND_COLOR[a.kind];
      var meta = el('div', 'meta', a.detail + ' · ' + ago(now - a.since) + (a.parent ? ' · reports to ' + short(a.parent) : ''));
      row.append(gem, name, kind, meta);
      box.appendChild(row);
    });
  }

  function renderTasks(tasks) {
    var box = document.getElementById('tasks');
    box.textContent = '';
    if (!tasks) { box.appendChild(el('p', 'empty', 'Turn on agent teamwork to use the shared board.')); return; }
    var cols = el('div', 'cols');
    [['pending', 'To do'], ['in_progress', 'Doing'], ['completed', 'Done']].forEach(function (c) {
      var col = el('div', 'col'); col.appendChild(el('h4', '', c[1]));
      tasks.filter(function (t) { return t.status === c[0]; }).forEach(function (t) {
        var card = el('div', 'task', t.id + ' ' + t.subject);
        if (t.owner) card.appendChild(el('div', 'owner', '👤 ' + short(t.owner)));
        else if (!t.ready) card.appendChild(el('div', 'owner', '⛓ blocked'));
        col.appendChild(card);
      });
      cols.appendChild(col);
    });
    box.appendChild(cols);
  }

  function renderFeed(events, now) {
    var list = document.getElementById('feed');
    list.textContent = '';
    if (events.length === 0) { list.appendChild(el('li', 'empty', 'Quiet so far.')); return; }
    var verbs = { spawn: '🎉 hired', message: '✉️ messaged', answer: '📦 reported to', task: '📋' };
    events.slice().reverse().forEach(function (e) {
      var li = el('li');
      li.appendChild(el('time', '', ago(now - e.time)));
      var line = e.kind === 'spawn' && !e.to
        ? short(e.from) + ' 🏠 ' + e.text
        : e.kind === 'task'
          ? short(e.from) + ' 📋 ' + e.text
          : short(e.from) + ' ' + verbs[e.kind] + (e.to ? ' ' + short(e.to) : '') + (e.text ? ': ' + e.text : '');
      li.appendChild(document.createTextNode(line));
      list.appendChild(li);
    });
  }

  function refreshTeams() {
    api('/api/teams').then(function (teams) {
      var known = {};
      Array.prototype.forEach.call(picker.options, function (o) { known[o.value] = true; });
      teams.forEach(function (t, i) {
        if (known[t.root]) return;
        var o = el('option', '', 'Team ' + (picker.options.length + 1) + ' · ' + t.root.slice(0, 8));
        o.value = t.root;
        picker.appendChild(o);
      });
      if (!currentRoot && teams.length > 0) { currentRoot = teams[0].root; picker.value = currentRoot; }
    }).catch(function () {});
  }

  function refresh() {
    if (!currentRoot) return;
    api('/api/team?root=' + encodeURIComponent(currentRoot)).then(function (snap) {
      document.getElementById('banner').style.display = snap.agents.length > 1 ? 'none' : 'block';
      var working = snap.agents.filter(function (a) { return a.state === 'working'; }).length;
      document.getElementById('sub').textContent = snap.agents.length + ' household members · ' + working + ' working';
      place(snap.agents);
      animate(snap.events);
      renderPeople(snap.agents, snap.now);
      renderTasks(snap.tasks);
      renderFeed(snap.events, snap.now);
    }).catch(function () {});
  }

  picker.addEventListener('change', function () {
    currentRoot = picker.value; lastEvent = 0;
    Object.keys(sims).forEach(function (n) { sims[n].node.remove(); delete sims[n]; });
    refresh();
  });
  refreshTeams();
  setInterval(refreshTeams, 4000);
  setInterval(refresh, 1000);
})();
</script>
</body>
</html>
`
