"use strict";

import urllib from 'url';
import punycode from 'punycode';


export function normalizeUrlObj(urlObj) {
  let [hostname, port, pathname] = ['', '', ''];

  if (urlObj.hostname) {
    hostname = punycode
      // IDN to unicode.
      .toUnicode(urlObj.hostname)
      // Remove `www.`.
      .replace(/^www./, '');
  }

  if (urlObj.port) {
    // Remove default port.
    if (!(urlObj.protocol === 'http:'  && +urlObj.port === 80 ||
          urlObj.protocol === 'https:' && +urlObj.port === 443))
      port = ':' + urlObj.port;
  }

  if (urlObj.pathname) {
    pathname = urlObj.pathname
      .toLowerCase()
      // Replace duplicate slashes.
      .replace(/\/{2,}/g, '/')
      // Remove ending "/".
      .replace(/\/$/, '')
      // Remove default index file.
      .replace(/\/(?:default.(?:html?|aspx?)|index.(?:s?html?|php|jsp|asp))$/, '');
  }

  return hostname + port + pathname;
}

export function normalizeUrl(url) {
  return normalizeUrlObj(urllib.parse(url));
}
