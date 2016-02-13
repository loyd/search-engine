"use strict";

import url from 'url';

import co from 'co';
import request from 'request-promise';
import sqlite3 from 'co-sqlite3';
import {Parser} from 'htmlparser2';
import {Readability} from 'readabilitySAX';

import Stemmer from './stemmer';


class Handler extends Readability {
  constructor() {
    super({searchFurtherPages: false});

    // Nesting <a> element is forbidden in HTML(5). Ignore it.
    this.nested = 0;
    this.links = [];
    this.link = null;
  }

  onopentag(name, attribs) {
    if (name === 'a')
      if (this.nested++ === 0) {
        let href = attribs.href || this.findHref(attribs);
        if (href)
          this.link = {href, text: ''};
      }

    super.onopentag && super.onopentag(name, attribs);
  }

  ontext(text) {
    if (this.nested && this.link)
      this.link.text += text + ' ';

    super.ontext(text);
  }

  onclosetag(name) {
    if (name === 'a') {
      if (this.nested === 1 && this.link) {
        this.links.push(this.link);
        this.link = null;
      }

      this.nested = Math.max(this.nested - 1, 0);
    }

    super.onclosetag(name);
  }

  onreset() {
    this.nested = 0;
    this.links.length = 0;
    this.link = null;

    super.onreset();
  }

  findHref(attribs) {
    for (let name of Object.keys(attribs))
      if (name.toLowerCase() === 'href')
        return attribs[name];
  }
}

const tables = [
  'page(url, title)',
  'word(stem, count)',
  'location(pageid, wordid, position, primary key(wordid, pageid, position)) without rowid',
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

    this.handler = new Handler;
    this.parser = new Parser(this.handler);

    this.stemmer = new Stemmer;

    this.downloaded = 0;
    this.indexed = 0;

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

    all: for (let i = 0; i < depth; ++i) {
      let page, next = [];

      while (page = pages.shift()) {
        if (this.indexed >= limit)
          break all;

        let derived = yield* this.visit(page);
        next.push(...derived);

        console.log('[%d|%d] %s', this.indexed, this.downloaded, decodeURI(page.url));
      }

      pages = next;
    }
  }

  *visit(page) {
    // Downloading.
    try {
      var {body, headers} = yield* this.download(page);
    } catch (_) {
      return [];
    }

    let acceptType = (headers['content-type'] || '').indexOf('html') > -1;
    let acceptLang = /en|ru/i.test(headers['content-language'] || 'en');

    if (!acceptType || !acceptLang)
      return [];

    ++this.downloaded;

    // Parsing.
    try {
      this.parser.parseComplete(body);
    } catch (ex) {
      console.error(`Error while parsing ${page.url}: ${ex}`);
      return [];
    }

    page.title = this.handler.getTitle();
    page.content = this.handler.getText();
    page.links = this.handler.links;

    // Processing.
    try {
      var derived = yield* this.process(page);
    } catch (ex) {
      console.error(`Error while processing ${page.url}: ${ex}`);
      return [];
    }

    ++this.indexed;
    return derived;
  }

  *download(page) {
    return yield request({
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
  }

  *process(page) {
    yield this.db.run('begin');

    let [links] = yield [
      this.indexLinks(page),
      this.indexBody(page)
    ];

    yield this.db.run('commit');
    return links;
  }

  *indexBody(page) {
    let {db} = this;
    let title = page.title.slice(0, 256);
    let stemIter = this.stemmer.tokenizeAndStem(page.content);
    let position = 0;

    let [$insertLocation, $updateWord] = yield [
      db.prepare(`insert into location(pageid, wordid, position) values (${page.id}, ?, ?)`),
      db.prepare('update word set count = count + 1 where rowid = ?')
    ];

    yield db.run('update page set title = ? where rowid = ?', title, page.id);

    for (let stem of stemIter) {
      let wordID = yield* this.takeWordID(stem);
      yield [
        $updateWord.run(wordID),
        $insertLocation.run(wordID, position++)
      ];
    }
  }

  *indexLinks(page) {
    let query = `insert into link(fromid, toid, wordid) values(${page.id}, ?, ?)`;

    let $insert = yield this.db.prepare(query);
    let derived = [];

    for (let link of page.links) {
      let fullUrl = this.stripUrl(url.resolve(page.url, link.href));

      if (!fullUrl.startsWith('http'))
        continue;

      let pageID = yield* this.takePageID(fullUrl);
      let stems = [...this.stemmer.tokenizeAndStem(link.text)].slice(0, 10);

      let wordIDs = yield stems.map(stem => this.takeWordID(stem));
      yield wordIDs.map(wordID => $insert.run(pageID, wordID));

      if (!this.cache.has(fullUrl)) {
        this.cache.add(fullUrl);
        derived.push({url: fullUrl, id: pageID});
      }
    }

    return derived;
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
}

co(function*() {
  let crawler = yield new Crawler('se.db');
  yield* crawler.crawl([encodeURI('https://ru.wikipedia.org/wiki/Программирование')], 50000);
}).catch(console.error);
