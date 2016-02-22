import co from 'co';
import request from 'request-promise';

import Downloader from '../src/downloader';
import Indexer from '../src/indexer';
import Extractor from '../src/extractor';
import urls from './urls.json';


let downloader, indexer, extractor;

co(function*() {
  let pages;

  downloader = new Downloader(10000);
  extractor = new Extractor;

  console.time('Initialization');
  indexer = yield new Indexer('');
  pages = yield* init(urls);
  console.timeEnd('Initialization');

  console.time('Downloading');
  pages = yield* download(pages);
  console.timeEnd('Downloading');

  console.time('Extracting');
  pages = yield* extract(pages);
  console.timeEnd('Extracting');

  console.time('Indexing');
  yield* index(pages);
  console.timeEnd('Indexing');
}).catch(ex => console.error(ex.stack));

function *init(urls) {
  let pages = yield urls.map(url => indexer.createPageIfUnknown(encodeURI(url)));
  return pages.filter(page => page);
}

function *download(pages) {
  downloader.enqueue(pages);
  let result = [];

  return yield new Promise((resolve, reject) => {
    downloader.on('data', page => {
      result.push(page);
      if (result.length === pages.length)
        resolve(result);
    });

    downloader.on('error', reject);
  });
}

function *extract(pages) {
  for (let page of pages)
    extractor.write(page);

  let result = [];

  return yield new Promise((resolve, reject) => {
    extractor.on('data', page => {
      result.push(page);
      if (result.length === pages.length)
        resolve(result);
    });

    extractor.on('error', reject);
  });
}

function *index(pages) {
  for (let page of pages)
    indexer.write(page);

  let indexed = 0;

  yield new Promise((resolve, reject) => {
    indexer.on('indexed', _ => {
      if (++indexed === pages.length)
        resolve();
    });

    indexer.on('error', reject);
  });
}
