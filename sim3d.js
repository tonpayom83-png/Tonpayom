/* Sim3D: interactive 3D models for the knowledge articles (three.js r128, loaded on demand).
 * Each article gets its own model:
 *   frame3d    -> reading structural drawings (footing / column / beam / slab, with grid lines)
 *   loadpath3d -> load path from slab to footing (tributary area, accumulated load, footing size)
 *   beam3d     -> RC beam with main bars and stirrups, driven by the 2D beam calculator
 */
(function () {
  'use strict';
  var T = window.THREE;
  if (!T) return;

  /* ---------- small helpers ---------- */
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function fmt(n, dp) {
    return n.toLocaleString('th-TH', { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 });
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function button(text, fn) {
    var b = el('button', null, text); b.type = 'button'; b.addEventListener('click', fn); return b;
  }
  function checkbox(text, color, checked, fn) {
    var l = el('label', 's3-chk');
    var i = el('input'); i.type = 'checkbox'; i.checked = checked;
    i.addEventListener('change', function () { fn(i.checked); });
    l.appendChild(i);
    if (color) { var sw = el('i'); sw.style.background = color; l.appendChild(sw); }
    l.appendChild(document.createTextNode(text));
    return l;
  }
  function disposeGroup(g) {
    g.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        var ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach(function (m) { if (m.map) m.map.dispose(); m.dispose(); });
      }
    });
    while (g.children.length) g.remove(g.children[0]);
  }

  // Text sprite with a rounded background. width = world-space width of the label.
  function label(text, o) {
    o = o || {};
    var fs = 56, pad = 16;
    var c = document.createElement('canvas'), ctx = c.getContext('2d');
    var font = '700 ' + fs + 'px Anuphan, "IBM Plex Sans Thai", sans-serif';
    ctx.font = font;
    var w = Math.ceil(ctx.measureText(text).width) + pad * 2, h = fs + pad * 2;
    c.width = w; c.height = h;
    ctx = c.getContext('2d'); ctx.font = font; ctx.textBaseline = 'middle';
    if (o.bg) {
      ctx.fillStyle = o.bg; ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(0, 0, w, h, 22); else ctx.rect(0, 0, w, h);
      ctx.fill();
    }
    ctx.fillStyle = o.color || '#14273F';
    ctx.fillText(text, pad, h / 2 + 2);
    var tex = new T.CanvasTexture(c); tex.minFilter = T.LinearFilter;
    var sp = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    var ww = o.width || 1.4;
    sp.scale.set(ww, ww * h / w, 1);
    sp.renderOrder = 10;
    return sp;
  }

  function stdMat(color, opacity) {
    return new T.MeshStandardMaterial({
      color: color, roughness: 0.85, metalness: 0,
      transparent: opacity != null, opacity: opacity == null ? 1 : opacity,
      depthWrite: opacity == null || opacity > 0.8
    });
  }
  function outline(mesh, opacity) {
    var e = new T.LineSegments(new T.EdgesGeometry(mesh.geometry),
      new T.LineBasicMaterial({ color: 0x14273F, transparent: true, opacity: opacity == null ? 0.35 : opacity }));
    mesh.add(e);
    return e;
  }
  function arrowDown(len, radius, color) {
    // Arrow whose tip is at y = 0 and tail at y = len.
    var g = new T.Group(), head = Math.min(len * 0.4, radius * 4);
    var shaft = new T.Mesh(new T.CylinderGeometry(radius, radius, Math.max(len - head, 0.01), 10), stdMat(color));
    shaft.position.y = head + (len - head) / 2;
    var cone = new T.Mesh(new T.ConeGeometry(radius * 2.4, head, 14), stdMat(color));
    cone.rotation.x = Math.PI; cone.position.y = head / 2;
    g.add(shaft); g.add(cone);
    return g;
  }

  /* ---------- shared stage: scene, camera, orbit controls, render loop ---------- */
  function Stage(box) {
    var self = this;
    this.wrap = el('div', 's3-canvas');
    box.appendChild(this.wrap);
    this.renderer = new T.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.localClippingEnabled = true;
    this.wrap.appendChild(this.renderer.domElement);
    this.scene = new T.Scene();
    this.scene.background = new T.Color(0xF6F4EF);
    this.camera = new T.PerspectiveCamera(42, 1, 0.1, 300);
    this.camera.position.set(10, 8, 12);
    this.controls = new T.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.52;
    this.scene.add(new T.HemisphereLight(0xffffff, 0xb9b4a6, 0.95));
    var d1 = new T.DirectionalLight(0xffffff, 0.75); d1.position.set(8, 14, 10); this.scene.add(d1);
    var d2 = new T.DirectionalLight(0xffffff, 0.25); d2.position.set(-8, 6, -10); this.scene.add(d2);
    this.alive = true; this.tw = null; this.last = performance.now();
    this.resize = function () {
      var w = self.wrap.clientWidth || 600, h = self.wrap.clientHeight || 380;
      self.renderer.setSize(w, h, false);
      self.camera.aspect = w / h;
      self.camera.updateProjectionMatrix();
    };
    if (window.ResizeObserver) { this.ro = new ResizeObserver(this.resize); this.ro.observe(this.wrap); }
    else window.addEventListener('resize', this.resize);
    this.resize();
    (function loop(now) {
      if (!self.alive) return;
      requestAnimationFrame(loop);
      var dt = Math.min((now - self.last) / 1000, 0.1); self.last = now;
      if (self.tw) {
        var t = self.tw; t.t = Math.min(1, t.t + dt / 0.55);
        var k = t.t < 0.5 ? 2 * t.t * t.t : 1 - Math.pow(-2 * t.t + 2, 2) / 2;
        self.camera.position.lerpVectors(t.p0, t.p1, k);
        self.controls.target.lerpVectors(t.t0, t.t1, k);
        if (t.t >= 1) self.tw = null;
      }
      self.controls.update();
      self.renderer.render(self.scene, self.camera);
    })(performance.now());
  }
  Stage.prototype.view = function (pos, target, instant) {
    var p1 = new T.Vector3(pos[0], pos[1], pos[2]), t1 = new T.Vector3(target[0], target[1], target[2]);
    if (instant) { this.camera.position.copy(p1); this.controls.target.copy(t1); this.controls.update(); this.tw = null; return; }
    this.tw = { t: 0, p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: p1, t1: t1 };
  };
  Stage.prototype.onPick = function (cb, getObjs) {
    var self = this, ray = new T.Raycaster(), v = new T.Vector2(), down = null, dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', function (e) { down = [e.clientX, e.clientY]; });
    dom.addEventListener('pointerup', function (e) {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      var r = dom.getBoundingClientRect();
      v.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(v, self.camera);
      var hits = ray.intersectObjects(getObjs(), false);
      cb(hits.length ? hits[0].object : null);
    });
  };
  Stage.prototype.dispose = function () {
    this.alive = false;
    if (this.ro) this.ro.disconnect(); else window.removeEventListener('resize', this.resize);
    disposeGroup(this.scene);
    this.controls.dispose();
    this.renderer.dispose();
  };

  /* =====================================================================
   * Model 1: RC frame for "reading structural drawings"
   * 3x3 grid (A-C by 1-3), 2 storeys, footings F1-F3, columns C1-C3,
   * ground beams GB1/GB2, floor beams B1/B2, slabs S1. Click to inspect.
   * ===================================================================== */
  function modelFrame(box) {
    var st = new Stage(box);
    var S = 4, H = 3, AX = [-S, 0, S], LET = ['A', 'B', 'C'];
    var LAYERS = [
      ['footing', 'ฐานราก', '#A5A093', 0xA5A093],
      ['column', 'เสา', '#7C93B0', 0x7C93B0],
      ['gbeam', 'คานคอดิน', '#9AA89A', 0x9AA89A],
      ['beam', 'คาน', '#D1B48A', 0xD1B48A],
      ['slab', 'พื้น', '#E6E2D8', 0xE6E2D8]
    ];
    var G = {}, pick = [], selected = null;
    LAYERS.forEach(function (l) { G[l[0]] = new T.Group(); st.scene.add(G[l[0]]); });

    function add(layer, w, h, d, x, y, z, color, info, opacity) {
      var m = new T.Mesh(new T.BoxGeometry(w, h, d), stdMat(color, opacity));
      m.position.set(x, y, z);
      outline(m, 0.4);
      m.userData.info = info; m.userData.layer = layer;
      G[layer].add(m); pick.push(m);
      return m;
    }
    function ref(ix, iz) { return LET[ix] + '-' + (iz + 1); }

    // footings and columns
    for (var ix = 0; ix < 3; ix++) for (var iz = 0; iz < 3; iz++) {
      var center = ix === 1 && iz === 1, edge = (ix === 1) !== (iz === 1);
      var kind = center ? 3 : edge ? 2 : 1, fs = [0, 1.2, 1.6, 2.0][kind], cs = kind === 3 ? 0.4 : 0.3;
      add('footing', fs, 0.5, fs, AX[ix], -1.05, AX[iz], 0xA5A093, {
        type: 'ฐานราก', name: 'F' + kind, size: fmt(fs, 2) + ' × ' + fmt(fs, 2) + ' × 0.50 ม.', at: 'จุดตัดกริด ' + ref(ix, iz),
        sheet: 'แปลนฐานราก และ ตารางฐานราก', note: kind === 3 ? 'ใต้เสากลาง รับน้ำหนักมากที่สุด จึงใหญ่ที่สุด' : kind === 2 ? 'ใต้เสาริม รับน้ำหนักปานกลาง' : 'ใต้เสามุม รับน้ำหนักน้อยที่สุด'
      });
      add('column', cs, 6.8, cs, AX[ix], 2.6, AX[iz], 0x7C93B0, {
        type: 'เสา', name: 'C' + kind, size: fmt(cs * 100) + ' × ' + fmt(cs * 100) + ' ซม.', at: 'จุดตัดกริด ' + ref(ix, iz),
        sheet: 'ตารางเสา (Column Schedule)', note: 'ในตารางเสาจะบอกขนาดหน้าตัด เหล็กยืน และเหล็กปลอก แยกตามชื่อ C1, C2, C3'
      });
    }
    // ground beams and floor beams along the 6 grid lines
    function beamsAt(layer, y, name0, levelText, color) {
      for (var line = 0; line < 3; line++) for (var i = 0; i < 2; i++) for (var dir = 0; dir < 2; dir++) {
        var inner = line === 1, name = name0 + (inner ? '2' : '1'), mid = (AX[i] + AX[i + 1]) / 2, fix = AX[line];
        var x = dir === 0 ? mid : fix, z = dir === 0 ? fix : mid;
        var a = dir === 0 ? ref(i, line) : ref(line, i), b = dir === 0 ? ref(i + 1, line) : ref(line, i + 1);
        add(layer, dir === 0 ? S - 0.3 : 0.2, 0.4, dir === 0 ? 0.2 : S - 0.3, x, y, z, color, {
          type: layer === 'gbeam' ? 'คานคอดิน' : 'คาน', name: name, size: '20 × 40 ซม. ยาว ' + fmt(S, 2) + ' ม.', at: 'ระหว่างกริด ' + a + ' และ ' + b + (levelText ? ' · ' + levelText : ''),
          sheet: layer === 'gbeam' ? 'แปลนคานคอดิน และ รายละเอียดคาน' : 'แปลนคานแต่ละชั้น และ รายละเอียดคาน (Beam Detail)',
          note: inner ? 'คานแนวกลางรับพื้นสองฝั่ง' : 'คานแนวริมอาคาร'
        });
      }
    }
    beamsAt('gbeam', -0.3, 'GB', 'ระดับดิน (±0.00)', 0x9AA89A);
    beamsAt('beam', H - 0.2, 'B', 'ชั้น 2 (+3.00)', 0xD1B48A);
    beamsAt('beam', 2 * H - 0.2, 'B', 'หลังคา (+6.00)', 0xD1B48A);
    // slabs: 4 panels per level
    [H, 2 * H].forEach(function (lv) {
      [-2, 2].forEach(function (cx) { [-2, 2].forEach(function (cz) {
        add('slab', S - 0.05, 0.1, S - 0.05, cx, lv - 0.05, cz, 0xE6E2D8, {
          type: 'พื้น', name: 'S1', size: 'หนา 10 ซม. แผ่น ' + fmt(S) + ' × ' + fmt(S) + ' ม.', at: lv === H ? 'ชั้น 2 (+3.00)' : 'หลังคา (+6.00)',
          sheet: 'แปลนพื้น / รายละเอียดพื้น', note: 'แผ่นพื้นสี่เหลี่ยมจัตุรัส ด้านยาว/ด้านสั้น = 1 จึงเป็นพื้นสองทาง'
        }, 0.6);
      }); });
    });

    // grid lines and labels (A-C along x, 1-3 along z), like on the drawings
    var grid = new T.Group(); st.scene.add(grid);
    var gm = new T.LineBasicMaterial({ color: 0xE8742A, transparent: true, opacity: 0.7 });
    AX.forEach(function (v, i) {
      var lx = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(v, 0.02, -S - 1.7), new T.Vector3(v, 0.02, S + 1.7)]), gm);
      var lz = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(-S - 1.7, 0.02, v), new T.Vector3(S + 1.7, 0.02, v)]), gm);
      grid.add(lx); grid.add(lz);
      var a = label(LET[i], { color: '#fff', bg: '#E8742A', width: 0.9 }); a.position.set(v, 0.3, -S - 2.4); grid.add(a);
      var n = label(String(i + 1), { color: '#fff', bg: '#E8742A', width: 0.9 }); n.position.set(-S - 2.4, 0.3, v); grid.add(n);
    });
    var gh = new T.GridHelper(20, 20, 0xC9C3B4, 0xE2DDD0); gh.position.y = -0.001; st.scene.add(gh);
    var gl = label('ระดับดิน ±0.00', { color: '#5B6577', width: 2.6 }); gl.position.set(S + 3.4, 0.3, S + 1.2); st.scene.add(gl);

    // UI
    var bar = el('div', 's3-bar'), tog = el('div', 's3-bar'), info = el('div', 's3-info');
    bar.appendChild(button('มุมมอง 3 มิติ', function () { st.view([11, 8, 12], [0, 2.2, 0]); }));
    bar.appendChild(button('แปลน (มองจากบน)', function () { st.view([0, 19, 0.01], [0, 0, 0]); }));
    bar.appendChild(button('รูปด้าน', function () { st.view([0, 3, 26], [0, 2.4, 0]); }));
    LAYERS.forEach(function (l) { tog.appendChild(checkbox(l[1], l[2], true, function (on) { G[l[0]].visible = on; })); });
    box.appendChild(bar); box.appendChild(tog); box.appendChild(info);
    function showInfo(i) {
      info.innerHTML = i
        ? '<b>' + esc(i.type) + ' ' + esc(i.name) + '</b> · ' + esc(i.size) + '<br>ตำแหน่ง: ' + esc(i.at) + '<br>อ่านจากแผ่นแบบ: <b>' + esc(i.sheet) + '</b><br>' + esc(i.note)
        : 'กดที่ชิ้นส่วนในโมเดลเพื่อดูชื่อ ขนาด ตำแหน่งกริด และแผ่นแบบที่ต้องใช้อ่าน ลากเพื่อหมุน เลื่อนล้อเมาส์เพื่อซูม';
    }
    showInfo(null);
    st.onPick(function (m) {
      if (selected) selected.material.emissive.setHex(0x000000);
      selected = m;
      if (m) { m.material.emissive.setHex(0xE8742A); m.material.emissiveIntensity = 0.55; }
      showInfo(m ? m.userData.info : null);
    }, function () { return pick.filter(function (m) { return m.visible && m.parent.visible; }); });
    st.view([11, 8, 12], [0, 2.2, 0], true);
    return { dispose: function () { st.dispose(); } };
  }

  /* =====================================================================
   * Model 2: load path - choose a column, number of storeys and soil
   * capacity; see the tributary area, accumulated load and footing size.
   * Uses the same numbers as the article (440 kg/m2 + beam share 96 kg/m2).
   * ===================================================================== */
  function modelLoadPath(box) {
    var st = new Stage(box);
    var S = 4, H = 3, AX = [-S, 0, S];
    var AREA = { center: 16, edge: 8, corner: 4 };
    var POS = { center: [0, 0], edge: [0, -S], corner: [-S, -S] };
    var RECT = { center: [-2, 2, -2, 2], edge: [-2, 2, -S, -2], corner: [-S, -2, -S, -2] };
    var NAMES = { center: 'เสากลาง', edge: 'เสาริม', corner: 'เสามุม' };
    var W = 440, BEAM = 96;
    var state = { n: 2, col: 'center', qa: 10, show: true };
    var grp = new T.Group(); st.scene.add(grp);
    var gh = new T.GridHelper(20, 20, 0xC9C3B4, 0xE2DDD0); gh.position.y = -0.001; st.scene.add(gh);

    var bar = el('div', 's3-bar'), ctl = el('div', 's3-ctl'), out = el('div', 's3-info');
    var colBtns = {};
    ['center', 'edge', 'corner'].forEach(function (k) {
      var b = button(NAMES[k], function () { state.col = k; rebuild(); });
      colBtns[k] = b; bar.appendChild(b);
    });
    var nLab = el('label', null, 'จำนวนชั้น <span class="unit-in"><input type="range" min="1" max="3" step="1" value="2"><em id="s3n">2 ชั้น</em></span>');
    var qLab = el('label', null, 'กำลังรับน้ำหนักดิน <span class="unit-in"><input type="number" min="1" step="1" value="10"><em>ตัน/ตร.ม.</em></span>');
    ctl.appendChild(nLab); ctl.appendChild(qLab);
    var tog = el('div', 's3-bar');
    tog.appendChild(checkbox('แสดงพื้นที่รับน้ำหนัก (Tributary Area) และลูกศรน้ำหนัก', '#E8742A', true, function (on) { state.show = on; rebuild(); }));
    box.appendChild(bar); box.appendChild(ctl); box.appendChild(tog); box.appendChild(out);
    var nIn = nLab.querySelector('input'), qIn = qLab.querySelector('input');
    nIn.addEventListener('input', function () { state.n = +nIn.value; nLab.querySelector('em').textContent = state.n + ' ชั้น'; rebuild(); var hv = home(); st.view(hv[0], hv[1]); });
    qIn.addEventListener('input', function () { var v = parseFloat(qIn.value); if (v > 0) { state.qa = v; rebuild(); } });

    function home() { // camera framing follows the number of storeys
      var d = 9 + 3.2 * state.n;
      return [[d * 0.72, d * 0.5 + 1, d * 0.86], [0, state.n * H / 2 + 0.2, 0]];
    }
    function color(f) { // 0..1 -> light yellow to deep orange-red
      return new T.Color().setHSL(0.12 - 0.1 * f, 0.85, 0.72 - 0.25 * f);
    }
    function box3(w, h, d, x, y, z, c, op) {
      var m = new T.Mesh(new T.BoxGeometry(w, h, d), stdMat(c, op)); m.position.set(x, y, z); outline(m, 0.3); grp.add(m); return m;
    }
    function rebuild() {
      disposeGroup(grp);
      var n = state.n, key = state.col, a = AREA[key], perFloor = a * (W + BEAM), total = perFloor * n;
      var p = POS[key], top = n * H;
      for (var k in colBtns) colBtns[k].className = k === key ? 'on' : '';
      // beams and slabs for every level (context, light grey)
      for (var lv = 1; lv <= n; lv++) {
        var y = lv * H;
        for (var line = 0; line < 3; line++) for (var i = 0; i < 2; i++) {
          var mid = (AX[i] + AX[i + 1]) / 2;
          box3(S - 0.3, 0.4, 0.2, mid, y - 0.2, AX[line], 0xD7D3C8);
          box3(0.2, 0.4, S - 0.3, AX[line], y - 0.2, mid, 0xD7D3C8);
        }
        [-2, 2].forEach(function (cx) { [-2, 2].forEach(function (cz) { box3(S - 0.05, 0.1, S - 0.05, cx, y - 0.05, cz, 0xE6E2D8, 0.45); }); });
      }
      // all columns: grey, except the chosen one which is coloured per segment by load carried
      for (var ix = 0; ix < 3; ix++) for (var iz = 0; iz < 3; iz++) {
        var isSel = AX[ix] === p[0] && AX[iz] === p[1];
        if (!isSel) { box3(0.3, top + 0.8, 0.3, AX[ix], (top - 0.8) / 2, AX[iz], 0xC9C4B8); box3(1.2, 0.4, 1.2, AX[ix], -1.0, AX[iz], 0xBDB8AC); }
      }
      for (var seg = 1; seg <= n; seg++) {
        var carried = n - seg + 1, f = carried / n;
        var y0 = (seg - 1) * H, y1 = seg * H, yb = seg === 1 ? -0.8 : y0;
        var m = box3(0.4, y1 - yb, 0.4, p[0], (yb + y1) / 2, p[1], color(f));
        var lab = label('รับ ' + carried + ' ชั้น = ' + fmt(perFloor * carried) + ' กก.', { color: '#14273F', bg: 'rgba(255,255,255,.94)', width: 4.4 });
        lab.position.set(p[0] + (key === 'corner' ? 2.7 : key === 'center' ? 3.7 : 2.7), (yb + y1) / 2 + 0.2, p[1] + 0.6); grp.add(lab);
      }
      // tributary area and load arrows
      if (state.show) {
        var r = RECT[key];
        for (var l2 = 1; l2 <= n; l2++) {
          var pl = new T.Mesh(new T.PlaneGeometry(r[1] - r[0], r[3] - r[2]), new T.MeshBasicMaterial({ color: 0xE8742A, transparent: true, opacity: 0.4, side: T.DoubleSide, depthWrite: false }));
          pl.rotation.x = -Math.PI / 2; pl.position.set((r[0] + r[1]) / 2, l2 * H + 0.03, (r[2] + r[3]) / 2); grp.add(pl);
          var edges = new T.LineSegments(new T.EdgesGeometry(new T.PlaneGeometry(r[1] - r[0], r[3] - r[2])), new T.LineBasicMaterial({ color: 0xA84A14 }));
          edges.rotation.x = -Math.PI / 2; edges.position.copy(pl.position); grp.add(edges);
          var nx = Math.max(2, Math.round((r[1] - r[0]) / 1.3)), nz = Math.max(2, Math.round((r[3] - r[2]) / 1.3));
          for (var ax = 0; ax < nx; ax++) for (var az = 0; az < nz; az++) {
            var arr = arrowDown(0.55, 0.035, 0xE8742A);
            arr.position.set(r[0] + (ax + 0.5) * (r[1] - r[0]) / nx, l2 * H + 0.6, r[2] + (az + 0.5) * (r[3] - r[2]) / nz);
            grp.add(arr);
          }
          var tl = label('พื้นที่รับน้ำหนัก ' + a + ' ตร.ม. × ' + (W + BEAM) + ' = ' + fmt(perFloor) + ' กก.', { color: '#fff', bg: '#A84A14', width: 6.2 });
          tl.position.set((r[0] + r[1]) / 2, l2 * H + 1.7, (r[2] + r[3]) / 2); grp.add(tl);
        }
      }
      // footing sized from the load
      var fArea = total * 1.1 / (state.qa * 1000), fSide = Math.sqrt(fArea);
      box3(fSide, 0.5, fSide, p[0], -1.05, p[1], 0xA5A093);
      var big = arrowDown(Math.min(0.6 + total / 9000, 3.2), 0.12, 0xB5451B);
      big.position.set(p[0], -0.8 + Math.min(0.6 + total / 9000, 3.2), p[1] + 0.9); grp.add(big);
      var fl = label('ΣP = ' + fmt(total) + ' กก. → ฐานรากกว้าง ≈ ' + fmt(fSide, 2) + ' ม.', { color: '#fff', bg: '#14273F', width: 6.6 });
      fl.position.set(p[0], -2.5, p[1] + 0.6); grp.add(fl);
      out.innerHTML = '<b>' + NAMES[key] + '</b> · พื้นที่รับน้ำหนัก ' + a + ' ตร.ม. · ' + n + ' ชั้น' +
        '<br>น้ำหนักต่อชั้น = ' + a + ' × (' + W + ' + ' + BEAM + ' คานและอื่นๆ) = <b>' + fmt(perFloor) + ' กก.</b>' +
        '<br>น้ำหนักรวมลงฐานราก ΣP = <b>' + fmt(total) + ' กก.</b> (ยังไม่รวมน้ำหนักเสา ผนัง และหลังคา)' +
        '<br>พื้นที่ฐานราก ≥ ΣP × 1.1 (รวมน้ำหนักฐาน) ÷ กำลังรับน้ำหนักดิน = ' + fmt(total * 1.1) + ' ÷ ' + fmt(state.qa * 1000) + ' = <b>' + fmt(fArea, 2) + ' ตร.ม.</b> → ฐานรากสี่เหลี่ยมจัตุรัสกว้าง ≈ <b>' + fmt(fSide, 2) + ' ม.</b>' +
        '<br><span class="s3-small">ตัวอย่างเพื่อการศึกษา ใช้ค่าน้ำหนักบรรทุกในบทความ ออกแบบจริงต้องให้วิศวกรตรวจสอบ</span>';
    }
    rebuild();
    var hv0 = home(); st.view(hv0[0], hv0[1], true);
    bar.appendChild(button('หมุนกลับมุมเดิม', function () { var hv = home(); st.view(hv[0], hv[1]); }));
    return { dispose: function () { st.dispose(); } };
  }

  /* =====================================================================
   * Model 3: RC beam with main bars and stirrups. Driven by the 2D beam
   * calculator: update({L,b,h,cov,n,db,s,wu}) is called on every change.
   * ===================================================================== */
  function modelBeam(box) {
    var st = new Stage(box);
    var grp = new T.Group(); st.scene.add(grp);
    var state = { glass: true, stirrups: true, cut: 100, labels: true }, last = null, first = true;
    var plane = new T.Plane(new T.Vector3(-1, 0, 0), 1e6);

    var bar = el('div', 's3-bar'), tog = el('div', 's3-bar'), ctl = el('div', 's3-ctl');
    bar.appendChild(button('ทั้งคาน', function () { state.labels = true; if (last) { rebuild(last); st.view(wholeView(last)[0], wholeView(last)[1]); } }));
    bar.appendChild(button('ดูหน้าตัดที่ปลายคาน', function () { if (last) { state.labels = false; rebuild(last); } if (last) st.view([-last.L / 2 - 1.1, 0.35, 0.9], [-last.L / 2 + 0.2, 0, 0]); }));
    tog.appendChild(checkbox('คอนกรีตโปร่งใส', '#CFCBC2', true, function (on) { state.glass = on; if (last) rebuild(last); }));
    tog.appendChild(checkbox('เหล็กปลอก', '#14273F', true, function (on) { state.stirrups = on; if (last) rebuild(last); }));
    var cutLab = el('label', null, 'ตัดคานดูด้านใน <span class="unit-in"><input type="range" min="2" max="100" step="1" value="100"><em>100%</em></span>');
    ctl.appendChild(cutLab);
    var cutIn = cutLab.querySelector('input');
    cutIn.addEventListener('input', function () { state.cut = +cutIn.value; cutLab.querySelector('em').textContent = state.cut + '%'; applyCut(); });
    var legend = el('div', 's3-small', '<span style="color:#E8742A">■</span> เหล็กยืนล่าง (รับแรงดึง) &nbsp; <span style="color:#3A4556">■</span> เหล็กบน (ยึดเหล็กปลอก) &nbsp; <span style="color:#14273F">■</span> เหล็กปลอก (รับแรงเฉือน) &nbsp; ลากเพื่อหมุน ซูมด้วยล้อเมาส์');
    box.appendChild(bar); box.appendChild(tog); box.appendChild(ctl); box.appendChild(legend);

    function wholeView(p) { return [[p.L * 0.1, p.h / 100 / 2 + 0.5 + p.L * 0.09, p.L * 0.42 + 0.9], [0, -0.05, 0]]; }
    function applyCut() {
      if (!last) return;
      plane.constant = state.cut >= 100 ? 1e6 : -last.L / 2 + last.L * state.cut / 100;
    }
    function rebuild(p) {
      disposeGroup(grp);
      var L = p.L, b = p.b / 100, h = p.h / 100, cov = p.cov / 100, db = p.db / 100, n = p.n, s = Math.max(p.s / 100, 0.04), t = 0.006;
      var clip = [plane];
      var cm = new T.MeshStandardMaterial({ color: 0xBFBBB1, roughness: 0.9, transparent: true, opacity: state.glass ? 0.2 : 0.95, depthWrite: !state.glass, clippingPlanes: clip });
      var conc = new T.Mesh(new T.BoxGeometry(L, h, b), cm); grp.add(conc);
      var ed = new T.LineSegments(new T.EdgesGeometry(conc.geometry), new T.LineBasicMaterial({ color: 0x14273F, transparent: true, opacity: 0.5, clippingPlanes: clip })); grp.add(ed);
      var steel = function (c, m) { return new T.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.35, clippingPlanes: clip }); };
      // main bars (bottom)
      var w = Math.max(b - 2 * cov - 2 * t - db, 0), yb = -h / 2 + cov + t + db / 2;
      for (var i = 0; i < n; i++) {
        var z = n === 1 ? 0 : -w / 2 + i * w / (n - 1);
        var bm = new T.Mesh(new T.CylinderGeometry(db / 2, db / 2, L - 2 * cov, 14), steel(0xE8742A));
        bm.rotation.z = Math.PI / 2; bm.position.set(0, yb, z); grp.add(bm);
      }
      // top hanger bars 2-DB12
      var rt = 0.006, yt = h / 2 - cov - t - rt, zt = b / 2 - cov - t - rt;
      [-zt, zt].forEach(function (z) {
        var tb = new T.Mesh(new T.CylinderGeometry(rt, rt, L - 2 * cov, 10), steel(0x3A4556));
        tb.rotation.z = Math.PI / 2; tb.position.set(0, yt, z); grp.add(tb);
      });
      // stirrups: 4 instanced sides
      if (state.stirrups) {
        var x0 = -L / 2 + 0.05, cnt = Math.min(400, Math.floor((L - 0.1) / s) + 1), bw = b - 2 * cov, bh = h - 2 * cov;
        var sides = [[t, t, bw, 0, -bh / 2, 0], [t, t, bw, 0, bh / 2, 0], [t, bh, t, 0, 0, -bw / 2], [t, bh, t, 0, 0, bw / 2]];
        var dummy = new T.Object3D();
        sides.forEach(function (sd) {
          var im = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), steel(0x14273F), cnt);
          for (var k = 0; k < cnt; k++) {
            dummy.position.set(x0 + k * s, sd[4], sd[5]); dummy.scale.set(sd[0], sd[1], sd[2]); dummy.updateMatrix(); im.setMatrixAt(k, dummy.matrix);
          }
          im.instanceMatrix.needsUpdate = true; grp.add(im);
        });
      }
      // supports
      [-L / 2, L / 2].forEach(function (x) {
        var sup = new T.Mesh(new T.ConeGeometry(0.22, 0.3, 4), stdMat(0x7C93B0)); sup.rotation.y = Math.PI / 4;
        sup.position.set(x, -h / 2 - 0.15, 0); grp.add(sup);
      });
      // uniform load arrows and labels
      var na = Math.max(5, Math.round(L * 2.5));
      for (var a = 0; a < na; a++) {
        var arr = arrowDown(0.3, 0.01, 0xE8742A);
        arr.position.set(-L / 2 + 0.1 + a * (L - 0.2) / (na - 1), h / 2 + 0.34, 0); grp.add(arr);
      }
      var ll = label('Wu = ' + fmt(p.wu) + ' กก./ม.', { color: '#fff', bg: '#A84A14', width: 1.5 }); ll.position.set(0, h / 2 + 0.58, 0); ll.visible = state.labels; grp.add(ll);
      var dl = label('L = ' + fmt(L, 2) + ' ม.   ' + fmt(p.b) + ' × ' + fmt(p.h) + ' ซม.', { color: '#14273F', bg: 'rgba(255,255,255,.9)', width: 2.2 }); dl.position.set(0, -h / 2 - 0.62, 0); dl.visible = state.labels; grp.add(dl);
      var rl = label('เหล็กยืน ' + n + '-DB' + Math.round(p.db * 10) + '   ปลอก RB6@' + fmt(p.s) + ' ซม.', { color: '#fff', bg: '#14273F', width: 3.0 }); rl.position.set(0, -h / 2 - 0.95, 0); rl.visible = state.labels; grp.add(rl);
      applyCut();
      if (first) { var v = wholeView(p); st.view(v[0], v[1], true); first = false; }
    }
    st.camera.position.set(1, 1.6, 3.5);
    return {
      update: function (p) {
        if (!p || !(p.L > 0 && p.b > 0 && p.h > 0 && p.n > 0 && p.db > 0 && p.s > 0)) return;
        last = p; rebuild(p);
      },
      dispose: function () { st.dispose(); }
    };
  }

  window.Sim3D = {
    mount: function (kind, box) {
      try {
        var wrap = el('div', 's3-wrap'); box.appendChild(wrap);
        var m = kind === 'frame3d' ? modelFrame(wrap) : kind === 'loadpath3d' ? modelLoadPath(wrap) : modelBeam(wrap);
        return m;
      } catch (e) {
        if (window.console) console.error('Sim3D', e);
        box.innerHTML = '<div class="s3-load">เบราว์เซอร์หรืออุปกรณ์นี้แสดงโมเดล 3 มิติไม่ได้</div>';
        return null;
      }
    }
  };
})();
