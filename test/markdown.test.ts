import { test } from 'bun:test';
import assert from 'node:assert/strict';
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
  assert.equal(elements(tree, 'strong')[0] && plainText(elements(tree, 'strong')[0]!.children), 'PROC-LIVE-82 handoff');
  assert.equal(elements(tree, 'ul').length, 1);
  assert.equal(elements(tree, 'ol').length, 1);
  assert.equal(elements(tree, 'li').length, 5);
  assert.ok(elements(tree, 'p').length >= 4);
  assert.match(plainText(tree), /128,000 cents.*po_000005.*gr_000011.*bill_000089/s);
  assert.match(plainText(tree), /stock-auth_000087.*stock-issue_000096.*op_000097.*journal_000099/s);
  assert.equal(plainText(tree).includes('**'), false);
});

test('nested tight and loose lists retain hierarchy, ordered starts, quotations, and noninteractive tasks', () => {
  const tree: MarkdownNode[] = markdownTree('# Review\n\n3. First **item**\n   - Nested *detail*\n     - Last level\n4. Next item\n\n   Second paragraph.\n\n> Evidence\n>\n> - One source\n\n- [x] Complete\n- [ ] Waiting');
  assert.equal(elements(tree, 'h1').length, 1);
  assert.equal(elements(tree, 'ol')[0]!.attrs.start, '3');
  const firstItem = elements(tree, 'ol')[0]!.children[0]!;
  assert.equal(firstItem.type, 'element');
  assert.equal(elements([firstItem], 'ul').length, 2);
  assert.equal(elements([firstItem], 'em').length, 1);
  assert.equal(elements(tree, 'blockquote').length, 1);
  assert.equal(elements(elements(tree, 'blockquote'), 'ul').length, 1);
  assert.match(plainText(tree), /☑ Complete☐ Waiting/);
  assert.equal(elements(tree, 'input').length, 0);
  assert.equal(elements(tree, 'button').length, 0);
});

test('HTML stays literal, active links are removed, and Markdown images never load resources', () => {
  const source = '<script>alert(1)</script>\n\n<img src="https://tracker.test/pixel" onerror="alert(2)">\n\n[bad](javascript:alert(1)) [encoded](java&#x73;cript&colon;alert(1)) [data](data:text/html,boom)\n\n![Invoice &amp; receipt](https://tracker.test/image.png) <iframe src="https://tracker.test/frame"></iframe>';
  const tree: MarkdownNode[] = markdownTree(source);
  assert.equal(elements(tree, 'script').length, 0);
  assert.equal(elements(tree, 'img').length, 0);
  assert.equal(elements(tree, 'iframe').length, 0);
  assert.equal(elements(tree, 'a').length, 0);
  assert.match(plainText(tree), /<script>alert\(1\)<\/script>/);
  assert.match(plainText(tree), /Image: Invoice & receipt/);
  for (const node of descendants(tree)) if (node.type === 'element') {
    assert.equal(Object.keys(node.attrs).some(name => /^on/i.test(name) || name === 'src' || name === 'srcdoc'), false);
  }
});

test('link validation blocks obfuscated active schemes and preserves useful evidence destinations', () => {
  for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'javascript&#58;alert(1)', 'java&Tab;script&colon;alert(1)', 'javascript%3Aalert(1)', 'data:text/html,boom', 'file:///etc/passwd', 'blob:https://example.test/id', '\\evil.test/path']) assert.equal(safeMarkdownUrl(href), null, href);
  assert.equal(safeMarkdownUrl('https://example.test/report?a=1&amp;b=2'), 'https://example.test/report?a=1&b=2');
  assert.equal(safeMarkdownUrl('/reports/42#proof'), '/reports/42#proof');
  assert.equal(safeMarkdownUrl('#evidence'), '#evidence');
  assert.equal(safeMarkdownUrl('mailto:finance@example.test'), 'mailto:finance@example.test');
  const tree: MarkdownNode[] = markdownTree('[Evidence](https://example.test/report "Invoice &amp; receipt") and <https://example.test/?q=&amp;>');
  assert.equal(elements(tree, 'a')[0]!.attrs.rel, 'noopener noreferrer');
  assert.equal(elements(tree, 'a')[0]!.attrs.title, 'Invoice & receipt');
  assert.equal(elements(tree, 'a')[1]!.attrs.href, 'https://example.test/?q=&amp;');
  assert.match(plainText(tree), /https:\/\/example\.test\/\?q=&amp;/);
});

test('code stays literal while tables retain headers, alignment, and inline formatting', () => {
  const tree: MarkdownNode[] = markdownTree('Use `&amp; <tag>` literally.\n\n```js\nconst html = "<img onerror=alert(1)>";\n```\n\n| Item | Amount |\n| :--- | ---: |\n| **Invoice** | $1,280.00 |\n| `po_000005` | 2 |');
  assert.equal(plainText(elements(tree, 'code')[0]!.children), '&amp; <tag>');
  assert.equal(elements(tree, 'pre').length, 1);
  assert.equal(elements(tree, 'code')[1]!.attrs['data-language'], 'js');
  assert.match(plainText(elements(tree, 'pre')), /<img onerror=alert\(1\)>/);
  assert.equal(elements(tree, 'table').length, 1);
  assert.equal(elements(tree, 'th').length, 2);
  assert.equal(elements(tree, 'th')[1]!.attrs.scope, 'col');
  assert.equal(elements(tree, 'th')[1]!.attrs['data-align'], 'right');
  assert.equal(elements(tree, 'td').length, 4);
  assert.equal(elements(elements(tree, 'table'), 'strong').length, 1);
});

test('ordinary text and entities decode once without corrupting escapes or turning text into HTML', () => {
  const tree: MarkdownNode[] = markdownTree('Fish &amp; chips &copy; 2026 &eacute; &#x1f600; &lt;b&gt; &amp;lt; &#38;amp; \\&amp;\n\n**A &lt; B**');
  assert.equal(plainText(tree), 'Fish & chips © 2026 é 😀 <b> &lt; &amp; &amp;A < B');
  assert.equal(elements(tree, 'b').length, 0);
  assert.equal(elements(tree, 'strong').length, 1);
  assert.deepEqual(markdownTree(null), []);
  assert.deepEqual(markdownTree(''), []);
});

test('very large or deeply nested replies stay bounded and retain readable text', () => {
  const source = 'Text '.repeat(50000);
  const tree: MarkdownNode[] = markdownTree(source);
  assert.ok(plainText(tree).length <= 200001);
  assert.equal(plainText(tree).endsWith('…'), true);
  const many: MarkdownNode[] = markdownTree('- item\n'.repeat(9000));
  assert.ok(descendants(many).length <= 10002);
  assert.equal(plainText(many).endsWith('…'), true);
  const nested: MarkdownNode[] = markdownTree('> '.repeat(70) + 'Deep evidence');
  assert.match(plainText(nested), /Deep evidence/);
});
