"use strict";

import {Transform} from 'stream';

import {Parser} from 'htmlparser2';
import {Readability} from 'readabilitySAX';


class Handler extends Readability {
  constructor(ignoreNofollow) {
    super({searchFurtherPages: false});

    this.nofollow = !ignoreNofollow;

    // Nesting <a> element is forbidden in HTML(5). Ignore it.
    this.nested = 0;
    this.links = [];
    this.link = null;
  }

  onopentag(name, attribs) {
    if (name === 'a')
      if (this.nested++ === 0) {
        let href, rel;

        for (let [name, value] of this.attribs(attribs))
          if (name === 'href')
            href = value;
          else if (name === 'rel')
            rel = value;

        if (href) {
          let nofollow = this.nofollow && !!rel && rel.toLowerCase().indexOf('nofollow') !== -1;
          this.link = {href, text: '', nofollow};
        }
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

  *attribs(attribs) {
    for (let name in attribs)
      yield [name.toLowerCase(), attribs[name]];
  }
}

export default class Extractor extends Transform {
  constructor(ignoreNofollow=false) {
    super({objectMode: true});

    this.handler = new Handler(ignoreNofollow);
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
