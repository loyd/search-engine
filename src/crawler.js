"use strict";

import EventEmitter from 'events';

import co from 'co';

import Downloader from './downloader';
import Extractor from './extractor';
import Indexer from './indexer';


export default class Crawler extends EventEmitter {
  constructor(opts) {
    super();

    this.downloaded = 0;
    this.indexed = 0;

    this.indexer = new Indexer;

    this.downloader = new Downloader(page => this.extractor.extract(page),
                                     opts.maxDepth, opts.timeout, opts.maxSize,
                                     opts.looseFilter, opts.relaxTime);

    this.extractor = new Extractor(urlObj => this.downloader.filter(urlObj),
                                   opts.ignoreNofollow, opts.linkStemLimit);

    this.downloader.on('downloaded', url => {
      ++this.downloaded;
      this.emit('downloaded', this.decodeURI(url), this.downloader.domains.size());
    });

    this.downloader.on('error', ex => this.emit('error', ex));

    co.call(this, function*() {
      yield* this.indexer.connect(opts.dbname);
      yield* this.indexer.each(url => this.downloader.markAsKnown(url));
      this.downloader.seed(opts.urls.map(encodeURI));
      yield* this.loop();
    }).catch(ex => this.emit('error', ex));
  }

  *loop() {
    for (;;) {
      let page = yield* this.downloader.dequeue();
      yield* this.indexer.index(page);
      ++this.indexed;
      this.emit('indexed', this.decodeURI(page.url), this.downloader.domains.size());
    }
  }

  shutdown() {
    this.downloader.shutdown();
  }

  decodeURI(url) {
    try {
      return decodeURI(url);
    } catch (_) {
      return url;
    }
  }
}
