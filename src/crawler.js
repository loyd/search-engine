"use strict";

import url from 'url';

import co from 'co';
import request from 'request-promise';
import cheerio from 'cheerio';
import sqlite3 from 'co-sqlite3';
import natural from 'natural';

import {words as enStopwords} from 'natural/lib/natural/util/stopwords';
import {words as ruStopwords} from 'natural/lib/natural/util/stopwords_ru';


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

const stopwords = new Set(enStopwords.concat(ruStopwords));

export default class Crawler {
  constructor(dbname, concurrency=5) {
    this.cache = new Set;
    this.db = null;
    this.concurrency = concurrency;

    this.tokenizer = new natural.AggressiveTokenizerRu;
    this.enStemmer = natural.PorterStemmer;
    this.ruStemmer = natural.PorterStemmerRu;

    return co.call(this, function*() {
      let db = this.db = yield sqlite3(dbname);

      yield tables.map(tbl => db.run(`create table if not exists ${tbl}`));
      yield indices.map(idx => db.run(`create index if not exists ${idx}`));

      return this;
    });
  }

  crawl(pages, depth=3) {
    let queue = new Queue(pages.map(page => ({url: page, depth})));

    pages.forEach(p => this.cache.add(p));

    for (let i = 0; i < this.concurrency; ++i)
      co.call(this, function*() {
        for (;;) {
          let page = yield queue.dequeue();
          let links = yield* this.visit(page.url);

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
      this.addLink(page, link);

      links.push(link);
    });

    return links;
  }

  *index(page, text) {
    let {db} = this;
    let words = this.tokenizeAndStem(text);

    let [$selectWord, $insertWord, $insertLoc] = yield [
      db.prepare('select rowid from wordlist where word=?'),
      db.prepare('insert into wordlist(word) values (?)'),
      db.prepare('insert into wordlocation(urlid, wordid, location) values (?, ?, ?)')
    ];

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

  tokenizeAndStem(text) {
    let words = this.tokenizer.tokenize(text);
    let stemmed = [];

    for (let word of words) {
      word = word.toLowerCase();

      if (!stopwords.has(word)) {
        let stemmer = word.charCodeAt(0) < 128 ? this.enStemmer : this.ruStemmer;
        stemmed.push(stemmer.stem(word));
      }
    }

    return stemmed;
  }

  addLink(from, to) {}
}

co(function*() {
  let crawler = yield new Crawler('se.db', 1);
  crawler.crawl(['https://learn.javascript.ru/promise'], 3);
}).catch(console.error);
