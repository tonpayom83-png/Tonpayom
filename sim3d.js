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
    var g = new T.Group(), head = Math.min(len * 0.4, radius * 4), mat = color && color.isMaterial ? color : stdMat(color);
    var shaft = new T.Mesh(new T.CylinderGeometry(radius, radius, Math.max(len - head, 0.01), 10), mat);
    shaft.position.y = head + (len - head) / 2;
    var cone = new T.Mesh(new T.ConeGeometry(radius * 2.4, head, 14), mat);
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
    this.alive = true; this.tw = null; this.cbs = []; this.last = performance.now();
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
      for (var i = 0; i < self.cbs.length; i++) self.cbs[i](dt);
      self.controls.update();
      self.renderer.render(self.scene, self.camera);
    })(performance.now());
  }
  Stage.prototype.view = function (pos, target, instant) {
    var p1 = new T.Vector3(pos[0], pos[1], pos[2]), t1 = new T.Vector3(target[0], target[1], target[2]);
    if (instant) { this.camera.position.copy(p1); this.controls.target.copy(t1); this.controls.update(); this.tw = null; return; }
    this.tw = { t: 0, p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: p1, t1: t1 };
  };
  Stage.prototype.onFrame = function (fn) { this.cbs.push(fn); };
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
    var W = 440, BEAM = 96, EXAG = 2;
    var state = { n: 2, col: 'center', qa: 10, fs: 0, lam: 1, show: true, fail: 0, failTarget: 0, play: null, lastInfo: 0, stage: '' };
    var grp = new T.Group(); st.scene.add(grp);
    var crackGroup = new T.Group(); st.scene.add(crackGroup);
    var crackGeo = new T.BoxGeometry(1, 1, 1), crackMat = new T.MeshBasicMaterial({ color: 0x2B1D17 });
    var gh = new T.GridHelper(24, 24, 0xC9C3B4, 0xE2DDD0); gh.position.y = -0.001; st.scene.add(gh);
    var D = null;   // dynamic parts of the selected column

    /* ----- UI ----- */
    var bar = el('div', 's3-bar'), ctl = el('div', 's3-ctl'), load = el('div', 's3-ctl'), act = el('div', 's3-bar'), tog = el('div', 's3-bar'), out = el('div', 's3-info');
    var colBtns = {};
    ['center', 'edge', 'corner'].forEach(function (k) {
      var b = button(NAMES[k], function () { stopPlay(); state.col = k; state.lam = 1; rebuild(); });
      colBtns[k] = b; bar.appendChild(b);
    });
    var nLab = el('label', null, 'จำนวนชั้น <span class="unit-in"><input type="range" min="1" max="3" step="1" value="2"><em>2 ชั้น</em></span>');
    var qLab = el('label', null, 'กำลังรับน้ำหนักของดิน qa <span class="unit-in"><input type="number" min="1" step="1" value="10"><em>ตัน/ตร.ม.</em></span>');
    var fOpts = '<option value="0" selected>คำนวณให้พอดี</option>' + [0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0].map(function (v) { return '<option value="' + v + '">กว้าง ' + v.toFixed(1) + ' ม.</option>'; }).join('');
    var fLab = el('label', null, 'ขนาดฐานราก (สี่เหลี่ยมจัตุรัส)<select>' + fOpts + '</select>');
    var lLab = el('label', null, 'น้ำหนักที่กระทำ (เทียบกับที่ใช้ออกแบบ) <span class="unit-in"><input type="range" min="0" max="300" step="1" value="100"><em>100%</em></span>');
    ctl.appendChild(nLab); ctl.appendChild(qLab); ctl.appendChild(fLab); load.appendChild(lLab);
    var nIn = nLab.querySelector('input'), qIn = qLab.querySelector('input'), fSel = fLab.querySelector('select'), lIn = lLab.querySelector('input'), lEm = lLab.querySelector('em');
    nIn.addEventListener('input', function () { stopPlay(); state.n = +nIn.value; nLab.querySelector('em').textContent = state.n + ' ชั้น'; rebuild(); var hv = home(); st.view(hv[0], hv[1]); });
    qIn.addEventListener('input', function () { var v = parseFloat(qIn.value); if (v > 0) { stopPlay(); state.qa = v; rebuild(); } });
    fSel.addEventListener('change', function () { stopPlay(); state.fs = +fSel.value; rebuild(); });
    lIn.addEventListener('input', function () { stopPlay(); setLam(+lIn.value / 100); syncSlider(); });
    act.appendChild(button('▶ เพิ่มน้ำหนักจนดินรับไม่ไหว', function () { startPlay(); }));
    act.appendChild(button('กลับมาที่น้ำหนักออกแบบ', function () { stopPlay(); setLam(1); syncSlider(); }));
    act.appendChild(button('หมุนกลับมุมเดิม', function () { var hv = home(); st.view(hv[0], hv[1]); }));
    tog.appendChild(checkbox('แสดงพื้นที่รับน้ำหนัก (Tributary Area) และลูกศรน้ำหนัก', '#E8742A', true, function (on) { state.show = on; rebuild(); }));
    var hint = el('div', 's3-small', 'ลองเลือกฐานรากให้เล็กลง หรือเลื่อนน้ำหนักเพิ่มขึ้น เพื่อดูว่าดินรับไม่ไหวแล้วโครงสร้างเป็นอย่างไร (ขยายการทรุด ×' + EXAG + ' ให้เห็นชัด)');
    [bar, ctl, load, act, tog, hint, out].forEach(function (e) { box.appendChild(e); });
    function syncSlider() { lIn.value = Math.round(state.lam * 100); lEm.textContent = Math.round(state.lam * 100) + '%'; }

    function home() { var d = 9 + 3.2 * state.n; return [[d * 0.72, d * 0.5 + 1, d * 0.86], [0, state.n * H / 2 + 0.2, 0]]; }
    function color(f) { return new T.Color().setHSL(0.12 - 0.1 * f, 0.85, 0.72 - 0.25 * f); }
    function box3(parent, w, h, d, x, y, z, c, op) {
      var m = new T.Mesh(new T.BoxGeometry(w, h, d), stdMat(c, op)); m.position.set(x, y, z); outline(m, 0.3); parent.add(m); return m;
    }
    function clearCracks() { while (crackGroup.children.length) crackGroup.remove(crackGroup.children[0]); }
    function addCrack(x, y, z, sx, sy, sz) { var m = new T.Mesh(crackGeo, crackMat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); crackGroup.add(m); }

    /* ----- static scene for the current column / storeys ----- */
    function rebuild() {
      disposeGroup(grp); clearCracks();
      var n = state.n, key = state.col, a = AREA[key], perFloor = a * (W + BEAM), Pserv = perFloor * n, p = POS[key], top = n * H;
      var ixS = AX.indexOf(p[0]), izS = AX.indexOf(p[1]);
      for (var k in colBtns) colBtns[k].className = k === key ? 'on' : '';
      var fAuto = Math.sqrt(Pserv * 1.1 / (state.qa * 1000));
      D = { sel: new T.Group(), beams: [], segs: [], foot: null, fside: state.fs > 0 ? state.fs : fAuto, fAuto: fAuto };
      grp.add(D.sel);
      for (var lv = 1; lv <= n; lv++) {
        var y = lv * H;
        for (var line = 0; line < 3; line++) for (var i = 0; i < 2; i++) for (var dir = 0; dir < 2; dir++) {
          var mid = (AX[i] + AX[i + 1]) / 2, cx = dir === 0 ? mid : AX[line], cz = dir === 0 ? AX[line] : mid;
          var bm = box3(grp, dir === 0 ? S - 0.3 : 0.2, 0.4, dir === 0 ? 0.2 : S - 0.3, cx, y - 0.2, cz, 0xD7D3C8);
          var attached = dir === 0 ? (line === izS && (i === ixS - 1 || i === ixS)) : (line === ixS && (i === izS - 1 || i === izS));
          if (attached) {
            var A = dir === 0 ? new T.Vector3(AX[i], y - 0.2, AX[line]) : new T.Vector3(AX[line], y - 0.2, AX[i]);
            var B = dir === 0 ? new T.Vector3(AX[i + 1], y - 0.2, AX[line]) : new T.Vector3(AX[line], y - 0.2, AX[i + 1]);
            var selIsB = dir === 0 ? i + 1 === ixS : i + 1 === izS;
            D.beams.push({ m: bm, dir: dir, N: selIsB ? B : A, F: selIsB ? A : B });
          }
        }
        [-2, 2].forEach(function (sx) { [-2, 2].forEach(function (sz) { box3(grp, S - 0.05, 0.1, S - 0.05, sx, y - 0.05, sz, 0xE6E2D8, 0.45); }); });
      }
      for (var ix = 0; ix < 3; ix++) for (var iz = 0; iz < 3; iz++) {
        if (!(ix === ixS && iz === izS)) { box3(grp, 0.3, top + 0.8, 0.3, AX[ix], (top - 0.8) / 2, AX[iz], 0xC9C4B8); box3(grp, 1.2, 0.4, 1.2, AX[ix], -1.0, AX[iz], 0xBDB8AC); }
      }
      // the chosen column: coloured per segment by the load it carries, and its footing (these settle together)
      for (var seg = 1; seg <= n; seg++) {
        var carried = n - seg + 1, y0 = (seg - 1) * H, y1 = seg * H, yb = seg === 1 ? -0.8 : y0;
        var m = box3(D.sel, 0.4, y1 - yb, 0.4, p[0], (yb + y1) / 2, p[1], color(carried / n));
        m.userData.f = carried / n; D.segs.push(m);
        var lab = label('สะสม ' + fmt(perFloor * carried) + ' กก.', { color: '#14273F', bg: 'rgba(255,255,255,.94)', width: 2.5 });
        lab.position.set(p[0] + 3.9, (yb + y1) / 2, p[1] + 0.9); grp.add(lab);
      }
      D.foot = box3(D.sel, D.fside, 0.5, D.fside, p[0], -1.05, p[1], 0xA5A093);
      // tributary area and arrows
      if (state.show) {
        var r = RECT[key];
        for (var l2 = 1; l2 <= n; l2++) {
          var pl = new T.Mesh(new T.PlaneGeometry(r[1] - r[0], r[3] - r[2]), new T.MeshBasicMaterial({ color: 0xE8742A, transparent: true, opacity: 0.4, side: T.DoubleSide, depthWrite: false }));
          pl.rotation.x = -Math.PI / 2; pl.position.set((r[0] + r[1]) / 2, l2 * H + 0.03, (r[2] + r[3]) / 2); grp.add(pl);
          var ed = new T.LineSegments(new T.EdgesGeometry(new T.PlaneGeometry(r[1] - r[0], r[3] - r[2])), new T.LineBasicMaterial({ color: 0xA84A14 }));
          ed.rotation.x = -Math.PI / 2; ed.position.copy(pl.position); grp.add(ed);
          var nx = Math.max(2, Math.round((r[1] - r[0]) / 1.3)), nz = Math.max(2, Math.round((r[3] - r[2]) / 1.3));
          for (var ax = 0; ax < nx; ax++) for (var az = 0; az < nz; az++) {
            var arr = arrowDown(0.55, 0.035, 0xE8742A);
            arr.position.set(r[0] + (ax + 0.5) * (r[1] - r[0]) / nx, l2 * H + 0.6, r[2] + (az + 0.5) * (r[3] - r[2]) / nz); grp.add(arr);
          }
          var tl = label(a + ' ตร.ม. → ' + fmt(perFloor) + ' กก./ชั้น', { color: '#fff', bg: '#A84A14', width: 3.4 });
          tl.position.set((r[0] + r[1]) / 2, l2 * H + 1.25, (r[2] + r[3]) / 2); grp.add(tl);
        }
      }
      // slider range: a little beyond the load at which the soil fails
      var af = D.fside * D.fside, lamFail = 3 * state.qa * 1000 * af / (1.1 * Pserv);
      lIn.max = Math.ceil(Math.max(3, lamFail * 1.2) * 100);
      state.fail = 0; state.failTarget = 0; state.stage = '';
      syncSlider();
      setLam(state.lam);
    }

    /* ----- behaviour at the current load ----- */
    function setLam(l) {
      state.lam = Math.max(0, l);
      if (!D) return;
      var q = state.lam * AREA[state.col] * (W + BEAM) * state.n * 1.1 / (D.fside * D.fside);
      if (q >= 3 * state.qa * 1000) state.failTarget = 1; else { state.failTarget = 0; state.fail = 0; }
      apply(true);
    }
    function startPlay() {
      if (!D) return;
      var Pserv = AREA[state.col] * (W + BEAM) * state.n, af = D.fside * D.fside;
      state.play = { t: 0, dur: 8, to: 3 * state.qa * 1000 * af / (1.1 * Pserv) * 1.12 };
      state.fail = 0; state.failTarget = 0; setLam(0);
      lIn.max = Math.max(+lIn.max, Math.ceil(state.play.to * 100));
    }
    function stopPlay() { state.play = null; }

    function apply(force) {
      if (!D) return;
      var n = state.n, key = state.col, a = AREA[key], perFloor = a * (W + BEAM), Pserv = perFloor * n, p = POS[key];
      var P = state.lam * Pserv, af = D.fside * D.fside, qa = state.qa * 1000, qu = 3 * qa, q = P * 1.1 / af;
      var stage = q <= qa * 1.0001 ? 'ok' : q < qu ? 'warn' : 'fail', f = stage === 'fail' ? state.fail : 0;
      // qualitative settlement (cm): small up to qa, growing fast between qa and qu, then the soil gives way
      var ds = q <= qa ? 1.5 * Math.pow(Math.max(q / qa, 0), 1.5) : q < qu ? 1.5 + 25 * Math.pow((q - qa) / (qu - qa), 2) : 26.5 + 30 * f;
      var vis = EXAG * ds / 100, c = Math.min(1, Math.max(0, (q - qa) / (qu - qa)));
      D.sel.position.y = -vis;
      D.foot.rotation.z = 0.16 * f;
      D.foot.material.color.setHex(stage === 'fail' ? 0x8A3B24 : 0xA5A093);
      D.segs.forEach(function (m) { m.material.color.copy(stage === 'fail' ? new T.Color(0xB5451B) : color(m.userData.f)); });
      // beams that frame into this column follow it down
      D.beams.forEach(function (b) {
        var Np = b.N.clone(); Np.y -= vis;
        var mid = Np.clone().add(b.F).multiplyScalar(0.5), vx = Np.x - b.F.x, vy = Np.y - b.F.y, vz = Np.z - b.F.z;
        b.m.position.copy(mid);
        if (b.dir === 0) { b.m.rotation.set(0, 0, Math.atan2(vy, vx)); } else { b.m.rotation.set(Math.atan2(-vy, vz), 0, 0); }
      });
      clearCracks();
      if (stage !== 'ok') {
        var cw = 0.004 + 0.03 * c * (1 + f);
        D.beams.forEach(function (b) {
          var Np = b.N.clone(); Np.y -= vis;
          var pt = Np.clone().lerp(b.F, 0.13);
          if (b.dir === 0) addCrack(pt.x, pt.y, pt.z, cw, 0.38, 0.24); else addCrack(pt.x, pt.y, pt.z, 0.24, 0.38, cw);
          var pt2 = Np.clone().lerp(b.F, 0.3);
          if (c > 0.35) { if (b.dir === 0) addCrack(pt2.x, pt2.y, pt2.z, cw * 0.6, 0.3, 0.24); else addCrack(pt2.x, pt2.y, pt2.z, 0.24, 0.3, cw * 0.6); }
        });
      }
      var now = performance.now();
      if (force || now - state.lastInfo > 90 || stage !== state.stage) { state.lastInfo = now; state.stage = stage; renderInfo(stage, P, q, ds, perFloor, a, key, n, af); }
    }

    function renderInfo(stage, P, q, ds, perFloor, a, key, n, af) {
      var qa = state.qa * 1000, qu = 3 * qa, scale = Math.max(qu * 1.15, q), pos = function (v) { return Math.min(100, v / scale * 100); };
      var bar = '<div class="s3-cap"><i class="f ' + (stage === 'fail' ? 'bad' : stage === 'warn' ? 'warn' : '') + '" style="width:' + pos(q) + '%"></i>' +
        '<i class="k y" style="left:' + pos(qa) + '%" title="qa"></i><i class="k m" style="left:' + pos(qu) + '%" title="qu"></i></div>';
      var msg = {
        ok: 'ดินรับน้ำหนักได้อย่างปลอดภัย: แรงกดบนดินไม่เกินค่าที่ยอมให้ (qa) ฐานรากทรุดตัวน้อย อาคารเสถียร',
        warn: 'แรงกดบนดินเกินค่าที่ยอมให้ (q > qa): ฐานรากนี้ทรุดมากกว่าฐานรากข้างเคียง คานที่ต่อกับเสานี้เริ่มแตกร้าวที่รอยต่อกับเสา (รอยดำบนคาน) พื้นและผนังจะร้าวตามมา เหตุการณ์นี้พบบ่อยในงานต่อเติมที่ฐานรากเล็กหรืออยู่บนดินอ่อน',
        fail: 'ดินวิบัติ (q ถึง qu ประมาณ 3 เท่าของ qa): ฐานรากจมและเอียง เสาและคานรอบๆ ทรุดตามและแตกร้าวรุนแรง ถ้าเป็นบ้านจริงต้องรีบอพยพและให้วิศวกรตรวจ'
      }[stage];
      out.innerHTML = '<b>' + NAMES[key] + '</b> · พื้นที่รับน้ำหนัก ' + a + ' ตร.ม. · ' + n + ' ชั้น · น้ำหนักต่อชั้น = ' + a + ' × (' + W + ' + ' + BEAM + ') = <b>' + fmt(perFloor) + ' กก.</b>' +
        '<div>น้ำหนักที่กระทำ ΣP = <b>' + fmt(P) + ' กก.</b> (' + fmt(state.lam * 100) + '% ของที่ใช้ออกแบบ) · ฐานรากกว้าง <b>' + fmt(D.fside, 2) + ' ม.</b> (' + (state.fs > 0 ? 'เลือกเอง' : 'คำนวณให้พอดี: ΣP × 1.1 ÷ qa = ' + fmt(D.fAuto * D.fAuto, 2) + ' ตร.ม.') + ')</div>' +
        bar + '<div class="s3-small">แรงกดบนดิน q = ΣP × 1.1 ÷ พื้นที่ฐาน = <b>' + fmt(q / 1000, 1) + '</b> ตัน/ตร.ม. · ค่าที่ยอมให้ qa = ' + fmt(qa / 1000, 1) + ' · ดินวิบัติที่ประมาณ qu = 3qa = ' + fmt(qu / 1000, 1) + ' ตัน/ตร.ม.</div>' +
        '<div><b' + (stage === 'fail' ? ' style="color:#B5451B"' : '') + '>' + { ok: 'ปลอดภัย', warn: 'เกินค่าที่ยอมให้', fail: 'พังแล้ว' }[stage] + '</b> · ' + msg + '</div>' +
        '<div class="s3-small">การทรุดตัวในโมเดลเป็นแบบจำลองเชิงคุณภาพเพื่อการเรียนรู้ (ประมาณ ' + fmt(ds, 1) + ' ซม.) ไม่ใช่การคำนวณการทรุดตัวจริง ค่าน้ำหนักใช้ตามบทความ ออกแบบจริงต้องให้วิศวกรตรวจสอบ</div>';
    }

    st.onFrame(function (dt) {
      if (!D) return;
      var dirty = false;
      if (state.play) {
        state.play.t += dt; var u = Math.min(1, state.play.t / state.play.dur);
        state.lam = state.play.to * u; syncSlider();
        var Pserv = AREA[state.col] * (W + BEAM) * state.n, af = D.fside * D.fside;
        if (state.lam * Pserv * 1.1 / af >= 3 * state.qa * 1000) state.failTarget = 1;
        if (u >= 1) state.play = null;
        dirty = true;
      }
      if (state.fail < state.failTarget) { state.fail = Math.min(state.failTarget, state.fail + dt / 1.2); dirty = true; }
      if (dirty) apply();
    });
    rebuild();
    var hv0 = home(); st.view(hv0[0], hv0[1], true);
    return { dispose: function () { crackGeo.dispose(); crackMat.dispose(); st.dispose(); } };
  }

  /* =====================================================================
   * Model 3: RC beam with main bars and stirrups, driven by the 2D beam
   * calculator, and a load test: as the load grows the beam goes through
   *   elastic -> flexural cracks -> steel yields -> failure
   * and fails the way the section really would:
   *   ductile   under-reinforced: steel yields, big sag, concrete crushes at the top
   *   brittle   over-reinforced: concrete crushes first, little sag, no warning
   *   minsteel  too little steel: snaps right after the first crack
   *   shear     diagonal cracks near the support, sudden, the end drops
   * update(p): p = {L,b,h,cov,n,db,s,wu,wd,wl,fc,fy,pass}  (m, cm, kg, ksc; s = 0 -> no stirrups)
   * Simplified textbook behaviour for teaching (Branson Ie, strain compatibility), not a design tool.
   * ===================================================================== */
  function analyzeBeam(p) {
    var Lc = p.L * 100, b = p.b, h = p.h, db = p.db, fc = p.fc, fy = p.fy, dv = 0.6;
    var d = h - p.cov - dv - db / 2, As = p.n * Math.PI * db * db / 4;
    var beta1 = fc <= 280 ? 0.85 : Math.max(0.65, 0.85 - 0.05 * (fc - 280) / 70);
    var Ec = 15100 * Math.sqrt(fc), Es = 2.04e6, nm = Es / Ec;
    var Ig = b * h * h * h / 12, Mcr = 2 * Math.sqrt(fc) * Ig / (h / 2);
    var kd = (-nm * As + Math.sqrt(nm * nm * As * As + 2 * b * nm * As * d)) / b;
    var Icr = b * kd * kd * kd / 3 + nm * As * (d - kd) * (d - kd);
    var ay = As * fy / (0.85 * fc * b), cy = ay / beta1;
    var yieldsSteel = 0.003 * (d - cy) / cy >= fy / Es, Mn, My;
    var rhoMaxB = 0.75 * 0.85 * beta1 * fc / fy * 6120 / (6120 + fy), ductile = yieldsSteel && As / (b * d) <= rhoMaxB;
    if (yieldsSteel) {
      Mn = As * fy * (d - ay / 2);
      My = As * fy * (d - kd / 3);
      if (My > Mn) My = Mn * 0.92;
      if (!ductile) My = Mn;
    } else {
      var A = 0.85 * fc * beta1 * b, B = As * Es * 0.003, C = -As * Es * 0.003 * d;
      var c = (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A);
      Mn = 0.85 * fc * beta1 * c * b * (d - beta1 * c / 2);
      My = Mn;
    }
    var Vc = 0.53 * Math.sqrt(fc) * b * d, Av = 2 * Math.PI * 0.36 / 4;
    var Vs = p.s > 0 ? Math.min(Av * 2400 * d / p.s, 2.1 * Math.sqrt(fc) * b * d) : 0, Vn = Vc + Vs;
    var Lm = p.L, crit = Lm / 2 - d / 100;
    var toW = function (Mkgcm) { return 8 * (Mkgcm / 100) / (Lm * Lm); };          // kg/m that gives this midspan moment
    var Mfail = Mn < Mcr ? Mcr : Mn;
    var wFlex = toW(Mfail), wShear = crit > 0 ? Vn / crit : 1e9;
    var mode = wShear < wFlex ? 'shear' : Mn < Mcr ? 'minsteel' : ductile ? 'ductile' : 'brittle';
    return {
      Lc: Lc, d: d, As: As, Ec: Ec, Ig: Ig, Icr: Icr, kd: kd, Mcr: Mcr, My: My, Mn: Mn, Mfail: Mfail, Vc: Vc, Vn: Vn, crit: crit,
      mode: mode, ductile: ductile, wFail: Math.min(wFlex, wShear), wFlex: wFlex, wShear: wShear
    };
  }
  function beamDelta(R, M) {            // mid-span deflection in cm for midspan moment M (kg-cm), Branson effective inertia
    var Lc = R.Lc, w = 8 * M / (Lc * Lc), Ie = R.Ig;
    if (M > R.Mcr) { var r = Math.pow(R.Mcr / M, 3); Ie = Math.min(R.Ig, r * R.Ig + (1 - r) * R.Icr); }
    return 5 * w * Math.pow(Lc, 4) / (384 * R.Ec * Ie);
  }

  function modelBeam(box) {
    var st = new Stage(box);
    var grp = new T.Group(); st.scene.add(grp);
    var crackGroup = new T.Group(); st.scene.add(crackGroup);
    var crackGeo = new T.BoxGeometry(1, 1, 1);
    var crackMat = new T.MeshBasicMaterial({ color: 0x2B1D17 });
    var plane = new T.Plane(new T.Vector3(-1, 0, 0), 1e6);
    var S = { glass: true, stirrups: true, cut: 100, labels: true, lam: 1, fail: 0, failTarget: 0, play: null, exag: 3, lastInfo: 0 };
    var P = null, R = null, M = null, first = true;

    /* ----- UI ----- */
    var bar = el('div', 's3-bar'), tog = el('div', 's3-bar'), ctl = el('div', 's3-ctl'), load = el('div', 's3-ctl'), act = el('div', 's3-bar');
    var info = el('div', 's3-info');
    bar.appendChild(button('ทั้งคาน', function () { S.labels = true; if (P) { rebuild(); view(0); } }));
    bar.appendChild(button('มองด้านข้าง (ดูรอยร้าว)', function () { if (P) view(1); }));
    bar.appendChild(button('ดูหน้าตัดที่ปลายคาน', function () { if (P) { S.labels = false; rebuild(); view(2); } }));
    tog.appendChild(checkbox('คอนกรีตโปร่งใส', '#CFCBC2', true, function (on) { S.glass = on; if (P) rebuild(); }));
    tog.appendChild(checkbox('เหล็กปลอก', '#14273F', true, function (on) { S.stirrups = on; if (P) rebuild(); }));
    var cutLab = el('label', null, 'ตัดคานดูด้านใน <span class="unit-in"><input type="range" min="2" max="100" step="1" value="100"><em>100%</em></span>');
    var cutIn = cutLab.querySelector('input');
    cutIn.addEventListener('input', function () { S.cut = +cutIn.value; cutLab.querySelector('em').textContent = S.cut + '%'; applyCut(); });
    var loadLab = el('label', null, 'น้ำหนักบรรทุกที่กระทำ <span class="unit-in"><input type="range" min="0" max="200" step="1" value="100"><em>100%</em></span>');
    var loadIn = loadLab.querySelector('input'), loadEm = loadLab.querySelector('em');
    loadIn.addEventListener('input', function () { stopPlay(); setLam(+loadIn.value / 100); syncSlider(); });
    ctl.appendChild(cutLab); load.appendChild(loadLab);
    act.appendChild(button('▶ เพิ่มน้ำหนักจนพัง', function () { startPlay(); }));
    act.appendChild(button('ตั้งที่น้ำหนักออกแบบ (Wu)', function () { stopPlay(); if (P) setLam(P.wu / (P.wd + P.wl)); syncSlider(); }));
    var legend = el('div', 's3-small', '<span style="color:#E8742A">■</span> เหล็กยืนล่าง (รับแรงดึง) · <span style="color:#D8321B">■</span> เหล็กที่ครากแล้ว · <span style="color:#3A4556">■</span> เหล็กบน · <span style="color:#14273F">■</span> เหล็กปลอก · เส้นดำบนคาน = รอยร้าว (ขยายการแอ่น ×' + S.exag + ' ให้เห็นชัด)');
    var cap = el('div', 's3-small');
    [bar, tog, ctl, load, act, cap, info, legend].forEach(function (e) { box.appendChild(e); });

    /* ----- view presets ----- */
    function view(kind) {
      var L = P.L, h = P.h / 100, k = Math.max(1, 1.7 / (st.camera.aspect || 1.6));
      if (kind === 0) st.view([L * 0.1 * k, h / 2 + 0.6 + L * 0.1 * k, (L * 0.52 + 1.1) * k], [0, -0.1, 0]);
      else if (kind === 1) st.view([0, 0.05, (L * 0.62 + 1.3) * k], [0, -0.1, 0]);
      else st.view([-L / 2 - 1.1, 0.35, 0.9], [-L / 2 + 0.2, 0, 0]);
    }
    function rebuild() { build(P); apply(); }
    function applyCut() { if (P) plane.constant = S.cut >= 100 ? 1e6 : -P.L / 2 + P.L * S.cut / 100; }

    /* ----- deformable geometry: store base positions, displace y by the deflection profile ----- */
    var regs = [];
    function register(geo, xoff) {
      var pos = geo.attributes.position; regs.push({ g: geo, pos: pos, base: pos.array.slice(), xoff: xoff || 0 });
    }
    var prof = function () { return 0; };
    function deformAll() {
      var L = P.L;
      regs.forEach(function (r) {
        var a = r.pos.array, b = r.base;
        for (var i = 0; i < a.length; i += 3) { a[i + 1] = b[i + 1] + prof(b[i] + r.xoff + L / 2); }
        r.pos.needsUpdate = true;
      });
    }

    /* ----- build the meshes for the current parameters ----- */
    function build(p) {
      disposeGroup(grp); regs = []; clearCracks();
      P = p; R = analyzeBeam(p);
      var L = p.L, b = p.b / 100, h = p.h / 100, cov = p.cov / 100, db = p.db / 100, n = p.n, t = 0.006, clip = [plane];
      M = { stir: null, arrows: [] };
      var cg = new T.BoxGeometry(L, h, b, 80, 1, 1);
      var cm = new T.MeshStandardMaterial({ color: 0xBFBBB1, roughness: 0.9, transparent: true, opacity: S.glass ? 0.2 : 0.95, depthWrite: !S.glass, clippingPlanes: clip });
      var conc = new T.Mesh(cg, cm); conc.frustumCulled = false; grp.add(conc); register(cg);
      var eg = new T.EdgesGeometry(cg);
      var ed = new T.LineSegments(eg, new T.LineBasicMaterial({ color: 0x14273F, transparent: true, opacity: 0.5, clippingPlanes: clip })); ed.frustumCulled = false; grp.add(ed); register(eg);
      var steel = function (c) { return new T.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.35, clippingPlanes: clip }); };
      var barGeo = function (r, len) { var g = new T.CylinderGeometry(r, r, len, 10, 80); g.rotateZ(Math.PI / 2); return g; };
      M.barMat = steel(0xE8742A);
      var w = Math.max(b - 2 * cov - 2 * t - db, 0), yb = -h / 2 + cov + t + db / 2;
      for (var i = 0; i < n; i++) {
        var g1 = barGeo(db / 2, L - 2 * cov), bm = new T.Mesh(g1, M.barMat); bm.frustumCulled = false;
        bm.position.set(0, yb, n === 1 ? 0 : -w / 2 + i * w / (n - 1)); grp.add(bm); register(g1);
      }
      var rt = 0.006, yt = h / 2 - cov - t - rt, zt = b / 2 - cov - t - rt, topMat = steel(0x3A4556);
      [-zt, zt].forEach(function (z) {
        var g2 = barGeo(rt, L - 2 * cov), tb = new T.Mesh(g2, topMat); tb.frustumCulled = false;
        tb.position.set(0, yt, z); grp.add(tb); register(g2);
      });
      if (S.stirrups && p.s > 0) {
        var s = Math.max(p.s / 100, 0.04), x0 = -L / 2 + 0.05, cnt = Math.min(400, Math.floor((L - 0.1) / s) + 1), bw = b - 2 * cov, bh = h - 2 * cov;
        var sides = [[t, t, bw, -bh / 2, 0], [t, t, bw, bh / 2, 0], [t, bh, t, 0, -bw / 2], [t, bh, t, 0, bw / 2]];
        M.stir = { cnt: cnt, s: s, x0: x0, sides: sides, meshes: sides.map(function () {
          var im = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), steel(0x14273F), cnt); im.frustumCulled = false; grp.add(im); return im;
        }) };
      }
      [-L / 2, L / 2].forEach(function (x) {
        var sup = new T.Mesh(new T.ConeGeometry(0.22, 0.3, 4), stdMat(0x7C93B0)); sup.rotation.y = Math.PI / 4;
        sup.position.set(x, -h / 2 - 0.15, 0); grp.add(sup);
      });
      M.arrowMat = stdMat(0xE8742A);
      var na = Math.max(5, Math.round(L * 2.5));
      for (var a = 0; a < na; a++) {
        var arr = arrowDown(0.3, 0.01, M.arrowMat);
        arr.position.set(-L / 2 + 0.1 + a * (L - 0.2) / (na - 1), h / 2 + 0.34, 0); grp.add(arr);
      }
      M.patch = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshBasicMaterial({ color: 0xB5451B, transparent: true, opacity: 0.9 }));
      M.patch.visible = false; grp.add(M.patch);
      var lab = function (txt, o, y) { var sp = label(txt, o); sp.position.set(0, y, 0); sp.visible = S.labels; grp.add(sp); };
      lab('Wu = ' + fmt(p.wu) + ' กก./ม.', { color: '#fff', bg: '#A84A14', width: 1.5 }, h / 2 + 0.58);
      cap.innerHTML = '<b>คานนี้:</b> ช่วง L = ' + fmt(L, 2) + ' ม. · ขนาด ' + fmt(p.b) + ' × ' + fmt(p.h) + ' ซม. · เหล็กยืน ' + n + '-DB' + Math.round(p.db * 10) + ' · ' + (p.s > 0 ? 'เหล็กปลอก RB6@' + fmt(p.s) + ' ซม.' : 'ไม่มีเหล็กปลอก');
      applyCut();
      // slider range: up to a bit over the failure load
      var wServ = p.wd + p.wl, lamU = p.wu / wServ, lamF = R.wFail / wServ;
      loadIn.max = Math.ceil(Math.max(lamU * 1.25, lamF * 1.2, 1.5) * 100);
      if (first) { view(0); first = false; }
    }

    /* ----- state at the current load ----- */
    function setLam(l) {
      S.lam = Math.max(0, l);
      if (!P) return;
      var failedNow = S.lam * (P.wd + P.wl) >= R.wFail;
      if (failedNow) S.failTarget = 1; else { S.failTarget = 0; S.fail = 0; }
      apply(true);
    }
    function syncSlider() { loadIn.value = Math.round(S.lam * 100); loadEm.textContent = Math.round(S.lam * 100) + '%'; }
    function startPlay() {
      if (!P) return;
      var wServ = P.wd + P.wl;
      S.play = { t: 0, to: R.wFail / wServ * 1.03, dur: 8 };
      S.fail = 0; S.failTarget = 0; setLam(0);
      loadIn.max = Math.max(+loadIn.max, Math.ceil(S.play.to * 100));
    }
    function stopPlay() { S.play = null; }

    function clearCracks() { while (crackGroup.children.length) crackGroup.remove(crackGroup.children[0]); }
    function addCrack(x, y, z, sx, sy, sz, rotZ) {
      var m = new T.Mesh(crackGeo, crackMat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); if (rotZ) m.rotation.z = rotZ; crackGroup.add(m);
    }

    function apply(force) {
      if (!P || !R) return;
      var L = P.L, h = P.h / 100, b = P.b / 100, wServ = P.wd + P.wl, w = S.lam * wServ;
      var failedNow = w >= R.wFail, f = failedNow ? S.fail : 0;
      var wEff = Math.min(w, R.wFail), Meff = wEff * L * L / 8 * 100;                 // kg-cm (clamped at failure)
      var yielded = R.ductile && R.mode !== 'minsteel' && Meff >= R.My;
      var stage = failedNow ? 'fail' : yielded ? 'yield' : Meff >= R.Mcr ? 'crack' : 'elastic';
      var mid = beamDelta(R, Meff), beta = 0;
      if (yielded && R.mode !== 'minsteel') {
        var dy = beamDelta(R, R.My), du = Math.max(0.045 * R.Lc, dy * 2.5);
        beta = Math.min(1, (Meff - R.My) / Math.max(R.Mfail - R.My, 1));
        mid = dy + (du - dy) * Math.pow(beta, 0.75);
      }
      var visMid = S.exag * mid / 100;
      prof = function (xm) {
        var xi = Math.min(1, Math.max(0, xm / L)), el = 3.2 * (xi - 2 * xi * xi * xi + xi * xi * xi * xi), tri = 1 - Math.abs(2 * xi - 1);
        var y = visMid * ((1 - beta) * el + beta * tri);
        if (f > 0) {
          if (R.mode === 'shear') y += f * 0.1 * L * (1 - xi);                       // the cracked end drops
          else { var fm = (R.mode === 'ductile' ? 0.18 : 0.16) * L, e = f * f * (3 - 2 * f); y = y * (1 - e) + fm * tri * e; }
        }
        return -y;
      };
      deformAll();
      // stirrups follow the sag
      if (M.stir) {
        var dummy = new T.Object3D();
        M.stir.meshes.forEach(function (im, si) {
          var sd = M.stir.sides[si];
          for (var k = 0; k < M.stir.cnt; k++) {
            var x = M.stir.x0 + k * M.stir.s;
            dummy.position.set(x, sd[3] + prof(x + L / 2), sd[4]); dummy.scale.set(sd[0], sd[1], sd[2]); dummy.updateMatrix(); im.setMatrixAt(k, dummy.matrix);
          }
          im.instanceMatrix.needsUpdate = true;
        });
      }
      M.barMat.color.setHex(yielded || (failedNow && R.mode === 'minsteel') ? 0xD8321B : 0xE8742A);
      M.arrowMat.color.setHex(failedNow ? 0xB5451B : 0xE8742A);
      // ----- cracks -----
      clearCracks();
      var zf = b / 2 + 0.0015, sp = Math.max(0.1, Math.min(0.2, P.s > 0 ? P.s / 100 : 0.15));
      if (Meff >= R.Mcr) {
        var ratio = R.Mcr / Meff, xi1 = (1 - Math.sqrt(Math.max(0, 1 - ratio))) / 2, span = L - 2 * xi1 * L;
        var cnt = Math.min(40, Math.floor(span / sp) + 1);
        for (var k = 0; k < cnt; k++) {
          var xm = L / 2 + (k - (cnt - 1) / 2) * sp, xi = xm / L, mloc = 4 * xi * (1 - xi) * Meff;
          var q = Math.min(1.2, Math.max(0, (mloc - R.Mcr) / Math.max(R.Mfail - R.Mcr, 1)));
          var hf = Math.min(0.9, 0.25 + 0.65 * q), ch = hf * h, cw = (0.0015 + 0.011 * q) * (yielded ? 1.3 : 1) * (1 + 0.5 * f);
          var y = -h / 2 + ch / 2 + prof(xm);
          addCrack(xm - L / 2, y, zf, cw, ch, 0.003); addCrack(xm - L / 2, y, -zf, cw, ch, 0.003);
        }
      }
      var Vd = wEff * R.crit, nu = Vd / R.Vc;
      if (nu >= 0.8 && R.crit > 0) {
        var width = 0.002 + 0.016 * Math.min(1.3, Math.max(0, (nu - 0.8) / Math.max(R.Vn / R.Vc - 0.8, 0.05))), hc = h * 0.85;
        [-1, 1].forEach(function (sg) {
          var wide = (R.mode === 'shear' && sg === -1) ? 1 + f * 2.5 : 1;
          [0, 0.22].forEach(function (off) {
            var a0 = 0.12 + off, xm = sg === -1 ? a0 + hc / 2 : L - a0 - hc / 2, y = -h / 2 + hc / 2 + prof(xm);
            addCrack(xm - L / 2, y, zf, width * wide, hc * 1.414, 0.003, sg === -1 ? Math.PI / 4 : -Math.PI / 4);
            addCrack(xm - L / 2, y, -zf, width * wide, hc * 1.414, 0.003, sg === -1 ? Math.PI / 4 : -Math.PI / 4);
          });
        });
      }
      // crushing of the top concrete at midspan
      var crush = R.mode !== 'shear' && (failedNow || Meff >= 0.93 * R.Mfail);
      M.patch.visible = crush;
      if (crush) {
        var g = failedNow ? 0.5 + 0.5 * f : 0.25;
        M.patch.scale.set(0.3 + 0.35 * g, 0.12 * h + 0.2 * h * g, b * 1.02); M.patch.position.set(0, h / 2 - M.patch.scale.y / 2, 0);
        M.patch.position.y += prof(L / 2);
      }
      // ----- readout (throttled) -----
      var now = performance.now();
      if (force || now - S.lastInfo > 90 || stage !== S.stage) { S.lastInfo = now; S.stage = stage; renderInfo(stage, w, Meff, mid, f); }
    }

    var MODE_TXT = {
      ductile: 'วิบัติจากแรงดัดแบบเหนียว: เหล็กยืนครากต่อเนื่อง คานแอ่นมากและรอยร้าวกว้างจนส่วนบนของคอนกรีตถูกบดแตก (จุดแดงบนคาน) แล้วพังลง ก่อนพังจะมีสัญญาณเตือนให้เห็น',
      brittle: 'วิบัติจากแรงดัดแบบเปราะ: ใส่เหล็กมากเกินไป คอนกรีตส่วนบนถูกบดแตกก่อนที่เหล็กจะคราก คานแอ่นน้อยและพังฉับพลันโดยแทบไม่มีสัญญาณเตือน อันตรายกว่าแบบเหนียว',
      minsteel: 'เหล็กน้อยเกินไป: พอคอนกรีตเริ่มแตกร้าว เหล็กรับแรงแทนไม่ไหวและครากทันที คานพังฉับพลัน',
      shear: 'วิบัติจากแรงเฉือน: เกิดรอยร้าวเฉียงประมาณ 45° ใกล้จุดรองรับแล้วแยกออกทันที ปลายคานตกลง เป็นการพังแบบเปราะและอันตรายมาก เพราะเหล็กปลอกไม่พอ'
    };
    var ISSUE = { size: 'หน้าตัดเล็กเกินไป', over: 'ใส่เหล็กมากเกินไป (ถ้าพังจะพังฉับพลันแบบเปราะ)', min: 'เหล็กน้อยกว่าขั้นต่ำ (จะพังฉับพลันทันทีที่คอนกรีตแตกร้าว)', flex: 'กำลังดัดไม่พอ', shear: 'เหล็กปลอกไม่พอรับแรงเฉือน (ถ้าพังจะพังฉับพลันที่ปลายคาน)' };
    function why() { var t = (P.issues || []).map(function (k) { return ISSUE[k]; }).filter(Boolean); return t.length ? t.join(' และ ') : 'ผลตรวจบางข้อไม่ผ่านตามเกณฑ์ที่กำหนด'; }
    function stageText(stage, f) {
      if (stage === 'elastic') return 'ยังไม่แตกร้าว: คอนกรีตรับแรงดึงเองได้ คานแอ่นน้อยมาก';
      if (stage === 'crack') return 'เริ่มแตกร้าวที่ท้องคานกลางช่วง: คอนกรีตส่วนล่างรับแรงดึงไม่ไหว เหล็กยืนเริ่มรับแรงแทน รอยร้าวเส้นเล็กเป็นเรื่องปกติของคอนกรีตเสริมเหล็ก';
      if (stage === 'yield') return 'เหล็กยืนครากแล้ว (เหล็กเปลี่ยนเป็นสีแดง): คานแอ่นเพิ่มเร็วขึ้นและรอยร้าวกว้างขึ้น นี่คือสัญญาณเตือนก่อนพัง ถ้าเห็นของจริงต้องรีบลดน้ำหนักและอพยพ';
      return (f < 0.4 ? 'กำลังพัง… ' : '') + MODE_TXT[R.mode];
    }
    function renderInfo(stage, w, Meff, mid, f) {
      var L = P.L, wServ = P.wd + P.wl, scale = Math.max(R.Mfail / 100 * 1.2, w * L * L / 8);
      var pos = function (Mkgm) { return Math.min(100, Mkgm / scale * 100); };
      var Mu = P.wu * L * L / 8, k = function (Mkgm, cls, t) { return '<i class="k ' + cls + '" style="left:' + pos(Mkgm) + '%" title="' + t + '"></i>'; };
      var bar = '<div class="s3-cap"><i class="f ' + (stage === 'fail' ? 'bad' : stage === 'yield' ? 'warn' : '') + '" style="width:' + pos(Math.min(w * L * L / 8, scale)) + '%"></i>' +
        k(R.Mcr / 100, 'c', 'แตกร้าว') + (R.ductile ? k(R.My / 100, 'y', 'เหล็กคราก') : '') + k(R.Mfail / 100, 'm', 'พัง') + k(Mu, 'u', 'Mu ออกแบบ') + '</div>' +
        '<div class="s3-small">โมเมนต์กลางช่วง: เส้นเริ่มแตกร้าว ' + fmt(R.Mcr / 100) + (R.ductile ? ' · เหล็กคราก ' + fmt(R.My / 100) : '') + ' · พัง ' + fmt(R.Mfail / 100) + ' · Mu ออกแบบ ' + fmt(Mu) + ' กก.-ม.</div>';
      var Mapp = w * L * L / 8, head = stage === 'fail' ? '<b style="color:#B5451B">พังแล้ว</b>' : '<b>' + { elastic: 'ปกติ', crack: 'แตกร้าว', yield: 'เหล็กครากแล้ว' }[stage] + '</b>';
      var reserve = R.wFail / P.wu;
      var verdict = reserve < 1
        ? 'ที่น้ำหนักออกแบบ Wu = ' + fmt(P.wu) + ' กก./ม. คานนี้<b>รับไม่ไหว</b> (กำลังจริงรับได้ ' + fmt(R.wFail) + ' กก./ม. = ' + fmt(reserve * 100) + '% ของ Wu)'
        : 'ที่น้ำหนักออกแบบ Wu = ' + fmt(P.wu) + ' กก./ม. คานนี้ยังไม่พัง พังเมื่อน้ำหนักถึง ' + fmt(R.wFail) + ' กก./ม. (เหลือกำลังสำรอง ' + fmt((reserve - 1) * 100) + '% จากน้ำหนักออกแบบ)' + (P.pass ? '' : ' แต่<b>ไม่ผ่านเกณฑ์ออกแบบ</b> เพราะ' + why() + ' กด "เพิ่มน้ำหนักจนพัง" เพื่อดูว่าจะพังแบบไหน');
      info.innerHTML = bar + '<div>' + head + ' · น้ำหนักที่กระทำ ' + fmt(w) + ' กก./ม. (' + fmt(w / wServ * 100) + '% ของ wD+wL) · โมเมนต์ ' + fmt(Mapp) + ' กก.-ม.</div>' +
        '<div>' + stageText(stage, f) + '</div>' +
        (stage === 'fail' ? '' : '<div class="s3-small">การแอ่นตัวจริงประมาณ ' + fmt(mid, 1) + ' ซม. (ในโมเดลขยาย ×' + S.exag + ')</div>') +
        '<div>' + verdict + '</div>';
    }

    /* ----- per-frame: play button and collapse animation ----- */
    st.onFrame(function (dt) {
      if (!P) return;
      var dirty = false;
      if (S.play) {
        S.play.t += dt; var u = Math.min(1, S.play.t / S.play.dur);
        S.lam = S.play.to * u; syncSlider();
        if (S.lam * (P.wd + P.wl) >= R.wFail) S.failTarget = 1;
        if (u >= 1) S.play = null;
        dirty = true;
      }
      if (S.fail < S.failTarget) { S.fail = Math.min(S.failTarget, S.fail + dt / 0.8); dirty = true; }
      if (dirty) apply();
    });
    st.camera.position.set(1, 1.6, 3.5);

    return {
      update: function (p) {
        if (!p || !(p.L > 0 && p.b > 0 && p.h > 0 && p.n > 0 && p.db > 0 && p.fc > 0 && p.fy > 0)) return;
        stopPlay(); var Lprev = S.lastL; build(p); S.lastL = p.L;
        if (Lprev && Math.abs(p.L - Lprev) / Lprev > 0.15) view(0);
        S.lam = p.wu / (p.wd + p.wl); S.fail = 0; S.failTarget = 0; syncSlider();
        setLam(S.lam);
      },
      dispose: function () { crackGeo.dispose(); crackMat.dispose(); st.dispose(); }
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
