"use strict";

import Crawler from './crawler';


let crawler = new Crawler({
  dbname: 'se.db',
  urls: ['https://ru.wikipedia.org/wiki/Программирование']
});

crawler.on('error', console.error);
crawler.on('downloaded', url => update('D', url));
crawler.on('indexed', url => update('I', url));

let start = Date.now();

function update(act, url) {
  let down = crawler.downloaded;
  let idx = crawler.indexed;
  let spnt = spent(start);

  let str = `D: ${down}   I: ${idx}   S: ${spnt}   [${act}] ${url}`;

  if (str.length > process.stdout.columns)
    str = str.slice(0, process.stdout.columns - 3) + '...';

  process.stdout.cursorTo(0);
  process.stdout.write(str);
  process.stdout.clearLine(1);
}

function spent(start) {
  let diff = Math.round((Date.now() - start) / 60000);
  let hours = diff / 60 | 0;
  let minutes = diff % 60;
  return hours + ':' + (minutes < 10 ? '0' : '') + minutes;
}

function onexit() {
  console.log('\n' + '-'.repeat(process.stdout.columns));
  console.log('Downloaded: %d', crawler.downloaded);
  console.log('Indexed: %d', crawler.indexed);
  console.log('Spent: %s', spent(start));
}

process.on('SIGINT', () => crawler.shutdown());
process.on('exit', onexit);
