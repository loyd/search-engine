"use strict";

import {Writable} from 'stream';
import urllib from 'url';

import co from 'co';
import sqlite3 from 'co-sqlite3';

import Stemmer from './stemmer';


const tables = [
  'page(url)',
  'indexed(pageid primary key, title, length) without rowid',
  'word(stem, count, idf)',
  'location(pageid, wordid, position, frequency, primary key(wordid, pageid)) without rowid',
  'link(fromid, toid, wordid)'
];

const indices = [
  'urlidx on page(url)',
  'stemidx on word(stem)',
  'toididx on link(toid)',
  'fromididx on link(fromid)'
];

export default class Indexer extends Writable {
  constructor(dbname) {
    super({objectMode: true});

    this.db = null
    this.pageCache = new Map;
    this.wordCache = new Map;
    this.stemmer = new Stemmer;

    return co.call(this, function*() {
      let db = this.db = yield sqlite3(dbname);

      yield tables.map(tbl => db.run(`create table if not exists ${tbl}`));
      yield indices.map(idx => db.run(`create index if not exists ${idx}`));

      let pages = yield db.all('select pageid, url from indexed join page on pageid = page.rowid');

      for (let page of pages)
        this.pageCache.set(page.url, page.pageid);

      return this;
    });
  }

  end() {
    super.end();
    this.once('indexed', _ => this.db.close());
  }

  _write(page, _, cb) {
    co.call(this, function*() {
      yield* this.process(page);
      cb();
    }).catch(cb);
  }

  *createPageIfUnknown(url) {
    let origUrl = this.stripUrl(url);
    url = origUrl.toLowerCase();

    if (!url.startsWith('http') || this.pageCache.has(url))
      return null;

    let page = {
      url: origUrl,
      id: yield* this.takePageID(url)
    };

    return page;
  }

  *process(page) {
    yield this.db.run('begin');

    let [derived] = yield [
      this.indexLinks(page),
      this.indexBody(page)
    ];

    yield this.db.run('commit');
    this.emit('indexed', page, derived);
  }

  *indexBody(page) {
    let {db} = this;

    let [$insertLocation, $updateWord] = yield [
      db.prepare(`insert into location(pageid, wordid, position, frequency)
                  values (${page.id}, ?, ?, ?)`),
      db.prepare('update word set count = count + 1 where rowid = ?')
    ];

    let stemIter = this.stemmer.tokenizeAndStem(page.content);
    let words = new Map;
    let position = 0;

    for (let stem of stemIter) {
      if (words.has(stem))
        ++words.get(stem).count;
      else
        words.set(stem, {position, count: 1});

      ++position;
    }

    for (let [stem, word] of words) {
      let wordID = yield* this.takeWordID(stem);
      $updateWord.run(wordID),
      $insertLocation.run(wordID, word.position, word.count / position)
    }

    $updateWord.finalize();
    $insertLocation.finalize();

    let title = page.title.slice(0, 256);
    db.run('insert into indexed(pageid, title, length) values (?, ?, ?)', page.id, title, position);
  }

  *indexLinks(page) {
    let query = `insert into link(fromid, toid, wordid) values(${page.id}, ?, ?)`;
    let $insert = yield this.db.prepare(query);

    let derived = [];
    let priced = new Set;

    for (let link of page.links) {
      let origUrl = this.stripUrl(urllib.resolve(page.url, link.href));
      let url = origUrl.toLowerCase();

      if (!url.startsWith('http') || priced.has(url))
        continue;

      priced.add(url);

      let known = this.pageCache.has(url);
      let pageID = yield* this.takePageID(url);

      if (!known)
        derived.push({url: origUrl, id: pageID});

      let stems = [...this.stemmer.tokenizeAndStem(link.text)].slice(0, 10);

      let wordIDs = yield stems.map(stem => this.takeWordID(stem));
      for (let wordID of wordIDs)
        $insert.run(pageID, wordID);
    }

    $insert.finalize();

    return derived;
  }

  *takePageID(url) {
    let cache = this.pageCache;
    let id = cache.get(url);

    if (!id) {
      id = (
        (yield this.db.get('select rowid as lastID from page where url = ?', url)) ||
        (yield this.db.run('insert into page(url) values (?)', url))
      ).lastID;

      cache.set(url, id);
    }

    return id;
  }

  *takeWordID(stem) {
    let cache = this.wordCache;
    let id = cache.get(stem);

    if (!id) {
      id = (
        (yield this.db.get('select rowid as lastID from word where stem = ?', stem)) ||
        (yield this.db.run('insert into word(stem, count) values (?, 0)', stem))
      ).lastID;

      cache.set(stem, id);
    }

    return id;
  }

  stripUrl(url) {
    return url.split(/[#?]/)[0];
  }
}
