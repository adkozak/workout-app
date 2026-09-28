// Small feedback effects: haptics, a rest-over beep, and confetti for PRs.

export function tap(): void {
  navigator.vibrate?.(12);
}

let audio: AudioContext | null = null;

/** Must first be called from a user gesture (a tap) so the browser allows sound later. */
export function unlockAudio(): void {
  if (!audio) audio = new AudioContext();
  if (audio.state === 'suspended') void audio.resume();
}

export function restOver(): void {
  navigator.vibrate?.([400, 150, 400, 150, 400]);
  if (!audio) return;
  const t0 = audio.currentTime;
  [0, 0.25, 0.5].forEach((dt, i) => {
    const osc = audio!.createOscillator();
    const gain = audio!.createGain();
    osc.frequency.value = i === 2 ? 1320 : 880;
    gain.gain.setValueAtTime(0.0001, t0 + dt);
    gain.gain.exponentialRampToValueAtTime(0.3, t0 + dt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.18);
    osc.connect(gain).connect(audio!.destination);
    osc.start(t0 + dt);
    osc.stop(t0 + dt + 0.2);
  });
}

export function confetti(): void {
  navigator.vibrate?.([60, 40, 60, 40, 200]);
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const colors = ['#f5a524', '#3e63dd', '#30a46c', '#e5484d', '#eef1f4'];
  const parts = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 80,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14,
    vy: -Math.random() * 14 - 4,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.4,
    w: 6 + Math.random() * 6,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  const frame = (t: number) => {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.w / 4, p.w, p.w / 2);
      ctx.restore();
    }
    if (t - start < 2600) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
