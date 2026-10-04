/* Preen, Pixelfeld: ein Canvas hinter den Sektionen malt ihre Flaechen in Zellen wie im Hero.
   Ein Canvas-Pixel ist eine Zelle, CSS skaliert scharf hoch. Unter [data-calm] nie eine Zelle. */
(function () {
  "use strict";
  var doc = document.documentElement, body = document.body, win = window, MA = Math;
  var floor = MA.floor, ceil = MA.ceil, round = MA.round, min = MA.min, max = MA.max;
  var hosts = document.querySelectorAll("[data-field]");
  var cv = document.createElement("canvas");
  var ctx = hosts.length > 1 && cv.getContext && cv.getContext("2d");
  if (!ctx) return;
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var box = document.createElement("div");
  box.className = "field";
  box.setAttribute("aria-hidden", "true");
  box.appendChild(cv);
  body.prepend(box);

  var hash = function (x, y) {
    var h = MA.imul(x, 374761393) ^ MA.imul(y, 668265263);
    h = MA.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  var noise = function (x, y) {
    var i = floor(x), j = floor(y), u = x - i, v = y - j, a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1);
    u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
    return a + (b - a) * u + (c - a) * v + (a - b - c + hash(i + 1, j + 1)) * u * v;
  };

  var css = getComputedStyle(doc);
  var rgb = function (s) {   /* #rrggbb als 32 Bit fuer ImageData */
    var n = parseInt(s.trim().slice(1), 16);
    return (0xff000000 | (n & 255) << 16 | (n & 0xff00) | (n >> 16 & 255)) >>> 0;
  };
  var tok = function (n) { return css.getPropertyValue(n).split(",").map(rgb); };
  var type = function (el) { return el ? max(0, ["photo", "light", "surface", "deep", "green"].indexOf(el.dataset.field)) : 1; };
  var BASE = [0, tok("--c-bg")[0], tok("--c-surface")[0], tok("--c-deep")[0], tok("--c-green")[0]];   /* 4: Fragen, dunkel wie 3, ohne Licht und Spur */
  var TINT = [0, "light", "surface", "deep", "green"].map(function (n) { return n && [1, 2, 3].map(function (k) { return tok("--field-" + n + "-" + k)[0]; }); });
  var THR = [2, 2, 2, 2, 2], FREQ = [0, 0.45, 0.45, 0.23, 0.23];      /* kein Zellwetter in den Flaechen: Pixel sind Kante, nie Zustand */
  var PHOTO = tok("--field-trail-light"), TDEEP = tok("--field-trail-deep");
  var LOOSE_L = tok("--field-loose-light"), LOOSE_D = tok("--field-loose-deep");
  /* Leuchten in dunklen Flaechen ([data-glow]): Stufen aus --field-glow, dazwischen geordnet gedithert wie Pixel-Art */
  var GLOW = tok("--field-glow"), NG = GLOW.length - 1;
  var BAYER2 = [0, 2, 3, 1];   /* 2 x 2, geordnetes Dithering zwischen den Lichtstufen: Pixelbaender statt Rauschen */
  /* ein Zellpaar kippt mit eigenem Takt um eine Zeile nach oben oder unten, meist bleibt es auf der Welle */
  var loose = function (q, E, sg, t) {
    var ep = floor(t * 0.25 + hash(q, 37 * E.k) * 5);
    return hash(q + 7 * E.k + ep * 131, sg + 59 * E.k) < E.p * 1.6;
  };
  var flip = function (pr, k, t) {
    var f = hash(pr + floor(t * 0.12 + hash(pr, 23 + k) * 9) * 61, 31 + k);
    return f < 0.08 ? -1 : f > 0.92 ? 1 : 0;
  };
  var mix = function (a, b, f) {
    for (var o = 0xff000000, s = 0; s < 24; s += 8) o |= ((a >> s & 255) * f + (b >> s & 255) * (1 - f)) << s;
    return o >>> 0;
  };

  /* Flaechen, Fugen und ruhige Zonen in Zellen des Dokuments */
  var cell = 0, cols = 0, areas, edges, zones, glows, trail = new Map();
  var pos = function (el, k) { for (var v = 0; el; el = el.offsetParent) v += el[k]; return v; };
  var layout = function () {
    var probe = box.appendChild(document.createElement("i"));
    probe.style.cssText = "position:absolute;width:var(--field-cell)";
    cell = probe.getBoundingClientRect().width || 24;
    probe.remove();
    cols = ceil(doc.clientWidth / cell);
    areas = []; edges = []; zones = []; glows = [];
    document.querySelectorAll("[data-glow]").forEach(function (el) {
      var x = pos(el, "offsetLeft"), y = pos(el, "offsetTop"), w = el.offsetWidth, h = el.offsetHeight;
      var at = el.querySelector("[data-glow-at]") || el, ay = pos(at, "offsetTop") + at.offsetHeight / 2;
      var ax = pos(at, "offsetLeft") + at.offsetWidth / 2;
      var stop = el.querySelector("[data-glow-end]") || el.querySelector("h2"), sy0 = stop ? pos(stop, "offsetTop") : ay + at.offsetHeight;
      /* Licht wie in inspo/startseite/07-download.png: zwei grosse Kegel, ihre Mitten liegen ueber der Sektion. Sichtbar sind
         ihre unteren Boegen links und rechts vom Icon, sie reichen hinter die Headline und klingen vor den Buttons aus.
         Die Stufen sind so dunkel, dass weisser Text darauf immer lesbar bleibt. Nur dunkle Zellen leuchten */
      var top = floor(y / cell), r0 = top + 1, D = max(3, sy0 / cell - top);   /* beginnt unter der Fuge: die Zaehne bleiben im Grundton */
      /* die Kegel rahmen das Icon wie in der Referenz (etwa ein und zwei Drittel der Breite), aussen bleibt es dunkel */
      glows.push({ top: top, cx: floor(ax / cell) + 0.5, cy: top - D * 0.3, sp: cols * (cols < 30 ? 0.22 : 0.19), rx: cols * (cols < 30 ? 0.13 : cols < 45 ? 0.12 : 0.15), dn: D * (cols < 30 ? 0.6 : 0.8),
        pk: cols < 30 ? 0.7 : 1, r0: r0, r1: ceil((y + h) / cell) });   /* schmale, helle Kegel, dazwischen bleibt ein dunkles V hinter Icon und Headline */
    });
    hosts.forEach(function (el, i) {
      var t = type(el), last = areas[areas.length - 1];
      if (last && last.t === t) return;
      var y = pos(el, "offsetTop") / cell, photo = last && !last.t;
      var r = i ? (photo ? ceil(y) : round(y)) : -1e6;   /* Hero klebt oben */
      areas.push({ r: r, t: t, blob: el.hasAttribute("data-blob") });
      if (!last) return;
      /* Kanten nach Bedeutung, alle in der Sprache der Fotokante im Hero: eine flache Welle, Zellpaare springen einzeln
         um eine Zeile, an der ersten Reihe loesen sich Zellen. Weiss zu Mint am ruhigsten, hinein ins Dunkle deutlicher */
      var soft = last.t && t < 3 && last.t < 3;
      var v = photo ? [2.6, 9, 3, 0.5, 0.78] : soft ? [2, 1, 1, 0.08, 0.4] : [2, 1, 1, 0.1, 0.4];   /* Welle, lose Zellen oben/unten, Dichte (wenige, einzelne), Abfall */
      var ed = { r: r, a: last.t, b: t, k: i, amp: v[0], up: v[1], dn: v[2], p: v[3], f: v[4], row: new Int16Array(cols),
        fr: 2 * MA.PI / max(14, cols * (0.6 + hash(i, 5) * 0.7)), ph: hash(i, 9) * 40 };   /* Wellenlaenge je Fuge zwischen 0,6 und 1,3 Bildschirmbreiten */
      edges.push(ed);
    });
    document.querySelectorAll("[data-calm]").forEach(function (el) {
      var x = pos(el, "offsetLeft"), y = pos(el, "offsetTop");
      zones.push({ el: el, live: el.dataset.calm === "live", cap: parseInt(el.dataset.calm, 10),
        t: type(el.closest("[data-field]")), x0: x, y0: y, x1: x + el.offsetWidth, y1: y + el.offsetHeight });
    });
    trail.clear(); dirty = true;
  };

  /* Fragen (Jamie 03.10.2026): im gruenen Feld blobben einzelne Zellen zufaellig auf und verglimmen in Stufen.
     Jede Zelle hat ihren eigenen Takt, je Takt leuchtet sie nur selten. Unter Text nie, bei reduzierter Bewegung nie */
  var PLATE = tok("--c-faq-plate")[0], BLOB_C = [];
  BLOB_C[4] = [mix(PLATE, BASE[4], 0.3), mix(PLATE, BASE[4], 0.65), PLATE];   /* gruen: bis zur Kartenfarbe */
  BLOB_C[3] = TINT[3];                                                       /* dunkel: die drei Feldstufen */
  var BLOB_RATE = 0.045;
  var BLOB_F = 34;   /* Takt in ganzen Feld-Frames (34 x 83 ms): jede Stufe haelt gleich lang, das Verglimmen stottert nicht */
  var blobAt = function (c, R, now, ty) {
    var C = BLOB_C[ty];
    var f = floor(now / STEP) + floor(hash(c * 13, R * 7) * BLOB_F), cyc = floor(f / BLOB_F), u = f - cyc * BLOB_F;
    if (hash(c + cyc * 197, R - cyc * 61) > BLOB_RATE) return 0;
    return u < 2 ? C[0] : u < 5 ? C[1] : u < 8 ? C[2] : u < 10 ? C[1] : u < 12 ? C[0] : 0;   /* an, hell, wieder leise, aus; danach Ruhe */
  };
  var img, u32, mask, capm, N = 0, Wd = 0, lastR0, HEAL = 650, STEP = 1000 / 12, M = 4;
  var draw = function (t, now) {
    var sy = win.scrollY, vh = win.innerHeight, R0 = floor(sy / cell) - M, n = ceil(vh / cell) + 2 * M + 1;
    var c, k, e, i, j;
    if (n !== N || cols !== Wd) {
      N = n; Wd = cv.width = cols; cv.height = N;
      cv.style.width = cols * cell + "px"; cv.style.height = N * cell + "px";
      img = ctx.createImageData(cols, N); u32 = new Uint32Array(img.data.buffer); mask = new Uint8Array(cols * N); capm = new Uint8Array(cols * N);
      lastR0 = null;
    }
    if (R0 !== lastR0) cv.style.transform = "translate3d(0," + (lastR0 = R0) * cell + "px,0)";

    /* Ruhige Zonen: eine Zelle Rand hart (Grundfarbe), eine weich */
    mask.fill(0); capm.fill(255);
    zones.forEach(function (q) {
      var x0 = q.x0, y0 = q.y0, x1 = q.x1, y1 = q.y1, b;
      if (q.live) { b = q.el.getBoundingClientRect(); x0 = b.left; x1 = b.right; y0 = b.top + sy; y1 = b.bottom + sy; }
      if (x1 <= x0) return;
      if (q.cap >= 0) {                  /* nur Lichtgrenze, weich: je Zelle Abstand eine Stufe heller */
        var a0 = floor(x0 / cell), a1 = ceil(x1 / cell) - 1, b0 = floor(y0 / cell), b1 = ceil(y1 / cell) - 1;
        for (var gr = max(b0 - 3, R0); gr <= min(b1 + 3, R0 + N - 1); gr++) {
          for (var gc = max(a0 - 3, 0); gc <= min(a1 + 3, cols - 1); gc++) {
            var ex = max(a0 - gc, gc - a1, 0), ey = max(b0 - gr, gr - b1, 0), dd = round(MA.sqrt(ex * ex + ey * ey)), go = (gr - R0) * cols + gc;
            capm[go] = min(capm[go], q.cap + dd);
          }
        }
        return;
      }
      var c0 = floor(x0 / cell) - 2, c1 = ceil(x1 / cell) + 1, r0 = floor(y0 / cell) - 2, r1 = ceil(y1 / cell) + 1;
      for (var rr = max(r0, R0); rr <= min(r1, R0 + N - 1); rr++) {
        for (var cc = max(c0, 0), o = (rr - R0) * cols + cc; cc <= min(c1, cols - 1); cc++, o++) {
          var inner = rr > r0 && rr < r1 && cc > c0 && cc < c1;
          var core = rr >= floor(y0 / cell) && rr <= ceil(y1 / cell) - 1 && cc >= floor(x0 / cell) && cc <= ceil(x1 / cell) - 1;
          mask[o] = inner ? 8 | q.t | (core ? 16 : mask[o] & 16) : mask[o] || 1;
          capm[o] = min(capm[o], inner ? 3 : 4);
        }
      }
    });

    /* Fugen: flache Welle aus Zellen, wandert seitwaerts. Die Fuge zum Foto waechst erst beim Scrollen */
    for (k = 0; k < edges.length; k++) {
      e = edges[k];
      e.g = !e.a ? min(1, max(0, (sy + vh - e.r * cell) / (vh * 0.45))) : 1;
      e.u = round(e.up * e.g); e.reach = ceil((e.amp + 1) * e.g);
      e.on = e.r + e.reach + e.dn >= R0 && e.r - e.reach - e.u <= R0 + N;
      if (e.on) for (c = 0; c < cols; c++) {
        if (!e.a) { e.row[c] = e.r + round(e.g * (round((hash(c >> 1, 11 + e.k) - 0.5) * 1.8) + e.amp * MA.sin((c + t * 0.45) * 0.15 + k * 1.7))); continue; }   /* Fotokante wie im Hero */
        /* Welle wandert langsam, je Zellpaar ein eigener Takt: es kippt immer nur eine Stufe, nie die ganze Kante */
        var pr = c >> 1, fp = flip(pr, e.k, t), x2 = pr * 2;
        var wv = round(e.amp * (0.7 * MA.sin((x2 + e.ph + t * 0.3) * e.fr) + 0.35 * MA.sin((x2 * 2.3 + e.ph * 1.7 - t * 0.2) * e.fr))) + (fp && !flip(pr - 1, e.k, t) ? fp : 0);   /* zwei Wellen uebereinander: keine Pyramide, jede Fuge eigen. Selten kippt ein Paar, nie zwei nebeneinander */
        e.row[c] = e.r + max(-e.amp, min(e.amp, wv));
      }
    }

    var ai = 0;
    for (j = 0; j < N; j++) {
      var R = R0 + j, E = null, dE = 1e9;
      for (k = 0; k < edges.length; k++) dE = min(dE, MA.abs(R - edges[k].r));
      var band = max(0, dE - 3) * 0.07;            /* helle Flaechen bleiben weiter als sieben Zeilen von einer Fuge sauber */
      var gRow = false;                             /* im Licht von #download keine einzelnen hellen Zellen */
      for (k = 0; k < glows.length; k++) if (R >= glows[k].r0 && R <= glows[k].r1) gRow = true;
      while (ai + 1 < areas.length && areas[ai + 1].r <= R) ai++;
      for (k = 0; k < edges.length && !E; k++) {
        e = edges[k];
        if (e.on && R >= e.r - e.reach - e.u - 1 && R <= e.r + e.reach + e.dn + 1) E = e;
      }
      for (c = 0; c < cols; c++) {
        i = j * cols + c;
        var m = mask[i], ty = areas[ai].t, lo = -1;
        if (E) {                         /* Text im Hero: gerader Schnitt */
          var up = R < ((m & 8) && !E.a ? E.r : E.row[c]), d = up ? E.row[c] - R : R - E.row[c] + 1;
          ty = up ? E.a : E.b;
          if (!m && d <= (up ? E.u : E.dn)) {
            if (E.a && d > 1) { /* keine Inseln: nur die erste Reihe an der Treppe loest sich */ }
            else if (E.a) {
              /* lose Zellen an der ersten Reihe: je Zellpaar hoechstens eine, nie zwei Paare nebeneinander (keine Balken),
                 im Zwischenton wie die Zellen an der Fotokante im Hero */
              var lp = c >> 1, sg = up ? 1 : -1;
              if (loose(lp, E, sg, t) && !loose(lp - 1, E, sg, t) && (c & 1) === (hash(lp, 3 + E.k) < 0.5 ? 0 : 1) && !(gRow && ty === 3)) { lo = ty; ty = up ? E.b : E.a; }   /* im Licht keine losen Zellen */
            } else {
              /* am Foto wandern sie wie im Hero */
              var drift = (up ? 1 : -1) * floor(t * (0.3 + hash(c, 91 + E.k) * 0.7) + hash(c, 37 + E.k) * 9);
              if (hash(c + 7 * E.k, R + drift) < E.p * MA.pow(E.f, d - 1) * E.g) ty = up ? E.b : E.a;
            }
          }
        }
        if (areas[ai].blob && ty === areas[ai].t && BLOB_C[ty] && !m && !reduce) { var bc = blobAt(c, R, now, ty); if (bc) { u32[i] = bc; continue; } }   /* [data-blob]: Zellen blobben auf, nie unter Text */
        if (ty === 3 && glows.length) {
          var gl = 0;
          for (var gk = 0; gk < glows.length; gk++) {
            var G = glows[gk];
            if (R < G.r0 || R > G.r1) continue;
            /* die Kegel ruecken langsam etwas auseinander und zurueck, der Rand bleibt unregelmaessig und lebendig */
            var sp = G.sp * (0.75 + 0.5 * max(0, R - G.top) / G.dn) * (1 + 0.1 * MA.sin(t * 0.25)), gy = (R + 0.5 - G.cy) / (G.dn * (0.88 + 0.12 * MA.sin(t * 0.4)));   /* nach unten weichen die Kegel auseinander: ein dunkles V */
            var g1 = (c + 0.5 - G.cx + sp) / G.rx, g2 = (c + 0.5 - G.cx - sp) / G.rx;
            var ed0 = min(1, max(0, min(c, cols - 1 - c) / cols / 0.24)), edge = ed0 * ed0 * (3 - 2 * ed0);   /* nach aussen weich ins Dunkel, keine senkrechte Kante */
            gl = max(gl, min(1, MA.exp(-(g1 * g1 + gy * gy)) + MA.exp(-(g2 * g2 + gy * gy))) * (0.85 + 0.15 * noise(c * 0.3, R * 0.3 + t * 0.05)) * G.pk * edge);
          }
          if (gl > 0) {
            /* Stufe 0 zu 1 ohne Dithering (ruhiger Rand), darueber geordnet gedithert */
            var lf = gl * NG, li = lf < 1 ? 0 : lf >= 3 ? round(lf) : floor(lf) + (lf % 1 > BAYER2[(R & 1) * 2 + (c & 1)] / 4 ? 1 : 0);   /* Dithering nur in den aeusseren Stufen, der Kern ist ruhig */
            li = min(li, capm[i]);                         /* unter Text nur so hell, dass der Kontrast haelt (data-calm="Stufe") */
            if (li > 0) {
              var gc = GLOW[min(NG, li)], t1 = !m && capm[i] === 255 && trail.size && trail.get(R * cols + c);
              if (t1 && now - t1 < HEAL) gc = mix(GLOW[min(NG, li + 1)], gc, 1 - MA.pow((now - t1) / HEAL, 2));   /* Spur: eine Stufe heller als das Licht */
              u32[i] = gc; continue;
            }
          }
        }
        if (m & 8 && (!E || !E.a)) { u32[i] = BASE[!E && (m & 7) || ty]; continue; }   /* unter Text: Grundton, an der Fotokante gerader Schnitt */
        if (m & 8) { u32[i] = BASE[ty]; continue; }                                    /* an einer Fuge gewinnt die Treppe, nie eine gerade Linie */
        if (!ty) { u32[i] = 0; continue; }
        /* Wetter zieht in Fronten nach rechts oben, Zellen flackern einzeln */
        var col = BASE[ty], f = FREQ[ty], ep = floor(t * 0.6 + hash(c, R) * 5);
        var nz = noise((c - t * 0.5) * f, (R + t * 0.18) * f) * 0.78 + noise(c * 0.5 + 40, R * 0.5 + t * 0.25) * 0.22 +
          (hash(c + ep * 131, R - ep * 17) - 0.5) * 0.14 + (noise(c * 0.07 - t * 0.06, R * 0.07) - 0.5) * 0.24 - (m ? 0.1 : 0);
        nz -= ty < 3 ? band : max(0, dE - 2) * 0.09;   /* dunkel: Zellwetter nur nahe der Fuge, die Flaeche bleibt ruhig */
        if (nz > THR[ty]) col = TINT[ty][min(2, floor((nz - THR[ty]) / (1 - THR[ty]) * 4))];
        if (lo >= 0) col = (lo > 2 && ty > 2) ? BASE[ty] : (lo && ty && lo < 3 && ty < 3) ? (lo === 1 ? TINT[2][2] : LOOSE_L[1]) : (ty > 2 ? LOOSE_D : LOOSE_L)[(hash(c, R) * 2) | 0];   /* lose Zelle in einem sichtbaren Ton der Palette, nie Grau */
        var t0 = ty === 3 && !m && capm[i] === 255 && trail.size && trail.get(R * cols + c);   /* nie an Text */   /* Spur nur auf dunklen Flaechen, hell bleibt ruhig */
        if (t0 && now - t0 < HEAL) {
          var h = hash(c, R * 3), P = ty > 2 ? TDEEP : PHOTO;
          col = mix(P[(h * P.length) | 0], col, 1 - MA.pow((now - t0) / HEAL, 2));
        }
        u32[i] = col;
      }
    }
    ctx.putImageData(img, 0, 0);
  };

  /* Zeichnet nur bei Aenderung, ruht im Hintergrund-Tab und vor dem Hero-Ende */
  var raf = 0, to = 0, lastSy = -1, lastTq = -1, dirty = true;
  var tick = function (now) {
    raf = 0;
    if (document.hidden || !cell) return;
    var sy = win.scrollY, tq = reduce ? 0 : floor(now / STEP), e = edges[0];
    var anim = !reduce && (areas[0].t || !e || sy + win.innerHeight > e.r * cell);
    trail.forEach(function (t0, key) { if (now - t0 >= HEAL) trail.delete(key); });
    if (dirty || sy !== lastSy || (anim && tq !== lastTq) || trail.size) {
      dirty = false; lastSy = sy; lastTq = tq;
      try { draw(tq * STEP / 1000, now); doc.classList.add("field-on"); }
      catch (err) { doc.classList.remove("field-on"); box.remove(); cell = 0; return; }
    }
    if (trail.size) raf = requestAnimationFrame(tick);
    else if (anim) { clearTimeout(to); to = setTimeout(kick, STEP - now % STEP); }   /* Wetter: 12 Bilder/s */
  };
  var kick = function () { if (!raf && cell) raf = requestAnimationFrame(tick); };
  var rt = 0;
  var later = function () { cancelAnimationFrame(rt); rt = requestAnimationFrame(function () { if (cell) { layout(); kick(); } }); };
  layout();
  kick();
  win.addEventListener("scroll", kick, { passive: true });
  win.addEventListener("resize", later);
  document.addEventListener("visibilitychange", kick);

  /* Mausspur auf dunklen Flaechen: bis zu acht Zellen, eine Stufe heller als der Grund, heilen in 0,65 s */
  if (!reduce && matchMedia("(hover: hover) and (pointer: fine)").matches) {
    var lx = null, ly = null;
    document.addEventListener("pointermove", function (ev) {
      if (ev.pointerType !== "mouse" || !cell) return;
      /* eine Zelle breite Linie vom letzten zum neuen Zeigerpunkt, wie ein Pinsel aus Pixeln */
      var mx = ev.clientX / cell, my = (ev.clientY + win.scrollY) / cell, now = performance.now();
      if (lx === null || MA.abs(mx - lx) + MA.abs(my - ly) > 12) { lx = mx; ly = my; }
      var steps = max(1, ceil(MA.max(MA.abs(mx - lx), MA.abs(my - ly)) * 2));
      for (var s = 1; s <= steps; s++) {
        var px = lx + (mx - lx) * s / steps, py = ly + (my - ly) * s / steps, c = floor(px), r = floor(py);
        if (c >= 0 && c < cols) { trail.delete(r * cols + c); trail.set(r * cols + c, now); }   /* ein ruhiger Pinselstrich aus Zellen */
        if (trail.size > 8) trail.delete(trail.keys().next().value);
      }
      lx = mx; ly = my;
      kick();
    }, { passive: true });
  }
  var lt = 0, laterRO = function () { if (lt) return; lt = setTimeout(function () { lt = 0; if (cell) { layout(); kick(); } }, STEP); };   /* Hoehen aendern sich in Animationen je Frame: hoechstens einmal je Feldtakt neu vermessen */
  if (win.ResizeObserver) new ResizeObserver(laterRO).observe(body);   /* FAQ und Bilder aendern Hoehen */
  if (document.fonts) document.fonts.ready.then(later);
})();
