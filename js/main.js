/* Preen, Landingpage. Kein Framework, keine Abhängigkeit. */
(function () {
  "use strict";

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var cssVar = function (el, name) { return getComputedStyle(el).getPropertyValue(name).trim(); };

  /* Touch-Geraete (iOS, Android): Die Adressleiste blendet beim Scrollen ein und aus und aendert dabei nur die
     Fensterhoehe. Darauf darf keine Szene neu rechnen, sonst springen Waage und Bilderflug mitten im Scrollen.
     viewH() ist dort die kleine, stabile Hoehe (100svh, wie die Pins), onResize() reagiert nur auf neue Breiten.
     Desktop (feiner Zeiger) bleibt unveraendert: innerHeight und jedes resize */
  var touchUI = window.matchMedia("(pointer: coarse)").matches;
  var vProbe = document.createElement("div"), vhPx = 0;
  vProbe.style.cssText = "position:absolute;visibility:hidden;height:100svh;width:0;top:0;pointer-events:none";
  document.body.appendChild(vProbe);
  var viewH = function () {
    if (!touchUI) return window.innerHeight;
    return vhPx || (vhPx = vProbe.offsetHeight || window.innerHeight);
  };
  var onResize = function (fn) {
    var lw = function () { return touchUI ? document.documentElement.clientWidth : window.innerWidth; };   /* Touch: Layoutbreite, Pinch-Zoom aendert sie nicht */
    var w = lw();
    window.addEventListener("resize", function (e) {
      if (touchUI && lw() === w) return;
      w = lw(); vhPx = 0;
      fn(e);
    });
  };

  /* ---------- Kopf: oben ohne Flaeche, beim Scrollen durchscheinendes Glas (inspo/NOTIZEN.md: transparent) ---------- */
  var header = document.querySelector("[data-header]");
  if (header) {
    var deeps = Array.prototype.slice.call(document.querySelectorAll(".section--deep, .section--green"));
    var greens = Array.prototype.slice.call(document.querySelectorAll(".section--green"));   /* nur vollbreite dunkle Flaechen, ueber der Tafel in Warum bleibt das Glas weiss */
    var surfaces = Array.prototype.slice.call(document.querySelectorAll("[data-field=surface]"));
    var setHeader = function () {
      var yNow = window.scrollY;
      header.classList.toggle("is-scrolled", yNow > 8);   /* oben ganz frei, beim Scrollen durchscheinendes Glas (NOTIZEN: transparent) */
      var y = header.offsetHeight / 2;       /* liegt die Mitte des Kopfs ueber einer dunklen Sektion? */
      var under = function (s) { var r = s.getBoundingClientRect(); return r.top <= y && r.bottom >= y; };
      header.classList.toggle("is-dark", deeps.some(under));
      header.classList.toggle("is-surface", surfaces.some(under));
      header.classList.toggle("is-green", greens.some(under));   /* ueber Mint: mintfarbenes Glas */
    };
    setHeader();
    var hTick = false;   /* einmal je Frame, nicht je Scroll-Event */
    window.addEventListener("scroll", function () { if (!hTick) { hTick = true; requestAnimationFrame(function () { hTick = false; setHeader(); }); } }, { passive: true });
  }

  /* ---------- Hero: Pixelauflösung ----------
     Raster ueber dem ganzen Hero. Jede Zelle ist eins von dreien: Foto, weiss, oder eine einzelne
     Zelle in der Durchschnittsfarbe des Fotos an dieser Stelle, die sich ins Weiss geloest hat.
     Desktop: die Oberkante des Fotos laeuft als Welle, links unter der Headline tief, rechts hoch.
     Unten rechts eine Aussparung fuer den Text. Deterministisch, bei jedem Laden gleich. */
  var hero = document.querySelector("[data-hero]");
  if (hero) {
    var himg = hero.querySelector(".hero__img");
    var canvas = hero.querySelector(".hero__pixels");
    var ctx = canvas.getContext("2d");
    var trail = hero.querySelector(".hero__trail");
    var tctx = trail.getContext("2d");
    var stage = hero.querySelector(".hero__stage");
    var head = hero.querySelector(".hero__title");
    var wrap = hero.querySelector(".hero__wrap");
    var cta = hero.querySelector(".hero__cta");
    var hash = function (x, y) {
      var h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    };
    var noise = function (c, r) { return 0.6 * hash(c, r) + 0.4 * hash(c >> 1, (r >> 1) + 97); };
    var HOLE = [0, 0.42, 0.18, 0.06];            /* Loch im Foto, nach Abstand zur Kante */
    var LOOSE = [0, 0.5, 0.25, 0.08];             /* geloeste Zelle im Weiss, nach Abstand zur Kante */
    var grid = null;                             /* merkt sich Raster und Farben fuer den Maus-Effekt */

    /* Zum Abtasten eine Kopie ohne srcset: nur sie meldet die echte Pixelgroesse. */
    var bmp = null;
    var drawHero = function () {
      if (!himg.complete || !himg.naturalWidth) return;
      /* Handy: das Hochformat endet unten am Band, so liegen Strassenkurve und Felswand im Band statt unter dem Text */
      if (window.innerWidth < 600 && stage) hero.style.setProperty("--hero-img-h", (stage.offsetTop + stage.offsetHeight) + "px");
      else hero.style.removeProperty("--hero-img-h");
      if (!bmp || bmp.src !== himg.currentSrc) {
        bmp = new Image();
        bmp.onload = drawHero;
        bmp.src = himg.currentSrc || himg.src;
        return;
      }
      if (!bmp.complete || !bmp.naturalWidth) return;

      var probe = document.createElement("div");
      probe.style.cssText = "position:absolute;visibility:hidden;width:var(--pixel-cell)";
      hero.appendChild(probe);
      var cell = probe.getBoundingClientRect().width;
      hero.removeChild(probe);

      var W = hero.clientWidth, H = hero.clientHeight;
      var cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
      var fl = function (v) { return Math.floor(v / cell); }, ce = function (v) { return Math.ceil(v / cell); };
      var wide = true;   /* Aufbau wie am Desktop auf allen Breiten (Jamie 05.10.2026): steigende Welle, Aussparung fuer den Text */

      /* Aussparung unten rechts aufs Raster legen, damit der Text genau mittig im Weiss sitzt */
      wrap.style.width = ""; wrap.style.height = "";
      if (wide) {
        var nL0 = fl(W - wrap.offsetWidth), nT0 = fl(H - wrap.offsetHeight);
        wrap.style.width = (W - nL0 * cell) + "px";
        wrap.style.height = (H - nT0 * cell) + "px";
      }

      var base = hero.getBoundingClientRect();
      var rel = function (el) {
        var r = el.getBoundingClientRect();
        return { l: r.left - base.left, t: r.top - base.top, r: r.right - base.left, b: r.bottom - base.top };
      };
      var st = rel(stage), hd = rel(head), ct = rel(cta), wr = rel(wrap);
      var hdr = document.querySelector("[data-header]");
      var relFixed = function (el) {                            /* Navbar ist fixiert: Lage so, als stuende die Seite oben */
        var q = rel(el), y = window.scrollY;
        return { l: q.l, r: q.r, t: q.t - y, b: q.b - y };
      };
      var headerRows = hdr ? ce(hdr.offsetHeight) : 0;
      var brand = hdr ? relFixed(hdr.querySelector(".brand")) : null;
      var navBtn = hdr ? relFixed(hdr.querySelector(".btn")) : null;
      var inRect = function (c, r, q) {                         /* Zelle beruehrt Rechteck q (mit einer Zelle Rand)? */
        return q && c >= fl(q.l) - 1 && c <= ce(q.r) && r >= fl(q.t) - 1 && r <= ce(q.b);
      };

      var sT = st.t <= 1 ? 0 : ce(st.t), sB = st.b >= H - 1 ? rows : fl(st.b);
      var sL = st.l <= 1 ? 0 : fl(st.l), sR = st.r >= W - 1 ? cols : ce(st.r);
      var hR = ce(hd.r), hB = ce(hd.b), hT = fl(hd.t);
      var nL = Math.round(wr.l / cell), nT = Math.round(wr.t / cell);
      var cL = fl(ct.l), cT = fl(ct.t), cR = ce(ct.r), cB = ce(ct.b);

      /* Obere Fotokante je Spalte. Unregelmaessig: Stufen in Zweierspalten plus eine leichte Schwingung,
         damit die geloesten Zellen keine gerade Linie bilden. Unter der Headline setzt das Foto direkt an
         ihrer Unterkante an, die Zellen darueber reichen in die Schrift hinein. */
      var jag = function (c) { return Math.floor(hash(c >> 1, 7) * 3) + Math.round(Math.sin(c * 0.45 + 1.3) * 1.3); };
      var topAt = function (c) {
        var low = hB + 2;
        if (c <= hR) return low + jag(c);
        var u = Math.min(1, (c - hR) / Math.max(1, cols - hR));
        var e = Math.sin(u * Math.PI / 2);                      /* steigt nach der Headline zuegig, oben rechts flacht sie ab */
        return Math.round(low + (sT - low) * e) + jag(c);
      };

      var n = cols * rows;
      var core = new Uint8Array(n), safe = new Uint8Array(n);
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          var i = r * cols + c;
          var inStage = r >= sT && r < sB && c >= sL && c < sR;
          var cut = r < topAt(c) || (sB < rows && r >= sB - Math.max(0, jag(c + 50)));   /* auch die Unterkante springt */
          if (wide) {
            if (c >= nL && r >= nT) cut = true;                          /* Aussparung fuer den Text */
          }
          core[i] = inStage && !cut ? 1 : 0;
          /* Schutz: Headline, Text unten rechts und Kopf bekommen nie eine Zelle */
          if ((r >= hT - 1 && r <= hB && c >= fl(hd.l) - 1 && c <= hR + 1) || (r >= cT - 1 && r <= cB && c >= cL - 1 && c <= cR) ||
              inRect(c, r, brand) || inRect(c, r, navBtn) ||
              (r <= headerRows && (c < cols * 0.14 || c > cols * 0.72))) safe[i] = 1;   /* Ecken oben bleiben ruhig */
        }
      }

      /* Abstand jeder Zelle zur Kante (4er-Nachbarschaft) */
      var dist = new Uint8Array(n), q = [];
      var nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var k = 0; k < n; k++) {
        var kr = (k / cols) | 0, kc = k % cols;
        for (var d = 0; d < 4; d++) {
          var nr = kr + nb[d][1], nc = kc + nb[d][0];
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && core[nr * cols + nc] !== core[k]) { dist[k] = 1; q.push(k); break; }
        }
      }
      for (var qi = 0; qi < q.length; qi++) {
        var p = q[qi], pr = (p / cols) | 0, pc = p % cols;
        if (dist[p] >= LOOSE.length) continue;
        for (var e2 = 0; e2 < 4; e2++) {
          var mr = pr + nb[e2][1], mc = pc + nb[e2][0];
          if (mr < 0 || mr >= rows || mc < 0 || mc >= cols) continue;
          var m = mr * cols + mc;
          if (!dist[m] && core[m] === core[p]) { dist[m] = dist[p] + 1; q.push(m); }
        }
      }

      /* Foto genau auf die Rasterkante der Buehne beschneiden (bei der Startanimation erst am Ende) */
      /* Hohe Fenster: das Foto ragt oben ueber den Hero hinaus (--hero-sky-cut), der Himmel liegt dann ausserhalb */
      var imgTop = himg.offsetTop, imgW = himg.offsetWidth || W, imgH = himg.offsetHeight || H;
      var clip = "inset(" + Math.round(sT * cell - imgTop) + "px 0 " + Math.max(0, Math.round(imgTop + imgH - sB * cell)) + "px 0)";   /* unten relativ zur Unterkante des Bildes */

      /* Durchschnittsfarbe je Zelle */
      var pos = getComputedStyle(himg).objectPosition.split(" ").map(function (v) { return parseFloat(v) / 100; });
      var iw = bmp.naturalWidth, ih = bmp.naturalHeight;
      var sc = Math.max(imgW / iw, imgH / ih);
      var offX = (imgW - iw * sc) * (pos[0] || 0.5), offY = imgTop + (imgH - ih * sc) * (pos[1] || 0.5);
      var small = document.createElement("canvas");
      small.width = cols; small.height = rows;
      var sctx = small.getContext("2d");
      sctx.imageSmoothingQuality = "high";
      /* Quellrechteck auf das Bild begrenzen. Safari zeichnet sonst nichts oder schwarz, wenn es ueber den Rand ragt */
      var qx = -offX / sc, qy = -offY / sc, qw = (cols * cell) / sc, qh = (rows * cell) / sc;
      var cx0 = Math.max(0, qx), cy0 = Math.max(0, qy), cx1 = Math.min(iw, qx + qw), cy1 = Math.min(ih, qy + qh);
      sctx.drawImage(bmp, cx0, cy0, cx1 - cx0, cy1 - cy0,
        (cx0 - qx) / qw * cols, (cy0 - qy) / qh * rows, (cx1 - cx0) / qw * cols, (cy1 - cy0) / qh * rows);
      var px = sctx.getImageData(0, 0, cols, rows).data;
      /* Randzellen ohne volle Deckung: Farbe vom Nachbarn links oder oben uebernehmen */
      for (var pr = 0; pr < rows; pr++) for (var pc = 0; pc < cols; pc++) {
        var pi = (pr * cols + pc) * 4;
        if (px[pi + 3] === 255) continue;
        var ni = pc > 0 ? pi - 4 : pr > 0 ? pi - cols * 4 : -1;
        if (ni >= 0) { px[pi] = px[ni]; px[pi + 1] = px[ni + 1]; px[pi + 2] = px[ni + 2]; px[pi + 3] = 255; }
      }
      /* Safari: ragt das Raster oben oder links ueber das abgetastete Bild, bleiben ganze Zeilen leer und die Zellen
         wurden schwarz. Zweiter Durchlauf von unten rechts: leere Zellen nehmen die Farbe von unten oder rechts */
      for (var qr = rows - 1; qr >= 0; qr--) for (var qc = cols - 1; qc >= 0; qc--) {
        var qi = (qr * cols + qc) * 4;
        if (px[qi + 3] === 255) continue;
        var nj = qr < rows - 1 ? qi + cols * 4 : qc < cols - 1 ? qi + 4 : -1;
        if (nj >= 0 && px[nj + 3] === 255) { px[qi] = px[nj]; px[qi + 1] = px[nj + 1]; px[qi + 2] = px[nj + 2]; px[qi + 3] = 255; }
      }

      var dpr = window.devicePixelRatio || 1, cd = cell * dpr;
      canvas.width = trail.width = Math.round(W * dpr);
      canvas.height = trail.height = Math.round(H * dpr);
      var white = cssVar(document.documentElement, "--c-bg") || "#fff";
      /* Vereinzelte Pixel weit im Weiss: dichter oben links in der Ecke und im Weiss zwischen Headline und Welle */
      var farLoose = function (c, r) {
        if (c < cols * 0.09 && r < rows * 0.3) return 0.14;
        if (c > cols * 0.42 && c < cols * 0.72 && r < rows * 0.34) return 0.1;
        return c > cols * 0.6 ? 0.07 : 0.02;
      };
      var far = new Int16Array(n), fq = [], dmax = 1;
      for (var f0 = 0; f0 < n; f0++) if (core[f0]) fq.push(f0);
      for (var fi = 0; fi < fq.length; fi++) {
        var fp = fq[fi], fr = (fp / cols) | 0, fc = fp % cols;
        for (var fd = 0; fd < 4; fd++) {
          var gr = fr + nb[fd][1], gc = fc + nb[fd][0];
          if (gr < 0 || gr >= rows || gc < 0 || gc >= cols) continue;
          var g2 = gr * cols + gc;
          if (!core[g2] && !far[g2]) { far[g2] = far[fp] + 1; dmax = Math.max(dmax, far[g2]); fq.push(g2); }
        }
      }
      /* Zwei gesetzte Gruppen (Wunsch des Art Directors): links neben der Headline und rechts oben zwischen
         dem Pixelpaar und der Fotokante. Farbe wie alle Zellen: das Foto an ihrer Stelle */
      var accent = {};
      if (wide) {
        var hl = fl(hd.l), aMid = hT + Math.round((hB - hT) * 0.2);
        /* Gruppe waechst aus dem linken Rand heraus (Spalte 0 voll besetzt), nie frei schwebend, nie bis an die Headline */
        if (hl >= 6) [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [3, 1], [0, 2], [1, 2], [2, 2], [0, 3], [2, 3], [0, 4], [1, 4], [0, 5], [1, 5], [3, 4], [0, 6]].forEach(function (p) {
          accent[(aMid + p[1]) * cols + p[0]] = 1;
        });
        var ac = Math.round(cols * 0.6), ar = headerRows + 2;
        [[0, 0], [1, 0], [1, 1], [2, 1], [0, 2]].forEach(function (p) { accent[(ar + p[1]) * cols + ac + p[0]] = 1; });
      }
      /* Himmelszellen (sehr hell) loesen sich nicht ins Weiss: dort waeren sie nur graue Flecken */
      var lum = function (idx) { var o = idx * 4; return (0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) / 255; };
      var bright = function (idx) { return lum(idx) > 0.62; };
      var dark = function (idx) { return lum(idx) < 0.12; };   /* fast schwarze Zellen frei im Weiss wirken wie tote Pixel */
      /* Nebel, Asphalt, Felsschatten: grau, lila oder fast schwarz. Frei im Weiss wirken solche Zellen wie Schmutz */
      var muddy = function (idx) {
        var o = idx * 4, mx = Math.max(px[o], px[o + 1], px[o + 2]), mn = Math.min(px[o], px[o + 1], px[o + 2]), l = lum(idx);
        return l < 0.14 || l > 0.55 || mx - mn < 24;
      };
      var rgbAt = function (idx) { var o = idx * 4; return "rgb(" + px[o] + "," + px[o + 1] + "," + px[o + 2] + ")"; };
      var greenNear = function (c0, r0) {                       /* naechste Fotozelle mit mittlerem Gruen */
        for (var dr = 0; dr < rows - r0; dr++) for (var dc = 0; dc <= 6; dc++) for (var sg = -1; sg <= 1; sg += 2) {
          var gc2 = c0 + sg * dc, gi = (r0 + dr) * cols + gc2;
          if (gc2 < 0 || gc2 >= cols) continue;
          var o3 = gi * 4, l3 = lum(gi);
          if (l3 > 0.2 && l3 < 0.55 && px[o3 + 1] > px[o3] * 1.1 && px[o3 + 1] > px[o3 + 2] * 1.08) return gi;
        }
        return r0 * cols + c0;
      };
      var fills = [];                                           /* [x, y, w, h, Farbe, Zeitpunkt in der Startanimation] */
      var kind = new Uint8Array(n);                             /* 0 = weiss, 1 = Foto, 2 = geloeste Zelle */
      for (var rr = 0; rr < rows; rr++) {
        var y0 = Math.floor(rr * cd), y1 = Math.ceil((rr + 1) * cd);
        for (var cc = 0; cc < cols; cc++) {
          var j2 = rr * cols + cc, fill = null;
          var x0 = Math.floor(cc * cd), x1 = Math.ceil((cc + 1) * cd);
          var inSt = rr >= sT && rr < sB && cc >= sL && cc < sR;
          var right = wide ? 1 + 0.6 * (cc / cols) : 1;          /* rechts etwas mehr Aufloesung */
          var when = 0;
          var inNotch = wide && cc >= nL && rr >= nT;                 /* die Textaussparung bleibt rein weiss */
          var lastCut = rr === rows - 1 && H - rr * cell < cell * 0.75; /* keine lose Zelle in der angeschnittenen letzten Reihe */
          if (core[j2]) {
            if (!safe[j2] && dist[j2] < (wide ? HOLE.length : 2) && noise(cc, rr) < HOLE[dist[j2]] * right) { fill = white; when = 650 + noise(cc + 9, rr) * 150; }   /* schmal: Loecher nur in der ersten Reihe, nie mitten auf der Strasse */
            else if (wide && !safe[j2] && rr < sT + 3 && muddy(j2) && lum(j2) > 0.55) { fill = white; when = 650; }   /* Nebel oben an der Welle loest sich: die gruene Kante bildet die Oberkante */
            else kind[j2] = 1;
          } else {
            fill = white;                                         /* das Weiss flutet von innen zur Fotokante */
            when = 250 + 450 * (1 - far[j2] / dmax) + noise(cc + 17, rr) * 100;
            if (accent[j2] && !safe[j2]) {
              var ao = greenNear(cc, Math.min(rows - 1, topAt(cc) + 2)) * 4;   /* Gruen vom Hang darunter, kein Himmel, kein Felsschatten */
              fill = "rgb(" + px[ao] + "," + px[ao + 1] + "," + px[ao + 2] + ")";
              kind[j2] = 2;
              when = 700 + noise(cc + 41, rr) * 200;
            } else if (!safe[j2] && !inNotch && !lastCut && dist[j2] < LOOSE.length && cc >= 2 && cc < cols - 2 && !bright(j2) && noise(cc + 311, rr) < LOOSE[dist[j2]] * right) {
              fill = rgbAt(muddy(j2) ? greenNear(cc, Math.min(rows - 1, rr + 1)) : j2);   /* graue oder schwarze Zelle bekommt das Gruen vom Hang daneben */
              kind[j2] = 2;
              when = 700 + noise(cc + 41, rr) * 200;             /* lose Pixel springen zuletzt ab */
            } else if (wide && !safe[j2] && !inNotch && !dist[j2] && far[j2] <= 6 && cc >= 2 && cc < cols - 2 && !bright(j2) && rr < topAt(cc) && noise(cc + 733, rr * 3) < farLoose(cc, rr)) {
              /* vereinzelt weit im Weiss, in der Farbe des Fotos an dieser Stelle, graue Toene werden zum Gruen daneben */
              fill = rgbAt(muddy(j2) ? greenNear(cc, Math.min(rows - 1, topAt(cc) + 2)) : j2);
              kind[j2] = 2;
              when = 700 + noise(cc + 41, rr) * 200;
            }
          }
          if (fill) fills.push([x0, y0, x1 - x0, y1 - y0, fill, when]);
        }
      }
      grid = { cell: cell, cd: cd, cols: cols, rows: rows, px: px, kind: kind, safe: safe, far: far,
        src: { sx: -offX / sc, sy: -offY / sc, sw: (cols * cell) / sc, sh: (rows * cell) / sc },
        box: wide ? { c0: nL, c1: cols - 1, r0: nT, r1: rows - 1 } : null };
      if (updateEat && !reduce) { lastKey = ""; updateEat(); }   /* Zerfall-Maske im neuen Raster */

      if (introPending && performance.now() - t0Page > 900) introPending = false;   /* langsames Netz: Headline sofort zeigen */
      if (introPending) { introPending = false; playIntro(fills, clip); }
      else {
        intro = null;
        stopIntro();
        for (var fk = 0; fk < fills.length; fk++) { var f = fills[fk]; ctx.fillStyle = f[4]; ctx.fillRect(f[0], f[1], f[2], f[3]); }
        himg.style.clipPath = clip;
      }
    };

    /* Startanimation "Erst nur Landschaft": das Foto fuellt den ganzen Hero, dann flutet das Weiss in Pixelstufen
       hinein, die Treppe an der Fotokante kommt zuletzt, dann springen die losen Pixel ab, dann setzt sich die
       Headline Zelle fuer Zelle zusammen und der Text blendet ein. Zeiten in Stufen zu 50 ms: Spruenge statt Gleiten.
       Nur beim ersten Aufbau, nie bei reduzierter Bewegung (dann fehlt die Klasse "intro" am html). */
    var root = document.documentElement;
    var introPending = root.classList.contains("intro"), introActive = false, introRaf = 0;
    var t0Page = performance.now();
    /* nichts auf dem Geraet speichern (§ 25 TDDDG, kein Banner noetig): das Intro laeuft bei jedem Laden oben ohne Anker */
    if (introPending && (location.hash || window.scrollY > 0)) introPending = false;
    var intro = null;                                         /* { fills, k, clip } der laufenden Startanimation */
    var stopIntro = function () {
      if (introRaf) cancelAnimationFrame(introRaf);
      introRaf = 0; introActive = false;
      head.style.maskImage = head.style.webkitMaskImage = "";
      root.classList.remove("intro", "intro-head");
    };
    /* Sofort in den Endzustand: alle restlichen Zellen zeichnen, Foto beschneiden, Text zeigen.
       Greift, wenn der Tab unsichtbar wird oder die Animation zu lange braucht. */
    var finishIntro = function () {
      if (!intro) return;
      for (; intro.k < intro.fills.length; intro.k++) {
        var f = intro.fills[intro.k];
        ctx.fillStyle = f[4]; ctx.fillRect(f[0], f[1], f[2], f[3]);
      }
      himg.style.clipPath = intro.clip;
      intro = null;
      stopIntro();
    };
    document.addEventListener("visibilitychange", function () { if (document.hidden) finishIntro(); });
    /* Wer scrollt, tippt oder klickt, will den Inhalt: die Startanimation springt sofort ans Ende */
    var skipIntro = function () {
      ["wheel", "keydown", "pointerdown", "touchstart"].forEach(function (t) { window.removeEventListener(t, skipIntro, true); });
      introPending = false;
      finishIntro();
    };
    if (introPending) ["wheel", "keydown", "pointerdown", "touchstart"].forEach(function (t) { window.addEventListener(t, skipIntro, { capture: true, passive: true }); });
    var assembleHead = function (done) {
      var r = head.getBoundingClientRect(), g = grid.cell;
      var mc = Math.ceil(r.width / g), mr = Math.ceil(r.height / g), order = [];
      for (var i = 0; i < mc * mr; i++) order.push(i);
      order.sort(function (a, b) { return hash(a, 3) - hash(b, 3); });
      var m = document.createElement("canvas");
      m.width = Math.ceil(r.width); m.height = Math.ceil(r.height);
      var mctx = m.getContext("2d");
      mctx.fillStyle = "#000";
      var STEPS = 5, step = 0;
      var tick = function () {
        if (!introActive) return;
        step++;
        var upto = Math.round(order.length * step / STEPS);
        for (var k = Math.round(order.length * (step - 1) / STEPS); k < upto; k++) {
          var idx = order[k];
          mctx.fillRect((idx % mc) * g, ((idx / mc) | 0) * g, Math.ceil(g), Math.ceil(g));
        }
        var url = "url(" + m.toDataURL() + ")";
        head.style.webkitMaskImage = head.style.maskImage = url;
        head.style.webkitMaskSize = head.style.maskSize = "100% 100%";
        if (step === 1) root.classList.add("intro-head");
        if (step === STEPS - 1) root.classList.remove("intro");  /* Text blendet mit dem letzten Schritt ein */
        if (step < STEPS) setTimeout(tick, 45); else done();
      };
      tick();
    };
    var playIntro = function (fills, clip) {
      fills.sort(function (a, b) { return a[5] - b[5]; });
      intro = { fills: fills, k: 0, clip: clip };
      if (document.hidden) { finishIntro(); return; }          /* im Hintergrund-Tab nie halbfertig stehen lassen */
      introActive = true;
      setTimeout(finishIntro, 2600);                            /* Sicherheitsnetz, falls Frames ausbleiben */
      var t0 = null, STEP = 50, headAt = 950;
      var frame = function (now) {
        if (!introActive || !intro) return;
        if (t0 === null) t0 = now;
        var t = Math.floor((now - t0) / STEP) * STEP;
        while (intro.k < intro.fills.length && intro.fills[intro.k][5] <= t) {
          var f = intro.fills[intro.k++];
          ctx.fillStyle = f[4];
          ctx.fillRect(f[0], f[1], f[2], f[3]);
        }
        if (t >= headAt) {
          finishDrawOnly();
          introRaf = 0;
          assembleHead(function () { intro = null; stopIntro(); });
          return;
        }
        introRaf = requestAnimationFrame(frame);
      };
      var finishDrawOnly = function () {                        /* Zellen fertig, Foto beschneiden, Headline folgt */
        for (; intro.k < intro.fills.length; intro.k++) {
          var f = intro.fills[intro.k];
          ctx.fillStyle = f[4]; ctx.fillRect(f[0], f[1], f[2], f[3]);
        }
        himg.style.clipPath = intro.clip;
      };
      introRaf = requestAnimationFrame(frame);
    };
    var heroRun = function () { try { drawHero(); } catch (e) { stopIntro(); /* ohne Canvas bleibt das grob beschnittene Foto */ } };
    /* Erster Aufbau erst, wenn Schrift und Foto da sind: die Headline bestimmt die Form der Welle */
    (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(function () {
      if (himg.complete) heroRun(); else himg.addEventListener("load", heroRun);
    });
    var heroTimer, lastW = window.innerWidth;
    onResize(function () {
      if (window.innerWidth === lastW) return;                  /* iOS: Adressleiste aendert nur die Hoehe */
      lastW = window.innerWidth;
      clearTimeout(heroTimer); heroTimer = setTimeout(heroRun, 120);
    });

    /* Uebergang: der Hero klebt, sobald sein unteres Ende den Bildschirm erreicht, und liegt ueber Warum.
       Beim Scrollen zerfaellt er Zelle fuer Zelle, verstreut ueber die ganze Flaeche, samt Navbar (Wunsch Jamie
       02.10.2026). Darunter kommt Warum hoch. Ist alles weg, setzt sich die Navbar in Pixeln neu zusammen, der
       Button steht dann schon auf der Containerkante. Folgt dem Scrollen, rueckwaerts baut sich der Hero wieder auf.
       Bei reduzierter Bewegung klebt der Hero nur und Warum schiebt sich darueber. */
    var stickStart = 0;
    var svh = document.createElement("div");                  /* stabile Hoehe, springt nicht mit der Adressleiste */
    svh.style.cssText = "position:absolute;visibility:hidden;height:100svh;width:0;top:0";
    document.body.appendChild(svh);
    var placeHero = function () {
      stickStart = Math.max(0, hero.offsetHeight - svh.offsetHeight);
      hero.style.setProperty("--hero-stick", -stickStart + "px");
    };
    var hdrEl = document.querySelector("[data-header]");
    var nextEl = hero.nextElementSibling, nextPin = nextEl && nextEl.querySelector(".warum__pin");
    var EAT = 0.6, BUILD = 0.3;                                 /* Anteile der Bildschirmhoehe: erst zerfaellt der Hero ins Weiss, dann setzen sich Warum und Navbar zusammen */
    var gone = function (c, r) { return 0.65 * hash(c + 3, r + 11) + 0.35 * hash((c >> 2) + 5, (r >> 2) + 19); };   /* verstreut, mit kleinen Nestern */
    var back = function (c, r) { return hash(c + 71, r + 29); };
    /* Zellen als Pfad: je Zeile zusammenhaengende Laeufe, y0/y1 begrenzen auf den sichtbaren Streifen */
    var cellPath = function (cols, r0, r1, cell, dy, y0, y1, keep) {
      var d = "";
      for (var r = r0; r < r1; r++) {
        var top = Math.max(y0, r * cell - dy), bot = Math.min(y1, (r + 1) * cell - dy);
        if (bot <= top) continue;
        for (var c = 0; c < cols; c++) {
          if (!keep(c, r)) continue;
          var c1 = c; while (c1 + 1 < cols && keep(c1 + 1, r)) c1++;
          d += "M" + Math.round(c * cell) + " " + Math.round(top) + "H" + Math.round((c1 + 1) * cell) + "V" + Math.round(bot) + "H" + Math.round(c * cell) + "Z";
          c = c1;
        }
      }
      return d ? "path('" + d + "')" : "inset(50%)";
    };
    var eatTick = false, lastKey = "";
    var updateEat = function () {
      eatTick = false;
      var vh = svh.offsetHeight, y = window.scrollY - stickStart;
      var p = Math.min(1, Math.max(0, y / (vh * EAT)));
      var q = Math.min(1, Math.max(0, (y - vh * (touchUI ? EAT * 0.2 : EAT)) / (vh * BUILD)));   /* Touch: Warum baut sich schon auf, waehrend der Hero zerfaellt, nie ein leerer Bildschirm */
      var cell = grid ? grid.cell : 0;
      /* Stufen statt Gleiten: 48 Zerfall- und 24 Aufbau-Stufen (etwa 11 px Scroll je Stufe), die Maske wird nur je Stufe neu gebaut */
      if (p > 0 && p < 1) p = Math.max(1 / 48, Math.round(p * 48) / 48);
      if (q > 0 && q < 1) q = Math.max(1 / 24, Math.round(q * 24) / 24);
      var key = p + "/" + q + "/" + cell;
      if (key === lastKey) return;
      lastKey = key;
      /* erst alles lesen, dann schreiben: ein Layout je Frame */
      var heroW = hero.clientWidth, heroH = hero.offsetHeight;
      var nt = nextEl ? nextEl.getBoundingClientRect().top : 0, nh = nextEl ? nextEl.offsetHeight : 0, nw = nextEl ? nextEl.clientWidth : 0;
      var hh = hdrEl ? hdrEl.offsetHeight : 0;
      var cols = cell ? Math.ceil(heroW / cell) : 0, rows = cell ? Math.ceil(heroH / cell) : 0;
      /* Hero. Ganz zerfallen: auf null Flaeche beschnitten, die Headline bleibt im Barrierefreiheitsbaum */
      hero.classList.toggle("is-eating", p > 0);
      if (touchUI) {   /* Touch: Schrift ist weg, bevor die Zellen sie erreichen (erstes Fuenftel) */
        var tOp = p > 0 ? Math.max(0, 1 - p * 5).toFixed(3) : "";
        head.parentNode.style.opacity = tOp; wrap.style.opacity = tOp;   /* an den Containern: die Schrift hat eigene Uebergaenge, die hier nachhinken wuerden */
      }
      hero.classList.toggle("is-covered", p >= 1);
      var pe = touchUI ? Math.min(1, p * 1.15) : p;   /* Touch: die letzten Zellen gehen gemeinsam, keine verwaiste Zelle im Weiss */
      hero.style.clipPath = pe >= 1 ? "inset(50%)" : p > 0 && cell ? cellPath(cols, 0, rows, cell, 0, 0, heroH, function (c, r) { return gone(c, r) >= pe; }) : "";
      /* Warum: unsichtbar, solange der Hero zerfaellt (sonst laegen zwei Texte uebereinander), dann setzt sich der
         sichtbare Teil Zelle fuer Zelle zusammen. Unterhalb des Bildschirms steht Warum immer ganz da */
      if (nextEl) {
        var below = Math.max(0, vh - nt);
        if (!cell || q >= 1) { nextEl.style.clipPath = ""; (nextPin || nextEl).style.opacity = ""; }
        else if (touchUI) {
          /* Touch: Warum blendet ein, keine halb ausgestanzte Schrift. Unterhalb des Bildschirms ohnehin unsichtbar */
          nextEl.style.clipPath = "";
          (nextPin || nextEl).style.opacity = q < 1 ? q.toFixed(3) : "";   /* am Pin, nicht an der 400svh hohen Sektion: WebKit muss keine Riesenebene zusammensetzen */
        }
        else if (q <= 0) nextEl.style.clipPath = "inset(" + Math.round(Math.min(nh, below)) + "px 0 0 0)";
        else {
          var wr = Math.ceil(Math.min(nh, below) / cell), wc = Math.ceil(nw / cell);
          var cp = cellPath(wc, Math.max(0, Math.floor(-nt / cell)), wr, cell, 0, 0, below, function (c, r) { return back(c + 13, r + 7) < q; });
          var rest = "M0 " + Math.round(below) + "H" + nw + "V" + nh + "H0Z";
          nextEl.style.clipPath = cp.indexOf("path('") === 0 ? cp.slice(0, -2) + rest + "')" : "path('" + rest + "')";
        }
      }
      /* Navbar: zerfaellt im Raster des Hero (um den Klebeversatz verschoben), dann Aufbau mit eigenem Muster */
      if (!hdrEl) return;
      var rTop = Math.floor(stickStart / cell), rBot = Math.ceil((stickStart + hh) / cell);
      hdrEl.classList.toggle("is-past-hero", p >= 1);
      hdrEl.classList.toggle("is-eating", (p > 0 && p < 1) || (p >= 1 && q < 1));
      if (!cell || touchUI || p <= 0 || (p >= 1 && q >= 1)) hdrEl.style.clipPath = "";   /* Touch: die Navbar bleibt stehen, ein Anker im Uebergang */
      else if (p < 1) hdrEl.style.clipPath = cellPath(cols, rTop, rBot, cell, stickStart, 0, hh, function (c, r) { return gone(c, r) >= p; });
      else hdrEl.style.clipPath = cellPath(cols, rTop, rBot, cell, stickStart, 0, hh, function (c, r) { return back(c, r) < q; });
    };
    placeHero();
    onResize(function () { placeHero(); lastKey = ""; updateEat(); });
    if (!reduce) {
      root.classList.add("eat-on");
      window.addEventListener("scroll", function () { if (!eatTick) { eatTick = true; requestAnimationFrame(updateEat); } }, { passive: true });
      updateEat();
    }

    /* Maus-Effekt: der Zeiger kehrt um, was unter ihm liegt. Im Weiss erscheinen Pixel des Fotos
       (Durchschnittsfarbe der Stelle), ueber dem Foto weisse Pixel. Die Spur heilt in 0,65 s.
       Laeuft auch unter der Navbar, damit dort keine harte Kante entsteht. Die Aussparung mit dem Text
       unten rechts bleibt ruhig. Nur mit Maus, nie bei reduzierter Bewegung. */
    var fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (fine && !reduce) {
      var HEAL = 480, RADIUS = 1.4;   /* kleiner Pinsel: nur ein paar Zellen um den Zeiger */
      var white = cssVar(document.documentElement, "--c-bg") || "#fff";
      var life = new Map(), running = false;
      var inBox = function (c, r) {
        var b = grid && grid.box;
        return !!b && c >= b.c0 - 1 && c <= b.c1 && r >= b.r0 - 1 && r <= b.r1;
      };
      var paint = function (now) {
        tctx.clearRect(0, 0, trail.width, trail.height);
        if (!grid) { running = false; return; }
        life.forEach(function (t0, idx) {
          var age = (now - t0) / HEAL;
          if (age >= 1) { life.delete(idx); return; }
          var c = idx % grid.cols, r = (idx / grid.cols) | 0, o = idx * 4;
          tctx.globalAlpha = Math.ceil((1 - age) * 4) / 4;      /* heilt in vier Stufen, wie die Startanimation */
          tctx.fillStyle = grid.kind[idx] ? white : "rgb(" + grid.px[o] + "," + grid.px[o + 1] + "," + grid.px[o + 2] + ")";
          var x0 = Math.floor(c * grid.cd), y0 = Math.floor(r * grid.cd);
          tctx.fillRect(x0, y0, Math.ceil((c + 1) * grid.cd) - x0, Math.ceil((r + 1) * grid.cd) - y0);
        });
        tctx.globalAlpha = 1;
        if (life.size) requestAnimationFrame(paint); else running = false;
      };
      /* Am Dokument lauschen: die Navbar liegt ueber dem Hero und faengt die Maus sonst ab */
      document.addEventListener("pointermove", function (ev) {
        if (!grid || introActive || ev.pointerType !== "mouse" || window.scrollY > stickStart + 8) return;
        var hb = hero.getBoundingClientRect();
        if (ev.clientY < hb.top || ev.clientY > hb.bottom) return;
        var mx = (ev.clientX - hb.left) / grid.cell, my = (ev.clientY - hb.top) / grid.cell;
        var now = performance.now();
        for (var r = Math.floor(my - RADIUS); r <= Math.ceil(my + RADIUS); r++) {
          for (var c = Math.floor(mx - RADIUS); c <= Math.ceil(mx + RADIUS); c++) {
            if (r < 0 || c < 0 || r >= grid.rows || c >= grid.cols || inBox(c, r)) continue;
            var dx = c + 0.5 - mx, dy = r + 0.5 - my;
            if (dx * dx + dy * dy > RADIUS * RADIUS) continue;
            if (hash(c + ((now / 90) | 0), r) < 0.5) continue;  /* nicht jede Zelle, sonst wirkt es wie ein Stempel */
            var gi = r * grid.cols + c;
            if (grid.safe[gi] || (!grid.kind[gi] && grid.far[gi] > 4)) continue;   /* nie ueber der Headline, nur nahe der Fotokante */
            life.set(gi, now);
          }
        }
        if (!running) { running = true; requestAnimationFrame(paint); }
      }, { passive: true });
    }
  }

  /* ---------- Pixel-Buttons: beim Hover springen Pixel in der Farbe des Buttons ab ---------- */
  if (!reduce && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    document.querySelectorAll(".btn--pixel:not(.btn--nav)").forEach(function (btn) {   /* der kleine Kopfknopf bekommt keine fliegenden Pixel */
      var last = 0;
      btn.addEventListener("pointerenter", function (ev) {
        if (ev.pointerType !== "mouse") return;
        var now = performance.now();
        if (now - last < 400) return;                           /* nicht bei jedem Zucken neu */
        last = now;
        var r = btn.getBoundingClientRect();
        var cs = getComputedStyle(btn);   /* die Farbe, in die der Knopf gerade gleitet; beim transparenten Knopf die Kante */
        var color = btn.classList.contains("btn--primary") ? cssVar(document.documentElement, "--c-primary-hover") : cs.backgroundColor;
        if (/transparent|rgba\([^)]*,\s*0\)$/.test(color)) color = cs.borderColor;
        if (/transparent|rgba\([^)]*,\s*0\)$/.test(color)) return;
        var per = 2 * (r.width + r.height);
        for (var i = 0; i < 14; i++) {
          var s = Math.random() * per, x, y, nx, ny;
          if (s < r.width) { x = r.left + s; y = r.top; nx = 0; ny = -1; }
          else if (s < r.width + r.height) { x = r.right; y = r.top + (s - r.width); nx = 1; ny = 0; }
          else if (s < 2 * r.width + r.height) { x = r.right - (s - r.width - r.height); y = r.bottom; nx = 0; ny = 1; }
          else { x = r.left; y = r.bottom - (s - 2 * r.width - r.height); nx = -1; ny = 0; }
          var bit = document.createElement("span");
          bit.className = "px-bit";
          bit.style.background = color;
          bit.style.left = x + "px"; bit.style.top = y + "px";
          document.body.appendChild(bit);
          var dist = 6 + Math.random() * 14;
          var dx = nx * dist + (Math.random() - 0.5) * 6, dy = ny * dist + (Math.random() - 0.5) * 6;
          var anim = bit.animate([
            { transform: "translate(-50%, -50%)", opacity: 1 },
            { transform: "translate(calc(-50% + " + dx.toFixed(1) + "px), calc(-50% + " + dy.toFixed(1) + "px))", opacity: 0 }
          ], { duration: 420 + Math.random() * 180, delay: Math.random() * 40, easing: "steps(5, start)", fill: "both" }   /* springt im ersten Frame ab */);
          anim.onfinish = (function (b) { return function () { b.remove(); }; })(bit);
        }
      });
    });
  }

  /* ---------- Zähler: Port des Zählers aus inspo/startseite/02-warum.code.txt ----------
     1100 ms, ease-out kubisch, Auslöser bei 60 % Sichtbarkeit, Zahlenformat de-DE.
     Bei reduzierter Bewegung steht sofort der Endwert. */
  var format = function (v, dec) { return v.toLocaleString("de-DE", { minimumFractionDigits: dec, maximumFractionDigits: dec }); };
  var runCount = function (el, durOverride) {
    var target = parseFloat(el.getAttribute("data-count")), from = parseFloat(el.getAttribute("data-from") || "0");
    var dec = parseInt(el.getAttribute("data-dec") || "0", 10);
    var dur = durOverride || parseFloat(cssVar(document.documentElement, "--dur-count")) || 1100;
    var start = null;
    cancelAnimationFrame(el._countRaf);                        /* ein neuer Lauf ersetzt den alten, nie zwei zugleich */
    var tick = function (ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      el.innerHTML = format(from + (target - from) * (1 - Math.pow(1 - p, 3)), dec).replace(",", '<span class="num-sep">,</span>');
      if (p < 1) el._countRaf = requestAnimationFrame(tick);
    };
    el._countRaf = requestAnimationFrame(tick);
  };
  /* Idee und Beispiel: einmal einblenden, wenn sie ins Bild kommen (das Ergebnisfenster, die Balken der Karten) */
  if (!reduce && "IntersectionObserver" in window) {
    document.documentElement.classList.add("reveal-on");
    var ro = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("is-in"); ro.unobserve(e.target); } });
    }, { threshold: 0.35 });
    /* Headlines: einmal beim ersten Hineinscrollen. Beobachtet wird der Block drumherum: eine ganz weggeschnittene
       Zeile (Wisch) zaehlt sonst als unsichtbar und wuerde nie ausgeloest */
    var hro = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        hro.unobserve(e.target);
        e.target.querySelectorAll("[data-reveal]").forEach(function (h) { h.classList.add("is-in"); });
      });
    }, { rootMargin: "0px 0px -15% 0px" });
    document.querySelectorAll("[data-reveal]").forEach(function (el) {
      var box = el.parentElement;                                 /* display: contents (Idee mobil) hat keine Box */
      while (getComputedStyle(box).display === "contents") box = box.parentElement;
      hro.observe(box);
    });
  }

  /* ---------- Idee: Durchlauf in der Buehne als Animation. Eine Zeitleiste rechnet jeden Frame alle Werte aus der Zeit t:
     Tasten als Akkord, Ruhefenster, Bild wird in einer Kurve hineingezogen, Panel klappt auf, Name wird getippt,
     Klick auf "Verarbeiten", Panel geht, das Ergebnis steht allein. Dann leise von vorn. Laeuft nur, solange die Buehne
     zu sehen ist (und nach der Uebergabe aus dem Bilderflug). Reduziert und ohne JS: das Ergebnis allein */
  var demo = document.querySelector("[data-demo]");
  if (demo && !reduce && "IntersectionObserver" in window) {
    demo.classList.add("demo-on");
    /* Tastatur bauen: deutsches Mac-Layout, Breite je Taste in Einheiten (--u). Nur Dekoration */
    var dBoard = demo.querySelector("[data-board]"), dKeys = [];
    var ROWS = [
      [["^"], ["1"], ["2"], ["3"], ["4"], ["5"], ["6"], ["7"], ["8"], ["9"], ["0"], ["ß"], ["´"], ["⌫", 1.5]],
      [["⇥", 1.5], ["Q"], ["W"], ["E"], ["R"], ["T"], ["Z"], ["U"], ["I"], ["O"], ["P", 1, "p"], ["Ü"], ["+"], ["↩", 1, null, "enter-top"]],
      [["⇪", 1.75], ["A"], ["S"], ["D"], ["F"], ["G"], ["H"], ["J"], ["K"], ["L"], ["Ö"], ["Ä"], ["#"], ["", 0.75, null, "enter-low"]],
      [["⇧", 1.25], ["<"], ["Y"], ["X"], ["C"], ["V"], ["B"], ["N"], ["M"], [","], ["."], ["-"], ["⇧", 2.25]],
      [["fn"], ["⌃"], ["⌥"], ["⌘", 1.25], ["", 5], ["⌘", 1.25, "cmd"], ["⌥", 1, "opt"], ["←"], ["↕"], ["→"]]
    ];
    var dHot = {};
    if (dBoard) ROWS.forEach(function (row) {
      var r = document.createElement("div"); r.className = "demo__row";
      row.forEach(function (k) {
        var e = document.createElement("span"); e.className = "demo__k" + (k[0].length === 1 && /[^A-Z0-9ÄÖÜß^´+#<,.\-]/.test(k[0]) ? " is-mod" : "");
        e.textContent = k[0]; if (k[1]) e.style.setProperty("--u", k[1]);
        if (k[2]) dHot[k[2]] = e;
        if (k[3]) e.classList.add("is-" + k[3]);   /* ISO-Eingabetaste: zwei Teile, eine Taste */
        r.appendChild(e);
      });
      dBoard.appendChild(r);
    });
    dKeys = [dHot.opt, dHot.cmd, dHot.p].filter(Boolean);   /* Reihenfolge wie der Kurzbefehl: Wahl, Befehl, P */
    var dRes = { kb: demo.querySelector("[data-res-kb]"), pct: demo.querySelector("[data-res-pct]"), bar: demo.querySelector("[data-res-bar]"), check: demo.querySelector(".res__check") };
    /* die Zahl bekommt die Breite ihres Endwerts: beim Hochzaehlen wandert "aus 2,1 MB" nicht */
    var dFixW = function () { [dRes.kb, dRes.pct].forEach(function (e) { e.style.minWidth = ""; e.style.display = "inline-block"; e.style.textAlign = "right"; var keep = e.textContent; e.textContent = e === dRes.kb ? "215" : "83"; e.style.minWidth = e.getBoundingClientRect().width.toFixed(1) + "px"; e.textContent = keep; }); };
    var dDrag = demo.querySelector(".demo__drag"), dThumb = demo.querySelector(".demo__thumb");
    var dRuhe = demo.querySelector(".demo__ruhe"), dPanel = demo.querySelector(".demo__panel"), dPress = demo.querySelector(".demo__press"), dType = demo.querySelector(".demo__type");
    var dFertig = demo.querySelector(".stage__fertig"), dCursor = demo.querySelector(".demo__cursor");
    var cl = function (v) { return Math.min(1, Math.max(0, v)); };
    var seg = function (t, a, b) { return cl((t - a) / (b - a)); };
    var eOut = function (q) { return 1 - Math.pow(1 - q, 3); };                 /* ankommen: schnell los, weich aus */
    var eInOut = function (q) { return q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2; };   /* bewegen auf der Buehne */
    var eBack = function (q) { var c = 1.4; return 1 + (c + 1) * Math.pow(q - 1, 3) + c * Math.pow(q - 1, 2); };   /* ein Hauch Nachfedern beim Aufklappen */
    /* nur schreiben, was sich aendert: in den Haltephasen kostet die Schleife fast nichts */
    var dSet = function (el, o, tf) { var os = o.toFixed(3); if (el._o !== os) { el.style.opacity = os; el._o = os; } if (el._t !== tf) { el.style.transform = tf; el._t = tf; } };
    var dPx = function (name, fb) { var v = cssVar(document.documentElement, name); return v.indexOf("rem") > 0 ? parseFloat(v) * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) : parseFloat(v) || fb; };
    var KEY_DEPTH = dPx("--demo-key-depth", 4);
    var TEMPO = 11650 / (parseFloat(cssVar(document.documentElement, "--demo-loop")) || 11650);   /* Takt aus tokens.css */
    /* Zeitleiste in ms */
    /* Tastatur: liegt auf dem Tisch, Kamera zoomt auf Wahl, Befehl und P, Akkord, dann zoomt sie weiter und geht */
    var BIN = 0, ZOOM0 = 350, ZOOM1 = 1250, KDOWN = [1350, 1520, 1690], KUP = 2050, BOUT = 2150,
        RIN = 2400, DRAGIN = 2850, DRAG0 = 3050, DRAG1 = 3900, DROP = 4000,
        TOFIELD0 = 4350, TOFIELD1 = 4950, TYPE0 = 5100, TOBTN0 = 6350, TOBTN1 = 7000, PRESS0 = 7100, PRESS1 = 7250, SWAP = 7300, D_HOLD = 11000, D_OUT = 11500, D_LOOP = 11650;
    /* natuerliches Tippen: 13 Zeichen mit leicht wechselndem Abstand */
    var typeAt = [0, 95, 170, 260, 330, 430, 500, 585, 700, 770, 850, 920, 1010].map(function (d) { return TYPE0 + d; });
    var dP = null;
    var dMeasure = function () {
      var w = demo.offsetWidth, h = demo.offsetHeight;
      var pc = function (el, fx, fy) { var x = 0, y = 0, n = el; while (n && n !== demo) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; } return [x + el.offsetWidth * fx, y + el.offsetHeight * fy]; };
      var ruheC = [w / 2, h / 2];
      dP = { w: w, h: h, bw: dBoard ? dBoard.offsetWidth : 0, bh: dBoard ? dBoard.offsetHeight : 0, start: [w * 0.8, h * 0.85], ruhe: ruheC, field: pc(dPanel, 0.44, 0.61), btn: pc(dPanel, 0.53, 0.9), out: [w * 0.82, h * 0.86] };
    };
    /* quadratische Kurve: der Zeiger zieht im Bogen, nicht auf dem Lineal */
    var curve = function (a, b, bend, q) {
      var mx = (a[0] + b[0]) / 2 + (b[1] - a[1]) * bend, my = (a[1] + b[1]) / 2 - (b[0] - a[0]) * bend;
      var u = 1 - q;
      return [u * u * a[0] + 2 * u * q * mx + q * q * b[0], u * u * a[1] + 2 * u * q * my + q * q * b[1]];
    };
    var dFrame = function (t) {
      if (!dP) { dMeasure(); dFixW(); }
      /* Tastatur: nur die rechte Haelfte, flach von oben. Sie gleitet herein, Befehl, Wahl und P werden gedrueckt, dann gleitet sie weg */
      if (dBoard && (t < BOUT + 500 || dBoard._o !== "0.000")) {
        var W = dP.w, H = dP.h, bw = dP.bw, bh = dP.bh;
        var bIn = eOut(seg(t, BIN, BIN + 550)), drift = eInOut(seg(t, ZOOM0, KUP)), bOut = eInOut(seg(t, BOUT, BOUT + 450));
        var sc = 1 + 0.04 * drift;   /* die Kamera kommt nur einen Hauch naeher */
        var tx = W * 0.97 - bw * sc, ty = H * 0.86 - bh * sc + H * 0.08 * (1 - bIn) + H * 0.1 * bOut;   /* nur die rechte Haelfte, wie am Desktop (Jamie 05.10.2026) */
        dSet(dBoard, bIn * (1 - bOut), "translate(" + tx.toFixed(1) + "px, " + ty.toFixed(1) + "px) scale(" + sc.toFixed(4) + ")");
        dKeys.forEach(function (k, i) {
          var down = t >= KDOWN[i] && t < KUP;
          if (k._d !== down) { k.classList.toggle("is-down", down); k.style.transform = down ? "translateY(" + (KEY_DEPTH / 2).toFixed(1) + "px)" : ""; k._d = down; }
        });
      }
      /* Ruhefenster: erscheint, hebt sich leicht, wenn das Bild darueber ist, waechst beim Aufklappen mit und geht */
      var rIn = eOut(seg(t, RIN, RIN + 450)), hover = eInOut(seg(t, DRAG1 - 250, DRAG1)) * (1 - seg(t, DROP, DROP + 120));
      var grow = eOut(seg(t, DROP, DROP + 420)), rO = rIn * (1 - eOut(seg(t, DROP + 80, DROP + 200)));   /* geht, bevor das Panel halb da ist: kein Geisterbild */
      dSet(dRuhe, rO, "translate(-50%, -50%) scale(" + (0.9 + 0.1 * rIn + 0.04 * hover + 0.25 * grow).toFixed(4) + ")");
      /* Panel klappt aus dem Ruhefenster auf, geht nach dem Klick */
      var pIn = seg(t, DROP + 80, DROP + 560), pOut = seg(t, SWAP, SWAP + 140);   /* Panel geht schnell: kein Geisterbild ueber dem Ergebnis */
      dSet(dPanel, cl(pIn * 4) * (1 - pOut), "scale(" + (0.6 + 0.4 * eBack(pIn) - 0.05 * pOut).toFixed(4) + ")");
      /* Tippen */
      var n = 0; for (var c = 0; c < typeAt.length; c++) if (t >= typeAt[c]) n = c + 1;
      var ts = "scaleX(" + (1 - n / 13).toFixed(4) + ")"; if (dType._t !== ts) { dType.style.transform = ts; dType._t = ts; }
      /* Klick */
      var po = (eOut(seg(t, PRESS0, PRESS0 + 70)) * (1 - seg(t, PRESS1 - 40, PRESS1 + 80))).toFixed(3); if (dPress._o !== po) { dPress.style.opacity = po; dPress._o = po; }
      /* Ergebnis allein, mittig; am Ende leise weg */
      var fIn = seg(t, SWAP, SWAP + 500)   /* kreuzt das gehende Panel bei etwa der Haelfte: keine leere Buehne */, fOut = eOut(seg(t, D_HOLD, D_OUT));
      /* wie in der App: der Haken ploppt, 215 KB zaehlt langsam hoch, die Leiste laeuft mit */
      var ck = seg(t, SWAP + 380, SWAP + 760), ckS = ck <= 0 ? 0 : eBack(ck);
      dSet(dRes.check, cl(ck * 3), "scale(" + ckS.toFixed(3) + ")");
      var cnt = eOut(seg(t, SWAP, SWAP + 1800));   /* zaehlt los, sobald das Fenster kommt: kein stehendes 0 KB */
      var kbs = String(Math.round(215 * cnt)), pcs = String(Math.round(83 * cnt));
      if (dRes.kb._s !== kbs) { dRes.kb.textContent = kbs; dRes.kb._s = kbs; }
      if (dRes.pct._s !== pcs) { dRes.pct.textContent = pcs; dRes.pct._s = pcs; }
      var bs = "scaleX(" + (0.83 * cnt).toFixed(4) + ")"; if (dRes.bar._t !== bs) { dRes.bar.style.transform = bs; dRes.bar._t = bs; }
      dSet(dFertig, cl(fIn * 4) * (1 - fOut), "scale(" + (0.92 + 0.08 * eBack(fIn) - 0.03 * fOut).toFixed(4) + ")");
      /* Zeiger und Bild */
      var pt, dragO = eOut(seg(t, DRAGIN, DRAGIN + 220)) * (1 - eOut(seg(t, SWAP, SWAP + 260)));
      if (t < DROP) pt = curve(dP.start, dP.ruhe, 0.18, eInOut(seg(t, DRAG0, DRAG1)));
      else if (t < TOBTN0) pt = curve(dP.ruhe, dP.field, -0.12, eInOut(seg(t, TOFIELD0, TOFIELD1)));
      else pt = curve(dP.field, dP.btn, 0.1, eInOut(seg(t, TOBTN0, TOBTN1)));
      var press = eOut(seg(t, PRESS0, PRESS0 + 70)) * (1 - seg(t, PRESS1 - 40, PRESS1 + 80));
      dSet(dDrag, dragO, "translate(" + pt[0].toFixed(1) + "px, " + pt[1].toFixed(1) + "px)");
      var cs = "scale(" + (1 - 0.12 * press).toFixed(3) + ")"; if (dCursor._t !== cs) { dCursor.style.transform = cs; dCursor._t = cs; }
      var lift = eInOut(seg(t, DRAG0, DRAG0 + 300)), drop = eOut(seg(t, DROP - 80, DROP + 160));
      dSet(dThumb, 1 - drop, "rotate(" + ((1 - eInOut(seg(t, DRAG0, DRAG1))) * 6).toFixed(2) + "deg) scale(" + (1 + 0.04 * lift - 0.5 * drop).toFixed(4) + ")");
    };
    var dT0 = 0, dRaf = 0, dOn = false, dSeen = false, dFresh = true, dHeld = 0;
    var dLoop = function (now) {
      if (!dT0) dT0 = now - dHeld;
      dHeld = ((now - dT0) * TEMPO) % D_LOOP / TEMPO;
      dFrame((now - dT0) * TEMPO % D_LOOP);
      dRaf = requestAnimationFrame(dLoop);
    };
    var dShow = function () { return dSeen && !document.hidden && (!document.documentElement.classList.contains("handoff-on") || demo.classList.contains("is-born")); };
    /* zurueck auf Anfang erst, wenn die Buehne ganz weg ist: beim Wiedereintritt dann von vorn, kurzes Wegschauen friert nur ein */
    var dReset = function () { cancelAnimationFrame(dRaf); dOn = false; dFresh = true; dHeld = 0; dT0 = 0; dFrame(0); };
    var dCheck = function () {
      var on = dShow();
      if (on && !dOn) { if (dFresh) { dHeld = 0; dP = null; } dFresh = false; dT0 = 0; dRaf = requestAnimationFrame(dLoop); }
      else if (!on && dOn) cancelAnimationFrame(dRaf);   /* anhalten, Bild bleibt stehen: kein Sprung */
      dOn = on;
    };
    dFrame(0);
    new IntersectionObserver(function (es) { es.forEach(function (e) { dSeen = e.isIntersecting; }); dCheck(); }, { threshold: 0.35 }).observe(demo);
    new IntersectionObserver(function (es) { es.forEach(function (e) { if (!e.isIntersecting) dReset(); }); }, { threshold: 0 }).observe(demo);
    document.addEventListener("visibilitychange", function () { if (document.hidden) dReset(); else dCheck(); });   /* zurueck im Tab: von vorn */
    new MutationObserver(function () { if (document.documentElement.classList.contains("handoff-on") && !demo.classList.contains("is-born")) dReset(); dCheck(); }).observe(demo, { attributes: true, attributeFilter: ["class"] });
    onResize(function () { dP = null; });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { dP = null; });   /* Masse nach dem Laden der Schrift neu */
  }

  /* ---------- Warum: Szene mit Waage. Der Scrollfortschritt durch die Sektion waehlt den Zustand:
     0 leer, 1 Foto, 2 Startseite, 3 LCP, 4 Preen (Schwellen --step-at, Puffer --step-hold gegen Flackern).
     Die Neigung folgt den echten Gewichten (links Foto, rechts alle Bilder einer Startseite). Rueckwaerts setzt data-dir,
     dann kippt die Waage ohne Wartezeit und nichts wird nachgespielt. Ohne JS keine Szene: data-step="4" aus dem HTML,
     alles steht untereinander. Bei reduzierter Bewegung dieselbe Szene, aber nur Ueberblendungen (.story-calm). */
  var story = document.querySelector("[data-story]");
  if (story) {
    var rootS = document.documentElement;
    rootS.classList.add("story-on");
    if (reduce) rootS.classList.add("story-calm");
    var scene = story.querySelector(".warum__scene"), bal = story.querySelector("[data-balance]"), pin = story.querySelector(".warum__pin"), track = story.querySelector(".warum__track");
    var runway = function () { return track.offsetHeight - pin.offsetHeight; };   /* so lange klebt der Pin */
    var chs = Array.prototype.slice.call(story.querySelectorAll("[data-chapter]"));
    var sPhoto = story.querySelector("[data-photo-kb]"), sWhat = story.querySelector("[data-photo-what]"), sWhatS = story.querySelector("[data-photo-what-s]"), photoBox = story.querySelector("[data-photo]");
    var W = { 0: [0, 0], 1: [2093, 0], 2: [2093, 900], 3: [2093, 900], 4: [215, 900] };
    var AT = cssVar(rootS, "--step-at").split(",").map(parseFloat), HOLD = parseFloat(cssVar(rootS, "--step-hold")) || 0.02;
    var tiltMax = parseFloat(cssVar(rootS, "--tilt-max")) || 14;
    var sCur = -1, timers = [], shedAnims = [], activeCh = null, activeDot = null;
    var later = function (fn, ms) { timers.push(setTimeout(fn, ms)); };
    var LABEL = { orig: ["Skye-Foto, Original", "Original"], busy: ["wird komprimiert", "wird komprimiert"], preen: ["Skye-Foto, mit Preen", "mit Preen"] };
    var shown = function () { return parseFloat(sPhoto.textContent.replace(/\./g, "").replace(",", ".")) || 0; };
    /* Kapitel 4: Pixel springen vom Foto ab, das ist die Kompression */
    var shed = function () {
      var r = photoBox.getBoundingClientRect(), colors = ["--c-feather", "--c-primary", "--c-text"];
      for (var i = 0; i < 28; i++) {
        var bit = document.createElement("span");
        bit.className = "px-bit px-bit--l";
        bit.style.background = cssVar(rootS, colors[i % colors.length]);
        var x = r.left + Math.random() * r.width, y = r.top + Math.random() * r.height * 0.7;
        if (touchUI) {   /* Touch: die Truemmer haengen an der Szene und scrollen mit ihr hinaus, statt kurz ueber den Quellen stehen zu bleiben */
          var pr0 = pin.getBoundingClientRect();
          bit.style.position = "absolute"; bit.style.left = (x - pr0.left) + "px"; bit.style.top = (y - pr0.top) + "px";
          pin.appendChild(bit);
        } else {
          bit.style.left = x + "px"; bit.style.top = y + "px";
          document.body.appendChild(bit);
        }
        var dx = (x - (r.left + r.width / 2)) * 0.8 + (Math.random() - 0.5) * 30, dy = -40 - Math.random() * 50;
        var anim = bit.animate([
          { transform: "translate(-50%, -50%)", opacity: 1 },
          { transform: "translate(calc(-50% + " + dx.toFixed(1) + "px), calc(-50% + " + dy.toFixed(1) + "px))", opacity: 0 }
        ], { duration: 360 + Math.random() * 140, delay: Math.random() * 100, easing: "steps(5, end)", fill: "both" });
        anim.onfinish = (function (b) { return function () { b.remove(); }; })(bit);
        shedAnims.push(anim);   /* ein Schrittwechsel beendet sie, nie fliegen Pixel ueber das naechste Kapitel */
      }
    };
    /* Verwandlung: Kopien fliegen zwischen Schalen und Kreisen, Ecke 0 zu rund (oder umgekehrt). Die Originale bleiben
       per .is-morph verborgen. Unterbrechbar: eine laufende Kopie wird an ihrer aktuellen Stelle festgehalten und fliegt
       von dort zum neuen Ziel, nie ein Sprung */
    var loadPhoto = photoBox, loadMedian = story.querySelector(".balance__load--median");
    var rings = Array.prototype.slice.call(story.querySelectorAll(".gauge__ring"));
    var morphTimer = 0, ghosts = [];
    var dropGhosts = function () {
      clearTimeout(morphTimer);
      ghosts.forEach(function (g) { if (g.anim) g.anim.cancel(); g.el.remove(); });
      ghosts = [];
      scene.classList.remove("is-morph");
    };
    var morph = function (toRings) {
      var dur = parseFloat(cssVar(rootS, "--dur-morph")) || 560, ease = cssVar(rootS, "--ease-morph") || "ease-in-out";
      var frame = cssVar(rootS, "--c-text"), fw = cssVar(rootS, "--bal-frame") || "2px";
      clearTimeout(morphTimer);
      scene.classList.add("is-morph");                          /* zuerst: Ebenen ohne Skalierung, Originale verborgen, dann messen */
      var pairs = [[loadPhoto, rings[0], loadPhoto.querySelector("img"), false], [loadMedian, rings[1], loadMedian, true]];
      var pr = pin.getBoundingClientRect();                     /* Kopien leben im Pin: Koordinaten relativ zu ihm */
      var box = function (r) { return { transform: "translate(" + (r.left - pr.left).toFixed(1) + "px, " + (r.top - pr.top).toFixed(1) + "px)", width: r.width + "px", height: r.height + "px" }; };   /* Lage per transform, nur die Groesse bleibt Layout */
      pairs.forEach(function (m, i) {
        var g = ghosts[i], from;
        if (g) {                                                /* Gegenzug mitten im Flug: von der aktuellen Stelle weiter */
          var cs = getComputedStyle(g.el);
          from = { transform: cs.transform, width: cs.width, height: cs.height, borderRadius: cs.borderRadius, opacity: cs.opacity, boxShadow: cs.boxShadow };
          g.anim.cancel();
        } else {
          var el = document.createElement("div");
          el.className = "morph-ghost" + (m[3] ? " morph-ghost--pile" : "");
          el.appendChild(m[2].cloneNode(true));
          pin.appendChild(el);
          g = ghosts[i] = { el: el };
          from = box((toRings ? m[0] : m[1]).getBoundingClientRect());
          from.borderRadius = toRings ? "0%" : "50%"; from.opacity = toRings ? 1 : 0;
          if (!m[3]) from.boxShadow = "0 0 0 " + fw + " " + (toRings ? frame : "transparent");
        }
        var to = box((toRings ? m[1] : m[0]).getBoundingClientRect());
        to.borderRadius = toRings ? "50%" : "0%"; to.opacity = toRings ? 0 : 1;
        if (!m[3]) to.boxShadow = "0 0 0 " + fw + " " + (toRings ? "transparent" : frame);   /* der Rahmen geht im farbigen Ring auf */
        var mid = { offset: toRings ? 0.8 : 0.2, opacity: 1 };
        g.anim = g.el.animate([from, mid, to], { duration: dur, easing: ease, fill: "both" });
      });
      morphTimer = setTimeout(function () {
        ghosts.forEach(function (g) { g.el.remove(); });
        ghosts = [];
        scene.classList.remove("is-morph");
      }, dur);
    };
    onResize(dropGhosts);             /* veraltete Ziele: sofort ins Ziel */
    var lastStep = 0, quickTimer = 0;
    var setStep = function (n) {
      if (n === sCur) return;
      var prev = sCur, first = prev < 0;
      var now = performance.now(), quick = !first && now - lastStep < (parseFloat(cssVar(rootS, "--quick-gap")) || 350);
      lastStep = now;
      clearTimeout(quickTimer);
      scene.classList.toggle("is-quick", quick);
      scene.setAttribute("data-entry", quick ? "quick" : "full");   /* bleibt bis zum naechsten Wechsel: nichts wird rueckwirkend langsam */
      if (quick) quickTimer = setTimeout(function () { scene.classList.remove("is-quick"); }, (parseFloat(cssVar(rootS, "--quick-gap")) || 350) + 50);
      sCur = n;
      scene.setAttribute("data-dir", !first && n < prev ? "back" : "fwd");
      scene.setAttribute("data-step", n);
      chs.forEach(function (c) { var on = +c.getAttribute("data-chapter") === n; c.classList.toggle("is-active", on); if (on) activeCh = c; });
      activeDot = null;
      story.querySelectorAll("[data-goto]").forEach(function (b) { if (+b.getAttribute("data-goto") === n) { b.setAttribute("aria-current", "step"); activeDot = b; } else b.removeAttribute("aria-current"); });
      var w = W[n];
      bal.style.setProperty("--tilt", (w[0] + w[1] ? -tiltMax * (w[0] - w[1]) / (w[0] + w[1]) : 0).toFixed(2) + "deg");
      /* Gewicht: zaehlt vom angezeigten Wert, das Etikett wechselt erst, wenn 215 KB erreicht sind */
      var kb = n === 4 ? 215 : 2093, calm = first || reduce || quick;   /* schnell gescrollt: Endwerte sofort */
      var countDur = n === 4 ? parseFloat(cssVar(rootS, "--dur-count-shed")) || 750 : 0;
      timers.forEach(clearTimeout); timers = [];
      sWhat.classList.remove("is-swap"); sWhatS.classList.remove("is-swap");   /* ein abgebrochener Tausch laesst das Etikett nie unsichtbar */
      shedAnims.forEach(function (a) { a.finish(); }); shedAnims = [];
      if (shown() !== kb) {
        sPhoto.setAttribute("data-from", shown()); sPhoto.setAttribute("data-count", kb); sPhoto.setAttribute("data-dec", 0);
        if (calm) { cancelAnimationFrame(sPhoto._countRaf); sPhoto.textContent = format(kb, 0); }
        else if (n === 4 && prev === 3) { cancelAnimationFrame(sPhoto._countRaf); later(function () { runCount(sPhoto, countDur); }, (parseFloat(cssVar(rootS, "--dur-morph")) || 460) * 0.8); }
        else runCount(sPhoto, countDur);
      }
      /* Etikett mit kurzem Ausblenden tauschen, nie hart. Alle Timer stehen in einer Liste, ein Schrittwechsel loescht sie */
      var dip = parseFloat(cssVar(rootS, "--dur-swap")) || 120;
      var put = function (l) { sWhat.textContent = l[0]; sWhatS.textContent = l[1]; };
      var swap = function (l, wait) {
        if (calm) { put(l); return; }
        later(function () {
          sWhat.classList.add("is-swap"); sWhatS.classList.add("is-swap");
          later(function () { put(l); sWhat.classList.remove("is-swap"); sWhatS.classList.remove("is-swap"); }, dip);
        }, wait);
      };
      var morphing = !calm && ((prev === 2 && n === 3) || (prev === 3 && (n === 4 || n === 2)));
      if (!morphing) dropGhosts();
      else morph(n === 3);
      /* Kapitel 3: die Zahlen in den Messkreisen zaehlen mit dem Ring hoch, erst das Original, dann Preen */
      if (n === 3) {
        var gStag = parseFloat(cssVar(rootS, "--gauge-stagger")), wait = isNaN(gStag) ? 450 : gStag;   /* 0 ist erlaubt (Handy): beide zaehlen zugleich */
        var fadeIn = morphing ? (parseFloat(cssVar(rootS, "--dur-morph")) || 460) * 0.8 : (parseFloat(cssVar(rootS, "--dur-fade")) || 300) * (1 + (parseFloat(cssVar(rootS, "--gauges-overlap")) || 0.6));   /* wie der Ring in CSS */
        var ringDur = parseFloat(cssVar(rootS, "--dur-gauge")) || 900;
        Array.prototype.forEach.call(story.querySelectorAll(".gauge__num"), function (el, gi) {
          var v = +el.getAttribute("data-count");
          cancelAnimationFrame(el._countRaf);
          if (calm || (!first && prev === 4)) { el.textContent = v; return; }     /* rueckwaerts aus Kapitel 4: steht schon */
          el.textContent = "0"; el.setAttribute("data-from", 0); el.setAttribute("data-dec", 0);
          later(function () { runCount(el, ringDur); }, fadeIn + gi * wait);
        });
      }
      /* Aus Kapitel 3: erst gehen die Kreise, dann kommt die Waage, erst dann die Kompression */
      var ret = !calm && n === 4 && prev === 3 ? (parseFloat(cssVar(rootS, "--dur-morph")) || 460) * 0.8 : 0;   /* Kompression beginnt, waehrend Foto und Stapel in den Schalen landen */
      scene.classList.toggle("is-return", ret > 0);
      if (n === 4) {
        if (!calm && prev >= 1 && prev < 4) {                    /* ab 0 gibt es noch kein Foto, von dem Pixel springen koennten */
          later(function () {
            shed();
            photoBox.classList.remove("is-shed"); void photoBox.offsetWidth; photoBox.classList.add("is-shed");
          }, ret);
        }
        if (calm) put(LABEL.preen);
        else { swap(LABEL.busy, ret); swap(LABEL.preen, ret + countDur); }
      } else if (sWhat.textContent !== LABEL.orig[0]) swap(LABEL.orig, 0);
    };
    var storyTick = false;
    var stepFor = function (p) {
      var n = 0;
      for (var k = 0; k < AT.length; k++) {
        var edge = AT[k] + (k + 1 > sCur ? HOLD : -HOLD);       /* vorwaerts etwas spaeter, rueckwaerts etwas frueher: kein Flackern */
        if (sCur < 0) edge = AT[k];
        if (p >= edge) n = k + 1;
      }
      return n;
    };
    var pickStep = function () {
      storyTick = false;
      var r = track.getBoundingClientRect(), span = runway();   /* Pinhoehe statt innerHeight: Adressleiste */
      var p = span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 0;
      setStep(stepFor(p));
      /* Fortschritt im aktuellen Kapitel: Zelle fuellt sich, Text gleitet leicht. Nur transform und Hintergrund */
      var a0 = sCur > 0 ? AT[sCur - 1] : 0, a1 = sCur < AT.length ? AT[sCur] : 1;
      var cp = Math.min(1, Math.max(0, (p - a0) / Math.max(0.001, a1 - a0))).toFixed(3);   /* nur am aktiven Kapitel und Punkt: kein Stil-Neuberechnen der ganzen Szene je Frame */
      if (activeCh && !touchUI) activeCh.style.setProperty("--chapter-p", cp);   /* Touch: der Text gleitet nicht, also keine Stilrechnung je Frame */
      if (activeDot) activeDot.style.setProperty("--chapter-p", cp);
      if (ghosts.length && r.bottom < pin.offsetHeight) ghosts.forEach(function (g) { if (g.anim) g.anim.finish(); });   /* Szene loest sich: Flug sofort beenden */
    };
    /* Tab auf einen Link in einem Kapitel: zur Stelle scrollen, an der das Kapitel steht */
    story.addEventListener("focusin", function (e) {
      var c = e.target.closest && e.target.closest("[data-chapter]");
      if (!c) return;
      var k = +c.getAttribute("data-chapter"), span = runway();
      var at = k > 0 ? AT[k - 1] + HOLD * 2 : 0;
      window.scrollTo({ top: track.getBoundingClientRect().top + window.scrollY + at * span, behavior: "instant" });   /* nie sanft: sonst spielen alle Kapitel im Schnelldurchlauf */
    });
    /* Fortschrittszellen: springen ohne Animation zum Kapitel */
    story.querySelectorAll("[data-goto]").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = +b.getAttribute("data-goto");
        window.scrollTo({ top: track.getBoundingClientRect().top + window.scrollY + (AT[k - 1] + HOLD * 2) * runway(), behavior: "instant" });
      });
    });
    window.addEventListener("scroll", function () { if (!storyTick) { storyTick = true; requestAnimationFrame(pickStep); } }, { passive: true });
    /* Passt die Szene nicht in den Bildschirm, wird stufenweise verdichtet. Handy und Tablet: die Waage wird kleiner,
       das macht dort den Platz fuer das Kapitel darunter frei. Desktop: die Kapitel stehen neben der Waage, eine
       kleinere Waage hilft ihnen kaum. Dort erst der Kopf (.is-compact),
       dann die Waage bis --balance-min-desk, erst dann ohne den Zusatz in Kapitel 3 (.is-tight). Der Vorbehalt in Kapitel 4 bleibt immer */
    var fitScene = function () {
      scene.style.removeProperty("--balance-w");
      scene.classList.remove("is-air", "is-lead1", "is-compact", "is-tight");
      var remPx = parseFloat(getComputedStyle(rootS).fontSize) || 16;
      var desk = window.innerWidth >= 900;
      var min = parseFloat(cssVar(rootS, desk ? "--balance-min-desk" : "--balance-min")) * remPx || 192;
      var safe = parseFloat(cssVar(rootS, "--space-3")) * remPx || 24;
      var over = function () {
        var top = pin.getBoundingClientRect().top, bottom = 0;      /* tatsaechliche Unterkante des Inhalts, nicht die Hoehe der Szene */
        Array.prototype.forEach.call(scene.querySelectorAll(".warum__head, .warum__stage, .chapter"), function (el) {
          var bt = el.getBoundingClientRect().bottom; if (bt > bottom) bottom = bt;
        });
        return bottom - top + safe - pin.clientHeight;             /* etwas Luft zur Unterkante, z. B. fuer die iOS-Leiste */
      };
      var raw = function () { return over() - safe; };              /* echter Ueberlauf ohne Sicherheitsabstand */
      if (window.innerWidth >= 900 && window.innerWidth < 1200) scene.classList.add("is-compact");   /* mittlere Breiten: Spalten sind schmal */
      if (desk && raw() > 0) scene.classList.add("is-air");       /* Stufe 0: weniger Luft unter der Navbar und vor der Buehne */
      if (desk && raw() > 0) scene.classList.add("is-lead1");     /* erste Stufe: nur der Satz unter der H2 einzeilig */
      if (desk && raw() > 0) scene.classList.add("is-compact");   /* erst bei echtem Ueberlauf: die Hauptbreite behaelt ihre grosse H2 */
      var shrink = function (floor) {
        for (var k = 0; k < 4; k++) {                           /* auf dem Desktop werden die Kapitelspalten mit breiter, deshalb mehrmals */
          var o = over(), w0 = bal.offsetWidth;
          if (o <= 0 || w0 <= floor) break;
          scene.style.setProperty("--balance-w", Math.max(floor, w0 - o / 0.66) + "px");
          if (over() > o - 2) { scene.style.setProperty("--balance-w", w0 + "px"); break; }   /* bringt nichts (z. B. die Kreise sind hoeher): Waage bleibt gross */
        }
      };
      shrink(min);
      scene.style.setProperty("--balance-w", bal.offsetWidth + "px");   /* immer in px festschreiben: abgeleitete Groessen (Ringe, Kapitelhoehe) rechnen nie mit Prozent */
      if (desk && over() > 0) scene.classList.add("is-tight");   /* erst nach der Waage: nur der Zusatz in Kapitel 3, nie der Vorbehalt in Kapitel 4 */
      if (desk && over() > 0) shrink(parseFloat(cssVar(rootS, "--balance-min")) * remPx || 176);   /* letzte Stufe fuer sehr niedrige Fenster */
    };
    var fitTimer;
    onResize(function () { clearTimeout(fitTimer); fitTimer = setTimeout(function () { fitScene(); pickStep(); }, 120); });
    (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(fitScene);
    fitScene();
    pickStep();
  }

  /* ---------- Bilderflug: schwere Fotos fliegen seitlich herein und ruhen ohne Ueberlappung um den Satz.
     Dann werden sie an Ort und Stelle in vier Pixelstufen kleiner (komprimiert) und laufen auf Bahnen neben dem
     Satz in ein ordentliches Raster aus Dateien darunter. Keine Karte kreuzt je den Text. ---------- */
  var flight = document.querySelector("[data-flight]");
  if (flight) {
    var fcards = Array.prototype.slice.call(flight.querySelectorAll(".flight__card"));
    var clamp01 = function (v) { return Math.min(1, Math.max(0, v)); };
    var ease2 = function (q) { return q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2; };
    var ftext = flight.querySelector(".flight__say");
    var tbox = [0, 0], fpos = [], fgrid = null, FM = 20, fnarrow = false, ftop = 0, FLIGHT_STRETCH = 1.2;   /* ftop: das Bild oben auf dem Stapel. Stretch: --flight-h wuchs von 340 auf 390svh */   /* FM: Abstand zwischen Karten und zum Satz */
    /* Ruhepositionen einmal je Fenstergroesse: Startpunkte aus data-x/-y, dann auseinanderschieben, bis sich
       nichts mehr ueberlappt (Satz, andere Karten, Fensterrand). Passt es nicht, werden alle Karten etwas kleiner. */
    var fvis = fcards, files = [];
    var flayout = function () {
      var vw = window.innerWidth, vh = viewH(), narrow = vw < 700, tall = vh > vw * 1.2;   /* hoch: die Karten weichen nach oben und unten aus, dort ist Platz */
      tbox = [ftext.offsetWidth / 2, ftext.offsetHeight / 2];
      fvis = fcards.filter(function (c) { return c.offsetParent !== null; });   /* schmal: sechs statt zehn Karten, dafuer groesser */
      var base = fvis.map(function (c) {
        var ar = (c.style.getPropertyValue("--ar") || "1 / 1").split("/").map(parseFloat);
        var w = c.offsetWidth, h = w * ar[1] / ar[0], rot = parseFloat(c.dataset.r), rad = Math.abs(rot) * Math.PI / 180;
        return { w: w, h: h, rot: rot, bw: w * Math.cos(rad) + h * Math.sin(rad), bh: h * Math.cos(rad) + w * Math.sin(rad),
          x0: parseFloat(c.dataset.x) / 100 * vw * (narrow ? 1.1 : 1), y0: parseFloat(c.dataset.y) / 100 * vh * (narrow ? 1.25 : 1) };
      });
      var gut0 = parseFloat(getComputedStyle(ftext.querySelector(".flight__text")).paddingLeft) || FM, head0 = header ? header.offsetHeight : 0;
      var k = 1, best = null;
      for (var tries = 0; tries < 12; tries++) {
        var P = base.map(function (b) { return { x: b.x0, y: b.y0, hw: b.bw * k / 2 + FM / 2, hh: b.bh * k / 2 + FM / 2 }; });
        for (var it = 0; it < 80; it++) {
          P.forEach(function (a) {
            var ox = tbox[0] + a.hw - Math.abs(a.x), oy = tbox[1] + a.hh - Math.abs(a.y);
            if (ox > 0 && oy > 0) { if (!narrow && (!tall || vw / 2 - tbox[0] - gut0 > a.hw * 2) && ox < oy * 1.4) a.x += (a.x < 0 ? -1 : 1) * ox; else a.y += (a.y < 0 ? -1 : 1) * oy; }   /* schmal und hoch: nur nach oben oder unten */
          });
          for (var i = 0; i < P.length; i++) for (var m = i + 1; m < P.length; m++) {
            var A = P[i], B = P[m], px = A.hw + B.hw - Math.abs(A.x - B.x), py = A.hh + B.hh - Math.abs(A.y - B.y);
            if (px > 0 && py > 0) {
              if (px < py && (!tall || !narrow)) { var sx = (A.x < B.x ? -1 : 1) * px / 2; A.x += sx; B.x -= sx; }
              else { var sy = (A.y < B.y ? -1 : 1) * py / 2; A.y += sy; B.y -= sy; }
            }
          }
          P.forEach(function (a) {   /* seitlich bis zur Inhaltskante, oben bis unter den Kopf: kein KI-Hinweis verschwindet unter dem Glas */
            var mx = Math.max(0, vw / 2 - gut0 - a.hw - FM), myT = Math.max(0, vh / 2 - head0 - a.hh - (narrow ? FM / 2 : vh < 800 ? FM : FM * 2)), myB = Math.max(0, vh / 2 - a.hh - FM * 2);   /* unten Luft bis zur Kante */
            a.x = Math.max(-mx, Math.min(mx, a.x)); a.y = Math.max(-myT, Math.min(myB, a.y));
          });
        }
        var over = 0, area = 0;
        for (var i2 = 0; i2 < P.length; i2++) {
          area += P[i2].hw * P[i2].hh * 4;
          var tx2 = tbox[0] + P[i2].hw - Math.abs(P[i2].x), ty2 = tbox[1] + P[i2].hh - Math.abs(P[i2].y);
          if (tx2 > 0 && ty2 > 0) over += tx2 * ty2 * 4;
          for (var m2 = i2 + 1; m2 < P.length; m2++) {
            var qx = P[i2].hw + P[m2].hw - Math.abs(P[i2].x - P[m2].x), qy = P[i2].hh + P[m2].hh - Math.abs(P[i2].y - P[m2].y);
            if (qx > 0 && qy > 0) over += qx * qy;
          }
        }
        best = { P: P, k: k };
        if (over < area * (narrow ? 0.15 : vh < 800 ? 0.02 : 0.012)) break;   /* schmal duerfen sich Ecken leicht beruehren, sonst werden die Bilder zu Briefmarken */   /* kaum Ueberlappung in der Ruhelage, die Karten bleiben gross genug */
        k *= 0.9;
      }
      /* nach dem Verteilen alle Karten etwas kleiner: mehr Luft zueinander, die Plaetze bleiben */
      fpos = base.map(function (b, i) { return { w: b.w, h: b.h, ar: b.w / b.h, arTxt: null, rot: b.rot, bw: b.bw * best.k * 0.96, x: best.P[i].x, y: best.P[i].y, k: best.k * 0.96, col: 0, row: 0, rc: 1 }; });
      /* Handy (Jamie 05.10.2026: "um den Satz wie am Desktop"): die Bilder liegen als lockerer Ring um den Satz, drei
         darueber, eines rechts neben der kurzen letzten Zeile (das KI-Label bleibt ganz im Bild), zwei darunter.
         Keine Karte ueberdeckt eine andere oder den Satz. Werte: Mitte x und Breite als Anteil der Inhaltsbreite,
         Mitte y in Pixeln eines 874 px hohen Schirms ab der Bildmitte (skaliert mit der echten Hoehe) */
      var FSLOT = { bruecke: [-0.28, -275, 0.4], leuchtturm: [0.32, -262, 0.28], moor: [0.02, -165, 0.36],
        wald: [0.4, 118, 0.26], hafen: [-0.26, 175, 0.34], wasserfall: [0.16, 275, 0.32] };   /* wald liegt rechts neben dem Satz und geht spaeter in die untere Reihe: keine Karte kreuzt den Satz */
      if (narrow) {
        var CW = vw - 2 * gut0, ky = Math.min(1, vh / 874);
        fvis.forEach(function (c, i) {
          var nm = ((c.querySelector("img").getAttribute("src") || "").match(/ph-ki-foto-\d+-([a-z]+)/) || [0, ""])[1], sl = FSLOT[nm];
          if (!sl) return;
          var b = base[i], kk = sl[2] * CW * ky / b.w;   /* niedrige Fenster: alles etwas kleiner und naeher am Satz */
          fpos[i].k = kk; fpos[i].bw = b.bw * kk;
          fpos[i].x = sl[0] * CW;
          fpos[i].y = sl[1] * ky;
        });
      }
      fnarrow = narrow;
      /* Raster am Ende: so breit wie der Seiteninhalt, zwei Reihen. Im Hochformat drei Reihen mit groesseren Kacheln */
      var gut = parseFloat(getComputedStyle(ftext.querySelector(".flight__text")).paddingLeft) || FM;
      var n = fvis.length, R = !narrow && n % 3 === 0 ? 3 : 2, cols2 = Math.ceil(n / R), gap = narrow ? 8 : 12;   /* drei Reihen nur als volles Raster */
      var gw = Math.min(vw - 2 * gut, vh < 800 ? 960 : 1200), tile = Math.min((gw - (cols2 - 1) * gap) / cols2, narrow ? 120 : 240);
      /* Plaetze nach Lage vergeben: obere Karten in die oberen Reihen, linke nach links. So kreuzt keine Karte das Raster */
      var order = fpos.map(function (p, i) { return i; }).sort(function (a, b) { return fpos[a].y - fpos[b].y; });
      for (var row = 0, at = 0; row < R; row++) {
        var rc = Math.floor(n / R) + (row < n % R ? 1 : 0);
        order.slice(at, at + rc).sort(function (a, b) { return fpos[a].x - fpos[b].x; }).forEach(function (ci, col) { fpos[ci].col = col; fpos[ci].row = row; fpos[ci].rc = rc; });
        at += rc;
      }
      /* untere Karten liegen oben auf: ihr KI-Label an der Oberkante wird nie von der Karte darueber verdeckt */
      order.forEach(function (ci) { fvis[ci].parentNode.appendChild(fvis[ci]); });
      /* Reihenabstand = Kachel + zweizeiliger Dateiname + Luft, damit kein Name unter der naechsten Reihe liegt.
         Niedrige Fenster: die Kacheln werden so klein, dass Satz, Raster und Label unter dem Kopf Platz haben */
      var labelH = 34, G0 = narrow ? 24 : 40, head = header ? header.offsetHeight : 0;
      var labelBlock = 6 + 2 * gap;   /* Luft unter dem Raster */
      var avgCard = fpos.reduce(function (a, q) { return a + q.w * q.k; }, 0) / Math.max(1, fpos.length);
      tile = Math.max(96, Math.min(tile, (vh - head - 2 * tbox[1] - G0 - R * labelH - (R - 1) * (6 + 3 * gap) - labelBlock - 2 * gap) / R));   /* die Gruppe steht mittig unter dem Kopf */
      var pitch = tile + labelH + 6 + 3 * gap;   /* nach jedem Dateinamen Luft, damit er eindeutig zu seiner Kachel gehoert */
      var gridH = (R - 1) * pitch + tile + labelH, G = G0, shift = (G + gridH + labelBlock) / 2;
      shift -= head / 2;
      fgrid = { cols: cols2, gap: gap, tile: tile, pitch: pitch, top: tbox[1] - shift + G, shift: shift };
      if (narrow) {
        /* Handy: eine Reihe ueber dem Satz, eine darunter. Die Karten oben bleiben oben, keine kreuzt den Text, der Satz bleibt stehen */
        tile = Math.min(tile, (gw - (cols2 - 1) * gap) / cols2);
        fgrid.tile = tile; fgrid.shift = 0;
        fgrid.rowY = [-tbox[1] - G0 - labelH - tile / 2, tbox[1] + G0 + tile / 2];
      }
      fpos.forEach(function (q, i) { if (q.row === 0 && q.col === (narrow ? q.rc - 1 : Math.floor((q.rc - 1) / 2))) ftop = i; });   /* oben auf den Stapel: das mittlere Bild der ersten Reihe. Handy: das rechte, so liegt beim Zusammenschieben jede Karte unter ihrer rechten Nachbarin und kein KI-Label wird verdeckt */
      fpos.forEach(function (q) { q.srk = narrow ? (q.row === 0 ? q.rc - 2 - q.col : 2 + q.col + q.row * q.rc) : -1; });   /* Handy: Rang im Stapel nach Spalte, links liegt hinten */
      fgrid.stackCY = narrow ? vh * 0.16 : -vh * 0.05;   /* Handy: tief im Bild, so folgt nach seinem Abgang gleich die Fuge zu Idee */   /* Stapel auf der optischen Mitte des Bildes, bei 45 % der Hoehe */ fgrid.stackW = narrow ? Math.min(gw * 0.72, vh * 0.42) : Math.min(tile * 1.6, gw * 0.6, (gridH + labelH) * 0.9);   /* der Stapel liegt mitten im Raster, etwas groesser als eine Kachel */
      fvis.forEach(function (c, i) {
        c.dataset.side = fpos[i].x < 0 ? "l" : "r";
        fpos[i].kiEl = c.querySelector(".flight__ki");
        fpos[i].ki = fpos[i].kiEl.offsetWidth + 16;   /* so breit muss die Karte sein, damit "KI-generiert" ganz hineinpasst */
      });
      /* Dateinamen unter dem Raster, wie Preen sie schreibt */
      files.forEach(function (f) { f.remove(); }); files = [];
      fvis.forEach(function (c, i) {
        var im = c.querySelector("img");
        var name = (im.getAttribute("src").match(/ph-ki-foto-\d+-([a-z]+)\.webp/) || [0, "bild"])[1] + ".webp";
        /* echte Werte der Datei auf dieser Seite: lange Kante und Groesse. Zweite Zeile, damit nie etwas abgeschnitten wird */
        if (narrow) name = name.replace(/\.webp$/, "");   /* schmal: ohne Endung, sonst wird der Name abgeschnitten */
        if (im.dataset.kb) name += "\n600 px \u00b7 " + im.dataset.kb + " KB";   /* Kante und Gewicht zusammen: 37 KB gelten fuer 600 px, nicht fuer 1600 */
        var f = document.createElement("span");
        f.className = "flight__file"; f.setAttribute("aria-hidden", "true"); f.textContent = name;
        var tx = (fpos[i].col - (fpos[i].rc - 1) / 2) * (tile + gap), ty = (fgrid.rowY ? fgrid.rowY[fpos[i].row] + tile / 2 : fgrid.top + tile + fpos[i].row * pitch) + 6;
        f.style.transform = "translate(-50%, 0) translate(" + tx.toFixed(1) + "px, " + ty.toFixed(1) + "px)";
        f.style.maxWidth = (tile + gap) + "px";
        flight.querySelector(".flight__pin").appendChild(f); files.push(f);
      });
    };
    flayout();
    onResize(flayout);
    if ("IntersectionObserver" in window) new IntersectionObserver(function (es) { es.forEach(function (e) { flight.classList.toggle("is-live", e.isIntersecting); }); }).observe(flight);   /* Hintergrund atmet nur in Sicht */
    else flight.classList.add("is-live");
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(flayout);
    var STACK_AT = 0.7, STACK_LEN = 0.18;   /* das fertige Raster steht kurz, Stapel fertig bei 0,88: vor dem Loesen des Pins bleibt Luft */   /* nach dem Raster: alle Bilder schieben sich zu einem Stapel */
    var place = function (p0, enter) {
      if (enter === undefined) enter = 1;
      var vw = window.innerWidth;
      var p = Math.min(1, p0 * FLIGHT_STRETCH);   /* die bisherigen Phasen behalten ihre Scrollstrecke, dahinter kommt der Stapel */
      flight.classList.toggle("is-out", p > 0.3);               /* Satz wechselt zu Preens Antwort, wenn die Bilder kleiner werden */
      /* Satz und Label ruecken mit dem Scroll in die Gruppe, bevor die Karten in die Zellen einbiegen */
      var gq = fgrid ? ease2(clamp01((p - 0.56) / 0.12)) : 0;   /* der Satz rueckt erst hoch, wenn die Karten halb angekommen sind */
      if (fgrid) ftext.style.transform = gq > 0 ? "translateY(" + (-fgrid.shift * gq).toFixed(1) + "px)" : "";
      var SA = fnarrow ? 0.75 : STACK_AT, SL = fnarrow ? 0.2 : STACK_LEN;   /* Handy: das Raster steht eine Weile still (gelandet bei etwa 0,66), dann der Stapel bis 0,95 */   /* Handy: Raster steht laenger, der Stapel ist erst kurz vor dem Loesen fertig, danach keine leere Strecke */
      var spAll = ease2(clamp01((p0 - SA) / SL));
      var sayOut = fnarrow ? clamp01((p0 - SA) / 0.06) : clamp01(spAll / 0.4);   /* schmal ist der Satz weg, bevor die erste Karte ihre Zelle verlaesst */
      ftext.style.opacity = sayOut > 0 ? (1 - sayOut).toFixed(3) : "";   /* ganz weg, bevor der Stapel die Zeilen erreicht */   /* beim Stapeln tritt der Satz zurueck, der Stapel steht allein in der Mitte */
      fvis.forEach(function (card, i) {
        var C = fpos[i];
        var dir = C.x < 0 ? -1 : 1, out = dir * (vw / 2 + C.bw * 0.6);
        var lag = (C.y < 0 ? 0.15 : 0) + (fnarrow ? 0 : (i % 3) * 0.04);   /* Handy: eine Reihe blendet gemeinsam ein, keine Doppelbelichtung */
        var arrive = fnarrow ? clamp01((enter - 0.18 - lag) / 0.18) : clamp01((enter - 0.15 - lag) / 0.55), e = 1 - Math.pow(1 - arrive, 3);   /* kommt seitlich, bremst sanft. Handy: erst, wenn die Sektion gut im Bild ist */
        var x = out + (C.x - out) * e, y = C.y * (0.85 + 0.15 * e), r = C.rot * (1 + (1 - e) * 1.5), s = C.k * (1 + 0.12 * (1 - e)), ar = C.ar;
        var mid = (C.rc - 1) / 2, lagL = fnarrow ? C.row * 0.02 : Math.abs(C.col - mid) * 0.03 + C.row * 0.02;   /* schmal: eine Reihe landet zusammen, die Namen erscheinen gemeinsam */   /* gestaffelt nach Spalte und Reihe: nie zwei Karten gleichzeitig auf derselben Bahn */
        var leave = clamp01((p - 0.3 - lagL) / 0.4);               /* innere Spalten zuerst; alle Karten landen sicher, bevor der Stapel beginnt */
        if (leave > 0) {
          var qa = clamp01(leave / 0.4), qb = clamp01((leave - 0.4) / 0.6);
          var col = C.col, row = C.row;
          var tx = (col - mid) * (fgrid.tile + fgrid.gap), ty = fgrid.rowY ? fgrid.rowY[row] : fgrid.top + fgrid.tile / 2 + row * fgrid.pitch;
          var sT = fgrid.tile / C.w, ea = ease2(qa);
          s = C.k + (sT - C.k) * ea;                              /* an Ort und Stelle kleiner, gleitend */
          ar = C.ar + (1 - C.ar) * ea;                             /* und dabei zum Quadrat */
          r = C.rot * (1 - (fnarrow ? ea : Math.max(ea * 0.5, ease2(qb))));   /* Handy: gerade in die Zelle, weniger Kreuzen */
          /* Bahn neben dem Satz: erst seitlich hinaus, dann hinunter, dann in die Zelle */
          /* direkt in die Zelle, in einer leichten Kurve: waagrecht etwas frueher als senkrecht. Unter dem Satz hindurch, er liegt oben */
          /* in die Zelle in einer Kurve, die um den Satz herumfuehrt: kreuzt der gerade Weg ihn, liegt der Kontrollpunkt seitlich daneben */
          var q = ease2(qb), hwT = C.w * s / 2, sh = fgrid.shift * gq, cross = false;
          for (var k2 = 0.2; k2 < 0.85; k2 += 0.15) {
            var px2 = C.x + (tx - C.x) * k2, py2 = C.y + (ty - C.y) * k2;
            if (Math.abs(px2) < tbox[0] + hwT && Math.abs(py2 + sh) < tbox[1] + hwT) cross = true;
          }
          var p1x = (C.x + tx) / 2, p1y = (C.y + ty) / 2;
          if (cross) {
            var side = (C.x || tx) < 0 ? -1 : 1, midX = side * Math.min(tbox[0] + hwT + FM, vw / 2 - hwT - 4);   /* ganz neben dem Satz vorbei, soweit Platz ist */
            p1x = 2 * midX - (C.x + tx) / 2;   /* die Kurve erreicht in der Mitte genau midX */
          }
          x = (1 - q) * (1 - q) * C.x + 2 * (1 - q) * q * p1x + q * q * tx;
          y = (1 - q) * (1 - q) * C.y + 2 * (1 - q) * q * p1y + q * q * ty;
        }
        card.style.transform = "translate(-50%, -50%) translate(" + x.toFixed(1) + "px, " + y.toFixed(1) + "px) rotate(" + r.toFixed(2) + "deg) scale(" + s.toFixed(3) + ")";
        /* schmal ist neben dem Satz kein Platz: dort tauchen die kleinen Karten kurz unter dem Text weg und unten wieder auf */
        var kiL = x - C.w * s / 2 + vw / 2, kiIn = fnarrow && e < 1 ? Math.min(clamp01((kiL - 4) / 32), clamp01((vw - 4 - kiL - (C.ki || 0)) / 32)) : 1;   /* Handy: sichtbar erst, wenn das KI-Label oben links ganz im Bild ist */
        card.style.opacity = kiIn < 1 ? kiIn.toFixed(3) : "";   /* breit: der Satz liegt ueber den Karten, wer darunter durchgleitet, blinkt nicht */
        var arTxt = ar === C.ar ? "" : ar.toFixed(3);
        if (C.arTxt !== arTxt) { card.style.aspectRatio = arTxt; C.arTxt = arTxt; }   /* nur bei Aenderung; contain: layout haelt das Layout in der Karte */
        card.classList.toggle("is-small", leave > 0.4);
        var landed = leave >= 1;
        /* Stapel: aus der Zelle in die Mitte, jedes Bild leicht verdreht, das oberste gerade */
        var spq = clamp01((p0 - SA - (i % 5) * 0.006) / SL), sp = fnarrow ? spq * spq * (3 - 2 * spq) : 1 - (1 - spq) * (1 - spq);   /* ease-out: die Bilder kommen langsam im Stapel an */
        if (sp > 0 && fgrid) {
          var top = i === ftop, jig = top ? 0 : 1;
          var sx = jig * (((i * 53) % 7) - 3) * 4, sy = fgrid.stackCY + jig * (((i * 29) % 5) - 2) * 4, sr = jig * (((i * 37) % 11) - 5) * 1.4;
          var srk = fnarrow ? C.srk : i < ftop ? i : i - 1;
          if (fnarrow) { if (top) { sx = 16; sy = fgrid.stackCY + 44; } else if (srk < 2) { sx = srk ? -16 : 0; sy = fgrid.stackCY - (srk ? 44 : 0); sr = srk ? -4 : -2; } }   /* Handy: drei Abzuege symmetrisch um die Mitte, 44 px Stufe und nach links gedreht: die hinteren lugen oben links hervor, ihr KI-Label bleibt ganz frei */   /* Handy: zwei Abzuege lugen oben links hervor, ihr KI-Label bleibt frei */
          var spY = fnarrow ? 1 - Math.pow(1 - clamp01(spq / 0.6), 2) : sp;   /* Handy: erst die Hoehe, dann seitlich: die Labels der hinteren Abzuege stehen frei, bevor sich eine Karte darueber schiebt */
          x += (sx - x) * (fnarrow && top ? spY : sp); y += (sy - y) * spY; r += (sr - r) * sp; s += (fgrid.stackW / C.w - s) * spY;   /* Handy: Wachsen und Absinken gemeinsam, die Gruppe laeuft um die Mitte zusammen */
          if (fnarrow) x = Math.max(-vw / 2 + 16 + C.w * s / 2, Math.min(vw / 2 - 16 - C.w * s / 2, x));   /* Handy: keine Karte ragt beim Zusammenschieben ueber den Rand */ ar += (1 - ar) * sp;
          card.style.opacity = "";
          var arS = ar === C.ar ? "" : ar.toFixed(3);
          if (C.arTxt !== arS) { card.style.aspectRatio = arS; C.arTxt = arS; }
        }
        var srk2 = fnarrow ? C.srk : i < ftop ? i : i - 1;
        card.style.zIndex = sp > 0 ? (i === ftop ? "10" : fnarrow ? String(srk2 < 2 ? 9 - srk2 : 2 + C.col) : "") : "";   /* Handy: rechts liegt immer oben, so deckt keine Karte das Label ihrer rechten Nachbarin */
        if (files[i]) files[i].classList.toggle("is-in", landed && (fnarrow ? spAll === 0 : sp === 0));   /* Handy: alle Namen gehen gemeinsam */   /* die Namen gehen, sobald sich die Bilder stapeln */
        if (sp > 0) {
          card.style.transform = "translate(-50%, -50%) translate(" + x.toFixed(1) + "px, " + y.toFixed(1) + "px) rotate(" + r.toFixed(2) + "deg) scale(" + s.toFixed(3) + ")";
        }
        var fit = Math.min(1, (C.w * s - 12) / (C.ki - 16));   /* "KI-generiert" bleibt immer ganz in der Karte: zu kleine Karten verkleinern den Hinweis ein wenig */
        var kiT = "scale(" + (fit / s).toFixed(3) + ")";
        if (C.kiT !== kiT) { C.kiEl.style.transform = kiT; C.kiT = kiT; }   /* sonst bleibt das Label gleich gross, egal wie klein die Karte ist. Direkt am Element */
        var rank = fnarrow ? C.srk : i < ftop ? i : i - 1, thr = fnarrow ? (rank < 2 ? 2 : 0.12) : 0.35 + rank * 0.06;   /* breit bis kurz vor dem fertigen Stapel: man sieht, wie aus zehn eins wird */
        card.classList.toggle("is-under", i !== ftop && sp > thr);   /* einzeln, bevor sich die Karten ueber die Labels schieben; schmal bleibt neben dem obersten hoechstens eins */
      });
    };
    if (reduce) {
      /* ruhig: das fertige Raster mit Antwortsatz und Dateigroessen, bevor der Stapel beginnt (p 0,839, jede Karte gelandet) */
      var FREST = STACK_AT - 0.001;
      place(FREST, 1);
      onResize(function () { place(FREST, 1); });
    } else {
      /* Weich nachgefuehrt: der Flug folgt dem Scroll mit kurzer Traegheit (rund 120 ms), damit Mausrad-Klicks
         gleiten statt springen. Retargetet in jedem Frame, also jederzeit umkehrbar */
      var ticking = false, cur = null, tgt = [0, 0], glide = 0, lastT = 0;
      var follow = function (now) {
        glide = 0;
        var k = 1 - Math.exp(-Math.min(64, lastT ? now - lastT : 16) / 120);
        lastT = now;
        cur[0] += (tgt[0] - cur[0]) * k; cur[1] += (tgt[1] - cur[1]) * k;
        if (Math.abs(tgt[0] - cur[0]) < 0.0004 && Math.abs(tgt[1] - cur[1]) < 0.0004) { cur = tgt.slice(); lastT = 0; }
        else glide = requestAnimationFrame(follow);
        place(cur[0], cur[1]);
      };
      var update = function (snap) {
        ticking = false;
        var rect = flight.getBoundingClientRect(), vh = viewH();
        var span = rect.height - vh;
        tgt = [clamp01(-rect.top / (span > 0 ? span : 1)), clamp01((vh - rect.top) / vh)];
        if (document.documentElement.classList.contains("handoff-on") && -rect.top > span - (parseFloat(getComputedStyle(flight).paddingBottom) || 0)) snap = true;   /* Pin geloest: keine Nachfuehrung mehr, der Stapel steht, die Uebergabe uebernimmt */
        if (touchUI) snap = true;                                 /* Touch scrollt schon weich: Nachfuehrung wuerde nur hinterherschwimmen */
        if (snap === true || !cur) { cancelAnimationFrame(glide); glide = 0; lastT = 0; cur = tgt.slice(); place(cur[0], cur[1]); }
        else if (!glide) glide = requestAnimationFrame(follow);
      };
      var onScroll = function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
      /* Nur in Sichtweite rechnen */
      if ("IntersectionObserver" in window) {
        var flightOn = false;
        new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting && !flightOn) { flightOn = true; window.addEventListener("scroll", onScroll, { passive: true }); update(true); }   /* beim Eintreten auf den aktuellen Stand, kein Nachgleiten von alten Werten */
            else if (!e.isIntersecting && flightOn) { flightOn = false; window.removeEventListener("scroll", onScroll); }
          });
        }, { rootMargin: "100% 0px" }).observe(flight);
      } else {
        window.addEventListener("scroll", onScroll, { passive: true });
      }
      onResize(function () { update(true); });
      update(true);

      /* Uebergabe an Idee: loest sich die Szene, fliegt das oberste Bild des Stapels als Kopie nach rechts und waechst
         zur Buehne. Am Ziel blendet das Foto in den Verlauf der Buehne, dann erscheinen die App-Fenster. Alles am Scroll,
         umkehrbar, mit derselben Nachfuehrung (120 ms) wie der Flug, damit grobe Mausraeder nicht springen */
      var hoStage = document.querySelector(".idee .stage"), idee = document.getElementById("idee");   /* eigener Name: "stage" gehoert dem Hero, alle Bloecke teilen einen Scope */
      if (hoStage && idee) {
        var hoPin = flight.querySelector(".flight__pin"), cardsBox = flight.querySelector(".flight__cards");
        var ghost = document.createElement("div"), gImg = document.createElement("img"), gKi = document.createElement("span");
        ghost.className = "flight__ghost"; ghost.setAttribute("aria-hidden", "true");
        gImg.alt = ""; gKi.className = "flight__ki"; gKi.textContent = "KI\u2011generiert";
        ghost.appendChild(gImg); ghost.appendChild(gKi); document.body.appendChild(ghost);
        var hc = 0, hT = 0, hGlide = 0, hLastT = 0, born = false, settled = false, settleT = 0, unbornAt = -1e9;
        var H_END = 0.9, LEAVE_MS = parseFloat(cssVar(document.documentElement, "--dur-exit")) || 180;
        /* Ziel der Uebergabe aus dem Scroll: 0 = Szene loest sich gerade, 1 = Buehne steht dort, wo auch der Anker #idee landet */
        var hoPad = 0, hoSpt = 0, hoMeasure = function () { hoPad = parseFloat(getComputedStyle(flight).paddingBottom) || 0; hoSpt = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0; };
        hoMeasure();
        var target = function () {
          var vh = viewH(), fr = flight.getBoundingClientRect(), sr = hoStage.getBoundingClientRect(), ir = idee.getBoundingClientRect();
          var pad = hoPad;
          var past = -fr.top - Math.max(1, fr.height - pad - vh);   /* Pixel seit der Pin sich loest, ohne das Polster der Fuge */
          var land = hoSpt + (sr.top - ir.top);
          var dist = sr.top + past - Math.max(land, header ? header.offsetHeight + 16 : 16);
          return { h: dist > 1 ? clamp01(past / dist) : (past > 0 ? 1 : 0), past: past, vh: vh, sr: sr, beside: sr.left > window.innerWidth * 0.35 };
        };
        var render = function (t) {
          var root = document.documentElement;
          root.classList.toggle("handoff-on", t.beside);
          var h = t.beside ? hc : 0;
          /* Die Kopie ist bei H_END fertig (Ort, Groesse, ohne Foto): ab dort ist sie pixelgleich mit der Buehne, der Wechsel ist unsichtbar.
             Zurueck erst darunter mit kleiner Hysterese. Die Fenster blenden dann sichtbar aus, erst danach zeigt sich wieder die Kopie */
          var wasBorn = born, leaving = !born && performance.now() - unbornAt < LEAVE_MS;
          if (leaving && t.h >= H_END) { leaving = false; unbornAt = -1e9; }   /* wieder vorwaerts: Abgang abbrechen */
          if (!leaving) { if (h >= H_END) born = true; else if (h < H_END - 0.03) born = false; }
          if (wasBorn && !born) { unbornAt = performance.now(); leaving = true; setTimeout(function () { if (!hGlide) hGlide = requestAnimationFrame(hoFollow); }, LEAVE_MS); }
          hoStage.classList.toggle("is-born", born || !t.beside);
          flight.classList.toggle("is-handoff", h > 0);
          var away = t.beside ? clamp01(h / 0.12) : fnarrow && fgrid ? clamp01((t.past - (t.vh / 2 + fgrid.stackCY - fgrid.stackW / 2 - 60 - (header ? header.offsetHeight : 0))) / (t.vh * 0.06)) : clamp01(t.past / (t.vh * 0.25));   /* mittel ohne Flug: der Stapel geht, bevor er unter den Kopf rutscht. Handy: er scrollt voll sichtbar mit und geht erst kurz, wenn die oberen KI-Labels (72 px ueber dem Stapel) die Navbar erreichen */
          if (cardsBox) cardsBox.style.opacity = away > 0 ? (1 - away).toFixed(3) : "";   /* der Stapel geht als Ganzes, ohne Durchsicht zwischen den Fotos */
          fvis.forEach(function (c, i) { c.classList.toggle("is-top", i === ftop); });
          var C = fpos[ftop], top = fvis[ftop];
          if (h <= 0 || born || leaving || !top || !fgrid || !C) { ghost.style.visibility = "hidden"; return; }
          /* Quelle: die Ruhelage des Stapels im Pin, nicht die gleitende Karte */
          var pr = hoPin.getBoundingClientRect(), sw = fgrid.stackW;
          var tx0 = pr.left + pr.width / 2, ty0 = pr.top + pr.height / 2 + fgrid.stackCY, sr = t.sr;
          /* waagrecht und Groesse mit Ease, senkrecht linear: die Kopie schwimmt nicht gegen den Scroll */
          var hn = clamp01(h / H_END), ex = 1 - Math.pow(1 - hn, 3), g = ease2(clamp01((hn - 0.25) / 0.75));
          var gw2 = sw + (sr.width - sw) * g, gh2 = sw + (sr.height - sw) * g;
          var cx = tx0 + (sr.left + sr.width / 2 - tx0) * ex, cy = ty0 + (sr.top + sr.height / 2 - ty0) * hn;
          var src = top.querySelector("img").getAttribute("src");
          if (gImg.getAttribute("src") !== src) gImg.src = src;
          ghost.style.visibility = "visible";
          ghost.style.width = gw2.toFixed(1) + "px"; ghost.style.height = gh2.toFixed(1) + "px";
          ghost.style.transform = "translate(" + (cx - gw2 / 2).toFixed(1) + "px, " + (cy - gh2 / 2).toFixed(1) + "px)";   /* Lage per transform, nur die Groesse ist Layout (fixe Ebene, contain) */
          var fitK = Math.min(1, (sw - 12) / (C.ki - 16));
          gKi.style.transform = "scale(" + fitK.toFixed(3) + ")";   /* so gross wie das Label auf der Karte */
          ghost.classList.toggle("is-fading", hn > 0.7);   /* kurz vor dem Ziel geht das Foto zeitbasiert (250 ms) in den Buehnenverlauf, kein eingefrorener Schleier */
        };
        var hoFollow = function (now) {
          hGlide = 0;
          var t = target(); hT = settled && t.h > 0.75 && t.h < H_END ? H_END : t.h;   /* ruht der Scroll kurz vor dem Ziel, gleitet die Kopie hinein */
          if (!born && performance.now() - unbornAt < LEAVE_MS) hT = Math.max(hT, H_END);   /* Abgang: die Kopie wartet in Buehnenlage, bis die Fenster weg sind, dann gleitet sie zum Scroll */
          var k = 1 - Math.exp(-Math.min(64, hLastT ? now - hLastT : 16) / 120);
          var sinceLeave = now - (unbornAt + LEAVE_MS);
          if (sinceLeave >= 0 && sinceLeave < 120) k *= Math.max(0.15, sinceLeave / 120);   /* nach dem Abgang laeuft die Kopie weich an, kein Ruck */
          hLastT = now;
          hc += (hT - hc) * k;
          if (Math.abs(hT - hc) < 0.001) { hc = hT; hLastT = 0; } else hGlide = requestAnimationFrame(hoFollow);
          render(t);
        };
        var onHo = function () {
          settled = false; clearTimeout(settleT);
          settleT = setTimeout(function () { settled = true; if (!hGlide) hGlide = requestAnimationFrame(hoFollow); }, 160);   /* Scroll ruht: knapp vor dem Ziel gleitet die Kopie hinein */
          if (!hGlide) hGlide = requestAnimationFrame(hoFollow);
        };
        var hoOn = false;
        var hoIO = new IntersectionObserver(function () {
          var fr = flight.getBoundingClientRect(), ir = idee.getBoundingClientRect(), vh = viewH();
          var near = fr.bottom > -vh && ir.top < vh * 2;
          if (near && !hoOn) { hoOn = true; window.addEventListener("scroll", onHo, { passive: true }); onHo(); }
          else if (!near && hoOn) { hoOn = false; window.removeEventListener("scroll", onHo); }
        }, { rootMargin: "100% 0px" });
        hoIO.observe(flight); hoIO.observe(idee);
        onResize(function () { hoMeasure(); hc = target().h; render(target()); });
        hc = target().h; render(target());
      }
    }
  }

  /* ---------- Fragen: eine Karte traegt die offene Frage und gleitet beim Wechsel zur neuen, die Hoehen gleichen sich
     in derselben Bewegung an. Die Seite scrollt dabei nie mit (Jamie). Im Hintergrund blobben Pixel von selbst auf (field.js),
     der Klick selbst bleibt ruhig. Alles wird vor dem Start gemessen, pro Frame wird nur geschrieben ---------- */
  var faq = document.querySelector("[data-faq]");
  if (faq) {
    var fqItems = Array.prototype.slice.call(faq.querySelectorAll(".faq__item"));
    var fqPlate = faq.querySelector(".faq__plate");
    var fqOpen = null, fqRaf = 0, fqBusy = false, fqY = 0, fqH = 0, fqA = 0;
    var fqDur = reduce ? 0 : parseFloat(cssVar(document.documentElement, "--dur-faq")) || 420;
    var fqBez = function (x1, y1, x2, y2) {   /* cubic-bezier wie in CSS */
      return function (x) {
        var t = x;
        for (var n = 0; n < 8; n++) {
          var cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
          var fx = ((ax * t + bx) * t + cx) * t - x, d = (3 * ax * t + 2 * bx) * t + cx;
          if (Math.abs(fx) < 1e-4 || !d) break;
          t = Math.max(0, Math.min(1, t - fx / d));
        }
        var cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
        return ((ay * t + by) * t + cy) * t;
      };
    };
    var fqIO = fqBez(0.77, 0, 0.175, 1), fqOut = fqBez(0.23, 1, 0.32, 1);   /* --ease-faq fuer Karte und Oeffnen, --ease-out fuer das Schliessen: kein leerer Kasten */
    var fqPut = function (y, h, op) {
      fqY = y; fqH = h; fqA = op;
      fqPlate.style.transform = "translateY(" + y + "px)"; fqPlate.style.height = h + "px"; fqPlate.style.opacity = String(op);
    };
    var fqPlace = function () { if (!fqBusy) fqPut(fqOpen ? fqOpen.offsetTop : fqY, fqOpen ? fqOpen.offsetHeight : fqH, fqOpen ? 1 : 0); };
    var fqAria = function () { fqItems.forEach(function (d) { d.querySelector("summary").setAttribute("aria-expanded", String(d === fqOpen)); }); };

    fqItems.forEach(function (d) {
      d.removeAttribute("name");   /* das Schliessen der anderen uebernimmt die Karte, sonst schliesst der Browser sofort */
      if (d.open) { if (fqOpen) d.open = false; else { fqOpen = d; d.classList.add("is-on"); } }
      d.querySelector("summary").addEventListener("click", function (ev) { ev.preventDefault(); fqToggle(d); });
      /* geoeffnet ohne Klick (Suche im Browser, Link): Karte nachziehen */
      d.addEventListener("toggle", function () {
        if (!d.open || d === fqOpen || fqBusy) return;
        if (fqOpen) { fqOpen.classList.remove("is-on"); fqOpen.open = false; }
        fqOpen = d; d.classList.add("is-on"); fqAria(); fqPlace();
      });
    });
    faq.classList.add("is-ready");
    fqAria(); fqPlace();
    if (window.ResizeObserver) new ResizeObserver(fqPlace).observe(faq); else onResize(fqPlace);

    var fqToggle = function (T) {
      cancelAnimationFrame(fqRaf);   /* laeuft noch eine Bewegung: aus dem Ist-Zustand weiter, kein Sprung */
      var hot = fqBusy, fresh = fqA < 0.01;   /* hot: Unterbrechung, sofort mit Tempo; fresh: nichts offen, die Karte erscheint */
      var to = T === fqOpen ? null : T, from = fqOpen, anchor = T.querySelector("summary");
      var idxT = fqItems.indexOf(T), idxTo = to ? fqItems.indexOf(to) : -1;
      if (to && !to.open) { to.open = true; to.querySelector(".faq__answer").style.height = "0px"; }
      var parts = [];
      fqItems.forEach(function (d, i) {
        if (!d.open) return;
        var an = d.querySelector(".faq__answer"), cur = an.offsetHeight, nat = 0;
        if (d === to) { var keep = an.style.height; an.style.height = "auto"; nat = an.offsetHeight; an.style.height = keep; }
        parts.push({ d: d, i: i, an: an, h0: cur, h1: nat, ease: d === to && !hot && !fresh ? fqIO : fqOut });   /* Erscheinen und Retarget mit ease-out: der Klick wirkt sofort */
      });
      parts.forEach(function (q) { q.an.style.overflow = "hidden"; q.an.style.height = q.h0 + "px"; });
      var toTop0 = to ? to.offsetTop : 0;
      var sumH = (to || from) ? (to || from).querySelector("summary").offsetHeight : 0, fromTop0 = from ? from.offsetTop : 0;
      if (from) from.classList.remove("is-on");
      if (to) to.classList.add("is-on");
      fqOpen = to; fqAria(); fqBusy = true;
      var py = fqY, ph = fqH, pa = fqA;
      if (pa < 0.01 && to) { py = toTop0; ph = sumH; }   /* aus dem Nichts: die Karte waechst aus der Frage */
      var shift = function (p, upto) {   /* wie weit sich alles unterhalb der Antworten 0..upto-1 verschoben hat */
        var s = 0;
        parts.forEach(function (q) { if (q.i < upto) s += (q.h0 + (q.h1 - q.h0) * q.ease(p)) - q.h0; });
        return s;
      };
      var lastY = py, lastB = py + ph, t0 = performance.now();
      var frame = function (p) {
        parts.forEach(function (q) { q.an.style.height = (q.h0 + (q.h1 - q.h0) * q.ease(p)) + "px"; });
        var e = (fresh || !to || hot) ? fqOut(p) : fqIO(p), ty, th, ta;   /* Schliessen: Karte und Antwort auf derselben Kurve, kein leerer Kasten */
        if (to) {
          var hn = 0; parts.forEach(function (q) { if (q.d === to) hn = q.h0 + (q.h1 - q.h0) * q.ease(p); });
          ty = toTop0 + shift(p, idxTo); th = sumH + hn; ta = pa + (1 - pa) * e;
        } else { ty = fromTop0 + shift(p, fqItems.indexOf(from)); th = sumH; ta = pa * (1 - e); }
        /* die Kante in Fahrtrichtung eilt voraus, die hintere zieht nach: die Karte streckt sich und folgt */
        var eLead = fqOut(p), eTrail = hot ? fqOut(p) : fqIO(Math.max(0, (p - 0.08) / 0.92)), down = ty > py;
        var top = py + (ty - py) * (down ? eTrail : eLead), bot = (py + ph) + (ty + th - py - ph) * (down ? eLead : eTrail);
        if (pa < 0.01 || !to) { top = py + (ty - py) * e; bot = top + ph + (th - ph) * e; }
        else {   /* bei weiten Spruengen dehnt sie sich hoechstens um eine Zeile, nie ueber alle Fragen */
          var cap = Math.max(th, ph) + sumH;
          if (bot - top > cap) { if (down) top = bot - cap; else bot = top + cap; }
        }
        fqPut(top, Math.max(0, bot - top), ta);
        lastY = top; lastB = bot;
      };
      var done = function () {
        frame(1); fqBusy = false;
        parts.forEach(function (q) { q.an.style.height = ""; q.an.style.overflow = ""; if (!q.h1) q.d.open = false; });
          fqPlace();
      };
      if (!fqDur) { done(); return; }
      var step = function (now) {
        var p = Math.min(1, (now - t0) / fqDur);
        if (p >= 1) { done(); return; }
        frame(p); fqRaf = requestAnimationFrame(step);
      };
      fqRaf = requestAnimationFrame(step);
    };
  }

  /* ---------- Beispiel: das ganze Foto, Original gegen Preen. Ziehen ueberall im Bild, am Handy erst bei waagrechter Bewegung ---------- */
  var compare = document.querySelector("[data-compare]");
  if (compare) {
    var range = compare.querySelector("input[type=range]");
    var tagL = compare.querySelector(".compare__tag--l"), tagR = compare.querySelector(".compare__tag--r");
    var line = compare.querySelector(".compare__line"), before = compare.querySelector(".compare__before");
    var root = document.documentElement;
    var remPx = function (name, fb) { var v = cssVar(root, name); return v.indexOf("rem") > 0 ? parseFloat(v) * (parseFloat(getComputedStyle(root).fontSize) || 16) : (parseFloat(v) || fb); };
    var PAD = remPx("--compare-tag-gap", 12), SLOP = remPx("--drag-slop", 6);
    var cw = compare.clientWidth, edgeL = 0, edgeR = 0, hideL = null, hideR = null;
    /* Nur transform und clip-path direkt an den Elementen; die Kanten der Etiketten werden nur beim Resize gemessen */
    var setPos = function () {
      var v = +range.value, lx = cw * v / 100;
      line.style.transform = "translateX(" + lx.toFixed(1) + "px)";
      before.style.clipPath = "inset(0 " + (100 - v) + "% 0 0)";
      range.setAttribute("aria-valuetext", Math.round(v) + " % Original, " + Math.round(100 - v) + " % Preen");
      /* Etikett ausblenden, wenn die Trennlinie es erreicht: nie ein halbes Wort */
      var hl = lx < edgeL + PAD, hr = lx > edgeR - PAD;
      if (hl !== hideL) { compare.classList.toggle("hide-l", hl); hideL = hl; }
      if (hr !== hideR) { compare.classList.toggle("hide-r", hr); hideR = hr; }
    };
    var remeasure = function () {
      cw = compare.clientWidth;
      edgeL = tagL ? tagL.offsetLeft + tagL.offsetWidth : 0;
      edgeR = tagR ? tagR.offsetLeft : cw;
      setPos();
    };
    var touched = false;
    range.addEventListener("input", function () { touched = true; setPos(); });
    remeasure();
    if (window.ResizeObserver) new ResizeObserver(remeasure).observe(compare); else onResize(remeasure);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(remeasure);
    /* Pfeiltasten in 5er-Schritten, mit Umschalt in 1er-Schritten */
    range.addEventListener("keydown", function (ev) {
      var d = ev.key === "ArrowLeft" || ev.key === "ArrowDown" ? -1 : ev.key === "ArrowRight" || ev.key === "ArrowUp" ? 1 : 0;
      touched = true;
      if (!d) return;
      ev.preventDefault();
      range.value = Math.max(0, Math.min(100, +range.value + d * (ev.shiftKey ? 1 : 5)));
      setPos();
    });
    var dragging = false, pending = null;
    var toPointer = function (ev) {
      var r = compare.getBoundingClientRect(), w = compare.offsetWidth, left = r.left + (r.width - w) / 2;   /* Masse ohne Kippen */
      range.value = Math.max(0, Math.min(100, (ev.clientX - left) / w * 100)).toFixed(1);
      setPos();
    };
    var startDrag = function (ev) {
      dragging = touched = true;
      try { range.focus({ preventScroll: true }); } catch (e) {}   /* danach wirken die Pfeiltasten gleich */
      compare.classList.add("is-drag");
      try { compare.setPointerCapture(ev.pointerId); } catch (e) {}
      toPointer(ev);
    };
    compare.addEventListener("pointerdown", function (ev) {
      if (ev.button > 0) return;
      /* Finger: erst abwarten, ob gescrollt oder waagrecht gezogen wird. Maus und Stift ziehen sofort */
      if (ev.pointerType === "touch") { pending = { id: ev.pointerId, x: ev.clientX, y: ev.clientY }; return; }
      ev.preventDefault();   /* Maus: kein Bild-Ziehen, keine Textauswahl */
      startDrag(ev);
    });
    compare.addEventListener("pointermove", function (ev) {
      if (dragging) { toPointer(ev); return; }
      if (!pending || ev.pointerId !== pending.id) return;
      var dx = Math.abs(ev.clientX - pending.x), dy = Math.abs(ev.clientY - pending.y);
      if (dx > SLOP && dx > dy) { pending = null; startDrag(ev); }
      else if (dy > SLOP) pending = null;   /* senkrecht: die Seite scrollt, der Vergleich bleibt */
    });
    var endDrag = function (ev) {
      if (pending && ev && ev.type === "pointerup" && ev.pointerId === pending.id) { touched = true; toPointer(ev); try { range.focus({ preventScroll: true }); } catch (e) {} }   /* Tippen ohne Bewegung: dorthin springen */
      pending = null; dragging = false; compare.classList.remove("is-drag");
    };
    compare.addEventListener("pointerup", endDrag);
    compare.addEventListener("pointercancel", function () { pending = null; dragging = false; compare.classList.remove("is-drag"); });
    /* Nach dem Auftritt zieht der Schieber einmal ueber das Bild, mit Halt an beiden Seiten. Die Endpunkte liegen
       kurz vor den Etiketten, damit jede Seite mit Namen zu sehen ist. Jede Beruehrung oder Taste beendet das sofort */
    /* Aufrichten am Scroll: --tilt 1 solange das Bild unten am Rand steht, 0 sobald seine Mitte bei 55 % der Hoehe ist. Weich nachgefuehrt */
    if (!reduce && !touchUI) {   /* Touch: kein Kippen, also auch kein Scroll-Listener und keine 3D-Ebene unter den Glas-Etiketten */
      document.documentElement.classList.add("tilt-on");
      var tCur = 1, tTgt = 1, tRaf = 0, tLast = 0;
      var shade = compare.parentNode.querySelector(".compare__shade");
      var shadeSize = function () { if (shade) { shade.style.width = compare.offsetWidth + "px"; shade.style.marginLeft = (-compare.offsetWidth / 2) + "px"; } };
      shadeSize();
      if (window.ResizeObserver) new ResizeObserver(shadeSize).observe(compare); else onResize(shadeSize);
      var T_DEG = parseFloat(cssVar(root, "--compare-tilt")) || 28, T_SC = parseFloat(cssVar(root, "--compare-tilt-scale")) || 0.14;
      var T_PERSP = remPx("--compare-persp", 1120), T_DROP = remPx("--space-6", 64);
      /* transform direkt am Element, keine vererbte Variable: der Teilbaum wird nicht neu berechnet */
      var tApply = function (k) {
        var tf = "perspective(" + T_PERSP.toFixed(0) + "px) translateY(" + (k * T_DROP).toFixed(1) + "px) rotateX(" + (k * T_DEG).toFixed(2) + "deg) scale(" + (1 - k * T_SC).toFixed(4) + ")";
        compare.style.transform = tf;
        if (shade) { shade.style.transform = tf; shade.style.opacity = (1 - k).toFixed(3); }
      };
      var tTarget = function () {
        if (touchUI) return 0;   /* Touch: das Bild steht flach, kein Kippen am Finger */
        var fr = compare.parentNode.getBoundingClientRect(), vh = viewH();   /* die Figur kippt nicht: ungekippte Masse, keine Rueckkopplung */
        var top = fr.top + compare.offsetTop, h = compare.offsetHeight;
        var q = Math.min(((top + h / 2) - vh * 0.65) / (vh * 0.4), ((top + h) - (vh - T_DROP / 2)) / (vh * 0.4));   /* flach, wenn die Mitte bei 65 % steht oder das Bild ganz zu sehen ist */   /* flach, sobald das Bild ganz im Bild ist: Aufrichten beim Hereinkommen, kein Zustand beim Lesen */
        return Math.max(0, Math.min(1, q));
      };
      var tStep = function (now) {
        tRaf = 0;
        var k = touchUI ? 1 : 1 - Math.exp(-Math.min(64, tLast ? now - tLast : 16) / 120);   /* Touch: kein Nachgleiten, der Finger scrollt schon weich */
        tLast = now;
        tCur += (tTgt - tCur) * k;
        if (Math.abs(tTgt - tCur) < 0.002) { tCur = tTgt; tLast = 0; } else tRaf = requestAnimationFrame(tStep);
        tApply(1 - Math.pow(1 - tCur, 2));
      };
      var tOnScroll = function () { tTgt = tTarget(); if (!tRaf) tRaf = requestAnimationFrame(tStep); };
      var tOn = false;
      new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (e.isIntersecting && !tOn) { tOn = true; window.addEventListener("scroll", tOnScroll, { passive: true }); tOnScroll(); }
          else if (!e.isIntersecting && tOn) { tOn = false; window.removeEventListener("scroll", tOnScroll); }
        });
      }, { rootMargin: "20% 0px" }).observe(compare);
      tCur = tTgt = tTarget(); tApply(1 - Math.pow(1 - tCur, 2));
    }
    if (!reduce && "IntersectionObserver" in window) {
      var IN_MS = parseFloat(cssVar(root, "--dur-compare-in")) || 900;
      var MOVE = parseFloat(cssVar(root, "--dur-sweep-move")) || 700, HOLDS = parseFloat(cssVar(root, "--dur-sweep-hold")) || 280;
      var sweepEase = function (q) { return q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2; };
      var cmpSeen = 0, sweepDone = false;
      var runSweep = function () {
        if (touched || sweepDone || cmpSeen < 0.35) return;
        if (typeof tCur === "number" && tCur > 0.08) { setTimeout(runSweep, 200); return; }   /* erst wenn das Bild flach steht */
        sweepDone = true;
        var lo = Math.min(45, (edgeL + PAD * 2) / cw * 100), hi = Math.max(55, (edgeR - PAD * 2) / cw * 100);
        var keys = [[0, 50], [MOVE, lo], [MOVE + HOLDS, lo], [MOVE * 2.6 + HOLDS, hi], [MOVE * 2.6 + HOLDS * 2, hi], [MOVE * 3.6 + HOLDS * 2, 50]];
        var t0 = performance.now();
        var step = function (now) {
          if (touched) return;
          var t = now - t0, v = 50;
          for (var i = 1; i < keys.length; i++) {
            if (t <= keys[i][0]) { var k0 = keys[i - 1], k1 = keys[i]; v = k0[1] + (k1[1] - k0[1]) * sweepEase((t - k0[0]) / (k1[0] - k0[0])); break; }
            v = keys[i][1];
          }
          range.value = v.toFixed(1); setPos();
          if (t < keys[keys.length - 1][0]) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      };
      /* Auftritt erst, wenn das Bild gut im Bild ist und beide Dateien dekodiert sind: nie ein grauer Kasten */
      var imgs = Array.prototype.slice.call(compare.querySelectorAll("img"));
      var ready = Promise.all(imgs.map(function (im) { return im.decode ? im.decode().catch(function () {}) : Promise.resolve(); }));
      var inObs = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          cmpSeen = e.intersectionRatio;
          if (e.isIntersecting && !compare.classList.contains("is-in")) {
            ready.then(function () { compare.classList.add("is-in"); setTimeout(runSweep, IN_MS * 0.8); });
          } else if (e.isIntersecting && compare.classList.contains("is-in")) runSweep();   /* schnell vorbei: beim naechsten Eintritt nachholen */
        });
      }, { threshold: [0, 0.35, 0.5], rootMargin: "0px 0px -20% 0px" });
      inObs.observe(compare);
    }
  }

  /* Nach dem Download: zum Ersten Start, sonst steht man vor der Sperre von macOS ohne Erklaerung (BRIEF, interne Links) */
  var firstStart = document.getElementById("erster-start");
  if (!firstStart) {
    /* Rechtsseiten: nach dem Download zur Startseite, Abschnitt Erster Start */
    document.querySelectorAll('a[href$="Preen.dmg"]').forEach(function (a) {
      a.addEventListener("click", function (ev) {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button > 0) return;
        setTimeout(function () { location.href = "../#erster-start"; }, 350);
      });
    });
  } else if (location.hash === "#erster-start") {
    firstStart.classList.add("is-flash");
    setTimeout(function () { firstStart.classList.remove("is-flash"); }, 1800);
  }
  /* Download: Hintergrund und Install-Moment laufen nur, solange sie zu sehen sind. Der Moment spielt drei Runden,
     erneut bei Hover und nach dem Klick auf Laden */
  var dlSec = document.getElementById("download"), install = document.querySelector("[data-install]");
  var installBusy = function () {   /* laeuft eine Runde, wird sie nie neu gestartet: Keyframes springen sonst auf 0 % */
    var g = install && install.querySelector(".install__ghost");
    return !!(g && g.getAnimations && g.getAnimations().some(function (a) { return a.playState === "running"; }));
  };
  var runInstall = function (runs) {
    if (!install || reduce) return;
    install.style.setProperty("--install-runs", String(runs || 3));   /* beim ersten Sichtbarwerden drei Runden, sonst eine */
    install.classList.remove("is-run"); void install.offsetWidth; install.classList.add("is-run");
  };
  if (dlSec && "IntersectionObserver" in window) {
    var dlStarted = false;
    new IntersectionObserver(function (es) { es.forEach(function (e) { dlSec.classList.toggle("is-live", e.isIntersecting); }); }).observe(dlSec);
    if (install) new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        install.classList.toggle("is-live", e.isIntersecting);
        if (e.isIntersecting && !dlStarted) { dlStarted = true; runInstall(); }
      });
    }, { threshold: 0.4 }).observe(install);
    if (install && matchMedia("(hover: hover) and (pointer: fine)").matches) install.addEventListener("mouseenter", function () { if (!installBusy()) runInstall(1); });
  }
  if (firstStart) {
    document.querySelectorAll('a[href$="Preen.dmg"]').forEach(function (a) {
      a.addEventListener("click", function (ev) {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button > 0) return;
        setTimeout(function () {
          var flash = function () {
            firstStart.classList.remove("is-flash"); void firstStart.offsetWidth; firstStart.classList.add("is-flash");
            setTimeout(function () { firstStart.classList.remove("is-flash"); }, 1800);
          };
          var r = firstStart.getBoundingClientRect(), hh = header ? header.offsetHeight : 0, far = r.top < hh || r.top > window.innerHeight * 0.6;
          if (far) {   /* kein Auto-Scrollen (Jamie): die Karte leuchtet, sobald man selbst bei ihr ankommt */
            if ("IntersectionObserver" in window) {
              var fio = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { fio.disconnect(); flash(); } }, { threshold: 0.5 });
              fio.observe(firstStart);
            }
            return;
          }
          var wait = 0;
          if (!installBusy()) { runInstall(1); wait = (parseFloat(cssVar(document.documentElement, "--dur-install")) || 4800) * 0.54; }   /* erst zeigt die Bewegung den Schritt, der Ring kommt, wenn der Ordner schluckt (install-gulp 54 %) */
          setTimeout(flash, wait);
        }, 350);
      });
    });
  }

  /* iOS zeigt :active nur mit einem touchstart-Listener */
  document.addEventListener("touchstart", function () {}, { passive: true });

  /* ---------- Erster Start: Befehl kopieren ---------- */
  var copyBtn = document.querySelector("[data-copy]");
  if (copyBtn) {
    var status = document.querySelector("[data-copy-status]");
    var copyLabel = copyBtn.querySelector("[data-copy-label]") || copyBtn;
    var copyT = 0;
    var done = function (ok) {
      clearTimeout(copyT);
      copyLabel.textContent = ok ? "Kopiert" : "Nicht kopiert";
      copyBtn.classList.toggle("is-done", ok);
      if (status) { status.textContent = ""; requestAnimationFrame(function () { status.textContent = ok ? "Befehl kopiert" : "Kopieren nicht möglich, bitte von Hand markieren"; }); }   /* auch beim zweiten Mal angesagt */
      copyT = setTimeout(function () { copyLabel.textContent = "Kopieren"; copyBtn.classList.remove("is-done"); }, 1800);
    };
    copyBtn.addEventListener("click", function () {
      var text = copyBtn.getAttribute("data-copy");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      } else {
        done(false);
      }
    });
  }

  /* ---------- Download: wechselnde Werte, zeichenweise (21st.dev text-rotate) ----------
     Das neue Wort kommt, waehrend das alte geht, nie eine leere Stelle. Nur in Sichtweite.
     Nach einer Runde bleibt der letzte Satz stehen. */
  var rot = document.querySelector("[data-rotate]");
  if (rot) {   /* auch bei reduzierter Bewegung: dann nur Ueberblenden (base.css), keine Bewegung */
    var words = rot.getAttribute("data-rotate").split("|");
    var idx = 0, rounds = 0, rotTimer = 0, rotStagger = parseFloat(cssVar(document.documentElement, "--rotate-stagger")) || 18, rotHold = parseFloat(cssVar(document.documentElement, "--dur-rotate-hold")) || 2200;
    rot.textContent = "";
    var layer = function (word, cls) {
      var l = document.createElement("span");
      l.className = "rotator__word" + (cls ? " " + cls : "");
      Array.prototype.forEach.call(word, function (ch, i) {
        var s = document.createElement("span");
        s.className = "rotator__char";
        s.style.transitionDelay = reduce ? "0ms" : (i * rotStagger) + "ms";
        s.textContent = ch;
        l.appendChild(s);
      });
      rot.appendChild(l);
      return l;
    };
    var rotCur = layer(words[0]);
    var spin = function () {
      if (document.hidden) return;
      idx = (idx + 1) % words.length;
      if (idx === 0) { rounds++; clearInterval(rotTimer); rotTimer = -1; }   /* eine Runde, dann bleibt "Ohne Upload." stehen */
      var old = rotCur;
      old.classList.add("is-out");
      var lastCh = old.lastChild, gone = false, drop = function () { if (!gone) { gone = true; old.remove(); } };
      if (lastCh) lastCh.addEventListener("transitionend", drop, { once: true });   /* weg, wenn das letzte Zeichen draussen ist */
      setTimeout(drop, rotHold);   /* Rueckfall, falls keine Transition laeuft */
      rotCur = layer(words[idx], "is-pre");
      rotCur.getBoundingClientRect();
      rotCur.classList.remove("is-pre");
    };
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (rotTimer === -1) return;
          if (e.isIntersecting && !rotTimer) rotTimer = setInterval(spin, rotHold);
          else if (!e.isIntersecting && rotTimer) { clearInterval(rotTimer); rotTimer = 0; }
        });
      }, { threshold: 0.5 }).observe(rot);
    }
  }
})();
