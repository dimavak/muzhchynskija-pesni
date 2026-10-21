/*
 * folk-player.js — прайгравальнік мелодый зборніка (без знешніх бібліятэк, гук сінтэзуецца ў браўзеры).
 *
 * Інструменты: мужчынскі голас (фармантны сінтэз, галосныя з першага куплета), голас з лірай, дуда,
 * сапілка, цымбалы (мадэль ударанай струны, доўгія ноты — трэмала), кларнет.
 * Голас, ліра і дуда гучаць у чыстым страі ад тонікі; ліра і дуда маюць свой бурдон.
 * Рэжымы: «listen» — адзін раз; «learn» — 70 % тэмпу, спачатку пачатковы тон, паўтор па крузе.
 * Налады (інструмент, актава, бурдон, вышыня ў паўтонах, тэмп) агульныя для ўсіх песень і запамінаюцца.
 *
 * Мелодыя для load(): { ev: [{ midi, b, d, f, staff, img }], beats, bpm, tonic, lyrics }
 *   midi — вышыня ноты (−1 — паўза), b — пачатак у долях, d — працягласць у долях, f — фермата,
 *   staff і img — радок і выява нот (на іх канчаюцца фразы), beats — даўжыня мелодыі ў долях,
 *   bpm — чвэртак у хвіліну, tonic — MIDI-нота тонікі (для бурдона і строю), lyrics — радкі тэксту.
 */
