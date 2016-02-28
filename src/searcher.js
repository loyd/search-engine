"use strict";

import co from 'co';
import sqlite3 from 'co-sqlite3';
import {OPEN_READONLY} from 'sqlite3';

import Stemmer from './stemmer';


export default class Searcher {
  constructor(dbname, verbose=false) {
    this.db = null;
    this.info = null;
    this.verbose = verbose;

    this.stemmer = new Stemmer;

    this.guard = co.call(this, function*() {
      this.db = yield sqlite3(dbname, OPEN_READONLY);
      this.info = yield this.db.get(`
        select numindexed as numIndexed,
               avgnumwords as avgNumWords,
               avgnumheads as avgNumHeads
        from info
      `);
    });
  }

  search(query, limit=Infinity, offset=0) {
    return co.call(this, function*() {
      yield this.guard;
      let start = Date.now();

      let words = yield* this.matchWords(query);
      let pages = yield* this.pickPages(words);

      this.rankPages(pages, words);

      let result = yield this.fetchInfo(pages.slice(offset, offset + limit));
      result.total = pages.length;
      result.spent = Date.now() - start;

      return result;
    });
  }

  *matchWords(query) {
    let stems = [...this.stemmer.tokenizeAndStem(query)];

    if (stems.length === 0)
      return [];

    let join = stems.map(w => `'${w}'`).join(',');
    let words = yield this.db.all(`select wordid as wordID,
                                          numpages as numPages,
                                          numheads as numHeads
                                   from word where stem in (${join})`);
    return words.sort((a, b) => a.numPages - b.numPages);
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

      select += `l${i}.wordfreq as wordFreq${i}, `;
      select += `l${i}.headfreq as headFreq${i}`;
      where += `l${i}.wordid = ${wordID}`;
      sum += `l${i}.position`;
    }

    let fullQuery = `
      select
        idx.pageid as pageID,
        idx.numwords as numWords,
        idx.numheads as numHeads,
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
    let {numIndexed, avgNumWords, avgNumHeads} = this.info;

    for (let word of words) {
      word.wordIDF = Math.max(Math.log((numIndexed - word.numPages) / word.numPages), 0);
      word.headIDF = word.numHeads &&
        Math.max(Math.log((numIndexed - word.numHeads) / word.numHeads), 0);
    }

    let maxWordBM25 = 0;
    let maxHeadBM25 = 0;
    let maxNumWords = 0;
    let maxTotalPosition = 0;
    let maxRefPageRank = 0;
    let maxPageRank = 0;

    const k = 1.5;
    const b = .15;
    const d = 1;

    for (let page of pages) {
      let gain = 1 - b + b * (page.numWords / avgNumWords);
      page.wordBM25 = words.reduce((acc, w, i) =>
        acc + w.wordIDF * ((k+1) * page['wordFreq'+i] / (page['wordFreq'+i] + k*gain) + d), 0);

      gain = 1 - b + b * (page.numHeads / avgNumHeads);
      page.headBM25 = words.reduce((acc, w, i) =>
        acc + w.headIDF * ((k+1) * page['headFreq'+i] / (page['headFreq'+i] + k*gain)), 0);

      maxWordBM25 = Math.max(maxWordBM25, page.wordBM25);
      maxHeadBM25 = Math.max(maxHeadBM25, page.headBM25);
      maxNumWords = Math.max(maxNumWords, page.numWords);
      maxTotalPosition = Math.max(maxTotalPosition, page.totalPosition);
      maxRefPageRank = Math.max(maxRefPageRank, page.referentPageRank);
      maxPageRank = Math.max(maxPageRank, page.pageRank);
    }

    const w = {
      wbm: 2,
      hbm: 3,
      cnt: 1,
      pos: 1,
      ref: 1.5,
      pr: .5
    };

    for (let page of pages) {
      let wrdBM25Score = maxWordBM25 && page.wordBM25 / maxWordBM25;
      let hdBM25Score = maxHeadBM25 && page.headBM25 / maxHeadBM25;
      let cntScore = page.numWords / maxNumWords;
      let posScore = 1 - page.totalPosition / Math.max(maxTotalPosition, 1);
      let refScore = page.referentPageRank / Math.max(maxRefPageRank, .15);
      let prScore = page.pageRank / maxPageRank;

      page.score = w.wbm * wrdBM25Score
                 + w.hbm * hdBM25Score
                 + w.cnt * cntScore
                 + w.pos * posScore
                 + w.ref * refScore
                 + w.pr  * prScore;

      page.score /= (w.wbm + w.hbm + w.cnt + w.pos + w.ref + w.pr);

      if (this.verbose)
        page.scores = {
          wbm: wrdBM25Score,
          hbm: hdBM25Score,
          cnt: cntScore,
          pos: posScore,
          ref: refScore,
          pr: prScore
        };
    }

    pages.sort((a, b) => b.score - a.score);
  }

  *fetchInfo(pages) {
    let mapper = this.verbose ? (map, page) => map.set(page.pageID, page)
                              : (map, page) => map.set(page.pageID, {score: page.score});
    let map = pages.reduce(mapper, new Map);

    let result = yield this.db.all(`
      select pageid, url, title from indexed join page using (pageid)
      where pageid in (${pages.map(p => p.pageID).join(',')})
    `);

    for (let info of result) {
      let page = map.get(info.pageid);
      page.url = info.url;
      page.title = info.title;
    }

    return map.values();
  }
}
