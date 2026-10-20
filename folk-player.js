/*
 * folk-player.js — прайгравальнік мелодый зборніка (без знешніх бібліятэк, гук сінтэзуецца ў браўзеры).
 *
 * Інструменты: сапілка, цымбалы (мадэль ударанай струны, доўгія ноты — трэмала), кларнет.
 * Рэжымы: «listen» — адзін раз; «learn» — 70 % тэмпу, спачатку пачатковы тон, паўтор па крузе.
 * Налады (інструмент, актава, бурдон, вышыня ў паўтонах, тэмп) агульныя для ўсіх песень і запамінаюцца.
 *
 * Мелодыя для load(): { ev: [{ midi, b, d }], beats, bpm, tonic }
 *   midi — вышыня ноты (−1 — паўза), b — пачатак у долях, d — працягласць у долях,
 *   beats — даўжыня мелодыі ў долях, bpm — чвэртак у хвіліну, tonic — MIDI-нота тонікі (для бурдона).
 */
(function (global) {
  'use strict';
  var KEY = 'fed5.player';
  var DEF = { inst: 'sapilka', octave: -12, drone: false, transpose: 0, tempo: 1 };
  var INST = {
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
  function note(dest, midi, t0, dur) {
    var f = hz(midi);
    if (INST[S.inst].string) struck(dest, f, t0, dur); else wind(dest, S.inst, f, t0, dur);
  }

  // drone (бурдон): tonic and fifth with an extra octave, never lower than ~150 Hz, fixed level about a half
  var drone = null;
  function droneOn(t) {
    if (drone || !song) return;
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
  var song = null, playing = false, mode = 'listen', bus = null, timer = 0, next = 0, segs = [], onEnd = null;
  function spb() { return 60 / (song.bpm * S.tempo * (mode === 'learn' ? LEARN_TEMPO : 1)); }
  function pitch(m) { return m + S.octave + S.transpose; }
  function pump() {
    if (!playing) return;
    var horizon = ctx.currentTime + LOOKAHEAD, sp = spb(), seg = segs[segs.length - 1];
    for (;;) {
      if (next >= song.ev.length) {
        var endT = seg.t0 + (song.beats - seg.b0) * sp;
        if (mode === 'learn') { seg = { t0: endT + sp, b0: 0 }; segs.push(seg); next = 0; if (seg.t0 > horizon) return; continue; }
        if (ctx.currentTime > endT + .25) finish();
        return;
      }
      var e = song.ev[next], t = seg.t0 + (e.b - seg.b0) * sp;
      if (t > horizon) return;
      if (e.midi >= 0) {
        var d = e.d * sp;
        note(bus, pitch(e.midi), t, d);
      }
      next++;
    }
  }
  function clear() {
    clearInterval(timer); timer = 0;
    var t = ctx ? ctx.currentTime : 0;
    droneOff(t);
    live.splice(0).forEach(function (n) { try { n.stop(t + .05); } catch (e) {} });
    if (bus) { var b = bus; try { b.gain.cancelScheduledValues(t); b.gain.setTargetAtTime(0, t, .02); } catch (e) {} setTimeout(function () { try { b.disconnect(); } catch (e) {} }, 300); }
    bus = null;
  }
  function finish() { playing = false; clear(); if (onEnd) onEnd(); }

  var api = {
    INST: INST, OCTAVES: OCTAVES, settings: S,
    supported: function () { return !!(global.AudioContext || global.webkitAudioContext); },
    load: function (melody) { if (playing) { playing = false; clear(); } song = melody; },
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
      if (S.drone) droneOn(t);
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
