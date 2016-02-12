"use strict";

import co from 'co';
import sqlite3 from 'co-sqlite3';
import {OPEN_READONLY} from 'sqlite3';

import Stemmer from './stemmer';


export default class Searcher {
  constructor(dbname) {
    this.db = null;

    this.stemmer = new Stemmer;

    return co.call(this, function*() {
      this.db = yield sqlite3(dbname, OPEN_READONLY);
      return this;
    });
  }

  *search(query) {
    let words = yield* this.matchWords(query);
    let pages = yield* this.pickPages(words);

    let [maxCount, maxLocation, maxDistance] = [1, 1, 1];

    for (let page of pages) {
      maxCount = Math.max(maxCount, page.count);
      maxLocation = Math.max(maxLocation, page.location);
      maxDistance = Math.max(maxDistance, page.distance);
    }

    const cntWeight = 1;
    const locWeight = 1;
    const distWeight = .5;
    const sumWeights = cntWeight + locWeight + distWeight;

    let scores = [];

    for (let page of pages) {
      let cntScore = page.count / maxCount;
      let locScore = 1 - page.location / maxLocation;
      let distScore = 1 - page.distance / maxDistance;

      let score = (cntWeight*cntScore +  locWeight*locScore + distWeight*distScore) / sumWeights;
      scores.push(score);
    }

    let $url = yield this.db.prepare('select url, title from page where rowid = ?');
    let result = yield pages.map(page => $url.get(page.pageid));

    for (let [i, res] of result.entries())
      res.score = scores[i];

    return result.sort((a, b) => b.score - a.score);
  }

  *matchWords(query) {
    let stems = this.stemmer.tokenizeAndStem(query);

    if (stems.length === 0)
      return [];

    let join = stems.map(w => `'${w}'`).join(',');

    return yield this.db.all(`select rowid, count from word where stem in (${join})`);
  }

  *pickPages(words) {
    if (words.length === 0)
      return [];

    words.sort((a, b) => a.count - b.count);

    let [select, from, where, sum, dist] = ['pageid', 'location l0', '', '', ''];

    for (let [i, {rowid}] of words.entries()) {
      if (i > 0) {
        from += ` join location l${i} using (pageid)`;
        where += ' and ';
        sum += ' + ';

        if (i > 1)
          dist += ' + ';

        dist += `abs(l${i}.position - l${i-1}.position)`;
      }

      where += `l${i}.wordid = ${rowid}`;
      sum += `l${i}.position`;
    }

    // For frequency score.
    select += ', count(*) as count';
    // For location score.
    select += `, min(${sum}) as location`;
    // For distance score.
    select += `, min(${dist || '1'}) as distance`;

    let fullQuery = `select ${select}\nfrom ${from}\nwhere ${where}\ngroup by pageid`;
    console.log(fullQuery);

    return yield this.db.all(fullQuery);
  }
}

co(function*() {
  let query = process.argv.slice(2).join(' ');

  let searcher = yield new Searcher('se.db');
  let start = Date.now();
  let result = yield* searcher.search(query);

  console.log('-'.repeat(80));

  if (result.length === 0)
    console.log('Ooops! Where is it?');

  for (let page of result.slice(0, 10))
    console.log('[%s] %s', page.score.toFixed(2), decodeURI(page.url));

  console.log('-'.repeat(80));
  console.log('About %s results (%d seconds)', result.length, (Date.now() - start) / 1000);
}).catch(console.error);
