// sfx.js - tiny dependency-free synthesised sound effects (WebAudio).
// Plain script: defines window.SFX = { muted, volume, play(name) }.
(function () {
  'use strict';

  var ctx = null;      // single lazily-created AudioContext
  var out = null;      // master gain node, set to SFX.volume
  var t0 = 0;          // start time of the sound currently being scheduled
  var lastMove = 0;    // timestamp of the last 'move' sound (throttle)

  var SFX = window.SFX = {
    muted: false,
    volume: 0.25,
    play: function (name) {
      try {
        if (SFX.muted || !SOUNDS.hasOwnProperty(name)) return;
        if (name === 'move') {
          var now = Date.now();
          if (now - lastMove < 60) return;
          lastMove = now;
        }
        var c = getCtx();
        if (!c) return;
        out.gain.value = SFX.volume;
        t0 = c.currentTime + 0.01;
        SOUNDS[name]();
      } catch (e) {
        // audio is optional; never let it break the game
      }
    }
  };

  function getCtx() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      out = ctx.createGain();
      out.gain.value = SFX.volume;
      out.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') {
      var p = ctx.resume();
      if (p && p.catch) p.catch(function () {});
    }
    return ctx;
  }

  // Browsers block audio until a user gesture: create/resume on first input.
  function unlock() {
    try { getCtx(); } catch (e) { /* ignore */ }
  }
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  // One oscillator tone with a quick attack and exponential decay.
  // freq/endFreq in Hz, start/dur in seconds relative to t0, peak is linear gain.
  function tone(freq, start, dur, type, peak, endFreq) {
    var s = t0 + start, e = s + dur;
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, s);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, e);
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(peak, s + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, e);
    o.connect(g);
    g.connect(out);
    o.start(s);
    o.stop(e + 0.02);
  }

  // A run of equally spaced notes (arpeggio / scale).
  function run(freqs, gap, dur, type, peak) {
    for (var i = 0; i < freqs.length; i++) tone(freqs[i], i * gap, dur, type, peak);
  }

  // Band-passed noise whose centre frequency sweeps f0 -> f1 (used for whooshes/snaps).
  function noise(start, dur, peak, f0, f1) {
    var s = t0 + start, e = s + dur;
    var len = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    var src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = buf;
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(f0, s);
    f.frequency.exponentialRampToValueAtTime(f1, e);
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(peak, s + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, e);
    src.connect(f);
    f.connect(g);
    g.connect(out);
    src.start(s);
    src.stop(e + 0.02);
  }

  // Each sound is a short list of tone()/run()/noise() calls.
  var SOUNDS = {
    move:         function () { tone(520, 0, 0.06, 'sine', 0.12, 380); },
    click:        function () { tone(1400, 0, 0.03, 'sine', 0.12, 1000); },
    tag:          function () { tone(1400, 0, 0.18, 'triangle', 0.18, 250); },
    tagged:       function () { tone(330, 0, 0.18, 'triangle', 0.2); tone(262, 0.16, 0.3, 'triangle', 0.2); },
    flagTaken:    function () { run([523, 659, 784], 0.08, 0.14, 'triangle', 0.2); },
    flagDropped:  function () { tone(659, 0, 0.14, 'triangle', 0.2); tone(440, 0.12, 0.2, 'triangle', 0.2); },
    flagReturned: function () { tone(392, 0, 0.15, 'triangle', 0.2); tone(523, 0.12, 0.25, 'triangle', 0.2); },
    capture:      function () { run([523, 659, 784], 0.1, 0.14, 'triangle', 0.2); tone(1047, 0.3, 0.3, 'triangle', 0.22); },
    enemyCapture: function () { tone(330, 0, 0.22, 'triangle', 0.22); tone(277, 0.18, 0.22, 'triangle', 0.22); tone(220, 0.36, 0.35, 'triangle', 0.22); },
    turn:         function () { tone(880, 0, 0.5, 'sine', 0.2); tone(1760, 0, 0.25, 'sine', 0.05); },
    pickup:       function () { run([880, 1175, 1568], 0.04, 0.08, 'sine', 0.18); },
    trap:         function () { tone(180, 0, 0.12, 'square', 0.05, 90); noise(0, 0.06, 0.15, 2000, 800); },
    ability:      function () { noise(0, 0.4, 0.25, 300, 2500); tone(200, 0, 0.35, 'sine', 0.08, 800); },
    rescue:       function () { run([523, 587, 659, 784, 880], 0.06, 0.12, 'triangle', 0.2); },
    win:          function () { run([523, 659, 784], 0.14, 0.2, 'triangle', 0.2); tone(784, 0.42, 0.6, 'triangle', 0.15); tone(1047, 0.42, 0.6, 'triangle', 0.15); },
    lose:         function () { run([392, 330, 294, 262], 0.25, 0.3, 'triangle', 0.2); },
    ping:         function () { tone(1760, 0, 0.06, 'sine', 0.12); tone(1760, 0.09, 0.06, 'sine', 0.12); },
    chat:         function () { tone(988, 0, 0.09, 'sine', 0.1); }
  };
})();
