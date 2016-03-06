import assert from 'assert';

import * as utils from '../src/utils';


function normalizeUrl(from, to) {
  assert.equal(utils.normalizeUrl(from, to), to, `${from} -> ${to}`);
}


normalizeUrl('HTTP://Example.COM', 'example.com');

normalizeUrl('http://example.com:80', 'example.com');
normalizeUrl('http://example.com:88', 'example.com:88');
normalizeUrl('https://example.com:443', 'example.com');
normalizeUrl('https://example.com:442', 'example.com:442');

normalizeUrl('https://example.com/', 'example.com');
normalizeUrl('https://example.com/test', 'example.com/test');
normalizeUrl('https://example.com/test/', 'example.com/test');

normalizeUrl('https://example.com/test//foo.html', 'example.com/test/foo.html');

normalizeUrl('https://example.com/index.html', 'example.com');
normalizeUrl('https://example.com/test/index.html', 'example.com/test');
normalizeUrl('https://example.com/test/index.htm', 'example.com/test');
normalizeUrl('https://example.com/test/index.shtml', 'example.com/test');
normalizeUrl('https://example.com/test/index.php', 'example.com/test');
normalizeUrl('https://example.com/test/index.jsp', 'example.com/test');
normalizeUrl('https://example.com/test/index.asp', 'example.com/test');
normalizeUrl('https://example.com/test/default.html', 'example.com/test');
normalizeUrl('https://example.com/test/default.htm', 'example.com/test');
normalizeUrl('https://example.com/test/default.asp', 'example.com/test');
normalizeUrl('https://example.com/test/default.aspx', 'example.com/test');
normalizeUrl('https://example.com/test/index.html/test', 'example.com/test/index.html/test');

normalizeUrl('https://www.example.com', 'example.com');

normalizeUrl('https://example.com#test', 'example.com');
normalizeUrl('https://example.com/test#test', 'example.com/test');
normalizeUrl('https://example.com/test.html/#test', 'example.com/test.html');
normalizeUrl('https://example.com/index.html/#test', 'example.com');

normalizeUrl('https://example.com/Test/Foo/bAr.HtMl', 'example.com/test/foo/bar.html');
normalizeUrl('https://example.com/INDEX.html/#test', 'example.com');
