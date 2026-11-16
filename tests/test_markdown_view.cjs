'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { render } = require('../markdown-view.js');

test('loads as a standalone browser global and CommonJS with the same immutable API', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'markdown-view.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.YDAMarkdown), ['render']);
  assert.equal(context.YDAMarkdown.render('# 参数'), '<h3>参数</h3>');
  assert.equal(globalThis.YDAMarkdown.render, render);
  assert.ok(Object.isFrozen(context.YDAMarkdown));
});

test('empty/missing content stays empty and unexpected non-text data is rejected', () => {
  for (const value of [null, undefined, '', '  \n\t\n', '\uFEFF']) assert.equal(render(value), '');
  for (const value of [1, {}, []]) assert.throws(() => render(value), TypeError);
});

test('Chinese headings retain hierarchy below the page title and normalize line endings', () => {
  assert.equal(render('\uFEFF# 参数说明\r\n\r\n## 初始资金\r### 每周增长 ###\n#### 档距\n##### 更深\n###### 注释'),
    '<h3>参数说明</h3>\n<h4>初始资金</h4>\n<h5>每周增长</h5>\n<h6>档距</h6>\n<h6>更深</h6>\n<h6>注释</h6>');
});

test('paragraphs, line breaks and nested inline styles preserve readable content', () => {
  assert.equal(render('初始 **20,000 HK**，增长 *1%*，__加粗__、_斜体_。\n第二行 `weekly_growth_ratio`\n\n**范围含 _端点_**'),
    '<p>初始 <strong>20,000 HK</strong>，增长 <em>1%</em>，<strong>加粗</strong>、<em>斜体</em>。<br>第二行 <code>weekly_growth_ratio</code></p>\n<p><strong>范围含 <em>端点</em></strong></p>');
});

test('unordered/ordered lists, explicit start numbers, continuations and quotes are supported', () => {
  assert.equal(render('- 第一项\n- **第二项**\n  接着说明\n\n3. 观察\n4. 比较\n\n> 提示\n>\n> - 只买\n> - 不卖'),
    '<ul><li>第一项</li><li><strong>第二项</strong><br>接着说明</li></ul>\n<ol start="3"><li>观察</li><li>比较</li></ol>\n<blockquote><p>提示</p>\n<ul><li>只买</li><li>不卖</li></ul></blockquote>');
});

test('parameter tables support alignment separators, code pipes and escaped literal pipes', () => {
  const source = '| 参数 | 数值 | 说明 |\n| :--- | ---: | :---: |\n| 初始资金 | **20,000 HK** | 每 15 分钟买入 |\n| 标识 | `a|b` | 左\\|右 |';
  assert.equal(render(source), '<div class="markdown-table-wrap"><table><thead><tr><th scope="col">参数</th><th scope="col">数值</th><th scope="col">说明</th></tr></thead><tbody><tr><td>初始资金</td><td><strong>20,000 HK</strong></td><td>每 15 分钟买入</td></tr><tr><td>标识</td><td><code>a|b</code></td><td>左|右</td></tr></tbody></table></div>');
  assert.equal(render('a | b\nnot | a separator'), '<p>a | b<br>not | a separator</p>');
});

test('math and parameter identifiers remain literal instead of executing or losing operators', () => {
  const formula = '$cash_n = 20000 * (1 + 1%)^{n-1}$';
  assert.equal(render(formula), `<p>${formula}</p>`);
  assert.equal(render('weekly_base_hk * weekly_growth_ratio * k'), '<p>weekly_base_hk * weekly_growth_ratio * k</p>');
  assert.equal(render('\\(\u0394 < step \\) 和 \\[ a_b * c_d \\]'), '<p>\\(Δ &lt; step \\) 和 \\[ a_b * c_d \\]</p>');
  assert.equal(render('$$\nQ_n = 20000 * (1.01)^n\n\na_b < c_d\n$$'),
    '<p class="markdown-math">$$<br>Q_n = 20000 * (1.01)^n<br><br>a_b &lt; c_d<br>$$</p>');
  assert.equal(render('$$\nglobalThis.executed = true;\n'), '<p class="markdown-math">$$<br>globalThis.executed = true;<br></p>');
  assert.ok(render('| 参数 | 公式 |\n| --- | --- |\n| 范围 | $a_b \\le |c_d|$ |')
    .includes('<td>$a_b \\le |c_d|$</td>'));
  assert.equal(globalThis.executed, undefined);
});

test('all raw HTML, entities and code are escaped before reaching the page', () => {
  assert.equal(render('<img src=x onerror="alert(1)">\n<script>alert(1)</script> &lt;b&gt;'),
    '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;<br>&lt;script&gt;alert(1)&lt;/script&gt; &amp;lt;b&amp;gt;</p>');
  assert.equal(render('`<svg/onload=alert(1)> & **x**`'), '<p><code>&lt;svg/onload=alert(1)&gt; &amp; **x**</code></p>');
});

test('only explicit HTTP(S) links are clickable and labels/attributes stay escaped', () => {
  assert.equal(render('[**说明**](https://example.com/参数?a=1&b=2) [页面](HTTP://example.org/a_(b))'),
    '<p><a href="https://example.com/参数?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"><strong>说明</strong></a> <a href="HTTP://example.org/a_(b)" target="_blank" rel="noopener noreferrer">页面</a></p>');
  assert.equal(render('[<img onerror=x>](https://example.com)'),
    '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">&lt;img onerror=x&gt;</a></p>');
});

test('unsafe, obfuscated and unsupported links degrade to their label without an anchor', () => {
  const urls = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd', '//example.com', '/relative', '#anchor', 'mailto:a@example.com',
    'java\tscript:alert(1)', 'https://example.com"onclick="alert(1)', 'https://example.com\\@evil',
    'https://example.com/\u0000x', 'javascript&#58;alert(1)', 'https://'];
  for (const url of urls) assert.equal(render(`[名称](${url})`), '<p>名称</p>', url);
});

test('images expose only their alt text and never generate src, img or an external request', () => {
  assert.equal(render('![参数示意](https://tracker.example/pixel.png) ![<svg onload=x>](data:image/svg+xml,anything)'),
    '<p>参数示意 &lt;svg onload=x&gt;</p>');
});

test('fenced code stays verbatim, ignores language attributes and accepts an unclosed block', () => {
  assert.equal(render('```javascript onmouseover=x\n<script>alert(1)</script>\n**原文**\n```\n之后'),
    '<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;\n**原文**</code></pre>\n<p>之后</p>');
  assert.equal(render('````\n```\nconst value = "<x>";\n'),
    '<pre><code>```\nconst value = &quot;&lt;x&gt;&quot;;\n</code></pre>');
  assert.equal(render('~~~\n参数 = 1\n~~~'), '<pre><code>参数 = 1</code></pre>');
});

test('unclosed inline markup is shown instead of swallowing the rest of the document', () => {
  assert.equal(render('**未闭合\n[名称](https://example.com\n`代码'),
    '<p>**未闭合<br>[名称](https://example.com<br>`代码</p>');
});

test('deeply nested quotes stop nesting safely without dropping their contents', () => {
  const value = render(`${'> '.repeat(80)}<img src=x onerror=x>`);
  assert.ok(value.includes('&lt;img src=x onerror=x&gt;'));
  assert.ok(!value.includes('<img'));
  assert.ok((value.match(/<blockquote>/g) || []).length <= 17);
});
