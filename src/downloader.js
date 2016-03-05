"use strict";

import EventEmitter from 'events';
import urllib from 'url';
import dns from 'dns';

import co from 'co';
import request from 'request';
import PriorityQueue from 'priorityqueuejs';
import {BloomFilter} from 'bloomfilter';

import * as robotstxt from './robotstxt';
import * as utils from './utils';


const reAlienUrlChar = /[^\x00-\xFFа-яА-ЯёЁ]/g;

export default class Downloader extends EventEmitter {
  static domainComparator(a, b) {
    return b.wakeUp - a.wakeUp;
  }

  static pageComparator(a, b) {
    return a.depth === b.depth ? b.penalty - a.penalty : b.depth - a.depth;
  }

  static calcBloomParams(count, prob) {
    let m = Math.ceil(-count * Math.log(prob)/Math.LN2/Math.LN2);
    let k = Math.round(Math.LN2 * m / count);
    return [m, k];
  }

  constructor(extract, maxDepth=4, timeout=15, maxSize=16, looseFilter=false,
                       relaxTime=10, highWaterMark=64) {
    super();

    this.maxDepth = maxDepth;
    this.timeout = timeout * 1000;
    this.maxSize = maxSize * 1024 * 1024;
    this.looseFilter = looseFilter;
    this.relaxTime = relaxTime * 60 * 1000;
    this.highWaterMark = highWaterMark;

    this.extract = extract;

    this.domains = new PriorityQueue(Downloader.domainComparator);
    this.domainCache = new Map;

    let approxUrlCount = Math.min(Math.pow(256, maxDepth - 1), 1e7);
    this.knownUrlSet = new BloomFilter(...Downloader.calcBloomParams(approxUrlCount, 0.00001));

    this.queue = [];
    this.waiter = null;
  }

  *dequeue() {
    if (this.queue.length) {
      this.schedule(this.highWaterMark - this.queue.length + 1);
      return this.queue.shift();
    }

    this.schedule(this.highWaterMark);
    return yield new Promise(resolve => this.waiter = resolve);
  }

  enqueue(page) {
    if (this.waiter) {
      this.waiter(page);
      this.waiter = null;
    } else
      this.queue.push(page);
  }

  shutdown() {
    this.highWaterMark = -Infinity;
  }

  markAsKnown(url) {
    this.knownUrlSet.add(utils.urlToKey(url));
  }

  seed(urls) {
    let links = [];

    for (let url of urls) {
      let normalized = utils.normalizeUrl(url);
      let urlObj = urllib.parse(normalized);

      if (!this.filter(urlObj))
        continue;

      urlObj.key = utils.urlObjToKey(urlObj);
      urlObj.index = true;
      urlObj.penalty = 0;

      links.push(urlObj);
    }

    this.collect({links, penalty: 0, depth: 0});
  }

  filter(urlObj) {
    if (!this.guessRelevant(urlObj))
      return false;

    if (this.domainCache.has(urlObj.host)) {
      let domain = this.domainCache.get(urlObj.host);
      if (domain.rules && robotstxt.isDisallowed(domain.rules, urlObj.pathname))
        return false;
    }

    return true;
  }

  collect(source) {
    if (source.depth >= this.maxDepth)
      return;

    for (let link of source.links) {
      if (this.knownUrlSet.test(link.key))
        return false;

      let page = {
        pathname: link.pathname,
        penalty: source.penalty + link.penalty,
        depth: source.depth + 1
      };

      let domain = this.domainCache.get(link.host);
      if (domain) {
        let secure = link.protocol === 'https:';
        if (secure !== domain.secure)
          page.secure = secure;
      } else
        domain = this.createDomain(link);

      domain.pages.enq(page);
      this.knownUrlSet.add(link.key);
    }
  }

  createDomain(link) {
    let domain = {
      host: link.hostname,
      secure: link.protocol === 'https:',
      pages: new PriorityQueue(Downloader.pageComparator),
      wakeUp: Date.now()
    };

    if (link.port)
      domain.port = link.port;

    this.domainCache.set(link.host, domain);
    this.domains.enq(domain);

    return domain;
  }

  schedule(n) {
    for (let i = 0; i < n; ++i)
      co.call(this, this.worker).catch(ex => this.emit('error', ex));
  }

