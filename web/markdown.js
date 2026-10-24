import { lexer } from 'marked';

const MAX_SOURCE = 200000;
const MAX_NODES = 10000;
const MAX_DEPTH = 32;
const namedEntities = {
  amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'",
  euro: '€', trade: '™', COPY: '©', REG: '®', NonBreakingSpace: '\u00a0',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', minus: '−', radic: '√',
  colon: ':', semi: ';', sol: '/', bsol: '\\', Tab: '\t', NewLine: '\n',
  num: '#', percnt: '%', commat: '@', dollar: '$', equals: '=', lowbar: '_',
  lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lcub: '{', rcub: '}',
  excl: '!', quest: '?', ast: '*', period: '.', comma: ',', vert: '|',
};
// The contiguous Latin-1 entity names cover ordinary accented text and currencies.
'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(' ').forEach((name, index) => { namedEntities[name] = String.fromCodePoint(160 + index); });

function decodeEntities(value) {
  return value.replace(/&(#(?:[xX][\da-fA-F]{1,6}|\d{1,7})|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (reference, name) => {
    if (name[0] !== '#') return Object.prototype.hasOwnProperty.call(namedEntities, name) ? namedEntities[name] : reference;
    const hex = name[1]?.toLowerCase() === 'x';
    const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '\ufffd';
  });
}

/** Return a safe, inert-until-clicked destination, or null. No resource is fetched. */
export function safeMarkdownUrl(value, { literal = false } = {}) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const href = (literal ? value : decodeEntities(value)).trim();
  if (!href || /[\u0000-\u001f\u007f\\]/.test(href)) return null;
  // Also reject disguised active schemes instead of treating them as relative paths.
  let probe = href;
  try { probe = decodeURIComponent(href); } catch { /* URL may contain a literal percent sign. */ }
  if (/^(?:javascript|vbscript|data|file|blob):/i.test(probe.replace(/[\u0000-\u0020\u007f]/g, ''))) return null;
  try {
    const url = new URL(href, 'https://markdown.invalid/');
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? href : null;
  } catch { return null; }
}

/**
 * A safe normalized tree containing only text and whitelisted semantic elements.
 * Text nodes: { type: 'text', text }. Elements: { type: 'element', tag, attrs, children }.
 * No token-provided HTML, element name, style, or event attribute is passed through.
 */
export function markdownTree(source) {
  if (typeof source !== 'string' || !source) return [];
  const input = source.slice(0, MAX_SOURCE);
  const budget = { remaining: MAX_NODES, truncated: source.length > MAX_SOURCE };
  const claim = () => { if (budget.remaining-- > 0) return true; budget.truncated = true; return false; };
  const text = value => value && claim() ? { type: 'text', text: value } : null;
  const element = (tag, children, attrs = {}) => claim() ? { type: 'element', tag, attrs, children: children().filter(Boolean) } : null;
  const map = (values, convert) => {
    const result = [];
    for (const value of values || []) {
      if (budget.remaining <= 0) { budget.truncated = true; break; }
      const node = convert(value);
      if (Array.isArray(node)) result.push(...node.filter(Boolean));
      else if (node) result.push(node);
    }
    return result;
  };
  const children = (tokens, depth, literal = false) => map(tokens, token => convert(token, depth, literal));
  const inline = (token, depth, literal = false) => token.tokens ? children(token.tokens, depth + 1, literal) : [text(literal ? token.text || '' : decodeEntities(token.text || ''))];
  function convert(token, depth, literal) {
    if (depth >= MAX_DEPTH) return text(token.raw || token.text || '');
    switch (token.type) {
      case 'space': case 'def': return null;
      case 'paragraph': return element('p', () => inline(token, depth, literal));
      case 'heading': return element('h' + Math.min(6, Math.max(1, token.depth)), () => inline(token, depth, literal));
      case 'strong': case 'em': case 'del': return element(token.type, () => inline(token, depth, literal));
      case 'text': return inline(token, depth, literal);
      case 'escape': return text(token.text || '');
      case 'br': case 'hr': return element(token.type, () => []);
      case 'codespan': return element('code', () => [text(token.text || '')]);
      case 'code': {
        const language = (token.lang || '').trim().split(/\s+/)[0];
        const attrs = /^[a-zA-Z0-9_+-]{1,32}$/.test(language) ? { 'data-language': language } : {};
        return element('pre', () => [element('code', () => [text(token.text || '')], attrs)]);
      }
      case 'html': return token.block ? element('p', () => [text(token.raw || token.text || '')], { class: 'markdown-literal' }) : text(token.raw || token.text || '');
      case 'blockquote': return element('blockquote', () => children(token.tokens, depth + 1, literal));
      case 'list': {
        const attrs = token.items.some(item => item.task) ? { class: 'markdown-task-list' } : {};
        if (token.ordered && Number.isSafeInteger(token.start) && token.start !== 1) attrs.start = String(token.start);
        return element(token.ordered ? 'ol' : 'ul', () => map(token.items, item => element('li', () => children(item.tokens, depth + 1, literal), item.task ? { class: 'markdown-task' } : {})), attrs);
      }
      case 'checkbox': return element('span', () => [text(token.checked ? '☑ ' : '☐ ')], { class: 'markdown-task-marker', role: 'img', 'aria-label': token.checked ? 'Completed' : 'Not completed' });
      case 'link': {
        const href = safeMarkdownUrl(token.href, { literal: token.autolink === true });
        const body = () => inline(token, depth, literal || token.autolink === true);
        if (!href) return body();
        const attrs = { href, rel: 'noopener noreferrer' };
        if (!href.startsWith('#') && !/^mailto:/i.test(href)) attrs.target = '_blank';
        if (token.title) attrs.title = decodeEntities(token.title).slice(0, 2000);
        return element('a', body, attrs);
      }
      case 'image': return element('span', () => [text('Image: '), ...inline(token, depth, literal)], { class: 'markdown-image' });
      case 'table': {
        const row = (cells, heading) => element('tr', () => map(cells, cell => {
          const attrs = heading ? { scope: 'col' } : {};
          if (['left', 'center', 'right'].includes(cell.align)) attrs['data-align'] = cell.align;
          return element(heading ? 'th' : 'td', () => children(cell.tokens, depth + 1, literal), attrs);
        }));
        return element('div', () => [element('table', () => [
          element('thead', () => [row(token.header, true)]),
          element('tbody', () => map(token.rows, cells => row(cells, false))),
        ])], { class: 'markdown-table' });
      }
      default: return text(token.raw || token.text || '');
    }
  }
  let result;
  try { result = children(lexer(input, { gfm: true, breaks: false }), 0); }
  catch { result = [{ type: 'element', tag: 'p', attrs: { class: 'markdown-literal' }, children: [{ type: 'text', text: input }] }]; }
  if (budget.truncated) result.push({ type: 'element', tag: 'p', attrs: { class: 'markdown-truncated' }, children: [{ type: 'text', text: '…' }] });
  return result;
}

/** Replace a response body's contents with semantic DOM; preserves the host itself. */
export function renderMarkdown(host, source) {
  const document = host.ownerDocument;
  const fragment = document.createDocumentFragment();
  function materialize(node) {
    if (node.type === 'text') return document.createTextNode(node.text);
    const element = document.createElement(node.tag);
    for (const [name, value] of Object.entries(node.attrs)) element.setAttribute(name, value);
    for (const child of node.children) element.append(materialize(child));
    return element;
  }
  for (const node of markdownTree(source)) fragment.append(materialize(node));
  host.classList.add('markdown-content');
  host.replaceChildren(fragment);
  return host;
}
