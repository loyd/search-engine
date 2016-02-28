"use strict";

import EventEmitter from 'events';
import urllib from 'url';

import co from 'co';
import request from 'request-promise';
import {RequestError, StatusCodeError} from 'request-promise/errors';
import PriorityQueue from 'fastpriorityqueue';
import {BloomFilter} from 'bloomfilter';

import * as robotstxt from './robotstxt';


const reAlienUrlChar = /[^\x00-\xFFа-яА-ЯёЁ]/g;

export default class Downloader extends EventEmitter {
  static domainComparator(a, b) {
    return a.wakeUp < b.wakeUp;
  }

  static pageComparator(a, b) {
    return a.depth === b.depth ? a.penalty < b.penalty : a.depth < b.depth;
  }

  static calcBloomParams(count, prob) {
    let m = Math.ceil(-count * Math.log(prob)/Math.LN2/Math.LN2);
    let k = Math.round(Math.LN2 * m / count);
    return [m, k];
  }

  constructor(extract, maxDepth=3, loose=false, relaxTime=10, timeout=15, highWaterMark=64) {
    super();

    this.maxDepth = maxDepth;
    this.loose = loose;
    this.relaxTime = relaxTime * 60 * 1000;
    this.timeout = timeout * 1000;
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
    this.knownUrlSet.add(url.toLowerCase());
  }

  seed(urls) {
    let links = [];

    for (let url of urls) {
      let urlObj = urllib.parse(url);

      if (!this.filter(urlObj))
        continue;

      links.push({
        url: `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`,
        protocol: urlObj.protocol,
        host: urlObj.host,
        path: urlObj.pathname,
        index: true,
        penalty: 0
      });
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
      let lowerUrl = link.url.toLowerCase();

      if (this.knownUrlSet.test(lowerUrl))
        return false;

      let secure = link.protocol === 'https:';
      let domain = this.domainCache.get(link.host) || this.createDomain(link.host, secure);

      let page = {
        path: link.path,
        penalty: source.penalty + link.penalty,
        depth: source.depth + 1
      };

      if (secure !== domain.secure)
        page.secure = secure;

      domain.pages.add(page);
      this.knownUrlSet.add(lowerUrl);
    }
  }

  createDomain(host, secure) {
    let domain = {
      host, secure,
      pages: new PriorityQueue(Downloader.pageComparator),
      wakeUp: Date.now()
    };

    this.domainCache.set(host, domain);
    this.domains.add(domain);

    return domain;
  }

  schedule(n) {
    for (let i = 0; i < n; ++i)
      co.call(this, this.worker).catch(ex => this.emit('error', ex));
  }

  *worker() {
    let {domains} = this;
    let domain = this.acquireDomain();
    if (!domain)
      return;

    if (!domain.rules)
      yield* this.fetchRobotstxt(domain);

    let page = this.seizePage(domain);

    if (page) {
      let protocol = ('secure' in page ? page.secure : domain.secure) ? 'https' : 'http';
      let url = `${protocol}://${domain.host}${page.path}`;
      let timestamp = Date.now();
      let response = yield* this.download(url);
      this.emit('downloaded', url);

      if (response && this.isAcceptable(response.headers)) {
        page.url = url;
        page.body = response.body;
        this.process(page);
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

    this.releaseDomain(domain);
  }

  acquireDomain() {
    let domain = null;

    while (!(domain || this.domains.isEmpty())) {
      domain = this.domains.poll();

      if (domain.pages.isEmpty()) {
        // Time is up.
        let ok = this.domainCache.delete(domain.host);
        console.assert(ok);
        domain = null;
      }
    }

    if (domain)
      --this.highWaterMark;

    return domain;
  }

  releaseDomain(domain) {
    this.domains.add(domain);
    ++this.highWaterMark;
  }

  seizePage(domain) {
    let page = null;

    while (!(page || domain.pages.isEmpty())) {
      page = domain.pages.poll();

      if (domain.rules && robotstxt.isDisallowed(domain.rules, page.path))
        page = null;
    }

    return page;
  }

  process(page) {
    this.extract(page);
    this.enqueue(page);
    this.collect(page);
  }

  *fetchRobotstxt(domain) {
    let protocol = domain.secure ? 'https:' : 'http:';
    let response = yield* this.download(`${protocol}//${domain.host}/robots.txt`);

    if (response) {
      let {rules, crawlDelay} = robotstxt.parse(response.body);
      domain.rules = rules;
      if (crawlDelay)
        domain.delay = crawlDelay * 1000;
    } else
      domain.rules = [];
  }

  *download(url) {
    let response = null;

    try {
      response = yield request({
        url,
        headers: {
          'accept': "application/xml,application/xhtml+xml,text/html;q=0.9,text/plain;q=0.8",
          'accept-language': 'ru, en;q=0.8',
          'accept-charset': 'utf-8',
          'user-agent': 'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_4; en-US) ' +
                        'AppleWebKit/534.7 (KHTML, like Gecko) Chrome/7.0.517.41 Safari/534.7',
        },
        gzip: true,
        resolveWithFullResponse: true,
        timeout: this.timeout,
        time: true
      });
    } catch (ex) {
      if (~url.indexOf('wikipedia') && url.endsWith('robots.txt')) {
        console.error(ex);
        process.exit(0);
      }
      if (!(ex instanceof RequestError || ex instanceof StatusCodeError))
        throw ex;
    }

    return response;
  }

  isAcceptable(headers) {
    let acceptType = (headers['content-type'] || '').indexOf('html') !== -1;
    let acceptLang = /en|ru/i.test(headers['content-language'] || 'en');

    return acceptType && acceptLang;
  }

  guessRelevant(urlObj) {
    if (!urlObj.protocol.startsWith('http'))
      return false;

    if (this.loose)
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
