"use strict";

import {Transform} from 'stream';

import {Parser} from 'htmlparser2';
import {Readability} from 'readabilitySAX';


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

        this.links.push(nofollow ? {href, nofollow} : {href});
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
  constructor(ignoreNofollow) {
    this.nofollow = !ignoreNofollow;
    this.reset();
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

        this.link = {href, text: ''};
      }
    } else if (this.isHeader(name))
      ++this.headerNesting;
  }

  ontext(text) {
    if (this.linkNesting && this.link)
      this.link.text += text + ' ';

    if (this.headerNesting)
      this.headers += text + ' ';

    this.content += text + ' ';
  }

  onclosetag(name) {
    if (name === 'a') {
      if (this.linkNesting === 1 && this.link) {
        this.links.push(this.link);
        this.link = null;
      }

      this.linkNesting = Math.max(this.linkNesting - 1, 0);
    } else if (this.isHeader(name))
      this.headerNesting = Math.max(this.headerNesting - 1, 0);
  }

  reset() {
    // Nesting <a>, <h*> elements is forbidden in HTML. Ignore it.
    this.linkNesting = 0;
    this.headerNesting = 0;

    this.links = [];
    this.link = null;
    this.content = '';
    this.headers = '';
  }

  isHeader(name) {
    return name.length === 2 && name[0] === 'h';
  }
}

export default class Extractor extends Transform {
  constructor(ignoreNofollow=false) {
    super({objectMode: true});

    this.handler = new Handler(ignoreNofollow);
    this.parser = new Parser(this.handler);
    this.collector = new InfoCollector(ignoreNofollow);
  }

  _transform(page, _, cb) {
    this.collector.reset();
    this.parser.parseComplete(page.body);
    this.handler.getEvents(this.collector);

    let links = this.handler.links;
    links.push(...this.collector.links);

    page.title = this.handler.getTitle();
    page.content = this.collector.content;
    page.headers = this.collector.headers;
    page.links = links;

    cb(null, page);
  }
}
