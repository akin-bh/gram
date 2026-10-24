import { test, expect } from 'bun:test';
// @ts-ignore TS7016: The browser imports this native JavaScript module directly.
import { markdownTree, safeMarkdownUrl } from '../web/markdown.js';

type MarkdownNode = { type: 'text'; text: string } | { type: 'element'; tag: string; attrs: Record<string, string>; children: MarkdownNode[] };
const descendants = (nodes: MarkdownNode[]): MarkdownNode[] => nodes.flatMap(node => [node, ...(node.type === 'element' ? descendants(node.children) : [])]);
const elements = (nodes: MarkdownNode[], tag: string) => descendants(nodes).filter((node): node is Extract<MarkdownNode, { type: 'element' }> => node.type === 'element' && node.tag === tag);
const plainText = (nodes: MarkdownNode[]): string => nodes.map(node => node.type === 'text' ? node.text : plainText(node.children)).join('');

// Actual PROC-LIVE-82 response excerpt supplied from the running UI.
const handoff = `**PROC-LIVE-82 handoff**

I matched all four supplier invoices and requested the payment and the purchase order.

**Completed**
- **sinv_000018 (SUP-0001, 128,000 cents):** Matched against po_000005 and receipt gr_000011. This created bill_000089, which is open, with beneficiary verified-northline-operating. Operation op_000090 posted journal_000092.
- **Inventory issue:** I issued 2 item-reader units under stock-auth_000087 (movement stock-issue_000096, operation op_000097, journal_000099).
- I did not use stock-auth_000080, which is a separate authorization.

**Pending controller decisions**
1. Approve the supplier payment.
2. Approve the purchase order.`;

test('the real procurement response becomes readable paragraphs, emphasis, and separate lists', () => {
  const tree: MarkdownNode[] = markdownTree(handoff);
  expect(elements(tree, 'strong')[0] && plainText(elements(tree, 'strong')[0]!.children)).toBe('PROC-LIVE-82 handoff');
  expect(elements(tree, 'ul').length).toBe(1);
  expect(elements(tree, 'ol').length).toBe(1);
  expect(elements(tree, 'li').length).toBe(5);
  expect(elements(tree, 'p').length >= 4).toBeTruthy();
  expect(plainText(tree)).toMatch(/128,000 cents.*po_000005.*gr_000011.*bill_000089/s);
  expect(plainText(tree)).toMatch(/stock-auth_000087.*stock-issue_000096.*op_000097.*journal_000099/s);
  expect(plainText(tree).includes('**')).toBe(false);
});

test('nested tight and loose lists retain hierarchy, ordered starts, quotations, and noninteractive tasks', () => {
  const tree: MarkdownNode[] = markdownTree('# Review\n\n3. First **item**\n   - Nested *detail*\n     - Last level\n4. Next item\n\n   Second paragraph.\n\n> Evidence\n>\n> - One source\n\n- [x] Complete\n- [ ] Waiting');
  expect(elements(tree, 'h1').length).toBe(1);
  expect(elements(tree, 'ol')[0]!.attrs.start).toBe('3');
  const firstItem = elements(tree, 'ol')[0]!.children[0]!;
  expect(firstItem.type).toBe('element');
  expect(elements([firstItem], 'ul').length).toBe(2);
  expect(elements([firstItem], 'em').length).toBe(1);
  expect(elements(tree, 'blockquote').length).toBe(1);
  expect(elements(elements(tree, 'blockquote'), 'ul').length).toBe(1);
  expect(plainText(tree)).toMatch(/☑ Complete☐ Waiting/);
  expect(elements(tree, 'input').length).toBe(0);
  expect(elements(tree, 'button').length).toBe(0);
});

test('HTML stays literal, active links are removed, and Markdown images never load resources', () => {
  const source = '<script>alert(1)</script>\n\n<img src="https://tracker.test/pixel" onerror="alert(2)">\n\n[bad](javascript:alert(1)) [encoded](java&#x73;cript&colon;alert(1)) [data](data:text/html,boom)\n\n![Invoice &amp; receipt](https://tracker.test/image.png) <iframe src="https://tracker.test/frame"></iframe>';
  const tree: MarkdownNode[] = markdownTree(source);
  expect(elements(tree, 'script').length).toBe(0);
  expect(elements(tree, 'img').length).toBe(0);
  expect(elements(tree, 'iframe').length).toBe(0);
  expect(elements(tree, 'a').length).toBe(0);
  expect(plainText(tree)).toMatch(/<script>alert\(1\)<\/script>/);
  expect(plainText(tree)).toMatch(/Image: Invoice & receipt/);
  for (const node of descendants(tree)) if (node.type === 'element') {
    expect(Object.keys(node.attrs).some(name => /^on/i.test(name) || name === 'src' || name === 'srcdoc')).toBe(false);
  }
});

