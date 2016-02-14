"use strict";

import {Transform} from 'stream';

import {Parser} from 'htmlparser2';
import {Readability} from 'readabilitySAX';


class Handler extends Readability {
  constructor() {
    super({searchFurtherPages: false});

    // Nesting <a> element is forbidden in HTML(5). Ignore it.
    this.nested = 0;
    this.links = [];
    this.link = null;
  }

  onopentag(name, attribs) {
    if (name === 'a')
      if (this.nested++ === 0) {
        let href = attribs.href || this.findHref(attribs);
        if (href)
          this.link = {href, text: ''};
      }

      super.onopentag && super.onopentag(name, attribs);
  }

  ontext(text) {
    if (this.nested && this.link)
      this.link.text += text + ' ';

    super.ontext(text);
  }

  onclosetag(name) {
    if (name === 'a') {
      if (this.nested === 1 && this.link) {
        this.links.push(this.link);
        this.link = null;
      }

      this.nested = Math.max(this.nested - 1, 0);
    }

    super.onclosetag(name);
  }

  onreset() {
    this.nested = 0;
    this.links.length = 0;
    this.link = null;

    super.onreset();
  }

  findHref(attribs) {
    for (let name of Object.keys(attribs))
      if (name.toLowerCase() === 'href')
        return attribs[name];
  }
}

export default class Extractor extends Transform {
  constructor() {
    super({objectMode: true});

    this.handler = new Handler;
    this.parser = new Parser(this.handler);
  }

  _transform(page, _, cb) {
    try {
      this.parser.parseComplete(page.body);
    } catch (ex) {
      return cb(ex);
    }

    page.title = this.handler.getTitle();
    page.content = this.handler.getText();
    page.links = this.handler.links;

    cb(null, page);
  }
}
