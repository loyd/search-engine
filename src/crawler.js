"use strict";

import url from 'url';

import co from 'co';
import request from 'request-promise';
import cheerio from 'cheerio';
import sqlite3 from 'co-sqlite3';

import Stemmer from './stemmer';


const tables = [
  'page(url, title)',
  'word(stem, count)',
  'location(pageid, wordid, position, primary key(wordid, pageid, position) without rowid',
  'link(fromid, toid, wordid)'
];

const indices = [
  'urlidx on page(url)',
  'stemidx on word(stem)',
  'toididx on link(toid)',
  'fromididx on link(fromid)'
];

export default class Crawler {
  constructor(dbname) {
    this.cache = null;
    this.db = null;

    this.stemmer = new Stemmer;

    return co.call(this, function*() {
      let db = this.db = yield sqlite3(dbname);

      yield tables.map(tbl => db.run(`create table if not exists ${tbl}`));
      yield indices.map(idx => db.run(`create index if not exists ${idx}`));

      let urls = yield db.all('select url from page');
      this.cache = new Set(urls.map(u => u.url));

      return this;
    });
  }

  *crawl(urls, limit=Infinity, depth=3) {
    let pages = [];

    for (let url of urls) {
      url = this.stripUrl(url);

      if (this.cache.has(url))
        continue;

      pages.push({
        url: url,
        id: yield* this.takePageID(url)
      });

      this.cache.add(url);
    }

    let visited = 0;

    all: for (let i = 0; i < depth; ++i) {
      let page, next = [];

      while (page = pages.shift()) {
        if (visited >= limit)
          break all;

        let derived = yield* this.visit(page);
        next.push(...derived);
        ++visited;
      }

      pages = next;
    }
  }

  *visit(page) {
    try {
      let {body, headers} = yield request({
        url: page.url,
        headers: {
          'accept': "application/xml,application/xhtml+xml,text/html;q=0.9,text/plain;q=0.8",
          'accept-language': 'ru, en;q=0.8',
          'accept-charset': 'utf-8',
          'user-agent': 'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_4; en-US) ' +
                        'AppleWebKit/534.7 (KHTML, like Gecko) Chrome/7.0.517.41 Safari/534.7',
        },
        gzip: true,
        resolveWithFullResponse: true
      });

      let acceptType = (headers['content-type'] || '').indexOf('html') > -1;
      let acceptLang = /en|ru/i.test(headers['content-language'] || 'en');

      if (!acceptType || !acceptLang)
        return [];

      var $ = cheerio.load(body);
    } catch (_) {
      return [];
    }

    try {
      return yield* this.process(page, $);
    } catch (e) {
      console.error(`Error while processing ${page.url}: ${e}`);
      return [];
    }
  }

  *process(page, $) {
    yield this.db.run('begin');

    let [links] = yield [
      this.indexLinks(page, $),
      this.indexBody(page, $)
    ];

    yield this.db.run('commit');

    console.log(decodeURI(page.url));
    return links;
  }

  *indexBody(page, $) {
    let {db} = this;
    let title = $('title').text().slice(0, 256);
    let text = this.grabText($('html > body').get());
    let stems = this.stemmer.tokenizeAndStem(text);

    let [$insertLocation, $updateWord] = yield [
      db.prepare(`insert into location(pageid, wordid, position) values (${page.id}, ?, ?)`),
      db.prepare('update word set count = count + 1 where rowid = ?')
    ];

    yield db.run('update page set title = ? where rowid = ?', title, page.id);

    for (let [position, stem] of stems.entries()) {
      let wordID = yield* this.takeWordID(stem);
      yield [
        $updateWord.run(wordID),
        $insertLocation.run(wordID, position)
      ];
    }
  }

  *indexLinks(page, $) {
    let query = `insert into link(fromid, toid, wordid)
                 values(${page.id}, ?, (select rowid from word where stem = ?))`;

    let $insert = yield this.db.prepare(query);
    let links = [];

    for (let a of $('a[href]').get()) {
      let rel = $(a).attr('href');
      let linkUrl = this.stripUrl(url.resolve(page.url, rel));
      let linkID = yield* this.takePageID(linkUrl);

      let text = this.grabText([a]);
      let stems = this.stemmer.tokenizeAndStem(text, 10);
      if (stems.length > 0)
        yield stems.map(stem => $insert.run(linkID, stem));

      if (linkUrl.startsWith('http') && !this.cache.has(linkUrl)) {
        this.cache.add(linkUrl);
        links.push({url: linkUrl, id: linkID});
      }
    }

    return links;
  }

  *takePageID(url) {
    return (
      (yield this.db.get('select rowid as lastID from page where url = ?', url)) ||
      (yield this.db.run('insert into page(url) values (?)', url))
    ).lastID;
  }

  *takeWordID(stem) {
    return (
      (yield this.db.get('select rowid as lastID from word where stem = ?', stem)) ||
      (yield this.db.run('insert into word(stem, count) values (?, 0)', stem))
    ).lastID;
  }

  stripUrl(url) {
    return url.split(/[#?]/)[0];
  }

  grabText(elems) {
    let result = '';

    for (let elem of elems)
      if (elem.type === 'text')
        result += elem.data + ' ';
      else if (elem.children && elem.type !== 'comment')
        result += this.grabText(elem.children) + '\n';

    return result;
  }
}

co(function*() {
  let crawler = yield new Crawler('se.db');
  yield* crawler.crawl([encodeURI('https://ru.wikipedia.org/wiki/Программирование')], 50000);
}).catch(console.error);
