import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { sb, supabaseAuth, ONLINE } from './backend';
import { CAT_BREEDS, ZONE_BREEDS, CAT_TRAITS, CAT_NAMES_MALE, CAT_NAMES_FEMALE, catArtUrl } from './catData';
import { fetchBreedPhoto, catPhotoFor, warmBreedPhotos, installPhotoFallback } from './photos';
installPhotoFallback();

// ─── Local Reminder Notifications (native app only — no-op on web) ────────────
// Daily nudges to bring lapsed players back: daily gift + mystery dog of the day.
// Uses on-device scheduling only, no push server required.
async function scheduleReminderNotifications() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      const req = await LocalNotifications.requestPermissions();
      if (req.display !== 'granted') return;
    }
    await LocalNotifications.schedule({
      notifications: [
        {
          id: 1001,
          title: '🎁 Your Daily Gift is Ready!',
          body: 'Come back to KittyMart and open your daily gift!',
          schedule: { on: { hour: 17, minute: 0 }, allowWhileIdle: true },
        },
        {
          id: 1002,
          title: '🔮 New Mystery Cat Today!',
          body: "Today's Mystery Cat of the Day is waiting for you in KittyMart!",
          schedule: { on: { hour: 9, minute: 30 }, allowWhileIdle: true },
        },
      ],
    });
  } catch (e) { console.error('Reminder scheduling error:', e); }
}

const APP_VERSION = 158; // build number; shown as v1.<n-137> (141 = v1.4). Bump with public/version.json
(async () => {
  try {
    const res = await fetch(process.env.PUBLIC_URL+'/version.json?t=' + Date.now());
    const { version } = await res.json();
    if (version > APP_VERSION) {
      if ('caches' in window) { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); }
      window.location.reload(true);
    }
  } catch {}
})();

const KM_LOGOS = { 'Halloween':'halloween','Christmas':'christmas','New Year':'newyear','Valentines':'valentine','St Patricks':'stpatrick','Easter':'easter','Summer':'summer' };
function kmLogo(h) {
  const m = new Date().getMonth() + 1;
  const k = (h && KM_LOGOS[h.name]) || (m >= 9 && m <= 11 ? 'autumn' : m >= 3 && m <= 5 ? 'spring' : 'summer');
  return process.env.PUBLIC_URL + '/logos/' + k + '.webp';
}
const RARITY_COLORS = { Common: '#adb5bd', Uncommon: '#4cc9f0', Rare: '#7b2ff7', Epic: '#f72585', Legendary: '#ffd700' };

// ─── Holiday Themes ────────────────────────────────────────────────────────────
function getHolidayTheme() {
  const now = new Date();
  const m = now.getMonth() + 1; // 1-12
  const d = now.getDate();
  // Halloween: all of October + Nov 1. Extra spooky on Oct 31.
  if ((m === 10) || (m === 11 && d === 1)) {
    const extraSpooky = (m === 10 && d === 31);
    const emojis = extraSpooky
      ? ['🎃','💀','👻','🧟','🕷️','🦇','🧙','☠️','🩸','🕯️']
      : ['💀','👻','🎃','🧙','🕷️','🦇'];
    const banner = extraSpooky ? '🎃 BOO! It\'s Halloween Night! 💀 Trick or Treat! 👻' : '💀 Happy Halloween! 🎃';
    return { name: 'Halloween', gradient: 'linear-gradient(135deg,#ff6b00,#1a0533)', nav: '#ff6b00', emojis, banner };
  }
  // Christmas: Dec 20 – Dec 31
  if (m === 12 && d >= 20)
    return { name: 'Christmas', gradient: 'linear-gradient(135deg,#c0392b,#1a5c2a)', nav: '#c0392b', emojis: ['🎄','⭐','🎅','❄️','🦌'], banner: '🎄 Merry Christmas! 🎅' };
  // New Year: Jan 1 – Jan 3
  if (m === 1 && d <= 3)
    return { name: 'New Year', gradient: 'linear-gradient(135deg,#1a1a2e,#e94560)', nav: '#e94560', emojis: ['🎆','🎇','✨','🥂','🎉'], banner: '🎆 Happy New Year! 🎇' };
  // Valentine's Day: Feb 10 – Feb 14
  if (m === 2 && d >= 10 && d <= 14)
    return { name: 'Valentines', gradient: 'linear-gradient(135deg,#e91e8c,#ff6b9d)', nav: '#e91e8c', emojis: ['💕','💝','🌹','💘','🐾'], banner: '💕 Happy Valentine\'s Day! 🌹' };
  // St. Patrick's Day: Mar 15 – Mar 17
  if (m === 3 && d >= 15 && d <= 17)
    return { name: 'St Patricks', gradient: 'linear-gradient(135deg,#1b5e20,#43a047)', nav: '#1b5e20', emojis: ['🍀','☘️','🌈','🎩','🐾'], banner: '☘️ Happy St. Patrick\'s Day! 🍀' };
  // Easter: approximate (Apr 1–20 range, simplified)
  if (m === 4 && d >= 1 && d <= 20)
    return { name: 'Easter', gradient: 'linear-gradient(135deg,#e040fb,#ffca28)', nav: '#e040fb', emojis: ['🐣','🐰','🥚','🌸','🌼'], banner: '🐣 Happy Easter! 🐰' };
  // Australian Summer: Jan 4 – Feb 9 (outside New Year and Valentine's windows)
  if ((m === 1 && d >= 4) || (m === 2 && d <= 9))
    return { name: 'Summer', gradient: 'linear-gradient(135deg,#f7971e,#ffd200)', nav: '#f7971e', emojis: ['☀️','🏖️','🌊','🍦','🐾'], banner: '☀️ Australian Summer! 🏖️ Go catch some beach cats!' };
  // Default — no theme
  return null;
}

// ─── Sound Effects (Web Audio API — no external files needed) ─────────────────
// playSound(type) works everywhere including iOS WebView (user-gesture required
// for the first call, but catch/tap events qualify). Silently no-ops if the
// browser doesn't support AudioContext.
let _audioCtx = null;
function _getAudioCtx() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
  return _audioCtx;
}
function _tone(freq, type, gain, start, dur, ctx) {
  try {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = type; o.frequency.setValueAtTime(freq, ctx.currentTime + start);
    g.gain.setValueAtTime(gain, ctx.currentTime + start);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
    o.start(ctx.currentTime + start);
    o.stop(ctx.currentTime + start + dur + 0.05);
  } catch {}
}
function playSound(type) {
  try {
    const ctx = _getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (type === 'coin') {
      // Classic coin collect: quick ascending ding
      _tone(988,  'sine', 0.18, 0,    0.07, ctx);
      _tone(1319, 'sine', 0.18, 0.07, 0.12, ctx);
    } else if (type === 'catch') {
      // Satisfying catch pop — two quick notes
      _tone(523, 'sine', 0.15, 0,    0.06, ctx);
      _tone(784, 'sine', 0.18, 0.06, 0.14, ctx);
    } else if (type === 'epic') {
      // Epic ascent
      _tone(659, 'sine', 0.18, 0,    0.08, ctx);
      _tone(784, 'sine', 0.18, 0.08, 0.08, ctx);
      _tone(1047,'sine', 0.20, 0.16, 0.20, ctx);
    } else if (type === 'legendary') {
      // Legendary fanfare — majestic 4-note rise
      _tone(523, 'sine', 0.18, 0,    0.10, ctx);
      _tone(659, 'sine', 0.18, 0.10, 0.10, ctx);
      _tone(784, 'sine', 0.18, 0.20, 0.10, ctx);
      _tone(1047,'sine', 0.22, 0.30, 0.35, ctx);
      _tone(1319,'sine', 0.20, 0.55, 0.40, ctx);
    } else if (type === 'achievement') {
      // Achievement chime — warm triad
      _tone(523, 'triangle', 0.14, 0,    0.15, ctx);
      _tone(659, 'triangle', 0.14, 0.08, 0.18, ctx);
      _tone(784, 'triangle', 0.16, 0.16, 0.25, ctx);
      _tone(1047,'triangle', 0.14, 0.28, 0.30, ctx);
    } else if (type === 'combo') {
      // Rapid ascending arpeggio
      [523,587,659,698,784].forEach((f,i) => _tone(f,'square',0.08,i*0.04,0.10,ctx));
    } else if (type === 'win') {
      // Race win / big reward — triumphant
      _tone(523, 'sine', 0.17, 0,    0.12, ctx);
      _tone(659, 'sine', 0.17, 0.12, 0.12, ctx);
      _tone(784, 'sine', 0.17, 0.24, 0.12, ctx);
      _tone(1047,'sine', 0.20, 0.36, 0.30, ctx);
      _tone(784, 'sine', 0.16, 0.66, 0.12, ctx);
      _tone(1047,'sine', 0.20, 0.78, 0.45, ctx);
    } else if (type === 'streak') {
      // 7-day streak — jubilant cascade
      [523,659,784,1047,1319,1568].forEach((f,i) => _tone(f,'sine',0.16,i*0.08,0.18,ctx));
    } else if (type === 'tap') {
      // Light UI tap feedback
      _tone(880, 'sine', 0.08, 0, 0.05, ctx);
    } else if (type === 'firework') {
      // Launch thump, then a short sparkly crackle
      _tone(110, 'sine', 0.22, 0, 0.18, ctx);
      [1568,1760,2093,1319,2349,1976].forEach((f,i) => _tone(f,'triangle',0.05,0.12+i*0.05,0.09,ctx));
    } else if (type === 'gift') {
      // Gift opened: rising sparkle
      [784,988,1175,1568,1976].forEach((f,i) => _tone(f,'sine',0.13,i*0.07,0.16,ctx));
    } else if (type === 'reward') {
      // Spinning reward reveal
      _tone(440, 'sine', 0.12, 0,    0.08, ctx);
      _tone(554, 'sine', 0.14, 0.08, 0.10, ctx);
      _tone(659, 'sine', 0.16, 0.18, 0.14, ctx);
      _tone(880, 'sine', 0.18, 0.32, 0.25, ctx);
    }
  } catch {}
}

// ─── Floating Score Popup ──────────────────────────────────────────────────────
// Fires a "+50 ⭐" label that floats up from the middle of the screen and fades.
// Triggered via CustomEvent: km_score_popup { detail: { text, color } }
function FloatingScorePopup() {
  const [items, setItems] = React.useState([]);
  React.useEffect(() => {
    const handler = (e) => {
      const id = Date.now() + Math.random();
      const text  = e.detail?.text  || '+pts';
      const color = e.detail?.color || '#f4a261';
      setItems(prev => [...prev, { id, text, color }]);
      setTimeout(() => setItems(prev => prev.filter(i => i.id !== id)), 1400);
    };
    window.addEventListener('km_score_popup', handler);
    return () => window.removeEventListener('km_score_popup', handler);
  }, []);
  if (!items.length) return null;
  return (
    <div style={{ position:'fixed', inset:0, pointerEvents:'none', zIndex:9998 }}>
      <style>{`
        @keyframes floatScore {
          0%   { opacity:1; transform:translateY(0) scale(1.2); }
          60%  { opacity:1; transform:translateY(-60px) scale(1); }
          100% { opacity:0; transform:translateY(-100px) scale(0.85); }
        }
      `}</style>
      {items.map(item => (
        <div key={item.id} style={{
          position:'absolute', left:'50%', top:'40%',
          transform:'translateX(-50%)',
          fontSize:28, fontWeight:900, color:item.color,
          textShadow:'0 2px 8px rgba(0,0,0,0.4)',
          animation:'floatScore 1.4s ease-out forwards',
          whiteSpace:'nowrap',
        }}>{item.text}</div>
      ))}
    </div>
  );
}
function fireScorePopup(text, color = '#f4a261') {
  try { window.dispatchEvent(new CustomEvent('km_score_popup', { detail: { text, color } })); } catch {}
}

// ─── Big Win Modal (Candy Crush-style reward reveal) ──────────────────────────
// Triggered via CustomEvent: km_bigwin { detail: { title, subtitle, emoji, color, duration } }
function BigWinModal() {
  const [win, setWin] = React.useState(null);
  const [show, setShow] = React.useState(false);
  React.useEffect(() => {
    const handler = (e) => {
      setWin(e.detail || {});
      setShow(true);
      const dur = e.detail?.duration || 2800;
      setTimeout(() => { setShow(false); setTimeout(() => setWin(null), 400); }, dur);
    };
    window.addEventListener('km_bigwin', handler);
    return () => window.removeEventListener('km_bigwin', handler);
  }, []);
  if (!win) return null;
  const color = win.color || '#ffd700';
  return (
    <>
      <style>{`
        @keyframes bigWinIn  { 0%{opacity:0;transform:scale(0.4) rotate(-8deg);} 65%{transform:scale(1.08) rotate(2deg);} 100%{opacity:1;transform:scale(1) rotate(0deg);} }
        @keyframes bigWinOut { 0%{opacity:1;transform:scale(1);} 100%{opacity:0;transform:scale(1.15);} }
        @keyframes shinePulse { 0%,100%{box-shadow:0 0 0 0 ${color}88;} 50%{box-shadow:0 0 60px 20px ${color}55;} }
        @keyframes starSpin { 0%{transform:rotate(0deg) scale(1);} 50%{transform:rotate(180deg) scale(1.3);} 100%{transform:rotate(360deg) scale(1);} }
        @keyframes bounceIn { 0%{transform:scale(0);opacity:0;} 70%{transform:scale(1.2);opacity:1;} 100%{transform:scale(1);} }
      `}</style>
      <div style={{
        position:'fixed', inset:0, zIndex:10000, pointerEvents:'none',
        display:'flex', alignItems:'center', justifyContent:'center',
        background: show ? 'rgba(0,0,0,0.45)' : 'transparent',
        transition:'background 0.4s',
      }}>
        <div style={{
          background:`linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)`,
          border:`3px solid ${color}`,
          borderRadius:28,
          padding:'32px 40px',
          textAlign:'center',
          maxWidth:300,
          width:'90%',
          animation: show ? 'bigWinIn 0.5s cubic-bezier(0.34,1.56,0.64,1) forwards, shinePulse 1.5s 0.5s ease-in-out infinite' : 'bigWinOut 0.4s ease-in forwards',
          position:'relative',
          overflow:'hidden',
        }}>
          {/* Shimmer overlay */}
          <div style={{ position:'absolute', inset:0, background:`linear-gradient(135deg, transparent 0%, ${color}22 50%, transparent 100%)`, borderRadius:26, pointerEvents:'none' }} />
          <div style={{ fontSize:64, lineHeight:1, marginBottom:8, animation:'bounceIn 0.6s 0.2s both' }}>{win.emoji || '🏆'}</div>
          <div style={{ fontSize:28, fontWeight:900, color, textShadow:`0 0 20px ${color}`, marginBottom:6, letterSpacing:1 }}>{win.title || 'AMAZING!'}</div>
          {win.subtitle && <div style={{ fontSize:16, color:'rgba(255,255,255,0.85)', fontWeight:'bold', marginBottom:4 }}>{win.subtitle}</div>}
          {win.detail && <div style={{ fontSize:13, color:'rgba(255,255,255,0.6)', marginTop:6 }}>{win.detail}</div>}
          {/* Decorative stars */}
          {['⭐','✨','🌟'].map((s,i) => (
            <div key={i} style={{ position:'absolute', fontSize:20, animation:`starSpin ${1.8+i*0.4}s ${i*0.2}s linear infinite`, opacity:0.7,
              top: i===0?8:i===1?'auto':12, bottom: i===1?8:'auto', left:i===2?8:'auto', right:i===0?10:i===1?14:'auto' }}>{s}</div>
          ))}
        </div>
      </div>
    </>
  );
}
function fireBigWin(title, subtitle, emoji, color, duration = 2800, detail = '') {
  try { window.dispatchEvent(new CustomEvent('km_bigwin', { detail: { title, subtitle, emoji, color, duration, detail } })); } catch {}
}

// ─── Combo Text Burst (Candy Crush-style "AMAZING!" overlays) ─────────────────
const COMBO_LABELS = ['', '', 'NICE! 🔥', 'GREAT! 🔥', 'AMAZING! 💥', 'INCREDIBLE! 🤩'];
function ComboTextBurst() {
  const [burst, setBurst] = React.useState(null);
  React.useEffect(() => {
    const handler = (e) => {
      const combo = e.detail?.combo || 0;
      if (combo < 2) return;
      const label = COMBO_LABELS[Math.min(combo, COMBO_LABELS.length - 1)];
      const id = Date.now();
      setBurst({ id, label, combo });
      setTimeout(() => setBurst(b => b?.id === id ? null : b), 1200);
    };
    window.addEventListener('km_combo', handler);
    return () => window.removeEventListener('km_combo', handler);
  }, []);
  if (!burst) return null;
  const big = burst.combo >= 4;
  return (
    <div style={{
      position:'fixed', inset:0, pointerEvents:'none', zIndex:9997,
      display:'flex', alignItems:'center', justifyContent:'center',
    }}>
      <style>{`
        @keyframes comboBurst { 0%{opacity:0;transform:scale(0.5);} 25%{opacity:1;transform:scale(1.15);} 75%{opacity:1;transform:scale(1);} 100%{opacity:0;transform:scale(0.9);} }
      `}</style>
      <div style={{
        fontSize: big ? 42 : 34, fontWeight:900,
        color: big ? '#ff6b35' : '#ffd700',
        textShadow:`0 0 30px ${big?'#ff6b35':'#ffd700'}, 0 3px 6px rgba(0,0,0,0.6)`,
        animation:'comboBurst 1.2s ease-out forwards',
        letterSpacing:2,
        userSelect:'none',
      }}>{burst.label}</div>
    </div>
  );
}

// ─── Fireworks ────────────────────────────────────────────────────────────────
// Triggered globally via: window.dispatchEvent(new CustomEvent('km_fireworks', { detail: { duration: 3000 } }))
function Fireworks() {
  const canvasRef = React.useRef(null);
  const [active, setActive] = React.useState(false);

  React.useEffect(() => {
    const start = (e) => {
      setActive(true);
      const duration = e?.detail?.duration || 3000;
      for (let t = 0; t < Math.min(duration, 4000); t += 700) setTimeout(() => playSound('firework'), t); // a bang per burst
      setTimeout(() => setActive(false), duration + 500);
    };
    window.addEventListener('km_fireworks', start);
    return () => window.removeEventListener('km_fireworks', start);
  }, []);

  React.useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const particles = [];
    const colors = ['#ff0','#f0f','#0ff','#f55','#5f5','#55f','#fa0','#0af','#fff','#ffd700'];

    function Particle(x, y, color) {
      this.x = x; this.y = y; this.color = color;
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 6 + 2;
      this.vx = Math.cos(angle) * speed;
      this.vy = Math.sin(angle) * speed;
      this.alpha = 1;
      this.decay = Math.random() * 0.015 + 0.01;
      this.size = Math.random() * 3 + 1.5;
      this.gravity = 0.12;
    }

    function burst(x, y) {
      const color = colors[Math.floor(Math.random() * colors.length)];
      const count = Math.floor(Math.random() * 40 + 40);
      for (let i = 0; i < count; i++) particles.push(new Particle(x, y, color));
    }

    // Launch several bursts at random positions across the screen
    const launchCount = 12;
    let launched = 0;
    const intervalId = setInterval(() => {
      if (launched >= launchCount) { clearInterval(intervalId); return; }
      const x = Math.random() * canvas.width * 0.8 + canvas.width * 0.1;
      const y = Math.random() * canvas.height * 0.5 + canvas.height * 0.05;
      burst(x, y);
      launched++;
    }, 250);

    let animId;
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx; p.y += p.vy; p.vy += p.gravity;
        p.vx *= 0.98; p.alpha -= p.decay;
        if (p.alpha <= 0) { particles.splice(i, 1); continue; }
        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.shadowBlur = 8; ctx.shadowColor = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      if (particles.length > 0) animId = requestAnimationFrame(draw);
    }
    draw();

    return () => {
      clearInterval(intervalId);
      cancelAnimationFrame(animId);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [active]);

  if (!active) return null;
  return <canvas ref={canvasRef} style={{ position: 'fixed', inset: 0, zIndex: 9999, pointerEvents: 'none' }} />;
}

function fireFireworks(duration = 3000) {
  try { window.dispatchEvent(new CustomEvent('km_fireworks', { detail: { duration } })); } catch {}
}

function HolidayBanner({ theme }) {
  const [visible, setVisible] = React.useState(true);
  if (!visible || !theme?.banner) return null;
  return (
    <div style={{ background: theme.gradient, color: 'white', textAlign: 'center', padding: '6px 12px', fontSize: 13, fontWeight: 'bold', letterSpacing: 0.5, position: 'relative', animation: 'slideUp 0.4s ease' }}>
      {theme.banner}
      <button onClick={() => setVisible(false)} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>×</button>
    </div>
  );
}

// A confirmation the player has to actively dismiss — used anywhere a result
// (name all dogs, a store purchase, etc.) needs to be unmissable, unlike a
// toast that fades on its own and can go unnoticed.
function AlertPopup({ message, onClose }) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }} onClick={onClose}>
      <div style={{ background:'white', borderRadius:20, padding:24, maxWidth:320, width:'100%', textAlign:'center' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:15, color:'#333', fontWeight:'bold', marginBottom:16, lineHeight:1.4 }}>{message}</div>
        <button onClick={onClose} style={{ width:'100%', padding:'12px', background:'linear-gradient(135deg,#5aab6a,#4a9e5c)', color:'white', border:'none', borderRadius:16, fontWeight:'bold', fontSize:15, cursor:'pointer', boxShadow:'0 4px 12px rgba(74,158,92,0.3)' }}>OK</button>
      </div>
    </div>
  );
}

function FloatingEmojis({ emojis }) {
  const items = React.useMemo(() => {
    if (!emojis?.length) return [];
    return Array.from({ length: 12 }, (_, i) => ({
      emoji: emojis[i % emojis.length],
      left: Math.random() * 100,
      delay: Math.random() * 8,
      dur: 6 + Math.random() * 6,
      size: 14 + Math.floor(Math.random() * 14),
    }));
  }, [emojis]);
  if (!items.length) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 0 }}>
      <style>{`
        @keyframes floatUp { 0%{transform:translateY(110vh) rotate(0deg);opacity:0.8} 100%{transform:translateY(-10vh) rotate(360deg);opacity:0} }
      `}</style>
      {items.map((it, i) => (
        <span key={i} style={{ position: 'absolute', bottom: 0, left: `${it.left}%`, fontSize: it.size, animation: `floatUp ${it.dur}s ${it.delay}s linear infinite`, opacity: 0 }}>
          {it.emoji}
        </span>
      ))}
    </div>
  );
}
const RARITY_POINTS = { Common: 1, Uncommon: 6, Rare: 10, Epic: 35, Legendary: 50 };
const RARITY_WEIGHTS = { Common: 50, Uncommon: 28, Rare: 14, Epic: 5, Legendary: 3 };

// ─── Live-Ops Events ───────────────────────────────────────────────────────────
// A small, code-driven events calendar. Add/remove entries here to run limited-time
// content without touching game logic elsewhere — first matching event wins.
const LIVE_EVENTS = [
  {
    id: 'mega_weekend',
    label: '🌟 Mega Weekend!',
    desc: 'First weekend of the month — best odds of the month plus 1.5x points!',
    isActive: () => { const d = new Date(); return (d.getDay() === 0 || d.getDay() === 6) && d.getDate() <= 7; },
    weights: { Common: 20, Uncommon: 26, Rare: 26, Epic: 18, Legendary: 10 },
    pointsMultiplier: 1.5,
  },
  {
    id: 'weekend',
    label: '🎉 Weekend Bonus!',
    desc: 'Epic & Legendary cats appear more often this weekend!',
    isActive: () => { const day = new Date().getDay(); return day === 0 || day === 6; },
    weights: { Common: 30, Uncommon: 28, Rare: 22, Epic: 12, Legendary: 8 },
  },
  {
    id: 'double_point_wednesday',
    label: '⭐ Double Point Wednesday!',
    desc: 'Every cat you catch today is worth double points!',
    isActive: () => new Date().getDay() === 3,
    weights: RARITY_WEIGHTS,
    pointsMultiplier: 2,
  },
];
function getActiveEvent() {
  return LIVE_EVENTS.find(e => e.isActive()) || null;
}

// Season number (months since Jan 2024)
function getCurrentSeason() {
  const now = new Date();
  return Math.max(1, (now.getFullYear() - 2026) * 12 + now.getMonth() - 9); // Season 1 = Nov 2026
}

const CUSTOM_BREED_ART = {};
const PROTECTED_DOG_IDS = new Set();
function dogImageSrc(dog) {
  if (!dog) return null;
  if (dog.id) {
    const custom = localStorage.getItem(`km_photo_${dog.id}`);
    if (custom) return custom;
  }
  return catPhotoFor(dog) || (dog.breed ? catArtUrl(dog.breed) : null);
}
async function resolveDogPhoto(dog) {
  if (!dog) return null;
  const own = catPhotoFor(dog);
  if (own) return own;
  const b = dog.breed ? CAT_BREEDS.find(x => x.name === dog.breed) : null;
  return (b && await fetchBreedPhoto(b)) || (dog.breed && catArtUrl(dog.breed)) || null;
}
const DOG_BREEDS = CAT_BREEDS;
window._DOG_BREEDS = DOG_BREEDS;

const ZONES = {
  home:        { label: '🏠 Home',        desc: 'Backyard & neighbourhood cats',   color: '#a8dadc' },
  park:        { label: '🌳 Park',         desc: 'Active & playful breeds',         color: '#a8edab' },
  beach:       { label: '🏖️ Beach',        desc: 'Water-loving breeds',             color: '#f4e04d' },
  city:        { label: '🏙️ City',         desc: 'Trendy city breeds',              color: '#c0c0d8' },
  countryside: { label: '🌾 Countryside',  desc: 'Working cat breeds',              color: '#e9c46a' },
  shopping:    { label: '🛍️ Shopping',     desc: 'Pampered & fancy breeds',         color: '#f4a0c0' },
  aussie:      { label: '🦘 Aussie',       desc: 'Australian breeds — rare finds!', color: '#c8e6c9' },
};

async function detectZone(lat, lon) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();
    const type = data.type || '';
    const category = data.class || '';
    const address = data.address || {};
    const road = (address.road || '').toLowerCase();
    const amenity = (address.amenity || '').toLowerCase();
    const suburb = address.suburb || address.neighbourhood || address.residential || '';
    const cityDistrict = address.city_district || '';
    const postcode = address.postcode || '';

    // Beach detection
    if (['beach','coastline','sand'].includes(type) || road.includes('beach') || road.includes('esplanade') || road.includes('foreshore')) return 'beach';

    // Park / nature
    if (['park','garden','nature_reserve','recreation_ground','grass','forest','wood'].includes(type) || amenity.includes('park') || category === 'leisure') return 'park';

    // Countryside / rural — no suburb or city attached
    if (['farmland','meadow','scrub','heath','allotments'].includes(type) || category === 'natural') return 'countryside';

    // Shopping centre
    if (['retail','mall','supermarket','commercial'].includes(type) || (category === 'commercial' && !suburb)) return 'shopping';

    // Suburb = HOME. If there's a suburb name and it's residential, that's home.
    if (suburb || address.residential || ['residential','house','apartments','terrace'].includes(type)) return 'home';

    // Only call it city if it's genuinely dense urban with no suburb
    if (address.city && !suburb && ['commercial','industrial'].includes(category)) return 'city';

    // Default to home — most people catch from home
    return 'home';
  } catch { return 'home'; }
}

// ─── Active power-up boosts (shared, timed, stored in localStorage `km_boosts`) ─
function isBoostActive(id) {
  try { const b = JSON.parse(localStorage.getItem('km_boosts') || '{}'); return !!(b[id] && Date.now() < b[id]); } catch { return false; }
}
// Legendary Bait multiplies the Legendary catch weight while active.
function applyLegendaryBait(weights) {
  if (!isBoostActive('legendary_bait')) return weights;
  return { ...weights, Legendary: (weights.Legendary || 3) * 6 };
}

function getBreedForZone(zone) {
  const pool = ZONE_BREEDS[zone] || ZONE_BREEDS.home;
  const candidates = DOG_BREEDS.filter(b => pool.includes(b.name));
  if (!candidates.length) return DOG_BREEDS[Math.floor(Math.random() * DOG_BREEDS.length)];
  const weights = applyLegendaryBait(RARITY_WEIGHTS);
  const total = candidates.reduce((s, b) => s + (weights[b.rarity] || 10), 0);
  let roll = Math.random() * total;
  for (const b of candidates) { roll -= (weights[b.rarity] || 10); if (roll <= 0) return b; }
  return candidates[0];
}

function getRandomBreed() {
  const event = getActiveEvent();
  const weights = applyLegendaryBait(event ? event.weights : RARITY_WEIGHTS);
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let roll = Math.random() * total; let cum = 0;
  const byRarity = {};
  DOG_BREEDS.forEach(b => { if (!byRarity[b.rarity]) byRarity[b.rarity] = []; byRarity[b.rarity].push(b); });
  for (const [rarity, weight] of Object.entries(weights)) {
    cum += weight;
    if (roll < cum) { const pool = byRarity[rarity]; return pool[Math.floor(Math.random() * pool.length)]; }
  }
  return DOG_BREEDS[0];
}

function calcPoints(dogs) {
  return dogs.reduce((sum, d) => sum + (RARITY_POINTS[d.rarity] || 0), 0);
}
// Small per-player summary cached on the device so the home stats can paint instantly,
// before the (paged) dog list has finished downloading.
function summarizeDogs(dogs) {
  return { count: dogs.length, pts: calcPoints(dogs), breeds: new Set(dogs.map(d => d.breed)).size };
}
function readCachedStats(playerId) {
  try { return JSON.parse(localStorage.getItem('kittymart_stats_' + playerId)) || null; } catch { return null; }
}
// Dog pages are big (up to ~350 KB each); on a weak connection one slow page used to fail the whole collection load.
// Give each page a longer timeout and retry it on its own.
const fetchDogPage = async (path) => {
  let err;
  for (let i = 0; i < 3; i++) {
    try { return await sb(path, 'GET', null, 25000); }
    catch (e) { err = e; await new Promise(r => setTimeout(r, 600 * (i + 1))); }
  }
  throw err;
};
// ── Server-authoritative bonus points ────────────────────────────────────────
// The DB (players.bonus_pts) is the ONLY source of truth — no localStorage,
// no debounce timer, no flush-on-close. Every award is an atomic increment
// written to Supabase immediately. The local _bonusPts is a display cache only.
//
// Offline resilience: failed writes go into _offlineQueue and are replayed the
// moment the browser reports it is back online. The queue uses deltas (not
// absolute values) so concurrent sessions on different devices don't clobber
// each other — each device just adds its own earned amount.
// Seed from the on-device cache so the first paint shows the last known value instead of 0;
// the DB fetch on login still overrides it.
let _bonusPts = (() => { try { return Math.max(0, parseInt(localStorage.getItem('km_bonus_pts') || '0', 10)) || 0; } catch { return 0; } })();
let _bonusPtsPlayerId = null;
let _bonusPtsLoaded = false;   // true once DB value has been fetched on login
let _pendingBonusDeltas = [];  // deltas earned before login restore completes
let _offlineQueue = [];        // deltas that failed to reach DB (offline)

function getBonusPts() { return _bonusPts; }

// ── Debounced bonus-pts write ─────────────────────────────────────────────────
// Rapid point awards (e.g. picking up many poos quickly) used to race each
// other: every addBonusPts fired its own PATCH immediately, and the last one
// to arrive at the DB won — earlier earned points were silently overwritten.
//
// Fix: accumulate all deltas in _pendingWriteDelta and flush at most once per
// 600ms. The flush writes _bonusPts (the local running total) as the absolute
// value. Because we hold off until the burst is over, only ONE write lands per
// activity, and it always carries the full accumulated total.
let _pendingWriteDelta = 0;
let _writeDebounceTimer = null;
const WRITE_DEBOUNCE_MS = 600;

async function _flushBonusPts() {
  _writeDebounceTimer = null;
  const delta = _pendingWriteDelta;
  _pendingWriteDelta = 0;
  if (!_bonusPtsPlayerId || delta === 0) return;
  try {
    // Read current DB value first, then write our local total only if it is
    // higher — protects against a stale local value clobbering a concurrent
    // write from another device.
    const current = await sb(`players?id=eq.${_bonusPtsPlayerId}&select=bonus_pts`);
    const dbVal = current && current[0] ? Math.max(0, parseInt(current[0].bonus_pts || 0, 10)) : 0;
    const writeVal = Math.max(dbVal + delta, _bonusPts);
    const rows = await sb(
      `players?id=eq.${_bonusPtsPlayerId}&select=bonus_pts`,
      'PATCH',
      { bonus_pts: writeVal }
    );
    if (rows && rows[0]) {
      _bonusPts = Math.max(0, parseInt(rows[0].bonus_pts || 0, 10));
      try { localStorage.setItem('km_bonus_pts', String(_bonusPts)); } catch {}
      window.dispatchEvent(new Event('km_pts_change'));
    }
  } catch {
    // Write failed (offline) — queue the delta for replay
    _offlineQueue.push(delta);
  }
}

function _writeBonusDelta(delta) {
  _pendingWriteDelta += delta;
  if (_writeDebounceTimer) clearTimeout(_writeDebounceTimer);
  _writeDebounceTimer = setTimeout(_flushBonusPts, WRITE_DEBOUNCE_MS);
}

// Public API — called everywhere a player earns points.
// Optimistically updates the local display value immediately so the UI is
// instant, then schedules a debounced DB write.
function addBonusPts(delta) {
  _bonusPts = Math.max(0, _bonusPts + delta);
  // Always mirror to localStorage as a safety net
  try { localStorage.setItem('km_bonus_pts', String(_bonusPts)); } catch {}
  window.dispatchEvent(new Event('km_pts_change'));
  if (!_bonusPtsLoaded) {
    // Login restore hasn't finished yet — queue delta, apply when ready
    _pendingBonusDeltas.push(delta);
    return _bonusPts;
  }
  _writeBonusDelta(delta);
  saveNow();
  return _bonusPts;
}

// Replay queued offline writes when connection is restored
window.addEventListener('online', async () => {
  if (!_bonusPtsPlayerId || !_bonusPtsLoaded || _offlineQueue.length === 0) return;
  const queued = _offlineQueue.splice(0);
  const total = queued.reduce((s, d) => s + d, 0);
  if (total !== 0) {
    _bonusPts = Math.max(0, _bonusPts + total);
    await _writeBonusDelta(total);
  }
});
function getTotalPts(dogs) { return calcPoints(dogs) + getBonusPts(); }
// useLive — subscribe to a custom event and return the latest getter value
function useLive(getter, event) {
  const [val, setVal] = useState(getter);
  useEffect(() => {
    const h = () => setVal(getter());
    window.addEventListener(event, h);
    return () => window.removeEventListener(event, h);
  }, []); // eslint-disable-line
  return val;
}

// ─── Cloud backup helpers — pack/restore player_data JSONB ───────────────────
// players.player_data is the authoritative cloud source of truth for every km_*
// localStorage key (points, achievements, cosmetics, per-dog state, daily
// challenges, house layout, avatar, nicknames, counters, etc.).
// Every km_* localStorage write automatically schedules a cloud save (2s debounce)
// via the setItem intercept below — no per-key wiring needed anywhere in the app.
function packPlayerData() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('km_') && !k.startsWith('km_db_') && !k.startsWith('km_catapi_') && !k.startsWith('km_cataas_')) { try { const v = localStorage.getItem(k); if (v != null) out[k] = v; } catch {} }
  }
  return out;
}
// ── Compressed cloud backup ──────────────────────────────────────────────────
// A big player's saved data is ~2 MB of JSON (one entry per dog). Storing and reading a 2 MB row over and over was
// pushing the (small) Supabase database out of memory, so it is gzip-compressed on the phone first (~10x smaller)
// and stored as { z: <base64 gzip>, v: 2 }. Old uncompressed rows are still read as before, and if compression is not
// available on a device the plain object is sent exactly as it used to be.
function _toB64(bytes) { let s = ''; const CH = 0x8000; for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); return btoa(s); }
function _fromB64(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
async function _pipeBytes(bytes, stream) { const w = stream.writable.getWriter(); w.write(bytes); w.close(); return new Uint8Array(await new Response(stream.readable).arrayBuffer()); }
async function packPlayerDataZ() {
  const raw = packPlayerData();
  try {
    if (typeof CompressionStream === 'undefined') return raw;
    // Put each dog's entries (state, gender, nickname) next to each other: their random 36-character ids then repeat
    // within gzip's window and compress away, instead of appearing three times far apart.
    const ordered = {}, groups = {}, rest = [];
    for (const k of Object.keys(raw)) { const m = /^km_(?:dog|gender|nick)_(.+)$/.exec(k); if (m) (groups[m[1]] = groups[m[1]] || []).push(k); else rest.push(k); }
    rest.forEach(k => { ordered[k] = raw[k]; });
    Object.keys(groups).forEach(id => groups[id].forEach(k => { ordered[k] = raw[k]; }));
    const z = _toB64(await _pipeBytes(new TextEncoder().encode(JSON.stringify(ordered)), new CompressionStream('gzip')));
    return { z, v: 2 };
  } catch { return raw; }
}
async function unpackPlayerData(data) {
  if (!data || typeof data !== 'object' || typeof data.z !== 'string') return data; // old uncompressed format (or nothing)
  try { return JSON.parse(new TextDecoder().decode(await _pipeBytes(_fromB64(data.z), new DecompressionStream('gzip')))); }
  catch { return null; } // can't read it on this device: leave the local data untouched
}
// Cloud always wins on restore — overwrites whatever is in localStorage.
// Dedicated DB columns (bonus_pts, race_wins, kitty_dollars) are applied
// AFTER this in the login restore, so they take precedence over the JSONB backup.
// Merge one dog's saved state (feeding, poo, level) from the cloud copy and this device's copy, keeping whichever is
// newer. Without this, a feed/poo pickup whose upload hadn't finished when the app was closed was overwritten by the
// older cloud copy the next time the app opened ("feeding resets when I leave the app").
function mergeDogState(cloud, local) {
  if (!cloud || !local) return cloud || local;
  const lc = local.level || 1, cc = cloud.level || 1;
  const localFresher = (local.lastFed || 0) >= (cloud.lastFed || 0);
  return {
    ...cloud, ...local,
    lastFed: Math.max(local.lastFed || 0, cloud.lastFed || 0),
    lastPoo: Math.max(local.lastPoo || 0, cloud.lastPoo || 0),
    level: Math.max(lc, cc),
    xp: lc === cc ? Math.max(local.xp || 0, cloud.xp || 0) : (lc > cc ? (local.xp || 0) : (cloud.xp || 0)),
    hunger: localFresher ? (local.hunger ?? cloud.hunger) : (cloud.hunger ?? local.hunger),
    skills: { ...(cloud.skills || {}), ...(local.skills || {}) },
  };
}
function restorePlayerData(data) {
  if (!data || typeof data !== 'object') return;
  Object.entries(data).forEach(([k, v]) => {
    if (k.startsWith('km_') && v != null) {
      try {
        const existing = localStorage.getItem(k);
        if (existing === v) return; // unchanged: skip the write (22,000 synchronous writes on every login was slow)
        if (k === 'km_dx') { // compact per-dog map from the cloud: merge each dog into ours
          let cloud = null; try { cloud = JSON.parse(v); } catch {}
          if (cloud && typeof cloud === 'object') {
            const m = dxLoad();
            Object.keys(cloud).forEach(id => {
              const ce = cloud[id], le = m[id];
              const merged = _dxFromState(mergeDogState(_dxToState(ce), le ? _dxToState(le) : null));
              merged[5] = ce[5] || (le && le[5]) || null; merged[6] = ce[6] || (le && le[6]) || null;
              m[id] = merged;
            });
            _dxDirty++;
          }
          return;
        }
        if (k.startsWith('km_dog_') || k.startsWith('km_gender_') || k.startsWith('km_nick_')) { // old-format backup
          const id = k.startsWith('km_dog_') ? k.slice(7) : k.startsWith('km_gender_') ? k.slice(10) : k.slice(8);
          if (k.startsWith('km_dog_')) { let st = null; try { st = JSON.parse(v); } catch {} if (st) _dxMerge(id, st); }
          else if (k.startsWith('km_gender_')) { const e = _dxEntry(id, true); e[5] = v === 'Male' ? 'M' : v === 'Female' ? 'F' : v; _dxDirty++; }
          else { const e = _dxEntry(id, true); e[6] = v; _dxDirty++; }
          return;
        }
        // For daily challenge keys, merge by taking the max progress per task
        // so a cloud restore never wipes out progress made since last save
        if (k.startsWith('km_daily_')) {
          let cloud = {}; try { cloud = JSON.parse(v); } catch {}
          let local = {}; try { local = JSON.parse(localStorage.getItem(k) || '{}'); } catch {}
          const merged = { ...cloud };
          Object.keys(local).forEach(id => {
            merged[id] = Math.max(merged[id] || 0, local[id] || 0);
          });
          localStorage.setItem(k, JSON.stringify(merged));
        } else {
          localStorage.setItem(k, v);
        }
      } catch {}
    }
  });
  dxFlushNow();
  // Tell DailyChallengeBar to re-read after restore
  try { window.dispatchEvent(new CustomEvent('km_challenge_update')); } catch {}
  try { window.dispatchEvent(new Event('km_dog_change')); } catch {}
}

// ─── Cloud-first sync infrastructure ─────────────────────────────────────────
// Every km_* localStorage write schedules a debounced cloud save so dog state,
// achievements, cosmetics, streaks, house, etc. sync to Supabase periodically.
// Debounce is 5s — short enough that closing the app after feeding doesn't lose data.
let _scheduledSave = null;
function scheduleSave() {
  if (!_bonusPtsPlayerId) return;
  if (_scheduledSave) clearTimeout(_scheduledSave); // reset timer on each write so we always get the latest state
  _scheduledSave = setTimeout(async () => {
    _scheduledSave = null;
    try { await sb(`players?id=eq.${_bonusPtsPlayerId}`, 'PATCH', { player_data: await packPlayerDataZ() }, 30000); } catch {}
  }, 5 * 1000);
}
// Flush immediately — call after important actions like feeding so state is never lost
async function saveNow() {
  if (!_bonusPtsPlayerId) return;
  if (_scheduledSave) { clearTimeout(_scheduledSave); _scheduledSave = null; }
  try { await sb(`players?id=eq.${_bonusPtsPlayerId}`, 'PATCH', { player_data: await packPlayerDataZ() }, 30000); } catch {}
}
// Intercept localStorage.setItem so any km_* write automatically triggers a save.
(function () {
  const _orig = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (key, value) {
    _orig(key, value);
    if (key && key.startsWith('km_') && !key.startsWith('km_db_')) scheduleSave(); // km_db_* is the offline database itself: saving it would re-trigger a save forever
  };
})();
// On reconnect: flush player_data (cosmetics, achievements, house etc.)
// bonus_pts are handled separately by the offline queue in the points system above.
window.addEventListener('online', async () => {
  if (!_bonusPtsPlayerId) return;
  try { await sb(`players?id=eq.${_bonusPtsPlayerId}`, 'PATCH', { player_data: await packPlayerDataZ() }); } catch {}
});

// ─── Kitty Coins (Ð) — race-earned currency, spent in the Mart ─────────────
const DD = 'Ð'; // Kitty Coin sign (plain text fallback)
function getDD() { try { return parseInt(localStorage.getItem('km_dd') || '0', 10); } catch { return 0; } }
function addDD(delta) { try { const n = Math.max(0, getDD() + delta); localStorage.setItem('km_dd', n); window.dispatchEvent(new Event('km_dd_change')); saveNow(); return n; } catch { return 0; } }
// DDIcon — Kitty Coin symbol
function DDIcon({ size = 18, style = {} }) {
  return (
    <img src={process.env.PUBLIC_URL + "/coin.png"} alt="coin" width={size} height={size}
      style={{ display:'inline-block', verticalAlign:'middle', borderRadius:'50%', marginRight:1, ...style }} />
  );
}
// Ð earned per race place: 1st=10, 2nd=6, 3rd=3, 4th=1
const DD_PLACE = [10, 6, 3, 1];

// ─── Haptic feedback (works on iOS Safari + Android) ─────────────────────────
function haptic(style = 'light') {
  try {
    // On iOS (Capacitor native), navigator.vibrate is not supported — use Capacitor Haptics plugin
    if (Capacitor.isNativePlatform()) {
      // Dynamically import to avoid errors if plugin isn't installed
      import('@capacitor/haptics').then(({ Haptics, ImpactStyle, NotificationType }) => {
        try {
          if (style === 'success') Haptics.notification({ type: NotificationType.Success });
          else if (style === 'heavy') Haptics.impact({ style: ImpactStyle.Heavy });
          else if (style === 'medium') Haptics.impact({ style: ImpactStyle.Medium });
          else Haptics.impact({ style: ImpactStyle.Light });
        } catch {}
      }).catch(() => {});
      return;
    }
    // Web fallback
    if (!navigator.vibrate) return;
    const patterns = { light: [10], medium: [30], heavy: [60], success: [10, 50, 30] };
    navigator.vibrate(patterns[style] || [10]);
  } catch {}
}

// ─── Today's featured dog ─────────────────────────────────────────────────────
function getFeaturedDog() {
  const dayIdx = Math.floor(Date.now() / 86400000);
  return DOG_BREEDS[dayIdx % DOG_BREEDS.length];
}

// ─── Dog of the Week ────────────────────────────────────────────────────────
// Rotates every 7 days, always an Epic or Legendary breed.
// Returns { breed, weekIdx, msUntilRotation }
function getDogOfTheWeek() {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const weekIdx = Math.floor(now / WEEK_MS);
  const msUntilRotation = WEEK_MS - (now % WEEK_MS);
  const elites = DOG_BREEDS.filter(b => b.rarity === 'Epic' || b.rarity === 'Legendary');
  if (!elites.length) return null;
  const breed = elites[weekIdx % elites.length];
  return { breed, weekIdx, msUntilRotation };
}

function formatCountdown(ms) {
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── Dog Personality Traits ───────────────────────────────────────────────────
const DOG_TRAITS = CAT_TRAITS;
function getDogTraits(dogId) {
  const key = `km_traits_${dogId}`;
  const stored = localStorage.getItem(key);
  if (stored) { try { return JSON.parse(stored); } catch {} }
  // Assign deterministically based on dog id hash
  const hash = dogId.split('').reduce((a,c) => a + c.charCodeAt(0), 0);
  const traits = [];
  for (let i = 0; i < 3; i++) traits.push(DOG_TRAITS[(hash * (i + 7)) % DOG_TRAITS.length]);
  // Ensure no duplicates
  const unique = [...new Set(traits)];
  while (unique.length < 3) unique.push(DOG_TRAITS[(hash + unique.length * 13) % DOG_TRAITS.length]);
  localStorage.setItem(key, JSON.stringify(unique.slice(0,3)));
  return unique.slice(0,3);
}

// ─── Onboarding helpers ───────────────────────────────────────────────────────
function hasSeenOnboarding() { return localStorage.getItem('km_onboarded') === '1'; }
function markOnboardingDone() { localStorage.setItem('km_onboarded', '1'); }


// ─── Login Streak helpers ──────────────────────────────────────────────────────
function checkLoginStreak() {
  try {
    const today = new Date().toDateString();
    const last  = localStorage.getItem('km_last_login');
    let streak  = parseInt(localStorage.getItem('km_streak') || '0', 10);
    let reward  = 0;
    if (last === today) return { streak, reward, isNew: false };
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    if (last === yesterday) { streak++; } else { streak = 1; }
    reward = Math.min(streak * 5, 50); // 5pts/day, capped at 50
    addBonusPts(reward);
    localStorage.setItem('km_streak', streak);
    localStorage.setItem('km_last_login', today);
    return { streak, reward, isNew: true };
  } catch { return { streak: 1, reward: 0, isNew: false }; }
}

// ─── Dog Life System helpers ──────────────────────────────────────────────────
// ── Compact per-dog store ─────────────────────────────────────────────────────
// Each dog used to take three localStorage entries (km_dog_<id>, km_gender_<id>, km_nick_<id>), each repeating the dog's
// 36-character id. For a 7,000-dog collection that was ~1.7M characters and filled the app's small storage area, so
// feeding, poo pickups and names silently failed to save. Everything per dog now lives in ONE entry, km_dx:
//   { <dogId>: [level, xp, hunger, lastFed, lastPoo, gender, nick, skills, extras] }   (~60% smaller)
// The whole map is kept in memory; it is written back (debounced) with a single setItem.
let _dx = null, _dxTimer = null, _dxDirty = 0;
const DX_KNOWN = ['level', 'xp', 'hunger', 'lastFed', 'lastPoo', 'skills'];
const DX_DEFAULT = () => ({ level: 1, xp: 0, hunger: 100, lastFed: 0, skills: {}, lastPoo: 0 });
function _dxFromState(st) {
  const extras = {}; let hasExtra = false;
  Object.keys(st || {}).forEach(k => { if (!DX_KNOWN.includes(k)) { extras[k] = st[k]; hasExtra = true; } });
  const sk = st && st.skills && Object.keys(st.skills).length ? st.skills : null;
  return [st.level || 1, st.xp || 0, st.hunger == null ? 100 : st.hunger, st.lastFed || 0, st.lastPoo || 0, null, null, sk, hasExtra ? extras : null];
}
function _dxEntry(id, create) {
  const m = dxLoad();
  if (!m[id] && create) m[id] = [1, 0, 100, 0, 0, null, null, null, null];
  return m[id];
}
function dxLoad() {
  if (_dx) return _dx;
  _dx = {};
  try { const raw = localStorage.getItem('km_dx'); if (raw) _dx = JSON.parse(raw) || {}; } catch { _dx = {}; }
  dxMigrateOldKeys();
  return _dx;
}
// One-time move of the old per-dog keys into the compact map (also runs after a cloud restore of an old-format backup).
// Done in chunks: for each chunk the old keys are removed BEFORE the map is written, so a phone whose storage is already
// full still has room for the (much smaller) compact copy. If a write ever fails, the removed keys are put back.
function dxMigrateOldKeys() {
  const old = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('km_dog_') || k.startsWith('km_gender_') || k.startsWith('km_nick_'))) old.push(k);
    }
  } catch {}
  const CHUNK = 1500;
  for (let i = 0; i < old.length; i += CHUNK) {
    const batch = old.slice(i, i + CHUNK).map(k => [k, localStorage.getItem(k)]);
    batch.forEach(([k, v]) => {
      try {
        if (k.startsWith('km_dog_')) { const st = JSON.parse(v); if (st) _dxMerge(k.slice(7), st); }
        else if (k.startsWith('km_gender_')) { const e = _dxEntry(k.slice(10), true); if (v) e[5] = v === 'Male' ? 'M' : v === 'Female' ? 'F' : v; }
        else { const e = _dxEntry(k.slice(8), true); if (v) e[6] = v; }
      } catch {}
    });
    batch.forEach(([k]) => { try { localStorage.removeItem(k); } catch {} });
    if (!dxFlushNow()) { // could not save the compact copy: put the old keys back and stop (the in-memory map still works)
      batch.forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch {} });
      return;
    }
  }
}
function _dxMerge(id, st) {
  const e = _dxEntry(id, true);
  const cur = _dxToState(e);
  const merged = mergeDogState(st, cur.lastFed || cur.lastPoo || cur.xp || cur.level > 1 ? cur : null);
  const ne = _dxFromState(merged); ne[5] = e[5]; ne[6] = e[6];
  _dx[id] = ne; _dxDirty++;
}
function _dxToState(e) {
  const st = { level: e[0] || 1, xp: e[1] || 0, hunger: e[2] == null ? 100 : e[2], lastFed: e[3] || 0, skills: e[7] || {}, lastPoo: e[4] || 0 };
  if (e[8]) Object.assign(st, e[8]);
  return st;
}
function dxFlushNow() {
  clearTimeout(_dxTimer); _dxTimer = null;
  if (!_dx) return true;
  try { localStorage.setItem('km_dx', JSON.stringify(_dx)); _dxDirty = 0; return true; } catch { return false; }
}
function dxScheduleFlush() {
  if (_dxTimer) return;
  _dxTimer = setTimeout(() => {
    _dxTimer = null;
    if (!dxFlushNow()) { try { window.dispatchEvent(new CustomEvent('km_save_status', { detail: { ok: true, failedLocal: Math.max(1, _dxDirty) } })); } catch {} }
  }, 250);
}
try { window.addEventListener('pagehide', () => { if (_dxTimer) dxFlushNow(); }); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && _dxTimer) dxFlushNow(); }); } catch {}
function getDogState(dogId) { const e = dxLoad()[dogId]; return e ? _dxToState(e) : DX_DEFAULT(); }
function getDogNick(id) { const e = dxLoad()[id]; return (e && e[6]) || ''; }
function setDogNick(id, v) { const e = _dxEntry(id, true); e[6] = v || null; _dxDirty++; dxScheduleFlush(); }
function getDogGender(id) { const e = dxLoad()[id]; const g = e && e[5]; return g === 'M' ? 'Male' : g === 'F' ? 'Female' : (g || null); }
function setDogGender(id, g) { const e = _dxEntry(id, true); e[5] = g === 'Male' ? 'M' : g === 'Female' ? 'F' : g; _dxDirty++; dxScheduleFlush(); }
function dxAllStates() { const m = dxLoad(); return Object.keys(m).map(id => _dxToState(m[id])); }
// Debounced saveNow — coalesces rapid-fire saves (e.g. feeding many dogs at once)
// into a single PATCH ~2s after the last call. saveNow() packs every km_* key, which
// is a multi-thousand-entry scan for big collections, so it must not fire mid-gameplay.
// (Each dog's level/xp/lastFed is also PATCHed to the dogs table immediately.)
let _saveNowTimer = null;
function saveNowDebounced() {
  if (_saveNowTimer) clearTimeout(_saveNowTimer);
  _saveNowTimer = setTimeout(() => {
    _saveNowTimer = null;
    saveNow();
  }, 2000);
}

// Bulk mode: power-ups that touch every dog (Litter Scooper, treat bags) used to fire thousands of network saves and
// events at once on big collections, which froze the app and lost the changes. In bulk mode we only write the local
// state per dog and do ONE cloud save at the end.
let _bulkMode = false;
let _bulkLocalFailures = 0; // dogs whose local state could not be written (phone storage full)
// Upload the full player data and report whether it worked, so a failed save is visible instead of silent.
async function saveNowAwait() {
  if (!_bonusPtsPlayerId) return { ok: false, err: 'not logged in yet' };
  if (_scheduledSave) { clearTimeout(_scheduledSave); _scheduledSave = null; }
  let lastErr = '';
  for (let i = 0; i < 2; i++) {
    try { await sb(`players?id=eq.${_bonusPtsPlayerId}`, 'PATCH', { player_data: await packPlayerDataZ() }, 30000); return { ok: true }; }
    catch (e) { lastErr = (e && e.message) || 'unknown error'; await new Promise(r => setTimeout(r, 2500)); }
  }
  return { ok: false, err: lastErr };
}
function runBulk(fn) {
  _bulkMode = true; _bulkLocalFailures = 0;
  try { fn(); } finally { _bulkMode = false; }
  if (!dxFlushNow()) _bulkLocalFailures = Math.max(1, _dxDirty);
  try {
    window.dispatchEvent(new Event('km_dog_change'));
    window.dispatchEvent(new CustomEvent('km_star_update'));
    window.dispatchEvent(new CustomEvent('km_challenge_update'));
  } catch {}
  const failedLocal = _bulkLocalFailures;
  saveNowAwait().then(r => { try { window.dispatchEvent(new CustomEvent('km_save_status', { detail: { ...r, failedLocal } })); } catch {} });
  return failedLocal;
}
// Purchase history (kept on this device, newest first, last 20) so a wrongly charged purchase can be spotted and refunded.
// Deliberately NOT a km_ key: km_ keys are uploaded with every save.
function logPurchase(item, cost, outcome) {
  try {
    const log = JSON.parse(localStorage.getItem('purchase_log') || '[]');
    log.unshift({ t: Date.now(), item, cost, outcome });
    localStorage.setItem('purchase_log', JSON.stringify(log.slice(0, 20)));
  } catch {}
}
function readPurchaseLog() { try { return JSON.parse(localStorage.getItem('purchase_log') || '[]'); } catch { return []; } }
function saveDogState(dogId, state) {
  const e = _dxEntry(dogId, true), ne = _dxFromState(state);
  ne[5] = e[5]; ne[6] = e[6]; dxLoad()[dogId] = ne; _dxDirty++;
  if (_bulkMode) return; // runBulk writes the whole map once at the end
  dxScheduleFlush();
  window.dispatchEvent(new Event('km_dog_change'));
  // Persist critical fields to Supabase so they survive localStorage wipe on iOS.
  // Requires: ALTER TABLE dogs ADD COLUMN IF NOT EXISTS meta jsonb DEFAULT '{}';
  // Gracefully no-ops if the column doesn't exist yet.
  const meta = { lastFed: state.lastFed||0, lastPoo: state.lastPoo||0, level: state.level||1, xp: state.xp||0 };
  sb(`cats?id=eq.${dogId}`, 'PATCH', { meta }).catch(() => {});
  // CRITICAL: flush full player_data to Supabase shortly after every dog state
  // change so lastFed is never lost if the app closes before the 5s debounce.
  // Debounced 300ms so feeding multiple dogs at once fires only one PATCH.
  saveNowDebounced();
}
// Restore dog state from Supabase meta when localStorage is missing/stale.
// Called after dogs are loaded on login.
function restoreDogStatesFromMeta(dogsArr) {
  if (!dogsArr || !dogsArr.length) return;
  let changed = false;
  dogsArr.forEach(dog => {
    if (!dog.meta) return;
    const e = dxLoad()[dog.id], local = e ? _dxToState(e) : null;
    // Only restore from DB if local is missing or DB has more recent timestamps (app was used on another device)
    if (!local || (dog.meta.lastFed||0) > (local.lastFed||0) || (dog.meta.lastPoo||0) > (local.lastPoo||0)) {
      const merged = Object.assign(DX_DEFAULT(), local||{}, {
        lastFed: Math.max(local?.lastFed||0, dog.meta.lastFed||0),
        lastPoo: Math.max(local?.lastPoo||0, dog.meta.lastPoo||0),
        level:   Math.max(local?.level||1,   dog.meta.level||1),
        xp:      Math.max(local?.xp||0,      dog.meta.xp||0),
      });
      const ne = _dxFromState(merged); if (e) { ne[5] = e[5]; ne[6] = e[6]; }
      dxLoad()[dog.id] = ne; changed = true;
    }
  });
  if (changed) { _dxDirty++; dxScheduleFlush(); }
}
function computeTrainingPts() {
  let pts = 0;
  dxAllStates().forEach(st => {
    if (st.skills) pts += Object.values(st.skills).reduce((a, v) => a + (v || 0), 0);
    if (st.level) pts += Math.max(0, st.level - 1); // count levels earned from feeding/XP too, not just the skill mini-game
  });
  return pts;
}
const RANDOM_DOG_NAMES_MALE = CAT_NAMES_MALE;
const RANDOM_DOG_NAMES_FEMALE = CAT_NAMES_FEMALE;
function generateDogName(usedNames, gender) {
  const source = gender === 'Male' ? RANDOM_DOG_NAMES_MALE : gender === 'Female' ? RANDOM_DOG_NAMES_FEMALE : [...RANDOM_DOG_NAMES_MALE, ...RANDOM_DOG_NAMES_FEMALE];
  const available = source.filter(n => !usedNames.has(n));
  const pool = available.length ? available : source;
  return pool[Math.floor(Math.random() * pool.length)];
}
// Combines a dog's nickname (if set) with its breed into one string, e.g. "Bella (Affenpinscher)".
// Used for race rooms, whose schema stores a single free-text dog label per slot.
function dogRaceLabel(dog) {
  const nick = getDogNick(dog.id) || '';
  return nick ? `${nick} (${dog.breed})` : (dog.breed || dog.name);
}
// ─── Safety: username filter + local block list (App Store guideline 1.2) ────
const BLOCKED_NAME_WORDS = ['fuck','shit','bitch','cunt','pussy','asshole','nigg','faggot','slut','whore','nazi','hitler','porn','penis','vagina','suicide','retard','dick','cock','cum','anal','anus','tits','boob','nude','naked','sex','rape','molest','pedo','paedo','kkk','isis','jihad','terror','kill','murder','dildo','blowjob','handjob','wank','twat','bastard','fag','dyke','tranny','whor','hoe','milf','hentai','incest','cocaine','heroin','meth','nigger'];
function isInappropriateName(name) {
  const flat = String(name).toLowerCase()
    .replace(/[0@]/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[4]/g, 'a').replace(/[5$]/g, 's').replace(/7/g, 't')
    .replace(/[^a-z]/g, '');
  return BLOCKED_NAME_WORDS.some(w => flat.includes(w));
}
// Some old accounts used an email address as their username; never show those in public lists.
function publicName(name) {
  const n = String(name || '');
  const at = n.indexOf('@');
  return at > 0 ? n.slice(0, Math.min(at, 3)) + '***' : n;
}
function getBlockedPlayers() {
  try { return JSON.parse(localStorage.getItem('km_blocked_players')) || []; } catch { return []; }
}
function blockPlayer(id) {
  const list = getBlockedPlayers();
  if (!list.includes(id)) { list.push(id); try { localStorage.setItem('km_blocked_players', JSON.stringify(list)); } catch {} }
}
function addXP(dogId, amount, setToast) {
  const s = getDogState(dogId);
  const prevLevel = s.level;
  s.xp += amount;
  const xpNeeded = s.level * 50;
  if (s.xp >= xpNeeded) {
    s.xp -= xpNeeded;
    s.level = Math.min(50, s.level + 1);
    if (setToast) setToast(`⬆️ Level up! Lv.${s.level}!`);
    // Evolution celebration at Level 10
    if (prevLevel < 10 && s.level >= 10) {
      window.dispatchEvent(new CustomEvent('km_evolution', { detail: { dogId } }));
    }
  }
  saveDogState(dogId, s);
  return s;
}
function calcHunger(state) {
  // Hunger decreases 10 per hour from lastFed
  const hoursElapsed = (Date.now() - (state.lastFed || 0)) / 3600000;
  return Math.max(0, (state.hunger || 100) - hoursElapsed * 10);
}

// Soft "mee-ow" synth: pitch rises then falls through a sweeping vowel filter. Pitch varies a little per breed.
function playMeow(breedName = '') {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let h = 0; for (const ch of String(breedName)) h = (h * 31 + ch.charCodeAt(0)) % 997;
    const base = 520 + (h % 9) * 35;          // 520-800 Hz
    const t = ctx.currentTime + 0.01, dur = 0.55;
    const osc = ctx.createOscillator(), filt = ctx.createBiquadFilter(), gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(base * 0.8, t);
    osc.frequency.linearRampToValueAtTime(base * 1.25, t + dur * 0.3);
    osc.frequency.exponentialRampToValueAtTime(base * 0.65, t + dur);
    filt.type = 'bandpass'; filt.Q.value = 4;
    filt.frequency.setValueAtTime(700, t);              // "mee"
    filt.frequency.linearRampToValueAtTime(1800, t + dur * 0.3);
    filt.frequency.linearRampToValueAtTime(600, t + dur); // "ow"
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(0.5, t + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
    osc.start(t); osc.stop(t + dur + 0.05);
    setTimeout(() => ctx.close(), 1500);
  } catch (e) {}
}

// Gentle purr: low amplitude-modulated rumble (~25 Hz pulses on a 55 Hz tone with filtered noise).
function playPurr() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime + 0.01, dur = 1.4;
    const osc = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    osc.type = 'sawtooth'; osc.frequency.value = 55;
    f.type = 'lowpass'; f.frequency.value = 400;
    lfo.frequency.value = 25; lg.gain.value = 0.12;
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.25);
    g.gain.linearRampToValueAtTime(0.001, t + dur);
    lfo.connect(lg); lg.connect(g.gain);
    osc.connect(f); f.connect(g); g.connect(ctx.destination);
    osc.start(t); lfo.start(t); osc.stop(t + dur); lfo.stop(t + dur);
    setTimeout(() => ctx.close(), 2000);
  } catch (e) {}
}

async function hashPassword(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ─── Background Music ─────────────────────────────────────────────────────────
let _bgCtx = null;
let _bgGain = null;
let _bgPlaying = false;
let _bgNextTime = 0;
let _bgSchedTimeout = null;
const BG_NOTES = [[261.63,0.4],[293.66,0.4],[329.63,0.4],[392,0.4],[440,0.4],[392,0.4],[329.63,0.4],[261.63,0.8]];
function _scheduleBg() {
  if (!_bgPlaying || !_bgCtx) return;
  const ahead = 2.0;
  while (_bgNextTime < _bgCtx.currentTime + ahead) {
    let t = _bgNextTime;
    BG_NOTES.forEach(([freq, dur]) => {
      const osc = _bgCtx.createOscillator();
      const env = _bgCtx.createGain();
      osc.type = 'triangle'; osc.frequency.value = freq;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.18, t + 0.04);
      env.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.88);
      osc.connect(env); env.connect(_bgGain);
      osc.start(t); osc.stop(t + dur);
      t += dur;
    });
    _bgNextTime += BG_NOTES.reduce((s,[,d]) => s + d, 0);
  }
  _bgSchedTimeout = setTimeout(_scheduleBg, 500);
}
function startBgMusic() {
  if (_bgPlaying) return;
  try {
    _bgCtx = new (window.AudioContext || window.webkitAudioContext)();
    _bgGain = _bgCtx.createGain();
    _bgGain.gain.value = 0.55;
    _bgGain.connect(_bgCtx.destination);
    _bgPlaying = true;
    _bgNextTime = _bgCtx.currentTime + 0.1;
    _scheduleBg();
  } catch(e) {}
}
function stopBgMusic() {
  _bgPlaying = false;
  clearTimeout(_bgSchedTimeout);
  try { if (_bgCtx) { _bgCtx.close(); } } catch(e) {}
  _bgCtx = null; _bgGain = null;
}

// ─── Share Catch Card ─────────────────────────────────────────────────────────
async function shareCatchCard(dogName, rarity, photoUrl) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 400; canvas.height = 400;
    const ctx = canvas.getContext('2d');
    const color = RARITY_COLORS[rarity] || '#764ba2';
    // Background gradient
    const grd = ctx.createLinearGradient(0, 0, 400, 400);
    grd.addColorStop(0, '#667eea'); grd.addColorStop(1, '#764ba2');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, 400, 400);
    // Dog photo circle
    if (photoUrl) {
      await new Promise(resolve => {
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => {
          ctx.save();
          ctx.beginPath(); ctx.arc(200, 180, 130, 0, Math.PI * 2); ctx.clip();
          ctx.drawImage(img, 70, 50, 260, 260);
          ctx.restore();
          resolve();
        };
        img.onerror = resolve;
        img.src = photoUrl;
      });
    }
    // Rarity ring
    ctx.beginPath(); ctx.arc(200, 180, 133, 0, Math.PI * 2);
    ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.stroke();
    // Text
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 28px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText(dogName, 200, 340);
    ctx.font = 'bold 18px Georgia, serif';
    ctx.fillStyle = color;
    ctx.fillText(`✨ ${rarity}`, 200, 368);
    ctx.font = '14px Georgia, serif';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('Caught in KittyMart!', 200, 392);

    canvas.toBlob(async blob => {
      if (!blob) return;
      const file = new File([blob], 'kitten-catch.png', { type: 'image/png' });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: `I caught a ${rarity} ${dogName}!`, text: `Just caught a ${rarity} ${dogName} in KittyMart! 🐾`, files: [file] });
      } else {
        // Fallback: download
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = `${dogName}-catch.png`; a.click();
      }
    }, 'image/png');
  } catch(e) { console.error('Share error', e); }
}

// ─── Shareable Dress-Up Card ──────────────────────────────────────────────────
async function shareDressupCard(dog, equipped) {
  try {
    const W = 480, H = 560;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Room background
    const wallGrd = ctx.createLinearGradient(0, 0, 0, 320);
    wallGrd.addColorStop(0, '#2a9d8f'); wallGrd.addColorStop(1, '#1e7a72');
    ctx.fillStyle = wallGrd; ctx.fillRect(0, 0, W, 320);
    // Paw pattern
    for (let py = 0; py < 320; py += 50) for (let px = 0; px < W; px += 50) {
      ctx.save(); ctx.globalAlpha = 0.06; ctx.fillStyle = 'white';
      ctx.beginPath(); ctx.ellipse(px+14, py+14, 6, 7, 0, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(px+8, py+6, 3.5, 4, 0, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(px+20, py+6, 3.5, 4, 0, 0, Math.PI*2); ctx.fill();
      ctx.restore();
    }
    // Floor
    const floorGrd = ctx.createLinearGradient(0, 320, 0, H-60);
    floorGrd.addColorStop(0, '#8B5E3C'); floorGrd.addColorStop(1, '#5C3A1E');
    ctx.fillStyle = floorGrd; ctx.fillRect(0, 320, W, H-320);
    // Floor planks
    ctx.strokeStyle = '#6B4226'; ctx.lineWidth = 1; ctx.globalAlpha = 0.4;
    [345, 370, 395].forEach(y => { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); });
    [120,240,360].forEach(x => { ctx.beginPath(); ctx.moveTo(x, 320); ctx.lineTo(x, H-60); ctx.stroke(); });
    ctx.globalAlpha = 1;
    // Wall trim
    ctx.fillStyle = '#1a7a70'; ctx.fillRect(0, 314, W, 9);

    // Dog photo circle
    const cx = W/2, cy = 200, r = 140;
    // Shadow ellipse
    ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = 'black';
    ctx.beginPath(); ctx.ellipse(cx, 328, 110, 18, 0, 0, Math.PI*2); ctx.fill(); ctx.restore();
    if (dog.photo_url) {
      await new Promise(resolve => {
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => {
          ctx.save();
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.clip();
          ctx.drawImage(img, cx-r, cy-r, r*2, r*2);
          ctx.restore();
          // Rarity ring
          ctx.strokeStyle = RARITY_COLORS[dog.rarity] || '#fff'; ctx.lineWidth = 7;
          ctx.beginPath(); ctx.arc(cx, cy, r+4, 0, Math.PI*2); ctx.stroke();
          ctx.strokeStyle = 'white'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(cx, cy, r+8, 0, Math.PI*2); ctx.stroke();
          resolve();
        };
        img.onerror = resolve; img.src = dog.photo_url;
      });
    }

    // Nameplate bar
    const barY = H - 110;
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; roundRect(ctx, 40, barY, W-80, 70, 16); ctx.fill();
    ctx.fillStyle = 'white'; ctx.font = 'bold 26px Georgia,serif'; ctx.textAlign = 'center';
    ctx.fillText(dog.name, W/2, barY+30);
    ctx.fillStyle = RARITY_COLORS[dog.rarity] || '#ffd700'; ctx.font = 'bold 17px Georgia,serif';
    ctx.fillText(`✨ ${dog.rarity} · KittyMart`, W/2, barY+54);

    // Watermark
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.font = '12px Georgia,serif';
    ctx.fillText('kittymart.app', W/2, H-8);

    canvas.toBlob(async blob => {
      if (!blob) return;
      const file = new File([blob], `${dog.name}-outfit.png`, { type: 'image/png' });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: `${dog.name} is dressed up!`, text: `Check out ${dog.name}'s outfit in KittyMart! 🐾`, files: [file] });
      } else {
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = `${dog.name}-outfit.png`; a.click();
      }
    }, 'image/png');
  } catch(e) { console.error('Dress-up share error', e); }
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+h-r); ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}

// ─── Online Presence ──────────────────────────────────────────────────────────
async function updatePresence(playerId, username) {
  try {
    await sb('km_presence', 'POST', { player_id: playerId, username, last_seen: new Date().toISOString() });
  } catch {
    try { await sb(`km_presence?player_id=eq.${playerId}`, 'PATCH', { username, last_seen: new Date().toISOString() }); } catch {}
  }
}
// ─── Friends List (persistent, requires a `friends` table — see SQL in CLAUDE.md) ─
// Fails silently (returns empty/false) until the table exists, so it's safe to ship
// ahead of running the migration.
async function addFriend(myId, friendId) {
  try { await sb('friends', 'POST', { player_id: myId, friend_id: friendId }); return true; }
  catch { return false; }
}
async function removeFriend(myId, friendId) {
  try { await sb(`friends?player_id=eq.${myId}&friend_id=eq.${friendId}`, 'DELETE'); return true; }
  catch { return false; }
}
async function getMyFriends(myId) {
  try {
    const rows = await sb(`friends?player_id=eq.${myId}&select=friend_id&limit=200`);
    if (!rows.length) return [];
    const ids = rows.map(r => r.friend_id);
    const orFilter = ids.map(id => `id.eq.${id}`).join(',');
    const players = await sb(`players?or=(${orFilter})&select=id,username,race_wins,total_pts&limit=200`);
    return players;
  } catch { return []; }
}
async function getOnlinePlayers() {
  try {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    return await sb(`km_presence?last_seen=gte.${encodeURIComponent(cutoff)}&select=player_id,username&limit=20`);
  } catch { return []; }
}

// ─── Parental Gate ────────────────────────────────────────────────────────────
// Simple math challenge shown before actions that leave the app (e.g. sharing to
// social media), so a young child can't trigger them without an adult's help.
function ParentalGateModal({ onSuccess, onClose }) {
  const [a] = useState(() => 3 + Math.floor(Math.random() * 6));
  const [b] = useState(() => 2 + Math.floor(Math.random() * 6));
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');

  const submit = () => {
    if (parseInt(answer, 10) === a + b) { onSuccess(); }
    else { setError('Not quite — try again!'); setAnswer(''); }
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:1100, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }} onClick={onClose}>
      <div style={{ background:'white', borderRadius:20, padding:24, maxWidth:320, width:'100%', textAlign:'center' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:36, marginBottom:8 }}>🔒</div>
        <h3 style={{ margin:'0 0 6px', color:'#764ba2' }}>Just for Grown-Ups!</h3>
        <p style={{ fontSize:13, color:'#555', margin:'0 0 16px' }}>Solve this to continue — this makes sure a parent is here.</p>
        <div style={{ fontSize:22, fontWeight:'bold', color:'#333', marginBottom:12 }}>{a} + {b} = ?</div>
        <input
          type="number"
          inputMode="numeric"
          value={answer}
          onChange={e => { setAnswer(e.target.value); setError(''); }}
          onKeyDown={e => e.key === 'Enter' && submit()}
          autoFocus
          style={{ width:'100%', padding:'10px 12px', fontSize:16, textAlign:'center', borderRadius:12, border:'2px solid #c39bd3', outline:'none', marginBottom:8, boxSizing:'border-box' }}
        />
        {error && <div style={{ color:'#e63946', fontSize:12, marginBottom:8 }}>{error}</div>}
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={onClose} style={{ flex:1, padding:'10px', background:'#eee', border:'none', borderRadius:12, fontWeight:'bold', cursor:'pointer', fontSize:14 }}>Cancel</button>
          <button onClick={submit} style={{ flex:1, padding:'10px', background:'linear-gradient(135deg,#667eea,#764ba2)', color:'white', border:'none', borderRadius:12, fontWeight:'bold', cursor:'pointer', fontSize:14 }}>Continue</button>
        </div>
      </div>
    </div>
  );
}

// ─── Privacy Policy ───────────────────────────────────────────────────────────
function PrivacyPolicyModal({ onClose }) {
  // Portal to <body> so it isn't clipped by the scrolling Settings container, and
  // keep clear of the notch / home indicator.
  return ReactDOM.createPortal(
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', boxSizing:'border-box', padding:'calc(env(safe-area-inset-top, 0px) + 16px) 16px calc(env(safe-area-inset-bottom, 0px) + 16px)' }} onClick={onClose}>
      <div style={{ background:'white', borderRadius:20, padding:24, maxWidth:400, width:'100%', maxHeight:'100%', overflowY:'auto', WebkitOverflowScrolling:'touch' }} onClick={e => e.stopPropagation()}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', margin:'0 0 16px' }}><h2 style={{ margin:0, color:'#764ba2' }}>🔒 Privacy Policy</h2><button onClick={onClose} aria-label="Close" style={{ background:'none', border:'none', fontSize:24, cursor:'pointer', color:'#888' }}>✕</button></div>
        <p style={{ fontSize:13, color:'#555', lineHeight:1.6 }}><strong>Last updated: October 2026</strong></p>
        <h3 style={{ fontSize:14, color:'#333' }}>What we collect</h3>
        <p style={{ fontSize:13, color:'#555', lineHeight:1.6 }}>We collect your username, your email address (optional, used for password reset), your password (hashed — we never store your plain password), the cats you catch, and any cat photos you choose to upload. If you allow location access, your approximate coordinates are sent to OpenStreetMap's Nominatim service only to work out your catch zone; we do not store your location on our servers. Real cat photos are loaded from The Cat API (thecatapi.com) and CATAAS (cataas.com), which receive your device's IP address like any website you visit.</p>
        <h3 style={{ fontSize:14, color:'#333' }}>How we use it</h3>
        <p style={{ fontSize:13, color:'#555', lineHeight:1.6 }}>Your data is used solely to power KittyMart — displaying your cat collection, race results, and leaderboard rankings.</p>
        <h3 style={{ fontSize:14, color:'#333' }}>Who we share it with</h3>
        <p style={{ fontSize:13, color:'#555', lineHeight:1.6 }}>We use Supabase (supabase.com) to store game data, and OpenStreetMap Nominatim to look up your catch zone from your approximate location. We do not sell or share your personal information with any third parties for advertising purposes.</p>
        <h3 style={{ fontSize:14, color:'#333' }}>Your rights</h3>
        <p style={{ fontSize:13, color:'#555', lineHeight:1.6 }}>You can delete your account at any time from Settings → Delete Account. This permanently removes all your data from our servers.</p>
        <h3 style={{ fontSize:14, color:'#333' }}>Parental controls</h3>
        <p style={{ fontSize:13, color:'#555', lineHeight:1.6 }}>KittyMart works with Apple's built-in Screen Time. Parents can set daily time limits or schedule Downtime (e.g. at bedtime) for KittyMart from Settings → Screen Time → App Limits on the device. Actions that leave the app, like sharing a catch, require solving a simple parental gate first.</p>
        <h3 style={{ fontSize:14, color:'#333' }}>Contact</h3>
        <p style={{ fontSize:13, color:'#555', lineHeight:1.6 }}>For privacy questions, contact us at the KittyMart team</p>
        <button onClick={onClose} style={{ width:'100%', padding:12, background:'linear-gradient(135deg,#667eea,#764ba2)', color:'white', border:'none', borderRadius:12, fontSize:15, fontWeight:'bold', cursor:'pointer', marginTop:8 }}>Close</button>
      </div>
    </div>,
    document.body
  );
}

// ─── Mystery Box ──────────────────────────────────────────────────────────────
function MysteryBoxModal({ onClose, player, onCatch }) {
  const [phase, setPhase] = useState('closed'); // closed | opening | revealed
  const [prize, setPrize] = useState(null);
  const [claiming, setClaiming] = useState(false);

  const openBox = async () => {
    setPhase('opening');
    const roll = Math.random();
    let rarity;
    if (roll < 0.45) {
      const amount = 10 + Math.floor(Math.random() * 21) * 5;
      setPrize({ type:'points', amount, label:'Bonus Points!' });
      setPhase('revealed');
      return;
    }
    if (roll < 0.75) rarity = 'Uncommon';
    else if (roll < 0.92) rarity = 'Rare';
    else if (roll < 0.99) rarity = 'Epic';
    else rarity = 'Legendary';

    // Pick the breed NOW so we can show it before claiming
    const validBreeds = DOG_BREEDS.filter(b => b.rarity === rarity);
    const b = validBreeds[Math.floor(Math.random() * validBreeds.length)];
    const photoUrl = b ? await fetchBreedPhoto(b).catch(() => null) : null;
    setPrize({ type:'dog', rarity, breed: b, photoUrl, label: rarity === 'Legendary' ? 'LEGENDARY Cat!!' : `${rarity} Cat!` });
    setPhase('revealed');
  };

  const claimPrize = async () => {
    if (!prize || claiming) return;
    setClaiming(true);
    try {
      if (prize.type === 'points') {
        addBonusPts(prize.amount);
      } else if (prize.breed) {
        const b = prize.breed;
        const saved = await sb('cats', 'POST', { owner_id: player.id, name: b.name, breed: b.name, rarity: b.rarity, photo_url: prize.photoUrl || b.api });
        recordCatch(b.rarity);
        if (onCatch) onCatch(saved && saved[0]);
      }
    } catch(e) {}
    setClaiming(false);
    onClose();
  };

  const color = prize?.rarity ? RARITY_COLORS[prize.rarity] : '#f4a261';

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ background:'white', borderRadius:24, padding:28, width:310, textAlign:'center', boxShadow:'0 20px 60px rgba(0,0,0,0.4)' }}>
        <div style={{ fontSize:56, marginBottom:8 }}>🎁</div>
        <h2 style={{ margin:'0 0 6px', color:'#764ba2' }}>Mystery Box!</h2>
        <p style={{ color:'#888', fontSize:13, margin:'0 0 18px' }}>Every 10 catches earns you a reward!</p>

        {phase === 'closed' && (
          <button onClick={openBox} style={{ width:'100%', padding:16, background:'linear-gradient(135deg,#f4a261,#e76f51)', color:'white', border:'none', borderRadius:14, fontSize:17, fontWeight:'bold', cursor:'pointer' }}>Open Box! 🎉</button>
        )}

        {phase === 'opening' && (
          <div style={{ padding:'20px 0', color:'#888', fontSize:14 }}>✨ Finding your cat…</div>
        )}

        {phase === 'revealed' && prize && (
          <div>
            {prize.type === 'points' ? (
              <>
                <div style={{ fontSize:52, marginBottom:8 }}>⭐</div>
                <div style={{ fontSize:20, fontWeight:'bold', color:'#f4a261', marginBottom:4 }}>{prize.label}</div>
                <div style={{ fontSize:16, color:'#333', marginBottom:20 }}>+{prize.amount} bonus points!</div>
              </>
            ) : (
              <>
                {/* Dog photo */}
                <div style={{ margin:'0 auto 10px', width:100, height:100, borderRadius:'50%', overflow:'hidden', border:`4px solid ${color}`, boxShadow:`0 0 20px ${color}66` }}>
                  {prize.photoUrl
                    ? <img src={prize.photoUrl} alt={prize.breed?.name} style={{ width:'100%', height:'100%', objectFit:'cover' }} onError={e=>{e.target.onerror=null;e.target.style.display='none';}} />
                    : <div style={{ width:'100%', height:'100%', background: color+'22', display:'flex', alignItems:'center', justifyContent:'center', fontSize:44 }}>🐱</div>
                  }
                </div>
                {/* Breed name */}
                <div style={{ fontSize:22, fontWeight:'bold', color, marginBottom:2 }}>{prize.breed?.name || prize.rarity + ' Cat'}</div>
                {/* Rarity badge */}
                <div style={{ display:'inline-block', background: color, color:'white', borderRadius:20, padding:'3px 14px', fontSize:12, fontWeight:'bold', marginBottom:6 }}>{prize.rarity}</div>
                {/* Fun fact */}
                {prize.breed?.facts?.[0] && (
                  <div style={{ fontSize:12, color:'#777', fontStyle:'italic', margin:'6px 0 14px', lineHeight:1.4, padding:'0 8px' }}>"{prize.breed.facts[0]}"</div>
                )}
                {!prize.breed?.facts?.[0] && <div style={{ marginBottom:14 }} />}
              </>
            )}
            <button onClick={claimPrize} disabled={claiming} style={{ width:'100%', padding:14, background: claiming ? '#ccc' : 'linear-gradient(135deg,#667eea,#764ba2)', color:'white', border:'none', borderRadius:14, fontSize:16, fontWeight:'bold', cursor: claiming ? 'default' : 'pointer' }}>
              {claiming ? 'Adding to collection…' : 'Claim! 🎊'}
            </button>
          </div>
        )}

        <button onClick={onClose} style={{ marginTop:10, width:'100%', padding:10, background:'#eee', border:'none', borderRadius:12, fontSize:14, cursor:'pointer', color:'#888' }}>Skip</button>
      </div>
    </div>
  );
}

// ─── Login ────────────────────────────────────────────────────────────────────
// One-time prompt shown after a successful legacy (pre-email) login, offering to
// add a real email so the account gets Supabase Auth + password reset going forward.
// requirePassword=true: shown after login (confirm with current password)
// requirePassword=false: shown from Settings (already logged in, just set new password)
function AddEmailModal({ player, onDone, requirePassword = true }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError('');
    const val = email.trim();
    const pw = requirePassword ? password.trim() : newPassword.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) { setError('Enter a valid email address.'); return; }
    if (!pw || pw.length < 4) { setError('Password must be at least 4 characters.'); return; }
    setLoading(true);
    try {
      const existing = await sb(`players?email=ilike.${encodeURIComponent(val)}&select=id`);
      if (existing.length > 0) { setError('That email is already in use on another account.'); setLoading(false); return; }
      const { data, error: signUpErr } = await supabaseAuth.auth.signUp({ email: val, password: pw });
      if (signUpErr || !data?.user) { setError(signUpErr?.message || 'Could not create secure login.'); setLoading(false); return; }
      await sb(`players?id=eq.${player.id}`, 'PATCH', { user_id: data.user.id, email: val });
      onDone(val);
    } catch (e) { setError(e.message); setLoading(false); }
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center', padding:16, overflowY:'auto' }}>
      <div style={{ background:'white', borderRadius:20, padding:24, maxWidth:340, width:'100%', textAlign:'center', margin:'auto' }}>
        <div style={{ fontSize:36, marginBottom:8 }}>📧</div>
        <h3 style={{ margin:'0 0 6px', color:'#764ba2' }}>Secure Your Account</h3>
        <p style={{ fontSize:13, color:'#555', margin:'0 0 16px' }}>
          {requirePassword
            ? 'Add your email so you can reset your password if you ever forget it. Confirm with your current password.'
            : 'Add your email and set a new password. You can use these to log in and reset your password in future.'}
        </p>
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email address" autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ width:'100%', padding:'12px', borderRadius:10, border:'2px solid #eee', fontSize:15, marginBottom:10, boxSizing:'border-box', outline:'none' }} />
        {requirePassword
          ? <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="Your current password" onKeyDown={e => e.key === 'Enter' && submit()} autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ width:'100%', padding:'12px', borderRadius:10, border:'2px solid #eee', fontSize:15, marginBottom:10, boxSizing:'border-box', outline:'none' }} />
          : <input value={newPassword} onChange={e => setNewPassword(e.target.value)} type="password" placeholder="Set a new password" onKeyDown={e => e.key === 'Enter' && submit()} autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ width:'100%', padding:'12px', borderRadius:10, border:'2px solid #eee', fontSize:15, marginBottom:10, boxSizing:'border-box', outline:'none' }} />
        }
        {error && <p style={{ color:'#e63946', fontSize:12, margin:'0 0 10px' }}>{error}</p>}
        <button onClick={submit} disabled={loading} style={{ width:'100%', padding:'12px', background:'linear-gradient(135deg,#667eea,#764ba2)', color:'white', border:'none', borderRadius:12, fontWeight:'bold', fontSize:15, cursor:loading?'not-allowed':'pointer', marginBottom:8 }}>{loading ? '...' : 'Save Email & Password'}</button>
        <button onClick={() => onDone(null)} style={{ width:'100%', padding:'10px', background:'#eee', border:'none', borderRadius:12, fontWeight:'bold', cursor:'pointer', fontSize:14 }}>Maybe Later</button>
      </div>
    </div>
  );
}

function ChangePasswordModal({ player, onDone }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError('');
    const cur = current.trim();
    const pw1 = next.trim();
    const pw2 = confirm.trim();
    if (!cur) { setError('Enter your current password.'); return; }
    if (pw1.length < 4) { setError('New password must be at least 4 characters.'); return; }
    if (pw1 !== pw2) { setError("New passwords don't match."); return; }
    setLoading(true);
    try {
      if (player.user_id) {
        const { error: signInErr } = await supabaseAuth.auth.signInWithPassword({ email: player.email, password: cur });
        if (signInErr) { setError('Current password is incorrect.'); setLoading(false); return; }
        const { error: updateErr } = await supabaseAuth.auth.updateUser({ password: pw1 });
        if (updateErr) { setError(updateErr.message); setLoading(false); return; }
      } else {
        const rows = await sb(`players?id=eq.${player.id}&select=password`);
        const stored = rows[0]?.password;
        const hashedCur = await hashPassword(cur);
        if (stored !== hashedCur && stored !== cur) { setError('Current password is incorrect.'); setLoading(false); return; }
        const hashedNew = await hashPassword(pw1);
        await sb(`players?id=eq.${player.id}`, 'PATCH', { password: hashedNew });
      }
      onDone(true);
    } catch (e) { setError(e.message); setLoading(false); }
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }} onClick={() => onDone(false)}>
      <div style={{ background:'white', borderRadius:20, padding:24, maxWidth:340, width:'100%', textAlign:'center' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:36, marginBottom:8 }}>🔒</div>
        <h3 style={{ margin:'0 0 6px', color:'#764ba2' }}>Change Password</h3>
        <p style={{ fontSize:13, color:'#555', margin:'0 0 16px' }}>Enter your current password, then choose a new one.</p>
        <input value={current} onChange={e => setCurrent(e.target.value)} type="password" placeholder="Current password" autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ width:'100%', padding:'12px', borderRadius:10, border:'2px solid #eee', fontSize:15, marginBottom:10, boxSizing:'border-box', outline:'none' }} />
        <input value={next} onChange={e => setNext(e.target.value)} type="password" placeholder="New password" autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ width:'100%', padding:'12px', borderRadius:10, border:'2px solid #eee', fontSize:15, marginBottom:10, boxSizing:'border-box', outline:'none' }} />
        <input value={confirm} onChange={e => setConfirm(e.target.value)} type="password" placeholder="Confirm new password" onKeyDown={e => e.key === 'Enter' && submit()} autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ width:'100%', padding:'12px', borderRadius:10, border:'2px solid #eee', fontSize:15, marginBottom:10, boxSizing:'border-box', outline:'none' }} />
        {error && <p style={{ color:'#e63946', fontSize:12, margin:'0 0 10px' }}>{error}</p>}
        <button onClick={submit} disabled={loading} style={{ width:'100%', padding:'12px', background:'linear-gradient(135deg,#667eea,#764ba2)', color:'white', border:'none', borderRadius:12, fontWeight:'bold', fontSize:15, cursor:loading?'not-allowed':'pointer', marginBottom:8 }}>{loading ? '...' : 'Update Password'}</button>
        <button onClick={() => onDone(false)} style={{ width:'100%', padding:'10px', background:'#eee', border:'none', borderRadius:12, fontWeight:'bold', cursor:'pointer', fontSize:14 }}>Cancel</button>
      </div>
    </div>
  );
}

function ChangeEmailModal({ player, onDone }) {
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError('');
    const val = newEmail.trim().toLowerCase();
    const pw = password.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) { setError('Enter a valid email address.'); return; }
    if (!pw) { setError('Enter your current password to confirm.'); return; }
    setLoading(true);
    try {
      // Verify current password
      const { error: signInErr } = await supabaseAuth.auth.signInWithPassword({ email: player.email, password: pw });
      if (signInErr) { setError('Password is incorrect.'); setLoading(false); return; }
      // Check email not already taken
      const existing = await sb(`players?email=ilike.${encodeURIComponent(val)}&select=id`);
      if (existing.length > 0) { setError('That email is already in use on another account.'); setLoading(false); return; }
      // Update players table immediately
      await sb(`players?id=eq.${player.id}`, 'PATCH', { email: val });
      // Update Supabase Auth email (sends confirmation to new email)
      await supabaseAuth.auth.updateUser({ email: val });
      onDone(val);
    } catch (e) { setError(e.message); setLoading(false); }
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }} onClick={() => onDone(null)}>
      <div style={{ background:'white', borderRadius:20, padding:24, maxWidth:340, width:'100%', textAlign:'center' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:36, marginBottom:8 }}>📧</div>
        <h3 style={{ margin:'0 0 6px', color:'#764ba2' }}>Change Email</h3>
        <p style={{ fontSize:13, color:'#555', margin:'0 0 16px' }}>Enter your new email address and current password to confirm.</p>
        <input value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="New email address" autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ width:'100%', padding:'12px', borderRadius:10, border:'2px solid #eee', fontSize:15, marginBottom:10, boxSizing:'border-box', outline:'none' }} />
        <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="Current password" onKeyDown={e => e.key === 'Enter' && submit()} autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ width:'100%', padding:'12px', borderRadius:10, border:'2px solid #eee', fontSize:15, marginBottom:10, boxSizing:'border-box', outline:'none' }} />
        {error && <p style={{ color:'#e63946', fontSize:12, margin:'0 0 10px' }}>{error}</p>}
        <button onClick={submit} disabled={loading} style={{ width:'100%', padding:'12px', background:'linear-gradient(135deg,#667eea,#764ba2)', color:'white', border:'none', borderRadius:12, fontWeight:'bold', fontSize:15, cursor:loading?'not-allowed':'pointer', marginBottom:8 }}>{loading ? '...' : 'Update Email'}</button>
        <button onClick={() => onDone(null)} style={{ width:'100%', padding:'10px', background:'#eee', border:'none', borderRadius:12, fontWeight:'bold', cursor:'pointer', fontSize:14 }}>Cancel</button>
      </div>
    </div>
  );
}

function ForgotPasswordModal({ onClose }) {
  const [input, setInput] = useState('');
  const [status, setStatus] = useState(''); // '', 'sent', 'error', 'no-email'
  const [errorDetail, setErrorDetail] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const val = input.trim();
    if (!val) return;
    setLoading(true); setStatus(''); setErrorDetail('');
    try {
      let email = val;
      if (!val.includes('@')) {
        const rows = await sb(`players?username=ilike.${encodeURIComponent(val)}&select=email`);
        email = rows[0]?.email;
        if (!email) { setStatus('no-email'); setLoading(false); return; }
      }
      // In the iOS app the origin is capacitor://localhost, which an emailed link can't open — use the hosted web app instead.
      const isWeb = /^https?:$/.test(window.location.protocol) && window.location.hostname !== 'localhost';
      const redirectTo = isWeb ? `${window.location.origin}${window.location.pathname}?reset=1` : 'https://harveyrockss.github.io/KittyMart/?reset=1';
      const { error } = await supabaseAuth.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) { setErrorDetail(error.message || String(error)); setStatus('error'); }
      else setStatus('sent');
    } catch (e) { setErrorDetail(e.message || String(e)); setStatus('error'); }
    setLoading(false);
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }} onClick={onClose}>
      <div style={{ background:'white', borderRadius:20, padding:24, maxWidth:340, width:'100%', textAlign:'center' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:36, marginBottom:8 }}>🔑</div>
        <h3 style={{ margin:'0 0 6px', color:'#764ba2' }}>Reset Password</h3>
        {status === 'sent' ? (
          <p style={{ fontSize:13, color:'#28a745', margin:'0 0 16px' }}>✅ Check your email for a reset link!</p>
        ) : status === 'no-email' ? (
          <p style={{ fontSize:13, color:'#e63946', margin:'0 0 16px' }}>This account hasn't added an email yet. Log in normally, then use "Secure Your Account" to add one — after that, password reset will work.</p>
        ) : (
          <>
            <p style={{ fontSize:13, color:'#555', margin:'0 0 16px' }}>Enter your username or email — we'll send a reset link if your account has an email on file.</p>
            <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} placeholder="Username or email" style={{ width:'100%', padding:'12px', borderRadius:10, border:'2px solid #eee', fontSize:15, marginBottom:12, boxSizing:'border-box', outline:'none' }} />
            {status === 'error' && <p style={{ color:'#e63946', fontSize:12, margin:'0 0 10px' }}>{errorDetail || 'Something went wrong — try again.'}</p>}
            <button onClick={submit} disabled={loading} style={{ width:'100%', padding:'12px', background:'linear-gradient(135deg,#667eea,#764ba2)', color:'white', border:'none', borderRadius:12, fontWeight:'bold', fontSize:15, cursor:loading?'not-allowed':'pointer', marginBottom:8 }}>{loading ? '...' : 'Send Reset Link'}</button>
          </>
        )}
        <button onClick={onClose} style={{ width:'100%', padding:'10px', background:'#eee', border:'none', borderRadius:12, fontWeight:'bold', cursor:'pointer', fontSize:14 }}>Close</button>
      </div>
    </div>
  );
}

function ResetPasswordScreen() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  // The auth client is created with detectSessionInUrl:false (so nothing happens on normal page loads), which means
  // the recovery code in the emailed link is never turned into a session. Do that here, once, from the link itself.
  const sessionReady = React.useRef(null);
  useEffect(() => {
    sessionReady.current = (async () => {
      const expired = 'This reset link is invalid or has expired. Please request a new one from the login screen.';
      try {
        const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        const query = new URLSearchParams(window.location.search);
        if (hash.get('error') || query.get('error')) { setError(expired); return false; }
        let res;
        if (hash.get('access_token') && hash.get('refresh_token')) {
          res = await supabaseAuth.auth.setSession({ access_token: hash.get('access_token'), refresh_token: hash.get('refresh_token') });
        } else if (query.get('token_hash')) {
          res = await supabaseAuth.auth.verifyOtp({ token_hash: query.get('token_hash'), type: 'recovery' });
        } else if (query.get('code')) {
          res = await supabaseAuth.auth.exchangeCodeForSession(query.get('code'));
        } else {
          setError('This reset link is missing its security code. Please request a new one from the login screen.');
          return false;
        }
        if (res.error) { setError(expired); return false; }
        // Remove the one-time tokens from the address bar (keep ?reset=1 so a reload still shows this screen).
        try { window.history.replaceState(null, '', window.location.pathname + '?reset=1'); } catch {}
        return true;
      } catch { setError(expired); return false; }
    })();
  }, []);

  const submit = async () => {
    const pw = password.trim();
    if (pw.length < 6) { setError('Password must be at least 6 characters.'); return; }
    setLoading(true); setError('');
    if (sessionReady.current && !(await sessionReady.current)) { setLoading(false); return; }
    const { error: updateErr } = await supabaseAuth.auth.updateUser({ password: pw });
    if (updateErr) { setError(updateErr.message); setLoading(false); return; }
    setDone(true);
    setTimeout(() => { window.location.href = window.location.pathname; }, 2500);
  };

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(180deg,#b8e8c8 0%,#e8f5e0 40%,#fffbe6 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '"Nunito","Comic Sans MS",Georgia,serif' }}>
      <div style={{ background: 'white', borderRadius: 24, padding: 40, width: 320, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', textAlign: 'center' }}>
        <div style={{ fontSize:40, marginBottom:8 }}>🔑</div>
        <h2 style={{ margin: '0 0 16px', color: '#764ba2' }}>Set New Password</h2>
        {done ? (
          <p style={{ color:'#28a745', fontSize:14 }}>✅ Password updated! Redirecting to login…</p>
        ) : (
          <>
            <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="New password" onKeyDown={e => e.key === 'Enter' && submit()} autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ width: '100%', padding: '12px', borderRadius: 10, border: '2px solid #eee', fontSize: 16, marginBottom: 16, boxSizing: 'border-box', outline: 'none' }} />
            {error && <p style={{ color: '#e63946', fontSize: 13, margin: '0 0 12px' }}>{error}</p>}
            <button onClick={submit} disabled={loading} style={{ width: '100%', padding: '14px', background: 'linear-gradient(135deg, #667eea, #764ba2)', color: 'white', border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 'bold', cursor: loading ? 'not-allowed' : 'pointer' }}>{loading ? '...' : 'Update Password'}</button>
          </>
        )}
      </div>
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [pendingMigration, setPendingMigration] = useState(null); // player row awaiting the add-email prompt

  const handleSubmit = async () => {
    setError('');
    const regEmail = email.trim() || (window.KM_OFFLINE ? (username.trim().toLowerCase().replace(/[^a-z0-9]/g,'') || 'cat') + '@kittymart.local' : '');
    if (mode === 'register') {
      if (!username.trim() || !regEmail || !password.trim()) { setError('Please fill in username, email, and password.'); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(regEmail)) { setError('Enter a valid email address.'); return; }
      if (isInappropriateName(username)) { setError('Please choose a family-friendly username.'); return; }
    } else if (!username.trim() || !password.trim()) {
      setError('Please enter your username/email and password.'); return;
    }
    setLoading(true);
    const pw = password.trim();
    try {
      if (mode === 'register') {
        const existingName = await sb(`players?username=ilike.${encodeURIComponent(username.trim())}&select=id`);
        if (existingName.length > 0) { setError('Username already taken!'); setLoading(false); return; }
        const existingEmail = await sb(`players?email=ilike.${encodeURIComponent(regEmail)}&select=id`);
        if (existingEmail.length > 0) { setError('An account already uses that email.'); setLoading(false); return; }
        const { data, error: signUpErr } = await supabaseAuth.auth.signUp({ email: regEmail, password: pw });
        if (signUpErr || !data?.user) { setError(signUpErr?.message || 'Could not create account.'); setLoading(false); return; }
        const created = await sb('players', 'POST', { username: username.trim(), email: regEmail, user_id: data.user.id });
        const keepKeys = ['kittymart_player'];
        Object.keys(localStorage).filter(k => k.startsWith('km_') && !keepKeys.includes(k)).forEach(k => localStorage.removeItem(k));
        onLogin(created[0]);
      } else {
        const input = username.trim();
        const isEmailInput = input.includes('@');
        // Resolve to the player row first (works whether they typed a username or email)
        const rows = isEmailInput
          ? await sb(`players?email=ilike.${encodeURIComponent(input)}&select=*`)
          : await sb(`players?username=ilike.${encodeURIComponent(input)}&select=*`);
        const row = rows[0];

        if (row?.user_id) {
          // Always try legacy password hash first — avoids Supabase Auth quota entirely
          if (row.password) {
            const hashedFallback = await hashPassword(pw);
            const legacyMatch = row.password === hashedFallback || row.password === pw;
            if (legacyMatch) { onLogin(row); setLoading(false); return; }
          }
          // Only call Supabase Auth as a last resort if there's an email
          if (row.email) {
            const { error: signInErr } = await supabaseAuth.auth.signInWithPassword({ email: row.email, password: pw });
            if (!signInErr) { onLogin(row); setLoading(false); return; }
          }
          setError('Wrong username or password.');
          setLoading(false);
          return;
        }

        // Legacy path — we already have the row, compare password client-side (no extra REST call)
        if (isEmailInput || !row) { setError(!ONLINE && !row ? `No cat-lover named "${input}" on this device. KittyMart accounts are saved in the browser/phone where they were made — log in on that same one, or tap Sign Up to start fresh here. (Check spelling too.)` : 'Wrong username or password.'); setLoading(false); return; }
        const hashed = await hashPassword(pw);
        const pwMatch = row.password === hashed || row.password === pw;
        if (!pwMatch) { setError('Wrong username or password.'); setLoading(false); return; }
        // Auto-migrate plaintext to hash silently
        if (row.password === pw) {
          sb(`players?id=eq.${row.id}`, 'PATCH', { password: hashed }).catch(() => {});
        }
        onLogin(row);
        setLoading(false);
        return;
      }
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const loginHoliday = getHolidayTheme();
  return (
    <div style={{ minHeight: '100vh', background: loginHoliday ? loginHoliday.gradient : 'linear-gradient(180deg,#b8e8c8 0%,#e8f5e0 40%,#fffbe6 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '"Nunito","Comic Sans MS",Georgia,serif' }}>
      <div style={{ background: 'white', borderRadius: 24, padding: 40, width: 320, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', textAlign: 'center' }}>
        <img src={kmLogo(loginHoliday)} alt="KittyMart" style={{ width: loginHoliday?.name === 'Halloween' ? 180 : 100, borderRadius: 20, marginBottom: 12 }} />
        <p style={{ color: '#888', margin: '0 0 24px', fontSize: 14 }}>Catch & trade cats with friends!</p>
        <div style={{ display: 'flex', background: '#f0f0f0', borderRadius: 12, padding: 4, marginBottom: 20 }}>
          {['login','register'].map(m => (
            <button key={m} onClick={() => { setMode(m); setError(''); }} style={{ flex: 1, padding: '8px', border: 'none', borderRadius: 10, cursor: 'pointer', fontWeight: 'bold', fontSize: 14, background: mode === m ? 'white' : 'transparent', color: mode === m ? '#764ba2' : '#888', boxShadow: mode === m ? '0 2px 8px rgba(0,0,0,0.1)' : 'none' }}>
              {m === 'login' ? 'Log In' : 'Sign Up'}
            </button>
          ))}
        </div>
        <input value={username} onChange={e => setUsername(e.target.value)} placeholder={mode === 'register' ? 'Username' : 'Username or Email'} autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ width: '100%', padding: '12px', borderRadius: 10, border: '2px solid #eee', fontSize: 16, marginBottom: 12, boxSizing: 'border-box', outline: 'none' }} />
        {mode === 'register' && (
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder={window.KM_OFFLINE ? "Email (optional)" : "Email"} autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ width: '100%', padding: '12px', borderRadius: 10, border: '2px solid #eee', fontSize: 16, marginBottom: 12, boxSizing: 'border-box', outline: 'none' }} />
        )}
        <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="Password" onKeyDown={e => e.key === 'Enter' && handleSubmit()} autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ width: '100%', padding: '12px', borderRadius: 10, border: '2px solid #eee', fontSize: 16, marginBottom: 16, boxSizing: 'border-box', outline: 'none' }} />
        {error && <p style={{ color: '#e63946', fontSize: 13, margin: '0 0 12px' }}>{error}</p>}
        <button onClick={handleSubmit} disabled={loading} style={{ width: '100%', padding: '14px', background: 'linear-gradient(135deg, #667eea, #764ba2)', color: 'white', border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 'bold', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}>
          {loading ? '...' : mode === 'login' ? 'Log In 🐾' : 'Create Account 🐱'}
        </button>
        {mode === 'login' && (
          <button onClick={() => setShowForgot(true)} style={{ marginTop:12, background:'none', border:'none', color:'#764ba2', fontSize:13, cursor:'pointer', fontWeight:'bold' }}>Forgot password?</button>
        )}
        <button onClick={() => setShowPrivacy(true)} style={{ display:'block', margin:'14px auto 0', background:'none', border:'none', color:'#aaa', fontSize:12, cursor:'pointer', textDecoration:'underline' }}>Privacy Policy</button>
      </div>
      {showPrivacy && <PrivacyPolicyModal onClose={() => setShowPrivacy(false)} />}
      {showForgot && <ForgotPasswordModal onClose={() => setShowForgot(false)} />}
    </div>
  );
}

// ─── Daily Challenges ─────────────────────────────────────────────────────────
// type: 'catch' | 'race_win' | 'poo' | 'spin' | 'feed'
const CHALLENGE_POOL = [
  // Catching
  {id:'c1', type:'catch', text:'Catch 3 Rare cats',      goal:3,  rarity:'Rare',      pts:50},
  {id:'c2', type:'catch', text:'Catch a Legendary',       goal:1,  rarity:'Legendary', pts:100},
  {id:'c3', type:'catch', text:'Catch 10 cats',           goal:10, rarity:'any',       pts:30},
  {id:'c4', type:'catch', text:'Catch 3 Epic cats',       goal:3,  rarity:'Epic',      pts:60},
  {id:'c5', type:'catch', text:'Catch 2 Uncommon cats',   goal:2,  rarity:'Uncommon',  pts:20},
  {id:'c6', type:'catch', text:'Catch 5 cats',            goal:5,  rarity:'any',       pts:15},
  {id:'c7', type:'catch', text:'Catch 15 cats',           goal:15, rarity:'any',       pts:40},
  {id:'c8', type:'catch', text:'Catch 2 Rare cats',       goal:2,  rarity:'Rare',      pts:35},
  {id:'c9', type:'catch', text:'Catch 5 Common cats',     goal:5,  rarity:'Common',    pts:10},
  // Racing
  {id:'r1', type:'race_win', text:'Win 1 race',           goal:1,  pts:60},
  {id:'r2', type:'race_win', text:'Win 3 races',          goal:3,  pts:120},
  {id:'r3', type:'race_finish', text:'Finish a race',     goal:1,  pts:25},
  {id:'r4', type:'race_finish', text:'Race 3 times',      goal:3,  pts:40},
  // Poo pickups
  {id:'p1', type:'poo', text:'Clean 3 litter trays',            goal:3,  pts:20},
  {id:'p2', type:'poo', text:'Clean 5 litter trays',            goal:5,  pts:30},
  {id:'p3', type:'poo', text:'Clean 10 litter trays',           goal:10, pts:50},
  {id:'p4', type:'poo', text:'Clean 1 litter tray',             goal:1,  pts:10},
  // Spin wheel
  {id:'s1', type:'spin', text:'Open the daily gift',           goal:1,  pts:15},
  // Feeding
  {id:'f1', type:'feed', text:'Feed 3 cats',              goal:3,  pts:15},
  {id:'f2', type:'feed', text:'Feed 5 cats',              goal:5,  pts:25},
  {id:'f3', type:'feed', text:'Feed 10 cats',             goal:10, pts:40},
  {id:'f4', type:'feed', text:'Make 4 cats purr with a snack', goal:4, pts:20},
  {id:'f5', type:'feed', text:'Fill 6 food bowls',        goal:6,  pts:30},
  {id:'p5', type:'poo', text:'Scoop 2 litter trays',      goal:2,  pts:15},
  {id:'c10', type:'catch', text:'Find 4 cats curled up napping', goal:4, rarity:'any', pts:20},
];

function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getDailyChallenges() {
  const dateStr = new Date().toDateString();
  return getDailyChallengesForDate(dateStr);
}

// Returns how many consecutive days ALL daily challenges were completed (up to 7)
function getChallengeStreak() {
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const ds = d.toDateString();
    const { challenges } = getDailyChallengesForDate(ds);
    const key = `km_daily_${ds}`;
    let prog = {};
    try { prog = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
    const allDone = challenges.every(c => (prog[c.id] || 0) >= c.goal);
    if (allDone) streak++;
    else if (i > 0) break; // gap — stop counting
  }
  return streak;
}

function getDailyChallengesForDate(dateStr) {
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) hash = (hash * 31 + dateStr.charCodeAt(i)) | 0;
  const pool = [...CHALLENGE_POOL];
  const picked = [];
  let h = Math.abs(hash);
  for (let i = 0; i < 3; i++) {
    const idx = h % (pool.length - i);
    picked.push(pool.splice(idx, 1)[0]);
    h = Math.abs((h * 1664525 + 1013904223) | 0);
  }
  return { challenges: picked, dateStr };
}

function recordChallenge(type, rarity) {
  const { challenges, dateStr } = getDailyChallenges();
  const key = `km_daily_${dateStr}`;
  let prog = {};
  try { prog = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
  const wasAllDone = challenges.every(c => (prog[c.id] || 0) >= c.goal);
  let earnedPts = 0;
  challenges.forEach(c => {
    if (c.type === type) {
      const wasDone = (prog[c.id] || 0) >= c.goal;
      if (type === 'catch') {
        if (c.rarity === 'any' || c.rarity === rarity) prog[c.id] = (prog[c.id] || 0) + 1;
      } else {
        prog[c.id] = (prog[c.id] || 0) + 1;
      }
      if (!wasDone && prog[c.id] >= c.goal) earnedPts += c.pts;
    }
  });
  try { localStorage.setItem(key, JSON.stringify(prog)); } catch {}
  // Save immediately to cloud — don't wait for debounce (bulk operations save once at the end)
  if (!_bulkMode) saveNow();
  if (earnedPts > 0) addBonusPts(earnedPts);

  // Check if all 3 challenges just became complete for the first time today
  const nowAllDone = challenges.every(c => (prog[c.id] || 0) >= c.goal);
  if (!wasAllDone && nowAllDone) {
    // Update challenge streak and check for 7-day bonus
    const streak = getChallengeStreak();
    const streakRewardKey = `km_cstreak_reward_${dateStr}`;
    if (streak >= 7 && !localStorage.getItem(streakRewardKey)) {
      localStorage.setItem(streakRewardKey, '1');
      // Random Kitty Coin prize: weighted random between 50–500 DD
      const prizes = [50, 75, 100, 100, 150, 150, 200, 200, 200, 250, 300, 500];
      const prize = prizes[Math.floor(Math.random() * prizes.length)];
      addDD(prize);
      try { window.dispatchEvent(new CustomEvent('km_challenge_streak_reward', { detail: { streak, prize } })); } catch {}
      fireFireworks(5000); // 7-day streak = big celebration!
      playSound('streak');
      setTimeout(() => fireBigWin(`${streak}-DAY STREAK!`, `You're on fire! 🔥`, '🔥', '#ff6b35', 3500, `+${prize} 🪙 Kitty Coins!`), 400);
    } else {
      fireFireworks(2500); // all daily tasks done
      playSound('achievement');
      setTimeout(() => fireBigWin('ALL DONE!', 'Daily Challenges Complete ✅', '🎯', '#51cf66', 2200, earnedPts > 0 ? `+${earnedPts} bonus pts` : ''), 300);
    }
    try { window.dispatchEvent(new CustomEvent('km_challenge_all_done', { detail: { streak } })); } catch {}
  }

  // Notify DailyChallengeBar to re-read progress
  if (!_bulkMode) { try { window.dispatchEvent(new CustomEvent('km_challenge_update')); } catch {} }
}

// Legacy alias used in catch screen
function recordCatch(rarity) { recordChallenge('catch', rarity); addStarXP('catch', rarity); }

function DailyChallengeBar() {
  const { challenges, dateStr } = getDailyChallenges();
  const key = `km_daily_${dateStr}`;
  const [prog, setProg] = useState(() => {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
  });
  const [streakRewardToast, setStreakRewardToast] = useState(null);
  // streak must be in state so it re-renders when prog updates
  const [streak, setStreak] = useState(() => getChallengeStreak());

  useEffect(() => {
    const refresh = () => {
      try {
        setProg(JSON.parse(localStorage.getItem(key) || '{}'));
        setStreak(getChallengeStreak());
      } catch {}
    };
    const onReward = (e) => {
      const prize = e.detail?.prize || 200;
      setStreakRewardToast({ prize });
      setTimeout(() => setStreakRewardToast(null), 5000);
    };
    // Refresh immediately on mount in case events fired before we were listening
    refresh();
    window.addEventListener('km_challenge_update', refresh);
    window.addEventListener('km_challenge_streak_reward', onReward);
    // Also catch localStorage writes from restorePlayerData (cross-component)
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('km_challenge_update', refresh);
      window.removeEventListener('km_challenge_streak_reward', onReward);
      window.removeEventListener('storage', refresh);
    };
  }, [key]);

  const allDoneToday = challenges.every(c => (prog[c.id] || 0) >= c.goal);

  return (
    <div style={{ marginBottom: 12 }}>
      {streakRewardToast && (
        <div style={{ background: 'linear-gradient(135deg,#ffd700,#ff9800)', borderRadius: 12, padding: '12px 14px', marginBottom: 8, textAlign: 'center', fontWeight: 'bold', color: '#7b3f00', boxShadow: '0 2px 16px rgba(255,180,0,0.5)', animation: 'none' }}>
          <div style={{ fontSize: 22, marginBottom: 2 }}>🎉</div>
          <div style={{ fontSize: 14 }}>7-Day Streak Complete!</div>
          <div style={{ fontSize: 20, fontWeight: 'bold', marginTop: 2 }}>+{streakRewardToast.prize} 🐾 Kitty Coins!</div>
          <div style={{ fontSize: 10, marginTop: 2, opacity: 0.8 }}>Prize was randomly chosen — nice work!</div>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ fontSize: 12, color: '#764ba2', fontWeight: 'bold' }}>🎯 Daily Challenges</div>
        {/* 7-day streak dots */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          {[1,2,3,4,5,6,7].map(i => (
            <div key={i} title={i === 7 ? '🎉 Random Kitty Coin prize!' : `Day ${i}`} style={{
              width: i === 7 ? 14 : 10,
              height: i === 7 ? 14 : 10,
              borderRadius: '50%',
              background: i <= streak ? (i === 7 ? 'linear-gradient(135deg,#ffd700,#ff9800)' : '#4caf50') : '#ddd',
              border: i === 7 ? '2px solid #ff9800' : 'none',
              fontSize: i === 7 ? 8 : 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontWeight: 'bold',
              boxShadow: i <= streak && i === 7 ? '0 0 6px #ffd700' : 'none',
            }}>{i === 7 ? '🐟' : ''}</div>
          ))}
          <div style={{ fontSize: 10, color: '#888', marginLeft: 4 }}>{streak}/7</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
        {challenges.map(c => {
          const count = Math.min(prog[c.id] || 0, c.goal);
          const done = count >= c.goal;
          return (
            <div key={c.id} style={{ flexShrink: 0, background: done ? '#d4edda' : '#f5f0ff', border: `1.5px solid ${done ? '#28a745' : '#c39bd3'}`, borderRadius: 16, padding: '6px 12px', fontSize: 11, whiteSpace: 'nowrap' }}>
              {done ? '✅' : '🎯'} {c.text} · {count}/{c.goal} · +{c.pts}pts
            </div>
          );
        })}
      </div>
      {allDoneToday && streak < 7 && (
        <div style={{ textAlign: 'center', fontSize: 11, color: '#4caf50', marginTop: 4, fontWeight: 'bold' }}>
          ✅ All done! {7 - streak} more day{7 - streak !== 1 ? 's' : ''} for a random Kitty Coin prize 🎉
        </div>
      )}
      {streak >= 7 && (
        <div style={{ textAlign: 'center', fontSize: 11, color: '#ff9800', marginTop: 4, fontWeight: 'bold' }}>
          🏆 7-day streak complete! Prize claimed — keep going for next week!
        </div>
      )}
    </div>
  );
}

// ─── Daily Star Track (Dreamlight-style milestone reward path) ────────────────
// Players earn Star XP from all activity. 5 milestones per day unlock rewards.
// Resets at midnight. Claimed milestones stored in localStorage.
const STAR_TRACK_MILESTONES = [
  { xp: 50,   reward: 'pts',  amount: 100,  label: '+100 ⭐',        emoji: '🌟' },
  { xp: 150,  reward: 'pts',  amount: 250,  label: '+250 ⭐',        emoji: '🌟' },
  { xp: 350,  reward: 'dd',   amount: 5,    label: '+5 🪙',          emoji: '💰' },
  { xp: 600,  reward: 'pts',  amount: 500,  label: '+500 ⭐',        emoji: '🌟' },
  { xp: 1000, reward: 'dd',   amount: 20,   label: '+20 🪙',         emoji: '🏆' },
];
const STAR_XP_REWARDS = {
  catch_common:    5,
  catch_uncommon:  8,
  catch_rare:      15,
  catch_epic:      25,
  catch_legendary: 50,
  poo:             3,
  feed:            3,
  race_finish:     20,
  race_win:        40,
  spin:            10,
};

function getStarTrackKey() { return `km_star_${localDateKey()}`; }
function getStarTrackData() {
  try { return JSON.parse(localStorage.getItem(getStarTrackKey()) || '{"xp":0,"claimed":[]}'); }
  catch { return { xp: 0, claimed: [] }; }
}
function addStarXP(type, rarity) {
  const key = rarity ? `${type}_${rarity.toLowerCase()}` : type;
  const amount = STAR_XP_REWARDS[key] || STAR_XP_REWARDS[type] || 0;
  if (!amount) return;
  const data = getStarTrackData();
  data.xp = (data.xp || 0) + amount;
  try { localStorage.setItem(getStarTrackKey(), JSON.stringify(data)); } catch {}
  if (!_bulkMode) window.dispatchEvent(new CustomEvent('km_star_update'));
  // Check for newly reached milestones and auto-claim
  STAR_TRACK_MILESTONES.forEach((m, i) => {
    if (data.xp >= m.xp && !data.claimed.includes(i)) {
      data.claimed.push(i);
      try { localStorage.setItem(getStarTrackKey(), JSON.stringify(data)); } catch {}
      if (m.reward === 'pts') addBonusPts(m.amount);
      else if (m.reward === 'dd') addDD(m.amount);
      setTimeout(() => fireBigWin('STAR REWARD! ✨', 'Daily Star Track', m.emoji, '#a78bfa', 2200, m.label), 400 + i * 100);
      if (!_bulkMode) window.dispatchEvent(new CustomEvent('km_star_update'));
    }
  });
}

function StarTrackBar() {
  const [data, setData] = useState(getStarTrackData);
  useEffect(() => {
    const refresh = () => setData(getStarTrackData());
    window.addEventListener('km_star_update', refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener('km_star_update', refresh); window.removeEventListener('storage', refresh); };
  }, []);
  const xp = data.xp || 0;
  const claimed = data.claimed || [];
  const maxXP = STAR_TRACK_MILESTONES[STAR_TRACK_MILESTONES.length - 1].xp;
  const pct = Math.min(100, (xp / maxXP) * 100);
  const nextMilestone = STAR_TRACK_MILESTONES.find((m, i) => !claimed.includes(i));
  return (
    <div style={{ background: 'linear-gradient(135deg,#1a1a2e,#16213e)', borderRadius: 18, padding: '14px 16px', marginBottom: 12, boxShadow: '0 4px 20px rgba(100,50,200,0.3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ color: '#a78bfa', fontWeight: 'bold', fontSize: 13 }}>✨ Daily Star Track</div>
        <div style={{ color: '#fbbf24', fontSize: 12, fontWeight: 'bold' }}>{xp} / {maxXP} XP</div>
      </div>
      {/* Progress bar */}
      <div style={{ position: 'relative', height: 12, background: 'rgba(255,255,255,0.1)', borderRadius: 8, marginBottom: 10 }}>
        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg,#a78bfa,#fbbf24)', borderRadius: 8, transition: 'width 0.5s ease' }} />
        {/* Milestone tick marks */}
        {STAR_TRACK_MILESTONES.map((m, i) => {
          const tickPct = (m.xp / maxXP) * 100;
          const done = claimed.includes(i);
          return (
            <div key={i} title={m.label} style={{ position: 'absolute', left: `${tickPct}%`, top: '50%', transform: 'translate(-50%,-50%)', width: 18, height: 18, borderRadius: '50%', background: done ? '#fbbf24' : 'rgba(255,255,255,0.2)', border: `2px solid ${done ? '#f59e0b' : 'rgba(255,255,255,0.3)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, zIndex: 1 }}>
              {done ? '✓' : m.emoji}
            </div>
          );
        })}
      </div>
      {/* Milestone rewards row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
        {STAR_TRACK_MILESTONES.map((m, i) => {
          const done = claimed.includes(i);
          const reachable = xp >= m.xp;
          return (
            <div key={i} style={{ flex: 1, textAlign: 'center', background: done ? 'rgba(251,191,36,0.15)' : reachable ? 'rgba(167,139,250,0.2)' : 'rgba(255,255,255,0.05)', borderRadius: 8, padding: '4px 2px', border: `1px solid ${done ? '#f59e0b55' : 'transparent'}` }}>
              <div style={{ fontSize: 14 }}>{done ? '✅' : m.emoji}</div>
              <div style={{ fontSize: 9, color: done ? '#fbbf24' : '#888', marginTop: 1 }}>{m.label}</div>
            </div>
          );
        })}
      </div>
      {nextMilestone && (
        <div style={{ textAlign: 'center', fontSize: 10, color: '#a78bfa', marginTop: 6 }}>
          Next reward at {nextMilestone.xp} XP — {Math.max(0, nextMilestone.xp - xp)} to go
        </div>
      )}
      {claimed.length === STAR_TRACK_MILESTONES.length && (
        <div style={{ textAlign: 'center', fontSize: 11, color: '#fbbf24', marginTop: 6, fontWeight: 'bold' }}>
          🏆 All star rewards claimed today! Come back tomorrow ✨
        </div>
      )}
    </div>
  );
}

// ─── Wishing Well (daily tap-for-bonus) ───────────────────────────────────────
const WELL_PRIZES = [
  { label: '+50 pts', type: 'pts', amount: 50, emoji: '⭐', color: '#f4a261' },
  { label: '+100 pts', type: 'pts', amount: 100, emoji: '⭐', color: '#f4a261' },
  { label: '+3 🪙', type: 'dd', amount: 3, emoji: '🪙', color: '#a78bfa' },
  { label: '+5 🪙', type: 'dd', amount: 5, emoji: '🪙', color: '#a78bfa' },
  { label: '+200 pts', type: 'pts', amount: 200, emoji: '💫', color: '#fbbf24' },
  { label: '+150 pts', type: 'pts', amount: 150, emoji: '⭐', color: '#f4a261' },
  { label: '+10 🪙', type: 'dd', amount: 10, emoji: '🏆', color: '#fbbf24' },
  { label: '+75 pts', type: 'pts', amount: 75, emoji: '⭐', color: '#52b788' },
];

function WishingWell() {
  const todayKey = localDateKey();
  const wellKey = `km_well_${todayKey}`;
  const [claimed, setClaimed] = useState(() => !!localStorage.getItem(wellKey));
  const [prize, setPrize] = useState(null);
  const [animating, setAnimating] = useState(false);

  const handleTap = () => {
    if (claimed || animating) return;
    setAnimating(true);
    setTimeout(() => {
      const p = WELL_PRIZES[Math.floor(Math.random() * WELL_PRIZES.length)];
      setPrize(p);
      if (p.type === 'pts') addBonusPts(p.amount);
      else addDD(p.amount);
      addStarXP('spin'); // counts toward star track
      localStorage.setItem(wellKey, '1');
      setClaimed(true);
      setAnimating(false);
      playSound('coin');
    }, 600);
  };

  return (
    <div onClick={handleTap} style={{ background: claimed ? 'linear-gradient(135deg,#1a3a2e,#0f2d1f)' : 'linear-gradient(135deg,#0f2027,#203a43,#2c5364)', borderRadius: 18, padding: '14px 16px', marginBottom: 12, cursor: claimed ? 'default' : 'pointer', boxShadow: claimed ? 'none' : '0 4px 24px rgba(16,185,129,0.3)', border: `2px solid ${claimed ? '#1a4a2e' : '#10b981'}`, textAlign: 'center', transition: 'all 0.3s' }}>
      <div style={{ fontSize: animating ? 40 : 32, transition: 'font-size 0.3s', marginBottom: 4 }}>
        {animating ? '✨' : claimed ? '🪣' : '🌊'}
      </div>
      <div style={{ fontWeight: 'bold', color: claimed ? '#4ade80' : '#10b981', fontSize: 13 }}>
        {animating ? 'The well is granting your wish…' : claimed ? `Wished! Got ${prize?.label || 'a surprise'}` : '🌊 Wishing Well — Tap for a daily wish!'}
      </div>
      {!claimed && !animating && (
        <div style={{ fontSize: 10, color: '#6ee7b7', marginTop: 3 }}>One wish per day ✨</div>
      )}
    </div>
  );
}

// ─── Achievements ──────────────────────────────────────────────────────────────
const ACHIEVEMENTS = [
  { id: 'first_catch',   label: '🐾 First Steps',    desc: 'Catch your first cat',              pts: 10,  check: (dogs) => dogs.length >= 1 },
  { id: 'trio',          label: '🐱 Little Clowder', desc: 'Catch 3 cats',                      pts: 15,  check: (dogs) => dogs.length >= 3 },
  { id: 'ten_club',      label: '🔟 Ten Club',       desc: 'Catch 10 cats',                     pts: 25,  check: (dogs) => dogs.length >= 10 },
  { id: 'big_family',    label: '🐱 Big Family',     desc: 'Catch 50 cats',                     pts: 75,  check: (dogs) => dogs.length >= 50 },
  { id: 'century',       label: '🏆 Century',        desc: 'Catch 100 cats',                    pts: 150, check: (dogs) => dogs.length >= 100 },
  { id: 'uncommon_5',    label: '✨ Uncommon Eye',   desc: 'Catch 5 Uncommon cats',             pts: 20,  check: (dogs) => dogs.filter(d=>d.rarity==='Uncommon').length >= 5 },
  { id: 'rare_hunter',   label: '🦄 Rare Hunter',    desc: 'Catch 10 Rare cats',                pts: 50,  check: (dogs) => dogs.filter(d=>d.rarity==='Rare').length >= 10 },
  { id: 'epic_3',        label: '💜 Epic Taste',     desc: 'Catch 3 Epic cats',                 pts: 80,  check: (dogs) => dogs.filter(d=>d.rarity==='Epic').length >= 3 },
  { id: 'lucky_star',    label: '🌟 Lucky Star',     desc: 'Catch your first Legendary',        pts: 100, check: (dogs) => dogs.some(d=>d.rarity==='Legendary') },
  { id: 'legend',        label: '👑 Legend',         desc: 'Catch 5 Legendary cats',            pts: 250, check: (dogs) => dogs.filter(d=>d.rarity==='Legendary').length >= 5 },
  { id: 'diversity',     label: '🌈 Collector',      desc: 'Own 10 different breeds',           pts: 60,  check: (dogs) => new Set(dogs.map(d=>d.breed)).size >= 10 },
  { id: 'half_dex',      label: '📖 Half-Dex',       desc: 'Discover 50% of all breeds',        pts: 120, check: (dogs) => new Set(dogs.map(d=>d.breed)).size >= Math.floor(DOG_BREEDS.length/2) },
  { id: 'full_dex',      label: '🎖️ Full Dex',      desc: 'Discover every breed',              pts: 500, check: (dogs) => new Set(dogs.map(d=>d.breed)).size >= DOG_BREEDS.length },
  { id: 'streak_3',      label: '🔥 On Fire',        desc: '3-day login streak',                pts: 30,  check: () => parseInt(localStorage.getItem('km_streak')||'0',10) >= 3 },
  { id: 'streak_7',      label: '🔥🔥 Week Warrior', desc: '7-day login streak',                pts: 75,  check: () => parseInt(localStorage.getItem('km_streak')||'0',10) >= 7 },
  { id: 'streak_30',     label: '🔥🔥🔥 Monthly',   desc: '30-day login streak',               pts: 300, check: () => parseInt(localStorage.getItem('km_streak')||'0',10) >= 30 },
  { id: 'nap_5',         label: '🛏️ Cosy Napper',    desc: 'Tuck cats in for 5 naps (😴 button)', pts: 20,  check: () => parseInt(localStorage.getItem('km_nap_count')||'0',10) >= 5 },
  { id: 'purr_10',       label: '😽 Purr Maker',     desc: 'Feed your cats 10 times',           pts: 20,  check: () => parseInt(localStorage.getItem('km_feed_count')||'0',10) >= 10 },
  { id: 'tidy_5',        label: '🧹 Tidy Tray',      desc: 'Scoop 5 litter trays',              pts: 20,  check: () => parseInt(localStorage.getItem('km_poo_count')||'0',10) >= 5 },
  { id: 'nine_lives',    label: '🐈 Nine Lives',     desc: 'Own 9 cats of the same breed',      pts: 60,  check: (dogs) => { const c = {}; return dogs.some(d => (c[d.breed] = (c[d.breed]||0)+1) >= 9); } },
  { id: 'cat_cafe',      label: '☕ Cat Café',        desc: 'Have 20 cats in your collection',   pts: 40,  check: (dogs) => dogs.length >= 20 },
];

function checkAchievements(dogs, setToast) {
  let unlocked = {};
  try { unlocked = JSON.parse(localStorage.getItem('km_ach') || '{}'); } catch {}
  const newUnlocks = [];
  let bonusTotal = 0;
  ACHIEVEMENTS.forEach(a => {
    if (!unlocked[a.id] && a.check(dogs)) {
      unlocked[a.id] = true;
      newUnlocks.push(a.label);
      bonusTotal += (a.pts || 0);
    }
  });
  if (newUnlocks.length) {
    try { localStorage.setItem('km_ach', JSON.stringify(unlocked)); } catch {}
    if (bonusTotal > 0) addBonusPts(bonusTotal);
    haptic('success');
    setToast(`🏆 ${newUnlocks[0]}${newUnlocks.length > 1 ? ` +${newUnlocks.length-1} more` : ''} · +${bonusTotal}pts`);
    playSound('achievement');
    fireFireworks(3000); // Achievement unlocked — celebrate!
    setTimeout(() => fireBigWin('ACHIEVEMENT!', newUnlocks[0], '🏆', '#ffd700', 2600, `+${bonusTotal} bonus pts`), 500);
  }
}

// ─── Weekly Community Goal ────────────────────────────────────────────────────
// Shared counter in km_races table using a sentinel row (no extra table needed)
// We store community_catches in a special km_races row with id='community_goal'
const COMMUNITY_GOAL_TARGET = 500;
const COMMUNITY_GOAL_ROW = 'community_goal_v1';

function getWeekKey() {
  const now = new Date();
  // Shift so week starts Monday (move Sunday to end: Sun=6, Mon=0…Sat=5)
  const day = (now.getDay() + 6) % 7; // 0=Mon … 6=Sun
  const monday = new Date(now);
  monday.setDate(now.getDate() - day);
  monday.setHours(0, 0, 0, 0);
  return `${monday.getFullYear()}_m${monday.getMonth() + 1}_d${monday.getDate()}`;
}

// Call this directly whenever a dog is caught — no DOM events needed
async function incrementCommunityGoal() {
  // Let the banner show the new count right away instead of waiting for its next 30s poll.
  try { window.dispatchEvent(new Event('km_cgoal_bump')); } catch {}
  try {
    const rowId = `${COMMUNITY_GOAL_ROW}_${getWeekKey()}`;
    const existing = await sb(`km_presence?player_id=eq.${rowId}&select=username`);
    if (existing && existing[0]) {
      const cur = parseInt(existing[0].username || '0', 10);
      await sb(`km_presence?player_id=eq.${rowId}`, 'PATCH', { username: String(cur + 1), last_seen: new Date().toISOString() });
    } else {
      await sb('km_presence', 'POST', { player_id: rowId, username: '1', last_seen: new Date().toISOString() });
    }
  } catch {}
}

function CommunityGoalBanner({ player, dogs }) {
  const weekKey = getWeekKey();
  const cacheKey = `cgoal_cache_${weekKey}`; // no km_ prefix: km_* keys are synced to the cloud on every write
  // Start from the last value we saw so the banner appears instantly instead of after the first request.
  const [progress, setProgress] = React.useState(() => {
    const c = parseInt(localStorage.getItem(cacheKey) || '', 10);
    return Number.isFinite(c) ? c : null;
  });
  const [rewarded, setRewarded] = React.useState(false);
  const rewardKey = `km_cgoal_${weekKey}`;

  React.useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        // Use km_presence table as a lightweight KV store with player_id as key
        const row = await sb(`km_presence?player_id=eq.${COMMUNITY_GOAL_ROW}_${weekKey}&select=*`);
        const val = row && row[0] ? parseInt(row[0].username || '0', 10) : 0;
        if (mounted) setProgress(val);
        try { localStorage.setItem(cacheKey, String(val)); } catch {}
      } catch { if (mounted) setProgress(p => (p === null ? 0 : p)); } // keep the last known value on a slow/failed request
    };
    load();
    const interval = setInterval(load, 30000);
    // Our own catches show up immediately; the next poll then corrects it with the shared total.
    const bump = () => { if (mounted) setProgress(p => (p === null ? 1 : p + 1)); };
    window.addEventListener('km_cgoal_bump', bump);
    return () => { mounted = false; clearInterval(interval); window.removeEventListener('km_cgoal_bump', bump); };
  }, [weekKey]);

  // Progress is polled every 30s; no local event listener needed —
  // incrementCommunityGoal() is called directly from the catch handler.

  React.useEffect(() => {
    const claimed = localStorage.getItem(rewardKey) === '1';
    setRewarded(claimed);
  }, [rewardKey]);

  const claimReward = () => {
    if (rewarded) return;
    localStorage.setItem(rewardKey, '1');
    addBonusPts(250);
    window.dispatchEvent(new Event('km_pts_change'));
    setRewarded(true);
    haptic('medium');
  };

  if (progress === null) return null;
  const pct = Math.min(100, Math.round((progress / COMMUNITY_GOAL_TARGET) * 100));
  const completed = progress >= COMMUNITY_GOAL_TARGET;

  return (
    <div style={{ background: completed ? 'linear-gradient(135deg,#ffd700,#ffb300)' : 'linear-gradient(135deg,#e8f5e9,#c8e6c0)', border: `2px solid ${completed ? '#ffd700' : '#81c784'}`, borderRadius: 16, padding: 14, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <div style={{ fontWeight: 'bold', fontSize: 13, color: completed ? '#7b4f00' : '#2e7d32' }}>🌍 Weekly Community Goal</div>
          <div style={{ fontSize: 12, color: completed ? '#7b4f00' : '#555', marginTop: 2 }}>Catch {COMMUNITY_GOAL_TARGET} cats together this week!</div>
        </div>
        <div style={{ fontSize: 11, fontWeight: 'bold', color: completed ? '#7b4f00' : '#2e7d32', textAlign: 'right' }}>
          {progress}/{COMMUNITY_GOAL_TARGET}
        </div>
      </div>
      <div style={{ background: 'rgba(255,255,255,0.5)', borderRadius: 8, height: 10, overflow: 'hidden', marginBottom: 8 }}>
        <div style={{ background: completed ? 'linear-gradient(90deg,#ff9800,#e65100)' : 'linear-gradient(90deg,#4caf50,#2e7d32)', width: `${pct}%`, height: '100%', borderRadius: 8, transition: 'width 0.6s ease' }} />
      </div>
      {completed ? (
        <button onClick={claimReward} disabled={rewarded}
          style={{ width: '100%', padding: '8px', background: rewarded ? '#ccc' : 'linear-gradient(135deg,#ff9800,#e65100)', color: 'white', border: 'none', borderRadius: 10, fontSize: 13, fontWeight: 'bold', cursor: rewarded ? 'default' : 'pointer' }}>
          {rewarded ? '✅ Reward Claimed!' : '🎁 Claim Reward: +250 pts!'}
        </button>
      ) : (
        <div style={{ fontSize: 11, color: '#2e7d32', textAlign: 'center', fontWeight: 'bold' }}>
          🎁 Goal complete = everyone gets +250 bonus pts! · {pct}% there
        </div>
      )}
    </div>
  );
}

// ─── Mystery Dog of the Day ───────────────────────────────────────────────────
function MysteryDogCard({ player, today }) {
  const isoDay = today || localDateKey();
  const dateStr = new Date(isoDay + 'T12:00:00').toDateString();
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) hash = (hash * 31 + dateStr.charCodeAt(i)) | 0;
  const idx = Math.abs(hash) % DOG_BREEDS.length;
  const mystery = DOG_BREEDS[idx];
  const storageKey = `km_mystery_${isoDay}`;
  const [revealed, setRevealed] = useState(false);
  const [resultMsg, setResultMsg] = useState('');
  const [used, setUsed] = useState(() => !!localStorage.getItem(storageKey));
  // Reset used state when the day changes
  React.useEffect(() => { setUsed(!!localStorage.getItem(storageKey)); setRevealed(false); setResultMsg(''); }, [storageKey]);

  const handleReveal = async () => {
    if (used) return;
    const lucky = Math.random() < 0.5;
    const ddDelta = lucky ? 20 : 0;
    if (ddDelta > 0) addDD(ddDelta);
    setRevealed(true);
    setResultMsg(lucky ? '✨ Lucky! +20 Kitty Coins! 🐱' : '😅 Better luck tomorrow!');
    try {
      localStorage.setItem(storageKey, '1');
      localStorage.setItem('km_mystery_count', (parseInt(localStorage.getItem('km_mystery_count')||'0')+1).toString());
    } catch {}
    setUsed(true);
  };

  return (
    <div style={{background:'linear-gradient(135deg,#1a1a2e,#16213e)',borderRadius:16,padding:16,marginBottom:16,color:'white',textAlign:'center',border:'2px solid #764ba2'}}>
      <div style={{fontWeight:'bold',fontSize:14,marginBottom:6,color:'#c39bd3'}}>🔮 Mystery Cat of the Day</div>
      {!revealed && !used ? (
        <>
          <div style={{fontSize:40,marginBottom:6}}>❓</div>
          <div style={{color:'#aaa',fontSize:13,marginBottom:10}}>A mysterious cat awaits…</div>
          <button onClick={handleReveal} style={{padding:'10px 24px',background:'linear-gradient(135deg,#764ba2,#667eea)',color:'white',border:'none',borderRadius:14,fontWeight:'bold',fontSize:14,cursor:'pointer'}}>🔮 Reveal!</button>
        </>
      ) : (
        <>
          <div style={{fontSize:40,marginBottom:4}}>🐱</div>
          <div style={{fontWeight:'bold',fontSize:16,color:'#ffd700',marginBottom:2}}>{mystery.name}</div>
          <div style={{fontSize:12,color:RARITY_COLORS[mystery.rarity],marginBottom:6}}>{mystery.rarity}</div>
          {resultMsg && <div style={{fontSize:16,fontWeight:'bold',color:resultMsg.includes('Lucky')?'#ffd700':'#e63946',marginBottom:4}}>{resultMsg}</div>}
          {used && !resultMsg && <div style={{fontSize:12,color:'#888'}}>Come back tomorrow for a new mystery!</div>}
        </>
      )}
    </div>
  );
}

// ─── Confetti Effect ──────────────────────────────────────────────────────────
function ConfettiEffect({ onDone }) {
  const colors = ['#ffd700','#f72585','#7b2ff7','#4cc9f0','#ff6b6b','#51cf66','#ffa94d'];
  const pieces = Array.from({ length: 60 }, (_, i) => ({
    id: i,
    color: colors[i % colors.length],
    left: Math.random() * 100,
    delay: Math.random() * 0.8,
    size: 8 + Math.random() * 10,
    duration: 1.5 + Math.random() * 1.2,
    spin: Math.random() > 0.5,
  }));
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, [onDone]);
  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 9999, overflow: 'hidden' }}>
      <style>{`
        @keyframes confettiFall { 0%{top:-5%;opacity:1;} 100%{top:110%;opacity:0;} }
        @keyframes confettiSpin { 0%{transform:rotate(0deg);} 100%{transform:rotate(720deg);} }
      `}</style>
      {pieces.map(p => (
        <div key={p.id} style={{
          position: 'absolute', left: `${p.left}%`, top: '-5%',
          width: p.size, height: p.size, borderRadius: p.spin ? '50%' : 2,
          background: p.color, opacity: 1,
          animation: `confettiFall ${p.duration}s ${p.delay}s ease-in forwards${p.spin ? `, confettiSpin ${p.duration * 0.5}s ${p.delay}s linear infinite` : ''}`,
        }} />
      ))}
    </div>
  );
}

// ─── Recent Catches helpers ────────────────────────────────────────────────────
function pushRecentCatch(breed, rarity, photoUrl) {
  try {
    const key = 'km_recent_catches';
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    arr.unshift({ breed, rarity, photoUrl, ts: Date.now() });
    localStorage.setItem(key, JSON.stringify(arr.slice(0, 8)));
  } catch {}
}
function getRecentCatches() {
  try { return JSON.parse(localStorage.getItem('km_recent_catches') || '[]'); } catch { return []; }
}

// ─── KittyDex Screen ───────────────────────────────────────────────────────────
function KittyDexScreen({ dogs, onBack }) {
  const RARITIES = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
  // Map breed name → best photo from owned dogs
  const ownedMap = {};
  dogs.forEach(d => { if (!ownedMap[d.breed]) ownedMap[d.breed] = catPhotoFor(d) || d.photo_url; });
  const total  = DOG_BREEDS.length;
  const caught = Object.keys(ownedMap).length;
  const pct    = Math.round((caught / total) * 100);

  return (
    <div style={{ padding: 16 }}>
      <button onClick={onBack} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', marginBottom: 8 }}>← Back</button>
      <h2 style={{ margin: '0 0 4px', textAlign: 'center', color: '#333' }}>📖 Breed KittyDex</h2>
      <p style={{ textAlign: 'center', color: '#888', fontSize: 13, margin: '0 0 10px' }}>{caught} / {total} breeds discovered</p>
      {/* Overall progress bar */}
      <div style={{ background: '#eee', borderRadius: 8, height: 12, overflow: 'hidden', marginBottom: 20 }}>
        <div style={{ background: 'linear-gradient(135deg,#667eea,#764ba2)', width: `${pct}%`, height: '100%', borderRadius: 8, transition: 'width 0.5s' }} />
      </div>
      {RARITIES.map(r => {
        const breeds = DOG_BREEDS.filter(b => b.rarity === r);
        const rCaught = breeds.filter(b => ownedMap[b.name]).length;
        return (
          <div key={r} style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontWeight: 'bold', color: RARITY_COLORS[r], fontSize: 15 }}>{r}</span>
              <span style={{ fontSize: 12, color: '#888' }}>{rCaught}/{breeds.length}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {breeds.map(b => {
                const photo = ownedMap[b.name] || localStorage.getItem(`km_photo_${b.name}`) || null;
                const isCaught = !!ownedMap[b.name];
                return (
                  <div key={b.name} style={{ textAlign: 'center', background: isCaught ? 'white' : '#f5f5f5', borderRadius: 12, padding: 8, border: `2px solid ${isCaught ? RARITY_COLORS[r] : '#eee'}` }}>
                    {isCaught && photo
                      ? <img src={photo} alt={b.name} style={{ width: 52, height: 52, borderRadius: '50%', objectFit: 'cover', border: `2px solid ${RARITY_COLORS[r]}` }} onError={e => e.target.style.display='none'} />
                      : <div style={{ width: 52, height: 52, borderRadius: '50%', background: '#ddd', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto', fontSize: 24 }}>❓</div>
                    }
                    <div style={{ fontSize: 9, fontWeight: 'bold', color: isCaught ? '#333' : '#bbb', marginTop: 4, lineHeight: 1.2 }}>{isCaught ? b.name : '???'}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Daily Gift ───────────────────────────────────────────────────────────────
// Once a day the player picks one of three wrapped gift boxes. Every box holds a prize, the three possible prizes are
// shown up front, nothing is staked and nothing can be lost (no wheel, no jackpot, no real money involved).
const DAILY_GIFT_PRIZES = [15, 30, 60];

function DailyGiftModal({ onClose, onWin }) {
  const [boxes] = useState(() => {
    const a = [...DAILY_GIFT_PRIZES];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  });
  const [picked, setPicked] = useState(null);

  const pick = (i) => {
    if (picked !== null) return;
    setPicked(i);
    const prize = boxes[i];
    addDD(prize);
    haptic('success');
    playSound('gift');
    if (prize >= 60) fireFireworks(2000); // the best gift gets fireworks
    onWin(prize);
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.85)', zIndex:800, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div style={{ background:'white', borderRadius:24, padding:24, width:'100%', maxWidth:360, textAlign:'center' }}>
        <div style={{ fontSize:28, marginBottom:4 }}>🎁 Daily Gift!</div>
        <p style={{ color:'#888', fontSize:13, margin:'0 0 6px' }}>{picked === null ? 'Pick a gift box. Every box has a prize!' : 'Enjoy your gift!'}</p>
        <p style={{ color:'#aaa', fontSize:12, margin:'0 0 16px' }}>Today's gifts: {DAILY_GIFT_PRIZES.join(', ')} 🐱$</p>
        <div style={{ display:'flex', gap:10, justifyContent:'center', marginBottom:16 }}>
          {boxes.map((prize, i) => {
            const opened = picked !== null;
            const mine = picked === i;
            return (
              <button key={i} onClick={() => pick(i)} disabled={opened} aria-label={opened ? `Box ${i + 1}: ${prize} Kitty Coins` : `Gift box ${i + 1}`}
                style={{ flex:1, padding:'14px 4px', border: mine ? '3px solid #764ba2' : '2px solid #eee', borderRadius:16, background: mine ? '#f5f0ff' : '#fff', cursor: opened ? 'default' : 'pointer', opacity: opened && !mine ? 0.55 : 1, transition:'all 0.2s' }}>
                <div style={{ fontSize:44, lineHeight:1.1 }}>{opened ? (mine ? '🎉' : '📦') : '🎁'}</div>
                <div style={{ fontSize:14, fontWeight:'bold', color: mine ? '#764ba2' : '#888', marginTop:6, minHeight:20 }}>{opened ? `${prize} 🐱$` : `Box ${i + 1}`}</div>
              </button>
            );
          })}
        </div>
        {picked !== null ? (
          <div>
            <div style={{ fontSize:20, fontWeight:'bold', color:'#764ba2', marginBottom:10 }}>{`+${boxes[picked]} Kitty Coins! 🐱`}</div>
            <button onClick={onClose} style={{ width:'100%', padding:14, background:'linear-gradient(135deg,#667eea,#764ba2)', color:'white', border:'none', borderRadius:14, fontSize:15, fontWeight:'bold', cursor:'pointer' }}>Awesome! 🎉</button>
          </div>
        ) : (
          <button onClick={onClose} style={{ marginTop:2, width:'100%', padding:10, background:'#eee', border:'none', borderRadius:12, fontSize:14, cursor:'pointer' }}>Maybe later</button>
        )}
      </div>
    </div>
  );
}

// ─── Friends Gallery ──────────────────────────────────────────────────────────
function FriendsGalleryModal({ onClose, initialQuery }) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState(null);
  const [profileDogs, setProfileDogs] = useState([]);
  const [error, setError] = useState('');
  const [showReportGate, setShowReportGate] = useState(false);
  // Opened from the leaderboard: look that player up straight away so Report / Block are one tap away.
  useEffect(() => { if (initialQuery) { setQuery(initialQuery); search(initialQuery); } }, []); // eslint-disable-line

  const search = async (override) => {
    const q = (typeof override === 'string' ? override : query).trim();
    if (!q) return;
    setLoading(true); setError(''); setProfile(null); setProfileDogs([]);
    try {
      const results = await sb(`players?username=ilike.${encodeURIComponent(q)}&select=id,username,race_wins,total_pts&limit=1`);
      if (!results.length) { setError('No player found with that username.'); setLoading(false); return; }
      const p = results[0];
      if (getBlockedPlayers().includes(p.id)) { setError('No player found with that username.'); setLoading(false); return; }
      const dogs = await sb(`cats?owner_id=eq.${p.id}&select=name,breed,rarity,photo_url&limit=50&order=rarity.desc`);
      setProfile(p);
      setProfileDogs(dogs);
    } catch (e) { setError('Search failed: ' + e.message); }
    setLoading(false);
  };

  // Portal to <body> (like PrivacyPolicyModal) so the sheet isn't trapped under the bottom tab bar by the scrolling Settings container.
  return ReactDOM.createPortal(
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:1100, display:'flex', alignItems:'flex-end', justifyContent:'center' }} onClick={onClose}>
      <div style={{ background:'white', borderRadius:'24px 24px 0 0', padding:'24px 24px calc(env(safe-area-inset-bottom, 0px) + 24px)', width:'100%', maxWidth:440, maxHeight:'85vh', overflowY:'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
          <h3 style={{ margin:0, color:'#764ba2' }}>👥 Find a Friend</h3>
          <button onClick={onClose} style={{ background:'none', border:'none', fontSize:22, cursor:'pointer' }}>✕</button>
        </div>
        <div style={{ display:'flex', gap:8, marginBottom:16 }}>
          <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key==='Enter' && search()}
            placeholder="Enter exact username…" style={{ flex:1, padding:'10px 14px', borderRadius:12, border:'2px solid #c39bd3', fontSize:14, outline:'none' }} />
          <button onClick={search} disabled={loading} style={{ padding:'10px 16px', background:'linear-gradient(135deg,#667eea,#764ba2)', color:'white', border:'none', borderRadius:12, fontWeight:'bold', cursor:'pointer', fontSize:14 }}>
            {loading ? '…' : '🔍'}
          </button>
        </div>
        {error && <p style={{ color:'#e63946', fontSize:13, textAlign:'center' }}>{error}</p>}
        {profile && (
          <div>
            <div style={{ background:'linear-gradient(135deg,#f5f0ff,#e8f4fd)', borderRadius:16, padding:16, marginBottom:16, textAlign:'center' }}>
              <div style={{ fontSize:40, marginBottom:4 }}>🐾</div>
              <div style={{ fontWeight:'bold', fontSize:18, color:'#333' }}>{publicName(profile.username)}</div>
              <div style={{ fontSize:13, color:'#888', marginTop:4 }}>
                🐱 {profileDogs.length} cats shown · 🏁 {profile.race_wins||0} race wins · ⭐ {profile.total_pts||0} pts
              </div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10 }}>
              {profileDogs.map((d, i) => (
                <div key={i} style={{ textAlign:'center', background:'white', borderRadius:14, padding:10, border:`2px solid ${RARITY_COLORS[d.rarity]||'#eee'}` }}>
                  <img src={dogImageSrc(d) || d.photo_url} alt={d.breed} style={{ width:60, height:60, borderRadius:'50%', objectFit:'cover', border:`3px solid ${RARITY_COLORS[d.rarity]}` }} onError={e=>e.target.style.display='none'} />
                  <div style={{ fontSize:10, fontWeight:'bold', color:'#333', marginTop:4, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{d.name||d.breed}</div>
                  <div style={{ fontSize:9, color:RARITY_COLORS[d.rarity], fontWeight:'bold' }}>{d.rarity}</div>
                </div>
              ))}
            </div>
            {profileDogs.length === 50 && <p style={{ color:'#aaa', fontSize:12, textAlign:'center', marginTop:8 }}>Showing top 50 cats by rarity</p>}
            <div style={{ display:'flex', gap:8, marginTop:16 }}>
              <button onClick={() => setShowReportGate(true)} style={{ flex:1, padding:10, background:'#fff3cd', color:'#856404', border:'none', borderRadius:10, fontWeight:'bold', fontSize:13, cursor:'pointer' }}>🚩 Report</button>
              <button onClick={() => { blockPlayer(profile.id); setProfile(null); setProfileDogs([]); setError('Player blocked. You will no longer see them.'); }} style={{ flex:1, padding:10, background:'#f8d7da', color:'#721c24', border:'none', borderRadius:10, fontWeight:'bold', fontSize:13, cursor:'pointer' }}>🚫 Block</button>
            </div>
            {showReportGate && (
              <ParentalGateModal
                onClose={() => setShowReportGate(false)}
                onSuccess={() => { setShowReportGate(false); window.location.href = `mailto:the KittyMart team?subject=${encodeURIComponent('Report player: ' + profile.username)}&body=${encodeURIComponent('Player ID: ' + profile.id + '\nReason: ')}`; }}
              />
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// ─── Home Screen ─────────────────────────────────────────────────────────────
// ─── Yarn Chase mini-game (cat-only) ─────────────────────────────────────────
function YarnChase() {
  const key = 'km_yarn_' + localDateKey();
  const getPlays = () => { try { return parseInt(localStorage.getItem(key) || '0', 10) || 0; } catch { return 0; } };
  const [plays, setPlays] = React.useState(getPlays);
  const [running, setRunning] = React.useState(false);
  const [time, setTime] = React.useState(15);
  const [score, setScore] = React.useState(0);
  const [pos, setPos] = React.useState({ x: 50, y: 50 });
  const [done, setDone] = React.useState(null);
  const scoreRef = React.useRef(0);
  React.useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTime(v => v - 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  React.useEffect(() => {
    if (running && time <= 0) {
      setRunning(false);
      const pts = Math.min(scoreRef.current, 15);
      if (pts > 0) addBonusPts(pts);
      setDone(pts);
    }
  }, [time, running]);
  const start = () => {
    if (plays >= 3) return;
    try { localStorage.setItem(key, String(plays + 1)); } catch {}
    setPlays(plays + 1); scoreRef.current = 0; setScore(0); setTime(15); setDone(null); setRunning(true);
  };
  const hit = () => {
    scoreRef.current += 1; setScore(scoreRef.current);
    try { playMeow(); } catch {}
    setPos({ x: 8 + Math.random() * 78, y: 8 + Math.random() * 72 });
  };
  return (
    <div data-testid="yarn-chase" style={{ background: 'white', borderRadius: 16, padding: 12, margin: '10px 0', border: '2px solid #ffd6e7' }}>
      <div style={{ fontWeight: 'bold', fontSize: 13, color: '#c2185b' }}>🧶 Yarn Chase · {3 - plays} play{3 - plays === 1 ? '' : 's'} left today</div>
      {!running && <div style={{ fontSize: 12, color: '#666', margin: '4px 0 8px' }}>{done !== null ? `Great pounce! ${score} catches = +${done} pts` : 'Tap the yarn ball as fast as you can for 15 seconds. Up to 15 pts!'}</div>}
      {running ? (
        <div>
          <div style={{ fontSize: 12, fontWeight: 'bold', color: '#764ba2' }}>⏱ {time}s · 🧶 {score}</div>
          <div style={{ position: 'relative', height: 150, background: '#fff0f6', borderRadius: 12, marginTop: 6, overflow: 'hidden' }}>
            <button aria-label="yarn ball" onClick={hit} style={{ position: 'absolute', left: pos.x + '%', top: pos.y + '%', fontSize: 32, background: 'none', border: 'none', cursor: 'pointer', transition: 'left 0.15s, top 0.15s', padding: 0 }}>🧶</button>
          </div>
        </div>
      ) : (
        <button onClick={start} disabled={plays >= 3} style={{ padding: '8px 16px', background: plays >= 3 ? '#eee' : 'linear-gradient(135deg,#ff6fa5,#c2185b)', color: plays >= 3 ? '#aaa' : 'white', border: 'none', borderRadius: 12, fontWeight: 'bold', cursor: 'pointer' }}>{plays >= 3 ? 'Come back tomorrow' : 'Play 🧶'}</button>
      )}
    </div>
  );
}

function HomeScreen({ player, dogs, stats, onNavigate }) {
  const bonusPts = useLive(getBonusPts, 'km_pts_change');
  const totalPoints = (stats ? stats.pts : calcPoints(dogs)) + bonusPts;
  const dd = useLive(getDD, 'km_dd_change');
  // Midnight reset: force re-render when the day changes so spin/mystery refresh automatically
  const [todayKey, setTodayKey] = React.useState(() => localDateKey());
  React.useEffect(() => {
    const msUntilMidnight = () => {
      const now = new Date();
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      return midnight - now;
    };
    let timer;
    const scheduleMidnight = () => {
      timer = setTimeout(() => {
        setTodayKey(localDateKey());
        scheduleMidnight();
      }, msUntilMidnight());
    };
    scheduleMidnight();
    return () => clearTimeout(timer);
  }, []);
  let unlockedAch = {};
  try { unlockedAch = JSON.parse(localStorage.getItem('km_ach') || '{}'); } catch {}
  const achCount = Object.values(unlockedAch).filter(Boolean).length;
  const recent = getRecentCatches();
  const catchCount = parseInt(localStorage.getItem('km_catch_count') || '0', 10);
  const nextBox = 10 - (catchCount % 10);
  const boxPct = Math.round(((catchCount % 10) / 10) * 100);
  const [streakInfo] = useState(() => checkLoginStreak());
  const [showStreak, setShowStreak] = useState(streakInfo.isNew);
  useEffect(() => {
    if (showStreak) {
      playSound(streakInfo.streak >= 7 ? 'streak' : streakInfo.streak >= 3 ? 'achievement' : 'coin');
      if (streakInfo.streak >= 7) {
        fireFireworks(4000);
        setTimeout(() => fireBigWin(`${streakInfo.streak}-DAY STREAK! 🔥`, 'You\'re unstoppable!', '🔥', '#ff6b35', 3000, `+${streakInfo.reward} bonus pts`), 500);
      }
      const t = setTimeout(() => setShowStreak(false), 4000);
      return () => clearTimeout(t);
    }
  }, [showStreak]); // eslint-disable-line
  const streak = parseInt(localStorage.getItem('km_streak') || '1', 10);
  // Collection completeness
  const uniqueBreeds = stats ? stats.breeds : new Set(dogs.map(d => d.breed)).size;
  const totalBreeds = Math.max(DOG_BREEDS.length, uniqueBreeds);
  const [showKittyDex, setShowKittyDex] = useState(false);
  // Daily spin wheel
  const todayStr = todayKey;
  const lastSpin = localStorage.getItem('km_last_spin') || '';
  const canSpin = lastSpin !== todayStr;
  const [showSpin, setShowSpin] = useState(false);
  const [showFriends, setShowFriends] = useState(false);
  const handleSpinWin = () => { localStorage.setItem('km_last_spin', todayStr); recordChallenge('spin'); addStarXP('spin'); };
  if (showKittyDex) return <KittyDexScreen dogs={dogs} onBack={() => setShowKittyDex(false)} />;
  const { challenges, dateStr } = getDailyChallenges();
  const key = `km_daily_${dateStr}`;
  let prog = {};
  try { prog = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
  return (
    <div style={{ padding: 16 }}>
      {showStreak && (
        <div style={{ position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', background: 'linear-gradient(135deg,#f4a261,#e76f51)', color: 'white', borderRadius: 20, padding: '12px 24px', fontWeight: 'bold', fontSize: 15, zIndex: 999, boxShadow: '0 4px 20px rgba(0,0,0,0.3)', textAlign: 'center', whiteSpace: 'nowrap' }}>
          🔥 {streak}-day streak! +{streakInfo.reward}pts bonus!
        </div>
      )}
      <div style={{ background: 'linear-gradient(135deg, #fff3e0, #ffe0b2)', borderRadius: 20, padding: '20px 16px', marginBottom: 16, textAlign: 'center', border: '2px solid #f4a261' }}>
        <div style={{ fontSize: 32, marginBottom: 4 }}>🐾</div>
        <div style={{ fontSize: 20, fontWeight: 'bold', color: '#333' }}>Welcome back, {player.username}!</div>
        <div style={{ fontSize: 13, color: '#e76f51', fontWeight: 'bold', marginTop: 4 }}>🔥 {streak}-day streak</div>
      </div>
      <div style={{ background: 'white', borderRadius: 16, padding: 16, marginBottom: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', border: '2px solid #f0e8ff' }}>
        <div style={{ fontWeight: 'bold', color: '#764ba2', marginBottom: 10, fontSize: 14 }}>📊 Your Stats</div>
        <div style={{ display: 'flex', justifyContent: 'space-around', marginBottom: 10 }}>
          <div style={{ textAlign: 'center' }}><div style={{ fontSize: 22, fontWeight: 'bold', color: '#333' }}>{stats ? stats.count : dogs.length}</div><div style={{ fontSize: 11, color: '#888' }}>Cats</div></div>
          <div style={{ textAlign: 'center' }}><div style={{ fontSize: 22, fontWeight: 'bold', color: '#764ba2' }}>{totalPoints}</div><div style={{ fontSize: 11, color: '#888' }}>Points</div></div>
          <div style={{ textAlign: 'center' }}><div style={{ fontSize: 22, fontWeight: 'bold', color: '#f4a261' }}>{achCount}</div><div style={{ fontSize: 11, color: '#888' }}>Badges</div></div>
          <div style={{ textAlign: 'center' }}><div style={{ fontSize: 22, fontWeight: 'bold', color: '#52b788' }}>{uniqueBreeds}</div><div style={{ fontSize: 11, color: '#888' }}>Breeds</div></div>
          <div style={{ textAlign: 'center' }}><div style={{ fontSize: 22, fontWeight: 'bold', color: '#e76f51' }}><DDIcon size={22} />{dd}</div><div style={{ fontSize: 11, color: '#888' }}>Coins</div></div>
        </div>
        {/* KittyDex progress */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, background: '#eee', borderRadius: 6, height: 8, overflow: 'hidden' }}>
            <div style={{ background: 'linear-gradient(135deg,#52b788,#2d6a4f)', width: `${Math.round(uniqueBreeds/totalBreeds*100)}%`, height: '100%', borderRadius: 6 }} />
          </div>
          <button onClick={() => setShowKittyDex(true)} style={{ background: 'linear-gradient(135deg,#52b788,#2d6a4f)', color: 'white', border: 'none', borderRadius: 12, padding: '4px 10px', fontSize: 11, fontWeight: 'bold', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            📖 {uniqueBreeds}/{totalBreeds}
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <button onClick={() => onNavigate('catch')} style={{ flex: 1, minWidth: 70, padding: '14px 8px', background: 'linear-gradient(135deg, #667eea, #764ba2)', color: 'white', border: 'none', borderRadius: 14, fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>🧶 Go Catch!</button>
        <button onClick={() => onNavigate('collection')} style={{ flex: 1, minWidth: 70, padding: '14px 8px', background: 'linear-gradient(135deg, #52b788, #2d6a4f)', color: 'white', border: 'none', borderRadius: 14, fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>🐱 My Cats</button>
        <button onClick={() => onNavigate('race')} style={{ flex: 1, minWidth: 70, padding: '14px 8px', background: 'linear-gradient(135deg, #f4a261, #e76f51)', color: 'white', border: 'none', borderRadius: 14, fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>🏁 Race!</button>

        <button onClick={() => onNavigate('vet')} style={{ flex: 1, minWidth: 70, padding: '14px 8px', background: 'linear-gradient(135deg, #48cae4, #0096c7)', color: 'white', border: 'none', borderRadius: 14, fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>🏥 Vet</button>
        <button onClick={() => onNavigate('cosy')} style={{ flex: 1, minWidth: 70, padding: '14px 8px', background: 'linear-gradient(135deg, #ffb6c1, #e07a9a)', color: 'white', border: 'none', borderRadius: 14, fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>🛏️ Cosy</button>
      </div>
      {/* Today's Featured Dog */}
      {(() => {
        const featured = getFeaturedDog();
        const alreadyOwn = dogs.some(d => d.breed === featured.name);
        return (
          <div style={{ background: `linear-gradient(135deg,${RARITY_COLORS[featured.rarity]}22,${RARITY_COLORS[featured.rarity]}44)`, border: `2px solid ${RARITY_COLORS[featured.rarity]}`, borderRadius: 16, padding: 14, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 'bold', fontSize: 13, color: '#555', marginBottom: 2 }}>⭐ Today's Featured Cat</div>
                <div style={{ fontWeight: 'bold', fontSize: 16, color: '#333' }}>{featured.name}</div>
                <div style={{ fontSize: 12, color: RARITY_COLORS[featured.rarity], fontWeight: 'bold' }}>{featured.rarity}</div>
                <div style={{ fontSize: 11, color: '#f4a261', fontWeight: 'bold', marginTop: 2 }}>🎁 Catch it for +100 bonus pts!</div>
                {alreadyOwn && <div style={{ fontSize: 11, color: '#52b788', fontWeight: 'bold', marginTop: 2 }}>✅ You own this one!</div>}
              </div>
              <button onClick={() => { haptic('light'); onNavigate('catch'); }} style={{ background: 'linear-gradient(135deg,#667eea,#764ba2)', color: 'white', border: 'none', borderRadius: 12, padding: '10px 14px', fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>
                {alreadyOwn ? '🧶 Catch Again' : '🧶 Catch It!'}
              </button>
            </div>
          </div>
        );
      })()}
      {/* Dog of the Week */}
      {(() => {
        const dotw = getDogOfTheWeek();
        if (!dotw) return null;
        const { breed, msUntilRotation } = dotw;
        const alreadyOwn = dogs.some(d => d.breed === breed.name);
        const claimKey = `km_dotw_${dotw.weekIdx}`;
        const claimed = localStorage.getItem(claimKey) === '1';
        const color = RARITY_COLORS[breed.rarity] || '#ffd700';
        return (
          <div style={{ background: `linear-gradient(135deg,${color}22,${color}44)`, border: `2px solid ${color}`, borderRadius: 16, padding: 14, marginBottom: 12, position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 8, right: 10, fontSize: 10, color: '#888', fontWeight: 'bold' }}>⏳ {formatCountdown(msUntilRotation)} left</div>
            <div style={{ fontWeight: 'bold', fontSize: 13, color: '#555', marginBottom: 4 }}>🐱 Cat of the Week</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 'bold', fontSize: 17, color: '#333' }}>{breed.name}</div>
                <div style={{ fontSize: 12, color, fontWeight: 'bold' }}>{breed.rarity}</div>
                <div style={{ fontSize: 11, color: '#f4a261', fontWeight: 'bold', marginTop: 2 }}>🪙 +30 Kitty Coins if you catch it!</div>
                {claimed && <div style={{ fontSize: 11, color: '#52b788', fontWeight: 'bold', marginTop: 2 }}>✅ Bonus claimed this week!</div>}
              </div>
              <button onClick={() => { haptic('light'); onNavigate('catch'); }} style={{ background: `linear-gradient(135deg,${color},${color}cc)`, color: 'white', border: 'none', borderRadius: 12, padding: '10px 14px', fontSize: 13, fontWeight: 'bold', cursor: 'pointer', textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}>
                {claimed ? '🧶 Catch Again' : alreadyOwn ? '🧶 Catch Again' : '🧶 Catch It!'}
              </button>
            </div>
          </div>
        );
      })()}
      <CommunityGoalBanner player={player} dogs={dogs} />
      <YarnChase />
      <MysteryDogCard player={player} today={todayKey} />
      <TrickOrTreatCard />
      <AdventCalendarCard />
      {/* Daily spin + friends row */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <button onClick={() => { if (canSpin) setShowSpin(true); else { haptic('light'); } }} style={{ flex: 1, padding: '14px 8px', background: canSpin ? 'linear-gradient(135deg,#ffd700,#f4a261)' : '#eee', color: canSpin ? 'white' : '#aaa', border: 'none', borderRadius: 14, fontSize: 13, fontWeight: 'bold', cursor: canSpin ? 'pointer' : 'default', boxShadow: canSpin ? '0 4px 12px rgba(244,162,97,0.4)' : 'none' }}>
          {canSpin ? '🎁 Free Gift!' : '🎁 Gift ✓'}
        </button>
        <button onClick={() => setShowFriends(true)} style={{ flex: 1, padding: '14px 8px', background: 'linear-gradient(135deg,#4cc9f0,#4361ee)', color: 'white', border: 'none', borderRadius: 14, fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>
          👥 Friends
        </button>
      </div>
      {/* Mystery box progress */}
      <div style={{ background: 'white', borderRadius: 16, padding: 14, marginBottom: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', border: '2px solid #ffd700' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontWeight: 'bold', color: '#e76f51', fontSize: 13 }}>🎁 Mystery Box Progress</span>
          <span style={{ fontSize: 12, color: '#888' }}>{nextBox} more catch{nextBox !== 1 ? 'es' : ''} to go!</span>
        </div>
        <div style={{ background: '#eee', borderRadius: 8, height: 10, overflow: 'hidden' }}>
          <div style={{ background: 'linear-gradient(135deg,#f4a261,#e76f51)', width: `${boxPct}%`, height: '100%', borderRadius: 8, transition: 'width 0.4s' }} />
        </div>
      </div>
      {/* Recent catches */}
      {recent.length > 0 && (
        <div style={{ background: 'white', borderRadius: 16, padding: 14, marginBottom: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', border: '2px solid #f0e8ff' }}>
          <div style={{ fontWeight: 'bold', color: '#764ba2', marginBottom: 8, fontSize: 13 }}>🕐 Recent Catches</div>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
            {recent.map((r, i) => (
              <div key={i} style={{ textAlign: 'center', minWidth: 60, flex: '0 0 auto' }}>
                <img src={r.photoUrl} alt={r.breed} style={{ width: 52, height: 52, borderRadius: '50%', objectFit: 'cover', border: `3px solid ${RARITY_COLORS[r.rarity] || '#aaa'}` }} onError={e => { e.target.onerror = null; e.target.src = catArtUrl(r.breed) || catArtUrl('Domestic Shorthair'); }} />
                <div style={{ fontSize: 10, color: '#666', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 60 }}>{r.breed.split(' ')[0]}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{ background: 'white', borderRadius: 16, padding: 16, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', border: '2px solid #f0e8ff' }}>
        <div style={{ fontWeight: 'bold', color: '#764ba2', marginBottom: 10, fontSize: 14 }}>🎯 Today's Challenges</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {challenges.map(c => {
            const count = Math.min(prog[c.id] || 0, c.goal);
            const done = count >= c.goal;
            return (
              <div key={c.id} style={{ background: done ? '#d4edda' : '#f5f0ff', border: `1.5px solid ${done ? '#28a745' : '#c39bd3'}`, borderRadius: 12, padding: '8px 12px', fontSize: 12 }}>
                {done ? '✅' : '🎯'} {c.text} · {count}/{c.goal} · +{c.pts}pts
              </div>
            );
          })}
        </div>
      </div>
      {/* ✨ Daily Star Track — Dreamlight-style reward path */}
      <StarTrackBar />
      {/* 🌊 Wishing Well — daily random bonus */}
      <WishingWell />
      {showSpin && <DailyGiftModal onClose={() => setShowSpin(false)} onWin={handleSpinWin} />}
      {showFriends && <FriendsGalleryModal onClose={() => setShowFriends(false)} />}
    </div>
  );
}

// ─── Trick or Treat Halloween Mini-Game ──────────────────────────────────────
const TRICK_OR_TREAT_PUZZLES = [
  { q: '🎃 Which cat is most like a witch\'s familiar?', opts: ['Golden Retriever','Black Cat Dachshund','Labrador','Beagle'], ans: 1, dd: 5 },
  { q: '👻 A ghost cat has how many legs?', opts: ['2','4','6','It floats!'], ans: 3, dd: 3 },
  { q: '🦇 Which is the spookiest rarity in KittyMart?', opts: ['Common','Uncommon','Rare','Legendary'], ans: 3, dd: 5 },
  { q: '🕷️ Spider-Cat shoots webs from where?', opts: ['Its tail','Its paws','Its nose','Its ears'], ans: 1, dd: 4 },
  { q: '🎃 What do cats do on Halloween?', opts: ['Trick OR Treat','Howl at the moon','Eat all the candy','Chase zombies'], ans: 1, dd: 3 },
  { q: '💀 A skeleton cat is made of how many fish?', opts: ['No fish','Too many!','206 — just like humans','3 big ones'], ans: 1, dd: 5 },
  { q: '🧙 What is a witch\'s cat called?', opts: ['A Familiar','A Hellhound','A Spooky Kitten','A Boo-dle'], ans: 0, dd: 4 },
  { q: '👻 Which breed is nicknamed the "Ghost Cat"?', opts: ['Samoyed','Dalmatian','Poodle','Shiba Inu'], ans: 0, dd: 5 },
  { q: '🎃 How many pumpkins can a cat carry?', opts: ['1','2','5','As many as their heart desires!'], ans: 3, dd: 3 },
  { q: '🐟 What is a zombie cat\'s favourite treat?', opts: ['Brains','Fish','Kibble','Pumpkin spice biscuits'], ans: 1, dd: 4 },
];
// 🎄 Advent Calendar — one door per day, Dec 1–25. Opened days live in localStorage under a
// km_ key, so saveNow() already backs them up to Supabase with the rest of the player's data.
const ADVENT_REWARDS = Array.from({ length: 25 }, (_, i) => {
  const day = i + 1;
  if (day === 25) return { day, dd: 50, pts: 100, label: 'Big Christmas gift!' };
  return day % 2 === 0
    ? { day, pts: 10 + day, label: `${10 + day} points` }
    : { day, dd: 2 + Math.floor(day / 4), label: `${2 + Math.floor(day / 4)} Kitty Coins` };
});
function AdventCalendarCard() {
  const now = new Date();
  const year = now.getFullYear();
  const storageKey = `km_advent_${year}`;
  const [opened, setOpened] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch { return []; }
  });
  const [justWon, setJustWon] = React.useState(null);
  const month = now.getMonth(); // 11 = December
  const today = now.getDate();

  // Before December: small teaser so testers can see it's coming. After December: hide.
  if (month < 11) {
    if (month < 10) return null;
    return (
      <div style={{ background: 'linear-gradient(135deg,#0b3d2e,#a4161a)', borderRadius: 20, padding: 14, marginBottom: 12, textAlign: 'center', color: 'white', fontWeight: 'bold', fontSize: 14 }}>
        🎄 Advent Calendar opens Dec 1! 🎁
      </div>
    );
  }

  const openDoor = (day) => {
    if (day > today || opened.includes(day)) return;
    const reward = ADVENT_REWARDS[day - 1];
    const next = [...opened, day];
    setOpened(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
    if (reward.dd) addDD(reward.dd);
    if (reward.pts) addBonusPts(reward.pts);
    haptic('medium');
    setJustWon(reward);
  };

  const missed = Array.from({ length: Math.min(today, 25) }, (_, i) => i + 1).filter(d => !opened.includes(d)).length;

  return (
    <div style={{ background: 'linear-gradient(135deg,#0b3d2e,#a4161a)', border: '2px solid #ffd700', borderRadius: 20, padding: 16, marginBottom: 12 }}>
      <div style={{ color: '#ffd700', fontWeight: 'bold', fontSize: 15, textAlign: 'center' }}>🎄 Advent Calendar 🎄</div>
      <div style={{ color: 'white', fontSize: 12, textAlign: 'center', marginBottom: 10 }}>
        {opened.length}/25 opened{missed > 0 ? ` · ${missed} ready to open!` : ' · come back tomorrow!'}
      </div>
      {justWon && (
        <div onClick={() => setJustWon(null)} style={{ background: 'white', borderRadius: 14, padding: 12, marginBottom: 10, textAlign: 'center', cursor: 'pointer' }}>
          <div style={{ fontSize: 28 }}>🎁</div>
          <div style={{ fontWeight: 'bold', color: '#a4161a' }}>Day {justWon.day}: {justWon.label}{justWon.dd && justWon.pts ? ` + ${justWon.dd} ${DD}` : ''}!</div>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
        {ADVENT_REWARDS.map(({ day }) => {
          const isOpen = opened.includes(day);
          const canOpen = day <= today && !isOpen;
          return (
            <button key={day} onClick={() => openDoor(day)} disabled={!canOpen}
              style={{ aspectRatio: '1', border: 'none', borderRadius: 10, fontWeight: 'bold', fontSize: 14,
                background: isOpen ? '#2d6a4f' : canOpen ? 'linear-gradient(135deg,#ffd700,#f4a261)' : 'rgba(255,255,255,0.18)',
                color: isOpen ? '#b7e4c7' : canOpen ? '#7a1f00' : 'rgba(255,255,255,0.5)',
                cursor: canOpen ? 'pointer' : 'default' }}>
              {isOpen ? '✓' : day === 25 ? '🎅' : day}
            </button>
          );
        })}
      </div>
    </div>
  );
}
function TrickOrTreatCard() {
  const todayKey = localDateKey();
  const storageKey = `km_tot_${todayKey}`;
  const [state, setState] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { return null; }
  });
  const earned = state?.earned || 0;
  const answered = state?.answered || [];
  const available = TRICK_OR_TREAT_PUZZLES.filter((_, i) => !answered.includes(i));
  const done = available.length === 0;
  const [current, setCurrent] = React.useState(() => done ? null : available[Math.floor(Math.random() * available.length)]);
  const currentIdx = TRICK_OR_TREAT_PUZZLES.indexOf(current);
  const [selected, setSelected] = React.useState(null);
  const [reveal, setReveal] = React.useState(false);

  // Only show on Oct 31
  const now = new Date();
  if (!(now.getMonth() === 9 && now.getDate() === 31)) return null;

  const handleAnswer = (optIdx) => {
    if (reveal) return;
    setSelected(optIdx);
    setReveal(true);
    const correct = optIdx === current.ans;
    const ddWon = correct ? current.dd : 0;
    const newAnswered = [...answered, currentIdx];
    const newEarned = earned + ddWon;
    const newState = { earned: newEarned, answered: newAnswered };
    setState(newState);
    try { localStorage.setItem(storageKey, JSON.stringify(newState)); } catch {}
    if (ddWon > 0) addDD(ddWon);
  };

  const nextPuzzle = () => {
    const remaining = TRICK_OR_TREAT_PUZZLES.filter((_, i) => !(state?.answered || []).includes(i));
    if (remaining.length === 0) { setCurrent(null); return; }
    setCurrent(remaining[Math.floor(Math.random() * remaining.length)]);
    setSelected(null);
    setReveal(false);
  };

  return (
    <div style={{ background: 'linear-gradient(135deg,#1a0533,#4a0e6e)', border: '2px solid #ff6b00', borderRadius: 20, padding: 16, marginBottom: 12 }}>
      <div style={{ color: '#ff6b00', fontWeight: 'bold', fontSize: 15, marginBottom: 4, textAlign: 'center' }}>🎃 Trick or Treat Puzzles! 🎃</div>
      <div style={{ color: '#ffcc00', fontSize: 12, textAlign: 'center', marginBottom: 10 }}>Answer correctly to earn 🪙 Kitty Coins!</div>
      {done || !current ? (
        <div style={{ textAlign: 'center', color: '#ffd700', fontWeight: 'bold', fontSize: 14, padding: 10 }}>
          <div style={{ fontSize: 32 }}>🎃</div>
          All puzzles solved! You earned {earned}{DD} today!
          <div style={{ fontSize: 12, color: '#ccc', marginTop: 4 }}>Come back next Halloween! 👻</div>
        </div>
      ) : (
        <>
          <div style={{ color: 'white', fontSize: 14, fontWeight: 'bold', marginBottom: 12, lineHeight: 1.4 }}>{current.q}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {current.opts.map((opt, i) => {
              let bg = '#2d0a4e';
              let border = '1.5px solid #6a1fa3';
              if (reveal) {
                if (i === current.ans) { bg = '#1a5c2a'; border = '2px solid #52b788'; }
                else if (i === selected) { bg = '#5c1a1a'; border = '2px solid #e76f51'; }
              }
              return (
                <button key={i} onClick={() => handleAnswer(i)}
                  style={{ background: bg, border, borderRadius: 12, padding: '10px 14px', color: 'white', fontSize: 13, fontWeight: 'bold', cursor: reveal ? 'default' : 'pointer', textAlign: 'left', transition: 'all 0.2s' }}>
                  {reveal && i === current.ans ? '✅ ' : reveal && i === selected && i !== current.ans ? '❌ ' : ''}{opt}
                </button>
              );
            })}
          </div>
          {reveal && (
            <div style={{ marginTop: 10, textAlign: 'center' }}>
              {selected === current.ans
                ? <div style={{ color: '#ffd700', fontWeight: 'bold' }}>🎉 Correct! +{current.dd}{DD} earned!</div>
                : <div style={{ color: '#ff6b00', fontWeight: 'bold' }}>👻 Oops! No Kitty Coins this time.</div>}
              {available.length > 1 && (
                <button onClick={nextPuzzle} style={{ marginTop: 8, background: '#ff6b00', color: 'white', border: 'none', borderRadius: 12, padding: '8px 18px', fontWeight: 'bold', fontSize: 13, cursor: 'pointer' }}>
                  Next Puzzle 🎃
                </button>
              )}
            </div>
          )}
          <div style={{ color: '#aaa', fontSize: 11, marginTop: 8, textAlign: 'center' }}>{TRICK_OR_TREAT_PUZZLES.length - (state?.answered||[]).length} puzzles remaining · {earned}{DD} earned today</div>
        </>
      )}
    </div>
  );
}

// ─── Onboarding Tutorial ─────────────────────────────────────────────────────
const ONBOARDING_STEPS = [
  { emoji: '🐾', title: 'Welcome to KittyMart!', body: 'The world\'s most fun cat collecting game. Catch rare cats, train them, race them, and trade with friends!' },
  { emoji: '🧶', title: 'Go Catch Cats!', body: 'Tap "Go Catch!" to find wild cats. Common cats wander slowly — Legendary cats dart away fast! Tap them before they escape.' },
  { emoji: '✨', title: 'Rarity Matters', body: 'Cats come in 5 rarities: Common, Uncommon, Rare, Epic, and Legendary. Higher rarity = more points and bragging rights!' },
  { emoji: '🏁', title: 'Race Your Cats', body: 'Challenge your cats in races to earn bonus points and climb the leaderboard. Higher-rarity cats win more often.' },
  { emoji: '📖', title: 'Fill Your KittyDex', body: 'There are dozens of real breeds to discover. Can you catch them all? Your KittyDex tracks every breed you\'ve found.' },
  { emoji: '🎁', title: 'Mystery Boxes', body: 'Every 10 catches you earn a Mystery Box — it might contain bonus points or a rare surprise cat!' },
];
function OnboardingModal({ onDone }) {
  const [step, setStep] = useState(0);
  const s = ONBOARDING_STEPS[step];
  const isLast = step === ONBOARDING_STEPS.length - 1;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: 'white', borderRadius: 24, padding: 32, maxWidth: 360, width: '100%', textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
        <div style={{ fontSize: 64, marginBottom: 12 }}>{s.emoji}</div>
        <h2 style={{ margin: '0 0 10px', color: '#333', fontSize: 20 }}>{s.title}</h2>
        <p style={{ margin: '0 0 24px', color: '#666', lineHeight: 1.6, fontSize: 15 }}>{s.body}</p>
        {/* Step dots */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 20 }}>
          {ONBOARDING_STEPS.map((_, i) => (
            <div key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: i === step ? '#5aab6a' : '#ddd' }} />
          ))}
        </div>
        <button onClick={() => { haptic('light'); if (isLast) { markOnboardingDone(); onDone(); } else setStep(s => s + 1); }}
          style={{ width: '100%', padding: '14px', background: 'linear-gradient(135deg,#5aab6a,#4a9e5c)', color: 'white', border: 'none', borderRadius: 14, fontSize: 16, fontWeight: 'bold', cursor: 'pointer' }}>
          {isLast ? "Let's Go! 🐾" : 'Next →'}
        </button>
        {!isLast && <button onClick={() => { markOnboardingDone(); onDone(); }} style={{ marginTop: 10, background: 'none', border: 'none', color: '#aaa', fontSize: 13, cursor: 'pointer' }}>Skip tutorial</button>}
      </div>
    </div>
  );
}

// ─── Pet Race Screen ──────────────────────────────────────────────────────────

// Race room helpers — schema: id, host_id, host_username, status,
// p1_id/p1_username/p1_dog/p1_rarity/p1_pct … p4_*, winner_id, created_at
async function createRaceRoom(hostId, hostUsername) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await sb('km_races', 'POST', {
    id, host_id: hostId, host_username: hostUsername,
    status: 'lobby', created_at: new Date().toISOString()
  });
  return id;
}
async function joinRaceSlot(raceId, playerId, username, dogName, dogRarity) {
  const room = await fetchRaceRoom(raceId);
  if (!room) throw new Error('Room not found');
  // If already in a slot, return it — prevents double entries
  for (const n of ['p1','p2','p3','p4']) {
    if (room[`${n}_id`] === playerId) return n;
  }
  // Claim the first empty slot
  for (const n of ['p1','p2','p3','p4']) {
    if (!room[`${n}_id`]) {
      await sb(`km_races?id=eq.${raceId}`, 'PATCH', {
        [`${n}_id`]: playerId, [`${n}_username`]: username,
        [`${n}_dog`]: dogName, [`${n}_rarity`]: dogRarity, [`${n}_pct`]: 0
      });
      return n;
    }
  }
  throw new Error('Race is full');
}
async function pushProgress(raceId, slot, pct) {
  await sb(`km_races?id=eq.${raceId}`, 'PATCH', { [`${slot}_pct`]: pct }).catch(() => {});
}
async function startRaceRoom(raceId) {
  await sb(`km_races?id=eq.${raceId}`, 'PATCH', { status: 'racing' });
}
async function finishRaceRoom(raceId, winnerId) {
  await sb(`km_races?id=eq.${raceId}`, 'PATCH', { status: 'finished', winner_id: winnerId }).catch(() => {});
}
async function deleteRaceRoom(raceId) {
  await sb(`km_races?id=eq.${raceId}`, 'DELETE').catch(() => {});
}
async function fetchOpenRaces() {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  return sb(`km_races?status=in.(lobby,racing)&created_at=gte.${encodeURIComponent(cutoff)}&select=*&limit=12`);
}
async function fetchRaceRoom(raceId) {
  const rows = await sb(`km_races?id=eq.${raceId}&select=*`);
  return rows[0] || null;
}

const PLACE_PTS = [200, 100, 50, 25];
const PLACE_LABELS = ['🥇 1st', '🥈 2nd', '🥉 3rd', '4th'];
// Elite Race prizes — Kitty Coins only, multiplayer only
const ELITE_DD_PLACE = [50, 20, 10, 5];
const LANE_COLORS = ['#667eea', '#f72585', '#06d6a0', '#ffd700'];

function RaceTrack({ room, mySlot }) {
  const slots = ['p1','p2','p3','p4'].filter(n => room[`${n}_id`]);
  return (
    <div style={{ background: 'linear-gradient(180deg,#1a472a 0%,#2d6a4f 100%)', borderRadius: 18, padding: '14px 10px', userSelect: 'none' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, paddingLeft: 4, paddingRight: 4 }}>
        <span style={{ color: '#a8d8a8', fontWeight: 'bold', fontSize: 13 }}>🏟️ Race Track</span>
        <span style={{ color: '#ffd700', fontWeight: 'bold', fontSize: 13 }}>🏁 Finish →</span>
      </div>
      {slots.map((n, i) => {
        const pct = Math.min(100, room[`${n}_pct`] || 0);
        const name = room[`${n}_username`] || '';
        const dog = room[`${n}_dog`] || '';
        const rarity = room[`${n}_rarity`] || 'Common';
        const isMe = n === mySlot;
        const color = LANE_COLORS[i];
        return (
          <div key={n} style={{ marginBottom: i < slots.length - 1 ? 10 : 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ color: isMe ? '#ffd700' : 'white', fontWeight: isMe ? 'bold' : 'normal', fontSize: 12 }}>
                {isMe ? '⭐ ' : ''}{name} · {dog}
              </span>
              <span style={{ color, fontWeight: 'bold', fontSize: 12 }}>{Math.round(pct)}%</span>
            </div>
            {/* Track lane */}
            <div style={{ position: 'relative', background: 'rgba(0,0,0,0.35)', borderRadius: 30, height: 38, overflow: 'visible', border: `2px solid ${isMe ? color : 'rgba(255,255,255,0.15)'}` }}>
              {/* Lane stripe */}
              <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 2, background: 'rgba(255,255,255,0.08)', transform: 'translateY(-50%)' }} />
              {/* Progress fill */}
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, background: `linear-gradient(90deg,${color}55,${color}33)`, borderRadius: 28, transition: 'width 0.3s linear' }} />
              {/* Dog avatar on track */}
              <div style={{
                position: 'absolute', top: '50%', left: `calc(${pct}% - 18px)`,
                transform: 'translateY(-50%)',
                transition: 'left 0.3s linear',
                width: 36, height: 36, borderRadius: '50%',
                background: color, border: `3px solid white`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18, boxShadow: isMe ? `0 0 12px ${color}` : '0 2px 8px rgba(0,0,0,0.4)',
                zIndex: 2, overflow: 'hidden'
              }}>
                <span style={{ display: 'inline-block', transform: 'scaleX(-1)' }}>🐱</span>
              </div>
              {/* Finish flag */}
              <div style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', fontSize: 18, opacity: pct >= 100 ? 1 : 0.35 }}>🏁</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DogPicker({ dogs, onPick, title, subtitle, accentGradient, accentShadow, buttonLabel, disabled }) {
  const [search, setSearch] = React.useState('');
  const q = search.trim().toLowerCase();
  const visible = React.useMemo(() => {
    if (!q) return dogs;
    return dogs.filter(d =>
      (d.breed || '').toLowerCase().includes(q) ||
      (d.name || '').toLowerCase().includes(q) ||
      (getDogNick(d.id) || '').toLowerCase().includes(q)
    );
  }, [dogs, q]);

  // Group visible dogs by breed for easy scanning
  const grouped = React.useMemo(() => {
    const map = {};
    visible.forEach(d => {
      const b = d.breed || 'Unknown';
      if (!map[b]) map[b] = [];
      map[b].push(d);
    });
    return Object.entries(map).sort(([a],[b]) => a.localeCompare(b));
  }, [visible]);

  return (
    <div>
      <p style={{ color: '#666', fontSize: 13, marginBottom: 10, textAlign: 'center' }}>{subtitle}</p>
      {/* Search box */}
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 16, pointerEvents: 'none' }}>🔍</span>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by breed or name…"
          style={{ width: '100%', padding: '10px 12px 10px 36px', borderRadius: 14, border: '2px solid #e0e0e0', fontSize: 14, outline: 'none', boxSizing: 'border-box', background: '#fafafa' }}
        />
        {search && (
          <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#aaa', lineHeight: 1 }}>×</button>
        )}
      </div>
      {dogs.length === 0 ? (
        <div style={{ color: '#888', textAlign: 'center', padding: 30 }}>No cats yet — catch some first!</div>
      ) : visible.length === 0 ? (
        <div style={{ color: '#888', textAlign: 'center', padding: 20 }}>No cats match "{search}"</div>
      ) : (
        <div>
          {grouped.map(([breed, breedDogs]) => (
            <div key={breed} style={{ marginBottom: 14 }}>
              {/* Breed header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 900, color: '#555', letterSpacing: 0.3 }}>🐱 {breed}</div>
                <div style={{ flex: 1, height: 1, background: '#eee' }} />
                <div style={{ fontSize: 11, color: '#aaa', fontWeight: 700 }}>{breedDogs.length} cat{breedDogs.length !== 1 ? 's' : ''}</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10 }}>
                {breedDogs.map(dog => {
                  const nick = getDogNick(dog.id) || '';
                  return (
                    <div key={dog.id} onClick={() => !disabled && onPick(dog)} style={{ background: 'white', border: `2px solid ${RARITY_COLORS[dog.rarity]}`, borderRadius: 16, padding: 12, textAlign: 'center', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
                      {dog.photo_url
                        ? <img src={dogImageSrc(dog)} alt={dog.name} style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover', border: `3px solid ${RARITY_COLORS[dog.rarity]}` }} onError={e => e.target.style.display='none'} />
                        : <div style={{ width: 64, height: 64, borderRadius: '50%', background: RARITY_COLORS[dog.rarity] + '33', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, margin: '0 auto' }}>🐱</div>
                      }
                      <div style={{ fontSize: 13, fontWeight: 'bold', marginTop: 6 }}>{nick || dog.name}</div>
                      <div style={{ fontSize: 12, color: '#555', fontWeight: 700 }}>{dog.breed}</div>
                      <div style={{ fontSize: 11, color: RARITY_COLORS[dog.rarity], fontWeight: 'bold' }}>{dog.rarity}</div>
                      <div style={{ marginTop: 8, background: accentGradient || 'linear-gradient(135deg,#667eea,#764ba2)', color: 'white', borderRadius: 10, padding: '5px 0', fontWeight: 'bold', fontSize: 12 }}>{buttonLabel || 'Race this cat 🏁'}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── In-Race Emoji Reactions ──────────────────────────────────────────────────
const RACE_EMOJIS = ['🔥','💨','🐾','🏆'];
function RaceWithEmoji({ room, mySlot, isCountingDown, cdColor, countdown, toast, finishedRef, handleTap, raceId, player }) {
  const [floats, setFloats] = React.useState([]); // [{id, emoji, x, y}]
  const [cooldown, setCooldown] = React.useState(false);
  const nextId = React.useRef(0);

  const sendEmoji = (emoji) => {
    if (cooldown || isCountingDown) return;
    setCooldown(true);
    setTimeout(() => setCooldown(false), 1000);
    const id = nextId.current++;
    const x = 20 + Math.random() * 60;
    setFloats(prev => [...prev, { id, emoji, x }]);
    setTimeout(() => setFloats(prev => prev.filter(f => f.id !== id)), 2200);
    // Try to write emoji to Supabase for opponents to see (best-effort)
    if (raceId) {
      sb(`km_races?id=eq.${raceId}`, 'PATCH', { last_emoji: `${player.username}:${emoji}:${Date.now()}` }).catch(() => {});
    }
  };

  return (
    <div style={{ padding: 16, userSelect: 'none', position: 'relative' }}>
      <style>{`.tap-btn{animation:tbounce 0.4s infinite}.tap-btn:active{transform:scale(0.88)!important}@keyframes tbounce{0%,100%{transform:scale(1)}50%{transform:scale(0.93)}}@keyframes cdpop{0%{transform:translate(-50%,-50%) scale(0.4);opacity:0}40%{transform:translate(-50%,-50%) scale(1.2);opacity:1}100%{transform:translate(-50%,-50%) scale(1);opacity:1}}@keyframes emojiFloat{0%{transform:translateY(0) scale(1);opacity:1}100%{transform:translateY(-120px) scale(1.4);opacity:0}}`}</style>
      {toast && <div style={{ position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', background: '#764ba2', color: 'white', borderRadius: 20, padding: '10px 20px', fontWeight: 'bold', fontSize: 14, zIndex: 999, whiteSpace: 'nowrap' }}>{toast}</div>}
      {room && <RaceTrack room={room} mySlot={mySlot} />}
      {/* Floating emoji bubbles */}
      <div style={{ position: 'relative', height: 0 }}>
        {floats.map(f => (
          <div key={f.id} style={{ position: 'absolute', left: `${f.x}%`, bottom: 0, fontSize: 32, animation: 'emojiFloat 2s ease-out forwards', pointerEvents: 'none', zIndex: 50 }}>{f.emoji}</div>
        ))}
      </div>
      {isCountingDown && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.55)', borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10 }}>
          <div key={String(countdown)} style={{ fontSize: countdown === 'GO! 🏁' ? 52 : 96, fontWeight: 900, color: cdColor, textShadow: `0 0 40px ${cdColor}`, animation: 'cdpop 0.5s ease-out forwards', position: 'absolute', top: '50%', left: '50%' }}>
            {countdown}
          </div>
        </div>
      )}
      <button className={isCountingDown ? '' : 'tap-btn'} onPointerDown={handleTap} style={{ display: 'block', width: '100%', minHeight: 120, background: finishedRef.current ? 'linear-gradient(135deg,#aaa,#888)' : isCountingDown ? '#555' : 'linear-gradient(135deg,#ffd700,#f4a261)', color: isCountingDown ? '#999' : '#333', border: 'none', borderRadius: 24, fontSize: 28, fontWeight: 900, cursor: isCountingDown ? 'default' : 'pointer', marginTop: 14, marginBottom: 10, boxShadow: isCountingDown ? 'none' : '0 8px 24px rgba(244,162,97,0.5)' }}>
        {finishedRef.current ? '✅ Finished!' : isCountingDown ? '⏳ Get ready…' : 'TAP! 🐾'}
      </button>
      {/* Emoji reaction buttons */}
      {!isCountingDown && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 6 }}>
          {RACE_EMOJIS.map(e => (
            <button key={e} onClick={() => sendEmoji(e)} disabled={cooldown}
              style={{ width: 44, height: 44, fontSize: 22, background: cooldown ? '#f0f0f0' : 'white', border: '2px solid #e0e0e0', borderRadius: 12, cursor: cooldown ? 'default' : 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', transition: 'transform 0.1s', opacity: cooldown ? 0.5 : 1 }}>
              {e}
            </button>
          ))}
        </div>
      )}
      <p style={{ textAlign: 'center', color: '#aaa', fontSize: 12, margin: 0 }}>Tap as fast as you can! 🏁 First to 100% wins</p>
    </div>
  );
}

function RaceHomeDogPicker({ dogs, selectedDog, setSelectedDog, getGhost }) {
  const [search, setSearch] = React.useState('');
  const [expanded, setExpanded] = React.useState(false);
  const [filter, setFilter] = React.useState('all'); // 'all' | 'elite'
  const q = search.trim().toLowerCase();

  const filtered = React.useMemo(() => {
    let list = dogs;
    if (filter === 'elite') list = list.filter(d => (getDogState(d.id).level || 1) >= 6);
    if (!q) return list;
    return list.filter(d =>
      (d.breed || '').toLowerCase().includes(q) ||
      (d.name || '').toLowerCase().includes(q) ||
      (getDogNick(d.id) || '').toLowerCase().includes(q)
    );
  }, [dogs, q, filter]);

  const grouped = React.useMemo(() => {
    const map = {};
    filtered.forEach(d => {
      const b = d.breed || 'Unknown';
      if (!map[b]) map[b] = [];
      map[b].push(d);
    });
    return Object.entries(map).sort(([a],[b]) => a.localeCompare(b));
  }, [filtered]);

  const selNick = selectedDog ? (getDogNick(selectedDog.id) || selectedDog.name) : null;

  return (
    <div style={{ background: 'white', borderRadius: 16, padding: '10px 12px', marginBottom: 14, boxShadow: '0 2px 10px rgba(0,0,0,0.08)', border: selectedDog ? `2px solid ${RARITY_COLORS[selectedDog.rarity]}` : '2px solid #eee' }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: expanded ? 10 : 0 }}>
        <div style={{ fontSize: 12, color: '#aaa', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 }}>
          🐱 Racing cat {selectedDog
            ? <span style={{ color: '#06d6a0' }}>✓ {selNick} <span style={{ fontWeight: 'normal', color: RARITY_COLORS[selectedDog.rarity] }}>{selectedDog.rarity}</span></span>
            : <span style={{ color: '#f4a261' }}>— pick one below</span>}
        </div>
        <button onClick={() => setExpanded(e => !e)} style={{ background: expanded ? '#f0f0f0' : 'linear-gradient(135deg,#667eea,#764ba2)', color: expanded ? '#555' : 'white', border: 'none', borderRadius: 20, padding: '5px 14px', fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}>
          {expanded ? 'Done ✓' : (selectedDog ? 'Change 🔄' : 'Pick cat 🐱')}
        </button>
      </div>

      {/* Selected dog mini-preview (when collapsed) */}
      {!expanded && selectedDog && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, padding: '6px 8px', background: RARITY_COLORS[selectedDog.rarity] + '12', borderRadius: 12 }}>
          {dogImageSrc(selectedDog)
            ? <img src={dogImageSrc(selectedDog)} alt={selectedDog.name} style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', border: `3px solid ${RARITY_COLORS[selectedDog.rarity]}` }} onError={e => e.target.style.display='none'} />
            : <div style={{ width: 44, height: 44, borderRadius: '50%', background: RARITY_COLORS[selectedDog.rarity] + '33', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>🐱</div>
          }
          <div>
            <div style={{ fontWeight: 'bold', fontSize: 14 }}>{selNick}</div>
            <div style={{ fontSize: 12, color: RARITY_COLORS[selectedDog.rarity], fontWeight: 'bold' }}>{selectedDog.breed} · {selectedDog.rarity}{getGhost(selectedDog.id) ? ' 👻' : ''}</div>
          </div>
        </div>
      )}

      {/* Expanded picker */}
      {expanded && (
        <div>
          {dogs.length === 0 ? (
            <div style={{ color: '#aaa', textAlign: 'center', padding: '10px 0', fontSize: 13 }}>No cats yet — catch some first!</div>
          ) : (
            <>
              {/* Filter tabs */}
              {dogs.some(d => (getDogState(d.id).level || 1) >= 6) && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  {[['all','All cats'],['elite','🏆 Elite (Lv.6+)']].map(([val, label]) => (
                    <button key={val} onClick={() => setFilter(val)}
                      style={{ flex: 1, padding: '6px 0', borderRadius: 20, border: 'none', fontWeight: 'bold', fontSize: 12, cursor: 'pointer',
                        background: filter === val ? (val === 'elite' ? 'linear-gradient(135deg,#f7b731,#e65100)' : 'linear-gradient(135deg,#667eea,#764ba2)') : '#f0f0f0',
                        color: filter === val ? 'white' : '#888' }}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {/* Search box */}
              <div style={{ position: 'relative', marginBottom: 10 }}>
                <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 14, pointerEvents: 'none' }}>🔍</span>
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search breed or name…"
                  style={{ width: '100%', padding: '8px 30px 8px 30px', borderRadius: 12, border: '1.5px solid #e0e0e0', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fafafa' }}
                />
                {search && <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', color: '#aaa' }}>×</button>}
              </div>
              {filtered.length === 0 ? (
                <div style={{ color: '#aaa', textAlign: 'center', padding: '8px 0', fontSize: 13 }}>No cats match "{search}"</div>
              ) : (
                <div style={{ maxHeight: 320, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
                  {grouped.map(([breed, breedDogs]) => (
                    <div key={breed} style={{ marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <div style={{ fontSize: 11, fontWeight: 900, color: '#666' }}>🐱 {breed}</div>
                        <div style={{ flex: 1, height: 1, background: '#eee' }} />
                        <div style={{ fontSize: 10, color: '#bbb', fontWeight: 700 }}>{breedDogs.length}</div>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 7 }}>
                        {breedDogs.map(dog => {
                          const nick = getDogNick(dog.id) || '';
                          const isSelected = selectedDog?.id === dog.id;
                          const hasGhost = !!getGhost(dog.id);
                          return (
                            <div key={dog.id} onClick={() => { setSelectedDog(isSelected ? null : dog); setExpanded(false); }}
                              style={{ textAlign: 'center', cursor: 'pointer', padding: '6px 4px', borderRadius: 12, border: isSelected ? `2px solid ${RARITY_COLORS[dog.rarity]}` : '2px solid transparent', background: isSelected ? RARITY_COLORS[dog.rarity] + '15' : '#fafafa', position: 'relative' }}>
                              {isSelected && <div style={{ position: 'absolute', top: 3, right: 5, fontSize: 11 }}>✓</div>}
                              {hasGhost && !isSelected && <div style={{ position: 'absolute', top: 3, right: 5, fontSize: 10 }}>👻</div>}
                              {dogImageSrc(dog)
                                ? <img src={dogImageSrc(dog)} alt={dog.name} style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', border: `2px solid ${isSelected ? RARITY_COLORS[dog.rarity] : '#ddd'}` }} onError={e => e.target.style.display='none'} />
                                : <div style={{ width: 44, height: 44, borderRadius: '50%', background: RARITY_COLORS[dog.rarity] + '33', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, margin: '0 auto' }}>🐱</div>
                              }
                              <div style={{ fontSize: 10, fontWeight: 'bold', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isSelected ? RARITY_COLORS[dog.rarity] : '#333' }}>{nick || dog.name}</div>
                              <div style={{ fontSize: 9, color: RARITY_COLORS[dog.rarity], fontWeight: 'bold' }}>{dog.rarity}</div>
                              {(() => { const lv = getDogState(dog.id).level || 1; return lv >= 6 ? <div style={{ fontSize: 9, background: 'linear-gradient(135deg,#f7b731,#e65100)', color: 'white', borderRadius: 6, padding: '1px 4px', fontWeight: 'bold', display: 'inline-block', marginTop: 1 }}>🏆 Lv.{lv}</div> : <div style={{ fontSize: 9, color: '#aaa' }}>Lv.{lv}</div>; })()}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Dog Training School ──────────────────────────────────────────────────────
// Sessions needed to reach target level: (targetLevel - 5) × 1 session
// i.e. level 6 = 1 session (3h), level 7 = 2 sessions, level 8 = 3 sessions …
// Session duration = 3 hours (real-time)
const TRAINING_SESSION_HOURS = 3;
const TRAINING_SESSION_MS = TRAINING_SESSION_HOURS * 60 * 60 * 1000;

// Reads from localStorage first, falling back to the dog's cloud-synced meta.training
// so an enrollment survives even when localStorage is full (e.g. very large collections).
function getTrainingState(dog) {
  try {
    const local = JSON.parse(localStorage.getItem(`km_training_${dog.id}`) || 'null');
    if (local) return local;
  } catch {}
  return dog.meta?.training || null;
}
function setTrainingState(dog, state) {
  try {
    if (state === null) localStorage.removeItem(`km_training_${dog.id}`);
    else localStorage.setItem(`km_training_${dog.id}`, JSON.stringify(state));
  } catch {}
  // Best-effort cloud backup — merges into the dog's existing meta (level/xp/etc.)
  // so training survives a full localStorage quota, same pattern as saveDogState.
  const meta = { ...(dog.meta || {}), training: state };
  sb(`cats?id=eq.${dog.id}`, 'PATCH', { meta }).catch(() => {});
}

function TrainingSchoolScreen({ player, dogs }) {
  const [now, setNow] = React.useState(Date.now());
  const [toast, setToast] = React.useState('');
  const [enrollingDog, setEnrollingDog] = React.useState(null); // dog pending confirmation
  const [cancellingDog, setCancellingDog] = React.useState(null); // dog pending cancel confirmation
  const [, forceUpdate] = React.useReducer(x => x + 1, 0);
  // In-memory override so enrolling/collecting/cancelling reflects in the UI
  // immediately within this session, even if the localStorage write failed
  // (full quota) or the cloud write hasn't round-tripped into the dogs prop yet.
  const [trainingOverride, setTrainingOverride] = React.useState({});
  const readTS = (dog) => {
    const o = trainingOverride[dog.id];
    return o !== undefined ? o : getTrainingState(dog);
  };
  const writeTS = (dog, state) => {
    setTrainingState(dog, state);
    setTrainingOverride(prev => ({ ...prev, [dog.id]: state }));
  };

  // Tick every second so timers update live
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const showMsg = (m) => { setToast(m); setTimeout(() => setToast(''), 3000); };

  // Dogs at level 5 or higher. This parses every dog's saved state, and this screen
  // re-renders every second for the timers, so only recompute when dogs actually change.
  const [dogStateTick, setDogStateTick] = React.useState(0);
  React.useEffect(() => {
    const h = () => setDogStateTick(n => n + 1);
    window.addEventListener('km_dog_change', h);
    return () => window.removeEventListener('km_dog_change', h);
  }, []);
  const eligibleDogs = React.useMemo(() => (dogs || []).filter(d => {
    const s = getDogState(d.id);
    return (s.level || 1) >= 5;
  }), [dogs, dogStateTick]); // eslint-disable-line react-hooks/exhaustive-deps
  // Make sure each cat's real photo list is loaded, then re-render so real photos replace cartoons
  const [, setPhotoTick] = useState(0);
  useEffect(() => {
    let live = true;
    Promise.all(eligibleDogs.slice(0, 20).map(d => resolveDogPhoto(d).catch(() => null))).then(() => { if (live) setPhotoTick(t => t + 1); });
    return () => { live = false; };
  }, [eligibleDogs]);

  // How many training sessions are needed to go from current level to next
  function sessionsNeeded(currentLevel) {
    // Lv5→6 = 1 session, Lv6→7 = 2, Lv7→8 = 3, etc.
    return Math.max(1, currentLevel - 4);
  }

  function formatTimeLeft(ms) {
    if (ms <= 0) return '✅ Done!';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function handleEnroll(dog) {
    const ts = readTS(dog);
    if (ts) { showMsg('Already in training!'); return; }
    const s = getDogState(dog.id);
    const targetLevel = (s.level || 1) + 1;
    const needed = sessionsNeeded(s.level || 1);
    setEnrollingDog({ dog, targetLevel, needed });
  }

  function confirmEnroll() {
    if (!enrollingDog) return;
    const { dog, targetLevel, needed } = enrollingDog;
    const s = getDogState(dog.id);
    writeTS(dog, {
      startTime: Date.now(),
      sessionStartTime: Date.now(),
      currentSession: 1,
      totalSessions: needed,
      targetLevel,
      currentLevel: s.level || 1,
    });
    setEnrollingDog(null);
    showMsg(`${dog.name || dog.breed} enrolled! ${needed} × 3h session${needed > 1 ? 's' : ''} to reach Lv.${targetLevel}`);
    forceUpdate();
  }

  function handleCollect(dog) {
    const ts = readTS(dog);
    if (!ts) return;
    // Re-read elapsed from real clock to avoid stale closure on now
    const elapsed = Date.now() - ts.sessionStartTime;
    if (elapsed < TRAINING_SESSION_MS) { showMsg('⏳ Session not finished yet!'); return; }

    // Session done — check if all sessions complete
    if (ts.currentSession >= ts.totalSessions) {
      // All sessions done — level up the dog by direct save (bypassing addXP thresholds)
      const s = getDogState(dog.id);
      const newLevel = Math.min(50, ts.targetLevel);
      s.level = newLevel;
      s.xp = 0; // reset XP within new level
      saveDogState(dog.id, s);
      writeTS(dog, null);
      showMsg(`🎓 ${dog.name || dog.breed} reached Lv.${newLevel}! 🐾`);
      window.dispatchEvent(new CustomEvent('km_evolution', { detail: { dogId: dog.id } }));
    } else {
      // More sessions needed — advance to next session with fresh timer
      writeTS(dog, {
        ...ts,
        sessionStartTime: Date.now(),
        currentSession: ts.currentSession + 1,
      });
      showMsg(`✅ Session ${ts.currentSession} complete! Session ${ts.currentSession + 1} of ${ts.totalSessions} started.`);
    }
    forceUpdate();
  }

  function handleCancel(dog) {
    setCancellingDog(dog);
  }

  function confirmCancel() {
    if (!cancellingDog) return;
    writeTS(cancellingDog, null);
    setCancellingDog(null);
    showMsg('Training cancelled.');
    forceUpdate();
  }

  const rarityColor = { Common:'#888', Uncommon:'#2d9e6b', Rare:'#1565c0', Epic:'#7b1fa2', Legendary:'#e65100' };

  return (
    <div style={{ padding: 16 }}>
      {toast && (
        <div style={{ position:'fixed', top:80, left:'50%', transform:'translateX(-50%)', background:'#764ba2', color:'white', borderRadius:20, padding:'10px 20px', fontWeight:'bold', fontSize:14, zIndex:999, whiteSpace:'nowrap', boxShadow:'0 4px 20px rgba(0,0,0,0.3)' }}>{toast}</div>
      )}
      {/* Enroll confirmation modal */}
      {enrollingDog && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'white', borderRadius:20, padding:24, margin:16, maxWidth:360, width:'100%', textAlign:'center' }}>
            <div style={{ fontSize:48, marginBottom:8 }}>🎓</div>
            <div style={{ fontWeight:'bold', fontSize:18, marginBottom:8 }}>Enrol in Training?</div>
            <div style={{ fontSize:15, color:'#555', marginBottom:4 }}>
              <b>{enrollingDog.dog.name || enrollingDog.dog.breed}</b> → <b>Lv.{enrollingDog.targetLevel}</b>
            </div>
            <div style={{ fontSize:13, color:'#888', marginBottom:16 }}>
              Requires <b>{enrollingDog.needed} × 3-hour</b> training session{enrollingDog.needed > 1 ? 's' : ''}<br />
              Total time: <b>{enrollingDog.needed * 3} hours</b>
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={() => setEnrollingDog(null)} style={{ flex:1, padding:'12px 0', background:'#eee', border:'none', borderRadius:12, fontWeight:'bold', fontSize:14, cursor:'pointer' }}>Cancel</button>
              <button onClick={confirmEnroll} style={{ flex:1, padding:'12px 0', background:'linear-gradient(135deg,#667eea,#764ba2)', color:'white', border:'none', borderRadius:12, fontWeight:'bold', fontSize:14, cursor:'pointer' }}>Enrol! 🎓</button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel training confirmation modal */}
      {cancellingDog && (() => {
        const ts = readTS(cancellingDog);
        return (
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center' }}>
            <div style={{ background:'white', borderRadius:20, padding:24, margin:16, maxWidth:360, width:'100%', textAlign:'center' }}>
              <div style={{ fontSize:48, marginBottom:8 }}>⚠️</div>
              <div style={{ fontWeight:'bold', fontSize:18, marginBottom:8 }}>Take {cancellingDog.name || cancellingDog.breed} out of school?</div>
              <div style={{ fontSize:13, color:'#888', marginBottom:16 }}>
                {ts && <>Currently on <b>Session {ts.currentSession} of {ts.totalSessions}</b> — this progress will be lost and training will need to start over from Session 1.</>}
              </div>
              <div style={{ display:'flex', gap:10 }}>
                <button onClick={() => setCancellingDog(null)} style={{ flex:1, padding:'12px 0', background:'#eee', border:'none', borderRadius:12, fontWeight:'bold', fontSize:14, cursor:'pointer' }}>Keep Training</button>
                <button onClick={confirmCancel} style={{ flex:1, padding:'12px 0', background:'#e63946', color:'white', border:'none', borderRadius:12, fontWeight:'bold', fontSize:14, cursor:'pointer' }}>Take Out</button>
              </div>
            </div>
          </div>
        );
      })()}

      <h2 style={{ textAlign:'center', margin:'0 0 4px', color:'#333' }}>🏫 Cat Training School</h2>
      <p style={{ textAlign:'center', color:'#888', fontSize:13, margin:'0 0 16px' }}>
        Enrol level 5+ cats · 3-hour sessions · unlock Elite Races at Lv.6!
      </p>

      {/* How it works */}
      <div style={{ background:'linear-gradient(135deg,#e8f5e9,#c8e6c9)', borderRadius:14, padding:12, marginBottom:16, border:'1.5px solid #81c784' }}>
        <div style={{ fontWeight:'bold', color:'#2e7d32', marginBottom:6, fontSize:13 }}>📋 How Training Works</div>
        <div style={{ fontSize:12, color:'#444', lineHeight:1.6 }}>
          • Only cats at <b>Level 5+</b> can attend the Training School<br />
          • Each level-up needs multiple 3-hour sessions<br />
          • <b>Lv5→6:</b> 1 session &nbsp;·&nbsp; <b>Lv6→7:</b> 2 sessions &nbsp;·&nbsp; <b>Lv7→8:</b> 3 sessions…<br />
          • Cats at <b>Lv6+</b> can enter 🏆 Elite Races for big Kitty Coins!
        </div>
      </div>

      {/* Currently in training */}
      {eligibleDogs.some(d => readTS(d)) && (
        <div style={{ marginBottom:16 }}>
          <div style={{ fontWeight:'bold', color:'#764ba2', marginBottom:8, fontSize:14 }}>🎓 Currently Training</div>
          {eligibleDogs.filter(d => readTS(d)).map(dog => {
            const ts = readTS(dog);
            const elapsed = now - ts.sessionStartTime;
            const remaining = Math.max(0, TRAINING_SESSION_MS - elapsed);
            const done = remaining === 0;
            const pct = Math.min(100, (elapsed / TRAINING_SESSION_MS) * 100);
            const s = getDogState(dog.id);
            return (
              <div key={dog.id} style={{ background:'white', borderRadius:14, padding:14, marginBottom:10, boxShadow:'0 2px 8px rgba(0,0,0,0.08)', border:'2px solid ' + (done ? '#06d6a0' : '#667eea') }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                  {dog.photo_url && <img src={dogImageSrc(dog) || dog.photo_url} alt="" style={{ width:44, height:44, borderRadius:10, objectFit:'cover' }} />}
                  <div>
                    <div style={{ fontWeight:'bold', fontSize:14 }}>{dog.name || dog.breed}</div>
                    <div style={{ fontSize:12, color:'#888' }}>{dog.breed} · Lv.{s.level} → Lv.{ts.targetLevel}</div>
                    <div style={{ fontSize:11, color:rarityColor[dog.rarity] || '#888', fontWeight:'bold' }}>{dog.rarity}</div>
                  </div>
                  <div style={{ marginLeft:'auto', textAlign:'right' }}>
                    <div style={{ fontSize:12, color:'#888' }}>Session {ts.currentSession}/{ts.totalSessions}</div>
                    <div style={{ fontWeight:'bold', fontSize:14, color: done ? '#06d6a0' : '#667eea' }}>{formatTimeLeft(remaining)}</div>
                  </div>
                </div>
                {/* Progress bar */}
                <div style={{ background:'#f0f0f0', borderRadius:8, height:8, marginBottom:10, overflow:'hidden' }}>
                  <div style={{ width:`${pct}%`, height:'100%', background: done ? '#06d6a0' : 'linear-gradient(90deg,#667eea,#764ba2)', borderRadius:8, transition:'width 1s linear' }} />
                </div>
                {done && ts.currentSession >= ts.totalSessions ? (
                  // Final session done — collect the level-up
                  <button onClick={() => handleCollect(dog)} style={{ width:'100%', padding:'12px 0', background:'linear-gradient(135deg,#f7b731,#e65100)', color:'white', border:'none', borderRadius:12, fontWeight:'bold', fontSize:15, cursor:'pointer' }}>
                    🎉 Collect Level Up to Lv.{ts.targetLevel}!
                  </button>
                ) : done ? (
                  // Intermediate session done — start next one
                  <button onClick={() => handleCollect(dog)} style={{ width:'100%', padding:'10px 0', background:'linear-gradient(135deg,#667eea,#764ba2)', color:'white', border:'none', borderRadius:12, fontWeight:'bold', fontSize:14, cursor:'pointer' }}>
                    ✅ Session {ts.currentSession} done! Start Session {ts.currentSession + 1} of {ts.totalSessions}
                  </button>
                ) : (
                  <button onClick={() => handleCancel(dog)} style={{ width:'100%', padding:'8px 0', background:'#fff0f0', color:'#c62828', border:'1px solid #ffcdd2', borderRadius:12, fontWeight:'bold', fontSize:13, cursor:'pointer' }}>
                    ✕ Cancel Training
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Available dogs */}
      <div style={{ fontWeight:'bold', color:'#333', marginBottom:8, fontSize:14 }}>🐱 Available Cats (Lv.5+)</div>
      {eligibleDogs.length === 0 ? (
        <div style={{ background:'#fff8e1', borderRadius:14, padding:16, textAlign:'center', border:'1.5px solid #ffe082' }}>
          <div style={{ fontSize:32, marginBottom:8 }}>🐾</div>
          <div style={{ fontWeight:'bold', color:'#e65100', marginBottom:4 }}>No cats at Level 5 yet!</div>
          <div style={{ fontSize:13, color:'#888' }}>Feed and train your cats in the 🐱 Cats tab to reach Level 5.</div>
        </div>
      ) : (
        <div>
          {eligibleDogs.filter(d => !readTS(d)).map(dog => {
            const s = getDogState(dog.id);
            const level = s.level || 1;
            const needed = sessionsNeeded(level);
            const totalHours = needed * TRAINING_SESSION_HOURS;
            return (
              <div key={dog.id} style={{ background:'white', borderRadius:14, padding:14, marginBottom:10, boxShadow:'0 2px 8px rgba(0,0,0,0.06)', border:'1.5px solid #e0e0e0' }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                  {dog.photo_url && <img src={dogImageSrc(dog) || dog.photo_url} alt="" style={{ width:44, height:44, borderRadius:10, objectFit:'cover' }} />}
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:'bold', fontSize:14 }}>{dog.name || dog.breed}</div>
                    <div style={{ fontSize:12, color:'#888' }}>{dog.breed}</div>
                    <div style={{ display:'flex', gap:6, marginTop:2 }}>
                      <span style={{ fontSize:11, fontWeight:'bold', color:rarityColor[dog.rarity]||'#888' }}>{dog.rarity}</span>
                      <span style={{ fontSize:11, color:'#764ba2', fontWeight:'bold' }}>Lv.{level}</span>
                      {level >= 6 && <span style={{ fontSize:10, background:'#ffd700', color:'#5d4037', borderRadius:8, padding:'1px 5px', fontWeight:'bold' }}>🏆 Elite</span>}
                    </div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:12, color:'#888' }}>→ Lv.{level + 1}</div>
                    <div style={{ fontSize:11, color:'#666' }}>{needed} session{needed>1?'s':''} · {totalHours}h</div>
                  </div>
                </div>
                <button onClick={() => handleEnroll(dog)} style={{ width:'100%', padding:'10px 0', background:'linear-gradient(135deg,#667eea,#764ba2)', color:'white', border:'none', borderRadius:12, fontWeight:'bold', fontSize:13, cursor:'pointer' }}>
                  🎓 Enrol in Training School
                </button>
              </div>
            );
          })}
          {eligibleDogs.filter(d => !readTS(d)).length === 0 && (
            <div style={{ textAlign:'center', color:'#888', fontSize:13, padding:16 }}>All eligible cats are currently training! 🎓</div>
          )}
        </div>
      )}
    </div>
  );
}

function PetRaceScreen({ player, dogs, setPlayer, onlineCount }) {
  const [screen, setScreen] = React.useState('home');
  // home | host_pick_dog | host_lobby | join_browse | join_pick_dog | waiting | racing | spectating | result
  const screenRef = React.useRef('home'); // always-current mirror of screen for use inside intervals
  const goScreen = s => { screenRef.current = s; setScreen(s); if (s === 'result') setRacePaidInDD(false); };

  const dd = useLive(getDD, 'km_dd_change');
  const [raceId, setRaceId] = React.useState(null);
  const [room, setRoom] = React.useState(null);
  const [mySlot, setMySlot] = React.useState(null); // 'p1'..'p4', null if host/spectator
  const [selectedDog, setSelectedDog] = React.useState(null);
  const [joinTarget, setJoinTarget] = React.useState(null); // room to join
  const [openRooms, setOpenRooms] = React.useState([]);
  const [browseError, setBrowseError] = React.useState(null);
  const [result, setResult] = React.useState(null);
  const [toast, setToast] = React.useState(null);
  const [finishOrder, setFinishOrder] = React.useState([]); // slots in finish order
  const [racePaidInDD, setRacePaidInDD] = React.useState(false);
  const [eliteMode, setEliteMode] = React.useState(false); // true when racing in Elite mode
  const showToast = m => { setToast(m); setTimeout(() => setToast(null), 2500); };

  const pollRef = React.useRef(null);
  const myPctRef = React.useRef(0);
  const finishedRef = React.useRef(false);
  const finishOrderRef = React.useRef([]);
  const [countdown, setCountdown] = React.useState(null); // 3,2,1,'GO!',null

  React.useEffect(() => () => clearInterval(pollRef.current), []);

  const playCountdownBeep = React.useCallback((isGo) => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = isGo ? 880 : 440;
      osc.type = isGo ? 'sine' : 'square';
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (isGo ? 0.6 : 0.18));
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + (isGo ? 0.6 : 0.2));
    } catch {}
  }, []);

  const startCountdown = React.useCallback((onDone) => {
    setCountdown(3);
    playCountdownBeep(false);
    let n = 3;
    const t = setInterval(() => {
      n--;
      if (n > 0) { setCountdown(n); playCountdownBeep(false); }
      else if (n === 0) { setCountdown('GO! 🏁'); playCountdownBeep(true); }
      else { clearInterval(t); setCountdown(null); onDone && onDone(); }
    }, 1000);
  }, [playCountdownBeep]);

  const goRacing = React.useCallback(() => {
    goScreen('racing');
    startCountdown(null);
  }, [startCountdown]); // eslint-disable-line

  const resetAll = () => {
    clearInterval(pollRef.current);
    clearInterval(aiIntervalRef.current);
    goScreen('home'); setRaceId(null); setRoom(null); setMySlot(null);
    setSelectedDog(null); setJoinTarget(null); setOpenRooms([]);
    setBrowseError(null); setResult(null); setFinishOrder([]);
    myPctRef.current = 0; finishedRef.current = false; finishOrderRef.current = [];
    aiRef.current = null; aiFinishedRef.current = false; myAiPctRef.current = 0; setAiRoom(null);
    ghostModeRef.current = false; setGhostMode(false); ghostStartRef.current = null; ghostTapsRef.current = [];
    setEliteMode(false);
  };

  // ── Polling ──────────────────────────────────────────────────────────────────
  const startPoll = React.useCallback((id, slot, isSpectator) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetchRaceRoom(id);
        if (!r) return;
        setRoom(r);

        // Use screenRef (always-current) to avoid stale closure
        if (r.status === 'racing' && (screenRef.current === 'waiting' || screenRef.current === 'host_lobby')) {
          if (isSpectator) { goScreen('spectating'); } else { goRacing(); }
        }

        // Detect finishers
        const slots = ['p1','p2','p3','p4'].filter(n => r[`${n}_id`]);
        for (const n of slots) {
          if (r[`${n}_pct`] >= 100 && !finishOrderRef.current.includes(n)) {
            finishOrderRef.current = [...finishOrderRef.current, n];
            setFinishOrder([...finishOrderRef.current]);
          }
        }

        // Fallback: if local player finished but race is still 'racing', nudge it to finish
        if (r.status === 'racing' && slot && r[`${slot}_finished_at`] && finishedRef.current) {
          finishRaceRoom(raceId, player.id).catch(() => {});
        }

        if (r.status === 'finished') {
          clearInterval(pollRef.current);
          // Build authoritative finish order from server-recorded finish timestamps.
          // Slots with a timestamp sort by that (ascending). Slots without (DNF) go last.
          const allSlots = ['p1','p2','p3','p4'].filter(n => r[`${n}_id`]);
          const withTime = allSlots.filter(n => r[`${n}_finished_at`]);
          const dnf = allSlots.filter(n => !r[`${n}_finished_at`]);
          withTime.sort((a, b) => new Date(r[`${a}_finished_at`]).getTime() - new Date(r[`${b}_finished_at`]).getTime());
          const order = [...withTime, ...dnf];
          finishOrderRef.current = order;
          setFinishOrder(order);
          const myPlace = slot ? order.indexOf(slot) : -1;
          const pts = myPlace >= 0 ? PLACE_PTS[myPlace] || 0 : 0;
          // Record challenge progress and race wins, but do NOT add points yet —
          // the result screen reward tabs let the player choose pts vs Kitty Coins.
          if (pts > 0) {
            recordChallenge('race_finish');
            addStarXP('race_finish');
            const rows = await sb(`players?id=eq.${player.id}&select=race_wins`).catch(() => []);
            if (myPlace === 0) {
              const w = parseInt(rows[0]?.race_wins || 0, 10) + 1;
              sb(`players?id=eq.${player.id}`, 'PATCH', { race_wins: w }).catch(() => {});
              localStorage.setItem('km_race_wins', w);
              recordChallenge('race_win');
              addStarXP('race_win');
              fireFireworks(3000); // 🏆 race win!
              playSound('win');
              fireBigWin('1st PLACE!', '🏁 Race Victory', '🏆', '#ffd700', 2800, 'Tap below: 200 pts OR 10 🪙 Kitty Coins');
            } else if (myPlace === 1) {
              playSound('achievement');
              fireBigWin('2nd PLACE!', 'Great race!', '🥈', '#c0c0c0', 2200);
            }
          }
          // Store order inside result so it's available synchronously on the result screen
          setResult({ place: myPlace, pts, isSpectator, order });
          goScreen('result');
        }
      } catch {}
    }, 500);
  }, [player]); // eslint-disable-line

  const [creatingRoom, setCreatingRoom] = React.useState(false);
  const [confirmDeleteRoom, setConfirmDeleteRoom] = React.useState(false);

  // ── VS AI state ───────────────────────────────────────────────────────────────
  const [aiRoom, setAiRoom] = React.useState(null); // local race room for AI mode
  const aiRef = React.useRef(null);
  const aiIntervalRef = React.useRef(null);
  const aiFinishedRef = React.useRef(false);
  const myAiPctRef = React.useRef(0);

  // Ghost recording refs
  const ghostStartRef = React.useRef(null);   // Date.now() when GO fires
  const ghostTapsRef = React.useRef([]);       // [{t: ms_since_start, pct: 0-100}, ...]
  const ghostModeRef = React.useRef(false);   // true when racing own ghost
  const [ghostMode, setGhostMode] = React.useState(false);

  // Helper: get ghost for a dog id
  const getGhost = (dogId) => {
    try { return JSON.parse(localStorage.getItem(`km_ghost_${dogId}`) || 'null'); }
    catch { return null; }
  };
  const saveGhost = (dogId, taps) => {
    try { localStorage.setItem(`km_ghost_${dogId}`, JSON.stringify(taps)); } catch {}
  };

  const AI_DOGS = [
    { name: 'Tigger',  breed: 'Bengal',            rarity: 'Legendary', speed: 6.4 },
    { name: 'Luna',    breed: 'Siamese',           rarity: 'Epic',      speed: 7.0 },
    { name: 'Milo',    breed: 'Ginger Tabby',      rarity: 'Common',    speed: 4.8 },
    { name: 'Cleo',    breed: 'Egyptian Mau',      rarity: 'Legendary', speed: 6.8 },
    { name: 'Smokey',  breed: 'Russian Blue',      rarity: 'Epic',      speed: 5.8 },
    { name: 'Biscuit', breed: 'Domestic Shorthair',rarity: 'Common',    speed: 4.5 },
  ];

  const startAiRace = React.useCallback((dog, useGhost) => {
    const ghost = useGhost ? getGhost(dog.id) : null;
    ghostModeRef.current = !!(useGhost && ghost);
    setGhostMode(!!(useGhost && ghost));

    // Reset ghost recording for this run
    ghostStartRef.current = null;
    ghostTapsRef.current = [];

    const opponents = [...AI_DOGS].sort(() => Math.random() - 0.5).slice(0, ghost ? 2 : 3);
    const initial = {
      p1_id: 'me', p1_username: player.username, p1_dog: dogRaceLabel(dog), p1_rarity: dog.rarity, p1_pct: 0,
      // p2 = ghost (if ghost mode) or first AI
      p2_id: ghost ? 'ghost' : 'ai1',
      p2_username: ghost ? '👻 You (best)' : '🤖 ' + opponents[0].name,
      p2_dog: ghost ? dogRaceLabel(dog) : opponents[0].breed,
      p2_rarity: ghost ? dog.rarity : opponents[0].rarity,
      p2_pct: 0,
      p3_id: 'ai2', p3_username: '🤖 ' + opponents[ghost ? 0 : 1].name, p3_dog: opponents[ghost ? 0 : 1].breed, p3_rarity: opponents[ghost ? 0 : 1].rarity, p3_pct: 0,
      p4_id: 'ai3', p4_username: '🤖 ' + opponents[ghost ? 1 : 2].name, p4_dog: opponents[ghost ? 1 : 2].breed, p4_rarity: opponents[ghost ? 1 : 2].rarity, p4_pct: 0,
    };
    // speeds[0] = ghost/ai1, speeds[1] = ai2, speeds[2] = ai3
    const aiSpeeds = ghost ? opponents.map(o => o.speed) : opponents.map(o => o.speed);
    aiRef.current = { room: initial, speeds: aiSpeeds, finishedAt: [null, null, null, null], ghost, ghostIdx: 0 };
    aiFinishedRef.current = false;
    myAiPctRef.current = 0;
    setAiRoom({ ...initial });
    setMySlot('p1');
    goScreen('ai_racing');
    startCountdown(() => {
      ghostStartRef.current = Date.now();
      // AI auto-advances every 300ms; ghost replays from recording
      aiIntervalRef.current = setInterval(() => {
        const state = aiRef.current;
        if (!state) return;
        const now = Date.now();
        const elapsed = ghostStartRef.current ? now - ghostStartRef.current : 0;
        let changed = false;

        // Ghost replay: advance p2 to match recorded pct at this elapsed time
        if (state.ghost && state.ghost.length) {
          // Find the latest recorded snapshot whose time <= elapsed
          let ghostPct = state.room.p2_pct;
          while (state.ghostIdx < state.ghost.length && state.ghost[state.ghostIdx].t <= elapsed) {
            ghostPct = state.ghost[state.ghostIdx].pct;
            state.ghostIdx++;
          }
          ghostPct = Math.min(100, ghostPct);
          if (ghostPct !== state.room.p2_pct) {
            state.room.p2_pct = ghostPct;
            if (ghostPct >= 100 && !state.finishedAt[1]) {
              state.finishedAt[1] = now;
            }
            changed = true;
          }
        }

        // AI opponents advance (p3 and p4, or p2/p3/p4 in non-ghost mode)
        const aiSlots = state.ghost ? ['p3', 'p4'] : ['p2', 'p3', 'p4'];
        const speedOffset = state.ghost ? 0 : 0; // speeds array already aligned
        aiSlots.forEach((slot, idx) => {
          const speedIdx = state.ghost ? idx : idx; // speeds[0..] match opponent order
          if (state.room[`${slot}_pct`] < 100) {
            const inc = state.speeds[speedIdx] + (Math.random() - 0.5) * 1.5;
            const newPct = Math.min(100, state.room[`${slot}_pct`] + inc);
            state.room[`${slot}_pct`] = newPct;
            const slotIdx = ['p1','p2','p3','p4'].indexOf(slot);
            if (newPct >= 100 && !state.finishedAt[slotIdx]) {
              state.finishedAt[slotIdx] = now;
            }
            changed = true;
          }
        });
        if (changed) setAiRoom({ ...state.room });
        // End race when first player finishes (mirrors multiplayer behaviour)
        const anyDone = ['p1','p2','p3','p4'].some(s => state.room[`${s}_pct`] >= 100);
        if (anyDone && !aiFinishedRef.current) {
          aiFinishedRef.current = true;
          clearInterval(aiIntervalRef.current);
          // Save ghost recording (replace old one)
          if (ghostTapsRef.current.length > 0) {
            saveGhost(dog.id, ghostTapsRef.current);
          }
          // Build result — sort finishers by time, DNF slots by progress descending
          const slots = ['p1','p2','p3','p4'];
          const withTime = slots.filter((s, i) => state.finishedAt[i]);
          withTime.sort((a, b) => state.finishedAt[slots.indexOf(a)] - state.finishedAt[slots.indexOf(b)]);
          const dnf = slots.filter((s, i) => !state.finishedAt[i]);
          // Sort DNF by how close they were to finishing (higher pct = better place)
          dnf.sort((a, b) => (state.room[`${b}_pct`] || 0) - (state.room[`${a}_pct`] || 0));
          const order = [...withTime, ...dnf];
          const myPlace = order.indexOf('p1');
          const pts = myPlace >= 0 ? PLACE_PTS[myPlace] || 0 : 0;
          // Record challenge progress and race wins, but do NOT add points yet —
          // the result screen reward tabs let the player choose pts vs Kitty Coins.
          if (pts > 0) {
            recordChallenge('race_finish');
            addStarXP('race_finish');
          }
          if (myPlace === 0) {
            const wins = parseInt(localStorage.getItem('km_race_wins') || '0') + 1;
            localStorage.setItem('km_race_wins', wins);
            recordChallenge('race_win');
            addStarXP('race_win');
            fireFireworks(3000); // 🏆 race win!
            playSound('win');
            fireBigWin('1st PLACE!', '🏁 Race Victory', '🏆', '#ffd700', 2800, 'Tap below: 200 pts OR 10 🪙 Kitty Coins');
          } else if (myPlace === 1) {
            playSound('achievement');
            fireBigWin('2nd PLACE!', 'Great race!', '🥈', '#c0c0c0', 2200);
          }
          setResult({ place: myPlace, pts, isSpectator: false, order, aiMode: true, ghostMode: ghostModeRef.current });
          goScreen('result');
        }
      }, 300);
    });
  }, [player, startCountdown]); // eslint-disable-line

  const handleAiTap = () => {
    if (screenRef.current !== 'ai_racing' || aiFinishedRef.current || countdown) return;
    const inc = 3.5 + Math.random() * 2;
    myAiPctRef.current = Math.min(100, myAiPctRef.current + inc);
    const pct = myAiPctRef.current;
    const now = Date.now();
    // Record tap for ghost replay
    if (ghostStartRef.current) {
      ghostTapsRef.current.push({ t: now - ghostStartRef.current, pct });
    }
    if (aiRef.current) {
      aiRef.current.room.p1_pct = pct;
      if (pct >= 100 && !aiRef.current.finishedAt[0]) {
        aiRef.current.finishedAt[0] = now;
      }
    }
    setAiRoom(prev => prev ? { ...prev, p1_pct: pct } : prev);
  };

  // ── Host creates room ────────────────────────────────────────────────────────
  const handleCreateRoom = async (dog) => {
    if (creatingRoom) return;
    setCreatingRoom(true);
    try {
      const id = await createRaceRoom(player.id, player.username);
      // Host joins as p1 so they race too
      const slot = await joinRaceSlot(id, player.id, player.username, dogRaceLabel(dog), dog.rarity);
      setRaceId(id);
      setMySlot(slot);
      setSelectedDog(dog);
      const r = await fetchRaceRoom(id);
      setRoom(r);
      goScreen('host_lobby');
      startPoll(id, slot, false);
    } catch {
      showToast('Could not create room. Set up km_races table in Supabase first.');
    } finally {
      setCreatingRoom(false);
    }
  };

  const handleStartRace = async () => {
    try {
      await startRaceRoom(raceId);
      goRacing(); // host races too now
    } catch { showToast('Could not start race.'); }
  };

  // ── Browse open rooms ────────────────────────────────────────────────────────
  const loadBrowse = async () => {
    setBrowseError(null);
    try {
      const rooms = await fetchOpenRaces();
      setOpenRooms(Array.isArray(rooms) ? rooms : []);
    } catch { setBrowseError('Could not load rooms. Check connection.'); setOpenRooms([]); }
  };

  // ── Join room ────────────────────────────────────────────────────────────────
  const handleJoin = async (targetRoom, dog) => {
    try {
      const slot = await joinRaceSlot(targetRoom.id, player.id, player.username, dogRaceLabel(dog), dog.rarity);
      setRaceId(targetRoom.id);
      setMySlot(slot);
      setSelectedDog(dog);
      const r = await fetchRaceRoom(targetRoom.id);
      setRoom(r);
      if (r.status === 'racing') { goRacing(); } else { goScreen('waiting'); }
      startPoll(targetRoom.id, slot, false);
    } catch (e) {
      showToast(e.message || 'Could not join.');
    }
  };

  // ── Player taps ──────────────────────────────────────────────────────────────
  const handleTap = async () => {
    if (screen !== 'racing' || finishedRef.current || !mySlot || countdown) return;
    const inc = 3.5 + Math.random() * 2;
    myPctRef.current = Math.min(100, myPctRef.current + inc);
    const pct = myPctRef.current;
    setRoom(prev => prev ? { ...prev, [`${mySlot}_pct`]: pct } : prev);
    if (pct >= 100 && !finishedRef.current) {
      finishedRef.current = true;
      const finishedAt = Date.now();
      // Push 100% AND record finish timestamp atomically
      await Promise.all([
        sb(`km_races?id=eq.${raceId}`, 'PATCH', { [`${mySlot}_pct`]: 100, [`${mySlot}_finished_at`]: finishedAt }).catch(() => {}),
      ]);
      // First player to finish ends the race — others still record their finish times
      await finishRaceRoom(raceId, player.id).catch(() => {});
    } else {
      pushProgress(raceId, mySlot, pct);
    }
  };

  const isHost = room?.host_id === player.id;
  const playerSlots = room ? ['p1','p2','p3','p4'].filter(n => room[`${n}_id`]) : [];

  // ── SCREENS ──────────────────────────────────────────────────────────────────

  if (screen === 'home') {
    return (
      <div style={{ padding: 16 }}>
        <style>{`.tap-btn{animation:tbounce 0.4s infinite}.tap-btn:active{transform:scale(0.88)!important}@keyframes tbounce{0%,100%{transform:scale(1)}50%{transform:scale(0.93)}}`}</style>
        <h2 style={{ textAlign: 'center', color: '#333', margin: '0 0 4px' }}>🏁 Pet Races</h2>
        <p style={{ textAlign: 'center', color: '#888', fontSize: 13, margin: '0 0 16px' }}>{ONLINE ? 'Live multiplayer · up to 4 cats per race' : 'Race the computer cats · up to 4 per race'}</p>
        <div style={{ background: 'linear-gradient(135deg,#1a1a2e,#16213e)', borderRadius: 14, padding: '10px 14px', marginBottom: 14, border: '2px solid #52b788', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#a0ffa0', fontWeight: 'bold', fontSize: 13 }}>{ONLINE ? `🟢 ${onlineCount || 0} players online` : '📴 Offline mode · race the computer'}</span>
          <span style={{ color: '#ffd700', fontWeight: 'bold', fontSize: 13 }}>🐱 {dd} Kitty Coins</span>
        </div>

        {/* Dog selector — searchable, grouped by breed */}
        <RaceHomeDogPicker dogs={dogs} selectedDog={selectedDog} setSelectedDog={setSelectedDog} getGhost={getGhost} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
          <button
            onClick={() => !ONLINE ? showToast('Live rooms need a KittyMart server — try Race vs AI!') : selectedDog ? handleCreateRoom(selectedDog) : showToast('Pick a cat first!')}
            style={{ opacity: ONLINE ? 1 : 0.55, filter: ONLINE ? 'none' : 'grayscale(0.6)', padding: '22px 0', background: selectedDog ? 'linear-gradient(135deg,#667eea,#764ba2)' : '#ccc', color: 'white', border: 'none', borderRadius: 20, fontSize: 17, fontWeight: 'bold', cursor: selectedDog ? 'pointer' : 'default', boxShadow: selectedDog ? '0 6px 20px rgba(102,126,234,0.35)' : 'none' }}>
            🏟️ Host a Race Room
            <div style={{ fontSize: 12, opacity: 0.85, fontWeight: 'normal', marginTop: 4 }}>{ONLINE ? 'Create a room · invite 2–4 players · start when ready' : '📴 Needs online play · not available offline'}</div>
          </button>
          <button
            onClick={() => { if (!ONLINE) showToast('Live rooms need a KittyMart server — try Race vs AI!'); else if (selectedDog) { goScreen('join_browse'); loadBrowse(); } else showToast('Pick a cat first!'); }}
            style={{ opacity: ONLINE ? 1 : 0.55, filter: ONLINE ? 'none' : 'grayscale(0.6)', padding: '22px 0', background: selectedDog ? 'linear-gradient(135deg,#f72585,#b5179e)' : '#ccc', color: 'white', border: 'none', borderRadius: 20, fontSize: 17, fontWeight: 'bold', cursor: selectedDog ? 'pointer' : 'default', boxShadow: selectedDog ? '0 6px 20px rgba(247,37,133,0.35)' : 'none' }}>
            🐾 Join a Race
            <div style={{ fontSize: 12, opacity: 0.85, fontWeight: 'normal', marginTop: 4 }}>{ONLINE ? 'Browse open rooms · race live' : '📴 Needs online play · not available offline'}</div>
          </button>
          <button
            onClick={() => selectedDog ? startAiRace(selectedDog, false) : showToast('Pick a cat first!')}
            style={{ padding: '22px 0', background: selectedDog ? 'linear-gradient(135deg,#06d6a0,#059e76)' : '#ccc', color: 'white', border: 'none', borderRadius: 20, fontSize: 17, fontWeight: 'bold', cursor: selectedDog ? 'pointer' : 'default', boxShadow: selectedDog ? '0 6px 20px rgba(6,214,160,0.35)' : 'none' }}>
            🤖 Race vs AI
            <div style={{ fontSize: 12, opacity: 0.85, fontWeight: 'normal', marginTop: 4 }}>Solo · 3 AI opponents · instant start</div>
          </button>
          {selectedDog && (() => { const lvl = getDogState(selectedDog.id).level || 1; return lvl >= 6; })() && (
            <button
              onClick={() => { goScreen('elite_pick_dog'); }}
              style={{ padding: '22px 0', background: 'linear-gradient(135deg,#f7b731,#e65100)', color: 'white', border: 'none', borderRadius: 20, fontSize: 17, fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 6px 20px rgba(230,81,0,0.4)', position: 'relative', overflow: 'hidden' }}>
              <span style={{ position:'absolute', top:6, right:12, fontSize:10, background:'rgba(255,255,255,0.25)', borderRadius:20, padding:'2px 8px', fontWeight:'bold' }}>ELITE</span>
              🏆 Elite Race
              <div style={{ fontSize: 12, opacity: 0.85, fontWeight: 'normal', marginTop: 4 }}>Lv.6+ cats · multiplayer only · big Kitty Coins!</div>
            </button>
          )}
          {selectedDog && getGhost(selectedDog.id) && (
            <button
              onClick={() => startAiRace(selectedDog, true)}
              style={{ padding: '16px 0', background: 'linear-gradient(135deg,#764ba2,#667eea)', color: 'white', border: 'none', borderRadius: 20, fontSize: 15, fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 6px 20px rgba(118,75,162,0.35)' }}>
              👻 Race Your Ghost
              <div style={{ fontSize: 12, opacity: 0.85, fontWeight: 'normal', marginTop: 4 }}>Beat your best previous run</div>
            </button>
          )}
        </div>
        {/* Elite Race info strip — only shown when player has a Lv6+ dog */}
        {(dogs || []).some(d => (getDogState(d.id).level || 1) >= 6) && (
          <div style={{ background: 'linear-gradient(135deg,#1a0533,#2d1b69)', borderRadius: 14, padding: '10px 14px', marginBottom: 14, border: '2px solid #f7b731', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 22 }}>🏆</span>
            <div>
              <div style={{ color: '#ffd700', fontWeight: 'bold', fontSize: 13 }}>Elite Races unlocked!</div>
              <div style={{ color: '#ccc', fontSize: 11 }}>Pick your Lv.6+ cat above to enter Elite Races for big Kitty Coins</div>
            </div>
          </div>
        )}
        <div style={{ background: 'linear-gradient(135deg,#fff8e1,#ffe082)', borderRadius: 14, padding: 14, border: '2px solid #ffd54f' }}>
          <div style={{ fontWeight: 'bold', color: '#e65100', marginBottom: 6, fontSize: 14 }}>🏆 Race Prizes</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-around' }}>
            {PLACE_LABELS.map((l, i) => (
              <div key={i} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 18 }}>{l.split(' ')[0]}</div>
                <div style={{ fontWeight: 'bold', color: '#e65100', fontSize: 14 }}>{PLACE_PTS[i]}pts</div>
                <div style={{ fontSize: 11, color: '#888' }}>{l.split(' ')[1]}</div>
              </div>
            ))}
          </div>
          <div style={{ borderTop: '1px solid #ffe082', marginTop: 10, paddingTop: 10 }}>
            <div style={{ fontWeight: 'bold', color: '#5d4037', fontSize: 12, marginBottom: 4 }}>🏆 Elite Race Prizes (Lv.6+ only)</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-around' }}>
              {['🥇','🥈','🥉','4️⃣'].map((em, i) => (
                <div key={i} style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 16 }}>{em}</div>
                  <div style={{ fontWeight: 'bold', color: '#e65100', fontSize: 13 }}>{ELITE_DD_PLACE[i]}🪙</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (screen === 'elite_pick_dog') {
    const eliteDogs = (dogs || []).filter(d => (getDogState(d.id).level || 1) >= 6);
    return (
      <div style={{ padding: 16 }}>
        {toast && <div style={{ position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', background: '#e65100', color: 'white', borderRadius: 20, padding: '10px 20px', fontWeight: 'bold', fontSize: 14, zIndex: 999, whiteSpace: 'nowrap' }}>{toast}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <button onClick={() => goScreen('home')} style={{ background: '#eee', border: 'none', borderRadius: 10, padding: '6px 12px', cursor: 'pointer', fontWeight: 'bold' }}>←</button>
          <h2 style={{ margin: 0, fontSize: 18, color: '#333' }}>🏆 Elite Race</h2>
        </div>
        <div style={{ background: 'linear-gradient(135deg,#1a0533,#2d1b69)', borderRadius: 14, padding: '10px 14px', marginBottom: 14, border: '2px solid #f7b731' }}>
          <div style={{ color: '#ffd700', fontWeight: 'bold', fontSize: 13, marginBottom: 4 }}>🏆 Elite Race Prizes</div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'space-around' }}>
            {['🥇','🥈','🥉','4️⃣'].map((em, i) => (
              <div key={i} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 16 }}>{em}</div>
                <div style={{ fontWeight: 'bold', color: '#ffd700', fontSize: 14 }}>{ELITE_DD_PLACE[i]}🪙</div>
              </div>
            ))}
          </div>
          <div style={{ color: '#aaa', fontSize: 11, marginTop: 6, textAlign: 'center' }}>Multiplayer only · Kitty Coins prize · Level 6+ cats</div>
        </div>
        <p style={{ color: '#666', fontSize: 13, marginBottom: 12, textAlign: 'center' }}>
          Pick your Lv.6+ cat to host or join an Elite Race Room.
        </p>
        {eliteDogs.length === 0 ? (
          <div style={{ background: '#fff8e1', borderRadius: 14, padding: 20, textAlign: 'center', border: '1.5px solid #ffe082' }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>🏫</div>
            <div style={{ fontWeight: 'bold', color: '#e65100', marginBottom: 4 }}>No Lv.6+ cats yet!</div>
            <div style={{ fontSize: 13, color: '#888' }}>Train your cats to Level 6+ in the 🏫 School tab.</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10 }}>
            {eliteDogs.map(dog => {
              const nick = getDogNick(dog.id) || '';
              const s = getDogState(dog.id);
              return (
                <div key={dog.id} style={{ background: 'linear-gradient(135deg,#fff9e6,#fff3cd)', border: '2px solid #f7b731', borderRadius: 16, padding: 12, textAlign: 'center', boxShadow: '0 2px 12px rgba(247,183,49,0.25)', position: 'relative' }}>
                  <div style={{ position: 'absolute', top: 6, left: 6, background: 'linear-gradient(135deg,#f7b731,#e65100)', color: 'white', borderRadius: 20, padding: '1px 7px', fontSize: 10, fontWeight: 'bold' }}>
                    Lv.{s.level} ELITE
                  </div>
                  {dog.photo_url
                    ? <img src={dogImageSrc(dog)} alt={dog.name} style={{ width: 60, height: 60, borderRadius: '50%', objectFit: 'cover', border: '3px solid #f7b731', marginTop: 14 }} onError={e => e.target.style.display='none'} />
                    : <div style={{ width: 60, height: 60, borderRadius: '50%', background: '#f7b73133', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, margin: '14px auto 0' }}>🐱</div>
                  }
                  <div style={{ fontSize: 13, fontWeight: 'bold', marginTop: 6 }}>{nick || dog.name}</div>
                  <div style={{ fontSize: 11, color: '#888' }}>{dog.breed}</div>
                  <div style={{ fontSize: 11, color: RARITY_COLORS[dog.rarity], fontWeight: 'bold', marginBottom: 8 }}>{dog.rarity}</div>
                  <button onClick={() => { setEliteMode(true); setSelectedDog(dog); handleCreateRoom(dog); }}
                    style={{ display: 'block', width: '100%', background: 'linear-gradient(135deg,#f7b731,#e65100)', color: 'white', border: 'none', borderRadius: 10, padding: '7px 0', fontWeight: 'bold', fontSize: 12, cursor: 'pointer', marginBottom: 5 }}>
                    🏟️ Host Elite Room
                  </button>
                  <button onClick={() => { setEliteMode(true); setSelectedDog(dog); goScreen('elite_browse'); loadBrowse(); }}
                    style={{ display: 'block', width: '100%', background: 'linear-gradient(135deg,#1a0533,#2d1b69)', color: '#ffd700', border: '1px solid #f7b731', borderRadius: 10, padding: '7px 0', fontWeight: 'bold', fontSize: 12, cursor: 'pointer' }}>
                    🐾 Join Elite Race
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (screen === 'elite_browse') {
    return (
      <div style={{ padding: 16 }}>
        {toast && <div style={{ position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', background: '#e65100', color: 'white', borderRadius: 20, padding: '10px 20px', fontWeight: 'bold', fontSize: 14, zIndex: 999, whiteSpace: 'nowrap' }}>{toast}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <button onClick={() => goScreen('elite_pick_dog')} style={{ background: '#eee', border: 'none', borderRadius: 10, padding: '6px 12px', cursor: 'pointer', fontWeight: 'bold' }}>←</button>
          <h2 style={{ margin: 0, fontSize: 18, color: '#333' }}>🏆 Join Elite Race</h2>
        </div>
        {browseError && <div style={{ color: '#e53935', marginBottom: 10, fontSize: 13 }}>{browseError}</div>}
        {openRooms.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 30 }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>🏆</div>
            <div style={{ color: '#888', fontSize: 14 }}>No Elite rooms open right now.</div>
            <div style={{ color: '#aaa', fontSize: 12, marginTop: 4 }}>Host one yourself or check back soon!</div>
            <button onClick={loadBrowse} style={{ marginTop: 14, padding: '10px 24px', background: 'linear-gradient(135deg,#f7b731,#e65100)', color: 'white', border: 'none', borderRadius: 12, fontWeight: 'bold', fontSize: 14, cursor: 'pointer' }}>🔄 Refresh</button>
          </div>
        ) : (
          <div>
            {openRooms.map(r => (
              <div key={r.id} style={{ background: 'linear-gradient(135deg,#fff9e6,#fff3cd)', borderRadius: 14, padding: 14, marginBottom: 10, border: '2px solid #f7b731', boxShadow: '0 2px 8px rgba(247,183,49,0.2)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontWeight: 'bold', color: '#e65100', fontSize: 15 }}>🏟️ Elite Room</div>
                  <div style={{ fontSize: 12, color: '#888' }}>
                    {['p1','p2','p3','p4'].filter(n => r[`${n}_id`]).length}/4 players
                  </div>
                </div>
                <div style={{ fontSize: 12, color: '#555', marginBottom: 8 }}>
                  Host: <b>{r.p1_username || '?'}</b>
                </div>
                <button onClick={() => selectedDog && handleJoin(r, selectedDog)}
                  style={{ width: '100%', padding: '10px 0', background: 'linear-gradient(135deg,#f7b731,#e65100)', color: 'white', border: 'none', borderRadius: 12, fontWeight: 'bold', fontSize: 14, cursor: 'pointer' }}>
                  🐾 Join This Room
                </button>
              </div>
            ))}
            <button onClick={loadBrowse} style={{ width: '100%', padding: '10px 0', background: '#f5f5f5', color: '#555', border: 'none', borderRadius: 12, fontWeight: 'bold', fontSize: 13, cursor: 'pointer', marginTop: 6 }}>
              🔄 Refresh List
            </button>
          </div>
        )}
      </div>
    );
  }

  if (screen === 'ai_pick_dog') {
    return (
      <div style={{ padding: 16 }}>
        {toast && <div style={{ position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', background: '#764ba2', color: 'white', borderRadius: 20, padding: '10px 20px', fontWeight: 'bold', fontSize: 14, zIndex: 999, whiteSpace: 'nowrap' }}>{toast}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <button onClick={() => goScreen('home')} style={{ background: '#eee', border: 'none', borderRadius: 10, padding: '6px 12px', cursor: 'pointer', fontWeight: 'bold' }}>←</button>
          <h2 style={{ margin: 0, fontSize: 18, color: '#333' }}>🤖 Race vs AI</h2>
        </div>
        <p style={{ color: '#666', fontSize: 13, marginBottom: 12, textAlign: 'center' }}>
          Pick your cat — you'll race against 3 AI opponents.<br />
          <span style={{ color: '#764ba2', fontWeight: 'bold' }}>👻 Cats with a ghost recording let you race your best run!</span>
        </p>
        {dogs.length === 0 ? (
          <div style={{ color: '#888', textAlign: 'center', padding: 30 }}>No cats yet — catch some first!</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10 }}>
            {dogs.map(dog => {
              const nick = getDogNick(dog.id) || '';
              const ghost = getGhost(dog.id);
              return (
                <div key={dog.id} style={{ background: 'white', border: `2px solid ${RARITY_COLORS[dog.rarity]}`, borderRadius: 16, padding: 12, textAlign: 'center', boxShadow: '0 2px 8px rgba(0,0,0,0.06)', position: 'relative' }}>
                  {ghost && (
                    <div style={{ position: 'absolute', top: 6, right: 6, background: 'linear-gradient(135deg,#764ba2,#667eea)', color: 'white', borderRadius: 20, padding: '2px 7px', fontSize: 10, fontWeight: 'bold' }}>
                      👻 Ghost
                    </div>
                  )}
                  {dog.photo_url
                    ? <img src={dogImageSrc(dog)} alt={dog.name} style={{ width: 60, height: 60, borderRadius: '50%', objectFit: 'cover', border: `3px solid ${RARITY_COLORS[dog.rarity]}` }} onError={e => e.target.style.display='none'} />
                    : <div style={{ width: 60, height: 60, borderRadius: '50%', background: RARITY_COLORS[dog.rarity] + '33', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, margin: '0 auto' }}>🐱</div>
                  }
                  <div style={{ fontSize: 13, fontWeight: 'bold', marginTop: 6 }}>{nick || dog.name}</div>
                  <div style={{ fontSize: 11, color: '#888' }}>{dog.breed}</div>
                  <div style={{ fontSize: 11, color: RARITY_COLORS[dog.rarity], fontWeight: 'bold', marginBottom: 8 }}>{dog.rarity}</div>
                  <button onClick={() => { setSelectedDog(dog); startAiRace(dog, false); }}
                    style={{ display: 'block', width: '100%', background: 'linear-gradient(135deg,#06d6a0,#059e76)', color: 'white', border: 'none', borderRadius: 10, padding: '6px 0', fontWeight: 'bold', fontSize: 12, cursor: 'pointer', marginBottom: ghost ? 5 : 0 }}>
                    Race vs AI 🤖
                  </button>
                  {ghost && (
                    <button onClick={() => { setSelectedDog(dog); startAiRace(dog, true); }}
                      style={{ display: 'block', width: '100%', background: 'linear-gradient(135deg,#764ba2,#667eea)', color: 'white', border: 'none', borderRadius: 10, padding: '6px 0', fontWeight: 'bold', fontSize: 12, cursor: 'pointer' }}>
                      👻 Race Ghost
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (screen === 'ai_racing') {
    const isCountingDown = countdown !== null;
    const cdColor = countdown === 'GO! 🏁' ? '#06d6a0' : '#ffd700';
    const myPct = aiRoom?.p1_pct || 0;
    const finished = myPct >= 100;
    return (
      <div style={{ padding: 16, userSelect: 'none', position: 'relative' }}>
        <style>{`.tap-btn{animation:tbounce 0.4s infinite}.tap-btn:active{transform:scale(0.88)!important}@keyframes tbounce{0%,100%{transform:scale(1)}50%{transform:scale(0.93)}}@keyframes cdpop{0%{transform:translate(-50%,-50%) scale(0.4);opacity:0}40%{transform:translate(-50%,-50%) scale(1.2);opacity:1}100%{transform:translate(-50%,-50%) scale(1);opacity:1}}`}</style>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontWeight: 'bold', color: ghostMode ? '#764ba2' : '#06d6a0', fontSize: 14 }}>
            {ghostMode ? '👻 Ghost Race' : '🤖 vs AI'}
          </span>
          <button onClick={() => { clearInterval(aiIntervalRef.current); resetAll(); }} style={{ background: '#eee', border: 'none', borderRadius: 8, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>Quit</button>
        </div>
        {ghostMode && (
          <div style={{ background: 'linear-gradient(135deg,#f3e5ff,#ede1ff)', borderRadius: 10, padding: '6px 12px', marginBottom: 8, fontSize: 12, color: '#764ba2', fontWeight: 'bold', textAlign: 'center' }}>
            👻 Racing against your best ghost — beat your own record!
          </div>
        )}
        {aiRoom && <RaceTrack room={aiRoom} mySlot="p1" />}
        {isCountingDown && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.55)', borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10 }}>
            <div key={String(countdown)} style={{ fontSize: countdown === 'GO! 🏁' ? 52 : 96, fontWeight: 900, color: cdColor, textShadow: `0 0 40px ${cdColor}`, animation: 'cdpop 0.5s ease-out forwards', position: 'absolute', top: '50%', left: '50%' }}>
              {countdown}
            </div>
          </div>
        )}
        <button className={isCountingDown ? '' : 'tap-btn'} onPointerDown={handleAiTap} style={{ display: 'block', width: '100%', minHeight: 120, background: finished ? 'linear-gradient(135deg,#aaa,#888)' : isCountingDown ? '#555' : 'linear-gradient(135deg,#ffd700,#f4a261)', color: isCountingDown ? '#999' : '#333', border: 'none', borderRadius: 24, fontSize: 28, fontWeight: 900, cursor: isCountingDown ? 'default' : 'pointer', marginTop: 14, marginBottom: 10, boxShadow: isCountingDown ? 'none' : '0 8px 24px rgba(244,162,97,0.5)' }}>
          {finished ? '✅ Finished!' : isCountingDown ? '⏳ Get ready…' : 'TAP! 🐾'}
        </button>
        <p style={{ textAlign: 'center', color: '#aaa', fontSize: 12, margin: 0 }}>Beat the AI! 🏁 Tap as fast as you can</p>
      </div>
    );
  }

  if (screen === 'host_pick_dog') {
    return (
      <div style={{ padding: 16 }}>
        {toast && <div style={{ position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', background: '#764ba2', color: 'white', borderRadius: 20, padding: '10px 20px', fontWeight: 'bold', fontSize: 14, zIndex: 999, whiteSpace: 'nowrap' }}>{toast}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <button onClick={() => goScreen('home')} style={{ background: '#eee', border: 'none', borderRadius: 10, padding: '6px 12px', cursor: 'pointer', fontWeight: 'bold' }}>←</button>
          <h2 style={{ margin: 0, fontSize: 18, color: '#333' }}>🐾 Pick Your Racing Cat</h2>
        </div>
        <DogPicker
          dogs={dogs}
          onPick={handleCreateRoom}
          subtitle="Choose which cat you'll race with as the host:"
          accentGradient="linear-gradient(135deg,#667eea,#764ba2)"
          buttonLabel={creatingRoom ? 'Creating…' : 'Race this cat 🏁'}
          disabled={creatingRoom}
        />
      </div>
    );
  }

  if (screen === 'host_lobby') {
    const canStart = playerSlots.length >= 2;
    return (
      <div style={{ padding: 16 }}>
        {toast && <div style={{ position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', background: '#764ba2', color: 'white', borderRadius: 20, padding: '10px 20px', fontWeight: 'bold', fontSize: 14, zIndex: 999, whiteSpace: 'nowrap' }}>{toast}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <button onClick={async () => { if (raceId) await deleteRaceRoom(raceId).catch(()=>{}); resetAll(); }} style={{ background: '#eee', border: 'none', borderRadius: 10, padding: '6px 12px', cursor: 'pointer', fontWeight: 'bold' }}>←</button>
          <h2 style={{ margin: 0, fontSize: 18, color: '#333' }}>🏟️ Race Lobby</h2>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#888' }}>You're racing 🐾</span>
        </div>
        {/* Room code */}
        <div style={{ background: 'linear-gradient(135deg,#667eea,#764ba2)', borderRadius: 16, padding: '14px 16px', marginBottom: 16, textAlign: 'center' }}>
          <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12, marginBottom: 4 }}>Share this room code with friends</div>
          <div style={{ fontFamily: 'monospace', fontSize: 22, fontWeight: 'bold', color: 'white', letterSpacing: 3, background: 'rgba(0,0,0,0.2)', borderRadius: 10, padding: '8px 16px', display: 'inline-block' }}>{raceId}</div>
        </div>
        {/* Players joined */}
        <div style={{ background: 'white', borderRadius: 16, padding: 14, marginBottom: 16, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
          <div style={{ fontWeight: 'bold', color: '#333', fontSize: 14, marginBottom: 10 }}>Players ({playerSlots.length}/4)</div>
          {playerSlots.length === 0 ? (
            <div style={{ color: '#aaa', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>
              <div style={{ fontSize: 32, marginBottom: 6 }}>⏳</div>
              Waiting for players to join…
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {playerSlots.map((n, i) => (
                <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#f8f8ff', borderRadius: 12, padding: '8px 12px' }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: LANE_COLORS[i], display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 'bold', fontSize: 14 }}>{i+1}</div>
                  <div>
                    <div style={{ fontWeight: 'bold', fontSize: 13, color: '#333' }}>{room[`${n}_username`]}</div>
                    <div style={{ fontSize: 11, color: '#888' }}>🐱 {room[`${n}_dog`]} · {room[`${n}_rarity`]}</div>
                  </div>
                  <div style={{ marginLeft: 'auto', fontSize: 18 }}>✅</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <button onClick={handleStartRace} disabled={!canStart} style={{ width: '100%', padding: '16px 0', background: canStart ? 'linear-gradient(135deg,#06d6a0,#059e76)' : '#ddd', color: canStart ? 'white' : '#aaa', border: 'none', borderRadius: 16, fontSize: 17, fontWeight: 'bold', cursor: canStart ? 'pointer' : 'default', boxShadow: canStart ? '0 6px 20px rgba(6,214,160,0.4)' : 'none', marginBottom: 10 }}>
          {canStart ? '🏁 Start Race!' : `Need ${2 - playerSlots.length} more player${2 - playerSlots.length !== 1 ? 's' : ''}`}
        </button>
        {!confirmDeleteRoom ? (
          <button onClick={() => setConfirmDeleteRoom(true)} style={{ width: '100%', padding: '12px 0', background: 'white', color: '#e53e3e', border: '2px solid #feb2b2', borderRadius: 14, fontSize: 14, fontWeight: 'bold', cursor: 'pointer', marginBottom: 10 }}>
            🗑️ Delete Room
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button onClick={() => setConfirmDeleteRoom(false)} style={{ flex: 1, padding: '12px 0', background: '#eee', border: 'none', borderRadius: 14, fontSize: 14, fontWeight: 'bold', cursor: 'pointer' }}>Cancel</button>
            <button onClick={async () => { setConfirmDeleteRoom(false); await deleteRaceRoom(raceId); resetAll(); }} style={{ flex: 1, padding: '12px 0', background: '#e53e3e', color: 'white', border: 'none', borderRadius: 14, fontSize: 14, fontWeight: 'bold', cursor: 'pointer' }}>Yes, Delete</button>
          </div>
        )}
        <p style={{ textAlign: 'center', color: '#aaa', fontSize: 12, margin: 0 }}>You're entered as a racer — tap as fast as you can when it starts! 🐾</p>
      </div>
    );
  }

  if (screen === 'join_browse') {
    return (
      <div style={{ padding: 16 }}>
        {toast && <div style={{ position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', background: '#764ba2', color: 'white', borderRadius: 20, padding: '10px 20px', fontWeight: 'bold', fontSize: 14, zIndex: 999, whiteSpace: 'nowrap' }}>{toast}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <button onClick={resetAll} style={{ background: '#eee', border: 'none', borderRadius: 10, padding: '6px 12px', cursor: 'pointer', fontWeight: 'bold' }}>←</button>
          <h2 style={{ margin: 0, fontSize: 18, color: '#333' }}>🐾 Open Races</h2>
          <button onClick={loadBrowse} style={{ marginLeft: 'auto', background: '#e8f4fd', border: 'none', borderRadius: 10, padding: '6px 12px', cursor: 'pointer', fontSize: 13 }}>↻ Refresh</button>
        </div>
        {browseError && <div style={{ background: '#fff5f5', border: '2px solid #fca5a5', borderRadius: 12, padding: 12, marginBottom: 14, fontSize: 13, color: '#c62828' }}>{browseError}</div>}
        {joinTarget ? (
          <div>
            {selectedDog ? (
              <div style={{ background: 'white', borderRadius: 16, padding: 14, marginBottom: 14, border: `2px solid ${RARITY_COLORS[selectedDog.rarity]}`, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
                <p style={{ fontWeight: 'bold', color: '#333', marginBottom: 10, fontSize: 14 }}>
                  Joining <b>{joinTarget.host_username}</b>'s race with:
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  {selectedDog.photo_url
                    ? <img src={dogImageSrc(selectedDog)} alt={selectedDog.name} style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', border: `3px solid ${RARITY_COLORS[selectedDog.rarity]}` }} onError={e => e.target.style.display='none'} />
                    : <div style={{ width: 48, height: 48, borderRadius: '50%', background: RARITY_COLORS[selectedDog.rarity] + '33', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>🐱</div>
                  }
                  <div>
                    <div style={{ fontWeight: 'bold', fontSize: 15 }}>{getDogNick(selectedDog.id) || selectedDog.name}</div>
                    <div style={{ fontSize: 12, color: '#888' }}>{selectedDog.breed}</div>
                    <div style={{ fontSize: 11, color: RARITY_COLORS[selectedDog.rarity], fontWeight: 'bold' }}>{selectedDog.rarity}</div>
                  </div>
                </div>
                <button onClick={() => handleJoin(joinTarget, selectedDog)} style={{ width: '100%', padding: '12px 0', background: 'linear-gradient(135deg,#f72585,#b5179e)', color: 'white', border: 'none', borderRadius: 14, fontWeight: 'bold', fontSize: 15, cursor: 'pointer' }}>
                  Enter Race 🏁
                </button>
              </div>
            ) : (
              <div>
                <p style={{ fontWeight: 'bold', color: '#333', marginBottom: 10 }}>Pick your cat to join <b>{joinTarget.host_username}</b>'s race:</p>
                <DogPicker
                  dogs={dogs}
                  onPick={dog => handleJoin(joinTarget, dog)}
                  subtitle=""
                  accentGradient="linear-gradient(135deg,#f72585,#b5179e)"
                  buttonLabel="Enter Race 🏁"
                />
              </div>
            )}
            <button onClick={() => setJoinTarget(null)} style={{ marginTop: 8, width: '100%', padding: 12, background: '#eee', border: 'none', borderRadius: 12, cursor: 'pointer', fontWeight: 'bold' }}>← Back</button>
          </div>
        ) : (
          openRooms.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40 }}>
              <div style={{ fontSize: 48, marginBottom: 10 }}>🏜️</div>
              <div style={{ fontWeight: 'bold', color: '#666', marginBottom: 6 }}>No open races right now</div>
              <div style={{ color: '#aaa', fontSize: 13, marginBottom: 20 }}>Host one yourself or check back soon!</div>
              <button onClick={() => goScreen('host_pick_dog')} style={{ padding: '14px 28px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: 'white', border: 'none', borderRadius: 14, fontWeight: 'bold', cursor: 'pointer' }}>🏟️ Host a Race</button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {openRooms.map(r => {
                const slots = ['p1','p2','p3','p4'].filter(n => r[`${n}_id`]);
                const isFull = slots.length >= 4;
                return (
                  <div key={r.id} style={{ background: 'white', borderRadius: 16, padding: '12px 14px', border: '2px solid #f72585', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div>
                        <div style={{ fontWeight: 'bold', color: '#333', fontSize: 14 }}>🏟️ {r.host_username}'s Race</div>
                        <div style={{ fontSize: 12, color: '#888' }}>{slots.length} / 4 racers · {r.status === 'racing' ? '🔴 Racing now' : '🟡 Waiting to start'}</div>
                      </div>
                      {!isFull && r.status === 'lobby' && (
                        <button onClick={() => setJoinTarget(r)} style={{ background: 'linear-gradient(135deg,#f72585,#b5179e)', color: 'white', border: 'none', borderRadius: 12, padding: '8px 16px', fontWeight: 'bold', fontSize: 13, cursor: 'pointer' }}>Join!</button>
                      )}
                      {(isFull || r.status === 'racing') && (
                        <span style={{ fontSize: 12, color: '#aaa', background: '#f5f5f5', borderRadius: 10, padding: '6px 10px' }}>{isFull ? 'Full' : 'In progress'}</span>
                      )}
                    </div>
                    {slots.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {slots.map((n, i) => (
                          <div key={n} style={{ background: LANE_COLORS[i] + '22', border: `1px solid ${LANE_COLORS[i]}`, borderRadius: 20, padding: '2px 10px', fontSize: 12, color: '#333' }}>
                            🐱 {r[`${n}_dog`]}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>
    );
  }

  if (screen === 'waiting') {
    const slots = room ? ['p1','p2','p3','p4'].filter(n => room[`${n}_id`]) : [];
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        {toast && <div style={{ position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', background: '#764ba2', color: 'white', borderRadius: 20, padding: '10px 20px', fontWeight: 'bold', fontSize: 14, zIndex: 999, whiteSpace: 'nowrap' }}>{toast}</div>}
        <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
        <div style={{ fontSize: 52, marginBottom: 12, animation: 'spin 2s linear infinite', display: 'inline-block' }}>🏟️</div>
        <div style={{ fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 6 }}>You're in! Waiting for host to start…</div>
        <div style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>🐱 {selectedDog?.name} · {selectedDog?.rarity}</div>
        <div style={{ background: 'white', borderRadius: 14, padding: 14, marginBottom: 20, boxShadow: '0 2px 8px rgba(0,0,0,0.06)', textAlign: 'left' }}>
          <div style={{ fontWeight: 'bold', fontSize: 13, color: '#555', marginBottom: 8 }}>Racers ({slots.length}):</div>
          {slots.map((n, i) => (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: LANE_COLORS[i] }} />
              <span style={{ fontSize: 13, color: n === mySlot ? '#764ba2' : '#333', fontWeight: n === mySlot ? 'bold' : 'normal' }}>{room[`${n}_username`]} · {room[`${n}_dog`]} {n === mySlot ? '(you)' : ''}</span>
            </div>
          ))}
        </div>
        <button onClick={resetAll} style={{ padding: '10px 24px', background: '#eee', border: 'none', borderRadius: 12, cursor: 'pointer', fontWeight: 'bold', color: '#666' }}>Leave</button>
      </div>
    );
  }

  if (screen === 'racing') {
    const isCountingDown = countdown !== null;
    const cdColor = countdown === 'GO! 🏁' ? '#06d6a0' : '#ffd700';
    return (
      <RaceWithEmoji
        room={room} mySlot={mySlot} isCountingDown={isCountingDown} cdColor={cdColor}
        countdown={countdown} toast={toast} finishedRef={finishedRef} handleTap={handleTap}
        raceId={raceId} player={player}
      />
    );
  }

  if (screen === 'spectating') {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontWeight: 'bold', color: '#333', fontSize: 16 }}>👀 Spectating</span>
          {isHost && room?.status === 'lobby' && <span style={{ fontSize: 12, color: '#888' }}>Race not started yet…</span>}
          {room?.status === 'racing' && <span style={{ background: '#ff4444', color: 'white', borderRadius: 10, padding: '3px 10px', fontSize: 12, fontWeight: 'bold' }}>🔴 LIVE</span>}
        </div>
        {room && <RaceTrack room={room} mySlot={null} />}
        {finishOrder.length > 0 && (
          <div style={{ background: 'white', borderRadius: 14, padding: 14, marginTop: 14, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
            <div style={{ fontWeight: 'bold', color: '#333', marginBottom: 8 }}>🏁 Finish Order</div>
            {finishOrder.map((n, i) => (
              <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
                <span style={{ fontSize: 20 }}>{['🥇','🥈','🥉','4️⃣'][i]}</span>
                <span style={{ fontWeight: 'bold', color: '#333' }}>{room[`${n}_username`]}</span>
                <span style={{ color: '#888', fontSize: 12 }}>· {room[`${n}_dog`]}</span>
                <span style={{ marginLeft: 'auto', color: '#f4a261', fontWeight: 'bold' }}>+{PLACE_PTS[i]}pts</span>
              </div>
            ))}
          </div>
        )}
        {room?.status === 'finished' && (
          <button onClick={resetAll} style={{ width: '100%', marginTop: 14, padding: '14px 0', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: 'white', border: 'none', borderRadius: 16, fontSize: 16, fontWeight: 'bold', cursor: 'pointer' }}>Done</button>
        )}
      </div>
    );
  }

  if (screen === 'result') {
    const place = result?.place ?? -1;
    const won = place === 0;
    // Elite races pay DD directly from ELITE_DD_PLACE; normal races use DD_PLACE
    const raceDDAmount = eliteMode
      ? (place >= 0 && place < ELITE_DD_PLACE.length ? ELITE_DD_PLACE[place] : 0)
      : (place >= 0 && place < DD_PLACE.length ? DD_PLACE[place] : (result?.pts ? Math.max(1, Math.floor(result.pts / 20)) : 0));
    // Auto-pay Elite DD once (no pts/DD choice for Elite). Use a lazy initialiser
    // to fire on the first render of the result screen without breaking hook rules.
    if (eliteMode && place >= 0 && raceDDAmount > 0 && racePaidInDD === false) {
      // setTimeout(0) defers the state update out of render, avoiding the
      // "setState during render" warning while still firing immediately.
      setTimeout(() => { addDD(raceDDAmount); setRacePaidInDD('dd'); }, 0);
    }
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        {eliteMode && (
          <div style={{ background: 'linear-gradient(135deg,#1a0533,#2d1b69)', borderRadius: 14, padding: '8px 14px', marginBottom: 12, border: '2px solid #f7b731', display: 'inline-block' }}>
            <span style={{ color: '#ffd700', fontWeight: 'bold', fontSize: 13 }}>🏆 ELITE RACE</span>
          </div>
        )}
        <div style={{ fontSize: 72, marginBottom: 12 }}>{won ? '🏆' : place === 1 ? '🥈' : place === 2 ? '🥉' : result?.isSpectator ? '👀' : '🐾'}</div>
        <div style={{ fontSize: 24, fontWeight: 'bold', color: won ? '#06d6a0' : '#764ba2', marginBottom: 6 }}>
          {result?.isSpectator ? 'Race Over!' : place >= 0 ? PLACE_LABELS[place] : 'Race finished!'}
        </div>
        {result?.ghostMode && (() => {
          const beatGhost = result.order && result.order.indexOf('p1') < result.order.indexOf('p2');
          if (beatGhost && !racePaidInDD) {
            // Pay the ghost-win bonus immediately (only once).
            // Use a separate flag so the pts/DD choice below still shows.
            addDD(15);
            setRacePaidInDD('ghost_bonus_paid');
          }
          return (
            <div style={{ borderRadius: 14, padding: '12px 16px', marginBottom: 10, fontWeight: 'bold', fontSize: 14,
              background: beatGhost ? 'linear-gradient(135deg,#d4edda,#a8d5b5)' : 'linear-gradient(135deg,#f8d7da,#f5a9af)',
              color: beatGhost ? '#155724' : '#721c24',
            }}>
              {beatGhost
                ? <>👻 You beat your Ghost! New record! 🎉<br /><span style={{ fontSize: 16 }}>+15 🪙 Kitty Coins!</span></>
                : '👻 Your Ghost beat you — try again!'}
            </div>
          );
        })()}
        {/* Elite race: show auto-paid DD reward */}
        {eliteMode && place >= 0 && raceDDAmount > 0 && (
          <div style={{ background: 'linear-gradient(135deg,#fff9e6,#fff3cd)', borderRadius: 16, padding: 14, marginBottom: 12, border: '2px solid #f7b731' }}>
            <div style={{ fontSize: 22, fontWeight: 'bold', color: '#e65100' }}>+{raceDDAmount} 🪙 Kitty Coins!</div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>Elite Race prize paid automatically</div>
          </div>
        )}
        {/* Normal race: pts/DD choice */}
        {!eliteMode && result?.pts > 0 && (!racePaidInDD || racePaidInDD === 'ghost_bonus_paid') && (
          <div style={{ background:'#fff8f0', borderRadius:16, padding:14, marginBottom:12, border:'2px solid #f4a261' }}>
            <div style={{ fontSize:14, color:'#888', marginBottom:8 }}>Choose your reward:</div>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={() => { addBonusPts(result.pts); try { localStorage.setItem('km_race_pts', (parseInt(localStorage.getItem('km_race_pts')||'0',10)+result.pts).toString()); } catch {} setRacePaidInDD('pts'); }} style={{ flex:1, padding:'10px 6px', background:'linear-gradient(135deg,#f4a261,#e76f51)', color:'white', border:'none', borderRadius:12, fontSize:13, fontWeight:'bold', cursor:'pointer' }}>
                ⭐ {result.pts} Points
              </button>
              <button onClick={() => { addDD(raceDDAmount); setRacePaidInDD('dd'); }} style={{ flex:1, padding:'10px 6px', background:'linear-gradient(135deg,#667eea,#764ba2)', color:'white', border:'none', borderRadius:12, fontSize:13, fontWeight:'bold', cursor:'pointer' }}>
                🐱 {raceDDAmount} Kitty Coins
              </button>
            </div>
          </div>
        )}
        {!eliteMode && racePaidInDD === 'pts' && <div style={{ fontSize: 18, fontWeight: 'bold', color: '#f4a261', marginBottom: 4 }}>+{result.pts} pts ⭐</div>}
        {!eliteMode && racePaidInDD === 'dd' && <div style={{ fontSize: 18, fontWeight: 'bold', color: '#764ba2', marginBottom: 4 }}>+{raceDDAmount} <DDIcon size={18} /> Kitty Coins!</div>}
        <div style={{ background: 'linear-gradient(135deg,#667eea22,#764ba222)', borderRadius: 10, padding: '6px 14px', display: 'inline-block', marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 'bold', color: '#fff' }}>🐱 Kitty Coins balance: {dd}</span>
        </div>
        <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Race Wins: 🏁 {localStorage.getItem('km_race_wins') || 0}</div>
        {(room || aiRoom) && result?.order?.length > 0 && (
          <div style={{ background: 'white', borderRadius: 14, padding: 14, marginBottom: 20, textAlign: 'left', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
            {result.order.map((n, i) => {
              const isMe = n === mySlot;
              let rewardLabel;
              if (eliteMode) {
                // Elite races: show DD prizes for all places, no pts
                const elitePrize = ELITE_DD_PLACE[i] || 0;
                rewardLabel = <span style={{ marginLeft: 'auto', color: '#e65100', fontWeight: 'bold', fontSize: 13 }}>+{elitePrize} 🪙</span>;
              } else if (isMe && racePaidInDD === 'dd') {
                rewardLabel = <span style={{ marginLeft: 'auto', color: '#764ba2', fontWeight: 'bold', fontSize: 13 }}>+{raceDDAmount} 🪙</span>;
              } else if (isMe && racePaidInDD === 'pts') {
                rewardLabel = <span style={{ marginLeft: 'auto', color: '#f4a261', fontWeight: 'bold', fontSize: 13 }}>+{PLACE_PTS[i]}pts ⭐</span>;
              } else {
                rewardLabel = <span style={{ marginLeft: 'auto', color: '#f4a261', fontWeight: 'bold', fontSize: 13 }}>+{PLACE_PTS[i]}pts</span>;
              }
              return (
                <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
                  <span style={{ fontSize: 20 }}>{['🥇','🥈','🥉','4️⃣'][i]}</span>
                  <span style={{ fontWeight: isMe ? 'bold' : 'normal', color: isMe ? '#764ba2' : '#333' }}>{(room || aiRoom)[`${n}_username`]}</span>
                  {rewardLabel}
                </div>
              );
            })}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {result?.aiMode ? (<>
            <button onClick={() => { const d = selectedDog; resetAll(); setTimeout(() => d ? startAiRace(d, false) : goScreen('ai_pick_dog'), 50); }} style={{ padding: '14px 0', background: 'linear-gradient(135deg,#06d6a0,#059e76)', color: 'white', border: 'none', borderRadius: 14, fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}>🤖 Race Again vs AI</button>
            {selectedDog && getGhost(selectedDog.id) && (
              <button onClick={() => { const d = selectedDog; resetAll(); setTimeout(() => startAiRace(d, true), 50); }} style={{ padding: '14px 0', background: 'linear-gradient(135deg,#764ba2,#667eea)', color: 'white', border: 'none', borderRadius: 14, fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}>👻 Race Your Ghost Again</button>
            )}
          </>) : eliteMode ? (<>
            <button onClick={() => { const d = selectedDog; resetAll(); setTimeout(() => { if (d) { setEliteMode(true); handleCreateRoom(d); } else goScreen('home'); }, 50); }} style={{ padding: '14px 0', background: 'linear-gradient(135deg,#f7b731,#e65100)', color: 'white', border: 'none', borderRadius: 14, fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}>🏆 Host Another Elite Race</button>
            <button onClick={() => { resetAll(); setTimeout(() => { setEliteMode(true); goScreen('elite_browse'); loadBrowse(); }, 50); }} style={{ padding: '14px 0', background: 'linear-gradient(135deg,#b5179e,#7b2ff7)', color: 'white', border: 'none', borderRadius: 14, fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}>🏆 Join an Elite Race</button>
          </>) : (<>
            <button onClick={() => { const d = selectedDog; resetAll(); setTimeout(() => d ? handleCreateRoom(d) : goScreen('home'), 50); }} style={{ padding: '14px 0', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: 'white', border: 'none', borderRadius: 14, fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}>🏟️ Host Another Race</button>
            <button onClick={() => { resetAll(); goScreen('join_browse'); loadBrowse(); }} style={{ padding: '14px 0', background: 'linear-gradient(135deg,#f72585,#b5179e)', color: 'white', border: 'none', borderRadius: 14, fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}>🐾 Join a Multiplayer Race</button>
          </>)}
          <button onClick={() => resetAll()} style={{ padding: '10px 0', background: '#eee', color: '#555', border: 'none', borderRadius: 14, fontSize: 14, fontWeight: 'bold', cursor: 'pointer' }}>🏠 Back to Race Menu</button>
        </div>
      </div>
    );
  }

  return null;
}

// ─── Tasks Screen ─────────────────────────────────────────────────────────────
const POWERUPS = [
  { id: 'lucky_collar',    label: '🍀 Lucky Collar',         desc: 'Double catch points for 10 minutes',         cost: 5,   duration: 600 },
  { id: 'speedy_paws',     label: '⚡ Speedy Paws',           desc: 'Slow down Rare/Epic cats for 5 minutes',     cost: 8,   duration: 300 },
  { id: 'lightning_post',  label: '🌩️ Lightning Post',        desc: 'Slow down Legendary cats for 5 minutes',     cost: 15,  duration: 300 },
  { id: 'xp_potion',       label: '✨ XP Potion',             desc: '+100 XP to your highest level cat',          cost: 3,   duration: 0   },
  { id: 'treat_common',    label: '🐟 Treat Bag',             desc: 'Feed all your Common cats',                  cost: 2,   duration: 0, rarity: 'Common'    },
  { id: 'treat_uncommon',  label: '🐟 Large Treat Bag',       desc: 'Feed all your Uncommon cats',                cost: 10,  duration: 0, rarity: 'Uncommon'  },
  { id: 'treat_rare',      label: '🐟 Xtra Large Treat Bag',  desc: 'Feed all your Rare cats',                    cost: 30,  duration: 0, rarity: 'Rare'      },
  { id: 'treat_epic',      label: '🐟 Super Treat Bag',       desc: 'Feed all your Epic cats',                    cost: 75,  duration: 0, rarity: 'Epic'      },
  { id: 'treat_legendary', label: '🐟 Mega Treat Bag',        desc: 'Feed all your Legendary cats',               cost: 150, duration: 0, rarity: 'Legendary' },
  { id: 'treat_ultra',     label: '🍖 Ultra Treat Bag',       desc: 'Feed EVERY cat you own at once, any rarity', cost: 200, duration: 0, rarity: 'All'       },
  { id: 'pooper_scooper',  label: '🪣 Litter Scooper',        desc: 'Clean all litter trays at once & earn the points', cost: 50,  duration: 0 },
  { id: 'legendary_bait',  label: '🌟 Legendary Bait',        desc: 'Much higher chance of a Legendary cat for 5 minutes', cost: 30, duration: 300 },
];

function TasksScreen({ dogs }) {
  const { challenges, dateStr } = getDailyChallenges();
  const key = `km_daily_${dateStr}`;
  let prog = {};
  try { prog = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
  const dd = useLive(getDD, 'km_dd_change');
  const [toast, setToast] = useState('');
  const [popupMsg, setPopupMsg] = useState('');
  const [activeBoosts, setActiveBoosts] = useState(() => {
    try { return JSON.parse(localStorage.getItem('km_boosts') || '{}'); } catch { return {}; }
  });
  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 2500); };
  // For purchase results — needs to be actively dismissed so it can't be missed like a fading toast.
  const showPopup = (m) => { haptic('success'); setPopupMsg(m); };

  const buyPowerup = (p) => {
    if (dd < p.cost) { showToast(`Need ${p.cost}${DD}! Win races to earn Kitty Coins.`); return; }
    addDD(-p.cost);
    if (p.duration > 0) {
      const expires = Date.now() + p.duration * 1000;
      const boosts = { ...activeBoosts, [p.id]: expires };
      setActiveBoosts(boosts);
      localStorage.setItem('km_boosts', JSON.stringify(boosts));
      showPopup(`${p.label} activated!`);
    } else if (p.id === 'pooper_scooper') {
      const now = Date.now();
      // A dog has poo if: never fed (lastFed=0) OR fed more than 4h ago AND poo not yet collected since last feed
      const targets = (dogs || []).filter(dog => {
        const ds = getDogState(dog.id);
        const lastFed = ds.lastFed || 0;
        const lastPoo = ds.lastPoo || 0;
        const hoursSinceFed = (now - lastFed) / 3600000;
        if (lastFed === 0) return lastPoo === 0; // never fed — one default poo, gone once collected
        return hoursSinceFed > 4 && lastPoo < lastFed;  // fed, poo not collected since
      });
      if (targets.length === 0) { showToast('No litter to clean right now!'); addDD(p.cost); logPurchase(p.label, p.cost, 'returned: nothing to collect'); return; }
      let totalPts = 0;
      const failedLocal = runBulk(() => targets.forEach(dog => {
        const rarity = rollPooRarity();
        const s = getDogState(dog.id); s.lastPoo = now; saveDogState(dog.id, s);
        try { localStorage.setItem('km_poo_count', (parseInt(localStorage.getItem('km_poo_count')||'0')+1).toString()); } catch {}
        recordChallenge('poo');
        addStarXP('poo');
        totalPts += rarity.pts;
      }));
      if (failedLocal > 0) { addDD(p.cost); logPurchase(p.label, p.cost, 'returned: phone storage full'); showPopup(`⚠️ ${p.label} could not update ${failedLocal} cats because the game's saved-data space on this phone is full. Your ${p.cost} Kitty Coins were returned.`); return; }
      logPurchase(p.label, p.cost, `applied to ${targets.length} cats`);
      addBonusPts(totalPts);
      showPopup(`${p.label} cleaned ${targets.length} litter tray${targets.length>1?'s':''}! +${totalPts}⭐ earned`);
    } else if (p.id === 'xp_potion') {
      const best = (dogs || []).reduce((b, d) => { const s = getDogState(d.id); return (!b || (s.level||1) > (b.lvl||1)) ? {id:d.id, name:d.name, lvl:(s.level||1)} : b; }, null);
      if (best) { const s = getDogState(best.id); s.xp = (s.xp||0) + 100; saveDogState(best.id, s); showPopup(`${p.label} gave +100 XP to ${best.name}!`); }
      else showToast('No cats to give XP to!');
    } else if (p.rarity) {
      const targets = p.rarity === 'All' ? (dogs || []) : (dogs || []).filter(d => d.rarity === p.rarity);
      if (targets.length === 0) { showToast(p.rarity === 'All' ? 'No cats to feed!' : `No ${p.rarity} cats to feed!`); addDD(p.cost); return; }
      const failedLocal = runBulk(() => targets.forEach(d => { const s = getDogState(d.id); s.hunger = 100; s.lastFed = Date.now(); saveDogState(d.id, s); }));
      if (failedLocal > 0) { addDD(p.cost); logPurchase(p.label, p.cost, 'returned: phone storage full'); showPopup(`⚠️ ${p.label} could not update ${failedLocal} cats because the game's saved-data space on this phone is full. Your ${p.cost} Kitty Coins were returned.`); return; }
      logPurchase(p.label, p.cost, `applied to ${targets.length} cats`);
      showPopup(p.rarity === 'All' ? `${p.label} has fed all your cats!` : `${p.label} has fed all your ${p.rarity} cats!`);
    } else {
      showPopup(`${p.label} activated!`);
    }
  };

  const isActive = (p) => {
    if (!p.duration) return false;
    return activeBoosts[p.id] && activeBoosts[p.id] > Date.now();
  };

  return (
    <div style={{ padding: 16 }}>
      {toast && <div style={{ position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', background: '#764ba2', color: 'white', borderRadius: 20, padding: '10px 20px', fontWeight: 'bold', fontSize: 14, zIndex: 999, whiteSpace: 'nowrap', boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>{toast}</div>}
      <h2 style={{ margin: '0 0 4px', color: '#333', textAlign: 'center' }}>🎯 Daily Tasks</h2>
      <p style={{ margin: '0 0 16px', color: '#888', fontSize: 13, textAlign: 'center' }}>Resets every day. Catch cats to progress!</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        {challenges.map(c => {
          const count = Math.min(prog[c.id] || 0, c.goal);
          const done = count >= c.goal;
          const pct = Math.round((count / c.goal) * 100);
          return (
            <div key={c.id} style={{ background: done ? '#d4edda' : 'white', border: `2px solid ${done ? '#28a745' : '#c39bd3'}`, borderRadius: 16, padding: 16, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontWeight: 'bold', fontSize: 15, color: '#333' }}>{done ? '✅' : '🎯'} {c.text}</div>
                <div style={{ fontWeight: 'bold', color: '#764ba2', fontSize: 14 }}>+{c.pts}pts</div>
              </div>
              <div style={{ background: '#eee', borderRadius: 8, height: 8, overflow: 'hidden', marginBottom: 4 }}>
                <div style={{ background: done ? '#28a745' : '#764ba2', width: `${pct}%`, height: '100%', borderRadius: 8, transition: 'width 0.3s' }} />
              </div>
              <div style={{ fontSize: 12, color: '#888' }}>{count} / {c.goal} · {pct}%</div>
            </div>
          );
        })}
      </div>
      {/* Power-up Shop */}
      <div style={{ borderRadius: 16, overflow: 'hidden', border: '2px solid #ffd700', background: 'linear-gradient(135deg, #fff8e7, #fff3cd)' }}>
        <div style={{ background: 'linear-gradient(135deg,#f4a261,#e76f51)', color: 'white', padding: '12px 16px', fontWeight: 'bold', fontSize: 15 }}>
          🛒 Power-Up Shop · <span style={{ fontWeight: 'normal', fontSize: 13, color: '#f4a261' }}><DDIcon size={14} />{dd} Kitty Coins</span>
        </div>
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {POWERUPS.map(p => {
            const active = isActive(p);
            return (
              <div key={p.id} style={{ background: active ? '#d4edda' : 'white', borderRadius: 12, padding: 12, display: 'flex', alignItems: 'center', gap: 12, border: `2px solid ${active ? '#28a745' : '#eee'}` }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 'bold', fontSize: 14, color: '#333' }}>{p.label}</div>
                  <div style={{ fontSize: 12, color: '#666' }}>{p.desc}</div>
                  {active && <div style={{ fontSize: 11, color: '#28a745', fontWeight: 'bold', marginTop: 2 }}>✅ Active!</div>}
                </div>
                <button onClick={() => buyPowerup(p)} disabled={active || dd < p.cost} style={{ padding: '8px 14px', background: active ? '#28a745' : dd >= p.cost ? 'linear-gradient(135deg,#f4a261,#e76f51)' : '#ccc', color: 'white', border: 'none', borderRadius: 12, fontWeight: 'bold', fontSize: 13, cursor: active || dd < p.cost ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
                  {active ? '✓' : <><DDIcon size={13} />{p.cost}</>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {popupMsg && <AlertPopup message={popupMsg} onClose={() => setPopupMsg('')} />}
    </div>
  );
}

// ─── Catch Screen ─────────────────────────────────────────────────────────────
// Physics config per rarity: velocity (% per tick), tick ms, disappear seconds, size px
const CATCH_CFG = {
  Common:    { vx: 0,    vy: 0,    tick: 2200, jitter: true,  time: null, size: 115 },
  Uncommon:  { vx: 0,    vy: 0,    tick: 1200, jitter: true,  time: 20,   size: 110 },
  Rare:      { vx: 1.4,  vy: 1.1,  tick: 40,   jitter: false, time: 14,   size: 100 },
  Epic:      { vx: 2.8,  vy: 2.2,  tick: 30,   jitter: false, time: 9,    size: 88  },
  Legendary: { vx: 2.2,  vy: 1.8,  tick: 30,   jitter: false, time: 12,   size: 70  },
};

function CatchScreen({ player, dogs, onCatch }) {
  const [breed, setBreed] = useState(null);
  const [pos, setPos] = useState({ x: 50, y: 50 });
  const [caught, setCaught] = useState(false);
  const [catching, setCatching] = useState(false);
  const [zone, setZone] = useState(null);
  const [locating, setLocating] = useState(false);
  const [dogScale, setDogScale] = useState(1);
  const [wobble, setWobble] = useState(false);
  const intervalRef = useRef(null);
  const catchingRef = useRef(false);
  const wobbleRef = useRef(null);
  const velRef = useRef({ vx: 1, vy: 0.8 });
  const posRef = useRef({ x: 50, y: 50 });
  const [achievementToast, setAchievementToast] = useState(null);
  const [catchFlash, setCatchFlash] = useState(null);
  const [caughtGender, setCaughtGender] = useState(null);
  const [timeLeft, setTimeLeft] = useState(null);
  const disappearRef = useRef(null);
  const countdownRef = useRef(null);
  const [showMysteryBox, setShowMysteryBox] = useState(false);
  const [showShareGate, setShowShareGate] = useState(false);
  const [lastCaughtBreed, setLastCaughtBreed] = useState(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const [combo, setCombo] = useState(0);
  const [showCombo, setShowCombo] = useState(false);
  const comboTimerRef = useRef(null);

  const [photoUrl, setPhotoUrl] = useState(null);
  const [treat, setTreat] = useState(0); // 0 = unused, 1 = cat is sniffing the treat, 2 = used
  const treatTimerRef = useRef(null);

  const stopAll = useCallback(() => {
    clearInterval(intervalRef.current);
    clearInterval(wobbleRef.current);
    clearInterval(countdownRef.current);
    clearTimeout(disappearRef.current);
  }, []);

  const throwTreat = () => {
    if (treat !== 0 || caught || !breed) return;
    setTreat(1);
    try { playPurr(); } catch {}
    clearTimeout(treatTimerRef.current);
    treatTimerRef.current = setTimeout(() => setTreat(2), 4000);
  };

  const spawnDog = useCallback(async (currentZone) => {
    stopAll();
    catchingRef.current = false;
    setCaught(false); setCatching(false); setDogScale(1); setPhotoUrl(null); setTimeLeft(null); clearTimeout(treatTimerRef.current); setTreat(0);
    const b = currentZone ? getBreedForZone(currentZone) : getRandomBreed();
    setBreed(b);
    const startPos = { x: 15 + Math.random() * 65, y: 15 + Math.random() * 60 };
    posRef.current = startPos;
    setPos(startPos);
    const cfg = CATCH_CFG[b.rarity] || CATCH_CFG.Common;
    // Speedy Paws boost: slow Rare/Epic/Legendary dogs by 50%
    const speedBoosts = (() => { try { return JSON.parse(localStorage.getItem('km_boosts') || '{}'); } catch { return {}; } })();
    const speedMult = (
      (speedBoosts.speedy_paws && Date.now() < speedBoosts.speedy_paws && ['Rare','Epic'].includes(b.rarity)) ||
      (speedBoosts.lightning_post && Date.now() < speedBoosts.lightning_post && b.rarity === 'Legendary')
    ) ? 0.5 : 1;
    // Random initial direction
    const angle = Math.random() * Math.PI * 2;
    velRef.current = { vx: Math.cos(angle) * cfg.vx * speedMult, vy: Math.sin(angle) * cfg.vy * speedMult };
    // Fetch photo in background — dog starts moving immediately, photo streams in
    fetchBreedPhoto(b).then(url => { if (url) setPhotoUrl(url); });
    // Pre-fetch next 2 dogs' photos while this dog is being chased, so next spawn is instant
    setTimeout(() => {
      for (let i = 0; i < 2; i++) {
        const next = getRandomBreed();
        fetchBreedPhoto(next).catch(() => {});
      }
    }, 800);
  }, [stopAll]);

  // Pre-warm photo cache on first mount — fetch 8 random breeds in background
  // so the first few dogs appear instantly even on slow connections
  useEffect(() => {
    const breeds = [];
    const seen = new Set();
    while (breeds.length < 8) {
      const b = getRandomBreed();
      if (!seen.has(b.api)) { seen.add(b.api); breeds.push(b); }
    }
    // Stagger fetches to avoid hammering thecatapi.com all at once
    breeds.forEach((b, i) => {
      setTimeout(() => fetchBreedPhoto(b).catch(() => {}), i * 300);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { spawnDog(null); }, [spawnDog]);

  useEffect(() => {
    if (!breed || caught) return;
    const cfg = CATCH_CFG[breed.rarity] || CATCH_CFG.Common;

    if (treat === 1) {
      // Treat lure: the cat stops to sniff the fish treat, easy to tap
      wobbleRef.current = setInterval(() => setWobble(w => !w), 350);
    } else if (cfg.jitter) {
      // Simple random jump movement for Common/Uncommon
      intervalRef.current = setInterval(() => {
        const p = { x: 10 + Math.random() * 75, y: 10 + Math.random() * 72 };
        posRef.current = p; setPos(p);
      }, cfg.tick);
      wobbleRef.current = setInterval(() => setWobble(w => !w), cfg.tick * 0.4);
    } else {
      // Physics bounce: update position by velocity, reverse on wall hit
      intervalRef.current = setInterval(() => {
        const p = posRef.current;
        let { vx, vy } = velRef.current;
        let nx = p.x + vx;
        let ny = p.y + vy;
        // Bounce off walls (5%–90% x, 5%–88% y to stay in arena)
        if (nx < 5  || nx > 90) { vx = -vx; nx = Math.max(5,  Math.min(90, nx)); }
        if (ny < 5  || ny > 88) { vy = -vy; ny = Math.max(5,  Math.min(88, ny)); }
        // Occasionally add a random kick to keep it unpredictable
        if (Math.random() < 0.06) { vx += (Math.random() - 0.5) * cfg.vx * 0.8; vy += (Math.random() - 0.5) * cfg.vy * 0.8; }
        // Clamp max speed
        const maxV = cfg.vx * 1.6;
        if (Math.abs(vx) > maxV) vx = Math.sign(vx) * maxV;
        if (Math.abs(vy) > maxV) vy = Math.sign(vy) * maxV;
        velRef.current = { vx, vy };
        posRef.current = { x: nx, y: ny };
        setPos({ x: nx, y: ny });
      }, cfg.tick);
      wobbleRef.current = setInterval(() => setWobble(w => !w), Math.max(80, cfg.tick * 3));
    }

    // Disappear countdown
    const secs = cfg.time;
    if (secs) {
      setTimeLeft(secs);
      countdownRef.current = setInterval(() => setTimeLeft(t => {
        if (t <= 1) { clearInterval(countdownRef.current); return 0; }
        return t - 1;
      }), 1000);
      disappearRef.current = setTimeout(() => spawnDog(zone), secs * 1000);
    }

    return stopAll;
  }, [breed, caught, stopAll, treat === 1]);

  const requestGPS = () => {
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const z = await detectZone(position.coords.latitude, position.coords.longitude);
        setZone(z); setLocating(false); spawnDog(z);
      },
      () => { setLocating(false); spawnDog(null); },
      { timeout: 8000 }
    );
  };

  const handleCatch = async () => {
    if (caught || catchingRef.current || !breed) return;
    catchingRef.current = true;
    stopAll(); clearTimeout(treatTimerRef.current); setTimeLeft(null);
    setCatching(true);
    setDogScale(1.4); setTimeout(() => setDogScale(0.8), 150); setTimeout(() => setDogScale(1.2), 300);
    playMeow(breed.name);
    haptic(breed.rarity === 'Legendary' || breed.rarity === 'Epic' ? 'heavy' : 'medium');
    const gender = Math.random() < 0.5 ? 'Male' : 'Female';
    setCaughtGender(gender);
    setLastCaughtBreed({ name: breed.name, rarity: breed.rarity, photoUrl });
    pushRecentCatch(breed.name, breed.rarity, photoUrl);
    // Combo multiplier — reset timer on each catch
    clearTimeout(comboTimerRef.current);
    setCombo(prev => {
      const c = prev + 1;
      setShowCombo(c > 1);
      if (c >= 2) {
        try { window.dispatchEvent(new CustomEvent('km_combo', { detail: { combo: c } })); } catch {}
        if (c >= 3) playSound('combo');
      }
      return c;
    });
    comboTimerRef.current = setTimeout(() => { setCombo(0); setShowCombo(false); }, 6000);
    setCaught(true); // show caught screen immediately — no delay, doesn't wait on the network save below
    // ── Sound + visual reward based on rarity ──────────────────────────────
    const newCombo = combo + 1; // updated below via setCombo
    if (breed.rarity === 'Legendary') {
      playSound('legendary');
      setCatchFlash(breed.rarity);
      setShowConfetti(true);
      setTimeout(() => setCatchFlash(null), 2500);
      fireFireworks(4000);
      setTimeout(() => fireBigWin('LEGENDARY!', breed.name, '⭐', '#ffd700', 3000, `+${points} points added`), 300);
    } else if (breed.rarity === 'Epic') {
      playSound('epic');
      setCatchFlash(breed.rarity);
      setShowConfetti(true);
      setTimeout(() => setCatchFlash(null), 2000);
      setTimeout(() => fireBigWin('EPIC CATCH!', breed.name, '💎', '#f72585', 2400, `+${points} points added`), 300);
    } else {
      playSound(newCombo >= 2 ? 'combo' : 'catch');
    }
    // Floating score popup
    if (points > 0) {
      const comboLabel = newCombo >= 2 ? ` ×${Math.min(newCombo,5)} COMBO` : '';
      fireScorePopup(`+${points} ⭐${comboLabel}`, breed.rarity === 'Legendary' ? '#ffd700' : breed.rarity === 'Epic' ? '#f72585' : '#f4a261');
    }
    recordCatch(breed.rarity);
    if (points > 0) addBonusPts(points);
    // Featured dog of the day bonus
    const featuredToday = getFeaturedDog();
    if (featuredToday && breed.name === featuredToday.name) {
      addBonusPts(100);
      setTimeout(() => setAchievementToast('⭐ Featured Cat bonus! +100 pts!'), 600);
      setTimeout(() => setAchievementToast(null), 3500);
    }
    // Dog of the Week bonus (first catch of this breed this week)
    const dotw = getDogOfTheWeek();
    if (dotw && breed.name === dotw.breed.name) {
      const claimKey = `km_dotw_${dotw.weekIdx}`;
      if (localStorage.getItem(claimKey) !== '1') {
        localStorage.setItem(claimKey, '1');
        addDD(30);
        setTimeout(() => setAchievementToast('🐱 Cat of the Week! +30 🪙 Kitty Coins!'), 700);
        setTimeout(() => setAchievementToast(null), 3800);
      }
    }
    // Mystery box every 10 catches
    const catchCount = parseInt(localStorage.getItem('km_catch_count') || '0', 10) + 1;
    localStorage.setItem('km_catch_count', catchCount);
    incrementCommunityGoal(); // best-effort, no await
    if (catchCount % 10 === 0) setTimeout(() => setShowMysteryBox(true), 1500);
    checkAchievements([...dogs, { rarity: breed.rarity }], (msg) => {
      setAchievementToast(msg);
      setTimeout(() => setAchievementToast(null), 3000);
    });
    // Pre-fetch the next dog's photo during the 2.2s pause so it appears instantly
    const nextBreed = zone ? getBreedForZone(zone) : getRandomBreed();
    fetchBreedPhoto(nextBreed).catch(() => {});
    setTimeout(() => spawnDog(zone), 2200); // brief pause to see the catch screen, then next dog

    // Save to the server in the background — the catch screen already shown above
    // means network latency is never felt as a delay before the catch registers.
    try {
      // Retry once on network hiccup — mobile connections drop briefly and "Load failed"
      // should never cost a player their catch.
      let newDog = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          newDog = await sb('cats', 'POST', { owner_id: player.id, name: breed.name, breed: breed.name, rarity: breed.rarity, photo_url: photoUrl || breed.api });
          break; // success
        } catch (retryErr) {
          if (attempt === 0) await new Promise(r => setTimeout(r, 500)); // brief pause then retry
          else throw retryErr; // second failure — bubble up
        }
      }
      if (newDog && newDog[0]) setDogGender(newDog[0].id, gender);
      onCatch(newDog && newDog[0]); // add the saved dog to the list (no full reload)
    } catch (e) {
      // The catch screen already played, so don't undo it — just let the player
      // know this one may not have saved rather than silently losing it.
      setAchievementToast('⚠️ Connection hiccup — that catch may not have saved');
      setTimeout(() => setAchievementToast(null), 3500);
    }
  };


  const zoneInfo = zone ? ZONES[zone] : null;
  const rarityColor = RARITY_COLORS[breed?.rarity] || '#fff';
  const eventMultiplier = getActiveEvent()?.pointsMultiplier || 1;
  const basePoints = Math.round((RARITY_POINTS[breed?.rarity] || 0) * eventMultiplier);
  const comboMultiplier = combo > 1 ? Math.min(combo, 5) : 1;
  const points = (isBoostActive('lucky_collar') ? basePoints * 2 : basePoints) * comboMultiplier;

  return (
    <div style={{ textAlign: 'center', padding: 16 }}>
      {catchFlash && (
        <div style={{
          position:'fixed',inset:0,zIndex:998,pointerEvents:'none',
          background: catchFlash==='Legendary' ? 'rgba(245,158,11,0.35)' : 'rgba(139,92,246,0.35)',
          display:'flex',alignItems:'center',justifyContent:'center',
          animation:'flashIn 0.3s ease-out'
        }}>
          <div style={{fontSize:48,fontWeight:900,color:'#fff',textShadow:'0 0 30px currentColor',textAlign:'center'}}>
            {catchFlash==='Legendary' ? '✨ LEGENDARY! ✨' : '💎 EPIC!'}
          </div>
        </div>
      )}
      {achievementToast && (
        <div style={{ position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', background: '#764ba2', color: 'white', borderRadius: 20, padding: '10px 20px', fontWeight: 'bold', fontSize: 14, zIndex: 999, boxShadow: '0 4px 20px rgba(0,0,0,0.3)', whiteSpace: 'nowrap' }}>
          {achievementToast}
        </div>
      )}
      <DailyChallengeBar />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={requestGPS} disabled={locating} style={{ padding: '9px 16px', background: 'linear-gradient(135deg, #667eea, #764ba2)', color: 'white', border: 'none', borderRadius: 20, fontSize: 13, cursor: 'pointer', fontWeight: 'bold', opacity: locating ? 0.7 : 1 }}>
          {locating ? '📍 Finding you...' : '📍 Use Location'}
        </button>
        {zone && <button onClick={() => { setZone(null); spawnDog(null); }} style={{ padding: '9px 16px', background: '#eee', color: '#666', border: 'none', borderRadius: 20, fontSize: 13, cursor: 'pointer' }}>✕ {zoneInfo?.label}</button>}
        {showCombo && combo > 1 && (
          <div style={{ background: combo >= 5 ? 'linear-gradient(135deg,#f4a261,#e76f51)' : 'linear-gradient(135deg,#667eea,#764ba2)', color: 'white', borderRadius: 20, padding: '9px 16px', fontWeight: 'bold', fontSize: 13, boxShadow: '0 4px 20px rgba(0,0,0,0.3)', whiteSpace: 'nowrap' }}>
            🔥 {combo}x COMBO! ×{Math.min(combo, 5)} points!
          </div>
        )}
      </div>
      {getActiveEvent() && (
        <div style={{ background: 'linear-gradient(135deg,#f4a261,#e76f51)', color: 'white', borderRadius: 14, padding: '8px 14px', marginBottom: 10, fontWeight: 'bold', fontSize: 13, textAlign: 'center' }}>
          {getActiveEvent().label} · {getActiveEvent().desc}
        </div>
      )}
      <h2 style={{ margin: '0 0 4px', color: '#333' }}>A wild cat appeared!</h2>
      {breed && (
        <div style={{ marginBottom: 12 }}>
          <p style={{ margin: '0 0 2px', color: rarityColor, fontWeight: 'bold', fontSize: 15 }}>✨ {breed.rarity} · {breed.name}</p>
          {points > 0 && <p style={{ margin: 0, color: '#f4a261', fontWeight: 'bold', fontSize: 13 }}>+{points} points if caught!</p>}
          {timeLeft !== null && !caught && (
            <div style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 5, background: timeLeft <= 3 ? '#e63946' : timeLeft <= 6 ? '#f4a261' : '#764ba2', color: 'white', borderRadius: 20, padding: '3px 12px', fontWeight: 'bold', fontSize: 13 }}>
              ⏱ {timeLeft}s — hurry!
            </div>
          )}
        </div>
      )}
      <div className="pm-catch-box" style={{ position: 'relative', width: '100%', maxWidth: 380, height: 310, background: zoneInfo ? `linear-gradient(135deg, ${zoneInfo.color}99, ${zoneInfo.color}44)` : 'linear-gradient(135deg, #a8edea, #fed6e3)', borderRadius: 20, margin: '0 auto 16px', overflow: 'hidden', border: '3px solid #fff', boxShadow: '0 4px 20px rgba(0,0,0,0.1)' }}>
        {!caught && <button onClick={() => spawnDog(zone)} style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(0,0,0,0.18)', color: 'white', border: 'none', borderRadius: 12, padding: '4px 10px', fontSize: 12, cursor: 'pointer', zIndex: 5 }}>Skip →</button>}
        {!breed ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <div style={{ fontSize: 40 }}>🐾</div>
            <div style={{ fontSize: 13, color: '#666' }}>Sniffing out a cat...</div>
          </div>
        ) : photoUrl ? (
          <img
            src={photoUrl} alt={breed.name} onClick={handleCatch}
            style={{ position: 'absolute', left: `${pos.x}%`, top: `${pos.y}%`, transform: `translate(-50%,-50%) scale(${dogScale}) rotate(${wobble ? '-6deg' : '6deg'})`, transition: catching ? 'transform 0.15s' : (CATCH_CFG[breed?.rarity]?.jitter ? `left 1.4s cubic-bezier(0.25,0.46,0.45,0.94), top 1.4s cubic-bezier(0.25,0.46,0.45,0.94), transform 0.9s ease` : 'transform 0.15s'), width: (CATCH_CFG[breed?.rarity]||CATCH_CFG.Common).size, height: (CATCH_CFG[breed?.rarity]||CATCH_CFG.Common).size, objectFit: 'cover', borderRadius: '50%', border: `4px solid ${rarityColor}`, cursor: caught ? 'default' : 'pointer', boxShadow: `0 4px 20px rgba(0,0,0,0.25), 0 0 20px ${rarityColor}66`, userSelect: 'none' }}
          />
        ) : (
          // Photo still loading — show tappable emoji dog so game is never blocked
          <div onClick={handleCatch} style={{ position: 'absolute', left: `${pos.x}%`, top: `${pos.y}%`, transform: `translate(-50%,-50%) scale(${dogScale}) rotate(${wobble ? '-6deg' : '6deg'})`, transition: catching ? 'transform 0.15s' : (CATCH_CFG[breed?.rarity]?.jitter ? `left 1.4s cubic-bezier(0.25,0.46,0.45,0.94), top 1.4s cubic-bezier(0.25,0.46,0.45,0.94), transform 0.9s ease` : 'transform 0.15s'), width: (CATCH_CFG[breed?.rarity]||CATCH_CFG.Common).size, height: (CATCH_CFG[breed?.rarity]||CATCH_CFG.Common).size, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', border: `4px solid ${rarityColor}`, cursor: 'pointer', boxShadow: `0 4px 20px rgba(0,0,0,0.25), 0 0 20px ${rarityColor}66`, background: 'rgba(255,255,255,0.9)', fontSize: 36, userSelect: 'none' }}>
            🐱
          </div>
        )}
        {zoneInfo && <div style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(255,255,255,0.85)', borderRadius: 12, padding: '4px 10px', fontSize: 12, fontWeight: 'bold' }}>{zoneInfo.label}</div>}
        {caught && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.92)', padding: 16 }}>
            {photoUrl && <img src={photoUrl} alt={breed?.name} style={{ width: 95, height: 95, objectFit: 'cover', borderRadius: '50%', border: `4px solid ${rarityColor}`, marginBottom: 8 }} />}
            <div style={{ fontSize: 22, fontWeight: 'bold', color: '#333' }}>Caught! 🎉</div>
            <div style={{ fontSize: 15, color: rarityColor, fontWeight: 'bold', margin: '4px 0 2px' }}>{breed?.name}</div>
            {caughtGender && <div style={{ fontSize: 13, color: '#555', marginBottom: 2 }}>{caughtGender === 'Male' ? '♂️ Male' : '♀️ Female'}</div>}
            {points > 0 && <div style={{ fontSize: 14, color: '#f4a261', fontWeight: 'bold' }}>+{points} points! ⭐</div>}
            {breed?.facts?.[0] && <div style={{ fontSize: 12, color: '#555', lineHeight: 1.4, maxWidth: 240, fontStyle: 'italic', marginTop: 8 }}>"{breed.facts[0]}"</div>}
            {caught && lastCaughtBreed && (
              <button onClick={() => setShowShareGate(true)} style={{ marginTop:10, padding:'8px 20px', background:'linear-gradient(135deg,#667eea,#764ba2)', color:'white', border:'none', borderRadius:20, fontSize:13, fontWeight:'bold', cursor:'pointer' }}>
                📤 Share Catch
              </button>
            )}
          </div>
        )}
      </div>
      {!caught && breed && (
        <button onClick={throwTreat} disabled={treat !== 0} style={{ margin: '0 0 8px', padding: '8px 18px', background: treat === 0 ? 'linear-gradient(135deg,#f4a261,#e76f51)' : '#ddd', color: treat === 0 ? 'white' : '#888', border: 'none', borderRadius: 20, fontSize: 13, fontWeight: 'bold', cursor: treat === 0 ? 'pointer' : 'default' }}>
          {treat === 1 ? '😻 Sniffing the treat… tap now!' : treat === 2 ? '🐟 Treat used' : '🐟 Throw a Treat (1 per cat)'}
        </button>
      )}
      <p style={{ color: '#666', fontSize: 13, margin: 0 }}>{caught ? 'Added to your collection!' : 'Tap the cat to catch it!'}</p>
      {showMysteryBox && <MysteryBoxModal onClose={() => setShowMysteryBox(false)} player={player} onCatch={onCatch} />}
      {showConfetti && <ConfettiEffect onDone={() => setShowConfetti(false)} />}
      {showShareGate && (
        <ParentalGateModal
          onClose={() => setShowShareGate(false)}
          onSuccess={() => { setShowShareGate(false); if (lastCaughtBreed) shareCatchCard(lastCaughtBreed.name, lastCaughtBreed.rarity, lastCaughtBreed.photoUrl); }}
        />
      )}
    </div>
  );
}

// ─── Dog Diary Modal ──────────────────────────────────────────────────────────
function DogDiaryModal({ dog, onClose, showToast }) {
  const breeds = DOG_BREEDS;
  const breedInfo = breeds.find(b => b.name === dog.breed) || {};
  const facts = breedInfo.facts || [];
  // useRef so the fact stays stable across re-renders (doesn't flash on every state change)
  const factRef = useRef(facts[Math.floor(Math.random() * facts.length)] || 'A wonderful companion!');
  const fact = factRef.current;

  const favKey = `km_fav_${dog.id}`;
  const photoKey = `km_photo_${dog.id}`;
  const [nick, setNick] = React.useState(getDogNick(dog.id) || '');
  const [fav, setFav] = React.useState(localStorage.getItem(favKey) === '1');
  // Custom photo = localStorage cache OR a data URL stored in dog.photo_url (cross-device)
  const isCustomUrl = (url) => url && url.startsWith('data:image/') && !url.startsWith('data:image/svg+xml');
  const [customPhoto, setCustomPhoto] = React.useState(() => {
    // Photo saved on the dog (cloud) wins; the local copy is only a fallback
    if (isCustomUrl(dog.photo_url)) return dog.photo_url;
    return localStorage.getItem(photoKey) || null;
  });
  const [resolvedPhoto, setResolvedPhoto] = React.useState(() => dogImageSrc(dog));
  React.useEffect(() => {
    if (customPhoto) return; // custom photo takes priority
    if (resolvedPhoto) return; // already have a good URL
    resolveDogPhoto(dog).then(url => { if (url) setResolvedPhoto(url); });
  }, [dog.id]);

  const gender = (() => { let g = getDogGender(dog.id); if (!g) { g = Math.random()<0.5?'Male':'Female'; try { setDogGender(dog.id, g); } catch {} } return g; })();

  const rarityColors = { Legendary:'#f59e0b', Epic:'#8b5cf6', Rare:'#3b82f6', Uncommon:'#10b981', Common:'#6b7280' };
  const color = rarityColors[dog.rarity] || '#6b7280';

  return ReactDOM.createPortal(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.85)',zIndex:999,display:'flex',flexDirection:'column',alignItems:'center',padding:'20px',paddingTop:56,overflowY:'auto'}} onClick={onClose}>
      <div style={{background:'#1a1a2e',borderRadius:20,padding:24,maxWidth:400,width:'100%',position:'relative'}} onClick={e=>e.stopPropagation()}>
        <button onClick={onClose} style={{position:'absolute',top:12,right:12,zIndex:2,background:'rgba(0,0,0,0.5)',border:'none',color:'#fff',fontSize:20,width:34,height:34,borderRadius:17,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>✕</button>
        {/* Equipped cosmetics display */}
        {(() => {
          const cos = getDogCosmetics(dog.id);
          const items = ['hat','collar','acc','cape'].map(s => cos[s] ? COSMETICS.find(c=>c.id===cos[s]) : null).filter(Boolean);
          if (!items.length) return null;
          return <div style={{ marginBottom: 10, textAlign: 'center', fontSize: 22 }}>{items.map(c => <span key={c.id} title={c.name}>{c.emoji}</span>)}</div>;
        })()}
        <div style={{marginBottom:12}}>
          <div style={{position:'relative'}}>
            {(customPhoto || resolvedPhoto) ? (
              <img src={customPhoto || resolvedPhoto} alt={dog.breed} style={{width:'100%',borderRadius:12,display:'block',height:220,objectFit:'contain',background:'#0f0f23'}} onError={e=>{e.target.onerror=null;e.target.src=catArtUrl(dog.breed)||catArtUrl('Domestic Shorthair');}} />
            ) : (
              <div style={{width:'100%',height:160,borderRadius:12,background:'#2a2a4e',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:8}}>
                <div style={{fontSize:48}}>🐱</div>
                <div style={{color:'#888',fontSize:13}}>Loading photo…</div>
              </div>
            )}
            {customPhoto && !PROTECTED_DOG_IDS.has(dog.id) && (
              <button onClick={async ()=>{
                setCustomPhoto(null);
                try { localStorage.removeItem(photoKey); } catch {}
                const plain = { ...dog, photo_url: null };
                const orig = await resolveDogPhoto(plain); // fetches the normal breed photo and saves it
                setResolvedPhoto(orig);
                const newUrl = orig && orig.startsWith('http') ? orig : null;
                window.dispatchEvent(new CustomEvent('km_photo_cleared', { detail: { id: dog.id, url: newUrl } })); // keep the dogs list in step
                sb(`cats?id=eq.${dog.id}`, 'PATCH', { photo_url: newUrl }).catch(()=>{});
              }} style={{position:'absolute',top:8,right:8,background:'rgba(220,38,38,0.85)',color:'white',border:'none',borderRadius:20,padding:'4px 12px',fontSize:11,fontWeight:'bold',cursor:'pointer'}}>✕ Remove photo</button>
            )}
          </div>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
          <h2 style={{color:'#fff',margin:0}}>{dog.name || dog.breed}</h2>
          <span style={{background:color,color:'#fff',borderRadius:8,padding:'2px 10px',fontSize:13,fontWeight:700}}>{dog.rarity}</span>
          <span style={{background: gender==='Male'?'#4a90e2':'#e26b9a',color:'#fff',borderRadius:8,padding:'3px 10px',fontSize:13,fontWeight:700,display:'inline-flex',alignItems:'center',lineHeight:1.2}}>{gender==='Male'?'♂ Male':'♀ Female'}</span>
          <button onClick={()=>{const nf=!fav;setFav(nf);localStorage.setItem(favKey,nf?'1':'0');}} style={{marginLeft:'auto',background:'none',border:'none',fontSize:24,cursor:'pointer'}}>{fav?'❤️':'🤍'}</button>
        </div>
        <p style={{color:'#aaa',fontSize:13,marginBottom:8}}>Caught: {new Date(dog.caught_at||Date.now()).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</p>
        <p style={{color:'#e2e8f0',fontStyle:'italic',marginBottom:16,lineHeight:1.5}}>"{fact}"</p>
        {/* Personality traits */}
        {(() => {
          const traits = getDogTraits(dog.id);
          return (
            <div style={{marginBottom:12}}>
              <div style={{color:'#aaa',fontSize:12,marginBottom:6,fontWeight:'bold'}}>✨ Personality</div>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {traits.map((t,i) => (
                  <span key={i} style={{background:'rgba(90,171,106,0.2)',border:'1.5px solid rgba(90,171,106,0.4)',color:'#a8d8a8',borderRadius:20,padding:'3px 10px',fontSize:12,fontWeight:'bold'}}>{t}</span>
                ))}
              </div>
            </div>
          );
        })()}
        <label style={{color:'#aaa',fontSize:13}}>Nickname</label>
        <input value={nick} onChange={e=>{setNick(e.target.value);setDogNick(dog.id, e.target.value);}}
          placeholder="Give this kitten a name..."
          style={{display:'block',width:'100%',marginTop:4,padding:'8px 12px',borderRadius:8,border:'1px solid #444',background:'#0f0f23',color:'#fff',fontSize:15,boxSizing:'border-box'}} />
        {/* Training passport */}
        {(() => {
          const state = getDogState(dog.id);
          const skills = state.skills || {};
          const lvl = state.level || 1;
          const xp = state.xp || 0;
          const hasTraining = Object.keys(skills).length > 0;
          return (
            <div style={{marginTop:16,background:'rgba(255,255,255,0.06)',borderRadius:12,padding:12}}>
              <div style={{color:'#ccc',fontWeight:'bold',fontSize:13,marginBottom:8}}>📜 Passport · Lv {lvl} · {xp} XP</div>
              {hasTraining ? ['Sit','Stay','Fetch','Roll Over'].map(sk => (
                <div key={sk} style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
                  <span style={{color:'#aaa',fontSize:12,width:80}}>{sk}</span>
                  <span style={{letterSpacing:2,fontSize:14}}>{Array.from({length:5},(_,i)=>i<(skills[sk]||0)?'⭐':'☆').join('')}</span>
                </div>
              )) : <div style={{color:'#666',fontSize:12}}>Not trained yet — go to your collection to train!</div>}
              {facts.length > 0 && <div style={{marginTop:10,color:'#9bc',fontSize:12,fontStyle:'italic',lineHeight:1.5}}>"{facts[0]}"</div>}
            </div>
          );
        })()}
      </div>
    </div>,
    document.body
  );
}

// ─── Train Dog Modal ──────────────────────────────────────────────────────────
const SKILLS = ['Sit', 'Stay', 'Fetch', 'Roll Over'];
const SIMON_EMOJIS = ['🐾','❤️','⭐','🐟','🌟','🧶'];

function TrainDogModal({ dog, onClose, setToast }) {
  const [skills, setSkills] = React.useState(() => getDogState(dog.id).skills || {});
  const [activeSkill, setActiveSkill] = React.useState(null);
  const [simonSeq, setSimonSeq] = React.useState([]);
  const [simonDisplay, setSimonDisplay] = React.useState(null);
  const [playerSeq, setPlayerSeq] = React.useState([]);
  const [lastTapped, setLastTapped] = React.useState(null);
  const [shuffled, setShuffled] = React.useState([]);
  const [phase, setPhase] = React.useState('idle'); // idle | showing | input | result
  const [result, setResult] = React.useState('');

  const startGame = (skill) => {
    setActiveSkill(skill);
    const seq = Array.from({length:3}, () => SIMON_EMOJIS[Math.floor(Math.random()*SIMON_EMOJIS.length)]);
    setSimonSeq(seq);
    setPlayerSeq([]);
    setResult('');
    const sh = [...SIMON_EMOJIS].sort(() => Math.random()-0.5);
    setShuffled(sh);
    setPhase('showing');
    setSimonDisplay(null);
    let i = 0;
    const show = () => {
      if (i < seq.length) { setSimonDisplay(seq[i]); setTimeout(() => { setSimonDisplay(null); setTimeout(() => { i++; show(); }, 300); }, 900); }
      else { setPhase('input'); }
    };
    setTimeout(show, 400);
  };

  const handleTap = (emoji) => {
    if (phase !== 'input') return;
    setLastTapped(emoji);
    setTimeout(() => setLastTapped(null), 250);
    const next = [...playerSeq, emoji];
    setPlayerSeq(next);
    if (next.length === simonSeq.length) {
      const correct = next.every((e, i) => e === simonSeq[i]);
      if (correct) {
        const s = getDogState(dog.id);
        const sk = s.skills || {};
        sk[activeSkill] = Math.min(5, (sk[activeSkill] || 0) + 1);
        s.skills = sk;
        // If all 4 skills are now maxed (5★), guarantee the dog reaches Level 5
        const allMaxed = SKILLS.every(sk2 => (sk[sk2] || 0) >= 5);
        if (allMaxed && (s.level || 1) < 5) {
          s.level = 5;
          s.xp = 0;
          saveDogState(dog.id, s);
          setSkills({...sk});
          setResult('correct');
          setToast('🎓 All skills mastered! Cat reached Level 5! 🎉');
        } else {
          saveDogState(dog.id, s);
          addXP(dog.id, 20, setToast);
          setSkills({...sk});
          setResult('correct');
          setToast('🎓 Skill up! +20 XP!');
        }
      } else {
        addXP(dog.id, 5, setToast);
        setResult('wrong');
      }
      setPhase('result');
    }
  };

  const stars = (n) => '★'.repeat(n) + '☆'.repeat(5-n);

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.8)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
      <div style={{background:'white',borderRadius:20,padding:20,width:'100%',maxWidth:360,maxHeight:'90vh',overflowY:'auto'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
          <h3 style={{margin:0,color:'#764ba2'}}>🎓 Train {dog.name || dog.breed}</h3>
          <button onClick={onClose} style={{background:'none',border:'none',fontSize:22,cursor:'pointer'}}>✕</button>
        </div>
        {phase === 'idle' && (() => {
          const currentLevel = getDogState(dog.id).level || 1;
          const allMaxed = SKILLS.every(sk2 => (skills[sk2] || 0) >= 5);
          // If all skills are maxed but dog is below Lv.5, show a "Graduate" button
          if (allMaxed && currentLevel < 5) {
            return (
              <div style={{textAlign:'center'}}>
                <div style={{fontSize:48,marginBottom:8}}>🎓</div>
                <div style={{fontWeight:'bold',color:'#764ba2',fontSize:17,marginBottom:6}}>All skills mastered!</div>
                <div style={{color:'#888',fontSize:13,marginBottom:16}}>{dog.name || dog.breed} has learned everything — time to graduate to Level 5!</div>
                {SKILLS.map(skill => (
                  <div key={skill} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 12px',background:'#f5f0ff',borderRadius:12,marginBottom:6}}>
                    <div style={{fontWeight:'bold',color:'#333',fontSize:14}}>{skill}</div>
                    <div style={{color:'#f59e0b',fontSize:16,letterSpacing:2}}>{stars(skills[skill]||0)}</div>
                  </div>
                ))}
                <button onClick={() => {
                  const s = getDogState(dog.id);
                  s.level = 5; s.xp = 0;
                  saveDogState(dog.id, s);
                  setToast('🎓 Graduated to Level 5! Visit the Training School for more!');
                  onClose();
                }} style={{marginTop:12,width:'100%',padding:'14px 0',background:'linear-gradient(135deg,#667eea,#764ba2)',color:'white',border:'none',borderRadius:14,fontWeight:'bold',fontSize:16,cursor:'pointer'}}>
                  🎓 Graduate to Level 5!
                </button>
              </div>
            );
          }
          return (
          <div>
            <p style={{color:'#888',fontSize:13,marginBottom:12}}>Tap a skill to practice!</p>
            {SKILLS.map(skill => (
              <div key={skill} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 12px',background:'#f5f0ff',borderRadius:12,marginBottom:8}}>
                <div>
                  <div style={{fontWeight:'bold',color:'#333',fontSize:14}}>{skill}</div>
                  <div style={{color:'#f59e0b',fontSize:16,letterSpacing:2}}>{stars(skills[skill]||0)}</div>
                </div>
                <button onClick={() => startGame(skill)} disabled={(skills[skill]||0)>=5} style={{padding:'8px 14px',background:(skills[skill]||0)>=5?'#eee':'linear-gradient(135deg,#667eea,#764ba2)',color:(skills[skill]||0)>=5?'#aaa':'white',border:'none',borderRadius:10,fontWeight:'bold',fontSize:13,cursor:(skills[skill]||0)>=5?'not-allowed':'pointer'}}>
                  {(skills[skill]||0)>=5?'Max!':'Practice'}
                </button>
              </div>
            ))}
          </div>
          );
        })()}
        {(phase==='showing'||phase==='input') && (
          <div style={{textAlign:'center'}}>
            <div style={{fontWeight:'bold',color:'#764ba2',marginBottom:8}}>Training: {activeSkill}</div>
            {phase==='showing' && (
              <div>
                <p style={{color:'#888',fontSize:13}}>Watch the sequence!</p>
                <div style={{fontSize:80,minHeight:100,display:'flex',alignItems:'center',justifyContent:'center'}}>{simonDisplay || '·'}</div>
              </div>
            )}
            {phase==='input' && (
              <div>
                <p style={{color:'#333',fontWeight:'bold',fontSize:13}}>Repeat the sequence! ({playerSeq.length}/{simonSeq.length})</p>
                <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10,margin:'16px 0'}}>
                  {shuffled.map((e,i) => (
                    <button key={i} onClick={()=>handleTap(e)} style={{fontSize:36,padding:12,background:lastTapped===e?'#c39bd3':'#f5f0ff',border:'2px solid #c39bd3',borderRadius:14,cursor:'pointer',transform:lastTapped===e?'scale(0.9)':'scale(1)',transition:'background 0.15s, transform 0.15s'}}>{e}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {phase==='result' && (
          <div style={{textAlign:'center',padding:20}}>
            {result==='correct' ? (
              <div><div style={{fontSize:60,marginBottom:8}}>🎉</div><div style={{fontWeight:'bold',color:'#06d6a0',fontSize:18}}>Correct! Skill up!</div><div style={{color:'#888',fontSize:13,marginTop:4}}>+20 XP earned</div></div>
            ) : (
              <div><div style={{fontSize:60,marginBottom:8}}>😅</div><div style={{fontWeight:'bold',color:'#e63946',fontSize:18}}>Keep practising!</div><div style={{color:'#888',fontSize:13,marginTop:4}}>+5 XP consolation</div></div>
            )}
            <button onClick={() => setPhase('idle')} style={{marginTop:16,padding:'10px 24px',background:'linear-gradient(135deg,#667eea,#764ba2)',color:'white',border:'none',borderRadius:12,fontWeight:'bold',fontSize:14,cursor:'pointer'}}>Back to Skills</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Dog House Screen ─────────────────────────────────────────────────────────
// ─── Dog Cosmetics (wearables per dog) ───────────────────────────────────────
const COSMETICS = [
  { id:'hat_cap',      emoji:'🧢', name:'Baseball Cap',    cost:30,  slot:'hat',    desc:'Sporty vibes' },
  { id:'hat_crown',    emoji:'👑', name:'Golden Crown',    cost:120, slot:'hat',    desc:'For royalty only' },
  { id:'hat_top',      emoji:'🎩', name:'Top Hat',         cost:80,  slot:'hat',    desc:'Fancy kitten' },
  { id:'hat_party',    emoji:'🎉', name:'Party Hat',       cost:25,  slot:'hat',    desc:'Always celebrating' },
  { id:'hat_santa',    emoji:'🎅', name:'Santa Hat',       cost:50,  slot:'hat',    desc:'Ho ho meow!' },
  { id:'collar_bow',   emoji:'🎀', name:'Bow Tie',         cost:40,  slot:'collar', desc:'Dapper kitty' },
  { id:'collar_diam',  emoji:'💎', name:'Diamond Collar',  cost:200, slot:'collar', desc:'Premium bling' },
  { id:'collar_flower',emoji:'🌸', name:'Flower Collar',   cost:35,  slot:'collar', desc:'Springtime cutie' },
  { id:'collar_star',  emoji:'⭐', name:'Star Collar',     cost:60,  slot:'collar', desc:'Born to shine' },
  { id:'acc_glasses',  emoji:'😎', name:'Cool Glasses',    cost:45,  slot:'acc',    desc:'Too cool for school' },
  { id:'acc_heart',    emoji:'❤️', name:'Heart Glasses',   cost:45,  slot:'acc',    desc:'Spreading love' },
  { id:'acc_bandana',  emoji:'🟥', name:'Red Bandana',     cost:30,  slot:'acc',    desc:'Wild kitten energy' },
  { id:'cape_hero',    emoji:'🦸', name:'Hero Cape',       cost:100, slot:'cape',   desc:'Saving the world one meow at a time' },
  { id:'cape_star',    emoji:'🌟', name:'Star Cape',       cost:150, slot:'cape',   desc:'Legendary sparkle' },
  // Cosy Cat Pack (one-time purchase) items — cost 0 and never sold for coins
  { id:'hat_beanie',   emoji:'🧶', name:'Yarn Beanie',     cost:0, slot:'hat',    desc:'Knitted by grandma', pack:'cosy' },
  { id:'collar_bell',  emoji:'🔔', name:'Jingle Bell',     cost:0, slot:'collar', desc:'Ting-a-ling!', pack:'cosy' },
  { id:'acc_scarf',    emoji:'🧣', name:'Cosy Scarf',      cost:0, slot:'acc',    desc:'Warm and snuggly', pack:'cosy' },
  { id:'cape_blanket', emoji:'🛏️', name:'Blanket Cape',    cost:0, slot:'cape',   desc:'Nap time anywhere', pack:'cosy' },
];

function getDogCosmetics(dogId) {
  try { return JSON.parse(localStorage.getItem(`km_cosmetics_${dogId}`) || '{}'); } catch { return {}; }
}
function setDogCosmetics(dogId, cos) {
  try { localStorage.setItem(`km_cosmetics_${dogId}`, JSON.stringify(cos)); } catch {}
}
// Owned cosmetics (not per-dog — owned globally, then equipped to a dog)
function getOwnedCosmetics() {
  try { return JSON.parse(localStorage.getItem('km_owned_cosmetics') || '[]'); } catch { return []; }
}
// Cosy Cat Pack entitlement. In the App Store build, window.KM_IAP (RevenueCat bridge) must provide
// purchase('cosy_cat_pack') -> Promise<boolean> and restore() -> Promise<boolean>. Without it nothing can be bought.
const COSY_PACK_PRICE = '$2.99';
function hasCosyPack() { try { return localStorage.getItem('km_pack_cosy') === '1'; } catch { return false; } }
function grantCosyPack() {
  try { localStorage.setItem('km_pack_cosy', '1'); } catch {}
  COSMETICS.filter(c => c.pack === 'cosy').forEach(c => addOwnedCosmetic(c.id));
  try { window.dispatchEvent(new Event('km_pack_change')); } catch {}
}
function addOwnedCosmetic(id) {
  const owned = getOwnedCosmetics();
  if (!owned.includes(id)) { owned.push(id); try { localStorage.setItem('km_owned_cosmetics', JSON.stringify(owned)); } catch {} }
}



// ── Transfer my cats: save / load a backup file so an account can move to another phone (offline mode) ──
function exportKittyBackup() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('km_') && !k.startsWith('km_catapi_') && !k.startsWith('km_cataas_')) { try { const v = localStorage.getItem(k); if (v != null) data[k] = v; } catch {} }
  }
  const blob = new Blob([JSON.stringify({ kittymart_backup: 1, saved: new Date().toISOString(), data })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'kittymart-backup.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importKittyBackup(file) {
  const j = JSON.parse(await file.text());
  if (!j || j.kittymart_backup !== 1 || !j.data || typeof j.data !== 'object') throw new Error('not a KittyMart backup');
  Object.keys(j.data).forEach(k => { if (k.startsWith('km_') && typeof j.data[k] === 'string') { try { localStorage.setItem(k, j.data[k]); } catch {} } });
}

// ─── Cosy Corner (cat-only): pick a bed + wall colour; napping cats curl up in it ───
const COSY_BEDS = [
  { id:'basket', emoji:'🧺', name:'Wicker Basket' },
  { id:'box',    emoji:'📦', name:'Cardboard Box' },
  { id:'igloo',  emoji:'🛖', name:'Snug Igloo' },
  { id:'cushion',emoji:'🛋️', name:'Soft Cushion' },
];
const COSY_WALLS = ['#ffe3ec','#e3f2ff','#e8f7e4','#fff3cf','#efe3ff'];
function getCosy() { try { return { bed:'basket', wall:COSY_WALLS[0], ...JSON.parse(localStorage.getItem('km_cosy') || '{}') }; } catch { return { bed:'basket', wall:COSY_WALLS[0] }; } }
function CosyCornerScreen({ dogs, onBack }) {
  const [cfg, setCfg] = useState(getCosy);
  const upd = (patch) => { const n = { ...cfg, ...patch }; setCfg(n); try { localStorage.setItem('km_cosy', JSON.stringify(n)); } catch {} };
  let naps = {}; try { naps = JSON.parse(localStorage.getItem('km_nap_times') || '{}'); } catch {}
  const sleepers = dogs.filter(d => Date.now() - (naps[d.id] || 0) < 6 * 3600000).slice(0, 6);
  const bed = COSY_BEDS.find(b => b.id === cfg.bed) || COSY_BEDS[0];
  return (
    <div style={{padding:16}}>
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14}}>
        <button onClick={onBack} style={{padding:'8px 14px',background:'#f0f0f0',border:'none',borderRadius:12,fontWeight:'bold',cursor:'pointer',fontSize:13}}>← Back</button>
        <h2 style={{margin:0,color:'#333',fontSize:18}}>🛏️ Cosy Corner</h2>
      </div>
      <div style={{background:cfg.wall,borderRadius:18,padding:14,border:'2px solid #e0d0ff',minHeight:170}}>
        <div style={{fontSize:12,color:'#888',marginBottom:8}}>{sleepers.length ? 'Sleepy cats are curled up in their beds 💤' : 'No cats napping yet — tap 😴 on a cat in the Cats tab to tuck it in!'}</div>
        <div style={{display:'flex',flexWrap:'wrap',gap:12,justifyContent:'center'}}>
          {sleepers.map(d => (
            <div key={d.id} style={{textAlign:'center',width:80}}>
              <div style={{position:'relative',height:70}}>
                <div style={{fontSize:56,lineHeight:'70px'}}>{bed.emoji}</div>
                {(dogImageSrc(d) || d.photo_url) && <img src={dogImageSrc(d) || d.photo_url} alt={d.name} style={{position:'absolute',left:'50%',top:8,transform:'translateX(-50%)',width:38,height:38,borderRadius:'50%',objectFit:'cover',border:`2px solid ${RARITY_COLORS[d.rarity]}`}} onError={e=>e.target.style.display='none'} />}
                <span style={{position:'absolute',right:4,top:0,fontSize:16}}>💤</span>
              </div>
              <div style={{fontSize:11,fontWeight:'bold',color:'#555',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{d.name}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{marginTop:14,fontWeight:'bold',color:'#764ba2',fontSize:13}}>Choose a bed</div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:6}}>
        {COSY_BEDS.map(b => (
          <button key={b.id} onClick={() => upd({ bed:b.id })} style={{padding:'8px 10px',borderRadius:12,border:cfg.bed===b.id?'3px solid #764ba2':'2px solid #ddd',background:'white',cursor:'pointer',fontSize:12,fontWeight:'bold'}}>{b.emoji} {b.name}</button>
        ))}
      </div>
      <div style={{marginTop:14,fontWeight:'bold',color:'#764ba2',fontSize:13}}>Wall colour</div>
      <div style={{display:'flex',gap:10,marginTop:6}}>
        {COSY_WALLS.map(c => (
          <button key={c} aria-label={'wall '+c} onClick={() => upd({ wall:c })} style={{width:38,height:38,borderRadius:'50%',background:c,border:cfg.wall===c?'3px solid #764ba2':'2px solid #ccc',cursor:'pointer'}} />
        ))}
      </div>
    </div>
  );
}

// ─── Vet Screen ──────────────────────────────────────────────────────────────
const VET_FEED_COST = 20;
function VetScreen({ player, dogs, setDogs, onBack }) {
  const score = useLive(getBonusPts, 'km_pts_change');
  const [msg, setMsg] = useState('');
  const [, forceUpdate] = useState(0);

  const checkup = (dog) => {
    const s = getDogState(dog.id);
    const h = calcHunger(s);
    if (h > 80) setMsg(`${dog.name}: 💚 Perfectly healthy! Keep it up!`);
    else if (h >= 50) setMsg(`${dog.name}: 💛 Could use a meal soon.`);
    else setMsg(`${dog.name}: ❤️ Hungry! Feed this kitten ASAP.`);
    setTimeout(() => setMsg(''), 3000);
  };

  const treatDog = (dog) => {
    if (score < VET_FEED_COST) { setMsg(`Need ${VET_FEED_COST}pts to feed a cat here — or use Kitty Coins in the Mart!`); setTimeout(() => setMsg(''), 3000); return; }
    addBonusPts(-VET_FEED_COST);
    const s = getDogState(dog.id);
    s.hunger = 100; s.lastFed = Date.now();
    saveDogState(dog.id, s);
    forceUpdate(n => n + 1);
    setMsg(`🏥 ${dog.name} treated! Hunger restored to 100.`);
    setTimeout(() => setMsg(''), 3000);
  };

  return (
    <div style={{padding:16}}>
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:16}}>
        <button onClick={onBack} style={{padding:'8px 14px',background:'#f0f0f0',border:'none',borderRadius:12,fontWeight:'bold',cursor:'pointer',fontSize:13}}>← Back</button>
        <h2 style={{margin:0,color:'#333',fontSize:18}}>🏥 KittyMart Vet Clinic</h2>
      </div>
      {msg && <div style={{background:'#764ba2',color:'white',borderRadius:12,padding:'10px 14px',marginBottom:12,fontWeight:'bold',fontSize:13}}>{msg}</div>}
      <div style={{background:'white',borderRadius:14,padding:14,marginBottom:14,border:'2px solid #e0d0ff'}}>
        <div style={{fontWeight:'bold',color:'#764ba2',marginBottom:6,fontSize:13}}>⭐ Points you can spend: {score} pts</div>
        <div style={{background:'linear-gradient(135deg,#667eea,#764ba2)',color:'white',borderRadius:12,padding:'12px 14px',fontWeight:'bold',fontSize:14,textAlign:'center'}}>💊 Full Treatment — {VET_FEED_COST}pts per cat to restore hunger to 100. Tap Feed next to a cat below!</div>
      </div>
      {dogs.length === 0 ? <div style={{textAlign:'center',color:'#aaa',padding:40}}>No cats yet!</div> : (
        <div style={{display:'flex',flexDirection:'column',gap:10}}>
          {dogs.map(dog => {
            const ds = getDogState(dog.id);
            const h = Math.round(calcHunger(ds));
            const hColor = h>60?'#52b788':h>30?'#f4a261':'#e63946';
            return (
              <div key={dog.id} style={{background:'white',border:'2px solid #eee',borderRadius:14,padding:12,display:'flex',alignItems:'center',gap:12}}>
                {dog.photo_url && <img src={dogImageSrc(dog) || dog.photo_url} alt={dog.name} style={{width:50,height:50,borderRadius:'50%',objectFit:'cover',border:`2px solid ${RARITY_COLORS[dog.rarity]}`}} onError={e=>e.target.style.display='none'} />}
                <div style={{flex:1}}>
                  <div style={{fontWeight:'bold',fontSize:13,color:'#333'}}>{dog.name}</div>
                  <div style={{fontSize:11,color:'#888',marginBottom:4}}>Lv.{ds.level} · {dog.rarity}</div>
                  <div style={{height:6,background:'#eee',borderRadius:4,overflow:'hidden'}}>
                    <div style={{height:'100%',width:`${h}%`,background:hColor,borderRadius:4,transition:'width 0.3s'}} />
                  </div>
                  <div style={{fontSize:10,color:hColor,marginTop:2}}>Hunger: {h}%</div>
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:6}}>
                  <button onClick={()=>checkup(dog)} style={{padding:'8px 12px',background:'#e8f5e9',color:'#2d6a4f',border:'none',borderRadius:10,fontWeight:'bold',fontSize:12,cursor:'pointer',whiteSpace:'nowrap'}}>Check-up (Free)</button>
                  <button onClick={()=>treatDog(dog)} disabled={h>=100} style={{padding:'8px 12px',background:h>=100?'#eee':'linear-gradient(135deg,#667eea,#764ba2)',color:h>=100?'#aaa':'white',border:'none',borderRadius:10,fontWeight:'bold',fontSize:12,cursor:h>=100?'not-allowed':'pointer',whiteSpace:'nowrap'}}>{h>=100?'Full!':`Feed (${VET_FEED_COST}pts)`}</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Collection Screen ────────────────────────────────────────────────────────
const POO_RARITIES = [{name:'Common',w:60,pts:1},{name:'Uncommon',w:25,pts:3},{name:'Rare',w:10,pts:10},{name:'Epic',w:4,pts:25},{name:'Legendary',w:1,pts:100}];
const POO_COLORS = {Common:'#adb5bd',Uncommon:'#4cc9f0',Rare:'#7b2ff7',Epic:'#f72585',Legendary:'#ffd700'};

function rollPooRarity() {
  const roll = Math.random()*100; let cum = 0;
  for (const r of POO_RARITIES) { cum += r.w; if (roll < cum) return r; }
  return POO_RARITIES[0];
}

// ─── Share My Pack Card ───────────────────────────────────────────────────────
function ShareMyPackModal({ player, dogs, onClose }) {
  const canvasRef = React.useRef(null);
  const [imgUrl, setImgUrl] = React.useState(null);
  const topDogs = React.useMemo(() => {
    const order = ['Legendary','Epic','Rare','Uncommon','Common'];
    return [...dogs].sort((a,b) => order.indexOf(a.rarity) - order.indexOf(b.rarity)).slice(0,6);
  }, [dogs]);
  const totalPts = calcPoints(dogs) + getBonusPts();
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = 800, H = 500;
    canvas.width = W; canvas.height = H;
    // ACNH-style background
    const grad = ctx.createLinearGradient(0,0,0,H);
    grad.addColorStop(0,'#b8e8c8'); grad.addColorStop(0.5,'#e8f5e0'); grad.addColorStop(1,'#fffbe6');
    ctx.fillStyle = grad; ctx.fillRect(0,0,W,H);
    // Leafy border
    ctx.strokeStyle = '#5aab6a'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.roundRect(6,6,W-12,H-12,24); ctx.stroke();
    ctx.strokeStyle = '#a8d8a8'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(14,14,W-28,H-28,18); ctx.stroke();
    // Title
    ctx.font = 'bold 36px "Nunito", sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#2d6a4f';
    ctx.fillText('🐾 My KittyMart Pack', W/2, 58);
    // Username
    ctx.font = '22px "Nunito", sans-serif'; ctx.fillStyle = '#5aab6a';
    ctx.fillText(`${player.username}'s Top Cats`, W/2, 90);
    // Stats bar
    ctx.fillStyle = 'rgba(90,171,106,0.15)'; ctx.beginPath(); ctx.roundRect(40,100,W-80,48,12); ctx.fill();
    ctx.font = 'bold 18px "Nunito", sans-serif'; ctx.fillStyle = '#2d6a4f'; ctx.textAlign = 'left';
    ctx.fillText(`🐱 ${dogs.length} cats`, 60, 130);
    ctx.textAlign = 'center';
    ctx.fillText(`⭐ ${totalPts} pts`, W/2, 130);
    ctx.textAlign = 'right';
    const rar = ['Legendary','Epic','Rare'].map(r => `${r[0]}: ${dogs.filter(d=>d.rarity===r).length}`).join('  ');
    ctx.fillText(rar, W-60, 130);
    // Dog cards
    const cols = 3, rows = 2, cardW = 190, cardH = 130, startX = 68, startY = 168, gapX = 30, gapY = 18;
    const rarityColors = { Legendary:'#f59e0b', Epic:'#8b5cf6', Rare:'#3b82f6', Uncommon:'#10b981', Common:'#9ca3af' };
    topDogs.forEach((dog, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const x = startX + col * (cardW + gapX), y = startY + row * (cardH + gapY);
      const color = rarityColors[dog.rarity] || '#9ca3af';
      // Card bg
      ctx.fillStyle = 'rgba(255,255,255,0.88)'; ctx.beginPath(); ctx.roundRect(x,y,cardW,cardH,14); ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.roundRect(x,y,cardW,cardH,14); ctx.stroke();
      // Rarity badge
      ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x+6,y+6,dog.rarity.length*8+10,22,8); ctx.fill();
      ctx.font = 'bold 12px "Nunito", sans-serif'; ctx.fillStyle = 'white'; ctx.textAlign = 'left';
      ctx.fillText(dog.rarity, x+12, y+21);
      // Name
      ctx.font = 'bold 15px "Nunito", sans-serif'; ctx.fillStyle = '#1a1a2e'; ctx.textAlign = 'center';
      const nick = getDogNick(dog.id) || '';
      ctx.fillText(nick || dog.name, x + cardW/2, y+56);
      ctx.font = '12px "Nunito", sans-serif'; ctx.fillStyle = '#666';
      ctx.fillText(dog.breed, x + cardW/2, y+72);
      // Paw icon
      ctx.font = '32px serif'; ctx.fillText('🐱', x + cardW/2, y+105);
    });
    // Footer
    ctx.font = '15px "Nunito", sans-serif'; ctx.fillStyle = '#9ab89a'; ctx.textAlign = 'center';
    ctx.fillText('KittyMart — Catch, Train, Race! 🌿', W/2, H-18);
    setImgUrl(canvas.toDataURL('image/png'));
  }, [topDogs, player.username, dogs, totalPts]);

  const handleShare = async () => {
    if (!imgUrl) return;
    try {
      const blob = await (await fetch(imgUrl)).blob();
      const file = new File([blob], 'my-kitten-pack.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'My KittyMart Pack', text: `Check out my pack on KittyMart! 🐾` });
      } else {
        const a = document.createElement('a'); a.href = imgUrl; a.download = 'my-kitten-pack.png'; a.click();
      }
    } catch {}
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }} onClick={onClose}>
      <div style={{ background:'white', borderRadius:24, padding:20, maxWidth:420, width:'100%', textAlign:'center' }} onClick={e=>e.stopPropagation()}>
        <div style={{ fontWeight:'bold', fontSize:18, color:'#2d6a4f', marginBottom:12 }}>🐾 Share My Pack</div>
        <canvas ref={canvasRef} style={{ display:'none' }} />
        {imgUrl && <img src={imgUrl} alt="My Pack" style={{ width:'100%', borderRadius:16, marginBottom:12 }} />}
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={handleShare} style={{ flex:1, padding:'14px 0', background:'linear-gradient(135deg,#5aab6a,#4a9e5c)', color:'white', border:'none', borderRadius:14, fontSize:15, fontWeight:'bold', cursor:'pointer' }}>
            📤 Share / Save
          </button>
          <button onClick={onClose} style={{ flex:1, padding:'14px 0', background:'#eee', color:'#666', border:'none', borderRadius:14, fontSize:15, fontWeight:'bold', cursor:'pointer' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function CollectionScreen({ player, dogs, setDogs, onNavigateTrade, onNavigateSearch, playerScore, setPlayerScore, dogsLoadError, dogsLoaded }) {
  const [diaryDog, setDiaryDog] = React.useState(null);
  const [pendingDogIds, setPendingDogIds] = useState([]);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [toast, setToast] = useState(null);
  const [pooOverlay, setPooOverlay] = useState(null); // {rarity, pts}
  const [showCount, setShowCount] = useState({}); // cards shown per rarity (thousands of cards at once froze big accounts)
  const [, forceUpdate] = useState(0);
  const [trainingDog, setTrainingDog] = useState(null);
  const [breedSelect, setBreedSelect] = useState([]);
  const [breedOverlay, setBreedOverlay] = useState(null); // {breed, rarity}
  const [breeding, setBreeding] = useState(false);
  const [evolutionDog, setEvolutionDog] = useState(null); // dog that just evolved to Champion
  const [showSharePack, setShowSharePack] = useState(false);
  const [confirmDeleteDog, setConfirmDeleteDog] = useState(null); // dog to delete
  // Re-rendering every dog card on each training result lags big collections, so
  // skip refreshes while the training modal is open and refresh once when it closes.
  const trainingOpenRef = useRef(false);
  trainingOpenRef.current = !!trainingDog;
  useEffect(() => {
    const h = () => { if (!trainingOpenRef.current) forceUpdate(n => n + 1); };
    window.addEventListener('km_dog_change', h);
    return () => window.removeEventListener('km_dog_change', h);
  }, []);

  // Evolution celebration at Level 10
  useEffect(() => {
    const onEvo = (e) => {
      const dog = dogs.find(d => d.id === e.detail?.dogId);
      if (dog) { setEvolutionDog(dog); fireFireworks(3000); playSound("achievement"); }
    };
    window.addEventListener('km_evolution', onEvo);
    return () => window.removeEventListener('km_evolution', onEvo);
  }, [dogs]);

  useEffect(() => {
    sb(`trades?from_player_id=eq.${player.id}&status=eq.pending&select=dog_id,created_at`).then(rows => setPendingDogIds(rows.map(r => ({ id: r.dog_id, created_at: r.created_at })))).catch(() => {});
  }, [player.id, dogs]);

  // Consume any pending treat-bag purchases from the Mart (km_feed_rarity_<rarity>,
  // including "All" for the Ultra Treat Bag) — actually feeds the matching dogs.
  useEffect(() => {
    if (!dogs.length) return;
    const pendingKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('km_feed_rarity_')) pendingKeys.push(k);
    }
    if (!pendingKeys.length) return;
    let fedCount = 0;
    runBulk(() => pendingKeys.forEach(key => {
      const rarity = key.replace('km_feed_rarity_', '');
      const targets = rarity === 'All' ? dogs : dogs.filter(d => d.rarity === rarity);
      targets.forEach(d => {
        const s = getDogState(d.id);
        s.hunger = 100; s.lastFed = Date.now();
        saveDogState(d.id, s);
        fedCount++;
      });
      localStorage.removeItem(key);
    }));
    if (fedCount > 0) { forceUpdate(n => n + 1); showToast(`🍖 Fed ${fedCount} cat${fedCount === 1 ? '' : 's'}!`); }
  }, [dogs]);

  const grouped = {};
  [...dogs].sort((a, b) => a.name.localeCompare(b.name)).forEach(d => {
    if (!grouped[d.rarity]) grouped[d.rarity] = [];
    grouped[d.rarity].push(d);
  });

  // Include bonus points so this matches the header and Settings totals.
  const collectionBonusPts = useLive(getBonusPts, 'km_pts_change');
  const totalPoints = calcPoints(dogs) + collectionBonusPts;

  const handleDelete = (e, dog) => {
    e.stopPropagation();
    if (PROTECTED_DOG_IDS.has(dog.id)) {
      try { window.dispatchEvent(new CustomEvent('km_score_popup', { detail: { text: 'Tessa is protected 💛', color: '#764ba2' } })); } catch {}
      return;
    }
    setConfirmDeleteDog(dog);
  };

  const confirmDelete = async () => {
    if (!confirmDeleteDog) return;
    const dog = confirmDeleteDog;
    setConfirmDeleteDog(null);
    try { await sb(`cats?id=eq.${dog.id}`, 'DELETE'); } catch {}
    setDogs(prev => prev.filter(d => d.id !== dog.id));
  };

  const startRename = (e, dog) => {
    e.stopPropagation();
    setRenamingId(dog.id);
    setRenameValue(getDogNick(dog.id) || '');
  };

  const saveRename = (e, dogId) => {
    e.stopPropagation();
    setDogNick(dogId, renameValue);
    setRenamingId(null);
  };

  if (dogs.length === 0) return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={onNavigateSearch} style={{ flex: 1, padding: '10px', background: '#f0f0f0', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 'bold', cursor: 'pointer', color: '#333' }}>🔍 Search</button>
        <button onClick={onNavigateTrade} style={{ flex: 1, padding: '10px', background: '#f0f0f0', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 'bold', cursor: 'pointer', color: '#333' }}>🤝 Trade</button>
      </div>
      {showSharePack && <ShareMyPackModal player={player} dogs={dogs} onClose={() => setShowSharePack(false)} />}
      <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>
        <div style={{ fontSize: 60, marginBottom: 16 }}>{dogsLoadError ? '⚠️' : '🐈‍⬛'}</div>
        {/* While the dogs are still downloading (thousands of dogs take a while) don't claim the collection is empty. */}
        <p>{dogsLoadError ? 'Your cats couldn\'t be loaded — they\'re still safe! Use the Retry button above.' : (dogsLoaded === false ? 'Loading your cats…' : 'No cats yet! Go catch some!')}</p>
      </div>
    </div>
  );

  const showToast = (msg, dur=2000) => { setToast(msg); setTimeout(()=>setToast(null), dur); };

  const handleFeed = (e, dog) => {
    e.stopPropagation();
    const s = getDogState(dog.id);
    s.hunger = 100; s.lastFed = Date.now();
    saveDogState(dog.id, s);
    addXP(dog.id, 10, showToast);
    playPurr();
    showToast(`🍖 ${dog.name} fed! +10 XP`);
    try { localStorage.setItem('km_feed_count', (parseInt(localStorage.getItem('km_feed_count')||'0')+1).toString()); } catch {}
    recordChallenge('feed');
    addStarXP('feed');
    forceUpdate(n=>n+1);
  };

  // Cat-only: tuck a cat into its cosy bed for a nap (once per 6h per cat)
  const handleNap = (e, dog) => {
    e.stopPropagation();
    let naps = {}; try { naps = JSON.parse(localStorage.getItem('km_nap_times') || '{}'); } catch {}
    const left = 6 * 3600000 - (Date.now() - (naps[dog.id] || 0));
    if (left > 0) { showToast(`😴 ${dog.name} is still rested — nap again in ${Math.ceil(left / 3600000)}h`); return; }
    naps[dog.id] = Date.now();
    try { localStorage.setItem('km_nap_times', JSON.stringify(naps)); localStorage.setItem('km_nap_count', (parseInt(localStorage.getItem('km_nap_count')||'0')+1).toString()); } catch {}
    addXP(dog.id, 8, showToast);
    playPurr();
    showToast(`😴 ${dog.name} had a cosy nap! +8 XP`);
    forceUpdate(n=>n+1);
  };

  // Cat-only: give a cat a gentle pet (purrs; once per hour per cat)
  const handlePet = (e, dog) => {
    e.stopPropagation();
    let pets = {}; try { pets = JSON.parse(localStorage.getItem('km_pet_times') || '{}'); } catch {}
    const left = 3600000 - (Date.now() - (pets[dog.id] || 0));
    if (left > 0) { showToast(`💜 ${dog.name} is purring happily — pet again in ${Math.ceil(left / 60000)}m`); return; }
    pets[dog.id] = Date.now();
    try { localStorage.setItem('km_pet_times', JSON.stringify(pets)); } catch {}
    addXP(dog.id, 3, showToast);
    playPurr();
    showToast(`💜 ${dog.name} purrs loudly! +3 XP`);
    forceUpdate(n=>n+1);
  };

  const handlePoo = (e, dog) => {
    if (e) e.stopPropagation();
    const rarity = rollPooRarity();
    const s = getDogState(dog.id);
    s.lastPoo = Date.now();
    saveDogState(dog.id, s);
    addXP(dog.id, 5, showToast);
    try { localStorage.setItem('km_poo_count', (parseInt(localStorage.getItem('km_poo_count')||'0')+1).toString()); } catch {}
    addBonusPts(rarity.pts);
    recordChallenge('poo');
    addStarXP('poo');
    setPooOverlay({rarity:rarity.name, pts:rarity.pts});
    forceUpdate(n=>n+1);
    setTimeout(()=>setPooOverlay(null), 2500);
  };

  const toggleBreedSelect = (e, dog) => {
    e.stopPropagation();
    setBreedSelect(prev => prev.some(d=>d.id===dog.id) ? prev.filter(d=>d.id!==dog.id) : prev.length<2 ? [...prev,dog] : prev);
  };

  const handleBreed = async () => {
    if (breedSelect.length !== 2 || breeding) return;
    if (getBonusPts() < 50) { showToast('Not enough points to breed! You need 50 pts.'); return; }
    addBonusPts(-50);
    const [d1, d2] = breedSelect;
    const RARITY_ORDER = ['Common','Uncommon','Rare','Epic','Legendary'];
    const r1 = RARITY_ORDER.indexOf(d1.rarity);
    const r2 = RARITY_ORDER.indexOf(d2.rarity);
    const betterIdx = Math.max(r1,r2);
    const worseIdx = Math.min(r1,r2);
    const roll = Math.random();
    let chosenIdx;
    if (r1 === r2) {
      // Same rarity parents: 50% same, 30% one above, 20% random
      if (roll < 0.50) chosenIdx = betterIdx;
      else if (roll < 0.80) chosenIdx = Math.min(betterIdx + 1, RARITY_ORDER.length - 1);
      else chosenIdx = Math.floor(Math.random() * RARITY_ORDER.length);
    } else {
      if (roll < 0.45) chosenIdx = betterIdx;
      else if (roll < 0.80) chosenIdx = worseIdx;
      else chosenIdx = Math.min(betterIdx + 1, RARITY_ORDER.length - 1);
    }
    const chosenRarity = RARITY_ORDER[chosenIdx];

    // Known breed crosses → specific offspring breed
    const BREED_CROSSES = {
      'King Charles Cavalier+Poodle': 'Cavoodle',
      'Poodle+King Charles Cavalier': 'Cavoodle',
      'King Charles Cavalier+Miniature Poodle': 'Cavoodle',
      'Miniature Poodle+King Charles Cavalier': 'Cavoodle',
      'King Charles Cavalier+Toy Poodle': 'Cavoodle',
      'Toy Poodle+King Charles Cavalier': 'Cavoodle',
      'Cocker Spaniel+Poodle': 'Cockapoo',
      'Poodle+Cocker Spaniel': 'Cockapoo',
      'Cocker Spaniel+Miniature Poodle': 'Cockapoo',
      'Miniature Poodle+Cocker Spaniel': 'Cockapoo',
      'Pug+Beagle': 'Puggle',
      'Beagle+Pug': 'Puggle',
      'Golden Retriever+Poodle': 'Goldendoodle',
      'Poodle+Golden Retriever': 'Goldendoodle',
      'Labrador Retriever+Poodle': 'Labradoodle',
      'Poodle+Labrador Retriever': 'Labradoodle',
    };
    const crossKey = `${d1.breed}+${d2.breed}`;
    const crossBreedName = BREED_CROSSES[crossKey];
    let breedInfo;
    if (crossBreedName) {
      breedInfo = DOG_BREEDS.find(b => b.name === crossBreedName) || DOG_BREEDS.filter(b=>b.rarity===chosenRarity)[Math.floor(Math.random()*DOG_BREEDS.filter(b=>b.rarity===chosenRarity).length)] || DOG_BREEDS[0];
    } else {
      const pool = DOG_BREEDS.filter(b=>b.rarity===chosenRarity);
      breedInfo = pool[Math.floor(Math.random()*pool.length)] || DOG_BREEDS[0];
    }

    const gender = Math.random()<0.5?'Male':'Female';
    const name = crossBreedName ? `${crossBreedName} Kitten` : `Kitten of ${d1.name} & ${d2.name}`;
    setBreeding(true);
    try {
      // Fetch a real photo for the offspring
      const photoUrl = await fetchBreedPhoto(breedInfo);
      const created = await sb('cats','POST',{owner_id:player.id,name,breed:breedInfo.name,rarity:breedInfo.rarity||chosenRarity,photo_url:photoUrl||breedInfo.api,caught_at:new Date().toISOString()});
      if (created && created[0]) { setDogGender(created[0].id, gender); setDogs(prev=>[...prev,created[0]]); }
      try { localStorage.setItem('km_bred','true'); } catch {}
      setBreedSelect([]);
      setBreedOverlay({breed:breedInfo.name, rarity:chosenRarity});
      setTimeout(()=>setBreedOverlay(null),3000);
    } catch(e) { showToast('Error: '+e.message); }
    setBreeding(false);
  };

  return (
    <div style={{ padding: 16 }}>
      {toast && <div style={{position:'fixed',top:80,left:'50%',transform:'translateX(-50%)',background:'#764ba2',color:'white',borderRadius:20,padding:'10px 20px',fontWeight:'bold',fontSize:14,zIndex:999,whiteSpace:'nowrap',boxShadow:'0 4px 20px rgba(0,0,0,0.3)'}}>{toast}</div>}
      {pooOverlay && <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:12}}>
        <div style={{fontSize:64}}>🧹</div>
        <div style={{fontSize:24,fontWeight:'bold',color:POO_COLORS[pooOverlay.rarity]||'#fff'}}>{pooOverlay.rarity} Litter Tray!</div>
        <div style={{fontSize:20,color:'#fff',fontWeight:'bold'}}>+{pooOverlay.pts} pts!</div>
      </div>}
      {breedOverlay && <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.75)',zIndex:1001,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:12}}>
        <div style={{fontSize:64}}>🎉</div>
        <div style={{fontSize:22,fontWeight:'bold',color:'#ffd700',textAlign:'center'}}>Your kitten {breedOverlay.breed} was born!</div>
        <div style={{fontSize:16,color:'#fff'}}>It's {breedOverlay.rarity}!</div>
      </div>}
      {evolutionDog && (
        <div onClick={() => setEvolutionDog(null)} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.85)',zIndex:1002,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:14,cursor:'pointer'}}>
          <div style={{fontSize:72, animation:'spin 1s linear infinite', display:'inline-block'}}>✨</div>
          <div style={{fontSize:28,fontWeight:'bold',color:'#ffd700',textAlign:'center',textShadow:'0 0 20px #ffd700'}}>
            👑 Champion! 👑
          </div>
          <div style={{fontSize:20,color:'#fff',fontWeight:'bold',textAlign:'center'}}>
            {getDogNick(evolutionDog.id) || evolutionDog.name}
          </div>
          <div style={{fontSize:14,color:'#ffd70099',textAlign:'center'}}>reached Level 10!</div>
          <img src={localStorage.getItem(`km_photo_${evolutionDog.id}`) || evolutionDog.photo_url} alt="" style={{width:100,height:100,objectFit:'cover',borderRadius:'50%',border:'4px solid #ffd700',boxShadow:'0 0 30px #ffd700'}} onError={e=>e.target.style.display='none'} />
          <div style={{fontSize:13,color:'#aaa',marginTop:8}}>Tap to continue</div>
        </div>
      )}
      {breedSelect.length===2 && !breedOverlay && (
        <div style={{position:'fixed',bottom:70,left:'50%',transform:'translateX(-50%)',background:'linear-gradient(135deg,#667eea,#764ba2)',color:'white',borderRadius:20,padding:'12px 20px',zIndex:900,boxShadow:'0 4px 24px rgba(0,0,0,0.3)',display:'flex',flexDirection:'column',alignItems:'center',gap:8,maxWidth:340,width:'calc(100% - 40px)'}}>
          <div style={{fontWeight:'bold',fontSize:13}}>🧬 Breed {breedSelect[0].name} × {breedSelect[1].name} → Kitten!</div>
          <div style={{display:'flex',gap:10}}>
            <button onClick={handleBreed} disabled={breeding} style={{padding:'8px 18px',background:'#ffd700',color:'#333',border:'none',borderRadius:12,fontWeight:'bold',fontSize:13,cursor:'pointer'}}>Breed Now! (Cost: 50pts)</button>
            <button onClick={()=>setBreedSelect([])} style={{padding:'8px 12px',background:'rgba(255,255,255,0.2)',color:'white',border:'none',borderRadius:12,fontSize:13,cursor:'pointer'}}>✕</button>
          </div>
        </div>
      )}
      {trainingDog && <TrainDogModal dog={trainingDog} onClose={()=>{ setTrainingDog(null); forceUpdate(n => n + 1); }} setToast={showToast} />}
      {showSharePack && <ShareMyPackModal player={player} dogs={dogs} onClose={() => setShowSharePack(false)} />}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button onClick={onNavigateSearch} style={{ flex: 1, padding: '10px', background: '#f0f0f0', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 'bold', cursor: 'pointer', color: '#333' }}>🔍 Search</button>
        <button onClick={onNavigateTrade} style={{ flex: 1, padding: '10px', background: '#f0f0f0', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 'bold', cursor: 'pointer', color: '#333' }}>🤝 Trade</button>
        <button onClick={() => setShowSharePack(true)} style={{ flex: 1, padding: '10px', background: 'linear-gradient(135deg,#5aab6a,#4a9e5c)', color: 'white', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>📤 Share</button>
      </div>
      <div style={{ background: 'linear-gradient(135deg, #5aab6a22, #4a9e5c22)', border: '2px solid #5aab6a44', borderRadius: 16, padding: '12px 16px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div><div style={{ fontWeight: 'bold', color: '#333', fontSize: 16 }}>🐱 {dogs.length} cats</div><div style={{ color: '#4a9e5c', fontSize: 13 }}>⭐ {totalPoints} points</div></div>
        <div style={{ textAlign: 'right', fontSize: 12, color: '#888' }}>🏪 Store open!</div>
      </div>
      {['Legendary','Epic','Rare','Uncommon','Common'].map(rarity => grouped[rarity] && (
        <div key={rarity}>
          <h3 style={{ color: RARITY_COLORS[rarity], margin: '16px 0 8px', fontSize: 14, textTransform: 'uppercase', letterSpacing: 1 }}>{rarity} · {RARITY_POINTS[rarity]}pts each ({grouped[rarity].length})</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
            {grouped[rarity].slice(0, showCount[rarity] || 90).map(dog => {
              const pendingEntry = pendingDogIds.find(p => (p.id || p) === dog.id);
              const isPending = !!pendingEntry;
              const isFav = localStorage.getItem('km_fav_'+dog.id) === '1';
              const nick = getDogNick(dog.id) || '';
              const isRenaming = renamingId === dog.id;
              const ds = getDogState(dog.id);
              const currentHunger = calcHunger(ds);
              const hungerColor = currentHunger > 60 ? '#52b788' : currentHunger > 30 ? '#f4a261' : '#e63946';
              const hoursSinceFed = (Date.now() - (ds.lastFed||0)) / 3600000;
              const needsPoo = hoursSinceFed > 4 && (ds.lastFed === 0 ? !ds.lastPoo : ds.lastPoo < ds.lastFed);
              const isChampion = ds.level >= 10;
              return (
                <div key={dog.id} onClick={() => setDiaryDog(dog)} style={{ position:'relative', background: isChampion ? 'linear-gradient(135deg,#fffbea,#fff8dc)' : isPending ? '#f5f5f5' : '#fff', border: isChampion ? '2px solid #ffd700' : `2px solid ${isPending ? '#ccc' : RARITY_COLORS[rarity] + '55'}`, borderRadius: 14, padding: 10, textAlign: 'center', opacity: isPending ? 0.7 : 1, cursor:'pointer', boxShadow: isChampion ? '0 0 12px rgba(255,215,0,0.5)' : 'none' }}>
                  {isChampion && <span style={{position:'absolute',top:4,left:4,fontSize:12,zIndex:3}}>👑</span>}
                  {isFav && <span style={{position:'absolute',top:6,right:6,fontSize:14}}>❤️</span>}
                  {(() => { const cos = getDogCosmetics(dog.id); const hat = cos.hat ? COSMETICS.find(c=>c.id===cos.hat) : null; const extra = ['collar','acc'].map(k => cos[k] ? COSMETICS.find(c=>c.id===cos[k]) : null).filter(Boolean); return <>{hat && <span style={{position:'absolute',top:-4,left:'50%',transform:'translateX(-50%)',fontSize:18,zIndex:2}}>{hat.emoji}</span>}{extra.length > 0 && <span style={{position:'absolute',top:62,left:'50%',transform:'translateX(-50%)',fontSize:14,zIndex:2,whiteSpace:'nowrap'}}>{extra.map(c=>c.emoji).join('')}</span>}</>; })()}
                  <img loading="lazy" decoding="async" src={dogImageSrc(dog) || dog.photo_url} alt={dog.name} style={{ width: 70, height: 70, objectFit: 'cover', borderRadius: '50%', border: isChampion ? '3px solid #ffd700' : `3px solid ${isPending ? '#ccc' : RARITY_COLORS[rarity]}`, filter: isPending ? 'grayscale(60%)' : isChampion ? 'drop-shadow(0 0 6px #ffd700)' : 'none' }} onError={e => e.target.style.display='none'} />
                  {nick && <div style={{ fontSize: 11, fontWeight: 'bold', color: '#764ba2', marginTop: 4 }}>{nick}</div>}
                  <div style={{ fontSize: 11, fontWeight: 'bold', color: '#333', marginTop: nick ? 1 : 6 }}>{dog.name}</div>
                  {(() => { let g = getDogGender(dog.id); if (!g) { g = Math.random()<0.5?'Male':'Female'; try { setDogGender(dog.id, g); } catch {} } return <div style={{ fontSize: 10, color: g === 'Male' ? '#4a90e2' : '#e26b9a' }}>{g === 'Male' ? '♂' : '♀'} {g}</div>; })()}
                  <div style={{ fontSize: 10, color: isPending ? '#aaa' : RARITY_COLORS[rarity], marginBottom: 4 }}>{isPending ? (() => { const msLeft = 24*3600000 - (Date.now() - new Date(pendingEntry?.created_at||Date.now()).getTime()); const h = Math.max(0,Math.floor(msLeft/3600000)); return `⏳ Pending · ${h}h left`; })() : dog.rarity}</div>
                  {/* Level badge — gold for Champion */}
                  <div style={{display:'inline-block',background: isChampion ? 'linear-gradient(135deg,#ffd700,#f4a261)' : '#667eea',color:'white',borderRadius:20,padding:'2px 8px',fontSize:10,fontWeight:'bold',marginBottom:4}}>
                    {isChampion ? `✨ Champion Lv.${ds.level}` : `Lv.${ds.level}`}
                  </div>
                  {/* Hunger bar */}
                  <div style={{height:5,background:'#eee',borderRadius:4,overflow:'hidden',marginBottom:6,marginTop:2}}>
                    <div style={{height:'100%',width:`${Math.round(currentHunger)}%`,background:hungerColor,borderRadius:4,transition:'width 0.3s'}} />
                  </div>
                  {/* Feed & poo buttons */}
                  <div style={{display:'flex',gap:3,flexWrap:'wrap',justifyContent:'center',marginBottom:3}} onClick={e=>e.stopPropagation()}>
                    <button onClick={e=>handleFeed(e,dog)} style={{flex:1,padding:'3px 4px',background:'#fff3e0',border:'1px solid #f4a261',borderRadius:7,fontSize:10,cursor:'pointer',color:'#e76f51',fontWeight:'bold'}}>🐟 Feed</button>
                    <button onClick={e=>handlePet(e,dog)} aria-label="Pet" style={{padding:'3px 6px',background:'#fce4ec',border:'1px solid #f48fb1',borderRadius:7,fontSize:11,cursor:'pointer'}}>💜</button>
                    <button onClick={e=>handleNap(e,dog)} aria-label="Nap" style={{padding:'3px 6px',background:'#ede7f6',border:'1px solid #b39ddb',borderRadius:7,fontSize:11,cursor:'pointer'}}>😴</button>
                    {needsPoo && <button onClick={e=>handlePoo(e,dog)} style={{padding:'3px 6px',background:'#fff8e1',border:'1px solid #f59e0b',borderRadius:7,fontSize:12,cursor:'pointer'}}>🧹</button>}
                  </div>
                  {isRenaming ? (
                    <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 3, marginBottom: 4 }}>
                      <input value={renameValue} onChange={e => setRenameValue(e.target.value)} placeholder="Nickname" style={{ flex: 1, fontSize: 10, padding: '2px 4px', borderRadius: 6, border: '1px solid #c39bd3', outline: 'none', width: 0 }} />
                      <button onClick={e => saveRename(e, dog.id)} style={{ padding: '2px 5px', background: '#764ba2', color: 'white', border: 'none', borderRadius: 6, fontSize: 10, cursor: 'pointer' }}>✓</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 3, justifyContent: 'center', marginBottom: 2 }} onClick={e=>e.stopPropagation()}>
                      <button onClick={e => { e.stopPropagation(); startRename(e, dog); }} style={{ padding: '3px 5px', background: '#f0e8ff', color: '#764ba2', border: 'none', borderRadius: 7, fontSize: 10, cursor: 'pointer' }}>✏️</button>
                      <button onClick={e => { e.stopPropagation(); setTrainingDog(dog); }} style={{ padding: '3px 5px', background: '#e8f5e9', color: '#2d6a4f', border: 'none', borderRadius: 7, fontSize: 10, cursor: 'pointer' }}>🎓</button>
                      <button onClick={e => toggleBreedSelect(e, dog)} style={{ padding: '3px 5px', background: breedSelect.some(d=>d.id===dog.id)?'#ffd700':'#f5f5dc', color: '#333', border: 'none', borderRadius: 7, fontSize: 10, cursor: 'pointer' }}>🧬</button>
                      <button onClick={e => handleDelete(e, dog)} style={{ padding: '3px 5px', background: '#ffe8e8', color: '#e63946', border: 'none', borderRadius: 7, fontSize: 10, cursor: 'pointer' }}>🗑️</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {grouped[rarity].length > (showCount[rarity] || 90) && (
            <button onClick={() => setShowCount(c => ({ ...c, [rarity]: (c[rarity] || 90) + 90 }))} style={{ width: '100%', marginTop: 10, padding: 12, background: '#f0e8ff', color: '#764ba2', border: 'none', borderRadius: 12, fontWeight: 'bold', fontSize: 14, cursor: 'pointer' }}>
              Show more ({grouped[rarity].length - (showCount[rarity] || 90)} left)
            </button>
          )}
        </div>
      ))}
      {diaryDog && <DogDiaryModal dog={diaryDog} onClose={() => setDiaryDog(null)} showToast={showToast} />}
      {confirmDeleteDog && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: 'white', borderRadius: 20, padding: 28, width: '100%', maxWidth: 320, textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
            <div style={{ fontSize: 44, marginBottom: 8 }}>🗑️</div>
            <div style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 6 }}>Delete {confirmDeleteDog.name}?</div>
            <div style={{ fontSize: 13, color: '#888', marginBottom: 20 }}>This cannot be undone.</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setConfirmDeleteDog(null)} style={{ flex: 1, padding: 14, background: '#eee', border: 'none', borderRadius: 14, fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}>Cancel</button>
              <button onClick={confirmDelete} style={{ flex: 1, padding: 14, background: '#e53e3e', color: 'white', border: 'none', borderRadius: 14, fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Search Screen ────────────────────────────────────────────────────────────
function SearchScreen() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [selected, setSelected] = useState(null);
  const [searchPhoto, setSearchPhoto] = useState(null);

  const search = () => {
    const q = query.trim().toLowerCase();
    if (!q) return;
    const matches = DOG_BREEDS.filter(b => b.name.toLowerCase().includes(q));
    setResults(matches);
    if (matches.length === 1) selectBreed(matches[0]);
    else setSelected(null);
  };

  const selectBreed = async (breed) => {
    setSelected(breed);
    setSearchPhoto(null);
    const url = await fetchBreedPhoto(breed);
    setSearchPhoto(url);
  };

  const sortedBreeds = [...DOG_BREEDS].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 4px', color: '#333', textAlign: 'center' }}>Cat Encyclopedia 🔍</h2>
      <p style={{ margin: '0 0 16px', color: '#888', fontSize: 13, textAlign: 'center' }}>Search any breed for fun facts!</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} placeholder="e.g. Corgi, Husky, Poodle..." style={{ flex: 1, padding: '12px', borderRadius: 12, border: '2px solid #e0d0ff', fontSize: 15, outline: 'none', boxSizing: 'border-box' }} />
        <button onClick={search} style={{ padding: '12px 18px', background: 'linear-gradient(135deg, #667eea, #764ba2)', color: 'white', border: 'none', borderRadius: 12, fontSize: 18, cursor: 'pointer' }}>🔍</button>
      </div>
      {results === null && (
        <div>
          <p style={{ color: '#aaa', fontSize: 13, marginBottom: 10 }}>All breeds A–Z:</p>
          {['Legendary','Epic','Rare','Uncommon','Common'].map(rarity => (
            <div key={rarity} style={{ marginBottom: 12 }}>
              <div style={{ color: RARITY_COLORS[rarity], fontWeight: 'bold', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{rarity}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {sortedBreeds.filter(b => b.rarity === rarity).map(b => (
                  <button key={b.name} onClick={() => { setQuery(b.name); selectBreed(b); setResults([b]); }} style={{ padding: '6px 12px', background: '#f5f0ff', border: `1.5px solid ${RARITY_COLORS[rarity]}44`, borderRadius: 20, fontSize: 12, cursor: 'pointer', color: '#333' }}>{b.name}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {results !== null && results.length === 0 && <p style={{ textAlign: 'center', color: '#aaa' }}>No breeds found!</p>}
      {results !== null && results.length > 1 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {results.map(b => <button key={b.name} onClick={() => selectBreed(b)} style={{ padding: '8px 14px', background: selected?.name === b.name ? '#764ba2' : '#f0f0f0', color: selected?.name === b.name ? 'white' : '#333', border: 'none', borderRadius: 20, cursor: 'pointer', fontSize: 13, fontWeight: 'bold' }}>{b.name}</button>)}
        </div>
      )}
      {selected && (
        <div style={{ background: 'white', borderRadius: 20, overflow: 'hidden', boxShadow: '0 4px 20px rgba(0,0,0,0.1)', border: `2px solid ${RARITY_COLORS[selected.rarity]}44` }}>
          <div style={{ background: `linear-gradient(135deg, ${RARITY_COLORS[selected.rarity]}22, ${RARITY_COLORS[selected.rarity]}08)`, padding: 20, textAlign: 'center' }}>
            {searchPhoto
              ? <img src={searchPhoto} alt={selected.name} style={{ width: 120, height: 120, borderRadius: '50%', objectFit: 'cover', border: `4px solid ${RARITY_COLORS[selected.rarity]}`, margin: '0 auto 12px', display: 'block' }} />
              : <div style={{ width: 120, height: 120, borderRadius: '50%', background: '#f0f0f0', margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 40 }}>🐾</div>
            }
            <h3 style={{ margin: '0 0 4px', color: '#333', fontSize: 20 }}>{selected.name}</h3>
            <span style={{ display: 'inline-block', padding: '4px 12px', background: RARITY_COLORS[selected.rarity], color: selected.rarity === 'Legendary' ? '#333' : 'white', borderRadius: 20, fontSize: 12, fontWeight: 'bold' }}>{selected.rarity}</span>
            <div style={{ marginTop: 6, fontSize: 13, color: '#764ba2', fontWeight: 'bold' }}>⭐ Worth {RARITY_POINTS[selected.rarity]} point{RARITY_POINTS[selected.rarity] === 1 ? '' : 's'}</div>
            <div style={{ marginTop: 4, fontSize: 11, color: '#888' }}>Found at: {Object.entries(ZONE_BREEDS).filter(([,v]) => v.includes(selected.name)).map(([k]) => ZONES[k]?.label).join(' · ') || '🏠 Home'}</div>
          </div>
          <div style={{ padding: 16 }}>
            <h4 style={{ margin: '0 0 10px', color: '#764ba2', fontSize: 14 }}>🐾 Fun Facts</h4>
            {selected.facts.map((fact, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 10, padding: '10px 12px', background: '#f9f5ff', borderRadius: 10 }}>
                <span style={{ fontSize: 16, flexShrink: 0 }}>{'🐟🐱✨'[i]}</span>
                <p style={{ margin: 0, fontSize: 13, color: '#444', lineHeight: 1.5 }}>{fact}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Marketplace Screen ───────────────────────────────────────────────────────
// ─── Store Screen ─────────────────────────────────────────────────────────────
function MartScreen({ dogs, totalPoints }) {
  const [section, setSection] = useState('powerups');
  const dd = useLive(getDD, 'km_dd_change');
  const [msg, setMsg] = useState('');
  const [popupMsg, setPopupMsg] = useState('');
  const showMsg = (m) => { haptic('light'); setMsg(m); setTimeout(() => setMsg(''), 2500); };
  // For purchase results — needs to be actively dismissed so it can't be missed like a fading banner.
  const showPopup = (m) => { haptic('success'); setPopupMsg(m); };

  const SECTION_TABS = [
    { id: 'powerups',   label: '⚡ Power-Ups' },
    { id: 'cosy',       label: '🧶 Cosy Pack' },
  ];
  const [ownedCosmetics, setOwnedCosmetics] = useState(() => getOwnedCosmetics());
  const [packOwned, setPackOwned] = useState(() => hasCosyPack());
  const [showPackGate, setShowPackGate] = useState(false);
  const [dressCat, setDressCat] = useState('');
  const [, bumpDress] = useState(0);
  const doBuyPack = async () => {
    setShowPackGate(false);
    try {
      if (window.KM_IAP && window.KM_IAP.purchase) { const ok = await window.KM_IAP.purchase('cosy_cat_pack'); if (ok) { grantCosyPack(); setPackOwned(true); showPopup('🧶 Cosy Cat Pack unlocked! Dress up your cats below.'); } return; }
      if (/[?&]testpack=1/.test(window.location.search)) { grantCosyPack(); setPackOwned(true); showPopup('🧶 (Test mode) Cosy Cat Pack unlocked!'); return; }
      showMsg('Purchases are available in the App Store version of KittyMart.');
    } catch { showMsg('Purchase did not go through. You were not charged.'); }
  };
  const doRestorePack = async () => {
    try { if (window.KM_IAP && window.KM_IAP.restore && await window.KM_IAP.restore()) { grantCosyPack(); setPackOwned(true); showPopup('Purchase restored!'); return; } } catch {}
    showMsg('No previous purchase found.');
  };

  return (
    <div style={{ padding: 16 }}>
      {/* Header */}
      <div style={{ background: 'linear-gradient(135deg,#764ba2,#667eea)', borderRadius: 20, padding: '16px 16px 12px', marginBottom: 14, textAlign: 'center', color: 'white' }}>
        <div style={{ fontSize: 28, marginBottom: 2 }}>🛒</div>
        <div style={{ fontSize: 20, fontWeight: 'bold' }}>The KittyMart</div>
        <div style={{ fontSize: 14, fontWeight: 'bold', marginTop: 4, color: '#ffd700' }}><DDIcon size={16} />{dd} Kitty Coins</div>
        <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>Earned by winning races · spend only here</div>
      </div>

      {msg && <div style={{ background: 'linear-gradient(135deg,#52b788,#2d6a4f)', color: 'white', borderRadius: 12, padding: '10px 14px', marginBottom: 12, fontWeight: 'bold', fontSize: 13, textAlign: 'center' }}>{msg}</div>}

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {SECTION_TABS.map(t => (
          <button key={t.id} onClick={() => setSection(t.id)}
            style={{ flex: 1, padding: '10px 4px', border: 'none', borderRadius: 12, fontWeight: 'bold', fontSize: 12, cursor: 'pointer', background: section === t.id ? 'linear-gradient(135deg,#667eea,#764ba2)' : '#f0f0f0', color: section === t.id ? 'white' : '#666', transition: 'all 0.15s' }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Cosy Cat Pack (one-time purchase) ── */}
      {section === 'cosy' && (
        <div>
          <div style={{ background: 'linear-gradient(135deg,#f4a261,#e76f51)', borderRadius: 20, padding: 16, color: 'white', textAlign: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 34 }}>🧶🧣🔔🛏️</div>
            <div style={{ fontSize: 18, fontWeight: 'bold', margin: '4px 0' }}>Cosy Cat Pack</div>
            <div style={{ fontSize: 13, opacity: 0.95, marginBottom: 10 }}>4 snuggly dress-up items for your cats: Yarn Beanie, Jingle Bell, Cosy Scarf and Blanket Cape. One-time purchase, no subscription.</div>
            {packOwned
              ? <div style={{ background: 'rgba(255,255,255,0.25)', borderRadius: 14, padding: '10px', fontWeight: 'bold' }}>✅ You own the Cosy Cat Pack</div>
              : <button onClick={() => setShowPackGate(true)} style={{ background: 'white', color: '#e76f51', border: 'none', borderRadius: 20, padding: '10px 26px', fontWeight: 'bold', fontSize: 15, cursor: 'pointer' }}>Get for {COSY_PACK_PRICE}</button>}
            {!packOwned && <div style={{ marginTop: 10 }}><button onClick={doRestorePack} style={{ background: 'none', border: 'none', color: 'white', textDecoration: 'underline', fontSize: 12, cursor: 'pointer' }}>Restore purchase</button></div>}
            {!packOwned && <div style={{ fontSize: 11, opacity: 0.85, marginTop: 6 }}>A grown-up must approve purchases.</div>}
          </div>
          {packOwned && (() => {
            const cat = (dogs || []).find(d => String(d.id) === String(dressCat));
            const cos = cat ? getDogCosmetics(cat.id) : {};
            return (
              <div style={{ background: 'white', borderRadius: 16, padding: 14, boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
                <div style={{ fontWeight: 'bold', color: '#764ba2', marginBottom: 8 }}>🎀 Dress up a cat</div>
                <select value={dressCat} onChange={e => setDressCat(e.target.value)} style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #ddd', fontSize: 14, marginBottom: 10 }}>
                  <option value="">Choose a cat…</option>
                  {(dogs || []).slice(0, 200).map(d => <option key={d.id} value={d.id}>{getDogNick(d.id) || d.breed} ({d.breed})</option>)}
                </select>
                {cat && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {COSMETICS.filter(c => c.pack === 'cosy').map(c => {
                    const on = cos[c.slot] === c.id;
                    return <button key={c.id} onClick={() => { const n = { ...cos }; if (on) delete n[c.slot]; else n[c.slot] = c.id; setDogCosmetics(cat.id, n); try { window.dispatchEvent(new Event('km_dog_change')); } catch {} bumpDress(x => x + 1); }}
                      style={{ flex: '1 1 40%', padding: '10px 6px', borderRadius: 12, border: on ? '2px solid #52b788' : '2px solid #eee', background: on ? '#e8f8ef' : '#fafafa', cursor: 'pointer', fontSize: 13 }}>
                      <div style={{ fontSize: 24 }}>{c.emoji}</div><div style={{ fontWeight: 'bold' }}>{c.name}</div><div style={{ fontSize: 11, color: '#777' }}>{on ? 'Wearing ✓' : 'Tap to wear'}</div>
                    </button>;
                  })}
                </div>}
              </div>
            );
          })()}
          {showPackGate && <ParentalGateModal onClose={() => setShowPackGate(false)} onSuccess={doBuyPack} />}
        </div>
      )}

      {/* ── Power-Ups section ── */}
      {section === 'powerups' && (
        <div>
          <p style={{ color: '#888', fontSize: 13, margin: '0 0 12px' }}>Power-Ups give temporary boosts during gameplay.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {POWERUPS.map(p => {
              const canAfford = dd >= p.cost;
              const boosts = (() => { try { return JSON.parse(localStorage.getItem('km_boosts') || '{}'); } catch { return {}; } })();
              const active = boosts[p.id] && Date.now() < boosts[p.id];
              const buyPU = () => {
                if (!canAfford) { showMsg(`Need ${p.cost}${DD} — win races to earn Kitty Coins!`); return; }
                addDD(-p.cost);
                haptic('success');
                if (p.duration > 0) {
                  const b = { ...boosts, [p.id]: Date.now() + p.duration * 1000 };
                  try { localStorage.setItem('km_boosts', JSON.stringify(b)); } catch {}
                  showPopup(`${p.label} activated!`);
                } else if (p.id === 'pooper_scooper') {
                  const now = Date.now();
                  const targets = dogs.filter(dog => {
                    const ds = getDogState(dog.id);
                    const lastFed = ds.lastFed || 0;
                    const lastPoo = ds.lastPoo || 0;
                    const hoursSinceFed = (now - lastFed) / 3600000;
                    if (lastFed === 0) return lastPoo === 0;
                    return hoursSinceFed > 4 && lastPoo < lastFed;
                  });
                  if (targets.length === 0) { showMsg('No litter to clean right now!'); addDD(p.cost); logPurchase(p.label, p.cost, 'returned: nothing to collect'); return; }
                  let totalPts = 0;
                  const failedLocal = runBulk(() => targets.forEach(dog => {
                    const rarity = rollPooRarity();
                    const s = getDogState(dog.id); s.lastPoo = now; saveDogState(dog.id, s);
                    try { localStorage.setItem('km_poo_count', (parseInt(localStorage.getItem('km_poo_count')||'0')+1).toString()); } catch {}
                    totalPts += rarity.pts;
                  }));
                  if (failedLocal > 0) { addDD(p.cost); logPurchase(p.label, p.cost, 'returned: phone storage full'); showPopup(`⚠️ ${p.label} could not update ${failedLocal} cats because the game's saved-data space on this phone is full. Your ${p.cost} Kitty Coins were returned.`); return; }
                  logPurchase(p.label, p.cost, `applied to ${targets.length} cats`);
                  addBonusPts(totalPts);
                  showPopup(`${p.label} cleaned ${targets.length} litter tray${targets.length>1?'s':''}! +${totalPts}⭐ earned`);
                } else if (p.id === 'xp_potion') {
                  const best = dogs.reduce((b, d) => { const s = getDogState(d.id); return (!b || (s.level||1) > (b.lvl||1)) ? {id:d.id, name:d.name, lvl:(s.level||1)} : b; }, null);
                  if (best) { const s = getDogState(best.id); s.xp = (s.xp||0)+100; saveDogState(best.id, s); showPopup(`${p.label} gave +100 XP to ${best.name}!`); }
                  else showMsg('No cats to give XP to!');
                } else if (p.rarity) {
                  const targets = p.rarity === 'All' ? dogs : dogs.filter(d => d.rarity === p.rarity);
                  if (targets.length === 0) { showMsg(p.rarity === 'All' ? 'No cats to feed!' : `No ${p.rarity} cats to feed!`); addDD(p.cost); return; }
                  const failedLocal = runBulk(() => targets.forEach(d => { const s = getDogState(d.id); s.hunger = 100; s.lastFed = Date.now(); saveDogState(d.id, s); }));
      if (failedLocal > 0) { addDD(p.cost); logPurchase(p.label, p.cost, 'returned: phone storage full'); showPopup(`⚠️ ${p.label} could not update ${failedLocal} cats because the game's saved-data space on this phone is full. Your ${p.cost} Kitty Coins were returned.`); return; }
      logPurchase(p.label, p.cost, `applied to ${targets.length} cats`);
                  showPopup(p.rarity === 'All' ? `${p.label} has fed all your cats!` : `${p.label} has fed all your ${p.rarity} cats!`);
                } else {
                  showPopup(`${p.label} activated!`);
                }
              };
              return (
                <div key={p.id} style={{ background: active ? '#d4edda' : 'white', border: `2px solid ${active ? '#28a745' : '#e0d0ff'}`, borderRadius: 14, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ fontSize: 32 }}>{p.label.split(' ')[0]}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: 13, color: '#333' }}>{p.label}</div>
                    <div style={{ fontSize: 11, color: '#888' }}>{p.desc}</div>
                    {active && <div style={{ fontSize: 10, color: '#28a745', fontWeight: 'bold' }}>⚡ Active!</div>}
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontWeight: 'bold', color: '#f4a261', fontSize: 12, marginBottom: 4 }}><DDIcon size={12} />{p.cost}</div>
                    <button onClick={buyPU}
                      style={{ padding: '7px 14px', background: canAfford ? 'linear-gradient(135deg,#f4a261,#e76f51)' : '#eee', color: canAfford ? 'white' : '#aaa', border: 'none', borderRadius: 10, fontWeight: 'bold', fontSize: 12, cursor: canAfford ? 'pointer' : 'not-allowed' }}>
                      {active ? 'Restock' : 'Buy'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {popupMsg && <AlertPopup message={popupMsg} onClose={() => setPopupMsg('')} />}
    </div>
  );
}


// ─── Leaderboard Screen ───────────────────────────────────────────────────────
function LeaderboardScreen({ currentPlayer, myTotalPts: myTotalPtsProp, onlineIds = new Set() }) {
  const [board, setBoard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('points');
  const [refreshKey, setRefreshKey] = useState(0);
  const [profileUser, setProfileUser] = useState(null); // tap a player to see their profile (Report / Block live there)

  useEffect(() => {
    const load = async () => {
      if (board.length === 0) setLoading(true); // only show spinner on first load
      try {
        setError('');

        // Fetch players with all stats columns
        let players;
        // (the first attempt used to ask for a login_streak column that does not exist, which failed on every open)
        try { players = await sb('players?select=id,username,race_wins,training_pts,total_pts&limit=200'); }
        catch { try { players = await sb('players?select=id,username,race_wins,training_pts,total_pts&limit=200'); } catch { try { players = await sb('players?select=id,username,race_wins,training_pts&limit=200'); } catch { players = await sb('players?select=id,username&limit=200'); } } }
        const blockedIds = getBlockedPlayers();
        const pArr = (Array.isArray(players) ? players : []).filter(p => !blockedIds.includes(p.id));

        // Fetch dog counts + champion dogs in parallel — one query each.
        // dog_counts_by_owner() is a single Postgres aggregate (fast).
        // Champion dogs: fetch only Legendary/Epic to keep payload tiny.
        const dogCountByOwner = {};
        const championByOwner = {};
        const RARITY_ORDER = { Legendary: 4, Epic: 3, Rare: 2, Uncommon: 1, Common: 0 };

        await Promise.allSettled([
          // Dog counts — prefer fast RPC, fall back to a single lightweight select
          (async () => {
            try {
              const counts = await sb('rpc/cat_counts_by_owner', 'POST', {});
              for (const row of counts) dogCountByOwner[row.owner_id] = parseInt(row.cat_count, 10);
            } catch {
              // Fallback: single query, owner_id only (no full-table scan of all columns)
              try {
                const rows = await sb('cats?select=owner_id&limit=2000');
                if (Array.isArray(rows)) for (const d of rows) dogCountByOwner[d.owner_id] = (dogCountByOwner[d.owner_id] || 0) + 1;
              } catch { /* leave empty — dog counts column will show 0 */ }
            }
          })(),
          // Champion dogs — only Legendary & Epic to keep payload small
          (async () => {
            try {
              const topDogs = await sb('cats?select=id,owner_id,name,breed,rarity&rarity=in.(Legendary,Epic)&limit=500');
              if (Array.isArray(topDogs)) {
                for (const d of topDogs) {
                  const prev = championByOwner[d.owner_id];
                  const curRank = RARITY_ORDER[d.rarity] ?? -1;
                  const prevRank = prev ? (RARITY_ORDER[prev.rarity] ?? -1) : -1;
                  if (curRank > prevRank) championByOwner[d.owner_id] = d;
                }
              }
            } catch { /* best-effort — champion dog display is decorative */ }
          })(),
        ]);

        // ── Current player's live local values (always accurate) ────────
        const myRaceWins = parseInt(localStorage.getItem('km_race_wins') || '0', 10);
        const myTrainingPts = computeTrainingPts();
        // Use the value passed directly from App (getTotalPts(dogs)) — always accurate
        const myTotalPts = myTotalPtsProp || getBonusPts();

        // ── Build leaderboard rows ──────────────────────────────────────
        const enriched = pArr.map(p => {
          const isMe = p.id === currentPlayer.id;
          const points      = isMe ? myTotalPts    : parseInt(p.total_pts    || 0, 10);
          const raceWins    = isMe ? myRaceWins    : parseInt(p.race_wins    || 0, 10);
          const trainingPts = isMe ? myTrainingPts : parseInt(p.training_pts || 0, 10);
          const champion = championByOwner[p.id] || null;
          // For the current player, prefer the localStorage nickname over the DB name
          let championLabel = null;
          if (champion) {
            const nick = isMe ? getDogNick(champion.id) : null;
            championLabel = (nick || champion.name || champion.breed || '').trim() || null;
          }
          // Streak: for the current player use live localStorage value; others use DB value if available
          const loginStreak = isMe
            ? parseInt(localStorage.getItem('km_streak') || '0', 10)
            : parseInt(p.login_streak || '0', 10);
          return { ...p, dogCount: dogCountByOwner[p.id] || 0, points, raceWins, totalLevels: trainingPts, champion, championLabel, loginStreak };
        });
        setBoard(enriched);
      } catch (e) { console.error('Leaderboard error:', e); setError(e.message || 'Failed to load'); }
      setLoading(false);
    };
    load();
  }, [currentPlayer.id, refreshKey]);

  const TABS = [
    { id: 'points',   label: '⭐ Points',   value: p => p.points,    unit: 'pts' },
    { id: 'cats',     label: '🐱 Cats',     value: p => p.dogCount,  unit: 'cats' },
    { id: 'races',    label: '🏁 Races',    value: p => p.raceWins,  unit: 'wins' },
    { id: 'training', label: '🏋️ Training', value: p => p.totalLevels, unit: 'stars' },
  ];
  const activeTab = TABS.find(t => t.id === tab) || TABS[0];
  const sorted = [...board].sort((a, b) => activeTab.value(b) - activeTab.value(a));
  const medals = ['🥇', '🥈', '🥉'];

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <h2 style={{ margin: 0, color: '#333' }}>🏆 Leaderboard</h2>
        <button onClick={() => { setLoading(true); setRefreshKey(k => k + 1); }} disabled={loading}
          style={{ background: '#f0e8ff', border: 'none', borderRadius: 20, padding: '6px 14px', fontWeight: 'bold', fontSize: 12, color: '#764ba2', cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.6 : 1 }}>
          {loading ? '⏳' : '🔄 Refresh'}
        </button>
      </div>
      <div style={{ textAlign: 'center', marginBottom: 10 }}>
        <span style={{ background: 'linear-gradient(135deg,#667eea,#764ba2)', color: 'white', borderRadius: 20, padding: '4px 14px', fontSize: 12, fontWeight: 'bold' }}>🗓️ Season {getCurrentSeason()}</span>
      </div>
      {getActiveEvent() && <div style={{ background: 'linear-gradient(135deg,#f4a261,#e76f51)', color: 'white', borderRadius: 12, padding: '8px 12px', marginBottom: 10, fontWeight: 'bold', fontSize: 13, textAlign: 'center' }}>{getActiveEvent().label} · {getActiveEvent().desc}</div>}
      <p style={{ textAlign: 'center', color: '#888', fontSize: 13, margin: '0 0 16px' }}>Who's the top cat?</p>

      <div style={{ display: 'flex', background: '#f0f0f0', borderRadius: 12, padding: 4, marginBottom: 16, gap: 2 }}>
        {TABS.map(({ id, label }) => (
          <button key={id} onClick={() => setTab(id)} style={{ flex: 1, padding: '7px 2px', border: 'none', borderRadius: 10, cursor: 'pointer', fontWeight: 'bold', fontSize: 11, background: tab === id ? 'white' : 'transparent', color: tab === id ? '#764ba2' : '#888', boxShadow: tab === id ? '0 2px 8px rgba(0,0,0,0.1)' : 'none' }}>
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>Loading...</div>
      ) : error ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#e74c3c', fontSize: 13 }}>⚠️ {error}</div>
      ) : sorted.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>No players yet!</div>
      ) : (
        <div>
          {sorted.map((p, i) => {
            const isMe = p.id === currentPlayer.id;
            const isOnline = onlineIds.has(p.id);
            const val = activeTab.value(p);
            return (
              <div key={p.id} onClick={() => { if (!isMe && p.username && !String(p.username).includes('@')) setProfileUser(p.username); }} style={{
                cursor: !isMe ? 'pointer' : 'default',
                background: isMe ? 'linear-gradient(135deg,#764ba222,#667eea11)' : isOnline ? 'linear-gradient(135deg,#e8fff6,#d4f7e8)' : 'white',
                border: isMe ? '2px solid #764ba2' : isOnline ? '2px solid #06d6a0' : '2px solid #eee',
                borderRadius: 16, padding: '14px 16px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 14,
                boxShadow: isOnline ? '0 2px 12px rgba(6,214,160,0.15)' : 'none',
              }}>
                <div style={{ fontSize: 24, width: 36, textAlign: 'center' }}>{medals[i] || `#${i + 1}`}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 'bold', fontSize: 16, color: '#333', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {publicName(p.username)}{isMe ? ' (you)' : ''}
                    {p.loginStreak >= 3 && (
                      <span style={{ fontSize: 10, background: p.loginStreak >= 30 ? '#e74c3c' : p.loginStreak >= 7 ? '#f39c12' : '#e67e22', color: 'white', borderRadius: 20, padding: '1px 7px', fontWeight: 'bold' }}>
                        🔥 {p.loginStreak}d
                      </span>
                    )}
                    {ONLINE && isOnline && <span style={{ fontSize: 10, background: '#06d6a0', color: 'white', borderRadius: 20, padding: '1px 7px', fontWeight: 'bold' }}>🟢 online</span>}
                  </div>
                  {p.championLabel && (
                    <div style={{ fontSize: 12, color: '#764ba2', fontStyle: 'italic', marginBottom: 2 }}>
                      {p.champion?.rarity === 'Legendary' ? '⭐' : p.champion?.rarity === 'Epic' ? '✨' : '🐾'} {p.championLabel}
                    </div>
                  )}
                  <div style={{ fontSize: 13, color: '#888' }}>🐱 {p.dogCount} · ⭐ {p.points} pts · 🏁 {p.raceWins}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 'bold', fontSize: 18, color: '#764ba2' }}>{val}</div>
                  <div style={{ fontSize: 11, color: '#aaa' }}>{activeTab.unit}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {profileUser && <FriendsGalleryModal initialQuery={profileUser} onClose={() => setProfileUser(null)} />}
    </div>
  );
}

// ─── Trade Screen ─────────────────────────────────────────────────────────────
function TradeScreen({ player, myDogs, onDogUpdate, onBack }) {
  const [players, setPlayers] = useState([]);
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [selectedDog, setSelectedDog] = useState(null);
  const [incomingTrades, setIncomingTrades] = useState([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const TRADE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

  const loadData = useCallback(async () => {
    const allPlayers = await sb(`players?id=neq.${player.id}&select=id,username`);
    setPlayers(allPlayers);
    let trades = [];
    try {
      trades = await sb(`trades?to_player_id=eq.${player.id}&status=eq.pending&select=*`);
    } catch (e) {
      setMsg('Trading is not set up yet (trades table missing in Supabase).');
      setIncomingTrades([]);
      return;
    }

    // Auto-expire trades older than 24h — cancel them and release the dog back to its owner
    const now = Date.now();
    const expired = trades.filter(t => t.created_at && (now - new Date(t.created_at).getTime()) > TRADE_EXPIRY_MS);
    if (expired.length > 0) {
      await Promise.allSettled(expired.map(t =>
        sb(`trades?id=eq.${t.id}`, 'PATCH', { status: 'expired' }).catch(() => {})
      ));
      trades = trades.filter(t => !expired.find(e => e.id === t.id));
    }

    // Also expire outgoing offers the current player sent that are stale
    try {
      const outgoing = await sb(`trades?from_player_id=eq.${player.id}&status=eq.pending&select=id,created_at`);
      const expiredOut = outgoing.filter(t => t.created_at && (now - new Date(t.created_at).getTime()) > TRADE_EXPIRY_MS);
      if (expiredOut.length > 0) {
        await Promise.allSettled(expiredOut.map(t =>
          sb(`trades?id=eq.${t.id}`, 'PATCH', { status: 'expired' }).catch(() => {})
        ));
      }
    } catch { /* best-effort */ }

    const enriched = await Promise.all(trades.map(async t => {
      const [dogData, senderData] = await Promise.all([sb(`cats?id=eq.${t.dog_id}&select=*`), sb(`players?id=eq.${t.from_player_id}&select=username`)]);
      return { ...t, dog: dogData[0], sender: senderData[0] };
    }));
    setIncomingTrades(enriched);
  }, [player.id]); // eslint-disable-line

  useEffect(() => { loadData(); }, [loadData]);

  const sendTrade = async () => {
    if (!selectedPlayer || !selectedDog) { setMsg('Pick a player and a cat.'); return; }
    setLoading(true);
    try {
      await sb('trades', 'POST', { from_player_id: player.id, to_player_id: selectedPlayer.id, dog_id: selectedDog.id, status: 'pending' });
      setMsg(`Trade offer sent to ${selectedPlayer.username}! 🐾`);
      setSelectedDog(null); setSelectedPlayer(null);
    } catch (e) { setMsg('Error: ' + e.message); }
    setLoading(false);
  };

  const acceptTrade = async (trade) => {
    setLoading(true);
    try {
      await sb(`cats?id=eq.${trade.dog_id}`, 'PATCH', { owner_id: player.id });
      // PATCH returns success even when the database silently blocks the change,
      // so confirm the dog really moved before marking the trade accepted.
      const check = await sb(`cats?id=eq.${trade.dog_id}&select=owner_id`);
      if (!check[0] || check[0].owner_id !== player.id) {
        setMsg('Could not transfer this cat (it may have moved or been blocked). Trade left pending.');
        setLoading(false); return;
      }
      await sb(`trades?id=eq.${trade.id}`, 'PATCH', { status: 'accepted' });
      await sb(`trades?dog_id=eq.${trade.dog_id}&status=eq.pending&id=neq.${trade.id}`, 'PATCH', { status: 'cancelled' });
      setMsg(`You received a ${trade.dog?.name}! 🎉`);
      await loadData(); onDogUpdate();
    } catch (e) { setMsg('Error: ' + e.message); }
    setLoading(false);
  };

  const declineTrade = async (trade) => {
    await sb(`trades?id=eq.${trade.id}`, 'PATCH', { status: 'declined' });
    setMsg('Trade declined.'); await loadData();
  };

  const sortedDogs = [...myDogs].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        {onBack && <button onClick={onBack} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', padding: '0 10px 0 0', color: '#764ba2' }}>←</button>}
        <h2 style={{ margin: 0, color: '#333', flex: 1, textAlign: 'center' }}>Trade Cats 🤝</h2>
      </div>
      {incomingTrades.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ color: '#e63946', margin: '0 0 12px', fontSize: 15 }}>📬 Incoming Offers ({incomingTrades.length})</h3>
          {incomingTrades.map(t => (
            <div key={t.id} style={{ background: '#fff8f0', border: '2px solid #ffb703', borderRadius: 14, padding: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
              {t.dog?.photo_url ? <img src={t.dog.photo_url} alt={t.dog.name} style={{ width: 60, height: 60, borderRadius: '50%', objectFit: 'cover', border: `3px solid ${RARITY_COLORS[t.dog?.rarity]}` }} onError={e => e.target.style.display='none'} /> : <div style={{ fontSize: 40 }}>🐱</div>}
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 'bold', color: '#333' }}>{t.dog?.name}</div>
                <div style={{ fontSize: 13, color: '#888' }}>from {t.sender?.username}</div>
                <div style={{ fontSize: 12, color: RARITY_COLORS[t.dog?.rarity] }}>{t.dog?.rarity} · ⭐ {RARITY_POINTS[t.dog?.rarity] || 0} pts</div>
                {t.created_at && (() => {
                  const msLeft = TRADE_EXPIRY_MS - (Date.now() - new Date(t.created_at).getTime());
                  const hLeft = Math.max(0, Math.floor(msLeft / 3600000));
                  const mLeft = Math.max(0, Math.floor((msLeft % 3600000) / 60000));
                  const urgent = hLeft < 2;
                  return <div style={{ fontSize: 11, color: urgent ? '#e63946' : '#aaa', marginTop: 2 }}>⏰ {hLeft}h {mLeft}m left to accept</div>;
                })()}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button onClick={() => acceptTrade(t)} style={{ padding: '6px 12px', background: '#06d6a0', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 'bold', fontSize: 13 }}>Accept</button>
                <button onClick={() => declineTrade(t)} style={{ padding: '6px 12px', background: '#e63946', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Decline</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <h3 style={{ color: '#333', margin: '0 0 10px', fontSize: 15 }}>Send a Trade Offer</h3>
      <div style={{ marginBottom: 14 }}>
        <p style={{ margin: '0 0 8px', fontSize: 13, color: '#666' }}>1. Pick a player:</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {players.length === 0 ? <p style={{ color: '#aaa', fontSize: 13 }}>No other players yet!</p> : players.map(p => (
            <button key={p.id} onClick={() => setSelectedPlayer(p)} style={{ padding: '8px 14px', background: selectedPlayer?.id === p.id ? '#764ba2' : '#f0f0f0', color: selectedPlayer?.id === p.id ? 'white' : '#333', border: 'none', borderRadius: 10, cursor: 'pointer', fontWeight: 'bold', fontSize: 14 }}>👤 {p.username}</button>
          ))}
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <p style={{ margin: '0 0 8px', fontSize: 13, color: '#666' }}>2. Pick a cat to offer (A–Z):</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {sortedDogs.map(dog => (
            <div key={dog.id} onClick={() => setSelectedDog(dog)} style={{ background: selectedDog?.id === dog.id ? '#764ba222' : '#f9f9f9', border: `2px solid ${selectedDog?.id === dog.id ? '#764ba2' : '#eee'}`, borderRadius: 12, padding: 10, textAlign: 'center', cursor: 'pointer' }}>
              {dog.photo_url ? <img src={dogImageSrc(dog) || dog.photo_url} alt={dog.name} style={{ width: 55, height: 55, borderRadius: '50%', objectFit: 'cover', border: `2px solid ${RARITY_COLORS[dog.rarity]}` }} onError={e => e.target.style.display='none'} /> : <div style={{ fontSize: 36 }}>🐱</div>}
              <div style={{ fontSize: 11, fontWeight: 'bold', color: '#333', marginTop: 4 }}>{dog.name}</div>
              <div style={{ fontSize: 10, color: RARITY_COLORS[dog.rarity] }}>{dog.rarity}</div>
            </div>
          ))}
        </div>
      </div>
      {msg && <p style={{ color: '#764ba2', fontWeight: 'bold', textAlign: 'center', fontSize: 14 }}>{msg}</p>}
      <button onClick={sendTrade} disabled={loading || !selectedPlayer || !selectedDog} style={{ width: '100%', padding: 14, background: selectedPlayer && selectedDog ? 'linear-gradient(135deg, #667eea, #764ba2)' : '#ccc', color: 'white', border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 'bold', cursor: selectedPlayer && selectedDog ? 'pointer' : 'not-allowed' }}>
        {loading ? '...' : 'Send Trade Offer 🤝'}
      </button>
    </div>
  );
}

// ─── Settings Screen ──────────────────────────────────────────────────────────
const AVATAR_EMOJIS = ['🐱','🐈','🐈‍⬛','🐱‍🦺','🐾','🌟','💎','🏆','👑','🧶','🐟','🐱','🐱','🦊','🦁','🐻'];

function SettingsScreen({ player, dogs, onLogout, onDogsReset, setPlayer }) {
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDeleteFinal, setConfirmDeleteFinal] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [friendCode, setFriendCode] = useState('');
  const [friendResult, setFriendResult] = useState(null);
  const [friendLoading, setFriendLoading] = useState(false);
  const [showFriends, setShowFriends] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showHelpGate, setShowHelpGate] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showAddEmail, setShowAddEmail] = useState(false);
  const [showChangeEmail, setShowChangeEmail] = useState(false);
  const [alertMsg, setAlertMsg] = useState('');
  const [championId, setChampionId] = useState(() => localStorage.getItem('km_champion') || '');
  const champion = dogs.find(d => d.id === championId) || [...dogs].sort((a,b) => (RARITY_POINTS[b.rarity]||0)-(RARITY_POINTS[a.rarity]||0))[0] || null;

  const myCode = player.id.replace(/-/g, '').substring(0, 8).toUpperCase();

  const [myFriends, setMyFriends] = useState([]);
  const [friendsOnlineIds, setFriendsOnlineIds] = useState(new Set());
  const [addFriendMsg, setAddFriendMsg] = useState('');

  const refreshFriends = useCallback(async () => {
    const list = await getMyFriends(player.id);
    setMyFriends(list);
    const online = await getOnlinePlayers();
    setFriendsOnlineIds(new Set(online.map(o => o.player_id)));
  }, [player.id]);

  useEffect(() => { refreshFriends(); }, [refreshFriends]);

  const lookupFriend = async () => {
    const code = friendCode.trim().toUpperCase();
    if (code.length < 6) return;
    setFriendLoading(true); setFriendResult(null); setAddFriendMsg('');
    try {
      // Try by username first (most user-friendly), then fall back to UUID prefix search
      let match = null;
      const byUsername = await sb(`players?select=id,username,race_wins&username=ilike.${encodeURIComponent(code)}&limit=1`);
      if (byUsername && byUsername[0]) {
        match = byUsername[0];
      } else {
        // UUID prefix: fetch small pages searching for a UUID whose stripped form starts with the code
        const stripped = code.toLowerCase();
        const page = await sb(`players?select=id,username,race_wins&limit=200`);
        match = (page || []).find(p => p.id.replace(/-/g,'').toUpperCase().startsWith(code));
      }
      if (match) {
        const dogsRes = await sb(`cats?owner_id=eq.${match.id}&select=rarity&limit=1000`);
        const pts = dogsRes.reduce((s, d) => s + (RARITY_POINTS[d.rarity] || 0), 0);
        setFriendResult({ ...match, dogCount: dogsRes.length, points: pts });
      } else {
        setFriendResult({ notFound: true });
      }
    } catch(e) { setFriendResult({ error: e.message }); }
    setFriendLoading(false);
  };

  const handleAddFriend = async () => {
    if (!friendResult || friendResult.notFound || friendResult.error) return;
    const ok = await addFriend(player.id, friendResult.id);
    setAddFriendMsg(ok ? `✅ Added ${friendResult.username} as a friend!` : "Couldn't add friend — try again later.");
    if (ok) refreshFriends();
  };

  const handleRemoveFriend = async (friendId, username) => {
    const ok = await removeFriend(player.id, friendId);
    if (ok) { showToast(`Removed ${username} from friends.`); refreshFriends(); }
  };

  const [avatar, setAvatar] = useState(() => localStorage.getItem('km_avatar') || '🐾');
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [editingUsername, setEditingUsername] = useState(false);
  const [newUsername, setNewUsername] = useState(player.username);
  const [usernameError, setUsernameError] = useState('');
  const [toast, setToast] = useState('');
  const rarityCount = {};
  dogs.forEach(d => { rarityCount[d.rarity] = (rarityCount[d.rarity] || 0) + 1; });
  const settingsBonusPts = useLive(getBonusPts, 'km_pts_change');
  const totalPoints = calcPoints(dogs) + settingsBonusPts;

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2500); };

  const pickAvatar = (emoji) => {
    setAvatar(emoji);
    localStorage.setItem('km_avatar', emoji);
    setShowAvatarPicker(false);
  };

  const saveUsername = async () => {
    const val = newUsername.trim();
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(val)) {
      setUsernameError('3-20 chars, letters/numbers/underscore only.');
      return;
    }
    if (isInappropriateName(val)) { setUsernameError('Please choose a family-friendly username.'); return; }
    setUsernameError('');
    try {
      await sb(`players?id=eq.${player.id}`, 'PATCH', { username: val });
      setPlayer(p => ({ ...p, username: val }));
      setEditingUsername(false);
      showToast('Username updated! 👍');
    } catch (e) { setUsernameError('Error: ' + e.message); }
  };

  const resetDogs = async () => {
    await sb(`cats?owner_id=eq.${player.id}`, 'DELETE');
    setConfirmReset(false);
    onDogsReset();
  };

  const autoNameAllDogs = () => {
    const usedNames = new Set();
    dogs.forEach(d => { const nick = getDogNick(d.id); if (nick) usedNames.add(nick); });
    let count = 0;
    let failed = 0;
    dogs.forEach(d => {
      if (!getDogNick(d.id)) {
        // setItem can throw (e.g. QuotaExceededError with very large collections); don't let one failure abort the whole run
        try {
          let gender = getDogGender(d.id);
          if (!gender) { gender = Math.random() < 0.5 ? 'Male' : 'Female'; setDogGender(d.id, gender); }
          const name = generateDogName(usedNames, gender);
          usedNames.add(name);
          setDogNick(d.id, name);
          count++;
        } catch (e) { failed++; }
      }
    });
    if (count > 0 && !dxFlushNow()) { failed += count; count = 0; }
    if (count > 0) { window.dispatchEvent(new Event('km_dog_change')); saveNowDebounced(); }
    setAlertMsg(
      failed > 0 ? `🏷️ Named ${count} cats, but ${failed} couldn't be saved (the game's saved-data space on this phone is full).`
      : count > 0 ? `🏷️ All cats have been named! (${count} named)`
      : 'All your cats already have names!'
    );
  };

  const deleteAccount = async () => {
    setDeleteError('');
    setDeleting(true);
    try {
      // Real (Supabase Auth) accounts: re-confirm the password, then have the delete-account Edge Function
      // remove the game data AND the login record. If the function isn't deployed we fall back to deleting the
      // game rows ourselves — but RLS only lets a migrated account delete its own rows when the request carries
      // that user's session token, so we send it, and we verify the rows are really gone before logging out.
      let fullyDeleted = false;
      let token = null;
      if (player.user_id) {
        if (!deletePassword) { setDeleteError('Enter your password to confirm.'); setDeleting(false); return; }
        const rows = await sb(`players?id=eq.${player.id}&select=email`);
        const email = rows[0]?.email;
        if (!email) throw new Error('No email on file for this account.');
        const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password: deletePassword });
        if (error || !data?.session) { setDeleteError('Incorrect password.'); setDeleting(false); return; }
        token = data.session.access_token;
      }
      if (!fullyDeleted) {
        const del = async (path) => sb(path, 'DELETE');
        // trades reference both players and dogs without ON DELETE CASCADE, so they must go first.
        await del(`trades?from_player_id=eq.${player.id}`);
        await del(`trades?to_player_id=eq.${player.id}`);
        await del(`cats?owner_id=eq.${player.id}`);
        const gone = await del(`players?id=eq.${player.id}`);
        // RLS silently deletes 0 rows instead of erroring, so an empty result means the account was NOT deleted.
        if (!Array.isArray(gone) || gone.length === 0) throw new Error('the server refused the deletion');
      }
    } catch (e) {
      setDeleteError('Could not delete your account: ' + (e.message || 'unknown error') + '. Please try again, or email the KittyMart team.');
      setDeleting(false);
      return;
    }
    Object.keys(localStorage).filter(k => k.startsWith('km_') || k === 'kittymart_player').forEach(k => localStorage.removeItem(k));
    onLogout();
  };

  return (
    <div style={{ padding: 20 }}>
      {toast && <div style={{ position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', background: '#764ba2', color: 'white', borderRadius: 20, padding: '10px 20px', fontWeight: 'bold', fontSize: 14, zIndex: 999, whiteSpace: 'nowrap', boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>{toast}</div>}
      <h2 style={{ margin: '0 0 20px', color: '#333', textAlign: 'center' }}>Settings ⚙️</h2>
      <div style={{ background: '#f9f9f9', borderRadius: 16, padding: 20, marginBottom: 16, textAlign: 'center' }}>
        <div onClick={() => setShowAvatarPicker(true)} style={{ fontSize: 64, marginBottom: 8, cursor: 'pointer', display: 'inline-block' }} title="Tap to change avatar">{avatar}</div>
        <div style={{ fontSize: 11, color: '#aaa', marginBottom: 8 }}>Tap to change avatar</div>
        {!editingUsername ? (
          <div>
            <div style={{ fontSize: 22, fontWeight: 'bold', color: '#333' }}>{player.username}</div>
            <button onClick={() => { setEditingUsername(true); setNewUsername(player.username); }} style={{ marginTop: 8, padding: '6px 16px', background: '#f0e8ff', color: '#764ba2', border: 'none', borderRadius: 20, fontSize: 13, cursor: 'pointer', fontWeight: 'bold' }}>✏️ Change Username</button>
          </div>
        ) : (
          <div>
            <input value={newUsername} onChange={e => setNewUsername(e.target.value)} placeholder="New username" style={{ width: '100%', padding: '10px', borderRadius: 10, border: '2px solid #c39bd3', fontSize: 15, textAlign: 'center', boxSizing: 'border-box', outline: 'none', marginBottom: 6 }} />
            {usernameError && <div style={{ color: '#e63946', fontSize: 12, marginBottom: 6 }}>{usernameError}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={saveUsername} style={{ flex: 1, padding: '10px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: 'white', border: 'none', borderRadius: 10, fontWeight: 'bold', cursor: 'pointer', fontSize: 14 }}>Save</button>
              <button onClick={() => setEditingUsername(false)} style={{ flex: 1, padding: '10px', background: '#eee', border: 'none', borderRadius: 10, fontWeight: 'bold', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
            </div>
          </div>
        )}
        <div style={{ color: '#888', fontSize: 14, marginTop: 8 }}>{dogs.length} cats · ⭐ {totalPoints} points</div>
        <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>Code: <span style={{ fontWeight: 'bold', color: '#764ba2', letterSpacing: 1 }}>{myCode}</span></div>
      </div>

      {/* Champion dog */}
      {champion && (
        <div style={{ background: 'linear-gradient(135deg,#fff8e7,#fff3cd)', border: '2px solid #ffd700', borderRadius: 16, padding: 16, marginBottom: 16 }}>
          <div style={{ fontWeight: 'bold', color: '#f4a261', fontSize: 14, marginBottom: 10 }}>🏆 Best in Show</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <img src={dogImageSrc(champion) || champion.photo_url} alt={champion.breed} style={{ width:60, height:60, borderRadius:'50%', objectFit:'cover', border:`3px solid ${RARITY_COLORS[champion.rarity]}` }} onError={e=>e.target.style.display='none'} />
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:'bold', color:'#333' }}>{getDogNick(champion.id) || champion.name || champion.breed}</div>
              <div style={{ fontSize:12, color:RARITY_COLORS[champion.rarity], fontWeight:'bold' }}>{champion.rarity}</div>
            </div>
            <button onClick={() => {
              const sorted = [...dogs].sort((a,b) => (RARITY_POINTS[b.rarity]||0)-(RARITY_POINTS[a.rarity]||0));
              const idx = sorted.findIndex(d => d.id === championId);
              const next = sorted[(idx + 1) % sorted.length];
              setChampionId(next.id); localStorage.setItem('km_champion', next.id);
            }} style={{ padding:'6px 12px', background:'#ffd700', border:'none', borderRadius:10, fontSize:12, fontWeight:'bold', cursor:'pointer' }}>
              Switch
            </button>
          </div>
        </div>
      )}

      {/* ── FRIENDS SECTION ── */}
      <div style={{ borderRadius: 20, overflow: 'hidden', marginBottom: 16, boxShadow: '0 4px 20px rgba(118,75,162,0.15)' }}>
        {/* Header */}
        <div style={{ background: 'linear-gradient(135deg,#667eea,#764ba2)', padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ color: 'white', fontWeight: 'bold', fontSize: 17 }}>👥 Friends</div>
            <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: 2 }}>{myFriends.length} friend{myFriends.length !== 1 ? 's' : ''} · connect &amp; race together!</div>
          </div>
          <button onClick={() => setShowFriends(true)} style={{ padding: '8px 14px', background: 'rgba(255,255,255,0.2)', color: 'white', border: '2px solid rgba(255,255,255,0.4)', borderRadius: 12, fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}>
            🔭 Browse
          </button>
        </div>

        <div style={{ background: 'white', padding: 16 }}>
          {/* Share my code */}
          <div style={{ background: 'linear-gradient(135deg,#f0e8ff,#e8f4fd)', borderRadius: 14, padding: 14, marginBottom: 14, textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: '#764ba2', fontWeight: 'bold', letterSpacing: 1, marginBottom: 6 }}>📤 MY FRIEND CODE — share this!</div>
            <div style={{ fontSize: 28, fontWeight: 'bold', color: '#333', letterSpacing: 4, marginBottom: 10 }}>{myCode}</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button onClick={() => { try { navigator.clipboard.writeText(myCode); showToast('Friend code copied! 📋'); } catch {} }}
                style={{ padding: '8px 20px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: 'white', border: 'none', borderRadius: 12, fontWeight: 'bold', cursor: 'pointer', fontSize: 13 }}>
                📋 Copy Code
              </button>
              <button onClick={() => { try { navigator.share({ title: 'KittyMart', text: `Add me on KittyMart! My friend code is ${myCode} 🐾` }); } catch { try { navigator.clipboard.writeText(`Add me on KittyMart! My friend code is ${myCode} 🐾`); showToast('Copied to clipboard! 📋'); } catch {} } }}
                style={{ padding: '8px 20px', background: 'linear-gradient(135deg,#06d6a0,#059e76)', color: 'white', border: 'none', borderRadius: 12, fontWeight: 'bold', cursor: 'pointer', fontSize: 13 }}>
                🔗 Share
              </button>
            </div>
          </div>

          {/* Add a friend */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 'bold', color: '#555', marginBottom: 8 }}>➕ ADD A FRIEND</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={friendCode} onChange={e => setFriendCode(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && lookupFriend()}
                placeholder="Enter their friend code…" maxLength={8}
                style={{ flex: 1, padding: '12px 14px', borderRadius: 12, border: '2px solid #c39bd3', fontSize: 15, outline: 'none', fontWeight: 'bold', letterSpacing: 2, textAlign: 'center' }} />
              <button onClick={lookupFriend} disabled={friendLoading}
                style={{ padding: '12px 18px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: 'white', border: 'none', borderRadius: 12, fontWeight: 'bold', cursor: 'pointer', fontSize: 15 }}>
                {friendLoading ? '⏳' : '🔍'}
              </button>
            </div>
          </div>

          {friendResult && !friendResult.notFound && !friendResult.error && (
            <div style={{ marginBottom: 14, background: '#f0fdf7', borderRadius: 14, padding: 14, border: '2px solid #06d6a0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 'bold', fontSize: 16 }}>🐾 {friendResult.username}</div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 3 }}>🐱 {friendResult.dogCount} cats · ⭐ {friendResult.points} pts · 🏁 {friendResult.race_wins || 0} wins</div>
                </div>
                {friendResult.id !== player.id && !myFriends.some(f => f.id === friendResult.id) && (
                  <button onClick={handleAddFriend} style={{ padding: '10px 16px', background: 'linear-gradient(135deg,#06d6a0,#059e76)', color: 'white', border: 'none', borderRadius: 12, fontSize: 13, fontWeight: 'bold', cursor: 'pointer' }}>+ Add</button>
                )}
                {myFriends.some(f => f.id === friendResult.id) && (
                  <span style={{ fontSize: 12, color: '#06d6a0', fontWeight: 'bold' }}>✅ Already friends!</span>
                )}
              </div>
            </div>
          )}
          {addFriendMsg && <div style={{ marginBottom: 10, fontSize: 13, color: '#764ba2', fontWeight: 'bold', textAlign: 'center', padding: '8px', background: '#f0e8ff', borderRadius: 10 }}>{addFriendMsg}</div>}
          {friendResult?.notFound && <div style={{ marginBottom: 10, color: '#e63946', fontSize: 13, textAlign: 'center' }}>❌ No player found with that code.</div>}
          {friendResult?.error && <div style={{ marginBottom: 10, color: '#e63946', fontSize: 13, textAlign: 'center' }}>Error: {friendResult.error}</div>}

          {/* Friends list */}
          {myFriends.length > 0 ? (
            <div>
              <div style={{ fontSize: 12, fontWeight: 'bold', color: '#555', marginBottom: 8 }}>MY FRIENDS ({myFriends.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {myFriends.map(f => (
                  <div key={f.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: friendsOnlineIds.has(f.id) ? 'linear-gradient(135deg,#f0fdf7,#e8f9f3)' : '#f9f9f9', borderRadius: 12, padding: '10px 14px', border: `2px solid ${friendsOnlineIds.has(f.id) ? '#06d6a0' : '#eee'}` }}>
                    <div>
                      <div style={{ fontWeight: 'bold', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {f.username}
                        {ONLINE && friendsOnlineIds.has(f.id) && <span style={{ fontSize: 9, background: '#06d6a0', color: 'white', borderRadius: 20, padding: '2px 7px', fontWeight: 'bold' }}>🟢 ONLINE</span>}
                      </div>
                      <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>⭐ {f.total_pts || 0} pts · 🏁 {f.race_wins || 0} wins</div>
                    </div>
                    <button onClick={() => handleRemoveFriend(f.id, f.username)} style={{ padding: '6px 12px', background: '#ffe8e8', color: '#e63946', border: 'none', borderRadius: 10, fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}>Remove</button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '12px 0', color: '#aaa', fontSize: 13 }}>
              <div style={{ fontSize: 36, marginBottom: 6 }}>🐾</div>
              No friends yet — share your code to get started!
            </div>
          )}
        </div>
      </div>
      {showAvatarPicker && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setShowAvatarPicker(false)}>
          <div style={{ background: 'white', borderRadius: 20, padding: 24, width: 300 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 16px', textAlign: 'center', color: '#764ba2' }}>Pick Your Avatar</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
              {AVATAR_EMOJIS.map(e => (
                <button key={e} onClick={() => pickAvatar(e)} style={{ fontSize: 32, padding: 10, background: avatar === e ? '#f0e8ff' : '#f9f9f9', border: `2px solid ${avatar === e ? '#764ba2' : '#eee'}`, borderRadius: 12, cursor: 'pointer' }}>{e}</button>
              ))}
            </div>
            <button onClick={() => setShowAvatarPicker(false)} style={{ width: '100%', padding: 10, background: '#eee', border: 'none', borderRadius: 10, fontWeight: 'bold', cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}
      <div style={{ background: '#f9f9f9', borderRadius: 16, padding: 16, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Collection Stats</h3>
        {Object.entries(RARITY_COLORS).map(([r, c]) => (
          <div key={r} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #eee' }}>
            <span style={{ color: c, fontWeight: 'bold', fontSize: 13 }}>{r} {RARITY_POINTS[r] > 0 ? `(${RARITY_POINTS[r]}pts)` : ''}</span>
            <span style={{ color: '#333', fontWeight: 'bold' }}>{rarityCount[r] || 0}</span>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0 0' }}>
          <span style={{ fontWeight: 'bold', color: '#764ba2' }}>Total Points</span>
          <span style={{ fontWeight: 'bold', color: '#764ba2' }}>⭐ {totalPoints}</span>
        </div>
      </div>

      {/* ── Points Breakdown Table ── */}
      {(() => {
        const dogPts = calcPoints(dogs);
        const bonusPtsVal = getBonusPts();
        const racePts = parseInt(localStorage.getItem('km_race_pts') || '0', 10);
        const pooCount = parseInt(localStorage.getItem('km_poo_count') || '0', 10);
        const catchCount = parseInt(localStorage.getItem('km_catch_count') || '0', 10);
        const streakPts = parseInt(localStorage.getItem('km_streak_pts_total') || '0', 10);
        const rows = [
          { label: '🐱 Cat Collection',  desc: `${dogs.length} cats across rarities`,         pts: dogPts },
          { label: '🏁 Race Winnings',   desc: `Earned from multiplayer & AI races`,           pts: racePts },
          { label: '🧹 Litter Cleanups',     desc: `${pooCount} trays cleaned`,                     pts: null },
          { label: '🧶 Cat Catches',     desc: `${catchCount} cats caught`,                    pts: null },
          { label: '🎁 Daily Gift',      desc: 'Daily gift box for Kitty Coins 🐱',          pts: null },
          // Race winnings are paid in as bonus points, so take them out here to keep the rows adding up to the Grand Total.
          { label: '⭐ Bonus Pts',       desc: 'Spins, litter, catches, daily login & more',     pts: Math.max(0, bonusPtsVal - racePts) },
        ];
        return (
          <div style={{ background: '#fdf6ff', border: '2px solid #e0d0ff', borderRadius: 16, padding: 16, marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 15, color: '#764ba2' }}>📊 Points Breakdown</h3>
            {rows.map((r, i) => r.pts !== null && (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: i < rows.length - 1 ? '1px solid #f0e8ff' : 'none' }}>
                <div>
                  <div style={{ fontWeight: 'bold', fontSize: 13, color: '#333' }}>{r.label}</div>
                  <div style={{ fontSize: 11, color: '#999' }}>{r.desc}</div>
                </div>
                <div style={{ fontWeight: 'bold', color: '#764ba2', fontSize: 14, minWidth: 60, textAlign: 'right' }}>⭐ {r.pts.toLocaleString()}</div>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0 0', borderTop: '2px solid #e0d0ff', marginTop: 4 }}>
              <span style={{ fontWeight: 'bold', fontSize: 15, color: '#764ba2' }}>🏅 Grand Total</span>
              <span style={{ fontWeight: 'bold', fontSize: 16, color: '#764ba2' }}>⭐ {totalPoints.toLocaleString()}</span>
            </div>
          </div>
        );
      })()}

      <div style={{ background: '#f0f8ff', borderRadius: 16, padding: 16, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>📍 Zone Guide</h3>
        {Object.entries(ZONES).map(([key, z]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid #eee' }}>
            <span style={{ fontSize: 13, fontWeight: 'bold', minWidth: 110 }}>{z.label}</span>
            <span style={{ fontSize: 12, color: '#666' }}>{z.desc}</span>
          </div>
        ))}
      </div>
      <button onClick={() => setShowPrivacy(true)} style={{ width: '100%', padding: 14, background: 'linear-gradient(135deg,#4cc9f0,#4361ee)', color: 'white', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 'bold', cursor: 'pointer', marginBottom: 10 }}>🔒 Privacy Policy</button>
      <button onClick={() => setShowHelp(true)} style={{ width: '100%', padding: 14, background: 'linear-gradient(135deg,#f6a6c1,#e26b9a)', color: 'white', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 'bold', cursor: 'pointer', marginBottom: 10 }}>💬 Help &amp; Contact</button>
      {showHelp && ReactDOM.createPortal(
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:1100, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }} onClick={() => setShowHelp(false)}>
          <div style={{ background:'white', borderRadius:20, padding:24, maxWidth:360, width:'100%', maxHeight:'85vh', overflowY:'auto' }} onClick={e => e.stopPropagation()}>
            <h2 style={{ margin:'0 0 12px', color:'#764ba2' }}>💬 Help &amp; Contact</h2>
            <p style={{ fontSize:13, color:'#555', lineHeight:1.6 }}><strong>Report a player:</strong> tap a player on the Board (or use Find a Friend), then tap 🚩 Report. You can also 🚫 Block them so you no longer see them.</p>
            <p style={{ fontSize:13, color:'#555', lineHeight:1.6 }}><strong>Delete your account:</strong> Me → Delete Account. This removes your profile and cats.</p>
            <p style={{ fontSize:13, color:'#555', lineHeight:1.6 }}><strong>A purchase didn't work?</strong> Kitty Coins are returned automatically if a power-up can't be applied. If something still looks wrong, email us with your username.</p>
            <p style={{ fontSize:13, color:'#555', lineHeight:1.6 }}>Contact: <strong>the KittyMart team</strong></p>
            <button onClick={() => setShowHelpGate(true)} style={{ width:'100%', padding:12, background:'linear-gradient(135deg,#667eea,#764ba2)', color:'white', border:'none', borderRadius:12, fontSize:15, fontWeight:'bold', cursor:'pointer', marginTop:8 }}>✉️ Email support</button>
            <button onClick={() => setShowHelp(false)} style={{ width:'100%', padding:12, background:'#f0f0f0', color:'#333', border:'none', borderRadius:12, fontSize:15, fontWeight:'bold', cursor:'pointer', marginTop:8 }}>Close</button>
            {showHelpGate && <ParentalGateModal onClose={() => setShowHelpGate(false)} onSuccess={() => { setShowHelpGate(false); window.location.href = `mailto:the KittyMart team?subject=${encodeURIComponent('KittyMart support: ' + player.username)}`; }} />}
          </div>
        </div>, document.body)}
      <button onClick={() => { try { exportKittyBackup(); } catch { alert('Could not save a backup on this device.'); } }} style={{ width: '100%', padding: 14, background: 'linear-gradient(135deg,#4cc9f0,#4361ee)', color: 'white', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 'bold', cursor: 'pointer', marginBottom: 10 }}>📦 Save My Cats to a File</button>
      <label style={{ display:'block', boxSizing:'border-box', width: '100%', padding: 14, background: 'linear-gradient(135deg,#7209b7,#560bad)', color: 'white', borderRadius: 12, fontSize: 15, fontWeight: 'bold', cursor: 'pointer', marginBottom: 10, textAlign:'center' }}>📥 Load Cats from a File
        <input type="file" accept="application/json,.json" style={{ display:'none' }} onChange={async e => { const f = e.target.files && e.target.files[0]; if (!f) return; if (!window.confirm('Load this backup? It replaces the cats and account saved on this phone.')) return; try { await importKittyBackup(f); alert('Backup loaded! The game will now reload.'); window.location.reload(); } catch { alert('That file is not a KittyMart backup.'); } }} />
      </label>
      <button onClick={autoNameAllDogs} style={{ width: '100%', padding: 14, background: 'linear-gradient(135deg,#06d6a0,#059e76)', color: 'white', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 'bold', cursor: 'pointer', marginBottom: 10 }}>🏷️ Name All My Cats</button>
      <button onClick={() => setConfirmReset(true)} style={{ width: '100%', padding: 14, background: '#e63946', color: 'white', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 'bold', cursor: 'pointer', marginBottom: 10 }}>🗑️ Reset My Cats</button>
      <button onClick={() => setConfirmDelete(true)} style={{ width: '100%', padding: 14, background: '#b00020', color: 'white', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 'bold', cursor: 'pointer', marginBottom: 10 }}>❌ Delete Account</button>

      {/* Reset dogs confirmation modal */}
      {confirmReset && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: 'white', borderRadius: 20, padding: 28, width: '100%', maxWidth: 340, textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🗑️</div>
            <h3 style={{ margin: '0 0 10px', color: '#e63946', fontSize: 20 }}>Reset All Cats?</h3>
            <p style={{ margin: '0 0 24px', color: '#555', fontSize: 14, lineHeight: 1.5 }}>This will permanently delete <strong>all {dogs.length} of your cats</strong>. Your points and account will stay, but this <strong>cannot be undone</strong>.</p>
            <button onClick={resetDogs} style={{ width: '100%', padding: 14, background: '#e63946', color: 'white', border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 'bold', cursor: 'pointer', marginBottom: 10 }}>Yes, delete all my cats</button>
            <button onClick={() => setConfirmReset(false)} style={{ width: '100%', padding: 14, background: '#f0f0f0', color: '#333', border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 'bold', cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Delete account — step 1 */}
      {confirmDelete && !confirmDeleteFinal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: 'white', borderRadius: 20, padding: 28, width: '100%', maxWidth: 340, textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>⚠️</div>
            <h3 style={{ margin: '0 0 10px', color: '#b00020', fontSize: 20 }}>Delete Account?</h3>
            <p style={{ margin: '0 0 24px', color: '#555', fontSize: 14, lineHeight: 1.5 }}>This will permanently delete your account, <strong>all {dogs.length} cats</strong>, points, and all progress. There is no way to recover your data.</p>
            <button onClick={() => setConfirmDeleteFinal(true)} style={{ width: '100%', padding: 14, background: '#b00020', color: 'white', border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 'bold', cursor: 'pointer', marginBottom: 10 }}>I understand — continue</button>
            <button onClick={() => setConfirmDelete(false)} style={{ width: '100%', padding: 14, background: '#f0f0f0', color: '#333', border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 'bold', cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Delete account — step 2 final */}
      {confirmDeleteFinal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 701, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: 'white', borderRadius: 20, padding: 28, width: '100%', maxWidth: 340, textAlign: 'center', border: '3px solid #b00020' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>💀</div>
            <h3 style={{ margin: '0 0 10px', color: '#b00020', fontSize: 20 }}>Final Warning</h3>
            <p style={{ margin: '0 0 24px', color: '#555', fontSize: 14, lineHeight: 1.5 }}>You are about to permanently delete <strong>{player.username}</strong> and everything associated with it. This is <strong>irreversible</strong>.</p>
            {player.user_id && (
              <input type="password" value={deletePassword} onChange={e => setDeletePassword(e.target.value)} placeholder="Enter your password to confirm" autoComplete="current-password"
                style={{ width: '100%', padding: 12, borderRadius: 10, border: '2px solid #ddd', fontSize: 15, boxSizing: 'border-box', marginBottom: 10, outline: 'none' }} />
            )}
            {deleteError && <div style={{ color: '#b00020', fontSize: 13, marginBottom: 10, lineHeight: 1.4 }}>{deleteError}</div>}
            <button onClick={deleteAccount} disabled={deleting} style={{ width: '100%', padding: 14, background: '#b00020', color: 'white', border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 'bold', cursor: 'pointer', marginBottom: 10 }}>❌ Delete my account forever</button>
            <button onClick={() => { setConfirmDelete(false); setConfirmDeleteFinal(false); setDeletePassword(''); setDeleteError(''); }} style={{ width: '100%', padding: 14, background: '#f0f0f0', color: '#333', border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 'bold', cursor: 'pointer' }}>Cancel — keep my account</button>
          </div>
        </div>
      )}
      <button onClick={async () => {
        try {
          if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
          }
          if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.unregister()));
          }
        } catch {}
        window.location.reload(true);
      }} style={{ width: '100%', padding: 14, background: 'linear-gradient(135deg,#48cae4,#0096c7)', color: 'white', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 'bold', cursor: 'pointer', marginBottom: 10 }}>🔄 Force Refresh App</button>
      {!player.user_id && (
        <button onClick={() => setShowAddEmail(true)} style={{ width: '100%', padding: 14, background: 'linear-gradient(135deg,#667eea,#764ba2)', color: 'white', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 'bold', cursor: 'pointer', marginBottom: 10 }}>📧 Add Email & Set Password</button>
      )}
      {player.user_id && (
        <button onClick={() => setShowChangeEmail(true)} style={{ width: '100%', padding: 14, background: 'linear-gradient(135deg,#667eea,#764ba2)', color: 'white', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 'bold', cursor: 'pointer', marginBottom: 10 }}>📧 Change Email</button>
      )}
      <button onClick={() => setShowChangePassword(true)} style={{ width: '100%', padding: 14, background: '#6c757d', color: 'white', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 'bold', cursor: 'pointer', marginBottom: 10 }}>🔒 Change Password</button>
      <button onClick={onLogout} style={{ width: '100%', padding: 14, background: '#764ba2', color: 'white', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 'bold', cursor: 'pointer' }}>Log Out</button>
      {showChangePassword && <ChangePasswordModal player={player} onDone={(ok) => { setShowChangePassword(false); if (ok) showToast('Password updated! 🔒'); }} />}
      {showAddEmail && <AddEmailModal player={player} requirePassword={false} onDone={(savedEmail) => { setShowAddEmail(false); if (savedEmail) { showToast('Email saved! You can now reset your password. 📧'); } }} />}
      {showChangeEmail && <ChangeEmailModal player={player} onDone={(newEmail) => { setShowChangeEmail(false); if (newEmail) showToast('Email updated! 📧'); }} />}
      {alertMsg && <AlertPopup message={alertMsg} onClose={() => setAlertMsg('')} />}
      {showPrivacy && <PrivacyPolicyModal onClose={() => setShowPrivacy(false)} />}
      {showFriends && <FriendsGalleryModal onClose={() => setShowFriends(false)} />}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [player, setPlayer] = useState(() => { try { return JSON.parse(localStorage.getItem('kittymart_player')); } catch { return null; } });
  const [dogs, setDogs] = useState([]);
  // When a custom photo is removed in the dog screen, update the shared dogs list too
  useEffect(() => {
    const onCleared = (e) => { const { id, url } = e.detail || {}; setDogs(ds => ds.map(d => d.id === id ? { ...d, photo_url: url } : d)); };
    window.addEventListener('km_photo_cleared', onCleared);
    return () => window.removeEventListener('km_photo_cleared', onCleared);
  }, []);
  // Real cat photos arrive in the background: re-render when new ones are cached, and warm
  // the photo lists for breeds the player owns so older cats can show real photos too.
  const [, setPhotoTick] = useState(0);
  useEffect(() => {
    let t = null;
    const onPhotos = () => { clearTimeout(t); t = setTimeout(() => setPhotoTick(n => n + 1), 250); };
    window.addEventListener('km_photos', onPhotos);
    return () => { window.removeEventListener('km_photos', onPhotos); clearTimeout(t); };
  }, []);
  useEffect(() => {
    if (!dogs.length) return;
    warmBreedPhotos([...new Set(dogs.map(d => d.breed))]);
  }, [dogs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // One-time correction: Tessa (Indiana's Cavoodle) was a girl; an update reset her gender to Male.
  useEffect(() => {
    const TESSA = '9344cd4b-5f62-48f2-8b26-4ad47d47d330';
    if (!dogs.some(d => d.id === TESSA)) return;
    if (localStorage.getItem('km_fix_tessa_gender') === '1') return;
    try { setDogGender(TESSA, 'Female'); localStorage.setItem('km_fix_tessa_gender', '1'); } catch {}
  }, [dogs]);

  const [dogsLoaded, setDogsLoaded] = useState(false);
  const [dogsLoadError, setDogsLoadError] = useState(false);
  // Set to true once the login restore effect has finished fetching bonus_pts,
  // race_wins, player_data etc from DB. Gates the after-dogs-load DB write so
  // we never overwrite real race_wins/training_pts with stale empty localStorage.
  const [statsRestored, setStatsRestored] = useState(false);
  const [tab, setTab] = useState('home');
  const [musicOn, setMusicOn] = useState(false);
  const holiday = React.useMemo(() => getHolidayTheme(), []);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onlineCount, setOnlineCount] = useState(0);
  const [onlineIds, setOnlineIds] = useState(new Set());
  const [friendActivityToast, setFriendActivityToast] = useState(null);
  // Shows whether a big save (Litter Scooper, treat bags) actually reached the cloud.
  const [saveStatus, setSaveStatus] = useState(null);
  useEffect(() => {
    let timer = null;
    const onStatus = (e) => {
      const d = (e && e.detail) || {};
      const good = d.ok && !d.failedLocal;
      const msg = d.failedLocal > 0 ? `⚠️ The game's saved-data space on this phone is full: ${d.failedLocal} cats could not be updated.`
        : d.ok ? '☁️ Saved'
        : `⚠️ Couldn't save to the cloud (${d.err}). Keep the app open and try again.`;
      setSaveStatus({ msg, good });
      clearTimeout(timer);
      timer = setTimeout(() => setSaveStatus(null), good ? 2500 : 10000);
    };
    window.addEventListener('km_save_status', onStatus);
    return () => { clearTimeout(timer); window.removeEventListener('km_save_status', onStatus); };
  }, []);
  const bonusPts = useLive(getBonusPts, 'km_pts_change');

  const toggleMusic = () => {
    if (musicOn) { stopBgMusic(); setMusicOn(false); }
    else { startBgMusic(); setMusicOn(true); }
  };

  const loadDogs = useCallback(async ({ silent = false } = {}) => {
    if (!player) return;
    // Retry once on a flaky connection before telling the player anything is wrong.
    // Pass { silent: true } for background refreshes (e.g. after a catch) so a
    // momentary hiccup doesn't show the error banner — the dog was already saved.
    const maxAttempts = silent ? 1 : 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Fetch pages in parallel batches (ordered by name, so page order is stable) instead of
        // one request at a time — a 6,000-dog collection used to take 7 round trips in a row.
        let allDogs = [];
        let from = 0;
        const pageSize = 1000;
        const batch = 4;
        let done = false;
        while (!done) {
          const offsets = Array.from({ length: batch }, (_, i) => from + i * pageSize);
          const pages = await Promise.all(offsets.map(off =>
            fetchDogPage(`cats?owner_id=eq.${player.id}&select=*&order=name.asc&limit=${pageSize}&offset=${off}`)));
          for (const page of pages) {
            allDogs = allDogs.concat(page);
            if (page.length < pageSize) { done = true; break; }
          }
          from += batch * pageSize;
        }
        setDogs(allDogs);
        setDogsLoaded(true);
        setDogsLoadError(false);
        restoreDogStatesFromMeta(allDogs);
        return;
      } catch (e) {
        console.error(e);
        if (attempt < maxAttempts - 1) await new Promise(r => setTimeout(r, 800));
      }
    }
    if (!silent) {
      setDogsLoadError(true);
      // Auto-dismiss the banner after 10s so players don't have to close the app
      setTimeout(() => setDogsLoadError(false), 10000);
    }
  }, [player]);

  useEffect(() => { loadDogs(); }, [loadDogs]);

  // Home stats: show the last cached summary immediately, then the live numbers once loaded.
  const stats = React.useMemo(() => {
    if (dogsLoaded) return summarizeDogs(dogs);
    return (player && readCachedStats(player.id)) || null;
  }, [dogsLoaded, dogs, player]);
  useEffect(() => {
    if (!player || !dogsLoaded) return;
    try { localStorage.setItem('kittymart_stats_' + player.id, JSON.stringify(summarizeDogs(dogs))); } catch {}
  }, [player, dogsLoaded, dogs]);

  // Unlock any achievements already earned (catches before achievements existed)
  useEffect(() => {
    if (!player || dogs.length === 0) return;
    checkAchievements(dogs, () => {});
  }, [player, dogs.length]); // eslint-disable-line

  // One-time rarity migration: fix dogs whose breed rarity was changed
  useEffect(() => {
    if (!player || dogs.length === 0) return;
    const CORRECT = { 'Akita': 'Epic', 'King Charles Cavalier': 'Legendary' };
    const toFix = dogs.filter(d => CORRECT[d.breed] && d.rarity !== CORRECT[d.breed]);
    if (!toFix.length) return;
    toFix.forEach(dog => {
      sb(`cats?id=eq.${dog.id}`, 'PATCH', { rarity: CORRECT[dog.breed] }).catch(() => {});
    });
    setDogs(prev => prev.map(d => CORRECT[d.breed] && d.rarity !== CORRECT[d.breed] ? { ...d, rarity: CORRECT[d.breed] } : d));
  }, [player, dogs.length]); // eslint-disable-line

  // Show onboarding for new players
  useEffect(() => { if (player && !hasSeenOnboarding()) setShowOnboarding(true); }, [player]);

  // Self-healing: re-fetch this player's canonical row id (by username) and, if the stored id doesn't match,
  // update localStorage so loadDogs (which uses player.id) finds the right dogs. Only the small id/username
  // columns are requested; for normal players the ids match and nothing happens.
  useEffect(() => {
    if (!player || !player.username) return;
    (async () => {
      try {
        const rows = await sb(`players?username=ilike.${encodeURIComponent(player.username)}&select=id,username&limit=5`);
        const canonical = (rows || []).find(r => r.username && r.username.toLowerCase() === player.username.toLowerCase());
        if (canonical && canonical.id !== player.id) {
          const updated = { ...player, ...canonical };
          localStorage.setItem('kittymart_player', JSON.stringify(updated));
          setPlayer(updated); // triggers loadDogs with correct id
        }
      } catch { /* silent — don't block login */ }
    })();
  }, [player?.id]); // eslint-disable-line

  // On login: load bonus_pts from DB into the in-memory mirror so all reads are instant.
  // Also restore race_wins and kitty_dollars. player_data restores daily challenges etc.
  useEffect(() => {
    if (!player) return;
    _bonusPtsPlayerId = player.id;
    _bonusPtsLoaded = false;
    _pendingBonusDeltas = [];
    let cancelled = false;
    (async () => {
      try {
        const rows = await sb(`players?id=eq.${player.id}&select=bonus_pts,race_wins,training_pts,kitty_dollars,player_data`);
        if (cancelled) return;
        const row = (rows && rows[0]) || {};
        // 1. Restore player_data FIRST so all km_* localStorage keys reflect cloud state.
        //    Cloud always wins here — this covers dog state, achievements, cosmetics,
        //    house, streaks, etc. Dedicated DB columns are applied next and override
        //    the JSONB backup where they have authoritative values.
        if (row.player_data) { const pdata = await unpackPlayerData(row.player_data); if (pdata) restorePlayerData(pdata); }
        // 2. race_wins: dedicated column is authoritative — take max of DB vs restored local.
        const dbWins = parseInt(row.race_wins || 0, 10);
        const localWins = parseInt(localStorage.getItem('km_race_wins') || '0', 10);
        if (dbWins > localWins) localStorage.setItem('km_race_wins', String(dbWins));
        // 3. kitty_dollars: dedicated column is authoritative — take max.
        const dbDD = parseInt(row.kitty_dollars || 0, 10);
        if (dbDD > getDD()) { try { localStorage.setItem('km_dd', dbDD); window.dispatchEvent(new Event('km_dd_change')); } catch {} }
        // 4. bonus_pts: DB is the single source of truth — load it directly.
        //    Any points earned during login (e.g. daily streak) were queued in
        //    _pendingBonusDeltas and are now written atomically on top.
        //    Fall back to localStorage if DB column is missing/null (e.g. new column not yet set).
        let dbBonusPts = Math.max(0, parseInt(row.bonus_pts || 0, 10));
        const localBonusPts = Math.max(0, parseInt(localStorage.getItem('km_bonus_pts') || '0', 10));
        // Take the higher of DB and local — DB wins if it has data, local saves us if DB is 0/null
        _bonusPts = Math.max(dbBonusPts, localBonusPts);
        _bonusPtsLoaded = true;
        window.dispatchEvent(new Event('km_pts_change'));
        // Flush any points earned before DB was ready (e.g. login streak reward)
        const pending = _pendingBonusDeltas.splice(0);
        if (pending.length > 0) {
          const pendingTotal = pending.reduce((s, d) => s + d, 0);
          _bonusPts = Math.max(0, _bonusPts + pendingTotal);
          await _writeBonusDelta(pendingTotal);
        }
        // Signal that DB values are now in localStorage — the after-dogs-load effect
        // can safely write race_wins and training_pts without overwriting real data.
        if (!cancelled) setStatsRestored(true);
      } catch (e) {
        console.error('Stats restore error:', e);
        // Even on failure, mark as loaded so pending deltas don't queue forever.
        // _bonusPts stays at whatever was accumulated pre-load; the next addBonusPts
        // call will write it to DB, which is wrong but far less damaging than the
        // alternative of a perpetually-blocked queue.
        _bonusPtsLoaded = true;
        _pendingBonusDeltas = [];
        if (!cancelled) setStatsRestored(true);
      }
    })();
    return () => { cancelled = true; };
  }, [player]);

  // After dogs load AND login restore completes: write total_pts + race_wins +
  // training_pts back to DB. Gated on statsRestored so we never overwrite real
  // DB values with stale/empty localStorage (e.g. on a new device or after a
  // cache clear). race_wins and km_dog_* are only trustworthy in localStorage
  // after restorePlayerData has run inside the login restore.
  useEffect(() => {
    if (!player || dogs.length === 0 || !statsRestored) return;
    let cancelled = false;
    // Debounced: computeTrainingPts() scans every localStorage key, so don't run it on every single catch.
    const timer = setTimeout(() => { (async () => {
      try {
        const trainingPts = computeTrainingPts();
        const raceWins = parseInt(localStorage.getItem('km_race_wins') || '0', 10);
        const realTotal = getTotalPts(dogs);
        if (cancelled) return;
        await sb(`players?id=eq.${player.id}`, 'PATCH', {
          total_pts: realTotal,
          race_wins: raceWins,
          training_pts: trainingPts,
        });
      } catch (e) { console.error('Stats sync error:', e); }
    })(); }, 5000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [player, dogs, statsRestored]);

  // Online presence heartbeat — lightweight ping every 60s, full DB sync every 3 min.
  // Depends on [player] only: it used to re-run (and upload ~1.7 MB) on every dogs change, i.e. every catch.
  const dogsRef = React.useRef(dogs);
  dogsRef.current = dogs;
  useEffect(() => {
    if (!player) return;
    let lastSync = 0;
    const ping = async () => {
      await updatePresence(player.id, player.username);
      const online = await getOnlinePlayers();
      setOnlineCount(online.length);
      setOnlineIds(new Set((online || []).map(o => o.player_id)));
      // Full DB sync (total_pts + player_data) at most every ~3 minutes, and only once the dogs have loaded
      // (otherwise total_pts would be written without the dog points).
      if (dogsRef.current.length > 0 && Date.now() - lastSync > 170000) {
        lastSync = Date.now();
        const liveTotal = getTotalPts(dogsRef.current);
        // (login_streak was sent here too, but players has no such column, so Supabase rejected the whole update.)
        sb(`players?id=eq.${player.id}`, 'PATCH', { total_pts: liveTotal, player_data: await packPlayerDataZ() }, 30000).catch(() => {});
      }
      // Friend activity notifications — check if a friend just caught a Legendary/Epic
      try {
        const friendRows = await getMyFriends(player.id);
        if (friendRows.length > 0) {
          const friendIds = friendRows.map(f => f.id);
          const orFilter = friendIds.map(id => `owner_id.eq.${id}`).join(',');
          const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
          const recentDogs = await sb(`cats?or=(${orFilter})&rarity=in.(Legendary,Epic)&caught_at=gte.${encodeURIComponent(cutoff)}&select=owner_id,breed,rarity&limit=5`);
          if (Array.isArray(recentDogs) && recentDogs.length > 0) {
            const seenKey = 'km_friend_notif_seen';
            let seen = [];
            try { seen = JSON.parse(localStorage.getItem(seenKey) || '[]'); } catch {}
            for (const d of recentDogs) {
              const notifId = `${d.owner_id}_${d.breed}_${cutoff.slice(0,16)}`;
              if (!seen.includes(notifId)) {
                const friend = friendRows.find(f => f.id === d.owner_id);
                if (friend) {
                  const emoji = d.rarity === 'Legendary' ? '⭐' : '✨';
                  setFriendActivityToast(`${emoji} ${friend.username} just caught a ${d.rarity} ${d.breed}!`);
                  setTimeout(() => setFriendActivityToast(null), 5000);
                  seen = [...seen.slice(-20), notifId]; // keep last 20
                  localStorage.setItem(seenKey, JSON.stringify(seen));
                  break; // show one at a time
                }
              }
            }
          }
        }
      } catch { /* friend notifications are best-effort */ }
    };
    ping();
    const t = setInterval(ping, 60000);
    // Push total_pts immediately when DD changes (kitty dollars affect leaderboard score)
    const onDDChange = () => {
      sb(`players?id=eq.${player.id}`, 'PATCH', { kitty_dollars: getDD() }).catch(() => {});
    };
    window.addEventListener('km_dd_change', onDDChange);
    return () => {
      clearInterval(t);
      window.removeEventListener('km_dd_change', onDDChange);
    };
  }, [player]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = (p) => { localStorage.setItem('kittymart_player', JSON.stringify(p)); setPlayer(p); };
  useEffect(() => { if (player) scheduleReminderNotifications(); }, [player]);
  const handleLogout = async () => {
    // Flush all unsaved state to cloud before wiping localStorage
    if (_bonusPtsPlayerId) {
      // Flush kitty_dollars and player_data on logout.
      // bonus_pts is already server-authoritative (written immediately on every award).
      await sb(`players?id=eq.${_bonusPtsPlayerId}`, 'PATCH', {
        kitty_dollars: getDD(),
        player_data: await packPlayerDataZ(),
      }).catch(() => {});
    }
    _bonusPts = 0; _bonusPtsPlayerId = null; _bonusPtsLoaded = false; _pendingBonusDeltas = []; _offlineQueue = [];
    Object.keys(localStorage).filter(k => k.startsWith('km_')).forEach(k => localStorage.removeItem(k));
    localStorage.removeItem('kittymart_player');
    setPlayer(null); setDogs([]); setDogsLoaded(false); setStatsRestored(false);
  };

  if (new URLSearchParams(window.location.search).get('reset') === '1') return <ResetPasswordScreen />;

  if (!player) return <LoginScreen onLogin={handleLogin} />;

  const totalPoints = (stats ? stats.pts : calcPoints(dogs)) + bonusPts;

  const TABS = [
    { id: 'home',        icon: '🏠', label: 'Home' },
    { id: 'catch',       icon: '🧶', label: 'Catch' },
    { id: 'collection',  icon: '🐱', label: 'Cats' },
    { id: 'mart',        icon: '🛒', label: 'Mart' },
    { id: 'race',        icon: '🏁', label: 'Race' },
    { id: 'training',    icon: '🏫', label: 'School' },
    { id: 'leaderboard', icon: '🏆', label: 'Board' },
    { id: 'settings',    icon: '👤', label: 'Me' },
  ];

  return (
    <div className="pm-app-root" style={{ maxWidth: 440, margin: '0 auto', height: '100dvh', minHeight: '-webkit-fill-available', boxSizing: 'border-box', paddingTop: 'env(safe-area-inset-top, 0px)', background: holiday ? holiday.gradient : 'linear-gradient(180deg,#b8e8c8 0%,#e8f5e0 35%,#fffbe6 100%)', backgroundAttachment: 'fixed', fontFamily: '"Nunito", "Comic Sans MS", Georgia, serif', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');
        @keyframes flashIn { from { opacity:0; transform:scale(1.2); } to { opacity:1; transform:scale(1); } }
        @keyframes slideUp { from { transform:translateY(20px); opacity:0; } to { transform:translateY(0); opacity:1; } }
        @keyframes leafFloat { 0%,100% { transform:translateY(0) rotate(0deg); } 50% { transform:translateY(-8px) rotate(5deg); } }
        * { -webkit-tap-highlight-color: transparent; }
        html, body { overscroll-behavior-y: contain; height: 100%; margin: 0; padding: 0; overflow: hidden; background: #000; }
        .pm-card { background: rgba(255,255,255,0.82) !important; border-radius: 20px !important; box-shadow: 0 4px 18px rgba(90,140,80,0.13), 0 1px 4px rgba(0,0,0,0.06) !important; border: 1.5px solid rgba(160,210,140,0.35) !important; backdrop-filter: blur(6px); }
        button { font-family: "Nunito", "Comic Sans MS", Georgia, serif !important; }
        @media (min-width: 600px) {
          .pm-app-root  { max-width: 100% !important; }
          .pm-nav-bar   { max-width: 100% !important; }
          .pm-catch-box { max-width: 100% !important; height: calc(100vh - 280px) !important; }
        }
      `}</style>
      <Fireworks />
      <FloatingScorePopup />
      <BigWinModal />
      <ComboTextBurst />
      {holiday && <FloatingEmojis emojis={holiday.emojis} />}
      {showOnboarding && <OnboardingModal onDone={() => setShowOnboarding(false)} />}
      <div style={{ flexShrink: 0 }}>
        {holiday && <HolidayBanner theme={holiday} />}
        <div style={{ background: holiday ? holiday.gradient : 'linear-gradient(160deg,#5aab6a 0%,#7bc67a 50%,#a8d8a8 100%)', color: 'white', padding: '12px 20px 10px', textAlign: 'center', position: 'relative', boxShadow: '0 4px 16px rgba(60,120,60,0.18)' }}>
          <button onClick={toggleMusic} style={{ position:'absolute', top:10, right:14, background:'rgba(255,255,255,0.2)', border:'none', borderRadius:20, padding:'4px 10px', color:'white', fontSize:16, cursor:'pointer' }} title={musicOn ? 'Mute music' : 'Play music'}>
            {musicOn ? '🔊' : '🔇'}
          </button>
          <img src={kmLogo(holiday)} alt="KittyMart" style={{ height: holiday?.name === 'Halloween' ? 110 : 55, borderRadius: 12, marginBottom: 2 }} />
          <p style={{ margin: '2px 0 0', fontSize: 12, opacity: 0.85 }}>Hi {player.username}! · 🐱 {dogsLoadError ? '⚠️' : (stats ? stats.count : dogs.length)} · ⭐ {totalPoints}pts · {ONLINE && <><span style={{color:'#a0ffa0',fontWeight:'bold'}}>🟢 {onlineCount} online</span> · </>}<span style={{opacity:0.5,fontSize:10}}>v1.{APP_VERSION - 137}</span></p>
        </div>
      </div>
      {dogsLoadError && (
        <div style={{ flexShrink: 0, background: '#fff3cd', borderBottom: '1px solid #ffe69c', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
          <span style={{ flex: 1, color: '#664d03' }}>⚠️ Couldn't load your cats — they're safe, this is just a connection issue. Check your signal and retry.</span>
          <button onClick={loadDogs} style={{ flexShrink: 0, padding: '6px 12px', background: '#4a9e5c', color: 'white', border: 'none', borderRadius: 10, fontWeight: 'bold', fontSize: 12, cursor: 'pointer' }}>Retry</button>
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {tab === 'home'        && <HomeScreen player={player} dogs={dogs} stats={stats} onNavigate={setTab} />}
        {tab === 'catch'       && <CatchScreen player={player} dogs={dogs} onCatch={(newDog) => {
          // Re-downloading the whole collection after every catch froze big accounts (7,000+ dogs) and
          // burned data; add the new dog locally and only reload if we don't have it.
          if (newDog && newDog.id) setDogs(prev => prev.some(d => d.id === newDog.id) ? prev : prev.concat(newDog));
          else loadDogs({ silent: true });
        }} />}
        {tab === 'collection'  && <CollectionScreen player={player} dogs={dogs} setDogs={setDogs} onNavigateTrade={() => setTab('trade')} onNavigateSearch={() => setTab('search')} playerScore={player.score} setPlayerScore={s => setPlayer(p=>({...p,score:s}))} dogsLoadError={dogsLoadError} dogsLoaded={dogsLoaded} />}
        {tab === 'cosy'        && <CosyCornerScreen dogs={dogs} onBack={() => setTab('home')} />}
        {tab === 'vet'         && <VetScreen player={player} dogs={dogs} setDogs={setDogs} onBack={() => setTab('home')} />}
        {tab === 'race'        && <PetRaceScreen player={player} dogs={dogs} setPlayer={setPlayer} onlineCount={onlineCount} />}
        {tab === 'training'    && <TrainingSchoolScreen player={player} dogs={dogs} />}
        {tab === 'tasks'       && <TasksScreen dogs={dogs} />}
        {tab === 'mart'        && <MartScreen dogs={dogs} totalPoints={totalPoints} />}
        {tab === 'search'      && <SearchScreen />}
        {tab === 'trade'       && <TradeScreen player={player} myDogs={dogs} onDogUpdate={loadDogs} onBack={() => setTab('home')} />}
        {tab === 'market'      && <MartScreen dogs={dogs} totalPoints={totalPoints} />}
        {tab === 'leaderboard' && <LeaderboardScreen currentPlayer={player} myTotalPts={totalPoints} onlineIds={onlineIds} />}
        {tab === 'settings'    && <SettingsScreen player={player} dogs={dogs} onLogout={handleLogout} onDogsReset={loadDogs} setPlayer={setPlayer} />}
      </div>
      {saveStatus && (
        <div style={{ position: 'fixed', bottom: 84, left: 16, right: 16, margin: '0 auto', maxWidth: 360, background: saveStatus.good ? '#2e7d32' : '#e65100', color: 'white', borderRadius: 16, padding: '10px 16px', fontWeight: 'bold', fontSize: 13, textAlign: 'center', zIndex: 1600, boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>
          {saveStatus.msg}
        </div>
      )}
      {friendActivityToast && (
        <div style={{ position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', background: 'linear-gradient(135deg,#ffd700,#f4a261)', color: 'white', borderRadius: 20, padding: '12px 20px', fontWeight: 'bold', fontSize: 14, zIndex: 1500, boxShadow: '0 4px 20px rgba(0,0,0,0.3)', textAlign: 'center', maxWidth: 320, animation: 'slideUp 0.3s ease-out', whiteSpace: 'nowrap' }}>
          {friendActivityToast}
        </div>
      )}
      <div className="pm-nav-bar" style={{ flexShrink: 0, width: '100%', maxWidth: 440, background: holiday ? '#1a0533' : 'rgba(255,253,240,0.97)', borderTop: holiday ? `1px solid ${holiday.nav}55` : '2px solid #c8e6c0', display: 'flex', boxShadow: '0 -4px 20px rgba(80,140,80,0.10)', paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 16px)' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ flex: 1, minWidth: 0, padding: '8px 2px 6px', border: 'none', background: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, color: tab === t.id ? (holiday?.nav || '#4a9e5c') : '#9ab89a', borderTop: `3px solid ${tab === t.id ? (holiday?.nav || '#4a9e5c') : 'transparent'}`, transition: 'all 0.15s' }}>
            <span style={{ fontSize: 20, lineHeight: 1 }}>{t.icon}</span>
            <span style={{ fontSize: 10, fontWeight: 'bold', lineHeight: 1 }}>{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