test('link validation blocks obfuscated active schemes and preserves useful evidence destinations', () => {
  for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'javascript&#58;alert(1)', 'java&Tab;script&colon;alert(1)', 'javascript%3Aalert(1)', 'data:text/html,boom', 'file:///etc/passwd', 'blob:https://example.test/id', '\\evil.test/path']) expect(safeMarkdownUrl(href), href).toBeNull();
  expect(safeMarkdownUrl('https://example.test/report?a=1&amp;b=2')).toBe('https://example.test/report?a=1&b=2');
  expect(safeMarkdownUrl('/reports/42#proof')).toBe('/reports/42#proof');
  expect(safeMarkdownUrl('#evidence')).toBe('#evidence');
  expect(safeMarkdownUrl('mailto:finance@example.test')).toBe('mailto:finance@example.test');
  const tree: MarkdownNode[] = markdownTree('[Evidence](https://example.test/report "Invoice &amp; receipt") and <https://example.test/?q=&amp;>');
  expect(elements(tree, 'a')[0]!.attrs.rel).toBe('noopener noreferrer');
  expect(elements(tree, 'a')[0]!.attrs.title).toBe('Invoice & receipt');
  expect(elements(tree, 'a')[1]!.attrs.href).toBe('https://example.test/?q=&amp;');
  expect(plainText(tree)).toMatch(/https:\/\/example\.test\/\?q=&amp;/);
});

test('code stays literal while tables retain headers, alignment, and inline formatting', () => {
  const tree: MarkdownNode[] = markdownTree('Use `&amp; <tag>` literally.\n\n```js\nconst html = "<img onerror=alert(1)>";\n```\n\n| Item | Amount |\n| :--- | ---: |\n| **Invoice** | $1,280.00 |\n| `po_000005` | 2 |');
  expect(plainText(elements(tree, 'code')[0]!.children)).toBe('&amp; <tag>');
  expect(elements(tree, 'pre').length).toBe(1);
  expect(elements(tree, 'code')[1]!.attrs['data-language']).toBe('js');
  expect(plainText(elements(tree, 'pre'))).toMatch(/<img onerror=alert\(1\)>/);
  expect(elements(tree, 'table').length).toBe(1);
  expect(elements(tree, 'th').length).toBe(2);
  expect(elements(tree, 'th')[1]!.attrs.scope).toBe('col');
  expect(elements(tree, 'th')[1]!.attrs['data-align']).toBe('right');
  expect(elements(tree, 'td').length).toBe(4);
  expect(elements(elements(tree, 'table'), 'strong').length).toBe(1);
});

test('ordinary text and entities decode once without corrupting escapes or turning text into HTML', () => {
  const tree: MarkdownNode[] = markdownTree('Fish &amp; chips &copy; 2026 &eacute; &#x1f600; &lt;b&gt; &amp;lt; &#38;amp; \\&amp;\n\n**A &lt; B**');
  expect(plainText(tree)).toBe('Fish & chips © 2026 é 😀 <b> &lt; &amp; &amp;A < B');
  expect(elements(tree, 'b').length).toBe(0);
  expect(elements(tree, 'strong').length).toBe(1);
  expect(markdownTree(null)).toStrictEqual([]);
  expect(markdownTree('')).toStrictEqual([]);
});

test('very large or deeply nested replies stay bounded and retain readable text', () => {
  const source = 'Text '.repeat(50000);
  const tree: MarkdownNode[] = markdownTree(source);
  expect(plainText(tree).length <= 200001).toBeTruthy();
  expect(plainText(tree).endsWith('…')).toBe(true);
  const many: MarkdownNode[] = markdownTree('- item\n'.repeat(9000));
  expect(descendants(many).length <= 10002).toBeTruthy();
  expect(plainText(many).endsWith('…')).toBe(true);
  const nested: MarkdownNode[] = markdownTree('> '.repeat(70) + 'Deep evidence');
  expect(plainText(nested)).toMatch(/Deep evidence/);
});
