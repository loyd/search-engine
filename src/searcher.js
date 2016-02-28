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
      join indexed idx using (pageid)
      left join linkword lw on idx.pageid = toid and lw.wordid in (${wordIDs.join(', ')})
      left join indexed fromidx on fromidx.pageid = fromid

      where ${where}
      group by l0.pageid
    `;

    return yield this.db.all(fullQuery);
  }

  rankPages(pages, words) {
    if (pages.length === 0)
      return;

    let {numIndexed, avgNumWords, avgNumHeads} = this.info;

    for (let word of words) {
      word.wordIDF = Math.max(Math.log((numIndexed - word.numPages) / word.numPages), 0);
      word.headIDF = word.numHeads &&
        Math.max(Math.log((numIndexed - word.numHeads) / word.numHeads), 0);
    }

    let values = {
      wordBM25: [],
      headBM25: [],
      numWords: [],
      totalPosition: [],
      refPageRank: [],
      pageRank: []
    };

    const [k, b] = [1.5, .15];

    for (let page of pages) {
      let gain = 1 - b + b * (page.numWords / avgNumWords);
      page.wordBM25 = words.reduce((acc, w, i) =>
        acc + w.wordIDF * (k+1) * page['wordFreq'+i] / (page['wordFreq'+i] + k*gain), 0);

      gain = 1 - b + b * (page.numHeads / avgNumHeads);
      page.headBM25 = words.reduce((acc, w, i) =>
        acc + w.headIDF * (k+1) * page['headFreq'+i] / (page['headFreq'+i] + k*gain), 0);

      if (page.wordBM25 > 0)
        values.wordBM25.push(page.wordBM25);

      if (page.headBM25 > 0)
        values.headBM25.push(page.headBM25);

      values.numWords.push(page.numWords);
      values.totalPosition.push(page.totalPosition);

      if (page.referentPageRank > 0)
        values.refPageRank.push(page.referentPageRank);

      values.pageRank.push(page.pageRank);
    }

    for (let name in values)
      values[name] = this.iqrRange(values[name]);

    const w = {wbm: 4, hbm: 6, cnt: 3, pos: 2, ref: 4, pr: 2};

    for (let page of pages) {
      let wrdBM25Score = this.normalize(page.wordBM25, values.wordBM25);
      let hdBM25Score = this.normalize(page.headBM25, values.headBM25);
      let cntScore = this.normalize(page.numWords, values.numWords);
      let posScore = this.normalize(page.totalPosition, values.totalPosition, true);
      let refScore = this.normalize(page.referentPageRank, values.refPageRank);
      let prScore = this.normalize(page.pageRank, values.pageRank);

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

  iqrRange(values) {
    if (values.length === 0)
      return null;

    values.sort((a, b) => a - b);
    let {length} = values;

    let q1 = values[Math.floor(length / 4)];
    let q3 = values[Math.min(Math.ceil(length * 3 / 4), length - 1)];

    let iqr = q3 - q1;

    let min = Math.max(q1 - iqr * 1.5, values[0]);
    let max = Math.min(q3 + iqr * 1.5, values[length-1]);
    let len = max - min;

    return {min, max, len};
  }

  normalize(value, range, inv=false) {
    if (!range)
      return 0;

    if (range.len === 0)
      return 1;

    value = (value - range.min) / range.len;
    let clamped = Math.max(0, Math.min(value, 1));
    return inv ? 1 - clamped : clamped;
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