  *worker() {
    let {domains} = this;
    let domain = this.seizeDomain();
    if (!domain)
      return;

    --this.highWaterMark;

    if (!domain.address) {
      let ok = yield* this.prepareDomain(domain);
      if (!ok) {
        ++this.highWaterMark;
        return;
      }
    }

    let page = this.seizePage(domain);

    if (page) {
      let protocol = ('secure' in page ? page.secure : domain.secure) ? 'https' : 'http';
      let url = `${protocol}://${domain.address}${page.pathname}`;
      let timestamp = Date.now();
      let response = yield* this.download(url, domain.host);

      if (response) {
        let url = `${protocol}://${domain.host}${page.pathname}`;
        this.emit('downloaded', url);

        if (this.isAcceptable(response.headers)) {
          page.url = url;
          page.body = response.body;
          this.process(page);
        }
      }

      if ('delay' in domain)
        domain.wakeUp = timestamp + domain.delay;
      else if (response)
        domain.wakeUp = timestamp + 2*response.elapsedTime;
      else
        //#TODO: depend on the status code.
        domain.wakeUp = Date.now();
    }

    if (domain.pages.isEmpty())
      domain.wakeUp = Date.now() + this.relaxTime;

    ++this.highWaterMark;
    this.domains.enq(domain);
  }

  seizeDomain() {
    let domain = null;

    while (!(domain || this.domains.isEmpty())) {
      domain = this.domains.deq();

      if (domain.pages.isEmpty()) {
        // Time is up.
        let ok = this.domainCache.delete(domain.host);
        console.assert(ok);
        domain = null;
      }
    }

    return domain;
  }

  *prepareDomain(domain) {
    yield* this.fetchAddress(domain);

    if (!domain.address)
      return false;

    yield* this.fetchRobotstxt(domain);
    return true;
  }

  seizePage(domain) {
    let page = null;

    while (!(page || domain.pages.isEmpty())) {
      page = domain.pages.deq();

      if (domain.rules && robotstxt.isDisallowed(domain.rules, page.pathname))
        page = null;
    }

    return page;
  }

  process(page) {
    this.extract(page);
    this.enqueue(page);
    this.collect(page);
  }

  *fetchAddress(domain) {
    let address = yield* this.lookup(domain.host);
    if (!address)
      return;

    if (domain.port) {
      domain.host += ':' + domain.port;
      address += ':' + domain.port;
      delete domain.port;
    }

    domain.address = address;
  }

  *fetchRobotstxt(domain) {
    let protocol = domain.secure ? 'https:' : 'http:';
    let response = yield* this.download(`${protocol}//${domain.address}/robots.txt`, domain.host);

    if (response) {
      let {rules, crawlDelay} = robotstxt.parse(response.body);
      domain.rules = rules;
      if (crawlDelay)
        domain.delay = crawlDelay * 1000;
    } else
      domain.rules = [];
  }

  *lookup(hostname) {
    try {
      return yield cb => dns.lookup(hostname, (err, addr, _) => cb(err, addr));
    } catch (_) {}
  }

  *download(url, host) {
    let opts = {
      url,
      headers: {
        'host': host,
        'accept': "application/xml,application/xhtml+xml,text/html;q=0.9,text/plain;q=0.8",
        'accept-language': 'ru, en;q=0.8',
        'accept-charset': 'utf-8',
        'user-agent': 'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_4; en-US) ' +
                      'AppleWebKit/534.7 (KHTML, like Gecko) Chrome/7.0.517.41 Safari/534.7',
      },
      gzip: true,
      strictSSL: false,
      timeout: this.timeout,
      time: true
    };

    let received = 0;

    return yield new Promise(resolve => {
      let req = request(opts, (err, response) => {
        if (err)
          return resolve(null);

        if (200 <= response.statusCode && response.statusCode < 300)
          return resolve(response);

        return resolve(null);
      })
      .setMaxListeners(64 /* Shut up! */)
      .on('data', chunk => {
        received += chunk.length;
        if (received > this.maxSize) {
          req.abort();
          resolve(null);
        }
      });
    });
  }

  isAcceptable(headers) {
    let acceptType = (headers['content-type'] || '').indexOf('html') !== -1;
    let acceptLang = /en|ru/i.test(headers['content-language'] || 'en');

    return acceptType && acceptLang;
  }

  guessRelevant(urlObj) {
    if (this.looseFilter)
      return true;

    let decodedPath = urlObj.pathname;
    try { decodedPath = decodeURI(decodedPath); } catch (_) {}

    let match = decodedPath.match(reAlienUrlChar);
    if (match && match.length > 2)
      return false;

    //#TODO: what about blacklist?
    let h = urlObj.host;
    if (h.startsWith('git.') || h.startsWith('svn.') || h.startsWith('hg.'))
      return false;

    let p = urlObj.pathname;
    let i = p.lastIndexOf('.');

    // No extension or unlikely.
    if (i === -1 || p.length - i > 6)
      return true;

    let ext = p.slice(i+1).toLowerCase();
    switch (ext) {
      case 'html': case 'php': case 'asp': case 'aspx': case 'htm': case 'xhtml': case 'stm':
      case 'phtml': case 'php3': case 'php4': case 'php5': case 'phps': case 'xht': case 'adp':
      case 'bml': case 'cfm': case 'cgi': case 'ihtml': case 'jsp': case 'las': case 'lasso':
      case 'pl': case 'rna': case 'r': case 'rnx': case 'shtml':
        return true;
    }

    return false;
  }
}
