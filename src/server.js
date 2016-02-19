"use strict";

import fs from 'fs';
import path from 'path';

import koa from 'koa';


export default class Server {
  constructor(searcher, limit) {
    let app = this.app = koa();

    app.context.searcher = searcher;
    app.context.limit = limit;

    app.use(this.logger);
    app.use(this.search);
    app.use(this.file);
  }

  listen(port) {
    this.app.listen(port);
  }

  /*
   * Middlewares.
   */

  *logger(next) {
    let start = Date.now();
    yield next;
    let ms = Date.now() - start;
    console.log('%s %s - %sms', this.method, this.url, ms);
  }

  *search(next) {
    if (this.path !== '/search')
      return yield next;

    let query = decodeURIComponent(this.query.q || '');
    let offset = +this.query.o;

    if (!Number.isSafeInteger(offset) || offset < 0)
      offset = 0;

    this.type = 'json';

    let start = Date.now();
    let result = yield this.searcher.search(query, this.limit, offset);
    let spent = Date.now() - start;

    this.body = {
      total: result.total,
      limit: this.limit,
      offset, result, spent
    };
  }

  *file(next) {
    let rpath = this.path === '/' ? '/index.html' : this.path;
    let fpath = path.resolve(__dirname + '/public' + rpath);
    try {
      let fstat = yield done => fs.stat(fpath, done);
      if (fstat.isFile()) {
        this.type = path.extname(fpath);
        this.body = fs.createReadStream(fpath);
      }
    } catch (_) {
      return yield next;
    }
  }
}
