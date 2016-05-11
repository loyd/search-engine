"use strict";

import urllib from 'url';

import {Parser} from 'htmlparser2';
import {Readability} from 'readabilitySAX';
import entities from 'entities';

import Stemmer from './stemmer';
import * as utils from './utils';


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

  setup(pageKey, pageUrl, title, links) {
    // Nesting <a>, <h*> elements is forbidden in HTML. Ignore it.
    this.linkNesting = 0;
    this.headerNesting = 0;

    this.words = new Map;
    this.wordCount = 0;
    this.headCount = 0;
    this.prepareText(title, true);

    this.link = null;
    this.links = new Map;
    this.pageKey = pageKey;
    this.pageUrl = pageUrl;

    for (let link of links)
      this.prepareLink(link);
  }

  prepareText(text, isHeader) {
    let {words} = this;
    let decoded = entities.decodeHTML(text);
    let stemIter = this.stemmer.tokenizeAndStem(decoded);

    for (let stem of stemIter) {
      ++this.wordCount;
      if (isHeader)
        ++this.headCount;

      if (words.has(stem)) {
        let word = words.get(stem);
        ++word.wordCount;
        if (isHeader)
          ++word.headCount;
      } else
        words.set(stem, {position: this.wordCount, wordCount: 1, headCount: +isHeader});
    }
  }

  prepareLink(link) {
    let resolved = urllib.resolve(this.pageUrl, link.href);
    let urlObj = urllib.parse(resolved);

    if (!/^https?:$/.test(urlObj.protocol) || !urlObj.pathname)
      return;

    let key = utils.normalizeUrlObj(urlObj);

    // It's an anchor. Throw out.
    if (key === this.pageKey)
      return;

    if (!this.urlFilter(urlObj))
      return;

    // Don't transfer the link juice to dynamic pages.
    if (urlObj.query)
      link.index = false;

    let stored = this.links.get(key);
    if (!stored) {
      stored = urlObj;
      stored.key = key;
      stored.index = link.index;
      stored.penalty = 0;
      this.links.set(key, stored);
    } else if (link.index)
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
}

export default class Extractor {
  constructor(urlFilter, ignoreNofollow=false, linkStemLimit=10) {
    this.handler = new Handler(ignoreNofollow);
    this.parser = new Parser(this.handler, {recognizeSelfClosing: true});
    this.collector = new InfoCollector(urlFilter, ignoreNofollow, linkStemLimit);
  }

  extract(page) {
    this.parser.parseComplete(page.body);

    let title = entities.decodeHTML(this.handler.getTitle());
    this.collector.setup(page.key, page.url, title, this.handler.links);
    this.handler.getEvents(this.collector);

    page.title = title;
    page.links = [...this.calculatePenalty(this.collector.links)];
    page.words = this.collector.words;
    page.wordCount = this.collector.wordCount;
    page.headCount = this.collector.headCount;
  }

  *calculatePenalty(links) {
    for (let link of links.values()) {
      if (!link.index)
        link.penalty += 8;

      if (!link.stems)
        link.penalty += 8;
      else if (link.stems.length === 0)
        link.penalty += 4;

      yield link;
    }
  }
}
