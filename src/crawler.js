"use strict";

import url from 'url';

import co from 'co';
import request from 'request-promise';
import cheerio from 'cheerio';



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

export default class Crawler {
  constructor(db) {}

  crawl(pages, depth=3, concurrency=5) {
    let self = this;
    let queue = new Queue(pages.map(page => ({url: page, depth})));

    for (let i = 0; i < concurrency; ++i)
      co(function*() {
        for (;;) {
          let page = yield queue.dequeue();
          let links = yield self.visit(page.url);

          if (page.depth > 1)
            for (let link of links)
              queue.enqueue({
                url: link,
                depth: page.depth - 1
              });
        }
      }).catch(console.error);
  }

  *visit(page) {
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

      if (!link.startsWith('http') || this.is_indexed(link))
        return;

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

  is_indexed(page) {
    return false;
  }
}

let c = new Crawler;
c.crawl(['https://learn.javascript.ru/promise'])
