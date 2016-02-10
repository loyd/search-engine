"use strict";

import url from 'url';

import co from 'co';
import request from 'request-promise';
import cheerio from 'cheerio';
import sqlite3 from 'co-sqlite3';

import Stemmer from './stemmer';


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
  'urllocidx on wordlocation(urlid)',
  'wordlocidx on wordlocation(wordid)',
  'wordurllocidx on wordlocation(wordid, urlid)',
  'urltoidx on link(toid)',
  'urlfromidx on link(fromid)'
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

      let urls = yield db.all('select url from urllist');
      this.cache = new Set(urls.map(u => u.url));

      return this;
    });
  }

  crawl(pages, depth=3) {
    let queue = [];

    for (let page of pages) {
      page = page.split('#')[0];

      if (this.cache.has(page))
        continue;

      queue.push({url: page, depth});
      this.cache.add(page);
    }

    co.call(this, function*() {
      let page;
      while (page = queue.shift()) {
        let links = yield* this.visit(page.url);

        if (page.depth > 1)
          for (let link of links)
            queue.push({
              url: link,
              depth: page.depth - 1
            });
      }
    }).catch(console.error);
  }

  *visit(page) {
    try {
      let {body, headers} = yield request({
        url: page,
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
      console.error(`Error while processing ${page}: ${e}`);
      return [];
    }
  }

  *process(page, $) {
    let text = this.grabText($('html > body').get());
    yield* this.index(page, text);

    let links = [];

    $('a[href]').each((_, a) => {
      let rel = $(a).attr('href');
      let link = url.resolve(page, rel).split('#')[0];

      if (!link.startsWith('http') || this.cache.has(link))
        return;

      this.cache.add(link);
      links.push(link);
    });

    return links;
  }

  *index(page, text) {
    let {db} = this;
    let words = this.stemmer.tokenizeAndStem(text);

    let [$selectWord, $insertWord, $insertLoc] = yield [
      db.prepare('select rowid from wordlist where word=?'),
      db.prepare('insert into wordlist(word) values (?)'),
      db.prepare('insert into wordlocation(urlid, wordid, location) values (?, ?, ?)')
    ];

    console.log(decodeURI(page));

    yield db.run('begin');
    let {lastID: urlID} = yield db.run('insert into urllist(url) values (?)', page);

    for (let [loc, word] of words.entries()) {
      //#TODO: ensure that there is thread-safety.
      let result = yield $selectWord.get(word);
      let wordID = result ? result.rowid : (yield $insertWord.run(word)).lastID;
      yield $insertLoc.run(urlID, wordID, loc);
    }
    yield db.run('commit');
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
  crawler.crawl([encodeURI('https://ru.wikipedia.org/wiki/Программирование')]);
}).catch(console.error);
