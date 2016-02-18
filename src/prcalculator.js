"use strict";

import EventEmitter from 'events';

import co from 'co';
import sqlite3 from 'co-sqlite3';


export default class PRCalculator extends EventEmitter {
  constructor(dbname) {
    super();

    this.db = null;
    this.state = null;
    this.guard = co.call(this, function*() {
      this.db = yield sqlite3(dbname);
    });
  }

  calculatePageRank(iterations=20) {
    co.call(this, function*() {
      yield this.guard;

      this.changeState('collecting inbound links');
      yield this.collectInboundLinks();
      this.changeState('collecting initial data');
      yield this.collectInitData();

      for (let i = 0; i < iterations; ++i) {
        this.changeState(`iteration #${i}`);
        yield this.step(i);
      }

      this.changeState('filling index');
      yield this.fillIndex(iterations);

      this.changeState('updating info');
      yield this.updateInfo();

      this.changeState('analyzing tables');
      yield this.analyzeTables();

      this.changeState('done');
    }).catch(ex => this.emit('error', ex));
  }

  collectInboundLinks() {
    return this.db.exec(`
      create temp table inboundlink(
        fromid integer not null,
        toid   integer not null,
        primary key(toid, fromid)
      ) without rowid;

      insert into inboundlink
      select fromid, toid
      from indexed ifr, indexed ito join link on fromid = ifr.pageid and toid = ito.pageid;
    `);
  }

  collectInitData() {
    return this.db.exec(`
      create index fromididx on inboundlink(fromid);

      ${this.prTemplate(0)};
      ${this.prTemplate(1)};

      insert into pr0
      select pageid, count(toid), 1.
      from indexed left join inboundlink on pageid = fromid
      group by pageid;
    `);
  }

  step(i) {
    let [src, dst] = [`pr${i % 2}`, `pr${(i+1) % 2}`];

    return this.db.exec(`
      delete from ${dst};

      insert into ${dst}
      select ${src}.pageid, ${src}.linkcount, .15 + .85 * total(fr.pagerank / fr.linkcount)
      from ${src} left join inboundlink on ${src}.pageid = toid
                  left join ${src} fr on fr.pageid = fromid
      group by ${src}.pageid;
    `);
  }

  fillIndex(iterations) {
    let src = `pr${iterations % 2}`;
    return this.db.run(`
      update indexed set pagerank = (
        select pagerank from ${src} where pageid = indexed.pageid
      )
    `);
  }

  updateInfo() {
    return this.db.exec(`
      delete from info;
      insert into info select count(*), avg(wordcount) from indexed;
    `);
  }

  analyzeTables() {
    return this.db.run('analyze');
  }

  prTemplate(i) {
    return `
      create temp table pr${i}(
        pageid    integer not null primary key,
        linkcount integer not null,
        pagerank  real    not null
      ) without rowid
    `;
  }

  changeState(state) {
    this.state = state;
    this.emit('changeState', state);
  }
}
