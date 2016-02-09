"use strict";

import url from 'url';

import co from 'co';
import request from 'request-promise';
import cheerio from 'cheerio';


export default class Crawler {
  constructor(db) {}

  crawl(pages, depth=3) {
    if (depth <= 0)
      return;

    let self = this;

    co(function*() {
      let result = yield pages.map(u => self.visit(u));
      let flatten = [].concat(...result);
      self.crawl(flatten, depth-1);
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
