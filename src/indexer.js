"use strict";

import urllib from 'url';

import co from 'co';
import sqlite3 from 'co-sqlite3';


const tables = [
  `page(
    pageid integer not null primary key,
    key    text    not null unique
  )`,

  `word(
    wordid    integer not null primary key,
    stem      text    not null unique,
    pagecount integer not null,
    headcount integer not null
  )`,

  `indexed(
    pageid    integer not null primary key references page(pageid),
    url       text    not null,
    title     text    not null,
    wordcount integer not null,
    headcount integer not null,
    pagerank  real    not null
  ) without rowid`,

  `location(
    wordid    integer not null references word(wordid),
    pageid    integer not null references indexed(pageid),
    position  integer not null,
    wordcount integer not null,
    headcount integer not null,
    primary key(wordid, pageid)
  ) without rowid`,

  `link(
    fromid integer not null references indexed(pageid),
    toid   integer not null references page(pageid)
  )`,

  `linkword(
    fromid integer not null references indexed(pageid),
    toid   integer not null references page(pageid),
    wordid integer not null references word(wordid)
  )`,

  `info(
    indexedcount integer not null,
    avgwordcount real    not null,
    avgheadcount real    not null
  )`
];

export default class Indexer {
  constructor() {
    this.db = null;
    this.wordCache = new Map;
  }

  *connect(dbname) {
    let db = this.db = yield sqlite3(dbname);

    yield tables.map(tbl => db.run(`create table if not exists ${tbl}`));

    this.sql = yield {
      insertIndexed: db.prepare(`insert into
                                 indexed(pageid, url, title, wordcount, headcount, pagerank)
                                 values (?, ?, ?, ?, ?, .15)`),
      insertLink: db.prepare('insert into link(fromid, toid) values (?, ?)'),
      insertLinkWord: db.prepare('insert into linkword(fromid, toid, wordid) values (?, ?, ?)'),
      insertLocation: db.prepare(`insert into
                                  location(wordid, pageid, position, wordcount, headcount)
                                  values (?, ?, ?, ?, ?)`),
      insertPage: db.prepare('insert into page(key) values (?)'),
      insertWord: db.prepare('insert into word(stem, pagecount, headcount) values (?, 0, 0)'),
      selectPage: db.prepare('select pageid from page where key = ?'),
      selectWord: db.prepare('select wordid from word where stem = ?'),
      updateWord: db.prepare('update word set pagecount = pagecount + 1 where wordid = ?'),
      updateHeadWord: db.prepare(`update word set pagecount = pagecount + 1,
                                                  headcount = headcount + 1 where wordid = ?`)
    };

    // Who cares?
    yield db.run('pragma foreign_keys = off');
    yield db.run('pragma synchronous = off');
    yield db.run('pragma journal_mode = memory');
  }

  *each(cb) {
    return yield complete => this.db.db.each('select url from indexed join page using (pageid)',
                                             (_, {url}) => cb(url), complete);
  }

  *index(page) {
    let {db} = this;

    yield db.run('begin');

    try {
      page.id = yield* this.takePageID(page.key);
      yield this.sql.insertIndexed.run(page.id, page.url, page.title,
                                       page.wordCount, page.headCount);
      yield [
        this.indexWords(page),
        this.indexLinks(page)
      ];
    } catch (ex) {
      yield db.run('rollback');
      throw ex;
    }

    yield db.run('commit');
  }

  *indexWords(page) {
    let {sql} = this;
    let guards = [];

    for (let [stem, w] of page.words) {
      let wordID = yield* this.takeWordID(stem);
      guards.push((w.headCount ? sql.updateHeadWord : sql.updateWord).run(wordID));
      guards.push(sql.insertLocation.run(wordID, page.id, w.position, w.wordCount, w.headCount));
    }

    yield guards;
  }

  *indexLinks(page) {
    let {sql} = this;
    let guards = [];

    for (let link of page.links) if (link.index) {
      let pageID = yield* this.takePageID(link.key);
      guards.push(sql.insertLink.run(page.id, pageID));

      if (link.stems) {
        let wordIDs = yield link.stems.map(stem => this.takeWordID(stem));
        for (let wordID of wordIDs)
          guards.push(sql.insertLinkWord.run(page.id, pageID, wordID));
      }
    }

    yield guards;
  }

  *takePageID(key) {
    let row = yield this.sql.selectPage.get(key);
    return row ? row.pageid : (yield this.sql.insertPage.run(key)).lastID;
  }

  *takeWordID(stem) {
    let cache = this.wordCache;
    let id = cache.get(stem);

    if (typeof id === 'number')
      return id;
    else if (id)
      return yield id;

    let promise = co.call(this, function*() {
      let row = yield this.sql.selectWord.get(stem);
      let id = row ? row.wordid : (yield this.sql.insertWord.run(stem)).lastID;

      cache.set(stem, id);
      return id;
    });

    cache.set(stem, promise);
    return yield promise;
  }
}
