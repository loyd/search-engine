"use strict";

import {Writable} from 'stream';
import urllib from 'url';

import co from 'co';
import sqlite3 from 'co-sqlite3';

import Stemmer from './stemmer';


const tables = [
  'page(url text not null collate nocase unique)',

  `word(
    stem      text    not null unique,
    pagecount integer not null
  )`,

  `indexed(
    pageid    integer not null primary key,
    title     text    not null,
    wordcount integer not null,
    linkcount integer not null,
    pagerank  real    not null
  ) without rowid`,

  `location(
    wordid    integer not null,
    pageid    integer not null,
    position  integer not null,
    frequency real    not null,
    primary key(wordid, pageid)
  ) without rowid`,

  `link(
    fromid integer not null,
    toid   integer not null,
    primary key(toid, fromid)
  ) without rowid`,

  `linkword(
    fromid integer not null,
    toid   integer not null,
    wordid integer not null
  )`
];

const indices = [
  'toidwordidx on linkword(toid, wordid)'
];

export default class Indexer extends Writable {
  constructor(dbname) {
    super({objectMode: true});

    this.db = null;
    this.pageCache = new Map;
    this.wordCache = new Map;
    this.stemmer = new Stemmer;

    return co.call(this, function*() {
      let db = this.db = yield sqlite3(dbname);

      yield tables.map(tbl => db.run(`create table if not exists ${tbl}`));
      yield indices.map(idx => db.run(`create index if not exists ${idx}`));

      let pages = yield db.all(`select pageid, lower(url) as url
                                from indexed join page on pageid = page.rowid`);
      for (let page of pages)
        this.pageCache.set(page.url, page.pageid);

      return this;
    });
  }

  _write(page, _, cb) {
    co.call(this, function*() {
      yield* this.index(page);
      cb();
    }).catch(cb);
  }

  *createPageIfUnknown(url) {
    let origUrl = this.stripUrl(url.trim());
    url = origUrl.toLowerCase();

    if (!url.startsWith('http') || this.pageCache.has(url))
      return null;

    let page = {
      url: origUrl,
      id: yield* this.takePageID(origUrl, url)
    };

    return page;
  }

  *index(page) {
    let {db} = this;
    let [words, wordCount] = this.prepareWords(page);

    yield db.run('begin');

    let wordGuard = this.indexWords(page, words, wordCount);

    let [links, linkCount] = this.prepareLinks(page);
    let linkGuard = this.indexLinks(page, links);

    let title = page.title.slice(0, 256);
    let indexGuard = db.run(`insert into indexed(pageid, title, wordcount, linkcount, pagerank)
                             values (?, ?, ?, ?, 0.)`, page.id, title, wordCount, linkCount);

    let [derived] = yield [linkGuard, wordGuard, indexGuard];
    yield db.run('commit');

    this.emit('indexed', page, derived);
  }

  prepareWords(page) {
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

    return [words, position];
  }

  *indexWords(page, words, wordCount) {
    let {db} = this;
    let [$insertLocation, $updateWord] = yield [
      db.prepare(`insert into location(wordid, pageid, position, frequency)
                  values (?, ${page.id}, ?, ?)`),
      db.prepare('update word set pagecount = pagecount + 1 where rowid = ?')
    ];

    for (let [stem, word] of words) {
      let wordID = yield* this.takeWordID(stem);
      $updateWord.run(wordID);
      $insertLocation.run(wordID, word.position, word.count / wordCount);
    }

    yield [
      $updateWord.finalize(),
      $insertLocation.finalize()
    ];
  }

  prepareLinks(page) {
    let links = new Map;
    let dofollow = 0;

    for (let link of page.links) {
      let resolved = urllib.resolve(page.url, link.href);
      let origUrl = this.stripUrl(resolved);

      // Don't transfer the link juice to dynamic pages.
      let questPos = link.href.indexOf('?');
      if (~questPos) {
        let hashPos = link.href.indexOf('#');
        if (hashPos === -1 || questPos < hashPos)
          link.nofollow = true;
      }

      // It's an anchor. Drop out.
      if (origUrl === page.url)
        continue;

      let url = origUrl.toLowerCase();
      if (!url.startsWith('http'))
        continue;

      let stored = links.get(url);
      if (!stored) {
        link.origUrl = origUrl;
        links.set(url, link);
        stored = link;
      }

      // Collect unique stems from the text.
      if (!link.nofollow) {
        let stemIter = this.stemmer.tokenizeAndStem(link.text);
        let stems = stored.stems = stored.stems || [];

        for (let stem of stemIter)
          if (stems.indexOf(stem) === -1) {
            stems.push(stem);
            if (stems.length >= 10)
              break;
          }

        if (stored === link || stored.nofollow) {
          ++dofollow;
          stored.nofollow = false;
        }
      }
    }

    return [links, dofollow];
  }

  *indexLinks(page, links) {
    let {db} = this;
    let [$insertLink, $insertLinkWord] = yield [
      db.prepare(`insert into link(fromid, toid) values (${page.id}, ?)`),
      db.prepare(`insert into linkword(fromid, toid, wordid) values (${page.id}, ?, ?)`)
    ];

    let derived = [];

    for (let [url, link] of links) {
      let known = this.pageCache.has(url);
      let pageID = yield* this.takePageID(link.origUrl, url);

      if (!known)
        derived.push({url: link.origUrl, id: pageID});

      if (!link.nofollow) {
        $insertLink.run(pageID);

        let wordIDs = yield link.stems.map(stem => this.takeWordID(stem));
        for (let wordID of wordIDs)
          $insertLinkWord.run(pageID, wordID);
      }
    }

    yield [
      $insertLink.finalize(),
      $insertLinkWord.finalize()
    ];

    return derived;
  }

  *takePageID(origUrl, url) {
    let cache = this.pageCache;
    let id = cache.get(url);

    if (!id) {
      id = (
        (yield this.db.get('select rowid as lastID from page where url = ?', origUrl)) ||
        (yield this.db.run('insert into page(url) values (?)', origUrl))
      ).lastID;

      cache.set(url, id);
    }

    return id;
  }

  *takeWordID(stem) {
    let cache = this.wordCache;
    let id = cache.get(stem);

    if (typeof id === 'number')
      return id;
    else if (id)
      return yield id;

    let promise = co.call(this, function*() {
      let id = (
        (yield this.db.get('select rowid as lastID from word where stem = ?', stem)) ||
        (yield this.db.run('insert into word(stem, pagecount) values (?, 0)', stem))
      ).lastID;

      cache.set(stem, id);
      return id;
    });

    cache.set(stem, promise);
    return yield promise;
  }

  stripUrl(url) {
    return url.split(/[#?]/)[0];
  }
}
