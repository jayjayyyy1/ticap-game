"use strict";

// All outcome probabilities and prizes live here. Weights need not total 100.
const GAME_CONFIG = Object.freeze({
  spins: 5,
  symbols: Object.freeze([
    { id: "panel", name: "Solar panel", weight: 14 },
    { id: "sun", name: "Sun", weight: 22 },
    { id: "tree", name: "Tree", weight: 18 },
    { id: "house", name: "Solar house", weight: 16 },
    { id: "battery", name: "Battery", weight: 16 },
    { id: "wind", name: "Wind turbine", weight: 14 }
  ]),
  rewards: Object.freeze({ 3: 50, 4: 150, 5: 500 }),
  solarJackpot: 1000
});

function pickSymbol(random = Math.random) {
  const total = GAME_CONFIG.symbols.reduce((sum, symbol) => sum + symbol.weight, 0);
  let pick = random() * total;
  for (const symbol of GAME_CONFIG.symbols) {
    pick -= symbol.weight;
    if (pick < 0) return symbol.id;
  }
  return GAME_CONFIG.symbols[GAME_CONFIG.symbols.length - 1].id;
}

// The board is five columns of three symbols, in the same order as the DOM.
function createOutcome(random = Math.random) {
  return Array.from({ length: 5 }, () => Array.from({ length: 3 }, () => pickSymbol(random)));
}

function scoreOutcome(board) {
  const lines = [];
  for (let row = 0; row < 3; row++) {
    const symbol = board[0][row];
    let length = 1;
    while (length < 5 && board[length][row] === symbol) length++;
    if (length < 3) continue;
    const jackpot = length === 5 && symbol === "panel";
    lines.push({ row, symbol, length, jackpot, points: jackpot ? GAME_CONFIG.solarJackpot : GAME_CONFIG.rewards[length] });
  }
  return { lines, total: lines.reduce((sum, line) => sum + line.points, 0), jackpot: lines.some(line => line.jackpot) };
}

// Pure rules can also be tested with Node; the website needs no modules/build.
if (typeof module !== "undefined" && module.exports) module.exports = { GAME_CONFIG, pickSymbol, createOutcome, scoreOutcome };

if (typeof document !== "undefined") initializeGame();

