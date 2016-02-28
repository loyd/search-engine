"use strict";

import yargs from 'yargs';

let argv = yargs
  .usage('Usage: $0 <command> ... (see -h)')
  .demand(1)
  .command('crawl', 'browse WWW and index information', yargs =>
    yargs
    .usage('Usage: $0 crawl [options] <urls...>')
    .demand(2)
    .option('i', {
      alias: 'ignore-nofollow',
      describe: 'ignore rel="nofollow"',
      boolean: true
    })
    .options('m', {
      alias: 'max-depth',
      describe: 'how far the crawler can go',
      number: true,
      default: 3
    })
    .options('l', {
      alias: 'loose',
      describe: 'disable link filtering',
      boolean: true
    })
    .option('t', {
      alias: 'timeout',
      describe: 'a waiting time for a response',
      number: true,
      default: 15,
      defaultDescription: 's'
    })
    .option('r', {
      alias: 'relax-time',
      descibe: 'a waiting time of an empty domain',
      number: true,
      default: 10,
      defaultDescription: 'm'
    })
    .options('s', {
      alias: 'link-stem-limit',
      describe: 'the maximum number of stems per link',
      number: true,
      default: 10
    })
  )
  .command('pagerank', 'precalculate pagerank', yargs =>
    yargs
    .usage('Usage: $0 pagerank [options]')
    .demand(1)
    .option('i', {
      alias: 'iterations',
      describe: 'the number of iterations',
      number: true,
      default: 30
    })
  )
  .command('search', 'request for indexed information', yargs =>
    yargs
    .usage('Usage: $0 search [options] <query>')
    .demand(2)
    .option('l', {
      alias: 'limit',
      describe: 'the number of pages',
      number: true,
      default: 10
    })
    .option('o', {
      alias: 'offset',
      describe: 'the number of skip pages',
      number: true,
      default: 0
    })
    .option('v', {
      alias: 'verbose',
      describe: 'provide more useful info',
      count: true
    })
  )
  .command('server', 'start the web server', yargs =>
    yargs
    .usage('Usage: $0 server [options]')
    .option('p', {
      alias: 'port',
      describe: 'specify the port',
      number: true,
      default: 3000
    })
    .option('l', {
      alias: 'limit',
      describe: 'pages per request limit',
      number: true,
      default: 15
    })
  )
  .option('d', {
    global: true,
    alias: 'database',
    describe: 'specify path to database',
    string: true,
    default: 'se.db'
  })
  .help('h', 'show help')
  .alias('h', 'help')
  .strict()
  .argv;

import Crawler from './crawler';
import PRCalculator from './prcalculator';
import Searcher from './searcher';
import Server from './server';


switch (argv._[0]) {
  case 'crawl': crawl(argv); break;
  case 'pagerank': pagerank(argv); break;
  case 'search': search(argv); break;
  case 'server': server(argv); break;
}

function crawl(argv) {
  let start = Date.now();

  let crawler = new Crawler({
    dbname: argv.database,
    urls: argv._.slice(1),
    ignoreNofollow: argv.ignoreNofollow,
    maxDepth: argv.maxDepth,
    loose: argv.loose,
    relaxTime: argv.relaxTime,
    timeout: argv.timeout,
    linkStemLimit: argv.linkStemLimit
  });

  crawler.on('downloaded', url => update('D', url));
  crawler.on('indexed', url => update('I', url));
  crawler.on('error', ex => console.error(ex.stack));

  process.on('SIGINT', () => crawler.shutdown());
  process.on('exit', onexit);

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

  function onexit() {
    console.log('\n' + '-'.repeat(process.stdout.columns));
    console.log('Downloaded: %d', crawler.downloaded);
    console.log('Indexed: %d', crawler.indexed);
    console.log('Spent: %s', spent(start));
  }

  function spent() {
    let diff = Math.round((Date.now() - start) / 60000);
    let hours = diff / 60 | 0;
    let minutes = diff % 60;
    return hours + ':' + (minutes < 10 ? '0' : '') + minutes;
  }
}

function pagerank(argv) {
  let start = Date.now();
  let calculator = new PRCalculator(argv.database);

  calculator.on('changeState', console.log);
  calculator.calculatePageRank(argv.iterations);
  calculator.on('error', ex => console.error(ex.stack));

  process.on('exit', _ => {
    console.log('-'.repeat(process.stdout.columns));
    console.log('Spent: %s', spent(start));
  });

  function spent() {
    let diff = Math.round((Date.now() - start) / 1000);
    let minutes = diff / 60 | 0;
    let seconds = diff % 60;
    return `${minutes}m ${seconds}s`;
  }
}

function search(argv) {
  let query = argv._.slice(1).join(' ');

  let searcher = new Searcher(argv.database, argv.verbose);
  searcher.search(query, argv.limit, argv.offset)
          .then(handleResult)
          .catch(ex => console.error(ex.stack));

  function handleResult(result) {
    let empty = true;

    for (let page of result) {
      empty = false;

      let [score, title, url] = [Math.round(page.score * 100), page.title, page.url];
      try { url = decodeURI(url); } catch (_) {}

      let str = `[${score}] ${title} | ${url}`;
      if (str.length > process.stdout.columns)
        str = str.slice(0, process.stdout.columns - 3) + '...';

      console.log(str);

      if (argv.verbose > 0) {
        let score = name => page.scores[name].toFixed(2);
        console.log('     scores: wbm=%s hbm=%s cnt=%s pos=%s ref=%s pr=%s',
          score('wbm'), score('hbm'), score('cnt'), score('pos'), score('ref'), score('pr'));
      }

      if (argv.verbose > 1) {
        console.log('     words: %d   heads: %d   total pos: %d   PR: %s   ref PR: %s',
          page.numWords, page.numHeads, page.totalPosition,
          page.pageRank.toFixed(2), page.referentPageRank.toFixed(2));
      }

      if (argv.verbose > 0)
        console.log('');
    }

    if (empty)
      console.log('Ooops! Where is it?');

    console.log('-'.repeat(process.stdout.columns));
    console.log('About %s results (%d seconds)', result.total, result.spent / 1000);
  }
}

function server(argv) {
  let searcher = new Searcher(argv.database);
  let server = new Server(searcher, argv.limit);
  server.listen(argv.port);
}
