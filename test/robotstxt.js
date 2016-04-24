"use strict";

import assert from 'assert';

import {parse, isDisallowed} from '../src/robotstxt';


function testNoMatch() {
  let result = parse(`
    user-agent: test-bot
    disallow: /path/to/file
  `);

  assert.equal(result.rules.length, 0);
  assert(isNaN(result.crawlDelay));
}

function testLastEntry() {
  let {rules} = parse(`
    user-agent: *
    disallow: /test/path1
    disallow: /test/path2*
    disallow: /test/path3
  `);

  assert.deepEqual(rules, ['/test/path1', '/test/path2', '/test/path3']);
}

function testMiddleEntry() {
  let result = parse(`
    user-agent: test-bot-1
    disallow: /test/path0

    user-agent: *
    disallow: /test/path1
    disallow: /test/path22*
    disallow: /test/path333

    user-agent: test-bot-2
    disallow: /test/path4
    crawl-delay: 2
  `);

  assert.deepEqual(result.rules, ['/test/path1', '/test/path22', '/test/path333']);
  assert(isNaN(result.crawlDelay));
}

function testComplex() {
  let {rules} = parse(`
    user-agent: test-bot-1
    disallow: /test/path0

    user-agent: *
    disallow: /test/path33
    disallow: /foo/bar$
    disallow: /test/*3
    disallow: /test/path1
    disallow: /test/path2*

    user-agent: test-bot-2
    disallow: /test/path4
    crawl-delay: 2
  `);

  assert.deepEqual(rules, ['/test/path1', '/test/path2', '/test/path33',
                           /^\/foo\/bar$/, /^\/test\/.*3/]);
}

function testEscape() {
  let {rules} = parse(`
    user-agent: *
    disallow: /test/(/foo
    disallow: /l*/+/foo
  `);

  assert.deepEqual(rules, ['/test/(/foo', /^\/l.*\/\+\/foo/]);
}

function testIgnoreDynamic() {
  let {rules} = parse(`
    user-agent: *
    disallow: /test/long-path
    disallow: /test/dynamic?lol=
    disallow: /test/path
  `);

  assert.deepEqual(rules, ['/test/path', '/test/long-path']);
}

function testCrawlDelay() {
  let result = parse(`
    user-agent: *
    crawl-delay: 2
  `);

  assert.equal(result.crawlDelay, 2);

  result = parse(`
    user-agent: *
    crawl-delay: 2.5
  `);

  assert.equal(result.crawlDelay, 2.5);
}

function testInvalidCrawlDelay() {
  let result = parse(`
    user-agent: *
    crawl-delay: 2.5.6
  `);

  assert(isNaN(result.crawlDelay));

  result = parse(`
    user-agent: *
    crawl-delay: foo
  `);

  assert(isNaN(result.crawlDelay));
}

function testDisallowed() {
  let {rules} = parse(`
    user-agent: *
    disallow: /test/path33
    disallow: /l*/lol
    disallow: /bar*/bar$
    disallow: /test/path1
    disallow: /foo/bar$
    disallow: /test/path2*
  `);

  assert(isDisallowed(rules, '/test/path33'));
  assert(isDisallowed(rules, '/test/path332'));
  assert(!isDisallowed(rules, '/test/path32'));
  assert(isDisallowed(rules, '/test/path2'));
  assert(isDisallowed(rules, '/test/path11'));
  assert(isDisallowed(rules, '/l/lol'));
  assert(isDisallowed(rules, '/lo/lol'));
  assert(isDisallowed(rules, '/lo/lolo'));
  assert(!isDisallowed(rules, '/lo/lo'));
  assert(isDisallowed(rules, '/foo/bar'));
  assert(!isDisallowed(rules, '/foo/baro'));
  assert(isDisallowed(rules, '/bar/bar'));
  assert(!isDisallowed(rules, '/bar/baro'));
}

testNoMatch();
testLastEntry();
testMiddleEntry();
testComplex();
testEscape();
testIgnoreDynamic();
testCrawlDelay();
testInvalidCrawlDelay();
testDisallowed();
