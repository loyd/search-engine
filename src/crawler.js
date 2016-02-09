"use strict";

import url from 'url';

import co from 'co';
import request from 'request-promise';
import cheerio from 'cheerio';
import sqlite3 from 'co-sqlite3';


class Queue {
  constructor(initial) {
    this.backend = initial;
    this.waiters = [];
  }

  enqueue(item) {
    if (this.waiters.length)
      this.waiters.pop()(item);
    else
      this.backend.push(item);
  }

  dequeue() {
    if (this.backend.length === 0)
      return new Promise(resolve => this.waiters.push(resolve));

    return Promise.resolve(this.backend.shift());
  }
}

const tables = [
  'urllist(url)',
  'wordlist(word)',
  'wordlocation(urlid, wordid, location)',
  'link(fromid, toid)',
  'linkwords(wordid, linkid)'
];

const indices = [
  'urlidx on urllist(url)',
  'wordidx on wordlist(word)',
  'wordurlidx on wordlocation(wordid)',
  'urltoidx on link(toid)',
  'urlfromidx on link(fromid)'
];

export default class Crawler {
  constructor(dbname) {
    this.cache = new Set;
    this.db = null;

    return co.call(this, function*() {
      let db = this.db = yield sqlite3(dbname);

      yield tables.map(tbl => db.run(`create table if not exists ${tbl}`));
      yield indices.map(idx => db.run(`create index if not exists ${idx}`));

      return this;
    });
  }

  crawl(pages, depth=3, concurrency=5) {
    let queue = new Queue(pages.map(page => ({url: page, depth})));

    pages.forEach(p => this.cache.add(p));

    for (let i = 0; i < concurrency; ++i)
      co.call(this, function*() {
        for (;;) {
          let page = yield queue.dequeue();
          let links = yield this.visit(page.url);

          if (page.depth > 1)
            for (let link of links)
              queue.enqueue({
                url: link,
                depth: page.depth - 1
              });
        }
      }).catch(console.error);
  }

  * visit(page) {
    try {
      let data = yield request(page);
      var $ = cheerio.load(data);
    } catch (_) {
      return [];
    }

    try {
      return this.process(page, $);
    } catch (e) {
      console.error(`Error while processing ${page}: ${e}`);
      return [];
    }
  }

  process(page, $) {
    let text = $('html > body').text().toLowerCase();
    this.index(page, text);

    let links = [];

    $('a[href]').each((_, a) => {
      let rel = $(a).attr('href');
      let link = url.resolve(page, rel).split('#')[0];

      if (!link.startsWith('http') || this.cache.has(link))
        return;

      this.cache.add(link);

      let text = $(a).text().toLowerCase();
      this.addLink(page, link, text);

      links.push(link);
    });

    return links;
  }

  index(page, text) {
    console.log(page);
  }

  addLink(from, to, text) {}
}

co(function*() {
  let crawler = yield new Crawler('se.db');
  crawler.crawl(['https://learn.javascript.ru/promise']);
}).catch(console.error);