function initializeGame() {
  const $ = id => document.getElementById(id);
  const machine = $("machine");
  const reels = [...document.querySelectorAll(".reel")];
  const strips = reels.map(reel => reel.querySelector(".reel-strip"));
  const spinButton = $("spin");
  const rulesDialog = $("rules-dialog");
  const finishDialog = $("finish-dialog");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const symbolNames = Object.fromEntries(GAME_CONFIG.symbols.map(symbol => [symbol.id, symbol.name]));
  let board;
  let points = 0;
  let remaining = GAME_CONFIG.spins;
  let spinning = false;
  let generation = 0;
  const animations = new Set();
  const heldSpinKeys = new Set();
  let countFrame = 0;
  let finishTimer = 0;
  let confettiFrame = 0;
  let audioContext;
  let muted = false;
  let audioNodes = new Set();
  let spinSoundTimer = 0;
  let soundStep = 0;

  function syncScore() {
    // The model and accessible total update immediately; only the painted number counts up.
    $("points").dataset.total = String(points);
    $("points").setAttribute("aria-label", `${points.toLocaleString()} Energy Points`);
  }

  function symbolElement(id) {
    const cell = document.createElement("div");
    cell.className = "symbol";
    cell.dataset.symbol = id;
    const img = document.createElement("img");
    img.src = `assets/${id}.svg`;
    img.alt = "";
    img.draggable = false;
    cell.append(img);
    return cell;
  }

  function renderColumn(column) {
    strips[column].replaceChildren(...board[column].map(symbolElement));
    strips[column].style.transform = "translateY(0)";
  }

  function describeBoard() {
    const rows = ["Top", "Middle", "Bottom"].map((name, row) => `${name} row: ${board.map(column => symbolNames[column[row]]).join(", ")}.`);
    $("reel-window").setAttribute("aria-label", rows.join(" "));
  }

  function updateMeters() {
    $("spins").textContent = remaining;
    [...$("spin-dots").children].forEach((dot, i) => dot.classList.toggle("used", i >= remaining));
    spinButton.disabled = spinning || remaining === 0;
    $("spin-label").textContent = spinning ? "SPINNING…" : remaining ? "SPIN" : "FINISHED";
    $("spin").querySelector(".spin-key").textContent = spinning ? "CATCHING SOME SUN" : remaining ? "SPACE / ENTER" : "START A NEW PLAYER";
  }

  function message(text, win = false) {
    $("message").textContent = text;
    $("feedback").classList.toggle("is-win", win);
  }

  function initAudio() {
    if (muted) return;
    try {
      const AudioConstructor = window.AudioContext || window.webkitAudioContext;
      if (!AudioConstructor) return;
      audioContext ||= new AudioConstructor();
      if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
    } catch { /* Audio is optional if the browser blocks it. */ }
  }

  function tone(frequency, duration = .1, type = "sine", volume = .035, delay = 0) {
    if (muted || document.hidden || !audioContext || audioContext.state !== "running") return;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const start = audioContext.currentTime + delay;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + .008);
    gain.gain.exponentialRampToValueAtTime(.001, start + duration);
    oscillator.connect(gain).connect(audioContext.destination);
    audioNodes.add(oscillator);
    oscillator.onended = () => { audioNodes.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start);
    oscillator.stop(start + duration + .02);
  }

  function stopAudio() {
    clearInterval(spinSoundTimer);
    spinSoundTimer = 0;
    audioNodes.forEach(node => { try { node.stop(); } catch { /* Already ended. */ } });
    audioNodes.clear();
  }

  function startSpinSound() {
    clearInterval(spinSoundTimer);
    spinSoundTimer = 0;
    if (!spinning || muted || document.hidden) return;
    spinSoundTimer = setInterval(() => {
      if (!spinning || muted || document.hidden) return;
      tone(150 + (soundStep++ % 4) * 45, .045, "triangle", .022);
    }, 90);
  }

  function winSound(jackpot) {
    const melody = jackpot ? [523, 659, 784, 1047, 784, 1047, 1319, 1568] : [523, 659, 784, 1047];
    melody.forEach((note, index) => tone(note, .25, "triangle", .065, index * .105));
  }

  function clearCelebration() {
    cancelAnimationFrame(countFrame);
    cancelAnimationFrame(confettiFrame);
    clearTimeout(finishTimer);
    machine.classList.remove("jackpot");
    $("paylines").replaceChildren();
    document.querySelectorAll(".winner").forEach(cell => cell.classList.remove("winner"));
    const canvas = $("confetti");
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }

  function resetGame() {
    generation++;
    animations.forEach(animation => animation.cancel());
    animations.clear();
    clearCelebration();
    stopAudio();
    spinning = false;
    points = 0;
    syncScore();
    remaining = GAME_CONFIG.spins;
    // A welcoming display; all actual spin outcomes are independently random.
    board = [["sun", "panel", "tree"], ["tree", "sun", "battery"], ["house", "panel", "sun"], ["battery", "wind", "house"], ["wind", "sun", "panel"]];
    reels.forEach((_, column) => renderColumn(column));
    $("points").textContent = "0";
    $("final-points").textContent = "0";
    $("reel-window").setAttribute("aria-busy", "false");
    machine.classList.remove("is-spinning");
    [rulesDialog, finishDialog].forEach(dialog => { if (dialog.open) dialog.close(); });
    message("Your next bright moment is one spin away.");
    updateMeters();
    describeBoard();
  }

  function countPoints(from, to, token) {
    cancelAnimationFrame(countFrame);
    if (reducedMotion.matches) { $("points").textContent = to.toLocaleString(); return; }
    const start = performance.now();
    function tick(now) {
      if (token !== generation) return;
      const progress = Math.min((now - start) / 850, 1);
      $("points").textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - progress, 3))).toLocaleString();
      if (progress < 1) countFrame = requestAnimationFrame(tick);
    }
    countFrame = requestAnimationFrame(tick);
  }

  function confetti(jackpot) {
    if (reducedMotion.matches || document.hidden) return;
    const canvas = $("confetti");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    const rect = machine.getBoundingClientRect();
    const colors = ["#ffd43b", "#168bff", "#71c837", "#ffffff", "#ffec95"];
    const pieces = Array.from({ length: jackpot ? 150 : 65 }, () => ({
      x: rect.left + rect.width / 2, y: rect.top + rect.height * .5,
      vx: (Math.random() - .5) * (jackpot ? 19 : 14), vy: -6 - Math.random() * 10,
      rotation: Math.random() * Math.PI, speed: (Math.random() - .5) * .25,
      size: 4 + Math.random() * 5, color: colors[Math.floor(Math.random() * colors.length)]
    }));
    const started = performance.now();
    let previous = started;
    function draw(now) {
      const elapsed = now - started;
      const step = Math.min((now - previous) / 16.67, 3);
      previous = now;
      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha = Math.min(1, (2400 - elapsed) / 600);
      pieces.forEach(p => {
        p.x += p.vx * step; p.y += p.vy * step; p.vy += .19 * step; p.rotation += p.speed * step;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rotation); ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * .55); ctx.restore();
      });
      if (elapsed < 2400) confettiFrame = requestAnimationFrame(draw);
      else ctx.clearRect(0, 0, width, height);
    }
    confettiFrame = requestAnimationFrame(draw);
  }

  async function animateReel(column, outcome, token) {
    const strip = strips[column];
    // Animate the whole physical strip, including old symbols, filler, and outcome.
    const travel = 17 + column * 4;
    const symbols = [...board[column]];
    while (symbols.length < travel) symbols.push(pickSymbol());
    symbols.push(...outcome[column]);
    // A tail symbol keeps the small settling overshoot inside populated artwork.
    symbols.push(pickSymbol());
    strip.replaceChildren(...symbols.map(symbolElement));
    // Percentages are relative to the strip itself, so resizing mid-spin stays aligned.
    const finalY = -100 * travel / symbols.length;
    const bounceY = finalY - (100 / symbols.length) * .075;
    const duration = reducedMotion.matches ? 240 + column * 70 : 1940 + column * 190;
    const animation = strip.animate(reducedMotion.matches ? [
      { opacity: .55, transform: `translateY(${finalY}%)` },
      { opacity: 1, transform: `translateY(${finalY}%)` }
    ] : [
      { transform: "translateY(0)", offset: 0, easing: "cubic-bezier(.4,.02,.17,1)" },
      { transform: `translateY(${bounceY}%)`, offset: .94, easing: "ease-out" },
      { transform: `translateY(${finalY}%)`, offset: 1 }
    ], { duration, fill: "forwards" });
    animations.add(animation);
    if (document.hidden) animation.pause();
    // Unexpected cancellation still settles the committed outcome. Reset invalidates the token.
    try { await animation.finished; } catch { /* Normalize below if this session is current. */ }
    if (token !== generation) return;
    animations.delete(animation);
    board[column] = outcome[column];
    // Both changes happen in one task, before paint, leaving exactly three aligned cells.
    animation.cancel();
    renderColumn(column);
    tone(290 + column * 90, .12, "triangle", .06);
  }

  async function spin() {
    if (spinning || !remaining || rulesDialog.open || finishDialog.open) return;
    initAudio();
    clearCelebration();
    stopAudio();
    $("points").textContent = points.toLocaleString();
    const token = ++generation;
    spinning = true;
    remaining--;
    machine.classList.add("is-spinning");
    $("reel-window").setAttribute("aria-busy", "true");
    updateMeters();
    message("A little sunshine is coming your way…");
    const outcome = createOutcome();
    startSpinSound();
    try {
      await Promise.all(reels.map((_, column) => animateReel(column, outcome, token)));
    } catch {
      if (token === generation) { resetGame(); message("Fresh energy! You’re ready to spin again."); }
      return;
    }
    if (token !== generation) return;
    animations.clear();
    clearInterval(spinSoundTimer);
    spinSoundTimer = 0;
    machine.classList.remove("is-spinning");
    $("reel-window").setAttribute("aria-busy", "false");
    describeBoard();
    const result = scoreOutcome(board);
    const previousPoints = points;
    points += result.total;
    syncScore();
    if (result.total) {
      result.lines.forEach(line => {
        for (let column = 0; column < line.length; column++) strips[column].children[line.row].classList.add("winner");
        const highlight = document.createElement("div");
        highlight.className = "payline";
        highlight.style.top = `${(line.row + .5) * 100 / 3}%`;
        highlight.style.right = `${(5 - line.length) * 20}%`;
        $("paylines").append(highlight);
      });
      const lineDetail = result.lines.map(line => `${["Top", "Middle", "Bottom"][line.row]} +${line.points.toLocaleString()}`).join(" · ");
      message(`${result.jackpot ? "SOLAR JACKPOT!" : "That’s some bright energy!"} +${result.total.toLocaleString()} pts · ${lineDetail}`, true);
      if (result.jackpot) machine.classList.add("jackpot");
      countPoints(previousPoints, points, token);
      winSound(result.jackpot);
      confetti(result.jackpot);
    } else {
      const encouragement = ["Keep your sunny side up. Your next spin could shine!", "Still bringing good energy. Give it another spin!", "A little luck is just around the sun."];
      message(remaining ? encouragement[Math.floor(Math.random() * encouragement.length)] : "Five spins of good energy. Thanks for playing!");
    }
    spinning = false;
    updateMeters();
    if (!remaining) {
      $("final-points").textContent = points.toLocaleString();
      $("finish-note").textContent = points ? "Good energy looks good on you. Pass the sunshine on!" : "The brightest part? Clean energy is a win for everyone.";
      finishTimer = setTimeout(() => {
        if (token !== generation) return;
        if (rulesDialog.open) rulesDialog.close();
        finishDialog.showModal();
      }, result.total ? 1700 : 850);
    }
  }

  spinButton.addEventListener("click", spin);
  $("new-player").addEventListener("click", () => { resetGame(); spinButton.focus(); });
  $("next-player").addEventListener("click", () => { resetGame(); spinButton.focus(); });
  $("sound").addEventListener("click", () => {
    muted = !muted;
    $("sound").setAttribute("aria-pressed", String(!muted));
    $("sound").querySelector("span").textContent = muted ? "Sound off" : "Sound on";
    if (muted) stopAudio();
    else { initAudio(); tone(660, .1, "sine", .04); startSpinSound(); }
  });
  [$("how-to-play"), $("prize-info")].forEach(button => button.addEventListener("click", () => rulesDialog.showModal()));
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
  [rulesDialog, finishDialog].forEach(dialog => dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  }));
  $("fullscreen").addEventListener("click", async () => {
    const token = generation;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else { message("Fullscreen isn’t available here. You can keep playing in this window."); }
    } catch { if (token === generation) message("Fullscreen isn’t available here. You can keep playing in this window."); }
  });
  document.addEventListener("fullscreenchange", () => {
    $("fullscreen").querySelector("span").textContent = document.fullscreenElement ? "Exit fullscreen" : "Fullscreen";
  });
  document.addEventListener("keydown", event => {
    if (event.code !== "Space" && event.code !== "Enter") return;
    if (event.altKey || event.ctrlKey || event.metaKey || rulesDialog.open || finishDialog.open) return;
    const control = event.target.closest("button, a, input, select, textarea, [contenteditable]");
    if (control && control !== spinButton) return;
    // Own SPIN's keyboard activation too: native Enter auto-repeat otherwise bypasses this guard.
    event.preventDefault();
    if (event.repeat || heldSpinKeys.has(event.code)) return;
    heldSpinKeys.add(event.code);
    spin();
  });
  document.addEventListener("keyup", event => heldSpinKeys.delete(event.code));
  window.addEventListener("blur", () => heldSpinKeys.clear());

  function restoreVisibility() {
    const hidden = document.hidden;
    document.body.classList.toggle("page-hidden", hidden);
    if (hidden) {
      animations.forEach(animation => animation.pause());
      stopAudio();
    } else {
      animations.forEach(animation => {
        if (animation.playState === "paused") animation.play();
      });
      // Resume only an existing context, created by an earlier user gesture.
      if (!muted && audioContext?.state === "suspended") audioContext.resume().catch(() => {});
      startSpinSound();
      if (!spinning) {
        cancelAnimationFrame(countFrame);
        $("points").textContent = points.toLocaleString();
      }
    }
  }
  document.addEventListener("visibilitychange", restoreVisibility);
  document.addEventListener("resume", restoreVisibility);
  window.addEventListener("focus", restoreVisibility);
  window.addEventListener("pageshow", restoreVisibility);
  resetGame();
}