(function (global) {
  'use strict';
  var KEY = 'fed5.player';
  var DEF = { inst: 'sapilka', octave: -12, drone: false, transpose: 0, tempo: 1 };
  var INST = {
    voice:    { name: 'Голас', voice: .9 },
    lira:     { name: 'Голас з лірай', voice: .32, lira: true, ownDrone: true },
    duda:     { name: 'Дуда', duda: true, ownDrone: true },
    sapilka:  { name: 'Сапілка', wave: [0, 1, .42, .2, .12, .06, .03], att: .025, rel: .07, vib: [5.6, .0045, .2], noise: .055, nq: 2.2, scoop: .03, gain: .3, legato: .93 },
    cymbaly:  { name: 'Цымбалы', string: true, gain: .5 },
    clarinet: { name: 'Кларнет', wave: [0, 1, .03, .72, .03, .48, .02, .26, .02, .14, .01, .08], att: .045, rel: .09, vib: [4.8, .0012, .3], noise: .012, nq: 1.2, scoop: 0, gain: .27, legato: .95, lp: 2800 }
  };
  var OCTAVES = [[12, 'Высока'], [0, 'Як у нотах'], [-12, 'Мужчынскі голас']];
  var LEARN_TEMPO = .7, LOOKAHEAD = 1.0, TICK = 50;

  var S = (function () {
    var o = {}, v = {};
    try { v = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) {}
    for (var k in DEF) o[k] = (k in v) ? v[k] : DEF[k];
    if (!INST[o.inst]) o.inst = DEF.inst;
    return o;
  })();
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

  // ---------------- audio graph ----------------
  var ctx = null, master = null, verb = null, noise = null, waves = {}, ks = {};
  function ensure() {
    if (ctx) return ctx;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    try { ctx = new AC({ latencyHint: 'playback' }); } catch (e) { ctx = new AC(); }
    var comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 3; comp.connect(ctx.destination);
    var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 45; hp.connect(comp);
    master = ctx.createGain(); master.gain.value = .9; master.connect(hp);
    var len = Math.floor(ctx.sampleRate * 1.3), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var c = 0; c < 2; c++) { var d = ir.getChannelData(c); for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.4); }
    verb = ctx.createConvolver(); verb.buffer = ir; var vg = ctx.createGain(); vg.gain.value = .18; verb.connect(vg); vg.connect(comp);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    var nd = noise.getChannelData(0); for (i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    Object.keys(INST).forEach(function (k) { var w = INST[k].wave; if (w) waves[k] = ctx.createPeriodicWave(new Float32Array(w.length), new Float32Array(w)); });
    var mk = function (h) { return ctx.createPeriodicWave(new Float32Array(h.length), new Float32Array(h)); }, gl = [0], bw = [0];
    for (i = 1; i < 60; i++) gl.push(Math.pow(i, -1.15) * (i % 2 ? 1 : .92));
    for (i = 1; i < 40; i++) bw.push(1 / i * (1 + .25 * Math.sin(i * 1.7)));
    waves.glottal = mk(gl); waves.bow = mk(bw);
    waves.reed = mk([0, 1, .95, .85, .6, .62, .4, .34, .25, .22, .16, .14, .1, .09, .06, .05]);
    waves.dreed = mk([0, 1, .7, .8, .5, .55, .35, .38, .25, .24, .15, .14, .1, .08]);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && playing && ctx.state !== 'running') ctx.resume(); });
    return ctx;
  }
  // Older iPhones mute Web Audio with the silent switch; a playing <audio> element lifts that.
  var silent = null;
  function iosUnlock() {
    if (navigator.audioSession) return;
    var ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document);
    if (!ios) return;
    if (!silent) {
      var n = 4000, b = new ArrayBuffer(44 + n), v = new DataView(b), w = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
      for (var i = 0; i < n; i++) v.setUint8(44 + i, 128);
      silent = new Audio(URL.createObjectURL(new Blob([b], { type: 'audio/wav' })));
      silent.loop = true; silent.setAttribute('playsinline', '');
    }
    var p = silent.play(); if (p && p.catch) p.catch(function () {});
  }

  var live = [];     // every started source, so that stop() really silences everything
  function track(node, end) { node.stop(end); live.push(node); node.onended = function () { var i = live.indexOf(node); if (i >= 0) live.splice(i, 1); }; }
  function hz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // wind: periodic wave + breath noise + late vibrato
  function wind(dest, key, f, t0, dur) {
    var I = INST[key], o = ctx.createOscillator(), g = ctx.createGain(), node = o;
    o.setPeriodicWave(waves[key]);
    o.frequency.setValueAtTime(I.scoop ? f * (1 - I.scoop) : f, t0);
    if (I.scoop) o.frequency.exponentialRampToValueAtTime(f, t0 + .05);
    if (I.lp) { var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = I.lp; o.connect(lp); node = lp; }
    node.connect(g); g.connect(dest);
    var end = t0 + Math.max(.05, dur * I.legato);
    if (I.vib[0]) {
      var l = ctx.createOscillator(), lg = ctx.createGain();
      l.frequency.value = I.vib[0]; lg.gain.setValueAtTime(0, t0); lg.gain.linearRampToValueAtTime(f * I.vib[1], t0 + I.vib[2] + .15);
      l.connect(lg); lg.connect(o.frequency); l.start(t0); track(l, end + I.rel + .05);
    }
    if (I.noise) {
      var n = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), ng = ctx.createGain();
      n.buffer = noise; n.loop = true; bp.type = 'bandpass'; bp.frequency.value = Math.min(9000, f * 2); bp.Q.value = I.nq;
      ng.gain.setValueAtTime(0, t0); ng.gain.linearRampToValueAtTime(I.noise * 2.2, t0 + .02); ng.gain.linearRampToValueAtTime(I.noise, t0 + .09);
      ng.gain.setValueAtTime(I.noise, end); ng.gain.linearRampToValueAtTime(0, end + I.rel);
      n.connect(bp); bp.connect(ng); ng.connect(g); n.start(t0, Math.random() * .5); track(n, end + I.rel + .05);
    }
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(I.gain, t0 + I.att); g.gain.setTargetAtTime(I.gain * .85, t0 + I.att, .15);
    g.gain.setValueAtTime(I.gain * .85, end); g.gain.linearRampToValueAtTime(0, end + I.rel);
    o.start(t0); track(o, end + I.rel + .05);
  }

  // cymbaly: Karplus-Strong string, two strings of one course slightly apart; cached per pitch
  function string(f) {
    var key = Math.round(f * 4);
    if (ks[key]) return ks[key];
    var sr = ctx.sampleRate, len = Math.floor(sr * 2.2), buf = ctx.createBuffer(1, len, sr), out = buf.getChannelData(0);
    var t60 = Math.max(.7, Math.min(2.6, 2.8 - f / 700));
    [1, 1.0016].forEach(function (det) {
      var P = sr / (f * det), D = P - .5, y = new Float32Array(len), ex = Math.max(2, Math.floor(P)), exc = new Float32Array(ex), mean = 0;
      for (var k = 0; k < ex; k++) { exc[k] = (Math.random() * 2 - 1) * .45 + Math.sin(Math.PI * k / ex) * .7; mean += exc[k] / ex; }
      for (k = 0; k < ex; k++) exc[k] -= mean;   // no DC: the string must not drift
      var rho = Math.pow(.001, 1 / (f * det * t60));
      for (var n = 0; n < len; n++) {
        var x = n < ex ? exc[n] : 0;
        var a = n - D, i0 = Math.floor(a), fr = a - i0, s1 = 0, s2 = 0;
        if (i0 >= 1) { s1 = y[i0] * (1 - fr) + y[i0 + 1 > n - 1 ? n - 1 : i0 + 1] * fr; s2 = y[i0 - 1] * (1 - fr) + y[i0] * fr; }
        y[n] = x + rho * .5 * (s1 + s2);
      }
      for (n = 0; n < len; n++) out[n] += y[n] * .5;
    });
    var pk = 0; for (var i = 0; i < len; i++) pk = Math.max(pk, Math.abs(out[i]));
    var fade = Math.floor(sr * .02);
    for (i = 0; i < len; i++) out[i] = out[i] / (pk || 1) * .8 * (i > len - fade ? (len - i) / fade : 1);
    return (ks[key] = buf);
  }
  function struck(dest, f, t0, dur) {
    var I = INST.cymbaly, buf = string(f), step = .085;
    var hits = dur > .45 ? Math.max(2, Math.floor(dur / step)) : 1;   // tremolo on long notes, as the players do
    for (var i = 0; i < hits; i++) {
      var t = t0 + i * step, s = ctx.createBufferSource(), g = ctx.createGain(), last = i === hits - 1;
      s.buffer = buf; s.connect(g); g.connect(dest);
      var v = I.gain * (i === 0 ? 1 : .55 + Math.random() * .15);
      g.gain.setValueAtTime(v, t);
      var off = last ? t + Math.min(buf.duration, (dur - i * step) + 1.1) : t + step + .05;
      g.gain.setTargetAtTime(0, last ? t0 + dur + .15 : t + step, last ? .3 : .02);
      s.start(t); track(s, Math.min(off, t + buf.duration));
    }
  }
  // ---------------- voice, lira and duda: one continuous sound per phrase ----------------
  // Tenor formants: frequency Hz, level dB, bandwidth Hz. «ы» sits between «і» and «у».
  var VOWELS = {
    a: [[650, 0, 80], [1080, -6, 90], [2650, -7, 120], [2900, -8, 130], [3250, -22, 140]],
    e: [[400, 0, 70], [1700, -14, 80], [2600, -12, 100], [3200, -14, 120], [3580, -20, 120]],
    i: [[290, 0, 40], [1870, -15, 90], [2800, -18, 100], [3250, -20, 120], [3540, -30, 120]],
    o: [[400, 0, 40], [800, -10, 80], [2600, -12, 100], [2800, -12, 120], [3000, -26, 120]],
    u: [[350, 0, 40], [600, -20, 60], [2700, -17, 100], [2900, -14, 120], [3300, -26, 120]],
    y: [[300, 0, 50], [1400, -12, 90], [2450, -15, 100], [2900, -20, 120], [3400, -28, 120]]
  };
  var VOWEL_OF = { 'а': 'a', 'я': 'a', 'о': 'o', 'ё': 'o', 'у': 'u', 'ю': 'u', 'э': 'e', 'е': 'e', 'і': 'i', 'ы': 'y' };
  var JUST = [1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 16 / 9, 15 / 8];
  function db(x) { return Math.pow(10, x / 20); }
  // just intonation from the tonic, so the drone does not beat against the melody
  function jhz(m) {
    var T = song.tonic + S.octave + S.transpose, d = m - T, o = Math.floor(d / 12);
    return hz(T) * JUST[d - o * 12] * Math.pow(2, o);
  }
  // phrase ends (rest, fermata, end of a line of notes) and one vowel per note from the first verse
  function phrasing(m) {
    var ev = m.ev, syl = [], n = 0, k = 0, prev = null, info = [];
    ev.forEach(function (e) { if (e.midi >= 0) n++; });
    (m.lyrics || []).some(function (l) {
      l.replace(/\([^)]*\)/g, '').toLowerCase().split('').forEach(function (c) { if (VOWEL_OF[c]) syl.push(VOWEL_OF[c]); });
      return syl.length >= n;
    });
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i], x = ev[i + 1];
      if (e.midi < 0) { if (prev) prev.end = true; info.push(null); continue; }
      var si = syl.length >= n ? k : Math.floor(k * syl.length / n);
      prev = { end: !x || x.midi < 0 || !!e.f || x.staff !== e.staff || x.img !== e.img, v: syl[si] || 'a', s: si, fresh: !prev || si !== prev.s };
      info.push(prev); k++;
    }
    return info;
  }
  function open(node, t) { node.start(t); live.push(node); node.onended = function () { var i = live.indexOf(node); if (i >= 0) live.splice(i, 1); }; return node; }
  function body(dest, peaks, lp) {
    var head = ctx.createGain(), x = head;
    peaks.forEach(function (q) { var f = ctx.createBiquadFilter(); f.type = q[3] || 'peaking'; f.frequency.value = q[0]; f.gain.value = q[1]; f.Q.value = q[2]; x.connect(f); x = f; });
    var l = ctx.createBiquadFilter(); l.type = 'lowpass'; l.frequency.value = lp; x.connect(l); l.connect(dest);
    return head;
  }
  // an amplitude envelope that only moves forward in time
  function env(g) {
    var E = { g: g, t: 0, v: 0 };
    E.to = function (t, v) { t = Math.max(t, E.t + .002); g.gain.linearRampToValueAtTime(v, t); E.t = t; E.v = v; };
    return E;
  }
  var lines = {};

  function voiceLine(dest, t0) {
    var L = { osc: ctx.createOscillator(), filt: [] }, src = ctx.createGain(), sum = ctx.createGain(), amp = ctx.createGain();
    L.osc.setPeriodicWave(waves.glottal); L.osc.connect(src);
    var nz = ctx.createBufferSource(), ng = ctx.createGain(); nz.buffer = noise; nz.loop = true; ng.gain.value = .045; nz.connect(ng); ng.connect(src);
    VOWELS.a.forEach(function () { var bp = ctx.createBiquadFilter(), g = ctx.createGain(); bp.type = 'bandpass'; src.connect(bp); bp.connect(g); g.connect(sum); L.filt.push({ bp: bp, g: g }); });
    sum.connect(amp); amp.connect(dest); amp.gain.setValueAtTime(0, t0);
    L.env = env(amp); L.env.t = t0;
    L.lfo = ctx.createOscillator(); L.lg = ctx.createGain(); L.lfo.frequency.value = 4.8 + Math.random() * .8; L.lg.gain.value = 0; L.lfo.connect(L.lg); L.lg.connect(L.osc.detune);
    var dr = ctx.createOscillator(), dg = ctx.createGain(); dr.frequency.value = .4 + Math.random() * .5; dg.gain.value = 5; dr.connect(dg); dg.connect(L.osc.detune);
    L.srcs = [L.osc, nz, L.lfo, dr].map(function (s) { return open(s, t0); });
    L.vowel = function (v, t, tau) {
      VOWELS[v].forEach(function (f, k) {
        var F = L.filt[k], bw = f[2] * (k < 2 ? 1.7 : 1.2), gain = db(f[1] + (k === 1 || k === 2 ? 3 : 0)) * (k ? 1.4 : 1) * Math.sqrt(f[0] / bw) * .35;
        if (tau) { F.bp.frequency.setTargetAtTime(f[0], t, tau); F.bp.Q.setTargetAtTime(f[0] / bw, t, tau); F.g.gain.setTargetAtTime(gain, t, tau); }
        else { F.bp.frequency.setValueAtTime(f[0], t); F.bp.Q.setValueAtTime(f[0] / bw, t); F.g.gain.setValueAtTime(gain, t); }
      });
    };
    return L;
  }
  // a sung note: glide into it, a short dip on a new syllable, a fall at the end of the phrase
  function sing(dest, midi, t, dur, info, A) {
    var L = lines.voice, f = jhz(midi);
    if (!L) {
      L = lines.voice = voiceLine(dest, t);
      L.osc.frequency.setValueAtTime(f * Math.pow(2, -1.6 / 12), t); L.osc.frequency.exponentialRampToValueAtTime(f, t + .11);
      L.vowel(info.v, t, 0); L.env.to(t + .07, A);
    } else {
      var glide = Math.abs(midi - L.midi) > 2 ? .045 : .022;
      L.osc.frequency.setTargetAtTime(f, t - glide * .6, glide);
      if (info.fresh) { L.vowel(info.v, t - .02, .025); L.env.to(t - .03, L.env.v); L.env.to(t - .004, A * .32); L.env.to(t + .035, A); }
    }
    L.midi = midi;
    if (dur > .45 && !info.end) L.env.to(t + dur - .06, A * .82);
    L.lg.gain.linearRampToValueAtTime(0, t);
    if (dur > .5) { L.lg.gain.linearRampToValueAtTime(14, t + Math.min(.6, dur * .7)); L.lg.gain.setValueAtTime(14, t + dur - .02); }
    if (info.end) {
      var e0 = t + dur, fs = t + Math.max(.12, dur * .62), end = e0 + .18;
      if (dur > .3) { L.osc.frequency.setValueAtTime(f, fs); L.osc.frequency.exponentialRampToValueAtTime(f * Math.pow(2, -(info.last ? 5 : 3) / 12), end - .02); L.env.to(fs, L.env.v); }
      else L.env.to(e0 - .02, L.env.v);
      L.env.to(end, 0);
      L.srcs.forEach(function (s) { s.stop(end + .1); });
      lines.voice = null;
    }
  }
  // lira: the melody string an octave above the voice, sounding while the wheel turns
  function liraString(dest, midi, t, dur, info) {
    if (!lines.liraBody) lines.liraBody = body(dest, LIRA_BODY, 5200);
    var L = lines.lira, f = jhz(midi + 12), G = .128;
    if (!L) {
      var osc = ctx.createOscillator(), amp = ctx.createGain(), nz = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), ng = ctx.createGain();
      osc.setPeriodicWave(waves.bow); osc.connect(amp); amp.connect(lines.liraBody); amp.gain.setValueAtTime(0, t);
      nz.buffer = noise; nz.loop = true; bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = .8; ng.gain.value = .25; nz.connect(bp); bp.connect(ng); ng.connect(amp);
      L = lines.lira = { osc: osc, env: env(amp), srcs: [open(osc, t), open(nz, t)] };
      L.env.t = t; osc.frequency.setValueAtTime(f, t); L.env.to(t + .06, G);
    } else {
      L.osc.frequency.setValueAtTime(f, t);
      if (midi === L.midi) { L.env.to(t - .025, L.env.v); L.env.to(t - .004, G * .75); L.env.to(t + .03, G); }
    }
    L.midi = midi;
    if (info.end) { var end = t + dur + .12; L.env.to(t + dur - .02, L.env.v); L.env.to(end, 0); L.srcs.forEach(function (s) { s.stop(end + .1); }); lines.lira = null; }
  }
  var LIRA_BODY = [[300, 7, 1.2], [720, 3, 1.5], [2300, 6, 1.4], [120, 0, .7, 'highpass']];
  // duda: the chanter never stops; a repeated note is split by a quick higher grace note
  function chanter(dest, midi, t, dur) {
    var L = lines.duda, m = midi + 12, f = jhz(m), G = .2;
    if (!L) {
      var out = body(dest, [[350, 0, .7, 'highpass'], [1300, 7, 1.1], [2700, 3, 1.5]], 5500);
      var osc = ctx.createOscillator(), amp = ctx.createGain(), lfo = ctx.createOscillator(), lg = ctx.createGain();
      osc.setPeriodicWave(waves.reed); osc.connect(amp); amp.connect(out); amp.gain.setValueAtTime(0, t);
      lfo.frequency.value = 5; lg.gain.value = 3; lfo.connect(lg); lg.connect(osc.detune);
      L = lines.duda = { osc: osc, env: env(amp), srcs: [open(osc, t), open(lfo, t)], n: 0 };
      L.env.t = t; osc.frequency.setValueAtTime(f, t); L.env.to(t + .05, G);
    } else if (midi === L.midi || (dur > .5 && L.n % 3 === 0)) {
      L.osc.frequency.setValueAtTime(jhz(m + (midi === L.midi ? 5 : 2)), t - .032); L.osc.frequency.setValueAtTime(f, t);
    } else L.osc.frequency.setValueAtTime(f, t);
    L.midi = midi; L.f = f; L.n++;
  }
  // instrument drones: lira on the tonic, its fifth and the octave below; duda two octaves below the chanter
  function ownDrone(t) {
    var I = INST[S.inst], T = song.tonic + S.octave + S.transpose, parts, out;
    if (I.lira) { parts = [[T, .056, 0], [T + 7, .04, 3], [T - 12, .048, 0]]; out = body(bus, LIRA_BODY, 2600); }
    else { parts = [[T - 12, .2, 0], [T - 12, .074, 6]]; out = body(bus, [[600, 4, 1.2]], 1500); }
    var g = ctx.createGain(); g.connect(out); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + .4);
    lines.drone = { g: g, srcs: parts.map(function (p) {
      var o = ctx.createOscillator(), og = ctx.createGain(); o.setPeriodicWave(I.lira ? waves.bow : waves.dreed);
      o.frequency.value = jhz(p[0]); o.detune.value = p[2]; og.gain.value = p[1]; o.connect(og); og.connect(g); return open(o, t);
    }) };
  }
  // the end of a listened melody: the duda bag empties and its pitch sags, drones fade out
  function closeLines(t) {
    var D = lines.duda, R = lines.drone;
    if (D) { D.osc.frequency.setValueAtTime(D.f, t - .05); D.osc.frequency.exponentialRampToValueAtTime(D.f * Math.pow(2, -1.2 / 12), t + .35); D.env.to(t - .02, D.env.v); D.env.to(t + .35, 0); D.srcs.forEach(function (s) { s.stop(t + .45); }); lines.duda = null; }
    if (R) { R.g.gain.setValueAtTime(1, t); R.g.gain.linearRampToValueAtTime(0, t + .4); R.srcs.forEach(function (s) { if (INST[S.inst].duda) s.frequency.exponentialRampToValueAtTime(s.frequency.value * Math.pow(2, -1.2 / 12), t + .4); s.stop(t + .5); }); lines.drone = null; }
  }

  // i: index of the event in song.ev (none for the starting tone of «Развучыць»)
  function note(dest, midi, t0, dur, i) {
    var I = INST[S.inst], info = (i != null && song.info[i]) || { end: true, v: 'a', fresh: true };
    if (I.voice) {
      info.last = i === song.ev.length - 1 || (i != null && song.ev.slice(i + 1).every(function (e) { return e.midi < 0; }));
      sing(dest, midi, t0, dur, info, I.voice);
      if (I.lira) liraString(dest, midi, t0, dur, info);
      return;
    }
    if (I.duda) { chanter(dest, midi, t0, dur); return; }
    var f = hz(midi);
    if (I.string) struck(dest, f, t0, dur); else wind(dest, S.inst, f, t0, dur);
  }

  // drone (бурдон): tonic and fifth with an extra octave, never lower than ~150 Hz, fixed level about a half
  var drone = null;
  function droneOn(t) {
    if (drone || !song || INST[S.inst].ownDrone) return;
    var f = hz(song.tonic + S.octave + S.transpose - 12);
    while (f < 150) f *= 2;
    var g = ctx.createGain(), lp = ctx.createBiquadFilter(), osc = [];
    lp.type = 'lowpass'; lp.frequency.value = 1600; lp.connect(g); g.connect(bus || master);
    [[1, .06], [1.5, .035], [2, .03]].forEach(function (p) { var o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f * p[0]; var og = ctx.createGain(); og.gain.value = p[1]; o.connect(og); og.connect(lp); o.start(t); osc.push(o); });
    g.gain.setValueAtTime(0, t); g.gain.setTargetAtTime(.5, t, .15);
    drone = { g: g, osc: osc };
  }
  function droneOff(t) {
    if (!drone) return;
    var d = drone; drone = null;
    d.g.gain.cancelScheduledValues(t); d.g.gain.setTargetAtTime(0, t, .08);
    d.osc.forEach(function (o) { try { o.stop(t + .5); } catch (e) {} });
    setTimeout(function () { try { d.g.disconnect(); } catch (e) {} }, 900);
  }

  // ---------------- scheduler: notes are queued about a second ahead ----------------
  var song = null, playing = false, mode = 'listen', bus = null, timer = 0, next = 0, segs = [], onEnd = null, closed = false;
  function spb() { return 60 / (song.bpm * S.tempo * (mode === 'learn' ? LEARN_TEMPO : 1)); }
  function pitch(m) { return m + S.octave + S.transpose; }
  function pump() {
    if (!playing) return;
    var horizon = ctx.currentTime + LOOKAHEAD, sp = spb(), seg = segs[segs.length - 1];
    for (;;) {
      if (next >= song.ev.length) {
        var endT = seg.t0 + (song.beats - seg.b0) * sp;
        if (mode === 'learn') { seg = { t0: endT + sp, b0: 0 }; segs.push(seg); next = 0; if (seg.t0 > horizon) return; continue; }
        if (!closed) { closeLines(endT); closed = true; }
        if (ctx.currentTime > endT + .5) finish();
        return;
      }
      var e = song.ev[next], t = seg.t0 + (e.b - seg.b0) * sp;
      if (t > horizon) return;
      if (e.midi >= 0) {
        var d = e.d * sp;
        note(bus, pitch(e.midi), t, d, next);
      }
      next++;
    }
  }
  function clear() {
    clearInterval(timer); timer = 0;
    var t = ctx ? ctx.currentTime : 0;
    droneOff(t);
    live.splice(0).forEach(function (n) { try { n.stop(t + .05); } catch (e) {} });
    lines = {};
    if (bus) { var b = bus; try { b.gain.cancelScheduledValues(t); b.gain.setTargetAtTime(0, t, .02); } catch (e) {} setTimeout(function () { try { b.disconnect(); } catch (e) {} }, 300); }
    bus = null;
  }
  function finish() { playing = false; clear(); if (onEnd) onEnd(); }

  var api = {
    INST: INST, OCTAVES: OCTAVES, settings: S,
    supported: function () { return !!(global.AudioContext || global.webkitAudioContext); },
    load: function (melody) { if (playing) { playing = false; clear(); } song = melody; song.info = phrasing(melody); },
    // mode: 'listen' | 'learn'; from: note index; opts.tone: false skips the starting tone in learn mode
    play: function (m, from, opts) {
      if (!song || !song.ev.length || !ensure()) return false;
      iosUnlock();
      if (ctx.state !== 'running') ctx.resume();
      if (playing) { playing = false; clear(); }
      mode = m === 'learn' ? 'learn' : 'listen'; playing = true;
      from = Math.max(0, Math.min(song.ev.length - 1, from || 0));
      bus = ctx.createGain(); bus.gain.value = 1; bus.connect(master); bus.connect(verb);
      var t = ctx.currentTime + .08;
      closed = false;
      if (S.drone) droneOn(t);
      if (INST[S.inst].ownDrone) ownDrone(t);
      if (mode === 'learn' && !(opts && opts.tone === false)) {
        for (var i = 0; i < song.ev.length && song.ev[i].midi < 0; i++) {}
        if (i < song.ev.length) { note(bus, pitch(song.ev[i].midi), t, 1.3); t += 1.9; }
      }
      segs = [{ t0: t, b0: song.ev[from].b }]; next = from;
      pump(); timer = setInterval(pump, TICK);
      return true;
    },
    stop: function () { if (playing) { playing = false; clear(); } },
    isPlaying: function () { return playing; },
    mode: function () { return mode; },
    // current position in beats (negative while the starting tone sounds)
    position: function () {
      if (!playing || !ctx) return 0;
      var now = ctx.currentTime, seg = segs[0];
      for (var i = segs.length - 1; i >= 0; i--) if (segs[i].t0 <= now) { seg = segs[i]; break; }
      return seg.b0 + (now - seg.t0) / spb();
    },
    secondsPerBeat: function () { return song ? spb() : 0; },
    onEnd: function (fn) { onEnd = fn; },
    set: function (k, v) {
      if (!(k in DEF)) return;
      S[k] = v; persist();
      if (!playing) return;
      if (k === 'drone') { if (v) droneOn(ctx.currentTime + .02); else droneOff(ctx.currentTime); }
      else { var b = api.position(), i = 0; for (var j = song.ev.length - 1; j >= 0; j--) if (song.ev[j].b <= b) { i = j; break; } api.play(mode, i, { tone: false }); }
    }
  };
  global.FolkPlayer = api;
})(window);
