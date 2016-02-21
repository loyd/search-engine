"use strict";

import {Readable} from 'stream';

import co from 'co';
import request from 'request-promise';
import {RequestError, StatusCodeError} from 'request-promise/errors';


export default class Downloader extends Readable {
  constructor(timeout=5000, highWaterMark=32) {
    super({highWaterMark, objectMode: true});
    this.timeout = timeout;
    this.pages = [];
    this.wait = false;
    this.terminated = false;
  }

  shutdown() {
    this.push(null);
    this.terminated = true;
    this.removeAllListeners('downloaded');
  }

  enqueue(pages) {
    this.pages.push(...pages);

    if (this.wait)
      this.run();
  }

  _read(_) { this.run(); }

  run() {
    this.wait = this.pages.length === 0;
    if (this.wait)
      return;

    co.call(this, function*() {
      let page;
      while (page = this.pages.shift()) {
        let result = yield* this.download(page);

        if (!result || !this.isAcceptable(result.headers))
          continue;

        page.body = result.body;

        if (this.terminated || !this.push(page))
          break;
      }
    }).catch(ex => this.emit('error', ex));
  }

  *download(page) {
    try {
      var result = yield request({
        url: page.url,
        headers: {
          'accept': "application/xml,application/xhtml+xml,text/html;q=0.9,text/plain;q=0.8",
          'accept-language': 'ru, en;q=0.8',
          'accept-charset': 'utf-8',
          'user-agent': 'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_4; en-US) ' +
            'AppleWebKit/534.7 (KHTML, like Gecko) Chrome/7.0.517.41 Safari/534.7',
        },
        gzip: true,
        resolveWithFullResponse: true,
        timeout: this.timeout
      });
    } catch (ex) {
      if (!(ex instanceof RequestError || ex instanceof StatusCodeError))
        throw ex;
    }

    this.emit('downloaded', page);
    return result;
  }

  isAcceptable(headers) {
    let acceptType = (headers['content-type'] || '').indexOf('html') !== -1;
    let acceptLang = /en|ru/i.test(headers['content-language'] || 'en');

    return acceptType && acceptLang;
  }
}
