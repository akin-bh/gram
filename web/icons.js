const paths = {
  book: ['M4 19.5V5a2 2 0 0 1 2-2h14v15H6.5A2.5 2.5 0 0 0 4 20.5 2.5 2.5 0 0 0 6.5 23H20v-5', 'M8 7h8M8 11h6'],
  grid: ['M5 3h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M15 3h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M5 13h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Z', 'M15 13h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Z'],
  mail: ['M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z', 'm3 7 9 6 9-6'],
  wallet: ['M20 7H5a2 2 0 0 1 0-4h13v4', 'M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1', 'M21 11h-5a3 3 0 0 0 0 6h5', 'M16 14h.01'],
  box: ['m12 3 9 5v9l-9 5-9-5V8l9-5Z', 'm3 8 9 5 9-5', 'M12 13v9', 'm7.5 5.5 9 5V15'],
  files: ['M8 3h8l4 4v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M16 3v5h4', 'M3 7v10', 'M10 12h6M10 16h6'],
  sparkles: ['m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z', 'M20 2v4M18 4h4', 'M3 19v3M1.5 20.5h3'],
  send: ['m21 3-7 18-4-7-7-4 18-7Z', 'M10 14 21 3'],
  check: ['M9 3h6v4H9V3Z', 'M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3', 'm8 14 3 3 5-6'],
  plus: ['M12 5v14M5 12h14'],
  search: ['M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z', 'm16 16 5 5'],
  sidebar: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M9 3v18'],
  close: ['m6 6 12 12M6 18 18 6'],
  stop: ['M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z'],
  more: ['M5 12h.01M12 12h.01M19 12h.01'],
  pin: ['m16 3 5 5-3 1-4 5v3l-3-3-4-4h3l5-4 1-3Z', 'm10 14-7 7'],
  star: ['m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z'],
  'split-right': ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M12 3v18', 'M15 12h3m-2-2 2 2-2 2'],
  'split-down': ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M3 12h18', 'M12 15v3m-2-2 2 2 2-2'],
  'arrow-left': ['M19 12H5m7-7-7 7 7 7'],
  'arrow-right': ['M5 12h14m-7-7 7 7-7 7'],
  refresh: ['M20 7v5h-5', 'M20 12a8 8 0 1 0-2.3 5.7'],
  sun: ['M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z', 'M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'],
  moon: ['M20.9 13.1A9 9 0 0 1 10.9 3.1 9 9 0 1 0 20.9 13.1Z'],
  settings: ['M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z', 'm9 3-.5 2-2 1.2-2-.5-2 3.4L4 10.5v3L2.5 15l2 3.4 2-.6 2 1.2.5 2h4l.5-2 2-1.2 2 .6 2-3.4-1.5-1.5v-3L21.5 9l-2-3.3-2 .5-2-1.2-.5-2H9Z'],
  file: ['M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M14 3v6h5'],
  folder: ['M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z'],
  clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M12 7v5l3 2'],
  compose: ['M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7', 'm18 3 3 3-10 10-4 1 1-4L18 3Z', 'm15 6 3 3'],
  external: ['M14 3h7v7M21 3 10 14', 'M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5'],
  copy: ['M10 9h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z', 'M16 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3'],
  download: ['M12 3v12m-5-5 5 5 5-5', 'M3 16v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3'],
  'chevron-down': ['m6 9 6 6 6-6'],
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1Z'],
};

const aliases = { books: 'book', work: 'inbox', overview: 'grid', finance: 'wallet', procurement: 'box', sources: 'files', agent: 'sparkles', delivery: 'send', audit: 'check', create: 'plus' };
const namespace = 'http://www.w3.org/2000/svg';

/** The Gram mark: an ink tile holding two linked cream squares. Theme overrides via --logo-tile/--logo-square. */
function logo() {
  const svg = document.createElementNS(namespace, 'svg');
  for (const [key, value] of Object.entries({ width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
  for (const [x, y, size, radius, fill] of [[1, 1, 22, 6.5, 'var(--logo-tile, #1b1b19)'], [4.8, 5.1, 7.9, 2.4, 'var(--logo-square, #f0efec)'], [11.3, 11, 7.9, 2.4, 'var(--logo-square, #f0efec)']]) {
    const rect = document.createElementNS(namespace, 'rect');
    for (const [key, value] of Object.entries({ x, y, width: size, height: size, rx: radius })) rect.setAttribute(key, String(value));
    rect.style.fill = fill;
    svg.append(rect);
  }
  return svg;
}

/** A fresh, decorative SVG. Accessible names belong on the containing control. */
export function icon(name) {
  if (name === 'logo') return logo();
  const svg = document.createElementNS(namespace, 'svg');
  for (const [key, value] of Object.entries({ width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
  const canonical = Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : name;
  const drawing = Object.prototype.hasOwnProperty.call(paths, canonical) ? paths[canonical] : paths.file;
  for (const d of drawing) {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
