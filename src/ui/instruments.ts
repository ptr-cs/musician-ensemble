import type { InstrumentKind } from '../performance/personas';

const BODY_PATH = `M50 105 C66 105 82 112 82 135 C82 152 76 160 79 166 C70 172 68 196 79 210
  C76 216 90 226 89 252 C88 280 70 292 50 292 C30 292 12 280 11 252 C10 226 24 216 21 210
  C32 196 30 172 21 166 C24 160 18 152 18 135 C18 112 34 105 50 105 Z`;

const F_HOLE = (x: number, flip: number) =>
  `<path d="M${x} 196 c${-4 * flip} 6 ${4 * flip} 14 0 22 s${-4 * flip} 14 0 20" fill="none" stroke="#2a1206" stroke-width="2" stroke-linecap="round"/>
   <circle cx="${x}" cy="195" r="1.8" fill="#2a1206"/><circle cx="${x}" cy="239" r="1.8" fill="#2a1206"/>`;

function stringInstrument(kind: InstrumentKind, id: string): string {
  const cello = kind === 'cello';
  const viewHeight = cello ? 340 : 300;
  const tone = kind === 'violin' ? ['#c9772f', '#7a3311'] : kind === 'viola' ? ['#b0612a', '#5e2610'] : ['#a4552a', '#4f1f0d'];
  const bow = cello
    ? `<g class="bow" id="${id}-bow"><line x1="-30" y1="236" x2="132" y2="214" stroke="#d8c7a0" stroke-width="2.2" stroke-linecap="round"/>
         <line x1="-30" y1="239" x2="132" y2="217" stroke="#3b2a1a" stroke-width="3"/></g>`
    : `<g class="bow" id="${id}-bow"><line x1="-36" y1="244" x2="136" y2="222" stroke="#d8c7a0" stroke-width="1.8" stroke-linecap="round"/>
         <line x1="-36" y1="247" x2="136" y2="225" stroke="#3b2a1a" stroke-width="2.6"/></g>`;
  return `
  <svg viewBox="-40 0 180 ${viewHeight}" role="img" aria-label="${kind}">
    <defs>
      <radialGradient id="${id}-varnish" cx="40%" cy="35%" r="75%">
        <stop offset="0" stop-color="${tone[0]}"/>
        <stop offset="1" stop-color="${tone[1]}"/>
      </radialGradient>
    </defs>
    ${cello ? '<line x1="50" y1="290" x2="50" y2="336" stroke="#9c9c9c" stroke-width="2.5" stroke-linecap="round"/>' : ''}
    <path d="${BODY_PATH}" fill="url(#${id}-varnish)" stroke="#2a1206" stroke-width="1.5"/>
    <path d="${BODY_PATH}" fill="none" stroke="rgba(255,220,170,0.25)" stroke-width="1" transform="translate(50 198) scale(0.94) translate(-50 -198)"/>
    ${F_HOLE(36, 1)}${F_HOLE(64, -1)}
    <rect x="45" y="26" width="10" height="84" rx="3" fill="#6b3416"/>
    <rect x="43.5" y="44" width="13" height="160" rx="4" fill="#15100c"/>
    <path d="M50 4 a8 8 0 1 1 -0.1 0 M46 10 h8 v22 h-8z" fill="#7a3a17" stroke="#2a1206" stroke-width="1"/>
    <rect x="41" y="226" width="18" height="4" rx="1" fill="#e8d2a8"/>
    <path d="M44 246 L56 246 L58 282 L42 282 Z" fill="#15100c"/>
    <g stroke="#e9e3d6" stroke-width="0.7" opacity="0.85">
      <line x1="47" y1="28" x2="45.5" y2="248"/><line x1="49" y1="28" x2="48.5" y2="248"/>
      <line x1="51" y1="28" x2="51.5" y2="248"/><line x1="53" y1="28" x2="54.5" y2="248"/>
    </g>
    ${bow}
  </svg>`;
}

function clarinet(id: string): string {
  return `
  <svg viewBox="-60 0 180 300" role="img" aria-label="clarinet">
    <defs>
      <linearGradient id="${id}-wood" x1="0" x2="1">
        <stop offset="0" stop-color="#1c1714"/><stop offset="0.45" stop-color="#3b322c"/><stop offset="1" stop-color="#120e0c"/>
      </linearGradient>
      <linearGradient id="${id}-silver" x1="0" x2="1">
        <stop offset="0" stop-color="#8c8c8c"/><stop offset="0.5" stop-color="#f0f0f0"/><stop offset="1" stop-color="#7a7a7a"/>
      </linearGradient>
    </defs>
    <path d="M27 2 L33 2 L35 30 L25 30 Z" fill="#0b0b0b"/>
    <rect x="24" y="22" width="12" height="5" fill="url(#${id}-silver)"/>
    <rect x="23" y="30" width="14" height="26" rx="2" fill="url(#${id}-wood)"/>
    <rect x="22.5" y="54" width="15" height="4" fill="url(#${id}-silver)"/>
    <rect x="24" y="58" width="12" height="104" fill="url(#${id}-wood)"/>
    <rect x="22.5" y="160" width="15" height="4" fill="url(#${id}-silver)"/>
    <rect x="24" y="164" width="12" height="92" fill="url(#${id}-wood)"/>
    <path d="M24 256 L36 256 C38 274 46 288 52 296 L8 296 C14 288 22 274 24 256 Z" fill="url(#${id}-wood)"/>
    <rect x="7" y="294" width="46" height="4" rx="2" fill="url(#${id}-silver)"/>
    <g fill="#0b0b0b" stroke="url(#${id}-silver)" stroke-width="1.2">
      <circle cx="30" cy="80" r="2.6"/><circle cx="30" cy="96" r="2.6"/><circle cx="30" cy="112" r="2.6"/>
      <circle cx="30" cy="186" r="2.6"/><circle cx="30" cy="202" r="2.6"/><circle cx="30" cy="218" r="2.6"/>
    </g>
    <g stroke="url(#${id}-silver)" stroke-width="1.4" fill="none" stroke-linecap="round">
      <path d="M36 70 L40 70 L40 140 L36 140"/><path d="M24 128 L20 128 L20 150"/>
      <path d="M36 176 L40 176 L40 240 L36 244"/><path d="M24 232 L19 236 L19 250"/>
    </g>
  </svg>`;
}

export function instrumentSvg(kind: InstrumentKind, id: string): string {
  return kind === 'clarinet' ? clarinet(id) : stringInstrument(kind, id);
}
