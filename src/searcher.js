"use strict";

import co from 'co';
import sqlite3 from 'co-sqlite3';
import {OPEN_READONLY} from 'sqlite3';

import Stemmer from './stemmer';


export default class Searcher {
  constructor(dbname) {
    this.db = null;
    this.info = null;

    this.stemmer = new Stemmer;

    this.guard = co.call(this, function*() {
      this.db = yield sqlite3(dbname, OPEN_READONLY);
      this.info = yield this.db.get(`
        select indexedcount as indexedCount, avgwordcount as avgWordCount from info
      `);
    });
  }

  search(query, limit=Infinity, offset=0) {
    return co.call(this, function*() {
      yield this.guard;

      let words = yield* this.matchWords(query);
      let pages = yield* this.pickPages(words);

      this.rankPages(pages, words);
      let result = yield this.fetchInfo(pages.slice(offset, offset + limit));
      result.total = pages.length;

      return result;
    });
  }

  *matchWords(query) {
    let stems = [...this.stemmer.tokenizeAndStem(query)];

    if (stems.length === 0)
      return [];

    let join = stems.map(w => `'${w}'`).join(',');
    let words = yield this.db.all(`select rowid as wordID, pagecount as pageCount
                                   from word where stem in (${join})`);
    return words.sort((a, b) => a.pageCount - b.pageCount);
  }

  *pickPages(words) {
    if (words.length === 0)
      return [];

    let wordIDs = words.map(word => word.wordID);
    let [select, from, where, sum] = ['', '', '', ''];

    for (let [i, wordID] of wordIDs.entries()) {
      if (i > 0) {
        select += ', ';
        from += ` join location l${i} using (pageid)`;
        where += ' and ';
        sum += ' + ';
      }

      select += `l${i}.frequency as frequency${i}`;
      where += `l${i}.wordid = ${wordID}`;
      sum += `l${i}.position`;
    }

    let fullQuery = `
      select
        idx.pageid as pageID,
        idx.wordcount as wordCount,
        idx.pagerank as pageRank,
        total(fromidx.pagerank) as referentPageRank,
        ${sum} as totalPosition,
        ${select}

      from location l0 ${from}
      join indexed idx using(pageid)
      left join linkword on idx.pageid = toid
      join indexed fromidx on fromidx.pageid = fromid

      where ${where}
      and linkword.wordid in (${wordIDs.join(', ')})
      group by l0.pageid
    `;

    return yield this.db.all(fullQuery);
  }

  rankPages(pages, words) {
    let {indexedCount, avgWordCount} = this.info;

    for (let word of words)
      word.idf = Math.max(Math.log((indexedCount - word.pageCount) / word.pageCount), 0);

    let maxBM25 = 0;
    let maxTotalPosition = 0;
    let maxReferentPageRank = 0;
    let maxPageRank = 0;

    for (let page of pages) {
      let gain = 2 * (.25 + .75 * (page.wordCount / avgWordCount));
      page.bm25 = words.reduce((acc, w, i) =>
        acc + w.idf * 3 * page['frequency'+i] / (page['frequency'+i] + gain), 0);

      maxBM25 = Math.max(maxBM25, page.bm25);
      maxTotalPosition = Math.max(maxTotalPosition, page.totalPosition);
      maxReferentPageRank = Math.max(maxReferentPageRank, page.referentPageRank);
      maxPageRank = Math.max(maxPageRank, page.pageRank);
    }

    for (let page of pages) {
      let bm25Score = page.bm25 / Math.max(maxBM25, 1);
      let posScore = 1 - page.totalPosition / Math.max(maxTotalPosition, 1);
      let refScore = page.referentPageRank / maxReferentPageRank;
      let prScore = page.pageRank / maxPageRank;

      page.score = (.5 * prScore + 1.5 * refScore + posScore + 2 * bm25Score) / 5;
      //page.scores = [prScore, refScore, posScore, bm25Score];
    }

    pages.sort((a, b) => b.score - a.score);
  }

  *fetchInfo(pages) {
    let map = pages.reduce((map, page) => map.set(page.pageID, {score: page.score}), new Map);

    let result = yield this.db.all(`
      select pageid, url, title from indexed join page on pageid = page.rowid
      where pageid in (${pages.map(p => p.pageID).join(',')})
    `);

    for (let info of result) {
      let page = map.get(info.pageid);
      page.url = info.url;
      page.title = info.title;
    }

    return [...map.values()];
  }
}
