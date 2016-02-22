"use strict";

import {Writable} from 'stream';
import urllib from 'url';

import co from 'co';
import sqlite3 from 'co-sqlite3';

import Stemmer from './stemmer';


const tables = [
  `page(
    pageid integer not null primary key,
    url    text    not null collate nocase unique
  )`,

  `word(
    wordid   integer not null primary key,
    stem     text    not null unique,
    numpages integer not null,
    numheads integer not null
  )`,

  `indexed(
    pageid   integer not null primary key references page(pageid),
    title    text    not null,
    numwords integer not null,
    numheads integer not null,
    pagerank real    not null
  ) without rowid`,

  `location(
    wordid   integer not null references word(wordid),
    pageid   integer not null references page(pageid),
    position integer not null,
    wordfreq real    not null,
    headfreq real    not null,
    primary key(wordid, pageid)
  ) without rowid`,

  `link(
    fromid integer not null references page(pageid),
    toid   integer not null references page(pageid)
  )`,

  `linkword(
    fromid integer not null references page(pageid),
    toid   integer not null references page(pageid),
    wordid integer not null references word(wordid)
  )`,

  `info(
    numindexed  integer not null,
    avgnumwords real    not null,
    avgnumheads real    not null
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
        insertIndexed: db.prepare(`insert into indexed(pageid, title, numwords, numheads, pagerank)
                                   values (?, ?, ?, ?, 0.)`),
        insertLink: db.prepare('insert into link(fromid, toid) values (?, ?)'),
        insertLinkWord: db.prepare('insert into linkword(fromid, toid, wordid) values (?, ?, ?)'),
        insertLocation: db.prepare(`insert into
                                    location(wordid, pageid, position, wordfreq, headfreq)
                                    values (?, ?, ?, ?, ?)`),
        insertPage: db.prepare('insert into page(url) values (?)'),
        insertWord: db.prepare('insert into word(stem, numpages, numheads) values (?, 0, 0)'),
        selectPage: db.prepare('select pageid from page where url = ?'),
        selectWord: db.prepare('select wordid from word where stem = ?'),
        updateWord: db.prepare('update word set numpages = numpages + 1 where wordid = ?'),
        updateHeadWord: db.prepare(`update word set numpages = numpages + 1,
                                                    numheads = numheads + 1 where wordid = ?`)
      };

      this.on('finish', () => {
        for (let name in this.sql)
          this.sql[name].finalize();
        db.close();
      });

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

    url = this.stripUrl(urlObj);

    let [id, known] = yield* this.takePageID(url);
    if (known)
      return null;

    return {id, url};
  }

  *index(page) {
    let {db} = this;

    yield db.run('begin');

    try {
      let [words, numWords, numHeads] = this.prepareWords(page);
      let wordGuard = this.indexWords(page, words, numWords, numHeads);

      let title = page.title.slice(0, 256);
      let indexGuard = this.sql.insertIndexed.run(page.id, title, numWords, numHeads);

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
    let words = new Map;

    let stemIter = this.stemmer.tokenizeAndStem(`${page.title} ${page.content}`);
    let position = 0;

    for (let stem of stemIter) {
      if (words.has(stem))
        ++words.get(stem).numWords;
      else
        words.set(stem, {position, numWords: 1, numHeads: 0});

      ++position;
    }

    let headStemIter = this.stemmer.tokenizeAndStem(`${page.title} ${page.headers}`);
    let numHeads = 0;

    for (let stem of headStemIter) {
      ++words.get(stem).numHeads;
      ++numHeads;
    }

    return [words, position, numHeads];
  }

  *indexWords(page, words, numWords, numHeads) {
    let {db} = this;

    for (let [stem, word] of words) {
      let wordID = yield* this.takeWordID(stem);

      if (word.numHeads) {
        let [wordFreq, headFreq] = [word.numWords / numWords, word.numHeads / numHeads];
        this.sql.updateHeadWord.run(wordID);
        this.sql.insertLocation.run(wordID, page.id, word.position, wordFreq, headFreq);
      } else {
        this.sql.updateWord.run(wordID);
        this.sql.insertLocation.run(wordID, page.id, word.position, word.numWords / numWords, 0);
      }
    }
  }

  prepareLinks(page) {
    let links = new Map;

    for (let link of page.links) {
      let resolved = urllib.resolve(page.url, link.href);
      let urlObj = urllib.parse(resolved);

      if (!this.guessRelevant(urlObj))
        continue;

      let url = this.stripUrl(urlObj);

      // It's an anchor. Drop out.
      if (url === page.url)
        continue;

      // Don't transfer the link juice to dynamic pages.
      if (urlObj.query)
        link.nofollow = true;

      let lowerUrl = url.toLowerCase();
      let stored = links.get(lowerUrl);
      if (!stored) {
        link.url = url;
        links.set(lowerUrl, link);
        stored = link;
      }

      if (!link.nofollow)
        stored.nofollow = false;

      // Collect unique stems from the text.
      if (link.text && !link.nofollow) {
        let stemIter = this.stemmer.tokenizeAndStem(link.text);
        let stems = stored.stems = stored.stems || [];

        for (let stem of stemIter)
          if (stems.indexOf(stem) === -1) {
            stems.push(stem);
            if (stems.length >= this.linkStemLimit)
              break;
          }
      }
    }

    return links;
  }

  *indexLinks(page, links) {
    let {db} = this;
    let derived = [];

    for (let link of links.values()) {
      let [pageID, known] = yield* this.takePageID(link.url);

      if (!known)
        derived.push({url: link.url, id: pageID});

      if (!link.nofollow)
        this.sql.insertLink.run(page.id, pageID);

      if (link.stems) {
        let wordIDs = yield link.stems.map(stem => this.takeWordID(stem));
        for (let wordID of wordIDs)
          this.sql.insertLinkWord.run(page.id, pageID, wordID);
      }
    }

    return derived;
  }

  *takePageID(url) {
    let row = yield this.sql.selectPage.get(url);
    let known = !!row;
    let id = row ? row.pageid : (yield this.sql.insertPage.run(url)).lastID;
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
      let id = row ? row.wordid : (yield this.sql.insertWord.run(stem)).lastID;

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
      case 'html': case 'php': case 'asp': case 'aspx': case 'htm': case 'xhtml': case 'stm':
      case 'phtml': case 'php3': case 'php4': case 'php5': case 'phps': case 'xht': case 'adp':
      case 'bml': case 'cfm': case 'cgi': case 'ihtml': case 'jsp': case 'las': case 'lasso':
      case 'pl': case 'rna': case 'r': case 'rnx': case 'shtml':
        return true;
    }

    return false;
  }
}
