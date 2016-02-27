"use strict";

import EventEmitter from 'events';

import co from 'co';

import Downloader from './downloader';
import Extractor from './extractor';
import Indexer from './indexer';


export default class Crawler extends EventEmitter {
  constructor(opts) {
    super();

    console.log(opts);

    this.downloaded = 0;
    this.indexed = 0;

    this.indexer = new Indexer;

    this.downloader = new Downloader(page => this.extractor.extract(page),
                                     opts.maxDepth, opts.loose, opts.relaxTime, opts.timeout);

    this.extractor = new Extractor(urlObj => this.downloader.filter(urlObj),
                                   opts.ignoreNofollow, opts.linkStemLimit);

    this.downloader.on('downloaded', url => {
      ++this.downloaded;
      this.emit('downloaded', decodeURI(url));
    });

    this.downloader.on('error', ex => this.emit('error', ex));

    co.call(this, function*() {
      this.downloader.seed(opts.urls.map(encodeURI));
      yield* this.indexer.connect(opts.dbname);
      yield* this.loop();
    }).catch(ex => this.emit('error', ex));
  }

  *loop() {
    for (;;) {
      let page = yield* this.downloader.dequeue();
      yield* this.indexer.index(page);
      ++this.indexed;
      this.emit('indexed', decodeURI(page.url));
    }
  }

  shutdown() {
    this.downloader.shutdown();
  }
}
