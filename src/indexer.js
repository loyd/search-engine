"use strict";

import {Writable} from 'stream';
import urllib from 'url';

import co from 'co';
import sqlite3 from 'co-sqlite3';

import Stemmer from './stemmer';


const tables = [
  `page(
    rowid integer not null primary key,
    url   text    not null collate nocase unique
  )`,

  `word(
    rowid     integer not null primary key,
    stem      text    not null unique,
    pagecount integer not null
  )`,

  `indexed(
    pageid    integer not null primary key references page(rowid),
    title     text    not null,
    wordcount integer not null,
    pagerank  real    not null
  ) without rowid`,

  `location(
    wordid    integer not null references word(rowid),
    pageid    integer not null references page(rowid),
    position  integer not null,
    frequency real    not null,
    primary key(wordid, pageid)
  ) without rowid`,

  `link(
    fromid integer not null references page(rowid),
    toid   integer not null references page(rowid)
  )`,

  `linkword(
    fromid integer not null references page(rowid),
    toid   integer not null references page(rowid),
    wordid integer not null references word(rowid)
  )`,

  `info(
    indexedcount integer not null,
    avgwordcount real not null
  )`
];

const indices = [
  'toidwordidx on linkword(toid, wordid)'
];

export default class Indexer extends Writable {
  constructor(dbname, loose=false, linkStemLimit=10) {
    super({objectMode: true});

    this.loose = loose;
    this.linkStemLimit = linkStemLimit;

    this.db = null;
    this.wordCache = new Map;
    this.stemmer = new Stemmer;

    return co.call(this, function*() {
      let db = this.db = yield sqlite3(dbname);

      yield tables.map(tbl => db.run(`create table if not exists ${tbl}`));
      yield indices.map(idx => db.run(`create index if not exists ${idx}`));

      this.sql = yield {
        insertIndexed: db.prepare(`insert into indexed(pageid, title, wordcount, pagerank)
                                   values (?, ?, ?, 0.)`),
        insertLink: db.prepare('insert into link(fromid, toid) values (?, ?)'),
        insertLinkWord: db.prepare('insert into linkword(fromid, toid, wordid) values (?, ?, ?)'),
        insertLocation: db.prepare(`insert into location(wordid, pageid, position, frequency)
                                    values (?, ?, ?, ?)`),
        insertPage: db.prepare('insert into page(url) values (?)'),
        insertWord: db.prepare('insert into word(stem, pagecount) values (?, 0)'),
        selectPage: db.prepare('select rowid from page where url = ?'),
        selectWord: db.prepare('select rowid from word where stem = ?'),
        updateWord: db.prepare('update word set pagecount = pagecount + 1 where rowid = ?')
      };

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
    let urlObj = urllib.parse(url);
    if (!this.guessRelevant(urlObj))
      return null;

    let origUrl = this.stripUrl(urlObj);
    url = origUrl.toLowerCase();

    let [id, known] = yield* this.takePageID(origUrl, url);
    if (known)
      return null;

    return {id, url: origUrl};
  }

  *index(page) {
    let {db} = this;

    yield db.run('begin');

    try {
      let [words, wordCount] = this.prepareWords(page);
      let wordGuard = this.indexWords(page, words, wordCount);

      let title = page.title.slice(0, 256);
      let indexGuard = this.sql.insertIndexed.run(page.id, title, wordCount);

      let links = this.prepareLinks(page);
      let linkGuard = this.indexLinks(page, links);

      var [derived] = yield [linkGuard, wordGuard, indexGuard];
    } catch (ex) {
      yield db.run('rollback');
      throw ex;
    }

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

    for (let [stem, word] of words) {
      let wordID = yield* this.takeWordID(stem);
      this.sql.updateWord.run(wordID);
      this.sql.insertLocation.run(wordID, page.id, word.position, word.count / wordCount);
    }
  }

  prepareLinks(page) {
    let links = new Map;

    for (let link of page.links) {
      let resolved = urllib.resolve(page.url, link.href);
      let urlObj = urllib.parse(resolved);

      if (!this.guessRelevant(urlObj))
        continue;

      let origUrl = this.stripUrl(urlObj);

      // It's an anchor. Drop out.
      if (origUrl === page.url)
        continue;

      // Don't transfer the link juice to dynamic pages.
      if (urlObj.query)
        link.nofollow = true;

      let url = origUrl.toLowerCase();
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
            if (stems.length >= this.linkStemLimit)
              break;
          }

        if (stored === link || stored.nofollow)
          stored.nofollow = false;
      }
    }

    return links;
  }

  *indexLinks(page, links) {
    let {db} = this;
    let derived = [];

    for (let [url, link] of links) {
      let [pageID, known] = yield* this.takePageID(link.origUrl, url);

      if (!known)
        derived.push({url: link.origUrl, id: pageID});

      if (!link.nofollow) {
        this.sql.insertLink.run(page.id, pageID);

        let wordIDs = yield link.stems.map(stem => this.takeWordID(stem));
        for (let wordID of wordIDs)
          this.sql.insertLinkWord.run(page.id, pageID, wordID);
      }
    }

    return derived;
  }

  *takePageID(origUrl, url) {
    let row = yield this.sql.selectPage.get(origUrl);
    let known = !!row;
    let id = row ? row.rowid : (yield this.sql.insertPage.run(origUrl)).lastID;
    return [id, known];
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
      let id = row ? row.rowid : (yield this.sql.insertWord.run(stem)).lastID;

      cache.set(stem, id);
      return id;
    });

    cache.set(stem, promise);
    return yield promise;
  }

  stripUrl(urlObj) {
    return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
  }

  guessRelevant(urlObj) {
    if (!urlObj.protocol.startsWith('http'))
      return false;

    if (this.loose)
      return true;

    //#TODO: what about blacklist?
    let h = urlObj.hostname;
    if (h.startsWith('git.') || h.startsWith('svn.') || h.startsWith('hg.'))
      return false;

    let p = urlObj.pathname;
    let i = p.lastIndexOf('.');

    // No extension or unlikely.
    if (i === -1 || p.length - i > 6)
      return true;

    let ext = p.slice(i+1).toLowerCase();
    switch (ext) {
      case 'html': case 'htm': case 'xhtml': case 'xht': case 'asp': case 'aspx': case 'adp':
      case 'bml': case 'cfm': case 'cgi': case 'ihtml': case 'jsp': case 'las': case 'lasso':
      case 'pl': case 'phtml': case 'rna': case 'r': case 'rnx': case 'shtml': case 'stm':
        return true;
    }

    // Case .php<version>.
    if (ext.startsWith('php'))
      return true;

    return false;
  }
}
