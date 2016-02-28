"use strict";

import urllib from 'url';
import punycode from 'punycode';

import {Parser} from 'htmlparser2';
import {Readability} from 'readabilitySAX';

import Stemmer from './stemmer';


class Handler extends Readability {
  constructor(ignoreNofollow) {
    super({searchFurtherPages: false});

    this.nofollow = !ignoreNofollow;
    this.links = [];
  }

  onopentag(name, attribs) {
    if (name === 'a') {
      let href = this.findAttr(attribs, 'href');
      if (href) {
        let nofollow;
        if (this.nofollow) {
          let rel = this.findAttr(attribs, 'rel');
          nofollow = rel && ~rel.toLowerCase().indexOf('nofollow');
        }

        this.links.push({href, index: !nofollow});
      }
    }

    super.onopentag && super.onopentag(name, attribs);
  }

  onreset() {
    this.links = [];
    super.onreset();
  }

  findAttr(attribs, name) {
    if (name in attribs)
      return attribs[name];

    name = Object.keys(attribs).find(a => a.toLowerCase() === name);
    return name && attribs[name];
  }
}

const reDupSlashes = /\/{2,}/g;

class InfoCollector {
  constructor(urlFilter, ignoreNofollow, linkStemLimit) {
    this.urlFilter = urlFilter;
    this.nofollow = !ignoreNofollow;
    this.linkStemLimit = linkStemLimit;
    this.stemmer = new Stemmer;
  }

  onopentag(name, attribs) {
    if (name === 'a') {
      if (this.linkNesting++ === 0) {
        let {href, rel} = attribs;
        if (!href)
          return;

        let nofollow = this.nofollow && rel && ~rel.toLowerCase().indexOf('nofollow');
        if (nofollow)
          return;

        this.link = {href, index: true, text: ''};
      }
    } else if (this.isHeader(name))
      ++this.headerNesting;
  }

  ontext(text) {
    if (this.linkNesting && this.link)
      this.link.text += text + ' ';

    this.prepareText(text, !!this.headerNesting);
  }

  onclosetag(name) {
    if (name === 'a') {
      if (this.linkNesting === 1 && this.link) {
        this.prepareLink(this.link);
        this.link = null;
      }

      this.linkNesting = Math.max(this.linkNesting - 1, 0);
    } else if (this.isHeader(name))
      this.headerNesting = Math.max(this.headerNesting - 1, 0);
  }

  isHeader(name) {
    return name.length === 2 && name[0] === 'h';
  }

  setup(pageUrl, title, links) {
    // Nesting <a>, <h*> elements is forbidden in HTML. Ignore it.
    this.linkNesting = 0;
    this.headerNesting = 0;

    this.words = new Map;
    this.numWords = 0;
    this.numHeads = 0;
    this.prepareText(title, true);

    this.link = null;
    this.links = new Map;
    this.pageUrl = pageUrl;
    this.pageLowerUrl = pageUrl.toLowerCase();

    for (let link of links)
      this.prepareLink(link);
  }

  prepareText(text, isHeader) {
    let {words} = this;
    let stemIter = this.stemmer.tokenizeAndStem(text);

    for (let stem of stemIter) {
      ++this.numWords;
      if (isHeader)
        ++this.numHeads;

      if (words.has(stem)) {
        let word = words.get(stem);
        ++word.numWords;
        if (isHeader)
          ++word.numHeads;
      } else
        words.set(stem, {position: this.numWords, numWords: 1, numHeads: +isHeader});
    }
  }

  prepareLink(link) {
    let resolved = urllib.resolve(this.pageUrl, this.normalizeUrl(link.href));
    let urlObj = urllib.parse(resolved);

    let url = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
    let lowerUrl = url.toLowerCase();

    // It's an anchor. Throw out.
    if (lowerUrl === this.pageLowerUrl)
      return;

    if (!this.urlFilter(urlObj))
      return;

    // Don't transfer the link juice to dynamic pages.
    if (urlObj.query)
      link.index = false;

    let stored = this.links.get(lowerUrl);
    if (!stored)
      this.links.set(lowerUrl, stored = {
        url,
        protocol: urlObj.protocol,
        host: urlObj.host,
        path: urlObj.pathname,
        index: link.index,
        penalty: 0
      });
    else if (link.index)
      stored.index = true;

    // Collect unique stems from the text.
    if (link.index && link.text) {
      let stemIter = this.stemmer.tokenizeAndStem(link.text);
      let stems = stored.stems = stored.stems || [];

      for (let stem of stemIter)
        if (stems.indexOf(stem) === -1) {
          stems.push(stem);
          if (stems.length >= this.linkStemLimit)
            break;
        }
    }
  }

  normalizeUrl(url) {
    url = url.trim();

    let shorthand = url.startsWith('//');
    let urlObj = urllib.parse(shorthand ? `http:${url}` : url);

    delete urlObj.host;
    delete urlObj.query;
    delete urlObj.hash;

    // Remove default port.
    if (urlObj.port) {
      if (urlObj.protocol === 'http:' && +urlObj.port === 80)
        delete urlObj.port;
      else if (urlObj.protocol === 'https:' && +urlObj.port === 443)
        delete urlObj.port;
    }

    // Replace duplicate slashes.
    if (urlObj.pathname)
      urlObj.pathname = urlObj.pathname.replace(reDupSlashes, '/');

    // IDN to unicode and remove "www.".
    if (urlObj.hostname) {
      let hostname = punycode.toUnicode(urlObj.hostname);
      if (hostname.startsWith('www.'))
        hostname = hostname.slice(4);

      urlObj.hostname = hostname;
    }

    url = urllib.format(urlObj);

    // Remove ending "/".
    if (url.endsWith('/'))
      url = url.slice(0, -1);

    // Restore relative protocol.
    if (shorthand)
      url = url.slice(5);

    return url;
  }
}

export default class Extractor {
  constructor(urlFilter, ignoreNofollow=false, linkStemLimit=10) {
    this.handler = new Handler(ignoreNofollow);
    this.parser = new Parser(this.handler);
    this.collector = new InfoCollector(urlFilter, ignoreNofollow, linkStemLimit);
  }

  extract(page) {
    this.parser.parseComplete(page.body);

    let title = this.handler.getTitle();
    this.collector.setup(page.url, title, this.handler.links);
    this.handler.getEvents(this.collector);

    page.title = title;
    page.links = this.calculatePenalty(this.collector.links);
    page.words = this.collector.words;
    page.numWords = this.collector.numWords;
    page.numHeads = this.collector.numHeads;
  }

  *calculatePenalty(links) {
    for (let link of links.values()) {
      if (!link.indexed)
        link.penalty += 8;

      if (!link.stems)
        link.penalty += 8;
      else if (link.stems.length === 0)
        link.penalty += 4;

      yield link;
    }
  }
}
