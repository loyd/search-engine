"use strict";

import co from 'co';
import EventEmitter from 'events';

import Downloader from './downloader';
import Extractor from './extractor';
import Indexer from './indexer';


export default class Crawler extends EventEmitter {
  constructor(opts) {
    super();

    let {dbname, urls, ignoreNofollow, timeout} = opts;

    this.indexed = 0;
    this.downloaded = 0;

    let onerror = ex => this.emit('error', ex);

    co.call(this, function*() {
      let indexer = this.indexer = yield new Indexer(dbname);

      indexer.on('error', onerror);
      indexer.on('indexed', (page, derived) => {
        ++this.indexed;
        this.emit('indexed', decodeURI(page.url));
        downloader.enqueue(derived);
      });

      let extractor = this.extractor = new Extractor(ignoreNofollow);
      extractor.on('error', onerror);

      let downloader = this.downloader = new Downloader(timeout);
      downloader.on('error', onerror);
      downloader.on('downloaded', page => {
        ++this.downloaded;
        this.emit('downloaded', decodeURI(page.url));
      });

      let pages = yield urls.map(url => indexer.createPageIfUnknown(encodeURI(url)));
      pages = pages.filter(page => page);

      downloader.enqueue(pages);
      downloader.pipe(extractor).pipe(indexer);
    }).catch(onerror);
  }

  shutdown() {
    this.downloader.shutdown();
  }
}
